import {
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  Color,
  Vector3,
  DoubleSide,
  BackSide
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

const TAU = Math.PI * 2;

/* ==================================================================== */
/* The mist                                                              */
/* ==================================================================== */

/**
 * The toxic mist: a **raymarched volume**, not a stack of billboards.
 *
 * This is the one pass on the sheet that cannot be faked. A cylinder of gas made
 * out of camera-facing quads dies the moment the camera orbits — the cards turn
 * with you, the silhouette never changes, and anything standing inside the cloud
 * is either entirely in front of every card or entirely behind it. So this
 * marches it properly:
 *
 *  1. **The proxy is only a scissor.** The mesh is a closed cylinder drawn back
 *     faces only with the depth test off; its single job is to rasterise the
 *     pixels the volume could possibly cover. Every metre of the actual shape is
 *     resolved analytically in the fragment stage, so the proxy's tessellation
 *     is irrelevant and the volume is perfectly smooth.
 *  2. **The span is analytic.** `cylinderSpan` solves the ray against an upright
 *     cylinder and clips it to the height slab, which gives an exact entry and
 *     exit distance — no depth peeling, no sorting, and correct results with the
 *     camera inside the cloud.
 *  3. **It is clipped against the scene.** The far end of the march is cut at
 *     the opaque depth prepass, so the character standing in the mist is veiled
 *     by exactly the gas in front of them and none of the gas behind them. That
 *     single line is what makes this an *aura* rather than a decal the character
 *     is pasted on top of.
 *  4. **It is lit from underneath.** The pool is the key light and it is *below*
 *     the gas, so emission falls off with height and the cloud is bright at its
 *     feet and dark at its crown. One extra tap toward the sun gives the top a
 *     self-shadow. Get this the wrong way round — light it flat, or from above —
 *     and it stops being smoke over a chemical fire and becomes green fog.
 *
 * Cost is honest: `uSteps` samples of a three-octave fbm plus one shadow tap.
 * Empty space is skipped before any noise is evaluated, the march stops as soon
 * as the volume is opaque, and the step count is a live slider — so this scales
 * from a laptop to a demo machine without a recompile.
 */
const MIST_VERTEX = /* glsl */ `
  varying vec3 vWorld;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const MIST_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3  uCentre;       // world, at the base of the column
  uniform float uRadius;
  uniform float uHeight;
  uniform float uSteps;
  uniform float uDensity;
  uniform float uAbsorb;
  uniform float uScale;
  uniform float uDetail;
  uniform float uFilament;
  uniform float uThreshold;
  uniform float uRise;
  uniform float uStretch;
  uniform float uTwist;
  uniform float uSpin;
  uniform float uEdge;
  uniform float uFlare;
  uniform float uFalloff;
  uniform float uSkirt;
  uniform float uLobe;
  uniform float uTear;
  uniform float uGroundGlow;
  uniform float uGroundFalloff;
  uniform float uShadow;
  uniform float uShadowStep;
  uniform float uAmbient;
  uniform float uSaturate;
  uniform float uBoil;
  uniform float uDissolve;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorDeep;
  uniform vec3  uColorBody;
  uniform vec3  uColorEdge;
  uniform vec3  uColorGlow;
  uniform vec3  uColorLight;

  uniform vec3  uLightDir;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying vec3 vWorld;

  ${noiseGLSL}
  ${commonGLSL}

  #define MAX_STEPS 64

  /**
   * Where the ray is inside the column, and how far up it is.
   *
   * The shape is a cylinder that opens with height, so the radial test is taken
   * against the *local* radius rather than a constant — the cloud is a chimney,
   * not a tube.
   */
  float shellProfile(vec3 q, out float h) {
    h = clamp(q.y / max(uHeight, 1e-3), 0.0, 1.0);
    float rr = uRadius * (1.0 + uFlare * h);

    // The wall is not turned on a lathe. Its radius wanders with bearing and
    // height, weighted upward because the gas is held at the floor by the pool
    // and loose above it. Without this the cloud is a *can* of gas however good
    // the noise inside it is — which is the single thing that gives a volume
    // away as a cylinder with a shader on it.
    vec2 dir = normalize(q.xz + vec2(1e-5));
    float lobe = snoise(vec3(dir * 1.6, q.y * 0.4 - uTime * uRise * 0.35 + uSeed));
    rr *= 1.0 + lobe * uLobe * (0.2 + 0.8 * h);

    float r = length(q.xz) / max(rr, 1e-3);
    // Soft wall, and a skirt that keeps the gas hugging the floor just past the
    // boundary instead of stopping dead on it.
    float wall = smoothstep(1.0 + uSkirt * (1.0 - h), uEdge, r);
    return wall * pow(1.0 - h, uFalloff);
  }

  /** Three octaves, twisted about the axis. The shape of the gas. */
  float mistNoise(vec3 q, float h) {
    // The column turns as it climbs and drifts as a whole: a vortex, which is
    // what a rising plume off a hot floor actually does. Sampled *after* the
    // twist so the structures are welded to the gas rather than swimming
    // through it.
    float turn = uTwist * h + uTime * uSpin;
    vec2 xz = rot2(turn) * q.xz;

    // A low stretch squashes the sampling axis, which elongates the features
    // along it: the difference between a plume climbing and fog drifting.
    vec3 np = vec3(xz * uScale, q.y * uScale * uStretch - uTime * uRise + uSeed);
    float n = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      n += a * snoise(np);
      np = np * 2.03 + vec3(17.3, 5.1, 9.7);
      a *= 0.5;
    }
    n = n * 0.5 + 0.5;

    // Ridged detail folded in: filaments and holes, so the cloud has wisps
    // torn out of it instead of being a uniform fog with a gradient on it.
    float fil = 1.0 - abs(snoise(vec3(xz, q.y * 0.6) * uScale * uDetail + uSeed * 3.0));
    return mix(n, fil, uFilament);
  }

  /** Density at a world point. Empty space costs one profile evaluation. */
  float density(vec3 p) {
    vec3 q = p - uCentre;
    float h;
    float shell = shellProfile(q, h);
    if (shell <= 0.002) return 0.0;

    float n = mistNoise(q, h);
    // Carved rather than faded: below the threshold there is simply no gas — and
    // the threshold *climbs*, so the crown tears into separate wisps while the
    // body at the pool stays solid. A cloud with a lid is a cloud nobody
    // believes.
    float d = smoothstep(uThreshold + uTear * h, 1.0, n) * shell;
    // The boil pushes the whole column, hardest at its feet.
    return d * uDensity * (1.0 + uBoil * (1.4 - h));
  }

  /** One cheap octave, for the shadow tap only. */
  float densityCoarse(vec3 p) {
    vec3 q = p - uCentre;
    float h;
    float shell = shellProfile(q, h);
    if (shell <= 0.002) return 0.0;
    float turn = uTwist * h + uTime * uSpin;
    vec2 xz = rot2(turn) * q.xz;
    float n = snoise(vec3(xz * uScale, q.y * uScale * uStretch - uTime * uRise + uSeed)) * 0.5 + 0.5;
    return smoothstep(uThreshold + uTear * h, 1.0, n) * shell * uDensity;
  }

  /**
   * The ray's entry and exit distance through the column.
   * Handles the camera being inside it, and a ray running parallel to the axis.
   */
  bool cylinderSpan(vec3 ro, vec3 rd, out float t0, out float t1) {
    vec2 oc = ro.xz - uCentre.xz;
    // The widest the chimney ever gets, so the span always contains the shape.
    float rMax = uRadius * (1.0 + max(uFlare, 0.0) + max(uSkirt, 0.0) + max(uLobe, 0.0));
    float a = dot(rd.xz, rd.xz);
    float b = dot(oc, rd.xz);
    float c = dot(oc, oc) - rMax * rMax;

    float tn = -1e9;
    float tf = 1e9;

    if (a < 1e-7) {
      if (c > 0.0) return false;          // parallel to the axis and outside
    } else {
      float disc = b * b - a * c;
      if (disc < 0.0) return false;
      float s = sqrt(disc);
      tn = (-b - s) / a;
      tf = (-b + s) / a;
    }

    float yb = uCentre.y;
    float yt = uCentre.y + uHeight;
    if (abs(rd.y) < 1e-7) {
      if (ro.y < yb || ro.y > yt) return false;
    } else {
      float k0 = (yb - ro.y) / rd.y;
      float k1 = (yt - ro.y) / rd.y;
      tn = max(tn, min(k0, k1));
      tf = min(tf, max(k0, k1));
    }

    t0 = max(tn, 0.0);
    t1 = tf;
    return t1 > t0;
  }

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - cameraPosition);

    float t0, t1;
    if (!cylinderSpan(ro, rd, t0, t1)) discard;

    /* ---- stop the march at the opaque scene ---- */
    // Third row of the view matrix is the camera's basis Z in world space; the
    // depth buffer is a *view* depth, so it has to be divided by the cosine
    // between the ray and that axis to become a distance along this ray.
    vec3 camFwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float packed = unpackRGBAToDepth(texture2D(uSceneDepth, screenUV));
    float sceneViewZ = perspectiveDepthToViewZ(packed, uCameraNear, uCameraFar);
    float sceneT = (-sceneViewZ) / max(dot(rd, camFwd), 1e-4);
    t1 = min(t1, sceneT);
    if (t1 <= t0) discard;

    float steps = clamp(uSteps, 4.0, float(MAX_STEPS));
    float dt = (t1 - t0) / steps;
    // Jittered start. Without it the march bands into visible shells, and the
    // banding is the single most obvious tell that a volume is stepped.
    float jitter = hash13(vec3(gl_FragCoord.xy, uTime * 60.0));
    float t = t0 + dt * jitter;

    vec3 acc = vec3(0.0);
    float trans = 1.0;

    for (int i = 0; i < MAX_STEPS; i++) {
      if (float(i) >= steps || trans < 0.012) break;

      vec3 p = ro + rd * t;
      float d = density(p);

      if (d > 0.002) {
        float h = clamp((p.y - uCentre.y) / max(uHeight, 1e-3), 0.0, 1.0);

        // The pool is the key light, and it is *underneath* the gas.
        float lift = exp(-uGroundFalloff * (p.y - uCentre.y));
        vec3 fromBelow = uColorGlow * lift * uGroundGlow;

        // One tap toward the sun. A full shadow march would cost as much as the
        // volume itself for a term the eye only reads as "the top is darker".
        float above = densityCoarse(p + uLightDir * uShadowStep);
        vec3 fromAbove = uColorLight * exp(-uShadow * above);

        // Thin gas is bright and yellow, thick gas is deep and saturated —
        // the whole reason a cloud has form instead of being a silhouette.
        vec3 body = mix(uColorEdge, uColorDeep, clamp(d * uSaturate, 0.0, 1.0));
        body = mix(body, uColorBody, 0.5);

        float a = 1.0 - exp(-d * uAbsorb * dt);
        acc += body * (fromBelow + fromAbove + uAmbient) * a * trans;
        trans *= 1.0 - a;
      }

      t += dt;
    }

    float alpha = (1.0 - trans) * uFade * uOpacity;
    // The collapse thins the gas from the top down: it sinks back into the pool
    // rather than blinking out.
    if (uDissolve > 0.0) alpha *= 1.0 - uDissolve;
    if (alpha < 0.004) discard;

    acc *= uGlow * uGlobalGlow;
    // Premultiplied: acc is already an integral weighted by its own alpha, so
    // the material is flagged premultipliedAlpha and no divide is needed.
    gl_FragColor = vec4(acc, alpha);
  }
`;

/**
 * The volume. Built once; every metre of it is resolved from `settings.acid`
 * each frame, so `zoneRadius` and `mistHeight` re-shape a cloud that is already
 * standing.
 */
export function createToxicMistMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // The march is clipped against the depth prepass itself, which is both more
    // accurate than the depth test and works with the camera inside the cloud.
    depthTest: false,
    blending: NormalBlending,
    premultipliedAlpha: true,
    side: BackSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uRadius: { value: 5 },
      uHeight: { value: 4.5 },
      uSteps: { value: 26 },
      uDensity: { value: 1.6 },
      uAbsorb: { value: 1.5 },
      uScale: { value: 0.42 },
      uDetail: { value: 1.9 },
      uFilament: { value: 0.4 },
      uThreshold: { value: 0.42 },
      uRise: { value: 0.5 },
      uStretch: { value: 0.32 },
      uTwist: { value: 1.6 },
      uSpin: { value: 0.12 },
      uEdge: { value: 0.55 },
      uFlare: { value: 0.25 },
      uFalloff: { value: 1.4 },
      uSkirt: { value: 0.12 },
      uLobe: { value: 0.3 },
      uTear: { value: 0.22 },
      uGroundGlow: { value: 1.5 },
      uGroundFalloff: { value: 0.55 },
      uShadow: { value: 2.2 },
      uShadowStep: { value: 0.9 },
      uAmbient: { value: 0.12 },
      uSaturate: { value: 1.6 },
      uBoil: { value: 0 },
      uDissolve: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uColorDeep: { value: new Color(0.06, 0.18, 0.03) },
      uColorBody: { value: new Color(0.24, 0.55, 0.08) },
      uColorEdge: { value: new Color(0.62, 0.95, 0.24) },
      uColorGlow: { value: new Color(0.45, 1.0, 0.12) },
      uColorLight: { value: new Color(0.5, 0.6, 0.34) }
    }),
    vertexShader: MIST_VERTEX,
    fragmentShader: MIST_FRAGMENT
  });

  /**
   * @param {object} state { centre:Vector3, radius, height, boil, dissolve, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.acid;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uRadius.value = state.radius;
    u.uHeight.value = state.height;
    u.uBoil.value = state.boil * c.boilDepth;
    u.uDissolve.value = state.dissolve;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uSteps.value = c.mistSteps;
    u.uDensity.value = c.mistDensity;
    u.uAbsorb.value = c.mistAbsorb;
    u.uScale.value = c.mistScale * g.noiseFrequency;
    u.uDetail.value = c.mistDetail;
    u.uFilament.value = c.mistFilament;
    u.uThreshold.value = c.mistThreshold;
    u.uRise.value = c.mistRise * g.noiseSpeed;
    u.uStretch.value = c.mistStretch;
    u.uTwist.value = c.mistTwist;
    u.uSpin.value = c.mistSpin * TAU;
    u.uEdge.value = c.mistEdge;
    u.uFlare.value = c.mistFlare;
    u.uFalloff.value = c.mistFalloff;
    u.uSkirt.value = c.mistSkirt;
    u.uLobe.value = c.mistLobe * g.noiseStrength;
    u.uTear.value = c.mistTear;
    u.uGroundGlow.value = c.mistGroundGlow * g.shaderIntensity;
    u.uGroundFalloff.value = c.mistGroundFalloff;
    u.uShadow.value = c.mistShadow;
    u.uShadowStep.value = c.mistShadowStep;
    u.uAmbient.value = c.mistAmbient;
    u.uSaturate.value = c.mistSaturate;
    u.uOpacity.value = c.mistOpacity * g.opacity;
    u.uGlow.value = c.mistGlow * g.glow;

    u.uColorDeep.value.copy(getColor(c.colorMistDeep));
    u.uColorBody.value.copy(getColor(c.colorMistBody));
    u.uColorEdge.value.copy(getColor(c.colorMistEdge));
    u.uColorGlow.value.copy(getColor(c.colorAcid));
    u.uColorLight.value.copy(getColor(c.colorMistLight));
  };

  return material;
}

/* ==================================================================== */
/* The base ring                                                         */
/* ==================================================================== */

