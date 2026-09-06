import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The Celestial Mark — layer 1, and the ground the whole ability stands on.
 *
 * One quad on the floor, everything in it a field, and every dimension in
 * **metres from the centre** rather than in quad space. That is the decision the
 * file hangs off: drag the footprint while a mark is standing and it re-scales
 * around its own middle with the strokes the same physical width and the same
 * number of glyphs. In quad space every line would stretch with the circle and
 * the mark would read as a texture being zoomed.
 *
 * ## What is drawn, and why it is not the Cascade's mark
 *
 * The reference sheet asks for two things from the same shader. Panel one is the
 * **sigil that locks on**: a four-pointed star with long concave points, a thin
 * ring struck through it, and satellite glyphs on the diagonals. Panel four is
 * the **detonation floor**: a nest of concentric golden rings with runic ticks
 * between them and the ground split open under the middle. So the mark is
 * authored as one field with a `uShatter` term that opens the second reading out
 * of the first — the rings brighten and spread, the cracks are cut, and the
 * sigil that was sitting on the floor is what tore it.
 *
 * ## Curved points need a different line function
 *
 * The Cascade's mark is built out of exact SDFs, so a line through one is a
 * `smoothstep` on the distance. This mark cannot be: a four-pointed star with
 * **concave** sides is a polar field, `r − outer·|cos 2θ|^k`, whose gradient is
 * nowhere near unit length — the same numeric value is half a metre from the
 * boundary near the point and five centimetres from it at the waist. Stroke that
 * with a fixed width and the star comes out thick at its tips and hairline at
 * its waists, which is exactly backwards.
 *
 * `lineAA` is the answer and it is the most important function in the file: it
 * measures the field's *own* gradient with `fwidth`, converts to a distance in
 * **pixels**, and floors the stroke at one pixel while scaling the brightness
 * back by however far it had to open. That buys three things at once — a
 * constant apparent width on any field, correct antialiasing, and the
 * grazing-angle behaviour a ground shader lives or dies by: a ring seen almost
 * edge-on gets wider and dimmer instead of breaking into a bolt of white
 * speckle across the far half of the floor.
 */

