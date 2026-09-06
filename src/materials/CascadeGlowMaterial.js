import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The ground glow — layer 4, and the only part of the mark with no edges in it.
 *
 * The reference sheet draws it as an ellipse because it is a disc seen from
 * three-quarters; there is nothing elliptical about the shader. What there *is*
 * is three terms that have to be kept apart or the panel reads as a blob:
 *
 *  - **the pool**, a soft radial falloff that carries the colour and most of
 *    the area. On its own it is a vignette.
 *  - **the lip**, a band of light sitting just inside the boundary. This is the
 *    term that makes the pool read as a *pool* — a bounded thing lying on the
 *    floor rather than a light source parked above it — and it is why the
 *    footprint the indicator measured out is legible from any angle.
 *  - **the spill**, a wide low wash reaching past the boundary, which is what
 *    stops the lip reading as a rim of paint.
 *
 * It sits under everything: drawn first, at the smallest height off the floor,
 * so the mark's line work reads against it rather than through it.
 *
 * The lip is where a ground shader normally throws a bolt of white speckle
 * across the far half of the floor, so its width is floored at the pixel
 * footprint and its brightness scaled back by however far it had to open — a
 * band seen edge-on gets thicker and dimmer instead of dissolving into sparks.
 * The radius wobble is damped by the same footprint: three centimetres of
 * wander is a long way across the screen on the far arc.
 */

const GLOW_VERTEX = /* glsl */ `
  varying vec2  vUv;
  varying float vViewZ;

  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const GLOW_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uGrown;
  uniform float uFade;
  uniform float uSeed;
  uniform float uPulse;
  uniform float uFlare;
  uniform float uOpacity;
  uniform float uGlow;

  uniform float uPool;
  uniform float uPoolFalloff;
  uniform float uLip;
  uniform float uLipSeat;
  uniform float uLipWidth;
  uniform float uSpill;
  uniform float uSpillReach;
  uniform float uSpillFalloff;
  uniform float uWobble;
  uniform float uWobbleLobes;
  uniform float uWobbleSpeed;
  uniform float uGrain;
  uniform float uGrainScale;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uSweepWidth;

  uniform vec3  uColorCore;
  uniform vec3  uColorPool;
  uniform vec3  uColorRim;

  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  #define GTAU 6.283185307179586

  /** A band of live width, antialiased and energy conserving. */
  float band(float d, float w, float aa) {
    float ww = max(w, aa);
    return (1.0 - smoothstep(0.0, ww, abs(d))) * (w / ww);
  }

  void main() {
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float r = length(p);
    float ang = atan(p.y, p.x);

    float aa = fwidth(r) + 1e-4;
    float footprint = max(fwidth(p.x), fwidth(p.y));
    float detail = 1.0 - smoothstep(0.02, 0.16, footprint);

    float outer = uRadius * uSpillReach;
    if (r > outer + 0.4) discard;

    float open = 1.0 - smoothstep(uGrown - 0.5, uGrown + 0.2, r);
    if (open < 0.002) discard;

    // The boundary is never quite a circle. Damped by the footprint, or the
    // wobble that reads as life up close reads as a serrated edge far away.
    float wobble = sin(ang * uWobbleLobes + uTime * uWobbleSpeed + uSeed * 5.0) * uWobble * detail;
    float edge = uRadius * (1.0 + wobble);

    float beat = 1.0 + uPulse + uFlare * 2.0;

    /* ---- the pool ---- */
    float pool = pow(clamp(1.0 - r / max(edge, 0.05), 0.0, 1.0), max(uPoolFalloff, 0.05)) * uPool;

    /* ---- the lip just inside the boundary ---- */
    float lip = band(r - edge * uLipSeat, uLipWidth, aa) * uLip;

    /* ---- the spill past it ---- */
    float spill = pow(clamp(1.0 - r / max(outer, 0.05), 0.0, 1.0), max(uSpillFalloff, 0.05)) * uSpill;

    /* ---- a read head turning round the pool ---- */
    // Slow, wide and faint: it is what keeps a static disc from looking like a
    // decal, and it is the only moving thing in this layer.
    float head = fract(ang / GTAU - uTime * uSweepSpeed);
    head = 1.0 - smoothstep(0.0, max(uSweepWidth, 1e-3), min(head, 1.0 - head));
    float sweep = head * uSweep * pool;

    float grain = (snoise01(vec3(p * uGrainScale, uSeed * 2.0 + uTime * 0.2)) - 0.5) * uGrain;
    pool *= 1.0 + grain * detail;

    float energy = pool + lip + spill + sweep;
    vec3 color = mix(uColorPool, uColorCore, clamp(pool * 1.6 + sweep, 0.0, 1.0)) * (pool + sweep);
    color += uColorRim * lip;
    color += uColorPool * spill;
    color *= beat;

    float alpha = clamp(energy, 0.0, 1.0) * open * uFade * uOpacity;
    if (alpha < 0.004) discard;

    color *= uGlow * uGlobalGlow;
    color /= 1.0 + color * 0.18;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The ground glow.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`
 */