/**
 * The ring the whole effect stands on — the brightest thing on the sheet, and
 * the element that makes the AoE *legible* before anything else has read.
 *
 * A signed-distance annulus in metres, so the band keeps its physical width when
 * the footprint is re-scaled. Three layers stack: a blown-out core one seam
 * wide, a broad halo either side of it, and a wash spilling inward across the
 * pool. On top of that the radius is pushed around by a noise on the bearing —
 * a *perfect* circle is the one thing that reads as UI rather than as something
 * burning on the floor.
 */
const RING_VERTEX = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uCore;
  uniform float uHalo;
  uniform float uHaloWidth;
  uniform float uSpill;
  uniform float uWobble;
  uniform float uWobbleScale;
  uniform float uChevrons;
  uniform float uChevronDepth;
  uniform float uScroll;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uSweepWidth;
  uniform float uTicks;
  uniform float uBoil;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorRing;
  uniform vec3  uColorCore;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float rad = length(p);
    float ang = atan(p.y, p.x);
    vec2 dir = rad > 1e-4 ? p / rad : vec2(1.0, 0.0);

    // The far side of the ring is nearly edge-on: one pixel there covers tens of
    // centimetres of floor, where near the camera it covers one.
    float aa = fwidth(rad);
    // A perfect circle reads as UI, so the radius wanders with the bearing — but
    // out on that far arc a three-centimetre wander is a long way across the
    // screen, and the ring picks up a notch. Damp it with the footprint: the
    // wobble is only worth having where it can be seen as a wobble.
    float wob = snoise(vec3(dir * uWobbleScale, uSeed + uTime * 0.12));
    float R = uRadius * (1.0 + wob * uWobble * (1.0 - smoothstep(0.02, 0.11, aa)));
    float d = abs(rad - R);

    float surge = 1.0 + uBoil;

    // Floor the core at the pixel footprint and give back the brightness that
    // widening it cost — the same light over a wider band, which is what a thin
    // bright line at a grazing angle actually does.
    float w0 = max(uWidth, 1e-3) * (1.0 + uBoil * 0.35);
    float w = max(w0, aa * 0.9);
    float conserve = w0 / w;

    // Core, then halo. The core is deliberately allowed to blow out — the
    // bloom pass is what turns it into the band on the reference sheet.
    float core = exp(-pow(d / w, 2.0)) * uCore * conserve;
    float halo = exp(-d / max(uHaloWidth, 1e-3)) * uHalo;
    // Inward only: the wash belongs to the pool, and spilling it outward makes
    // the footprint unreadable.
    float spill = smoothstep(R, R * 0.35, rad) * uSpill;

    // Energy running round the band.
    float chev = pow(0.5 + 0.5 * cos(ang * uChevrons - uTime * uScroll * TAU), 3.0);
    float ticks = pow(0.5 + 0.5 * cos(ang * uTicks), 24.0);
    float head = pow(0.5 + 0.5 * cos(ang - uTime * uSweepSpeed * TAU), 1.0 / max(uSweepWidth, 1e-3));

    float band = core * (1.0 - uChevronDepth + uChevronDepth * chev);
    band += core * ticks * 0.8;
    band += core * head * uSweep;

    float bright = (band + halo * (0.6 + 0.4 * chev)) * surge;
    vec3 color = mix(uColorRing, uColorCore, clamp(core * 0.8, 0.0, 1.0));
    color = color * bright + uColorRing * spill * surge * 0.6;

    float alpha = clamp(bright + spill, 0.0, 3.0) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

