import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The two passes a bolt is drawn in. Same geometry, same path, same uniforms —
 * only the ribbon width and the cross-ribbon profile differ.
 */
export const BoltPass = Object.freeze({
  CORE: 0, // the hot filament itself
  GLOW: 1 // the wide halo the filament sits inside
});

/**
 * The whole bolt lives in this vertex shader.
 *
 * A vertex arrives as `(t, side)` — how far along the bolt it is and which edge
 * of the ribbon it is on — and leaves as a world position. Everything in
 * between is derived from `settings.thunder`, so there is no path on the CPU to
 * go stale: dragging `jitter` re-kinks a bolt that is already in the air, and
 * dragging `spread` re-fans it, both with the clock stopped.
 *
 * Three things stack to make the shape:
 *
 *   1. **the axis** — a straight line from the hand to the impact point, bowed
 *      by `sag`. This is the only part that knows where the cast is pointing.
 *   2. **the fan** — a constant per-filament offset in the plane perpendicular
 *      to the axis, opening from `spreadNear` at the hand to `spread` at the
 *      target and rolling around the axis with `twist`. This is what separates
 *      one filament from the next.
 *   3. **the kinks** — octaves of *linearly* interpolated value noise. Linear
 *      on purpose: smoothstep would round the corners off, and the corners are
 *      the entire reason it reads as lightning rather than as a wobbly tube.
 *
 * The ribbon is then turned to face the camera by crossing the local tangent
 * with the view vector, which is why the bolt keeps its apparent thickness from
 * any angle without ever being a screen-space line.
 */
