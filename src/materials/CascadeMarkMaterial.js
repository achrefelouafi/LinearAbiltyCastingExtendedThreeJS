import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The decal mark — layer 1, the thing the whole cast is named after.
 *
 * One quad on the floor, everything in it a signed distance field, and every
 * dimension in **metres from the centre** rather than in quad space. That is
 * the decision the file hangs off: drag the footprint while a mark is standing
 * and it re-scales around its own middle with the strokes the same physical
 * width and the same number of barbs. In quad space every line would stretch
 * with the circle and the mark would read as a texture being zoomed.
 *
 * ## What is actually drawn
 *
 * The reference sheet's first panel is not a circle. It is **angular** — a
 * four-pointed star inside a diamond, barbed at every point, with a knot of
 * hooks in the middle — and almost all of it is drawn with one helper,
 * `taper`, the distance to a segment whose width runs from one end to the
 * other. Spearheads, barbs, ticks and the ribs down the diamond's edges are all
 * that function with different arguments; the hooks are its polar cousin. Two
 * exact SDFs do the rest: a four-point star (iq's, generalised over the point
 * count) and a rhombus.
 *
 * Nothing is symmetrical by accident either. The star turns one way, the
 * diamond the other and the hooks a third, at revolutions per *minute* rather
 * than per second — the mark should look machined and alive, not spun.
 *
 * ## Aliasing, which is most of the work
 *
 * A ground shader full of thin bright lines is the easiest way to put a bolt of
 * white speckle across the far half of the floor: at a grazing angle one pixel
 * covers tens of centimetres, so neighbouring pixels sample unrelated parts of
 * the field and every hard edge resolves to full brightness at random. Two
 * things fix it and both are here — the pixel footprint fades the fine detail
 * out as it outgrows the features, and `stroke` floors every line's width at
 * that footprint while scaling its brightness back by however far it had to
 * open. A rib seen edge-on gets thicker and dimmer rather than breaking into
 * sparks.
 */