export function createAcidRingMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 12 },
      uRadius: { value: 5 },
      uWidth: { value: 0.09 },
      uCore: { value: 2.6 },
      uHalo: { value: 0.8 },
      uHaloWidth: { value: 0.45 },
      uSpill: { value: 0.18 },
      uWobble: { value: 0.02 },
      uWobbleScale: { value: 2.6 },
      uChevrons: { value: 34 },
      uChevronDepth: { value: 0.3 },
      uScroll: { value: 0.06 },
      uSweep: { value: 1.2 },
      uSweepSpeed: { value: 0.22 },
      uSweepWidth: { value: 0.12 },
      uTicks: { value: 6 },
      uBoil: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uColorRing: { value: new Color(0.45, 1.0, 0.12) },
      uColorCore: { value: new Color(0.92, 1.0, 0.72) }
    }),
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT
  });

  /** @param {object} state { radius, quadSize, boil, gain, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.acid;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uBoil.value = state.boil * c.boilDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uWidth.value = c.ringWidth;
    u.uCore.value = c.ringCore * state.gain * g.shaderIntensity;
    u.uHalo.value = c.ringHalo * state.gain;
    u.uHaloWidth.value = c.ringHaloWidth;
    u.uSpill.value = c.ringSpill;
    u.uWobble.value = c.ringWobble * g.noiseStrength;
    u.uWobbleScale.value = c.ringWobbleScale * g.noiseFrequency;
    u.uChevrons.value = c.ringChevrons;
    u.uChevronDepth.value = c.ringChevronDepth;
    u.uScroll.value = c.ringScroll;
    u.uSweep.value = c.ringSweep;
    u.uSweepSpeed.value = c.ringSweepSpeed;
    u.uSweepWidth.value = c.ringSweepWidth;
    u.uTicks.value = c.ringTicks;
    u.uOpacity.value = c.ringOpacity * g.opacity;
    u.uGlow.value = c.ringGlow * g.glow;

    u.uColorRing.value.copy(getColor(c.colorRing));
    u.uColorCore.value.copy(getColor(c.colorRingCore));
  };

  return material;
}

/* ==================================================================== */
/* The collar                                                            */
/* ==================================================================== */

