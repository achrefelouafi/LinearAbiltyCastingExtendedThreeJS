import {
  Mesh,
  Group,
  RingGeometry,
  PlaneGeometry,
  ShaderMaterial,
  NormalBlending,
  DoubleSide,
  Vector3
} from 'three';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { saturate, Easing } from '../utils/math.js';

/**
 * Kinetic air distortion — layer 5 of the breakdown.
 *
 * Nothing here is drawn. Both meshes live on `LAYER.DISTORTION`, are invisible
 * to the main pass, and write screen-space refraction offsets into the buffer
 * that `postprocessing/DistortionShader.js` warps the finished frame by:
 *
 *   R,G → offset encoded around 0.5   B → strength   A → coverage
 *
 * Two parts, because a blast displaces air in two different ways and they read
 * as different things:
 *
 *   1. **The pressure ring.** A flat annulus lying on the floor, expanding
 *      outward at a fixed metres-per-second. Its offset is genuinely *radial* —
 *      the world-space outward direction rotated into view space — so the frame
 *      is stretched away from the epicentre along the wavefront instead of just
 *      shivering. That is what makes it read as a compression wave rather than
 *      as heat, and it is the one thing the reference's fifth panel is showing.
 *      A ring rather than a disc: the air *behind* the wave is already still.
 *
 *   2. **The column.** A camera-facing billboard over the impact carrying rising
 *      turbulence — the volume of air the blast threw upward, still churning
 *      while the dust climbs through it. Camera-facing because a flat proxy
 *      edge-on writes nothing, and the shimmer would vanish as the camera
 *      orbits past it.
 *
 * Owned by the cast, like the crater and the scars.
 */

const RING_VERTEX = /* glsl */ `
  uniform float uRadius;

  varying vec2  vLocal;    // metres from the centre, on the floor
  varying vec3  vWorld;

  void main() {
    // RingGeometry is authored in the XY plane; the mesh is laid flat, so the
    // local frame is (x, z) once it is on the floor.
    vec3 scaled = vec3(position.xy * uRadius, 0.0);
    vLocal = scaled.xy;
    vec4 world = modelMatrix * vec4(scaled, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const RING_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uFront;      // where the wavefront is, metres
  uniform float uThickness;  // depth of the wave packet, metres
  uniform float uStrength;
  uniform float uRipples;    // bands inside the packet
  uniform float uChop;       // how far the front is broken up
  uniform float uChopScale;
  uniform float uShaderIntensity;

  varying vec2 vLocal;
  varying vec3 vWorld;

  ${noiseGLSL}

  void main() {
    float r = length(vLocal);
    if (r < 0.001) discard;

    // The front is not a perfect circle: a blast rolls faster where the ground
    // gave way and slower where it did not.
    float chop = snoise(vec3(normalize(vLocal) * uChopScale, uTime * 0.35)) * uChop;
    float d = r - (uFront + chop);

    // A wave packet: bands, windowed so they exist only near the front.
    float window = exp(-(d * d) / max(0.02, uThickness * uThickness));
    if (window < 0.004) discard;
    float bands = sin(d * uRipples - uTime * 6.0);

    // The outward direction in world space, rotated into view space and read as
    // a screen direction. This is what makes the warp stretch away from the
    // impact rather than shimmer in place.
    vec3 outward = normalize(vec3(vLocal.x, 0.0, vLocal.y));
    vec2 screenDir = (viewMatrix * vec4(outward, 0.0)).xy;
    float len = length(screenDir);
    screenDir = len > 1e-4 ? screenDir / len : vec2(0.0, 1.0);

    float strength = uStrength * uShaderIntensity * window;
    vec2 offset = screenDir * bands;

    gl_FragColor = vec4(offset * 0.5 + 0.5, strength, window);
  }
`;

const COLUMN_VERTEX = /* glsl */ `
  uniform float uWidth;
  uniform float uHeight;

  varying vec2 vUv;
  varying vec3 vLocal;

  void main() {
    vUv = uv;
    // Camera-facing: the quad's own basis is discarded and its corners are laid
    // out in view space around the object's origin.
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * vec2(uWidth, uHeight);
    // Kept in the *object's* frame for the noise, so the churn is welded to the
    // blast and does not slide when the camera moves.
    vLocal = vec3(position.x * uWidth, position.y * uHeight, 0.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const COLUMN_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uSeed;
  uniform float uShaderIntensity;

  varying vec2 vUv;
  varying vec3 vLocal;

  ${noiseGLSL}

  void main() {
    // Displaced air climbs: the field scrolls up, and is stretched vertically so
    // the structures are columns rather than blobs.
    vec3 np = vec3(vLocal.xy * uScale, vLocal.y * uScale * 0.4 - uTime * uSpeed + uSeed);
    float nx = snoise(np);
    float ny = snoise(np + vec3(19.3, 7.7, 31.1));

    vec2 c = (vUv - 0.5) * 2.0;
    // Strongest just off the floor, thinning with height, feathered at the
    // sides so the warp never shows a border.
    float mask = (1.0 - smoothstep(0.15, 1.0, abs(c.x)))
               * (1.0 - smoothstep(0.0, 1.0, pow(clamp(vUv.y, 0.0, 1.0), 0.8)));
    mask *= smoothstep(0.0, 0.06, vUv.y);

    float strength = uStrength * uShaderIntensity * mask;
    if (strength < 0.002) discard;

    gl_FragColor = vec4(vec2(nx, ny) * 0.5 + 0.5, strength, mask);
  }
`;

