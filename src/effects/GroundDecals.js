import {
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  Color,
  Group
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { ObjectPool } from '../utils/ObjectPool.js';

/**
 * SCORCH, SHOCKWAVE, FROST and ARC are used by the live abilities; the rest are
 * generic ground marks kept for whatever gets built next, and cost nothing until
 * one is spawned (three compiles a program per decal type, on first use).
 */
export const DecalType = Object.freeze({
  SCORCH: 0, // burnt ground with cooling embers  (fire / thunder)
  RIPPLE: 1, // expanding water ring              (water)
  CRACK: 2, // radial fractures with hot glow     (earth)
  SHOCKWAVE: 3, // thin expanding ring            (all impacts)
  DUSTRING: 4, // soft ground-hugging dust puff   (earth / wind)
  FOAM: 5, // spreading sea foam over wet stone   (water)
  FROST: 6, // rime creeping outward in plates    (ice)
  ARC: 7 // branching electric burn               (thunder)
});

const DECAL_VERTEX = /* glsl */ `
  uniform vec3 uLightDir;      // world space, toward the sun
  varying vec2 vUv;
  varying vec3 vLight;         // the same direction, in the decal's own frame

  void main() {
    vUv = uv;

    // Decals are spawned with a random yaw to decorrelate their noise, so a key
    // direction taken straight from world space would light every patch from a
    // different side of the room. Rotate it into the quad's frame once, here:
    // the fragment stage's c.x runs along local +X and c.y along local -Z.
    vec3 ax = normalize(modelMatrix[0].xyz);
    vec3 ay = normalize(modelMatrix[1].xyz);
    vec3 az = normalize(modelMatrix[2].xyz);
    vLight = normalize(vec3(dot(uLightDir, ax), dot(uLightDir, ay), -dot(uLightDir, az)));

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DECAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uAge;        // 0..1 normalised lifetime
  uniform float uSeed;
  uniform float uIntensity;
  uniform float uWidth;      // crack / ring thickness
  uniform float uRadius;     // footprint radius in metres, for world-scaled grain
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform float uGlobalGlow;
  varying vec2 vUv;
  varying vec3 vLight;

  ${noiseGLSL}
  ${commonGLSL}

  /**
   * Depth of settled snow at q (metres from the centre of the patch), ~0..1.
   *
   * Three scales, because that is what makes powder read as powder rather than
   * as a texture: banked drifts you can see the shape of, the shouldered slabs
   * where the crust has packed and cracked, and a fine grain on top for the
   * light to catch. It is a *height* field — the FROST decal differentiates it
   * for a normal, which is the whole reason the patch stops looking flat.
   */
  float snowDepth(vec2 q, float seed, float sharpness) {
    float drift = fbm3(vec3(q * 0.85, seed)) * 0.5 + 0.5;
    vec2  cell  = voronoi2(q * (1.4 + sharpness * 0.9) + seed * 7.0);
    float slabs = smoothstep(0.0, 0.55, cell.x) * 0.30 + cell.y * 0.12;
    float grain = snoise01(vec3(q * (7.0 + sharpness * 5.0), seed * 3.0)) * 0.15;
    return drift * 0.60 + slabs + grain;
  }

  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float d = length(c);
    if (d > 1.0) discard;

    float alpha = 0.0;
    vec3 color = uColorA;
    float fadeOut = 1.0 - smoothstep(0.55, 1.0, uAge);

    #if DECAL == 0                                   /* SCORCH */
      float n = fbm3(vec3(c * 2.4, uSeed * 13.0));
      float burn = smoothstep(1.0, 0.15, d + n * 0.45);
      float embers = pow(max(0.0, snoise(vec3(c * 6.0, uSeed * 9.0 + uTime * 0.35))), 4.0);
      alpha = burn * (0.85 * fadeOut);
      color = mix(uColorA, uColorB, embers * (1.0 - uAge));
      color += embers * uColorB * 2.5 * (1.0 - smoothstep(0.0, 0.6, uAge));

    #elif DECAL == 1                                 /* RIPPLE */
      float radius = mix(0.05, 1.0, sqrt(uAge));
      float ring = smoothstep(uWidth, 0.0, abs(d - radius));
      float inner = smoothstep(radius, radius - 0.35, d) * 0.22;
      float wobble = 0.75 + 0.25 * snoise(vec3(c * 5.0, uSeed * 4.0 + uTime));
      alpha = (ring * wobble + inner) * fadeOut;
      color = mix(uColorA, uColorB, ring);

    #elif DECAL == 2                                 /* CRACK */
      float ang = atan(c.y, c.x);
      float branch = ridged(vec3(cos(ang), sin(ang), uSeed * 5.0) * 2.6, 4);
      float spread = smoothstep(0.0, 0.45, uAge);
      float radial = smoothstep(spread, spread * 0.35, d);
      float crack = smoothstep(0.55 - uWidth * 0.35, 0.85, branch) * radial;
      float glow = crack * (1.0 - smoothstep(0.1, 0.8, uAge));
      alpha = clamp(crack * 0.95 * fadeOut, 0.0, 1.0);
      color = mix(uColorA, uColorB, glow);
      color += uColorB * glow * 1.8;

    #elif DECAL == 3                                 /* SHOCKWAVE */
      float radius = mix(0.0, 1.0, pow(uAge, 0.55));
      float ring = smoothstep(uWidth, 0.0, abs(d - radius));
      alpha = ring * (1.0 - uAge) * 0.9;
      color = mix(uColorA, uColorB, ring);

    #elif DECAL == 4                                 /* DUSTRING */
      float radius = mix(0.1, 1.0, pow(uAge, 0.4));
      float n = fbm3(vec3(c * 3.1, uSeed * 7.0 + uTime * 0.2));
      float puff = smoothstep(radius, radius * 0.35, d) * (0.6 + n * 0.5);
      alpha = puff * (1.0 - uAge) * 0.7;
      color = mix(uColorA, uColorB, n * 0.5 + 0.5);

    #elif DECAL == 6                                 /* FROST */
      // Snow driven into the ground where the cold went through it.
      //
      // The old version drove its silhouette off atan(), and an angular lookup
      // hands every radius along a bearing the same lobe value — which is
      // literally how you draw a star, and a star is what it drew. Everything
      // here is sampled in the *plane* instead, and the patch is **shaded** off
      // a height field rather than tinted through a mask: cheap forward
      // differences give a normal, the scene's own key direction lights it, and
      // the result banks and catches light like powder instead of reading as a
      // blue-and-white transfer stuck to the floor.
      //
      // uWidth (the "crystal sharpness" slider) is the grain frequency.
      float seed = uSeed * 37.0;
      float sharp = clamp(uWidth, 0.05, 4.0);
      // Sample in metres, so a small rime patch and the broad sheet under an
      // impact have the same size of grain and read as the same substance.
      vec2 q = c * max(0.35, uRadius);

      /* ---- the drift: a ragged reach, never a disc ---- */
      vec2 warp = vec2(fbm3(vec3(q * 0.55, seed)), fbm3(vec3(q * 0.55, seed + 5.7))) * 0.45;
      float lobes = fbm3(vec3(q * 0.8 + warp, seed + 13.0));
      float grow = pow(uAge, 0.30);
      float reach = d * (1.0 - lobes * 0.40);
      float cover = smoothstep(grow, grow - 0.38, reach);
      if (cover < 0.004) discard;

      /* ---- relief ---- */
      float e = 0.16;                               // metres between taps
      float h  = snowDepth(q, seed, sharp);
      float hx = snowDepth(q + vec2(e, 0.0), seed, sharp);
      float hy = snowDepth(q + vec2(0.0, e), seed, sharp);
      // A shallow bump: snow is soft, and a steep fake normal reads as gravel.
      vec3 nrm = normalize(vec3((h - hx) / e * 0.30, 1.0, (h - hy) / e * 0.30));

      float lambert = clamp(dot(nrm, normalize(vLight)), 0.0, 1.0);
      // Snow scatters deep, so its own shadow never goes black — it goes blue.
      float shade = 0.36 + 0.64 * pow(lambert, 0.8);

      /* ---- how thickly it lies ---- */
      // Thick in the middle, breaking into scattered grains at the rim, so the
      // patch has no printed outline anywhere.
      float lie = smoothstep(0.10, 0.52, cover * (0.34 + 0.78 * h));

      alpha = lie * fadeOut * 0.95;
      color = mix(uColorB * 0.55, mix(uColorA, vec3(1.0), 0.45), shade);

      // Ice glints where the crust catches the light — stepped in time so they
      // twinkle as the patch settles rather than crawling.
      float glint = smoothstep(0.90, 1.0, snoise01(vec3(q * 9.0, floor(uTime * 7.0) * 0.37 + seed)));
      color += glint * pow(lambert, 2.0) * 1.5 * (1.0 - smoothstep(0.0, 0.7, uAge));

      // The advancing lip is still freezing, so it stays lit while it travels.
      float lip = smoothstep(0.10, 0.0, abs(reach - grow)) * (1.0 - smoothstep(0.0, 0.5, uAge));
      color = mix(color, mix(uColorB, vec3(1.0), 0.6), lip * 0.55);
      alpha = clamp(alpha + lip * cover * 0.25 * fadeOut, 0.0, 1.0);

    #elif DECAL == 5                                 /* FOAM */
      // A sheet of foam thrown outward by the impact, which then drains from
      // the middle and dries back into a ring, over wet stone that darkens and
      // slowly evaporates.
      float front = mix(0.12, 1.0, pow(uAge, 0.42));
      float n = fbm3(vec3(c * 2.6, uSeed * 17.0 + uTime * 0.12));
      // Water runs outward in fingers, so the front is never a clean circle.
      float ang = atan(c.y, c.x);
      float fingers = 0.68 + 0.32 * snoise(vec3(cos(ang), sin(ang), uSeed * 3.0) * 3.5);
      float edge = d + n * 0.26;
      float reach = front * fingers;

      float sheet = smoothstep(reach, reach - 0.3, edge);
      float drain = smoothstep(reach * uAge * 0.9 - 0.05, reach * uAge + 0.3, edge + n * 0.12);
      float foam = sheet * mix(1.0, drain, smoothstep(0.12, 0.85, uAge));

      // Cell noise turns the sheet into bubbles instead of flat white paint.
      vec2 cell = voronoi2(c * 9.0 + uSeed * 30.0);
      float bubbles = smoothstep(0.55, 0.04, cell.x);
      float rim = smoothstep(0.09, 0.0, abs(edge - reach)) * (1.0 - uAge);

      float wet = sheet * (1.0 - smoothstep(0.3, 1.0, uAge));
      float mask = clamp(foam * (0.5 + 0.65 * bubbles) + rim * 0.9, 0.0, 1.0);
      alpha = clamp(wet * 0.5 + mask, 0.0, 1.0) * fadeOut;
      color = mix(uColorA, uColorB, clamp(mask * 1.3, 0.0, 1.0));

    #else                                            /* ARC */
      // The burn a bolt leaves where it earthed itself.
      //
      // The filament field is sampled in the *plane*, never on the angle. An
      // angular function hands every radius along a given bearing the same
      // value, which draws dead-straight spokes out of the centre — a firework,
      // not a burn. Sampling in 2D and warping the lookup lets the filaments
      // meander and fork the way current actually does. uWidth is how finely it
      // splits.
      float warp = fbm3(vec3(c * 1.7, uSeed * 3.0)) * 0.5;
      float fil = ridged(vec3(c * (2.4 + uWidth * 4.0) + warp, uSeed * 11.0), 4);
      float veins = smoothstep(0.70, 0.96, fil);

      // A ragged front that opens outward, so the mark spreads from the strike
      // rather than appearing whole.
      float grow = pow(uAge, 0.35);
      float edge = d + fbm3(vec3(c * 2.2, uSeed * 5.0)) * 0.25;
      float front = smoothstep(grow, grow * 0.15, edge);
      float hot = veins * front * (1.0 - smoothstep(0.0, 0.45, uAge));

      alpha = clamp(veins * front * 1.1, 0.0, 1.0) * fadeOut;
      color = mix(uColorA, uColorB, clamp(veins * 1.4, 0.0, 1.0));
      color += uColorB * hot * 1.8;
    #endif

    alpha *= uIntensity;
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * Pooled ground decals: scorch marks, ripples, cracks, shockwaves and foam.
 *
 * Each decal is a single quad lying on the ground with a fully procedural
 * fragment shader, so there are no decal textures and no projection cost. One
 * material instance per decal keeps the uniforms independent while three's
 * program cache still compiles only one program per decal type.
 */
export class DecalSystem {
  constructor(scene) {
    this.group = new Group();
    this.group.name = 'GroundDecals';
    scene.add(this.group);

    this.geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.active = [];

    // One pool per type so the shader `#define` stays constant per material.
    this.pools = new Map();
  }

  _poolFor(type) {
    let pool = this.pools.get(type);
    if (!pool) {
      pool = new ObjectPool(() => this._createDecal(type), (decal) => {
        decal.mesh.visible = false;
        this.group.remove(decal.mesh);
      });
      this.pools.set(type, pool);
    }
    return pool;
  }

  _createDecal(type) {
    const additive =
      type === DecalType.RIPPLE || type === DecalType.SHOCKWAVE || type === DecalType.ARC;
    const material = new ShaderMaterial({
      defines: { DECAL: type },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? AdditiveBlending : NormalBlending,
      toneMapped: false,
      uniforms: sharedUniforms({
        uAge: { value: 0 },
        uSeed: { value: Math.random() },
        uIntensity: { value: 1 },
        uWidth: { value: 0.12 },
        uRadius: { value: 1 },
        uColorA: { value: new Color(0.1, 0.06, 0.05) },
        uColorB: { value: new Color(1, 0.5, 0.15) }
      }),
      vertexShader: DECAL_VERTEX,
      fragmentShader: DECAL_FRAGMENT
    });

    const mesh = new Mesh(this.geometry, material);
    mesh.layers.set(LAYER.VFX);
    mesh.renderOrder = additive ? 8 : 6;
    mesh.frustumCulled = false;

    return { mesh, material, type, age: 0, life: 1, radius: 1, growth: 0 };
  }

  /**
   * @param {number} type   DecalType.*
   * @param {THREE.Vector3} position
   * @param {object} options
   */
  spawn(type, position, options = {}) {
    const {
      radius = 2,
      life = 2,
      colorA = null,
      colorB = null,
      intensity = 1,
      width = 0.12,
      growth = 0,
      height = 0.02
    } = options;

    const decal = this._poolFor(type).acquire();
    const u = decal.material.uniforms;

    decal.age = 0;
    decal.life = Math.max(0.05, life);
    decal.radius = radius;
    decal.growth = growth;

    u.uAge.value = 0;
    u.uSeed.value = Math.random();
    u.uIntensity.value = intensity;
    u.uWidth.value = width;
    u.uRadius.value = radius;
    if (colorA) u.uColorA.value.copy(colorA);
    if (colorB) u.uColorB.value.copy(colorB);

    decal.mesh.position.set(position.x, height, position.z);
    decal.mesh.rotation.y = Math.random() * Math.PI * 2;
    decal.mesh.scale.setScalar(radius * 2);
    decal.mesh.visible = true;

    this.group.add(decal.mesh);
    this.active.push(decal);
    return decal;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const decal = this.active[i];
      decal.age += dt;
      const t = decal.age / decal.life;
      decal.material.uniforms.uAge.value = t;

      if (decal.growth !== 0) {
        decal.mesh.scale.setScalar(decal.radius * 2 * (1 + decal.growth * t));
      }

      if (t >= 1) {
        this.active.splice(i, 1);
        this._poolFor(decal.type).release(decal);
      }
    }
  }

  clear() {
    for (const decal of this.active) this._poolFor(decal.type).release(decal);
    this.active.length = 0;
  }

  dispose() {
    this.clear();
    for (const pool of this.pools.values()) pool.dispose((decal) => decal.material.dispose());
    this.pools.clear();
    this.geometry.dispose();
    this.group.parent?.remove(this.group);
  }
}