export function createCascadeGlowMaterial() {
  const material = new ShaderMaterial({
    name: 'CascadeGlow',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 12 },
      uRadius: { value: 4 },
      uGrown: { value: 0 },
      uFade: { value: 1 },
      uSeed: { value: 0 },
      uPulse: { value: 0 },
      uFlare: { value: 0 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },

      uPool: { value: 0.85 },
      uPoolFalloff: { value: 1.7 },
      uLip: { value: 1.1 },
      uLipSeat: { value: 0.9 },
      uLipWidth: { value: 0.16 },
      uSpill: { value: 0.22 },
      uSpillReach: { value: 1.45 },
      uSpillFalloff: { value: 2.6 },
      uWobble: { value: 0.02 },
      uWobbleLobes: { value: 5 },
      uWobbleSpeed: { value: 0.5 },
      uGrain: { value: 0.3 },
      uGrainScale: { value: 1.6 },
      uSweep: { value: 0.5 },
      uSweepSpeed: { value: 0.09 },
      uSweepWidth: { value: 0.18 },

      uColorCore: { value: new Color() },
      uColorPool: { value: new Color() },
      uColorRim: { value: new Color() }
    }),
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT
  });

  /** @param {object} state { radius, quadSize, grown, pulse, flare, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.cascade;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uGrown.value = state.grown;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uFlare.value = state.flare;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uPool.value = c.glowPool;
    u.uPoolFalloff.value = c.glowPoolFalloff;
    u.uLip.value = c.glowLip * g.shaderIntensity;
    u.uLipSeat.value = c.glowLipSeat;
    u.uLipWidth.value = c.glowLipWidth;
    u.uSpill.value = c.glowSpill;
    u.uSpillReach.value = c.glowSpillReach;
    u.uSpillFalloff.value = c.glowSpillFalloff;
    u.uWobble.value = c.glowWobble * g.noiseStrength;
    u.uWobbleLobes.value = c.glowWobbleLobes;
    u.uWobbleSpeed.value = c.glowWobbleSpeed * g.noiseSpeed;
    u.uGrain.value = c.glowGrain * g.noiseStrength;
    u.uGrainScale.value = c.glowGrainScale * g.noiseFrequency;
    u.uSweep.value = c.glowSweep;
    u.uSweepSpeed.value = c.glowSweepSpeed;
    u.uSweepWidth.value = c.glowSweepWidth;
    u.uOpacity.value = c.glowOpacity * g.opacity;
    u.uGlow.value = c.glowGlow * g.glow;

    u.uColorCore.value.copy(getColor(c.colorGlowCore));
    u.uColorPool.value.copy(getColor(c.colorGlowPool));
    u.uColorRim.value.copy(getColor(c.colorGlowRim));
  };

  return material;
}
