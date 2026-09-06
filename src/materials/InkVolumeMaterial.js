import { ShaderMaterial, NormalBlending, Color, Vector3, Vector4, BackSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The suspended ink: a **raymarched volume**, and the panel on the reference
 * sheet that cannot be faked with cards.
 *
 * Ink hanging in water is the one shape in this ability with no surface. It has
 * no silhouette to give a billboard, it is seen *through* — the far strands
 * shade the near ones — and the character standing in the tide has to be veiled
 * by exactly the ink in front of them and none of the ink behind. So it is
 * marched, on the same four principles the Caustic Bloom's mist is:
 *
 *  1. **the proxy is only a scissor** — a closed cylinder drawn back faces
 *     only, with the depth test off, whose single job is to rasterise the
 *     pixels the volume could cover;
 *  2. **the span is analytic** — `cylinderSpan` solves the ray against the
 *     column and clips it to the height slab, which is exact, sorts nothing,
 *     and stays correct with the camera inside the ink;
 *  3. **it is clipped against the scene** — the march stops at the opaque depth
 *     prepass, which is what makes this an *aura* rather than a decal the
 *     character is pasted on top of;
 *  4. **empty space is free** — the profile is evaluated before any noise is,
 *     the march stops as soon as the ink is opaque, and the step count is a
 *     live slider so a laptop and a demo machine run the same build.
 *
 * And one that is not the Bloom's: **it stands back from what the tide is
 * holding**. Clipping against the depth prepass keeps the ink off everything
 * *behind* it, which is what makes the character look veiled rather than
 * pasted over — but a body wound into the middle of the vortex has metres of
 * ink between it and the camera, and all of that ink is legitimately in front.
 * So the tide hands the volume the bodies it has hold of (`uClears`) and the
 * march opens the *near* half of those rays: the pigment parts ahead of a
 * corpse and closes again behind it. See `openTo` in the main loop.
 *
 * Two things make it ink rather than green fog with the colours changed:
 *
 * **It absorbs.** The gas in the Caustic Bloom is lit from underneath and
 * *adds* to the frame. Ink does the opposite — it is dark and it is opaque, so
 * what it contributes is its own alpha, and the frame behind it goes away. That
 * is the entire reason this material is premultiplied and near-black.
 *
 * **It is a funnel, not a chimney.** The middle is hollowed out at the floor
 * and closes with height, so the ink hangs in the *wall* of the vortex; and the
 * twist is strongest nearest the axis (`uWind`), which is what a vortex does
 * and what a spin does not. Turn the whole volume at one rate and it reads as a
 * cylinder of noise being rotated.
 */

/**
 * How many held bodies the ink can be asked to stand back from at once.
 *
 * A tide can have sixteen; this is the number that reach the shader, and it is
 * eight because the ones that matter are the ones near the middle — beyond
 * that they are stacked on each other and share a parting anyway. The array is
 * a fixed-size uniform, so this is also the loop bound the compiler unrolls.
 */
const MAX_CLEARANCES = 8;

/** Handed to `sync` when a tide is holding nothing. */
const EMPTY = [];

const VOLUME_VERTEX = /* glsl */ `
  varying vec3 vWorld;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const VOLUME_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3  uCentre;      // world, at the base of the column
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
  uniform float uWind;
  uniform float uFunnel;
  uniform float uEdge;
  uniform float uFlare;
  uniform float uSkirt;
  uniform float uFalloff;
  uniform float uLobe;
  uniform float uTear;
  uniform float uLight;
  uniform float uShadow;
  uniform float uShadowStep;
  uniform float uAmbient;
  uniform float uSaturate;
  uniform float uSwell;
  uniform float uDrain;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorDeep;
  uniform vec3  uColorBody;
  uniform vec3  uColorEdge;
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
  #define MAX_CLEAR ${MAX_CLEARANCES}
  #define TAU 6.28318530718

  /** The bodies the tide has hold of: world centre in xyz, metres in w. */
  uniform int   uClearCount;
  uniform vec4  uClears[MAX_CLEAR];
  uniform float uClear;      // how far the ink stands back, 0..1
  uniform float uClearFade;  // metres it closes over, behind the body

  /**
   * Where the ray is inside the funnel, and how far up it is.
   *
   * Two masks, not one: a wall that opens with height, and a *hole* up the
   * middle that closes with it. The hole is the throat the pool has opened on
   * the floor, carried up into the volume — without it the ink fills the axis
   * and the vortex has no eye.
   */
  float shellProfile(vec3 q, out float h, out float rn) {
    h = clamp(q.y / max(uHeight, 1e-3), 0.0, 1.0);
    float rr = uRadius * (1.0 + uFlare * h);

    // The wall is not turned on a lathe: its radius wanders with bearing and
    // height. Without this the volume is a can of ink however good the noise
    // inside it is, which is the one thing that gives a march away.
    vec2 dir = normalize(q.xz + vec2(1e-5));
    float lobe = snoise(vec3(dir * 1.7, q.y * 0.35 - uTime * uRise * 0.4 + uSeed));
    rr *= 1.0 + lobe * uLobe * (0.25 + 0.75 * h);

    rn = length(q.xz) / max(rr, 1e-3);

    float wall = smoothstep(1.0 + uSkirt * (1.0 - h), uEdge, rn);
    // The eye of the vortex. Widest at the floor, closed over by the crown.
    float hole = uFunnel * (1.0 - h * 0.85);
    float eye = smoothstep(hole * 0.35, hole, rn);

    return wall * eye * pow(1.0 - h, uFalloff);
  }

  /** Three octaves, wound around the axis. The shape of the ink. */
  float inkNoise(vec3 q, float h, float rn) {
    // Differential rotation: the turn rises toward the axis, which is what a
    // vortex does. A constant turn is a spin, and a spun cylinder of noise
    // looks exactly like one.
    float turn = uTwist * h + uTime * uSpin * TAU + uWind / (0.25 + rn);
    vec2 xz = rot2(turn) * q.xz;

    // A low stretch squashes the sampling axis, elongating features along it:
    // the difference between strands hanging and a cloud sitting.
    vec3 np = vec3(xz * uScale, q.y * uScale * uStretch - uTime * uRise + uSeed);
    float n = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      n += a * snoise(np);
      np = np * 2.07 + vec3(13.1, 7.7, 21.3);
      a *= 0.5;
    }
    n = n * 0.5 + 0.5;

    // Ridged detail: ink in water is filament and void, never a uniform haze.
    float fil = 1.0 - abs(snoise(vec3(xz, q.y * 0.55) * uScale * uDetail + uSeed * 3.0));
    return mix(n, fil, uFilament);
  }

  /** Density at a world point. Empty space costs one profile evaluation. */
  float density(vec3 p) {
    vec3 q = p - uCentre;
    float h, rn;
    float shell = shellProfile(q, h, rn);
    if (shell <= 0.002) return 0.0;

    float n = inkNoise(q, h, rn);
    // Carved rather than faded: below the threshold there is simply no pigment,
    // and the threshold climbs, so the top tears into separate strands while
    // the body at the surface stays solid.
    float d = smoothstep(uThreshold + uTear * h, 1.0, n) * shell;
    // The swell pushes the whole volume, hardest at its feet; the drain pulls
    // it back down into the throat rather than fading it out on the spot.
    return d * uDensity * (1.0 + uSwell * (1.2 - h)) * (1.0 - uDrain * h);
  }

  /** One cheap octave, for the shadow tap only. */
  float densityCoarse(vec3 p) {
    vec3 q = p - uCentre;
    float h, rn;
    float shell = shellProfile(q, h, rn);
    if (shell <= 0.002) return 0.0;
    float turn = uTwist * h + uTime * uSpin * TAU + uWind / (0.25 + rn);
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

    /* ---- and stand it back from whatever the tide is holding ---- */
    // Solved once per ray rather than per sample: which held body this ray
    // passes through, how far along it is, and how squarely — none of that
    // moves as the march advances, so the loop below pays one smoothstep.
    // openTo is the distance the ink has to be out of the way to, and openBy
    // how completely; a feathered footprint rather than a hard disc,
    // because a hard-edged hole in a volume reads as a hole and nothing else.
    float openTo = 0.0;
    float openBy = 0.0;
    for (int i = 0; i < MAX_CLEAR; i++) {
      if (i >= uClearCount) break;
      vec3 toBody = uClears[i].xyz - ro;
      float along = dot(toBody, rd);
      if (along <= 0.0) continue;
      float miss = length(toBody - rd * along);
      float inside = 1.0 - smoothstep(uClears[i].w * 0.45, uClears[i].w * 1.25, miss);
      if (inside <= 0.0) continue;
      openTo = max(openTo, along);
      openBy = max(openBy, inside);
    }
    openBy *= uClear;

    float steps = clamp(uSteps, 4.0, float(MAX_STEPS));
    float dt = (t1 - t0) / steps;
    // Jittered start. Without it the march bands into visible shells, and that
    // banding is the single most obvious tell that a volume is stepped.
    float jitter = hash13(vec3(gl_FragCoord.xy, uTime * 60.0));
    float t = t0 + dt * jitter;

    vec3 acc = vec3(0.0);
    float trans = 1.0;

    for (int i = 0; i < MAX_STEPS; i++) {
      if (float(i) >= steps || trans < 0.012) break;

      vec3 p = ro + rd * t;
      float d = density(p);
      // Only the ink in front of the body is moved. Behind it the volume is
      // untouched, so the corpse is seen *through* a parting in the pigment
      // rather than in a tube cut out of it.
      if (openBy > 0.0) {
        d *= 1.0 - openBy * (1.0 - smoothstep(openTo - uClearFade, openTo, t));
      }

      if (d > 0.002) {
        // Daylight comes down *through* the water, so one tap toward the sun is
        // the right approximation here — and it is the term that gives a strand
        // a lit side and a shadow side instead of a flat silhouette.
        float above = densityCoarse(p + uLightDir * uShadowStep);
        vec3 sun = uColorLight * exp(-uShadow * above) * uLight;

        // Thin ink is a teal wash, thick ink is black. That gradient is the
        // whole of the form: without it the volume is one silhouette.
        vec3 body = mix(uColorEdge, uColorDeep, clamp(d * uSaturate, 0.0, 1.0));
        body = mix(body, uColorBody, 0.5);

        float a = 1.0 - exp(-d * uAbsorb * dt);
        acc += body * (sun + uAmbient) * a * trans;
        trans *= 1.0 - a;
      }

      t += dt;
    }

    float alpha = (1.0 - trans) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    acc *= uGlobalGlow;
    // Premultiplied: acc is already an integral weighted by its own alpha, so
    // the material is flagged premultipliedAlpha and no divide is needed. It is
    // also what lets near-black ink darken the frame instead of tinting it.
    gl_FragColor = vec4(acc, alpha);
  }
`;

/**
 * The suspended ink. Built once; every metre of it is resolved from
 * `settings.ink` each frame, so `zoneRadius` and `wispHeight` re-shape a volume
 * that is already hanging.
 */
export function createInkVolumeMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // The march is clipped against the depth prepass itself, which is both more
    // accurate than the depth test and works with the camera inside the ink.
    depthTest: false,
    blending: NormalBlending,
    premultipliedAlpha: true,
    side: BackSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uRadius: { value: 5 },
      uHeight: { value: 3.2 },
      uSteps: { value: 24 },
      uDensity: { value: 2.6 },
      uAbsorb: { value: 1.75 },
      uScale: { value: 0.62 },
      uDetail: { value: 2.2 },
      uFilament: { value: 0.62 },
      uThreshold: { value: 0.55 },
      uRise: { value: 0.35 },
      uStretch: { value: 0.55 },
      uTwist: { value: 2.4 },
      uSpin: { value: 0.14 },
      uWind: { value: 1.6 },
      uFunnel: { value: 0.55 },
      uEdge: { value: 0.5 },
      uFlare: { value: 0.3 },
      uSkirt: { value: 0.12 },
      uFalloff: { value: 1.35 },
      uLobe: { value: 0.3 },
      uTear: { value: 0.3 },
      uLight: { value: 0.85 },
      uShadow: { value: 2.6 },
      uShadowStep: { value: 0.8 },
      uAmbient: { value: 0.08 },
      uSaturate: { value: 2.4 },
      uSwell: { value: 0 },
      uDrain: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uClearCount: { value: 0 },
      uClears: { value: Array.from({ length: MAX_CLEARANCES }, () => new Vector4()) },
      uClear: { value: 0.85 },
      uClearFade: { value: 1.1 },
      uColorDeep: { value: new Color(0.016, 0.027, 0.04) },
      uColorBody: { value: new Color(0.07, 0.21, 0.24) },
      uColorEdge: { value: new Color(0.31, 0.56, 0.57) },
      uColorLight: { value: new Color(0.75, 0.9, 0.88) }
    }),
    vertexShader: VOLUME_VERTEX,
    fragmentShader: VOLUME_FRAGMENT
  });

  /**
   * @param {object} state { centre, radius, height, swell, drain, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.ink;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uRadius.value = state.radius;
    u.uHeight.value = state.height;
    u.uSwell.value = state.swell * c.swellDepth;
    u.uDrain.value = state.drain;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uSteps.value = Math.round(c.wispSteps);
    u.uDensity.value = c.wispDensity * g.shaderIntensity;
    u.uAbsorb.value = c.wispAbsorb;
    u.uScale.value = c.wispScale * g.noiseFrequency;
    u.uDetail.value = c.wispDetail;
    u.uFilament.value = c.wispFilament;
    u.uThreshold.value = c.wispThreshold;
    u.uRise.value = c.wispRise * g.noiseSpeed;
    u.uStretch.value = c.wispStretch;
    u.uTwist.value = c.wispTwist * g.turbulence;
    u.uSpin.value = c.wispSpin;
    u.uWind.value = c.wispWind * g.turbulence;
    u.uFunnel.value = c.wispFunnel;
    u.uEdge.value = c.wispEdge;
    u.uFlare.value = c.wispFlare;
    u.uSkirt.value = c.wispSkirt;
    u.uFalloff.value = c.wispFalloff;
    u.uLobe.value = c.wispLobe * g.noiseStrength;
    u.uTear.value = c.wispTear;
    u.uLight.value = c.wispLight;
    u.uShadow.value = c.wispShadow;
    u.uShadowStep.value = c.wispShadowStep;
    u.uAmbient.value = c.wispAmbient;
    u.uSaturate.value = c.wispSaturate;
    u.uOpacity.value = c.wispOpacity * g.opacity;

    // The bodies the tide is holding, copied rather than aliased: the ability
    // reuses one array of vectors per cast and the uniform must not follow it
    // into the next frame's edits.
    const clears = state.clears ?? EMPTY;
    const count = Math.min(clears.length, MAX_CLEARANCES);
    for (let i = 0; i < count; i++) u.uClears.value[i].copy(clears[i]);
    u.uClearCount.value = count;
    u.uClear.value = count > 0 ? c.wispClear : 0;
    // Never zero: the march feathers the parting with a smoothstep, and a
    // zero-width one is a divide by zero rather than a hard edge.
    u.uClearFade.value = Math.max(0.05, c.wispClearFade);

    u.uColorDeep.value.copy(getColor(c.colorWispDeep));
    u.uColorBody.value.copy(getColor(c.colorWispBody));
    u.uColorEdge.value.copy(getColor(c.colorWispEdge));
    u.uColorLight.value.copy(getColor(c.colorWispLight));
  };

  return material;
}