const SIGIL_VERTEX = /* glsl */ `
  varying vec2  vUv;
  varying float vViewZ;

  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SIGIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uGrown;
  uniform float uFront;
  uniform float uFade;
  uniform float uSeed;
  uniform float uPulse;
  uniform float uFlare;
  uniform float uShatter;
  uniform float uOpacity;
  uniform float uGlow;

  uniform float uLineWidth;
  uniform float uLineGlow;

  uniform float uStar;
  uniform float uStarPoints;
  uniform float uStarOuter;
  uniform float uStarSharp;
  uniform float uStarSpin;
  uniform float uStarFill;
  uniform float uStarInner;
  uniform float uStarInnerScale;

  uniform float uRings;
  uniform float uRingCount;
  uniform float uRingInner;
  uniform float uRingSpread;
  uniform float uRingWobble;
  uniform float uRingWobbleLobes;

  uniform float uGlyphs;
  uniform float uGlyphCount;
  uniform float uGlyphSeat;
  uniform float uGlyphSize;
  uniform float uGlyphSpin;

  uniform float uTicks;
  uniform float uTickCount;
  uniform float uTickSeat;
  uniform float uTickLength;
  uniform float uTickSpin;

  uniform float uCracks;
  uniform float uCrackCount;
  uniform float uCrackSeat;
  uniform float uCrackWander;
  uniform float uCrackWidth;

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

  #define STAU 6.283185307179586
  #define SPI  3.141592653589793

  /**
   * Any field, stroked as a line of constant apparent width.
   *
   * The field does not have to be a distance — it only has to cross zero on the
   * boundary. Its gradient is measured with fwidth, which converts the value
   * into a distance in pixels, so a polar star and an exact circle come out with
   * the same weight of line. The width is floored at one pixel and the
   * brightness scaled back by however far it had to open, which is what keeps a
   * ring seen edge-on from resolving into speckle.
   *
   * @param f      the field, zero on the line
   * @param metres how thick the line should be, in world metres
   * @param mpp    metres one pixel covers on the floor here
   */
  float lineAA(float f, float metres, float mpp) {
    float g = max(fwidth(f), 1e-7);
    float px = abs(f) / g;
    float want = metres / max(mpp, 1e-7);
    float w = max(want, 1.0);
    return (1.0 - smoothstep(0.0, w, px)) * (want / w);
  }

  /** The inside of any field, antialiased against its own gradient. */
  float solidAA(float f) {
    float g = max(fwidth(f), 1e-7);
    return 1.0 - smoothstep(-g, g, f);
  }

  /**
   * The four-pointed star, as a polar field.
   *
   * The boundary radius is the outer reach scaled by a raised cosine, so the
   * sides between two points are **concave** — which is the whole difference
   * between the reference sheet's sigil and a compass rose. Sharpness above 1
   * draws the points out into needles; at 1 it is a rounded clover, and at 0 it
   * is a circle.
   */
  float sparkleField(vec2 p, float outer, float points, float sharp) {
    float a = atan(p.y, p.x);
    float lobe = pow(abs(cos(a * points * 0.5)), max(sharp, 0.05));
    return length(p) - outer * lobe;
  }

  /** Distance to a segment whose half-width runs from wa at a to wb at b. */
  float taper(vec2 p, vec2 a, vec2 b, float wa, float wb) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h) - mix(wa, wb, h);
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
    float ang = atan(p.y, p.x);

    // How much floor one pixel covers. Fine detail is faded out as it outgrows
    // its own features, which is what a mip chain does for a texture.
    float mpp = max(fwidth(p.x), fwidth(p.y)) + 1e-6;
    float detail = 1.0 - smoothstep(0.02, 0.16, mpp);

    // Everything the sigil can reach: the star's points, the outermost ring of
    // the nest, and the cracks once the rend has opened them. The margin is
    // generous on purpose — a discard that clips a ring leaves a hard circular
    // cut across the floor that reads as a rendering fault, not as a mark.
    float reach = uRadius * max(max(uStarOuter, uRingInner + uRingSpread),
                                uCrackSeat * step(0.002, uShatter)) + 1.2;
    if (r > reach) discard;

    // The sigil is cut *outward* from the middle, so nothing exists past the
    // front while it is still writing itself on.
    float open = 1.0 - smoothstep(uGrown - 0.3, uGrown + 0.12, r);
    if (open < 0.002) discard;

    float beat = 1.0 + uPulse + uFlare * 1.7;
    float width = uLineWidth * (1.0 + uFlare * 0.4 + uShatter * 0.5);

    float lines = 0.0;
    float cores = 0.0;

    /* ---- the four-pointed star ---- */
    float spin = uTime * uStarSpin * STAU;
    vec2 ps = rot2(spin) * p;
    float star = sparkleField(ps, uRadius * uStarOuter, uStarPoints, uStarSharp);
    float starLine = lineAA(star, width * 1.15, mpp);
    lines += starLine * uLineGlow * uStar;

    // A second star inside it, turned the other way and half the size. It is
    // what stops the middle of the sigil being empty at the moment the pillar
    // is not yet standing in it.
    vec2 pi = rot2(-spin * 1.6 + SPI / max(uStarPoints, 1.0)) * p;
    float inner = sparkleField(pi, uRadius * uStarOuter * uStarInnerScale, uStarPoints, uStarSharp * 1.2);
    lines += lineAA(inner, width * 0.85, mpp) * uLineGlow * uStarInner;

    // The wash the star holds. Bounded by the star itself rather than by a
    // circle, so the fill has the sigil's own shape and the points read as
    // solid rather than as outlines with a disc behind them.
    float body = solidAA(star);
    cores += body * uStarFill * pow(clamp(1.0 - r / max(uRadius * uStarOuter, 0.05), 0.0, 1.0), 1.4);

    /* ---- the nest of concentric rings ---- */
    // Panel four is these, and the reason they are dealt in a loop rather than
    // struck as a fixed few is that the detonation *spreads* them: uShatter
    // pushes the outer ones outward and thickens them, so the same field reads
    // as a lock-on sigil before the rend and as a blast floor after it.
    if (uRings > 0.001) {
      float count = max(floor(uRingCount), 1.0);
      float wobble = uRingWobble * uRadius * sin(ang * max(floor(uRingWobbleLobes), 1.0) + uTime * 0.6 + uSeed);
      for (float i = 0.0; i < 8.0; i += 1.0) {
        if (i >= count) break;
        float k = count <= 1.0 ? 0.0 : i / (count - 1.0);
        // Squared spacing: the rings crowd toward the middle, which is what
        // makes the nest read as something radiating rather than as a target.
        float seat = uRadius * (uRingInner + uRingSpread * k * k) * (1.0 + uShatter * 0.12 * k);
        float thin = width * mix(1.5, 0.6, k) * (1.0 + uShatter * 0.6);
        float ringLine = lineAA(r - seat + wobble, thin, mpp);
        // The innermost ring is the brightest, and every one outside it is
        // paid for out of the same budget.
        lines += ringLine * uLineGlow * uRings * mix(1.0, 0.42, k);
        cores += ringLine * uRings * mix(0.5, 0.1, k);
      }
    }

    /* ---- the glyphs seated on the diagonals ---- */
    if (uGlyphs > 0.001 && detail > 0.01) {
      float count = max(floor(uGlyphCount), 1.0);
      float sector = STAU / count;
      float turn = uTime * uGlyphSpin * STAU + SPI / count;
      float local = mod(ang - turn + sector * 0.5, sector) - sector * 0.5;
      // Folded into one sector and pushed back out along +X, so a single
      // rhombus is drawn count times without a loop.
      vec2 pg = vec2(cos(local), sin(local)) * r - vec2(uRadius * uGlyphSeat, 0.0);
      float size = uRadius * uGlyphSize;
      float glyph = rhombusSDF(pg, vec2(size, size * 0.42));
      float shell = lineAA(glyph, width, mpp);
      float fill = solidAA(glyph + size * 0.42);
      lines += shell * uLineGlow * uGlyphs * detail;
      cores += fill * uGlyphs * 0.9 * detail;
    }

    /* ---- runic ticks around the rim ---- */
    if (uTicks > 0.001 && detail > 0.01) {
      float count = max(floor(uTickCount), 1.0);
      float sector = STAU / count;
      float turn = uTime * uTickSpin * STAU;
      float local = mod(ang - turn + sector * 0.5, sector) - sector * 0.5;
      vec2 pt = vec2(cos(local), sin(local)) * r;
      // Alternating lengths, so the band reads as writing rather than as a
      // comb. The long ones land every fourth tick.
      float which = floor(mod((ang - turn) / sector + 0.5, 4.0));
      float len = uTickLength * (which < 0.5 ? 1.0 : 0.45);
      float d = taper(
        pt,
        vec2(uRadius * uTickSeat, 0.0),
        vec2(uRadius * (uTickSeat + len), 0.0),
        width * 1.2,
        width * 0.35
      );
      lines += solidAA(d) * uTicks * detail;
    }

    /* ---- the ground splitting under it ---- */
    // Only after the rend. Cut as radial tapers whose bearing wanders with
    // angle, so they fork off the middle instead of radiating like a wheel.
    if (uCracks > 0.001 && uShatter > 0.002) {
      float count = max(floor(uCrackCount), 1.0);
      float sector = STAU / count;
      float wander = snoise(vec3(cos(ang) * 1.4, sin(ang) * 1.4, uSeed)) * uCrackWander;
      float local = mod(ang + wander + sector * 0.5, sector) - sector * 0.5;
      // Distance from this crack's centreline, widening outward so the split
      // is a wedge rather than a hairline.
      float across = abs(sin(local)) * r;
      float seat = uRadius * uCrackSeat;
      float along = smoothstep(0.0, 0.25, r / max(seat, 0.05)) *
                    (1.0 - smoothstep(0.55, 1.0, r / max(seat, 0.05)));
      float open2 = uCrackWidth * uRadius * (0.25 + 0.75 * along);
      float split = (1.0 - smoothstep(open2 * 0.35, open2, across)) * along;
      // Eaten by noise so no two arms are the same length.
      split *= 0.55 + 0.45 * snoise01(vec3(p * 1.1, uSeed * 3.0));
      lines += split * uCracks * uShatter;
      cores += split * uCracks * uShatter * 0.5;
    }

    /* ---- the wash inside it all ---- */
    float wash = pow(clamp(1.0 - r / max(uRadius * 1.05, 0.05), 0.0, 1.0), max(uWashFalloff, 0.05));
    float grain = (snoise01(vec3(p * uGrainScale, uSeed * 3.0 + uTime * 0.14)) - 0.5) * uGrain;
    wash *= 1.0 + grain * detail;
    wash *= uWash * (1.0 + uShatter * 1.6);

    /* ---- the front racing out to the boundary ---- */
    float front = (1.0 - smoothstep(0.0, 0.45, abs(r - uGrown))) * uFront;

    /* ---- put it together ---- */
    vec3 color = mix(uColorLine, uColorCore, clamp(lines * 0.14 + cores * 0.6, 0.0, 1.0)) * lines * beat;
    color += uColorCore * cores * beat * 1.35;
    color += uColorDeep * body * clamp(1.0 - lines, 0.0, 1.0) * uWash * 0.4;
    color += uColorWash * wash * beat;
    color += uColorFront * front * 2.6;

    float alpha = clamp(lines * 0.9 + cores * 0.8 + wash + front, 0.0, 1.0);
    alpha *= open * uFade * uOpacity;
    if (alpha < 0.004) discard;

    color *= uGlow * uGlobalGlow;
    // The soft ceiling every additive pass in this project ends on: the terms
    // above are independent and stack, and a glyph sitting on a ring sitting in
    // the wash sums past ten without it.
    color /= 1.0 + color * 0.15;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The Celestial Mark.
 *
 * An ability-owned mesh rather than a pooled decal, because a decal captures its
 * radius when it spawns and this one has to re-scale under `zoneRadius` while
 * the mark is already standing.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`
 */
