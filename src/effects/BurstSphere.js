import {
  Mesh,
  IcosahedronGeometry,
  ShaderMaterial,
  AdditiveBlending,
  Color,
  Group,
  DoubleSide
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { Easing } from '../utils/math.js';

export const BurstMode = Object.freeze({
  FIRE: 0, // billowing fireball
  WATER: 1, // splash dome, fresnel heavy
  AIR: 2, // thin pressure shell
  EARTH: 3, // dense dust ball
  FROST: 4, // shell of freezing vapour tearing into plates
  STORM: 5 // ionised air, filaments racing over a near-invisible shell
});

const BURST_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uAge;
  uniform float uDisplace;
  uniform float uSeed;
  uniform float uTurbulence;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vDisp;
  varying vec2  vUv;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    vUv = uv;

    // Billowing surface: several octaves of noise pushed along the normal,
    // scrolling outward as the burst expands.
    vec3 np = normal * (1.6 + uAge * 1.4) + vec3(uSeed * 13.0) - vec3(0.0, uTime * 0.6, 0.0);
    float n = fbm4(np) * 0.6 + ridged(np * 1.3, 4) * 0.4;
    vDisp = n;

    float amount = uDisplace * (0.35 + uAge * 0.9) * uTurbulence;
    vec3 pos = position + normal * n * amount;

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - world.xyz;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BURST_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uAge;
  uniform float uSeed;
  uniform float uIntensity;
  uniform float uFresnel;
  uniform float uOpacity;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vDisp;
  varying vec2  vUv;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float fres = fresnelTerm(vViewDir, vNormalW, 2.2, 1.0) * uFresnel;
    float heat = clamp(vDisp * 0.5 + 0.5, 0.0, 1.0);

    // Dissolve the shell away over the burst's life.
    vec2 dis = dissolveMask(heat, uAge * 1.15 - 0.15, 0.3);

    float alpha = uOpacity;
    vec3 color;

    #if BURST_MODE == 0                     /* FIRE */
      color = gradient4(uColorA, uColorB, uColorC, uColorC * 0.15, 1.0 - heat);
      color += dis.y * uColorA * 3.0;
      alpha *= (1.0 - uAge) * (0.55 + fres * 0.8) * dis.x;

    #elif BURST_MODE == 1                   /* WATER */
      // A splash dome is water with foam riding on it: the billowing noise the
      // vertex stage already computed doubles as the foam mask, so the crests of
      // the dome go white and opaque while the troughs stay deep and glassy.
      float crestFoam = smoothstep(0.5, 0.95, heat);
      float bubbles = smoothstep(0.55, 0.05, voronoi2(vNormalW.xy * 11.0 + vNormalW.z * 4.0 + uSeed).x);
      color = mix(uColorA, uColorB, heat * 0.85);
      color = mix(color, uColorC * (0.75 + 0.5 * bubbles), crestFoam);
      color += uColorC * fres * 0.9;
      alpha *= (1.0 - uAge) * (0.2 + fres * 0.85 + crestFoam * 0.8) * dis.x;

    #elif BURST_MODE == 2                   /* AIR */
      color = mix(uColorA, uColorB, fres);
      alpha *= (1.0 - uAge) * fres * 0.85 * dis.x;

    #elif BURST_MODE == 3                   /* EARTH */
      color = mix(uColorA, uColorB, heat * 0.8);
      alpha *= (1.0 - uAge) * (0.5 + heat * 0.4) * dis.x;

    #elif BURST_MODE == 4                   /* FROST */
      // Freezing vapour rather than an explosion: the billowing noise the vertex
      // stage already computed is reused as a crystallisation mask, so the shell
      // goes glassy and opaque in plates and stays clear between them — it tears
      // apart as it expands instead of fading out as a ball.
      float plates = smoothstep(0.42, 0.95, heat);
      float rime = smoothstep(0.55, 0.05, voronoi2(vNormalW.xy * 9.0 + vNormalW.z * 3.0 + uSeed).x);
      color = mix(uColorA, uColorB, heat * 0.9);
      color = mix(color, uColorC * (0.7 + 0.6 * rime), plates);
      color += uColorC * fres * 1.3;
      alpha *= (1.0 - uAge) * (0.16 + fres * 0.95 + plates * 0.7) * dis.x;

    #else                                   /* STORM */
      // Ionised air, not a fireball. The shell has to stay *empty*: the body of
      // it contributes almost nothing, and what you see is thin filaments
      // racing over the surface plus the fresnel rim. Ridged noise scrolling in
      // the normal direction gives branching arcs that skate across it as it
      // expands. Thresholded hard on purpose — a wide band here fills the shell
      // in and it immediately reads as a rock.
      float fil = ridged(vNormalW * (5.0 + uAge * 7.0) + vec3(uSeed * 9.0) +
                         vec3(0.0, uTime * 3.4, 0.0), 4);
      float arcs = smoothstep(0.80, 0.97, fil) * (1.0 - uAge * 0.6);
      float rim = pow(fres, 1.6);
      color = mix(uColorA, uColorB, heat * 0.5);
      color = mix(color, uColorC, arcs);
      color += uColorC * rim * 1.2 + uColorC * arcs * 2.4;
      alpha *= (1.0 - uAge) * (rim * 0.55 + arcs * 0.9) * dis.x;
    #endif

    alpha = clamp(alpha, 0.0, 1.0);
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, 0.6);
    if (alpha < 0.004) discard;

    color *= uIntensity * uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * Pooled expanding shells used for every element's impact.
 *
 * One shared icosphere geometry, one material per pooled instance (so uniforms
 * stay independent) and one shader with four compile-time modes.
 */