/**
 * The ring given height.
 *
 * A flat annulus on the floor is invisible at a low camera angle, which is
 * exactly the angle a third-person game is played at — the reference sheet's
 * ring plainly stands *up* off the ground. So a short open tube is seated on the
 * boundary and lit from its foot: the band gains a body you can see edge-on, the
 * gas above it gets something to sit on, and the whole aura keeps a silhouette
 * when the camera drops to eye level.
 *
 * Grazing angles are boosted rather than damped, because a thin sheet of light
 * seen edge-on is the case where you look through the most of it.
 */
const COLLAR_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vViewZ;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    // An upright tube of uniform radius: the outward direction *is* the normal.
    vNormalW = normalize(mat3(modelMatrix) * vec3(position.x, 0.0, position.z));
    vViewDir = cameraPosition - world.xyz;
    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const COLLAR_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uGain;
  uniform float uFalloff;
  uniform float uFresnel;
  uniform float uStreaks;
  uniform float uStreakDepth;
  uniform float uStreakSpeed;
  uniform float uChevrons;
  uniform float uScroll;
  uniform float uBoil;
  uniform float uSoftFade;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorRing;
  uniform vec3  uColorCore;

  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    float up = clamp(vUv.y, 0.0, 1.0);

    // Bright at the foot, gone by the crown.
    float body = pow(1.0 - up, uFalloff);

    // Vertical filaments licking up off the band, torn by their own noise so
    // the collar is not a gradient with stripes on it.
    float streak = snoise01(vec3(vUv.x * uStreaks, up * 2.2 - uTime * uStreakSpeed, uSeed));
    body *= 1.0 - uStreakDepth + uStreakDepth * streak;

    float chev = pow(0.5 + 0.5 * cos(vUv.x * TAU * uChevrons - uTime * uScroll * TAU), 3.0);
    body *= 0.7 + 0.3 * chev;

    // A sheet of light seen edge-on is where you look through the most of it.
    float rim = fresnelTerm(vViewDir, vNormalW, uFresnel, 1.0);
    float bright = body * (0.65 + rim * 0.9) * uGain * (1.0 + uBoil);

    // Pale only in the last centimetres, where it is genuinely the same light as
    // the ring. Carried further up it doubles the ring's white against the far
    // rim, and 16 streaks compressed into that grazing arc turn the pair into a
    // jagged bolt lying across the pool.
    vec3 color = mix(uColorRing, uColorCore, clamp(pow(1.0 - up, 6.0) * 0.55, 0.0, 1.0));

    float alpha = clamp(bright, 0.0, 2.0) * uFade * uOpacity;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= bright * uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