export function createRendSigilMaterial() {
  const material = new ShaderMaterial({
    name: 'RendSigil',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 14 },
      uRadius: { value: 5 },
      uGrown: { value: 0 },
      uFront: { value: 0 },
      uFade: { value: 1 },
      uSeed: { value: 0 },
      uPulse: { value: 0 },
      uFlare: { value: 0 },
      uShatter: { value: 0 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },

      uLineWidth: { value: 0.03 },
      uLineGlow: { value: 1.8 },

      uStar: { value: 1 },
      uStarPoints: { value: 4 },
      uStarOuter: { value: 0.98 },
      uStarSharp: { value: 2.6 },
      uStarSpin: { value: 0.01 },
      uStarFill: { value: 0.22 },
      uStarInner: { value: 0.7 },
      uStarInnerScale: { value: 0.44 },

      uRings: { value: 1 },
      uRingCount: { value: 5 },
      uRingInner: { value: 0.26 },
      uRingSpread: { value: 0.92 },
      uRingWobble: { value: 0.012 },
      uRingWobbleLobes: { value: 7 },

      uGlyphs: { value: 1 },
      uGlyphCount: { value: 4 },
      uGlyphSeat: { value: 0.66 },
      uGlyphSize: { value: 0.1 },
      uGlyphSpin: { value: -0.014 },

      uTicks: { value: 0.75 },
      uTickCount: { value: 48 },
      uTickSeat: { value: 1.02 },
      uTickLength: { value: 0.09 },
      uTickSpin: { value: 0.006 },

      uCracks: { value: 1 },
      uCrackCount: { value: 9 },
      uCrackSeat: { value: 1.5 },
      uCrackWander: { value: 0.35 },
      uCrackWidth: { value: 0.07 },

      uWash: { value: 0.26 },
      uWashFalloff: { value: 1.7 },
      uGrain: { value: 0.4 },
      uGrainScale: { value: 2.2 },

      uColorLine: { value: new Color() },
      uColorCore: { value: new Color() },
      uColorDeep: { value: new Color() },
      uColorWash: { value: new Color() },
      uColorFront: { value: new Color() }
    }),
    vertexShader: SIGIL_VERTEX,
    fragmentShader: SIGIL_FRAGMENT
  });

  /** @param {object} state { radius, quadSize, grown, front, pulse, flare, shatter, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.rend;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uGrown.value = state.grown;
    u.uFront.value = state.front;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uFlare.value = state.flare;
    u.uShatter.value = state.shatter;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uLineWidth.value = c.sigilLineWidth;
    u.uLineGlow.value = c.sigilLineGlow * g.shaderIntensity;

    u.uStar.value = c.sigilStar * g.shaderIntensity;
    u.uStarPoints.value = Math.max(1, Math.round(c.sigilStarPoints));
    u.uStarOuter.value = c.sigilStarOuter;
    u.uStarSharp.value = c.sigilStarSharp;
    u.uStarSpin.value = c.sigilStarSpin;
    u.uStarFill.value = c.sigilStarFill;
    u.uStarInner.value = c.sigilStarInner;
    u.uStarInnerScale.value = c.sigilStarInnerScale;

    u.uRings.value = c.sigilRings * g.shaderIntensity;
    u.uRingCount.value = Math.max(1, Math.round(c.sigilRingCount));
    u.uRingInner.value = c.sigilRingInner;
    u.uRingSpread.value = c.sigilRingSpread;
    u.uRingWobble.value = c.sigilRingWobble * g.noiseStrength;
    u.uRingWobbleLobes.value = Math.max(1, Math.round(c.sigilRingWobbleLobes));

    u.uGlyphs.value = c.sigilGlyphs * g.shaderIntensity;
    u.uGlyphCount.value = Math.max(1, Math.round(c.sigilGlyphCount));
    u.uGlyphSeat.value = c.sigilGlyphSeat;
    u.uGlyphSize.value = c.sigilGlyphSize;
    u.uGlyphSpin.value = c.sigilGlyphSpin;

    u.uTicks.value = c.sigilTicks * g.shaderIntensity;
    u.uTickCount.value = Math.max(1, Math.round(c.sigilTickCount));
    u.uTickSeat.value = c.sigilTickSeat;
    u.uTickLength.value = c.sigilTickLength;
    u.uTickSpin.value = c.sigilTickSpin;

    u.uCracks.value = c.sigilCracks * g.shaderIntensity;
    u.uCrackCount.value = Math.max(1, Math.round(c.sigilCrackCount));
    u.uCrackSeat.value = c.sigilCrackSeat;
    u.uCrackWander.value = c.sigilCrackWander * g.noiseStrength;
    u.uCrackWidth.value = c.sigilCrackWidth;

    u.uWash.value = c.sigilWash;
    u.uWashFalloff.value = c.sigilWashFalloff;
    u.uGrain.value = c.sigilGrain * g.noiseStrength;
    u.uGrainScale.value = c.sigilGrainScale * g.noiseFrequency;
    u.uOpacity.value = c.sigilOpacity * g.opacity;
    u.uGlow.value = c.sigilGlow * g.glow;

    u.uColorLine.value.copy(getColor(c.colorSigilLine));
    u.uColorCore.value.copy(getColor(c.colorSigilCore));
    u.uColorDeep.value.copy(getColor(c.colorSigilDeep));
    u.uColorWash.value.copy(getColor(c.colorSigilWash));
    u.uColorFront.value.copy(getColor(c.colorFront));
  };

  return material;
}