export class KineticWarp {
  constructor() {
    this.group = new Group();
    this.group.name = 'KineticWarp';

    /* --- the pressure ring --- */
    // Authored as a unit annulus and scaled in the shader, so its reach is a
    // live slider that re-scales a wave already travelling.
    this.ringMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uRadius: { value: 6 },
        uFront: { value: 0 },
        uThickness: { value: 0.9 },
        uStrength: { value: 1 },
        uRipples: { value: 7 },
        uChop: { value: 0.35 },
        uChopScale: { value: 2.4 }
      }),
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT
    });
    // Inner radius 0: the packet decides where it is, not the geometry.
    this.ringGeometry = new RingGeometry(0, 1, 96, 1);
    this.ring = new Mesh(this.ringGeometry, this.ringMaterial);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.35;

    /* --- the column --- */
    this.columnMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uWidth: { value: 6 },
        uHeight: { value: 5 },
        uStrength: { value: 1 },
        uScale: { value: 1.6 },
        uSpeed: { value: 2.2 },
        uSeed: { value: 0 }
      }),
      vertexShader: COLUMN_VERTEX,
      fragmentShader: COLUMN_FRAGMENT
    });
    // Anchored at its bottom edge so the object origin sits on the floor.
    this.columnGeometry = new PlaneGeometry(1, 1).translate(0, 0.5, 0);
    this.column = new Mesh(this.columnGeometry, this.columnMaterial);

    for (const mesh of [this.ring, this.column]) {
      mesh.layers.set(LAYER.DISTORTION);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
    }

    this.centre = new Vector3();
    this.age = 0;
    this.life = 1;
    this.active = false;
  }

  /**
   * Punch the air.
   * @param {THREE.Vector3} position the impact, on the floor
   */
  spawn(position) {
    const c = settings.quake;
    this.centre.copy(position);
    this.age = 0;
    this.life = Math.max(0.15, c.warpLife);
    this.active = true;

    this.group.position.set(position.x, 0, position.z);
    this.columnMaterial.uniforms.uSeed.value = Math.random() * 40;
    this.ring.visible = true;
    this.column.visible = true;
    this.update(0);
  }

  /** @returns {boolean} still alive */
  update(dt) {
    if (!this.active) return false;
    const c = settings.quake;
    const g = settings.global;
    this.age += dt;

    const t = saturate(this.age / this.life);
    if (t >= 1) {
      this.hide();
      return false;
    }

    /* --- the ring --- */
    const u = this.ringMaterial.uniforms;
    const reach = c.warpRadius * g.explosionIntensity;
    u.uRadius.value = reach;
    // Fast out, easing off — the same silhouette every shockwave has.
    u.uFront.value = reach * Easing.outQuint(t);
    u.uThickness.value = c.warpThickness;
    u.uRipples.value = c.warpRipples;
    u.uChop.value = c.warpChop;
    u.uChopScale.value = c.warpChopScale;
    // The wave loses its punch as it spreads: energy over a growing circumference.
    u.uStrength.value = c.warpStrength * g.distortion * (1 - t) * (1 - t);

    /* --- the column --- */
    const cu = this.columnMaterial.uniforms;
    cu.uWidth.value = c.warpColumnWidth * g.explosionIntensity;
    cu.uHeight.value = c.warpColumnHeight * g.explosionIntensity;
    cu.uScale.value = c.warpScale * g.noiseFrequency;
    cu.uSpeed.value = c.warpSpeed * g.noiseSpeed;
    // Held up for the first third, then let go: the churn outlives the wave.
    cu.uStrength.value =
      c.warpColumn * g.distortion * Easing.outQuad(saturate(this.age / 0.12)) * (1 - Easing.inQuad(t));

    return true;
  }

  hide() {
    this.active = false;
    this.ring.visible = false;
    this.column.visible = false;
  }

  dispose() {
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
    this.columnGeometry.dispose();
    this.columnMaterial.dispose();
    this.group.parent?.remove(this.group);
  }
}