export function createAcidCollarMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uGain: { value: 1.4 },
      uFalloff: { value: 2.2 },
      uFresnel: { value: 1.6 },
      uStreaks: { value: 26 },
      uStreakDepth: { value: 0.55 },
      uStreakSpeed: { value: 1.1 },
      uChevrons: { value: 34 },
      uScroll: { value: 0.06 },
      uBoil: { value: 0 },
      uSoftFade: { value: 0.4 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uColorRing: { value: new Color(0.45, 1.0, 0.12) },
      uColorCore: { value: new Color(0.92, 1.0, 0.72) }
    }),
    vertexShader: COLLAR_VERTEX,
    fragmentShader: COLLAR_FRAGMENT
  });

  /** @param {object} state { boil, gain, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.acid;
    const g = settings.global;
    const u = material.uniforms;

    u.uBoil.value = state.boil * c.boilDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uGain.value = c.collarGain * state.gain * g.shaderIntensity;
    u.uFalloff.value = c.collarFalloff;
    u.uFresnel.value = c.collarFresnel * g.fresnel;
    u.uStreaks.value = c.collarStreaks;
    u.uStreakDepth.value = c.collarStreakDepth;
    u.uStreakSpeed.value = c.collarStreakSpeed * g.noiseSpeed;
    u.uChevrons.value = c.ringChevrons;
    u.uScroll.value = c.ringScroll;
    u.uSoftFade.value = c.collarSoftFade;
    u.uOpacity.value = c.collarOpacity * g.opacity;
    u.uGlow.value = c.ringGlow * g.glow;

    u.uColorRing.value.copy(getColor(c.colorRing));
    u.uColorCore.value.copy(getColor(c.colorRingCore));
  };

  return material;
}

/* ==================================================================== */
/* The corrosive shimmer                                                 */
/* ==================================================================== */