export class BurstSystem {
  constructor(scene) {
    this.group = new Group();
    this.group.name = 'Bursts';
    scene.add(this.group);

    this.geometry = new IcosahedronGeometry(1, 4);
    this.pools = new Map();
    this.active = [];
  }

  _poolFor(mode) {
    let pool = this.pools.get(mode);
    if (!pool) {
      pool = new ObjectPool(
        () => this._create(mode),
        (burst) => {
          burst.mesh.visible = false;
          this.group.remove(burst.mesh);
        }
      );
      this.pools.set(mode, pool);
    }
    return pool;
  }

  _create(mode) {
    const material = new ShaderMaterial({
      defines: { BURST_MODE: mode },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uAge: { value: 0 },
        uSeed: { value: Math.random() },
        uDisplace: { value: 0.45 },
        uTurbulence: { value: 1 },
        uIntensity: { value: 1 },
        uFresnel: { value: 1 },
        uOpacity: { value: 1 },
        uColorA: { value: new Color(1, 0.9, 0.6) },
        uColorB: { value: new Color(1, 0.45, 0.1) },
        uColorC: { value: new Color(0.4, 0.08, 0.03) }
      }),
      vertexShader: BURST_VERTEX,
      fragmentShader: BURST_FRAGMENT
    });

    const mesh = new Mesh(this.geometry, material);
    mesh.layers.set(LAYER.VFX);
    mesh.renderOrder = 14;
    mesh.frustumCulled = false;

    return { mesh, material, mode, age: 0, life: 1, radius: 1, endRadius: 2 };
  }

  /**
   * @param {number} mode BurstMode.*
   * @param {THREE.Vector3} position
   */
  spawn(mode, position, options = {}) {
    const {
      radius = 0.4,
      endRadius = 3,
      life = 0.9,
      intensity = 1,
      opacity = 1,
      fresnel = 1,
      displace = 0.45,
      turbulence = 1,
      colorA = null,
      colorB = null,
      colorC = null,
      squash = 1
    } = options;

    const burst = this._poolFor(mode).acquire();
    const u = burst.material.uniforms;

    burst.age = 0;
    burst.life = Math.max(0.05, life);
    burst.radius = radius;
    burst.endRadius = endRadius;
    burst.squash = squash;

    u.uAge.value = 0;
    u.uSeed.value = Math.random() * 10;
    u.uIntensity.value = intensity;
    u.uOpacity.value = opacity;
    u.uFresnel.value = fresnel;
    u.uDisplace.value = displace;
    u.uTurbulence.value = turbulence;
    if (colorA) u.uColorA.value.copy(colorA);
    if (colorB) u.uColorB.value.copy(colorB);
    if (colorC) u.uColorC.value.copy(colorC);

    burst.mesh.position.copy(position);
    burst.mesh.scale.setScalar(radius);
    burst.mesh.visible = true;
    this.group.add(burst.mesh);
    this.active.push(burst);
    return burst;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const burst = this.active[i];
      burst.age += dt;
      const t = Math.min(1, burst.age / burst.life);
      burst.material.uniforms.uAge.value = t;

      // Fast expansion that eases out — the classic explosion silhouette.
      const scale = burst.radius + (burst.endRadius - burst.radius) * Easing.outQuint(t);
      burst.mesh.scale.set(scale, scale * burst.squash, scale);

      if (t >= 1) {
        this.active.splice(i, 1);
        this._poolFor(burst.mode).release(burst);
      }
    }
  }

  clear() {
    for (const burst of this.active) this._poolFor(burst.mode).release(burst);
    this.active.length = 0;
  }

  dispose() {
    this.clear();
    for (const pool of this.pools.values()) pool.dispose((burst) => burst.material.dispose());
    this.pools.clear();
    this.geometry.dispose();
    this.group.parent?.remove(this.group);
  }
}