const MARK_VERTEX = /* glsl */ `
  varying vec2  vUv;
  varying float vViewZ;

  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const MARK_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uGrown;
  uniform float uFront;
  uniform float uFade;
  uniform float uSeed;
  uniform float uPulse;
  uniform float uFlare;
  uniform float uOpacity;
  uniform float uGlow;

  uniform float uLineWidth;
  uniform float uLineGlow;

  uniform float uStarPoints;
  uniform float uStarOuter;
  uniform float uStarSharp;
  uniform float uStarSpin;
  uniform float uStarInnerScale;
  uniform float uStarInnerGain;

  uniform float uDiamond;
  uniform float uDiamondSeat;
  uniform float uDiamondAspect;
  uniform float uDiamondSpin;

  uniform float uSpear;
  uniform float uSpearFrom;
  uniform float uSpearTo;
  uniform float uSpearWidth;

  uniform float uHooks;
  uniform float uHookCount;
  uniform float uHookSeat;
  uniform float uHookSweep;
  uniform float uHookWidth;
  uniform float uHookSpin;

  uniform float uRibs;
  uniform float uRibCount;
  uniform float uRibLength;
  uniform float uRibWidth;

  uniform float uTicks;
  uniform float uTickCount;
  uniform float uTickSeat;
  uniform float uTickLength;

  uniform float uHub;
  uniform float uHubRing;
  uniform float uHubDot;

  uniform float uWash;
  uniform float uWashFalloff;
  uniform float uGrain;
  uniform float uGrainScale;

  uniform vec3  uColorLine;
  uniform vec3  uColorCore;
  uniform vec3  uColorDeep;
  uniform vec3  uColorWash;
  uniform vec3  uColorFront;

  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  #define MTAU 6.283185307179586
  #define MPI  3.141592653589793

  /**
   * A line of live width, antialiased and energy conserving.
   *
   * The width is floored at the pixel footprint and the brightness scaled back
   * by however far it had to open — so a rib the camera is looking along gets
   * wider and dimmer instead of breaking into a dotted line. This is the single
   * most important function in the file.
   */
  float stroke(float d, float w, float aa) {
    float ww = max(w, aa);
    return (1.0 - smoothstep(0.0, ww, abs(d))) * (w / ww);
  }

  /** The inside of a field, antialiased. */
  float solid(float d, float aa) {
    return 1.0 - smoothstep(-aa, aa, d);
  }

  /**
   * Distance to a segment whose half-width runs from wa at a to wb at b.
   *
   * Most of the mark is this: with wb at zero it is a spearhead, with both ends
   * equal it is a rib, and at a tenth of the size it is a tick.
   */
  float taper(vec2 p, vec2 a, vec2 b, float wa, float wb) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h) - mix(wa, wb, h);
  }

  /**
   * Distance to a circular arc of radius ra swept from -half to +half about
   * the +x axis, with the stroke tapering along its own sweep.
   *
   * The curls in the middle of the reference mark are barbed: thick where they
   * leave the hub and closing to a point where they end. A constant-width arc
   * reads as a washer.
   */
  float hook(vec2 p, float ra, float sweep, float wa, float wb) {
    float ang = atan(p.y, p.x);
    float k = clamp(ang / max(sweep, 1e-4), -1.0, 1.0);
    if (abs(ang) <= sweep) {
      float w = mix(wa, wb, (k * 0.5 + 0.5));
      return abs(length(p) - ra) - w;
    }
    // Past either end, the distance to the cap that closes it.
    float e = sign(ang) * sweep;
    vec2 tip = vec2(cos(e), sin(e)) * ra;
    return length(p - tip) - (sign(ang) > 0.0 ? wb : wa);
  }

  /**
   * Exact SDF of an n-pointed star (after iq).
   *
   * The sharp argument runs from 2 to the point count, and it is the wrong way
   * round from what the name suggests: **2 is the regular polygon** and the
   * point count is the sharpest star. At 4 points, values around 3.2 give the
   * long concave barbs the reference sheet is built on; 2 gives a square, which
   * is what a mis-set value looks like.
   */
  float starSDF(vec2 p, float radius, float points, float sharp) {
    float n = max(points, 2.0);
    float m = clamp(sharp, 2.0, n);
    float an = MPI / n;
    float en = MPI / m;
    vec2 acs = vec2(cos(an), sin(an));
    vec2 ecs = vec2(cos(en), sin(en));

    float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
    vec2 q = length(p) * vec2(cos(bn), abs(sin(bn)));
    q -= radius * acs;
    q += ecs * clamp(-dot(q, ecs), 0.0, radius * acs.y / ecs.y);
    return length(q) * sign(q.x);
  }

  float ndot(vec2 a, vec2 b) { return a.x * b.x - a.y * b.y; }

  /** Exact SDF of a rhombus with half-diagonals b (after iq). */
  float rhombusSDF(vec2 p, vec2 b) {
    vec2 q = abs(p);
    float h = clamp(ndot(b - 2.0 * q, b) / max(dot(b, b), 1e-6), -1.0, 1.0);
    float d = length(q - 0.5 * b * vec2(1.0 - h, 1.0 + h));
    return d * sign(q.x * b.y + q.y * b.x - b.x * b.y);
  }

  void main() {
    // Metres from the centre. Everything below is in metres.
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float r = length(p);

    float aa = fwidth(r) + 1e-4;
    // How much floor one pixel covers. Fine detail is faded out as it outgrows
    // its own features, which is what a mip chain does for a texture.
    float footprint = max(fwidth(p.x), fwidth(p.y));
    float detail = 1.0 - smoothstep(0.02, 0.15, footprint);

    float reach = uRadius * uStarOuter;
    if (r > reach + 0.6) discard;

    // The mark is cut *outward*, so nothing exists past the front.
    float open = 1.0 - smoothstep(uGrown - 0.28, uGrown + 0.1, r);
    if (open < 0.002) discard;

    float beat = 1.0 + uPulse + uFlare * 1.6;
    float width = uLineWidth * (1.0 + uFlare * 0.35);

    float lines = 0.0;
    float cores = 0.0;

    /* ---- the star, and the smaller one inside it ---- */
    float spin = uTime * uStarSpin * MTAU;
    vec2 ps = rot2(spin) * p;
    float star = starSDF(ps, uRadius * uStarOuter, uStarPoints, uStarSharp);
    lines += stroke(star, width, aa) * uLineGlow;

    vec2 pi = rot2(-spin * 1.7 + MPI / max(uStarPoints, 2.0)) * p;
    float inner = starSDF(pi, uRadius * uStarOuter * uStarInnerScale, uStarPoints, uStarSharp + 0.5);
    lines += stroke(inner, width * 0.8, aa) * uLineGlow * uStarInnerGain;

    /* ---- the diamond that frames them ---- */
    vec2 pd = rot2(uTime * uDiamondSpin * MTAU + MPI * 0.25) * p;
    float seat = uRadius * uDiamondSeat;
    float diamond = rhombusSDF(pd, vec2(seat, seat * uDiamondAspect));
    lines += stroke(diamond, width * 1.25, aa) * uLineGlow * uDiamond;

    /* ---- the ribs combed down each edge of it ---- */
    if (uRibs > 0.001 && detail > 0.01) {
      // Walked around the rhombus in its own frame: each rib is a short taper
      // struck inward from a point on the edge, so they fan with the shape
      // instead of radiating from the middle.
      float ribs = max(floor(uRibCount), 1.0);
      vec2 q = abs(pd);
      float edge = q.x / max(seat, 1e-4) + q.y / max(seat * uDiamondAspect, 1e-4);
      float along = q.x / max(seat, 1e-4);
      float cell = fract(along * ribs);
      float bar = 1.0 - smoothstep(uRibWidth * 0.5, uRibWidth, abs(cell - 0.5) * 2.0);
      float band = 1.0 - smoothstep(0.0, uRibLength, abs(edge - 1.0));
      lines += bar * band * uRibs * detail;
    }

    /* ---- the spearheads on the star's points ---- */
    if (uSpear > 0.001) {
      float points = max(floor(uStarPoints), 2.0);
      float sector = MTAU / points;
      // Folded the way starSDF folds — atan(x, y), so the first point is on +Y.
      // Measured from +X instead and the barbs come out on the star's *waists*,
      // which reads as a compass rose rather than as a barbed mark.
      float ang = atan(ps.x, ps.y);
      float local = mod(ang + sector * 0.5, sector) - sector * 0.5;
      vec2 pf = vec2(sin(local), cos(local)) * length(ps);
      float d = taper(
        pf,
        vec2(0.0, uRadius * uSpearFrom),
        vec2(0.0, uRadius * uSpearTo),
        uRadius * uSpearWidth,
        0.0
      );
      // Ramped along its own length rather than filled flat: a solid wedge on
      // the floor reads as a paper cutout, and the gradient is what makes it a
      // barb driven outward.
      float along = clamp((length(ps) / max(uRadius, 0.05) - uSpearFrom) /
                          max(uSpearTo - uSpearFrom, 1e-3), 0.0, 1.0);
      float head = solid(d, aa) * mix(0.35, 1.0, along);
      lines += head * uSpear;
      cores += head * uSpear * along * 0.35;
    }

    /* ---- the knot of hooks in the middle ---- */
    if (uHooks > 0.001) {
      float count = max(floor(uHookCount), 1.0);
      float sector = MTAU / count;
      float turn = uTime * uHookSpin * MTAU;
      float ang = atan(p.y, p.x) - turn;
      float local = mod(ang + sector * 0.5, sector) - sector * 0.5;
      vec2 ph = vec2(cos(local), sin(local)) * r;
      float d = hook(
        ph,
        uRadius * uHookSeat,
        uHookSweep,
        uRadius * uHookWidth,
        uRadius * uHookWidth * 0.06
      );
      float curl = solid(d, aa);
      lines += curl * uHooks;
      cores += curl * uHooks * 0.28;
    }

    /* ---- ticks around the rim ---- */
    if (uTicks > 0.001 && detail > 0.01) {
      float count = max(floor(uTickCount), 1.0);
      float sector = MTAU / count;
      float ang = atan(p.x, p.y) + uTime * uStarSpin * MTAU * 0.5;
      float local = mod(ang + sector * 0.5, sector) - sector * 0.5;
      vec2 pt = vec2(cos(local), sin(local)) * r;
      float d = taper(
        pt,
        vec2(uRadius * uTickSeat, 0.0),
        vec2(uRadius * (uTickSeat + uTickLength), 0.0),
        width * 1.1,
        0.0
      );
      lines += solid(d, aa) * uTicks * detail;
    }

    /* ---- the hub ---- */
    float hub = stroke(r - uRadius * uHubRing, width * 1.1, aa) * uLineGlow;
    hub += solid(r - uRadius * uHubDot, aa) * 1.4;
    lines += hub * uHub;
    cores += solid(r - uRadius * uHubDot, aa) * uHub;

    /* ---- the wash inside it all ---- */
    // Bounded by the star rather than by a circle, so the fill has the mark's
    // own shape and the barbs read as solid rather than as outlines with a disc
    // behind them.
    float body = solid(star, aa * 2.0);
    float wash = body * pow(clamp(1.0 - r / max(reach, 0.05), 0.0, 1.0), max(uWashFalloff, 0.05));
    float grain = (snoise01(vec3(p * uGrainScale, uSeed * 3.0 + uTime * 0.12)) - 0.5) * uGrain;
    wash *= 1.0 + grain * detail;
    wash *= uWash;

    /* ---- the front racing out to the boundary ---- */
    float front = (1.0 - smoothstep(0.0, 0.4, abs(r - uGrown))) * uFront;

    /* ---- put it together ---- */
    vec3 color = mix(uColorLine, uColorCore, clamp(lines * 0.16 + cores * 0.5, 0.0, 1.0)) * lines * beat;
    color += uColorDeep * body * clamp(1.0 - lines, 0.0, 1.0) * uWash * 0.35;
    color += uColorWash * wash * beat;
    color += uColorFront * front * 2.4;

    float alpha = clamp(lines * 0.9 + wash + front, 0.0, 1.0);
    alpha *= open * uFade * uOpacity;
    if (alpha < 0.004) discard;

    color *= uGlow * uGlobalGlow;
    // The soft ceiling every additive pass in this project ends on: the terms
    // above are independent and stack, and a spearhead sitting on the diamond
    // sitting in the wash sums past ten without it.
    color /= 1.0 + color * 0.16;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The mark.
 *
 * An ability-owned mesh rather than a pooled decal, because a decal captures
 * its radius when it spawns and this one has to re-scale under `zoneRadius`
 * while the mark is already standing.
 */
export function createCascadeMarkMaterial() {
  const material = new ShaderMaterial({
    name: 'CascadeMark',
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
      uFront: { value: 0 },
      uFade: { value: 1 },
      uSeed: { value: 0 },
      uPulse: { value: 0 },
      uFlare: { value: 0 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },

      uLineWidth: { value: 0.034 },
      uLineGlow: { value: 1.7 },

      uStarPoints: { value: 4 },
      uStarOuter: { value: 1 },
      uStarSharp: { value: 2.25 },
      uStarSpin: { value: 0.011 },
      uStarInnerScale: { value: 0.62 },
      uStarInnerGain: { value: 0.75 },

      uDiamond: { value: 1 },
      uDiamondSeat: { value: 0.8 },
      uDiamondAspect: { value: 1 },
      uDiamondSpin: { value: -0.008 },

      uSpear: { value: 1 },
      uSpearFrom: { value: 0.5 },
      uSpearTo: { value: 1.05 },
      uSpearWidth: { value: 0.075 },

      uHooks: { value: 1 },
      uHookCount: { value: 4 },
      uHookSeat: { value: 0.3 },
      uHookSweep: { value: 1.25 },
      uHookWidth: { value: 0.05 },
      uHookSpin: { value: 0.02 },

      uRibs: { value: 0.55 },
      uRibCount: { value: 9 },
      uRibLength: { value: 0.16 },
      uRibWidth: { value: 0.22 },

      uTicks: { value: 0.6 },
      uTickCount: { value: 32 },
      uTickSeat: { value: 0.86 },
      uTickLength: { value: 0.07 },

      uHub: { value: 1 },
      uHubRing: { value: 0.15 },
      uHubDot: { value: 0.05 },

      uWash: { value: 0.3 },
      uWashFalloff: { value: 1.6 },
      uGrain: { value: 0.45 },
      uGrainScale: { value: 2.4 },

      uColorLine: { value: new Color() },
      uColorCore: { value: new Color() },
      uColorDeep: { value: new Color() },
      uColorWash: { value: new Color() },
      uColorFront: { value: new Color() }
    }),
    vertexShader: MARK_VERTEX,
    fragmentShader: MARK_FRAGMENT
  });

  /** @param {object} state { radius, quadSize, grown, front, pulse, flare, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.cascade;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uGrown.value = state.grown;
    u.uFront.value = state.front;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uFlare.value = state.flare;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uLineWidth.value = c.markLineWidth;
    u.uLineGlow.value = c.markLineGlow * g.shaderIntensity;

    u.uStarPoints.value = Math.max(2, Math.round(c.markPoints));
    u.uStarOuter.value = c.markStarOuter;
    u.uStarSharp.value = c.markStarSharp;
    u.uStarSpin.value = c.markStarSpin;
    u.uStarInnerScale.value = c.markInnerScale;
    u.uStarInnerGain.value = c.markInnerGain;

    u.uDiamond.value = c.markDiamond * g.shaderIntensity;
    u.uDiamondSeat.value = c.markDiamondSeat;
    u.uDiamondAspect.value = c.markDiamondAspect;
    u.uDiamondSpin.value = c.markDiamondSpin;

    u.uSpear.value = c.markSpear * g.shaderIntensity;
    u.uSpearFrom.value = c.markSpearFrom;
    u.uSpearTo.value = c.markSpearTo;
    u.uSpearWidth.value = c.markSpearWidth;

    u.uHooks.value = c.markHooks * g.shaderIntensity;
    u.uHookCount.value = Math.max(1, Math.round(c.markHookCount));
    u.uHookSeat.value = c.markHookSeat;
    u.uHookSweep.value = c.markHookSweep;
    u.uHookWidth.value = c.markHookWidth;
    u.uHookSpin.value = c.markHookSpin;

    u.uRibs.value = c.markRibs * g.shaderIntensity;
    u.uRibCount.value = Math.max(1, Math.round(c.markRibCount));
    u.uRibLength.value = c.markRibLength;
    u.uRibWidth.value = c.markRibWidth;

    u.uTicks.value = c.markTicks * g.shaderIntensity;
    u.uTickCount.value = Math.max(1, Math.round(c.markTickCount));
    u.uTickSeat.value = c.markTickSeat;
    u.uTickLength.value = c.markTickLength;

    u.uHub.value = c.markHub * g.shaderIntensity;
    u.uHubRing.value = c.markHubRing;
    u.uHubDot.value = c.markHubDot;

    u.uWash.value = c.markWash;
    u.uWashFalloff.value = c.markWashFalloff;
    u.uGrain.value = c.markGrain * g.noiseStrength;
    u.uGrainScale.value = c.markGrainScale * g.noiseFrequency;
    u.uOpacity.value = c.markOpacity * g.opacity;
    u.uGlow.value = c.markGlow * g.glow;

    u.uColorLine.value.copy(getColor(c.colorMarkLine));
    u.uColorCore.value.copy(getColor(c.colorMarkCore));
    u.uColorDeep.value.copy(getColor(c.colorMarkDeep));
    u.uColorWash.value.copy(getColor(c.colorMarkWash));
    u.uColorFront.value.copy(getColor(c.colorFront));
  };

  return material;
}