/**
 * Writes screen-space refraction offsets instead of colour — the mesh lives on
 * `LAYER.DISTORTION`, is invisible to the main pass, and the composite warps the
 * frame by whatever this leaves in the buffer:
 *
 *   R,G → offset encoded around 0.5   B → strength   A → coverage
 *
 * Not the same field as a fire's heat haze. Fumes off a chemical reaction *roll*
 * — the offsets are spun about the column's axis with height, so the warp turns
 * with the gas above it rather than shivering straight up. Camera-facing,
 * because a flat proxy seen edge-on writes nothing and the shimmer would vanish
 * as the camera orbits.
 */
const FUME_VERTEX = /* glsl */ `
  uniform float uWidth;
  uniform float uHeight;

  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    vUv = uv;

    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * vec2(uWidth, uHeight);
    // World position for the noise, so the shimmer is welded to the floor and
    // does not slide when the camera moves.
    vWorld = (modelMatrix * vec4(position.x * uWidth, position.y * uHeight, 0.0, 1.0)).xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const FUME_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uFalloff;
  uniform float uSwirl;
  uniform float uBoil;
  uniform float uSeed;
  uniform float uShaderIntensity;

  varying vec2 vUv;
  varying vec3 vWorld;

  ${noiseGLSL}

  void main() {
    // Rolls as it rises: the sampling plane is turned by height, so the warp
    // shares the mist's vortex instead of running straight up past it.
    vec2 xz = rot2(vWorld.y * uSwirl + uTime * 0.15) * vWorld.xz;
    vec3 np = vec3(xz * uScale, vWorld.y * uScale * 0.45 - uTime * uSpeed + uSeed);
    float nx = snoise(np);
    float ny = snoise(np + vec3(19.3, 7.7, 31.1));

    vec2 c = (vUv - 0.5) * 2.0;
    // Strongest just off the floor and thinning with height, feathered at both
    // sides so the warp never shows a border.
    float mask = (1.0 - smoothstep(0.25, 1.0, abs(c.x)))
               * (1.0 - smoothstep(0.0, 1.0, pow(clamp(vUv.y, 0.0, 1.0), 1.0 / max(uFalloff, 0.05))));
    mask *= smoothstep(0.0, 0.08, vUv.y);

    float strength = uStrength * uShaderIntensity * mask * (1.0 + uBoil);
    if (strength < 0.002) discard;

    gl_FragColor = vec4(vec2(nx, ny) * 0.5 + 0.5, strength, mask);
  }
`;

export function createAcidFumeMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uWidth: { value: 8 },
      uHeight: { value: 5 },
      uStrength: { value: 1 },
      uScale: { value: 1.9 },
      uSpeed: { value: 1.1 },
      uFalloff: { value: 1.3 },
      uSwirl: { value: 0.35 },
      uBoil: { value: 0 },
      uSeed: { value: 0 }
    }),
    vertexShader: FUME_VERTEX,
    fragmentShader: FUME_FRAGMENT
  });

  /** @param {object} state { width, height, strength, boil, seed } */
  material.userData.sync = (state) => {
    const c = settings.acid;
    const g = settings.global;
    const u = material.uniforms;

    u.uWidth.value = state.width;
    u.uHeight.value = state.height;
    u.uStrength.value = state.strength * c.fumeStrength * g.distortion;
    u.uScale.value = c.fumeScale * g.noiseFrequency;
    u.uSpeed.value = c.fumeSpeed * g.noiseSpeed;
    u.uFalloff.value = c.fumeFalloff;
    u.uSwirl.value = c.fumeSwirl;
    u.uBoil.value = state.boil * c.boilDepth;
    u.uSeed.value = state.seed;
  };

  return material;
}