const BOLT_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSag;
  uniform float uSeed;
  uniform float uRestrike;

  uniform float uStrands;
  uniform float uSpread;
  uniform float uSpreadNear;
  uniform float uSpreadCurve;
  uniform float uTwist;
  uniform float uTwistSpeed;

  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;
  uniform float uConverge;

  uniform float uWidth;
  uniform float uWidthTip;
  uniform float uWidthCurve;
  uniform float uCoreWidth;
  uniform float uWidthScale;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;
  uniform float uFade;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}

  /** Value noise with a *linear* ramp — piecewise-linear output, sharp corners. */
  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

  /**
   * Offset of one filament from the axis, in the perpendicular plane.
   * span is the length of the cast, so uJitterScale stays kinks per *metre*
   * however far the bolt reaches.
   */
  vec2 kink(float t, float seed, float span) {
    vec2 o = vec2(0.0);
    float amp = 1.0;
    float freq = max(uJitterScale, 0.01) * span;
    float scroll = uTime * uCrawl;

    // Fixed trip count with a per-octave gate: a dynamic bound is not portable,
    // and five multiply-adds are cheaper than the branch would be anyway.
    for (int i = 0; i < 5; i++) {
      float on = step(float(i), uOctaves - 1.0);
      o.x += on * amp * vnoise(t * freq + scroll, seed + 13.0 * float(i));
      o.y += on * amp * vnoise(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
      amp *= uJitterFalloff;
      freq *= 2.0;
      scroll *= 1.63;
    }
    return o;
  }

  vec3 boltPoint(float t, float seed, float radial, vec3 n1, vec3 n2, float span) {
    vec3 axis = mix(uOrigin, uTarget, t);
    axis.y += uSag * sin(t * PI);

    // Pinned at the hand always, and at the target as hard as uConverge asks —
    // a bolt that lands somewhere other than where it was aimed reads as a bug.
    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) *
                 mix(1.0, smoothstep(0.0, pinch, 1.0 - t), clamp(uConverge, 0.0, 1.0));

    vec2 offset = kink(t, seed, span) * uJitter * ends;

    float angle = seed * TAU + (t * uTwist + uTime * uTwistSpeed) * TAU;
    float reach = mix(uSpreadNear, uSpread, pow(clamp(t, 0.0, 1.0), max(uSpreadCurve, 0.01)));
    offset += vec2(cos(angle), sin(angle)) * reach * radial;

    return axis + n1 * offset.x + n2 * offset.y;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    /* ---- the frame the offsets live in ---- */
    vec3 delta = uTarget - uOrigin;
    float span = max(length(delta), 0.01);
    vec3 dir = delta / span;
    // Gram-Schmidt rather than the raw lateral: the axis tilts downward from the
    // hand, so uSide is only approximately perpendicular to it.
    vec3 n1 = uSide - dir * dot(uSide, dir);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    /* ---- which filament is this, and what shape is it wearing ---- */
    // The strike index snaps every filament onto a new shape uRestrike times a
    // second; the crawl inside kink() slides it continuously in between. Both
    // together are what stops a held bolt looking like a static ribbon.
    float strike = floor(uTime * max(uRestrike, 0.01));
    float seed = hash11(aStrand * 7.13 + uSeed + strike * 3.77) * 97.0;
    float radial = uStrands <= 1.0 ? 0.0 : aStrand / (uStrands - 1.0);
    vStrand = radial;

    vec3 here = boltPoint(t, seed, radial, n1, n2, span);

    // Tangent by finite difference, mirrored at the far end so the last node
    // still has a neighbour to look at.
    float step_ = 0.02;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = boltPoint(ahead, seed, radial, n1, n2, span);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

    /* ---- turn the ribbon to face the camera ---- */
    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    /* ---- width ---- */
    // A stuttering per-filament blink, quantised to uFlickerSpeed so the whole
    // bundle strobes on the same clock instead of shimmering independently.
    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;

    float halfWidth = uWidth * uWidthScale;
    halfWidth *= mix(1.0, uWidthTip, pow(clamp(t, 0.0, 1.0), max(uWidthCurve, 0.01)));
    halfWidth *= mix(uCoreWidth, 1.0, radial);
    halfWidth *= flash * uFade;

    // World space throughout: the ability's group is an identity transform, and
    // going through modelMatrix would only invite it to drift.
    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BOLT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uTipGlow;
  uniform float uTipLength;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uBranchDim;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    // Ahead of the strike front there is no bolt yet. The ribbon is drawn whole
    // and clipped here rather than scaled, so the *shape* never changes as the
    // front travels — only how much of it exists.
    float tip = max(uTipLength, 1e-3);
    float drawn = smoothstep(uProgress, uProgress - tip, vT);
    if (drawn <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef BOLT_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
      float alpha = profile;
    #endif

    // The leading edge is where the air is actually breaking down.
    color += uColorCore * smoothstep(uProgress - tip * 2.0, uProgress, vT) * uTipGlow;

    // Quantised, not sinusoidal: real lightning stutters between brightnesses,
    // it does not breathe.
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);

    alpha *= drawn * flicker * vFlash * uFade * uPassOpacity * uOpacity;
    alpha *= mix(1.0, clamp(uBranchDim, 0.0, 1.0), vStrand);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One pass of a bolt.
 *
 * Both passes share every uniform except the two that define the pass itself
 * (`uWidthScale`, `uPassOpacity`), so `userData.sync()` can be handed the same
 * state for each and the editor drives them together.
 *
 * @param {number} pass BoltPass.*
 */
export function createLightningMaterial(pass = BoltPass.CORE) {
  const glow = pass === BoltPass.GLOW;

  const material = new ShaderMaterial({
    defines: glow ? { BOLT_GLOW: '' } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uOrigin: { value: new Vector3() },
      uTarget: { value: new Vector3(0, 0, 1) },
      uSide: { value: new Vector3(1, 0, 0) },
      uSag: { value: 0.2 },
      uSeed: { value: 0 },
      uRestrike: { value: 24 },
      uProgress: { value: 0 },
      uFade: { value: 1 },

      uStrands: { value: 9 },
      uSpread: { value: 0.75 },
      uSpreadNear: { value: 0.05 },
      uSpreadCurve: { value: 1.6 },
      uTwist: { value: 0.45 },
      uTwistSpeed: { value: 0.8 },
      uBranchDim: { value: 0.72 },

      uJitter: { value: 0.34 },
      uJitterScale: { value: 0.85 },
      uOctaves: { value: 4 },
      uJitterFalloff: { value: 0.55 },
      uCrawl: { value: 3.2 },
      uPinch: { value: 0.14 },
      uConverge: { value: 0.8 },

      uWidth: { value: 0.085 },
      uWidthTip: { value: 0.5 },
      uWidthCurve: { value: 1 },
      uCoreWidth: { value: 2.1 },
      uCoreSharp: { value: 3.4 },
      uGlowFalloff: { value: 2.4 },
      uWidthScale: { value: glow ? 8 : 1 },
      uPassOpacity: { value: glow ? 0.32 : 1 },
      uSoftFade: { value: 0.5 },

      uFlicker: { value: 0.3 },
      uFlickerSpeed: { value: 34 },
      uStrandFlash: { value: 0.5 },
      uTipGlow: { value: 2 },
      uTipLength: { value: 0.08 },

      uOpacity: { value: 1 },
      uGlow: { value: 2.3 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorInner: { value: new Color(0.78, 0.92, 1) },
      uColorOuter: { value: new Color(0.22, 0.62, 1) },
      uColorHalo: { value: new Color(0.04, 0.24, 0.78) }
    }),
    vertexShader: BOLT_VERTEX,
    fragmentShader: BOLT_FRAGMENT
  });

  /**
   * Push the live settings and the current cast state into the uniforms.
   *
   * Called every frame — including on a zero-length frame while the sandbox is
   * paused, which is what keeps every control below a live slider.
   *
   * @param {object} state { origin, target, side, progress, fade, seed, strands }
   */
  material.userData.sync = (state) => {
    const c = settings.thunder;
    const g = settings.global;
    const u = material.uniforms;

    u.uOrigin.value.copy(state.origin);
    u.uTarget.value.copy(state.target);
    u.uSide.value.copy(state.side);
    u.uSeed.value = state.seed;
    u.uProgress.value = state.progress;
    u.uFade.value = state.fade;
    u.uStrands.value = state.strands;

    u.uSag.value = c.sag;
    u.uRestrike.value = c.restrike;

    u.uSpread.value = c.spread;
    u.uSpreadNear.value = c.spreadNear;
    u.uSpreadCurve.value = c.spreadCurve;
    u.uTwist.value = c.twist;
    u.uTwistSpeed.value = c.twistSpeed;
    u.uBranchDim.value = c.branchDim;

    // The kinks are the one place `global.randomness` and the noise multipliers
    // have anything to bite on, so they scale here rather than everywhere.
    u.uJitter.value = c.jitter * g.randomness * g.noiseStrength;
    u.uJitterScale.value = c.jitterScale * g.noiseFrequency;
    u.uOctaves.value = Math.round(c.octaves);
    u.uJitterFalloff.value = c.jitterFalloff;
    u.uCrawl.value = c.crawl * g.noiseSpeed;
    u.uPinch.value = c.pinch;
    u.uConverge.value = c.converge;

    u.uWidth.value = c.width;
    u.uWidthTip.value = c.widthTip;
    u.uWidthCurve.value = c.widthCurve;
    u.uCoreWidth.value = c.coreWidth;
    u.uCoreSharp.value = c.coreSharp;
    u.uGlowFalloff.value = c.glowFalloff;
    u.uWidthScale.value = glow ? c.glowWidth : 1;
    u.uPassOpacity.value = glow ? c.glowOpacity : 1;
    u.uSoftFade.value = c.softFade;

    u.uFlicker.value = c.flicker;
    u.uFlickerSpeed.value = c.flickerSpeed;
    u.uStrandFlash.value = c.strandFlash;
    u.uTipGlow.value = c.tipGlow;
    u.uTipLength.value = c.tipLength;

    u.uOpacity.value = c.opacity * g.opacity;
    u.uGlow.value = c.glow;
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorInner.value.copy(getColor(c.colorInner));
    u.uColorOuter.value.copy(getColor(c.colorOuter));
    u.uColorHalo.value.copy(getColor(c.colorHalo));
  };

  return material;
}
