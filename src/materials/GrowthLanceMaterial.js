import { AdditiveBlending, Color, DoubleSide, ShaderMaterial, Vector3, Vector4 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/** How many lances may be in the air at once. One instance apiece, one draw. */
export const MAX_LANCES = 6;

/**
 * The lance the bloom fires.
 *
 * A volley is **one draw call**. Every shot is one instance of the same tube,
 * and each instance reads its own two endpoints and its own clock out of a
 * small uniform array — so four bodies being cut down at once costs exactly what
 * one does. The alternative (a mesh per shot, placed and scaled on the CPU)
 * needs a pool, a matrix per frame per shot, and four draws; this needs an
 * index.
 *
 * The shape is the beam ability's, cut down to what a *cut* needs. Where that
 * one is a column with weather inside it, this is an **edge**: thin, hard, hot
 * white in the middle and green at its sheath, with the same axis-weighted core
 * (brightest where the view ray runs down the barrel, so the middle reads as a
 * solid rod rather than as a lit pipe) and two things of its own —
 *
 *  - a pair of **helices** wound around it, drawn as an intensity pattern on
 *    the tube's own surface rather than as extra geometry. Nature magic that
 *    fires a clean laser reads as science fiction; the twist is what keeps it
 *    growing even while it cuts.
 *  - a **strike** profile. The lance does not fade up: it arrives, in the first
 *    tenth of its life, as a point that reaches the target — and the frame it
 *    lands is the frame the body comes apart.
 */

const LANCE_VERTEX = /* glsl */ `
  #define LTAU 6.283185307179586
  #define LPI  3.141592653589793

  attribute float aLance;

  uniform vec3  uOrigin[MAX_LANCES];
  uniform vec3  uTarget[MAX_LANCES];
  uniform vec4  uState[MAX_LANCES];

  uniform float uTime;
  uniform float uRadius;
  uniform float uRadiusMuzzle;
  uniform float uRadiusCurve;
  uniform float uFlare;
  uniform float uFlareWidth;
  uniform float uThrob;
  uniform float uThrobBands;
  uniform float uThrobSpeed;
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;
  uniform float uStrike;
  uniform float uHold;

  varying float vT;
  varying float vA;
  varying float vFacing;
  varying float vLife;
  varying float vSeed;
  varying float vLive;
  varying float vReach;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    int slot = int(aLance + 0.5);
    vec3 from = uOrigin[slot];
    vec3 to = uTarget[slot];
    vec4 state = uState[slot];

    float life = state.x;
    float seed = state.y;
    float width = state.z;
    float live = state.w;

    // How far down the line the lance has actually reached. Fast, and eased out
    // so it *lands* rather than stopping dead.
    float reach = clamp(life / max(uStrike, 1e-3), 0.0, 1.0);
    reach = 1.0 - pow(1.0 - reach, 3.0);
    // And how much of it is left. It holds while it cuts, then snaps out.
    float spent = clamp((life - uHold) / max(1.0 - uHold, 1e-3), 0.0, 1.0);
    float fade = 1.0 - spent * spent;

    vec3 delta = to - from;
    float span = max(length(delta), 0.01);
    vec3 dir = delta / span;
    vec3 n1 = normalize(cross(dir, abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    float t = position.x * reach;
    float a = position.y;
    float angle = a * LTAU;
    vec3 nrm = n1 * cos(angle) + n2 * sin(angle);

    /* ---- half-width at t ---- */
    float r = mix(uRadiusMuzzle, uRadius, pow(clamp(t, 0.0, 1.0), max(uRadiusCurve, 0.01)));
    r *= 1.0 + uThrob * sin((t * uThrobBands - uTime * uThrobSpeed) * LTAU + seed * 13.0);
    r *= 1.0 + uFlare * smoothstep(1.0 - max(uFlareWidth, 1e-3), 1.0, t / max(reach, 1e-3));
    r *= width * fade;
    // Drawn to a point at the head while it is still travelling, so the strike
    // is a spearhead rather than a rod that appears at full length.
    r *= smoothstep(0.0, 0.06, position.x) * (1.0 - smoothstep(0.86, 1.0, position.x) * (1.0 - reach));

    /* ---- the axis, with a little life in it ---- */
    vec3 axis = mix(from, to, t);
    float ends = sin(clamp(position.x, 0.0, 1.0) * LPI);
    axis += n1 * snoise(vec3(t * uWanderScale, uTime * uWanderSpeed, seed)) * uWander * ends;
    axis += n2 * snoise(vec3(t * uWanderScale + 21.3, uTime * uWanderSpeed, seed + 4.1)) * uWander * ends;

    vec3 here = axis + nrm * max(r, 1e-5);
    // An idle slot is collapsed onto its own origin: no fragments, no branch.
    here = mix(from, here, live);

    vT = t;
    vA = a;
    vLife = life;
    vSeed = seed;
    vLive = live;
    vReach = reach;
    vFacing = abs(dot(normalize(cameraPosition - here), nrm));

    vec4 mv = viewMatrix * vec4(here, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const LANCE_FRAGMENT = /* glsl */ `
  #define LTAU 6.283185307179586

  uniform float uTime;
  uniform float uCoreFill;
  uniform float uEdgePower;
  uniform float uSheath;
  uniform float uCoils;
  uniform float uCoilTurns;
  uniform float uCoilSpeed;
  uniform float uCoilWidth;
  uniform float uCoilGain;
  uniform float uMotes;
  uniform float uMoteScale;
  uniform float uMoteSpeed;
  uniform float uHeadGlow;
  uniform float uHeadWidth;
  uniform float uHold;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorCoil;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying float vT;
  varying float vA;
  varying float vFacing;
  varying float vLife;
  varying float vSeed;
  varying float vLive;
  varying float vReach;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    if (vLive < 0.5) discard;

    float spent = clamp((vLife - uHold) / max(1.0 - uHold, 1e-3), 0.0, 1.0);
    float fade = 1.0 - spent * spent;

    // Weighted toward the axis: the path a view ray takes through the tube is
    // longest looking straight down it, so that is where the white belongs.
    float core = pow(clamp(vFacing, 0.0, 1.0), max(uCoreFill, 0.05));
    // ... and the opposite weighting for the sheath around it, which is what
    // gives the lance a silhouette instead of a soft edge.
    float sheath = pow(1.0 - clamp(vFacing, 0.0, 1.0), max(uEdgePower, 0.05)) * uSheath;

    /* ---- the helices ---- */
    float coilPhase = vA * uCoils - vT * uCoilTurns + uTime * uCoilSpeed + vSeed;
    float coil = abs(fract(coilPhase) - 0.5) * 2.0;
    coil = 1.0 - smoothstep(0.0, max(uCoilWidth, 1e-3), coil);
    coil *= uCoilGain;

    /* ---- motes carried along inside it ---- */
    float motes = snoise01(vec3(vA * 3.0, vT * uMoteScale - uTime * uMoteSpeed, vSeed * 7.0));
    motes = pow(motes, 8.0) * uMotes;

    /* ---- the head, where it is going through something ---- */
    float head = 1.0 - smoothstep(0.0, max(uHeadWidth, 1e-3), abs(vT - vReach));
    head *= uHeadGlow;

    float energy = core + sheath + coil + motes + head;
    vec3 color = mix(uColorOuter, uColorInner, clamp(core * 1.3, 0.0, 1.0));
    color = mix(color, uColorCore, clamp(pow(core, 2.0) + head, 0.0, 1.0));
    color += uColorCoil * coil * 0.7;
    color *= energy * uIntensity * fade;

    float alpha = clamp(energy * 0.9, 0.0, 1.0) * fade * uOpacity;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    color /= 1.0 + color * 0.1;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The lances, as one material driving every shot in flight.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync` and, on its uniforms,
 *   the `uOrigin` / `uTarget` / `uState` arrays the ability writes each frame.
 */
export function createGrowthLanceMaterial() {
  const origin = [];
  const target = [];
  const state = [];
  for (let i = 0; i < MAX_LANCES; i++) {
    origin.push(new Vector3());
    target.push(new Vector3(0, 1, 0));
    // x = life 0..1, y = seed, z = width, w = live
    state.push(new Vector4(0, 0, 1, 0));
  }

  const material = new ShaderMaterial({
    name: 'GrowthLance',
    defines: { MAX_LANCES },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uOrigin: { value: origin },
      uTarget: { value: target },
      uState: { value: state },

      uRadius: { value: 0.085 },
      uRadiusMuzzle: { value: 0.16 },
      uRadiusCurve: { value: 0.6 },
      uFlare: { value: 0.7 },
      uFlareWidth: { value: 0.14 },
      uThrob: { value: 0.16 },
      uThrobBands: { value: 5 },
      uThrobSpeed: { value: 2.2 },
      uWander: { value: 0.05 },
      uWanderScale: { value: 4 },
      uWanderSpeed: { value: 1.6 },
      uStrike: { value: 0.12 },
      uHold: { value: 0.42 },

      uCoreFill: { value: 2.4 },
      uEdgePower: { value: 2.6 },
      uSheath: { value: 0.75 },
      uCoils: { value: 2 },
      uCoilTurns: { value: 7 },
      uCoilSpeed: { value: 1.1 },
      uCoilWidth: { value: 0.34 },
      uCoilGain: { value: 0.9 },
      uMotes: { value: 1.1 },
      uMoteScale: { value: 14 },
      uMoteSpeed: { value: 3.2 },
      uHeadGlow: { value: 2.2 },
      uHeadWidth: { value: 0.06 },
      uIntensity: { value: 2.4 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.35 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorInner: { value: new Color(0.6, 1, 0.6) },
      uColorOuter: { value: new Color(0.1, 0.7, 0.35) },
      uColorCoil: { value: new Color(0.8, 1, 0.4) }
    }),
    vertexShader: LANCE_VERTEX,
    fragmentShader: LANCE_FRAGMENT
  });

  material.userData.sync = () => {
    const c = settings.growth;
    const g = settings.global;
    const u = material.uniforms;

    u.uRadius.value = c.lanceRadius;
    u.uRadiusMuzzle.value = c.lanceMuzzleRadius;
    u.uRadiusCurve.value = c.lanceRadiusCurve;
    u.uFlare.value = c.lanceFlare;
    u.uFlareWidth.value = c.lanceFlareWidth;
    u.uThrob.value = c.lanceThrob;
    u.uThrobBands.value = c.lanceThrobBands;
    u.uThrobSpeed.value = c.lanceThrobSpeed * g.noiseSpeed;
    u.uWander.value = c.lanceWander * g.noiseStrength;
    u.uWanderScale.value = c.lanceWanderScale * g.noiseFrequency;
    u.uWanderSpeed.value = c.lanceWanderSpeed * g.noiseSpeed;
    u.uStrike.value = c.lanceStrike;
    u.uHold.value = c.lanceHold;

    u.uCoreFill.value = c.lanceCoreFill;
    u.uEdgePower.value = c.lanceEdgePower;
    u.uSheath.value = c.lanceSheath * g.fresnel;
    u.uCoils.value = Math.max(1, Math.round(c.lanceCoils));
    u.uCoilTurns.value = c.lanceCoilTurns;
    u.uCoilSpeed.value = c.lanceCoilSpeed * g.noiseSpeed;
    u.uCoilWidth.value = c.lanceCoilWidth;
    u.uCoilGain.value = c.lanceCoilGain * g.shaderIntensity;
    u.uMotes.value = c.lanceMotes;
    u.uMoteScale.value = c.lanceMoteScale * g.noiseFrequency;
    u.uMoteSpeed.value = c.lanceMoteSpeed * g.noiseSpeed;
    u.uHeadGlow.value = c.lanceHeadGlow * g.shaderIntensity;
    u.uHeadWidth.value = c.lanceHeadWidth;
    u.uIntensity.value = c.lanceIntensity * g.shaderIntensity;
    u.uOpacity.value = c.lanceOpacity * g.opacity;
    u.uSoftFade.value = c.lanceSoftFade;

    u.uColorCore.value.copy(getColor(c.colorLanceCore));
    u.uColorInner.value.copy(getColor(c.colorLanceInner));
    u.uColorOuter.value.copy(getColor(c.colorLanceOuter));
    u.uColorCoil.value.copy(getColor(c.colorLanceCoil));
  };

  return material;
}
