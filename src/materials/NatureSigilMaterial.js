import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The nature sigil — layer 1, the mark the summon is drawn out of.
 *
 * One quad on the floor, everything in it a signed distance field, and every
 * dimension in **metres from the centre of the circle** rather than in quad
 * space. That is the decision the whole file hangs off: drag `footprint radius`
 * while a summon is standing and the sigil re-scales around it with its strokes
 * the same physical width, the runes the same physical height and the same
 * number of them per metre of arc. In quad space every line would stretch with
 * the circle and the mark would read as a texture being zoomed.
 *
 * ## What is actually drawn
 *
 * Outward from the middle: a hub, an inscribed triangle and its inverse (the
 * two together are the star the reference sheet has under the bloom), a
 * filigree of vine arcs that wander instead of running true, an inner rail, a
 * band of **generated** runes, and the outer rail with its ticks. Nothing here
 * is a texture and nothing is a repeat: every rune cell hashes its own subset
 * out of a nine-stroke alphabet, so moving `runes` re-cuts all of them and the
 * ring carries genuinely non-repeating script.
 *
 * ## Aliasing, which is most of the work
 *
 * A ground shader full of thin bright rings is the single easiest way to put a
 * bolt of white speckle across the far half of the floor: at a grazing angle one
 * pixel covers tens of centimetres, so every neighbouring pixel samples an
 * unrelated part of the field and every hard edge resolves to full brightness at
 * random. Two things fix it and both are here:
 *
 *  - **the pixel footprint fades the fine detail out** as it outgrows the
 *    features — the runes, the ticks and the grain — exactly as a mip chain
 *    would for a texture;
 *  - **every band's width is floored at the footprint** and its brightness
 *    scaled by how far it had to be widened, so a rail seen edge-on gets
 *    thicker and dimmer rather than dissolving into a dotted line.
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
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uPulse;

  uniform float uRailWidth;
  uniform float uRailOuter;
  uniform float uRailInner;
  uniform float uRailHub;
  uniform float uRailGlow;

  uniform float uRunes;
  uniform float uRuneBand;
  uniform float uRuneSeat;
  uniform float uRuneWeight;
  uniform float uRuneStrokes;
  uniform float uRuneSpin;
  uniform float uRuneSweep;
  uniform float uRuneSweepSpeed;
  uniform float uRuneSweepWidth;
  uniform float uRuneFlicker;
  uniform float uRuneGlow;

  uniform float uTicks;
  uniform float uTickCount;
  uniform float uTickWidth;
  uniform float uTickLength;

  uniform float uStar;
  uniform float uStarRadius;
  uniform float uStarWidth;
  uniform float uStarSpin;

  uniform float uFiligree;
  uniform float uFiligreeSeat;
  uniform float uFiligreeAmp;
  uniform float uFiligreeLobes;
  uniform float uFiligreeWidth;
  uniform float uFiligreeSpin;

  uniform float uPool;
  uniform float uPoolFalloff;
  uniform float uGrain;
  uniform float uGrainScale;

  uniform vec3  uColorLine;
  uniform vec3  uColorCore;
  uniform vec3  uColorRune;
  uniform vec3  uColorPool;
  uniform vec3  uColorFront;

  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  #define STAU 6.283185307179586
  #define SPI  3.141592653589793

  /**
   * A band around a circle, antialiased and energy conserving.
   *
   * The width is floored at the pixel footprint and the brightness scaled back
   * by however far it had to open — so a rail the camera is looking along gets
   * wider and dimmer instead of breaking into sparks. This is the single most
   * important function in the file.
   */
  float rail(float r, float radius, float width, float aa) {
    float w = max(width, aa);
    return (1.0 - smoothstep(0.0, w, abs(r - radius))) * (width / w);
  }

  /** Distance to the outline of a regular n-gon of apothem a, in polar. */
  float polygonEdge(float r, float ang, float sides, float apothem, float rot) {
    float sector = STAU / max(sides, 3.0);
    float a = mod(ang - rot + sector * 0.5, sector) - sector * 0.5;
    return abs(r * cos(a) - apothem);
  }

  /** Distance from p to the segment ab. The rune alphabet is built out of it. */
  float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
  }

  /**
   * One generated glyph, in a cell running -0.5..0.5 on both axes.
   *
   * Nine candidate strokes, each kept or dropped on its own hash of the cell's
   * id — so a glyph is a *subset* of an alphabet rather than a symbol looked up
   * from one. Two cells never carry the same mark unless they draw the same
   * subset, which at nine strokes is unlikely enough to never be seen in a ring
   * of forty. Raising uRuneStrokes keeps more of them and the script gets
   * denser; nothing about the ring is re-cut.
   */
  float glyph(vec2 p, float id, float weight) {
    float keep = clamp(uRuneStrokes, 0.0, 1.0);
    float d = 1e3;

    // The spine, and the two rails either side of it.
    if (hash11(id * 1.7 + 0.11) < keep + 0.25) d = min(d, segment(p, vec2(0.0, -0.42), vec2(0.0, 0.42)));
    if (hash11(id * 2.3 + 0.27) < keep) d = min(d, segment(p, vec2(-0.3, -0.34), vec2(-0.3, 0.2)));
    if (hash11(id * 3.1 + 0.43) < keep) d = min(d, segment(p, vec2(0.3, -0.2), vec2(0.3, 0.34)));
    // Cross bars.
    if (hash11(id * 4.7 + 0.59) < keep) d = min(d, segment(p, vec2(-0.32, 0.24), vec2(0.32, 0.24)));
    if (hash11(id * 5.3 + 0.71) < keep) d = min(d, segment(p, vec2(-0.32, -0.24), vec2(0.32, -0.24)));
    // Diagonals — the strokes that make it read as script rather than as a grid.
    if (hash11(id * 6.1 + 0.83) < keep) d = min(d, segment(p, vec2(-0.3, -0.3), vec2(0.0, 0.05)));
    if (hash11(id * 7.9 + 0.97) < keep) d = min(d, segment(p, vec2(0.3, 0.3), vec2(0.0, -0.05)));
    if (hash11(id * 8.3 + 1.13) < keep) d = min(d, segment(p, vec2(-0.28, 0.32), vec2(0.06, -0.02)));
    // And a bowl, so some glyphs are round.
    if (hash11(id * 9.7 + 1.31) < keep * 0.7) d = min(d, abs(length(p - vec2(0.0, -0.12)) - 0.17));

    return 1.0 - smoothstep(weight * 0.5, weight, d);
  }

  void main() {
    // Metres from the centre. Everything below is in metres.
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float r = length(p);
    float ang = atan(p.y, p.x);

    float aa = fwidth(r) + 1e-4;
    // How much floor one pixel covers. Fine detail is faded out as it outgrows
    // its own features, which is what a mip chain does for a texture.
    float footprint = max(fwidth(p.x), fwidth(p.y));
    float detail = 1.0 - smoothstep(0.02, 0.16, footprint);

    float outer = uRadius * uRailOuter;
    if (r > outer + aa * 6.0 + 0.5) discard;

    // The sigil is cut *out* of the floor as the growth races to the boundary,
    // so nothing is visible past the front.
    float open = 1.0 - smoothstep(uGrown - 0.35, uGrown + 0.15, r);
    if (open < 0.002) discard;

    float beat = 1.0 + uPulse;

    /* ---- the rails ---- */
    float spin = uTime * uRuneSpin * STAU;
    float lines = 0.0;
    lines += rail(r, outer, uRailWidth, aa) * uRailGlow;
    lines += rail(r, uRadius * uRailInner, uRailWidth * 1.6, aa) * uRailGlow;
    lines += rail(r, uRadius * uRailHub, uRailWidth * 0.9, aa) * uRailGlow * 0.8;

    /* ---- the ticks around the outer rail ---- */
    float tickPhase = fract((ang + spin * 0.35) / STAU * max(uTickCount, 1.0));
    float tickMask = 1.0 - smoothstep(uTickWidth * 0.5, uTickWidth, abs(tickPhase - 0.5) * 2.0);
    float tickBand = rail(r, outer - uRadius * uTickLength * 0.5, uRadius * uTickLength * 0.5, aa);
    lines += tickMask * tickBand * uTicks * detail;

    /* ---- the star: a triangle and its inverse ---- */
    float apothem = uRadius * uStarRadius * 0.5;
    float rot = uTime * uStarSpin * STAU;
    float triA = polygonEdge(r, ang, 3.0, apothem, rot);
    float triB = polygonEdge(r, ang, 3.0, apothem, rot + SPI / 3.0);
    float star = 1.0 - smoothstep(0.0, max(uStarWidth, aa), min(triA, triB));
    // Clipped to the disc the star is inscribed in, or the polygon's edges run
    // out to infinity along their own lines.
    star *= 1.0 - smoothstep(uRadius * uStarRadius * 0.96, uRadius * uStarRadius * 1.02, r);
    lines += star * uStar;

    /* ---- the vine filigree ---- */
    // A pair of circles that *wander*: the radius breathes with the angle, so
    // the arcs weave instead of running true. Two of them, counter-turning.
    float fa = ang + uTime * uFiligreeSpin * STAU;
    float fb = ang - uTime * uFiligreeSpin * STAU * 0.7;
    float seatA = uRadius * uFiligreeSeat;
    float seatB = uRadius * uFiligreeSeat * 0.78;
    float wobbleA = uFiligreeAmp * uRadius * sin(fa * uFiligreeLobes + uSeed);
    float wobbleB = uFiligreeAmp * uRadius * 0.7 * sin(fb * (uFiligreeLobes + 3.0) + uSeed * 2.3);
    float fil = rail(r, seatA + wobbleA, uFiligreeWidth, aa);
    fil += rail(r, seatB + wobbleB, uFiligreeWidth * 0.8, aa) * 0.8;
    lines += fil * uFiligree;

    /* ---- the rune band ---- */
    float band = uRadius * uRuneSeat;
    float bandHalf = uRuneBand * 0.5;
    float inBand = step(abs(r - band), bandHalf);
    float runes = 0.0;
    if (inBand > 0.5 && detail > 0.01) {
      float cells = max(floor(uRunes), 1.0);
      // The ring turns, and the glyphs turn with it — a band whose script slid
      // through stationary cells would read as a ticker tape.
      float around = fract((ang + spin) / STAU) * cells;
      float id = floor(around) + uSeed * 17.0;
      // Cell space: x across the arc scaled so a glyph is as wide as it is
      // tall, y across the band.
      float cellWidth = STAU * band / cells;
      vec2 q = vec2((fract(around) - 0.5) * cellWidth / max(uRuneBand, 1e-3), (r - band) / uRuneBand);
      runes = glyph(q, id, uRuneWeight);

      // A read head running round the ring, and a per-glyph stutter under it.
      float head = fract((ang + spin) / STAU - uTime * uRuneSweepSpeed);
      head = 1.0 - smoothstep(0.0, max(uRuneSweepWidth, 1e-3), min(head, 1.0 - head));
      float flicker = 1.0 - uRuneFlicker * hash11(floor(id) + floor(uTime * 6.0) * 0.37);
      runes *= flicker * (1.0 + head * uRuneSweep);
      runes *= detail;
    }

    /* ---- the pool of light inside it all ---- */
    float pool = pow(clamp(1.0 - r / max(uRadius, 0.05), 0.0, 1.0), max(uPoolFalloff, 0.05)) * uPool;
    float grain = (snoise01(vec3(p * uGrainScale, uSeed * 3.0 + uTime * 0.15)) - 0.5) * uGrain;
    pool *= 1.0 + grain * detail;

    /* ---- the growth front racing out to the boundary ---- */
    float front = (1.0 - smoothstep(0.0, 0.55, abs(r - uGrown))) * uFront;

    /* ---- put it together ---- */
    vec3 color = mix(uColorLine, uColorCore, clamp(lines * 0.35, 0.0, 1.0)) * lines * beat;
    color += uColorRune * runes * uRuneGlow * beat;
    color += uColorPool * pool * beat;
    color += uColorFront * front * 2.2;

    float alpha = clamp(lines * 0.85 + runes * 0.9 + pool + front, 0.0, 1.0);
    alpha *= open * uFade * uOpacity;
    if (alpha < 0.004) discard;

    color *= uGlow * uGlobalGlow;
    // The soft ceiling every additive pass in this project ends on: the terms
    // above are independent and stack, and a rune sitting on a rail sitting in
    // the pool sums past ten without it.
    color /= 1.0 + color * 0.16;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The sigil.
 *
 * An ability-owned mesh rather than a pooled decal, because a decal captures its
 * radius when it spawns and this one has to re-scale under `zoneRadius` while
 * the summon is already standing.
 */
export function createNatureSigilMaterial() {
  const material = new ShaderMaterial({
    name: 'NatureSigil',
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
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uPulse: { value: 0 },

      uRailWidth: { value: 0.035 },
      uRailOuter: { value: 1.0 },
      uRailInner: { value: 0.84 },
      uRailHub: { value: 0.2 },
      uRailGlow: { value: 1.6 },

      uRunes: { value: 44 },
      uRuneBand: { value: 0.34 },
      uRuneSeat: { value: 0.92 },
      uRuneWeight: { value: 0.055 },
      uRuneStrokes: { value: 0.5 },
      uRuneSpin: { value: 0.012 },
      uRuneSweep: { value: 1.4 },
      uRuneSweepSpeed: { value: 0.14 },
      uRuneSweepWidth: { value: 0.08 },
      uRuneFlicker: { value: 0.25 },
      uRuneGlow: { value: 2.2 },

      uTicks: { value: 0.7 },
      uTickCount: { value: 72 },
      uTickWidth: { value: 0.35 },
      uTickLength: { value: 0.05 },

      uStar: { value: 1.0 },
      uStarRadius: { value: 0.66 },
      uStarWidth: { value: 0.03 },
      uStarSpin: { value: -0.01 },

      uFiligree: { value: 0.9 },
      uFiligreeSeat: { value: 0.5 },
      uFiligreeAmp: { value: 0.07 },
      uFiligreeLobes: { value: 6 },
      uFiligreeWidth: { value: 0.022 },
      uFiligreeSpin: { value: 0.02 },

      uPool: { value: 0.32 },
      uPoolFalloff: { value: 2.2 },
      uGrain: { value: 0.5 },
      uGrainScale: { value: 2.6 },

      uColorLine: { value: new Color() },
      uColorCore: { value: new Color() },
      uColorRune: { value: new Color() },
      uColorPool: { value: new Color() },
      uColorFront: { value: new Color() }
    }),
    vertexShader: SIGIL_VERTEX,
    fragmentShader: SIGIL_FRAGMENT
  });

  /** @param {object} state { radius, quadSize, grown, front, pulse, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.growth;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uGrown.value = state.grown;
    u.uFront.value = state.front;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uRailWidth.value = c.sigilRailWidth;
    u.uRailOuter.value = c.sigilRailOuter;
    u.uRailInner.value = c.sigilRailInner;
    u.uRailHub.value = c.sigilRailHub;
    u.uRailGlow.value = c.sigilRailGlow * g.shaderIntensity;

    u.uRunes.value = Math.max(1, Math.round(c.sigilRunes));
    u.uRuneBand.value = c.sigilRuneBand;
    u.uRuneSeat.value = c.sigilRuneSeat;
    u.uRuneWeight.value = c.sigilRuneWeight;
    u.uRuneStrokes.value = c.sigilRuneStrokes;
    u.uRuneSpin.value = c.sigilSpin;
    u.uRuneSweep.value = c.sigilRuneSweep;
    u.uRuneSweepSpeed.value = c.sigilRuneSweepSpeed;
    u.uRuneSweepWidth.value = c.sigilRuneSweepWidth;
    u.uRuneFlicker.value = c.sigilRuneFlicker * g.randomness;
    u.uRuneGlow.value = c.sigilRuneGlow * g.shaderIntensity;

    u.uTicks.value = c.sigilTicks;
    u.uTickCount.value = Math.max(1, Math.round(c.sigilTickCount));
    u.uTickWidth.value = c.sigilTickWidth;
    u.uTickLength.value = c.sigilTickLength;

    u.uStar.value = c.sigilStar * g.shaderIntensity;
    u.uStarRadius.value = c.sigilStarRadius;
    u.uStarWidth.value = c.sigilStarWidth;
    u.uStarSpin.value = c.sigilStarSpin;

    u.uFiligree.value = c.sigilFiligree * g.shaderIntensity;
    u.uFiligreeSeat.value = c.sigilFiligreeSeat;
    u.uFiligreeAmp.value = c.sigilFiligreeAmp * g.noiseStrength;
    u.uFiligreeLobes.value = c.sigilFiligreeLobes;
    u.uFiligreeWidth.value = c.sigilFiligreeWidth;
    u.uFiligreeSpin.value = c.sigilFiligreeSpin;

    u.uPool.value = c.sigilPool;
    u.uPoolFalloff.value = c.sigilPoolFalloff;
    u.uGrain.value = c.sigilGrain * g.noiseStrength;
    u.uGrainScale.value = c.sigilGrainScale * g.noiseFrequency;
    u.uOpacity.value = c.sigilOpacity * g.opacity;
    u.uGlow.value = c.sigilGlow * g.glow;

    u.uColorLine.value.copy(getColor(c.colorSigil));
    u.uColorCore.value.copy(getColor(c.colorSigilCore));
    u.uColorRune.value.copy(getColor(c.colorRune));
    u.uColorPool.value.copy(getColor(c.colorSigilPool));
    u.uColorFront.value.copy(getColor(c.colorFront));
  };

  return material;
}
