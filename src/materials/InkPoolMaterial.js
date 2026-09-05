import { ShaderMaterial, NormalBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The floor under the Sumi Tide: paper, ink, and water standing in it.
 *
 * This is the single most important pass in the ability, because it carries
 * four of the five panels on the reference sheet at once — the expanding ink
 * puddle, the brush-stroke ripples, the water surface, and the splatter — and
 * they have to be *one* surface. Drawn as four stacked decals they would sort
 * against each other, double their alpha where they overlap, and read as four
 * things on a floor rather than as one painting.
 *
 * Four decisions carry it, and none of them are about colour:
 *
 * **It is painted on paper.** A white wash with a deckled edge and a real tooth
 * goes down first, and everything else is painted onto it. Black on granite is
 * a scorch mark; black on paper is a brush stroke. That one pass is the whole
 * difference between this ability reading as ink and reading as tar, and it is
 * why the wash is the first thing to arrive and the last thing to leave.
 *
 * **The ink is watercolour, not paint.** Three physical behaviours, and they
 * are the ones an eye checks without knowing it: the boundary grows *dendritic*
 * fingers where pigment wicks along wet fibre; the drying rim is **darker**
 * than the middle, because pigment is carried outward and stranded there; and
 * the pigment **granulates**, settling into the tooth as a fine mottle. Remove
 * the three and what is left is a black disc with a soft edge.
 *
 * **The ripples are strokes, not circles.** Each ring is loaded at its start,
 * skips off the tooth of the paper through its middle (`uBristle`) and lifts
 * at its end. A ring without skips in it is a circle, and a circle on a floor
 * reads as UI however well it is shaded.
 *
 * **The water is wound, not spun.** Everything inside the footprint is sampled
 * through a rotation whose angle *rises toward the middle*, so the ink veil and
 * the surface waves shear into a spiral around the throat instead of turning
 * as a rigid disc. That shear is the only thing on the floor that says the
 * bodies are being pulled into something.
 *
 * Everything is in **metres from the centre of the tide**, so `zoneRadius`
 * re-floods a pool that is already standing and every feature keeps its
 * physical size when the footprint moves.
 */

const POOL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vViewDir = cameraPosition - world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * The ripple field, shared by the pool and the refraction proxy.
 *
 * It is a separate chunk for exactly one reason: the water is *shaded* with it
 * in one material and the frame is *bent* by it in another, and if the two ever
 * drifted apart the highlights would sit somewhere the refraction is not. One
 * definition, two consumers, no drift.
 */
const RIPPLE_GLSL = /* glsl */ `
  #define MAX_RINGS 8

  /**
   * How far a point is wound around the throat.
   *
   * The angle rises toward the middle rather than being constant, which is what
   * makes this a vortex: a constant angle turns the pool as one rigid plate and
   * nothing shears.
   */
  float windAngle(float rad, float radius, float spin) {
    float rn = clamp(rad / max(radius, 1e-3), 0.0, 1.0);
    return spin * (0.35 + 0.65 / (0.25 + rn));
  }

  /**
   * One brush ripple, accumulated over every ring in flight.
   *
   * Returns the ink laid down by the stroke in x, the white lifted along its
   * leading edge in y, and in z the height it stands off the surface — which is
   * what the normal and the refraction are both read off.
   */
  vec3 brushRings(
    float rad, vec2 dir, float radius, float clock, float count,
    float reach, float width, float taper, float bristle, float bristleScale,
    float wobble, float wobbleScale, float seed
  ) {
    vec3 acc = vec3(0.0);
    float n = max(1.0, count);

    for (int i = 0; i < MAX_RINGS; i++) {
      if (float(i) >= n) break;
      float id = float(i);

      // Evenly spaced in phase, so the rings leave at a steady interval however
      // many of them are in flight.
      float ph = fract(clock - id / n);
      float rr = ph * radius * reach;

      // The stroke wanders off true. A ring drawn on a perfect circle is a
      // compass mark; this is a brush being dragged around one.
      float wob = snoise(vec3(dir * wobbleScale, id * 3.7 + seed)) * wobble * radius;
      float target = rr + wob;

      // Loaded at the start, dry at the end.
      float w = max(0.01, width * (1.0 - taper * ph));
      float d = rad - target;
      float band = smoothstep(w, 0.0, abs(d));

      // Dry brush: the bristles skip off the tooth of the paper, and the skips
      // travel with the ring rather than sitting still on the floor.
      float skip = snoise01(vec3(dir * bristleScale, id * 9.1 + seed - ph * 2.0));
      float loaded = 1.0 - bristle * smoothstep(0.34, 0.86, skip);

      // Lifting: a stroke thins as the brush leaves the paper. Linear rather
      // than squared, because a ring has to survive the whole way out onto the
      // paper — the concentric strokes lying *outside* the water are half of
      // what the reference sheet is about, and a squared falloff kills every
      // one of them before it clears the pool.
      float alive = 1.0 - ph;

      acc.x += band * loaded * alive;
      // The white sits on the *outside* lip — the water the ring is pushing.
      acc.y += smoothstep(w * 0.75, 0.0, abs(d - w * 0.6)) * alive * loaded;
      acc.z += band * alive;
    }

    return acc;
  }
`;

const POOL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uSpread;       // metres the wash has soaked out to
  uniform float uOpen;         // 0..1, how full the water is
  uniform float uThroat;       // 0..1, how far the vortex has opened
  uniform float uSpin;         // accumulated vortex rotation, radians
  uniform float uRingClock;    // accumulated ring travel, in reaches
  uniform float uSwell;
  uniform float uDry;          // 0..1, how far it has dried to a stain
  uniform float uFade;
  uniform float uOpacity;
  uniform float uSeed;

  uniform float uWashRadius;
  uniform float uWashOpacity;
  uniform float uWashBleed;
  uniform float uWashDeckle;
  uniform float uWashDeckleScale;
  uniform float uWashTooth;
  uniform float uWashToothScale;
  uniform float uWashFibre;
  uniform float uWashFibreScale;
  uniform float uWashDry;

  uniform float uInkRadius;
  uniform float uInkOpacity;
  uniform float uInkFeather;
  uniform float uInkTendril;
  uniform float uInkTendrilScale;
  uniform float uInkEdge;
  uniform float uInkEdgeWidth;
  uniform float uGranulation;
  uniform float uGranulationScale;
  uniform float uInkSwirl;
  uniform float uInkVeil;
  uniform float uInkVeilScale;
  uniform float uInkVeilSharp;

  uniform float uWaterOpacity;
  uniform float uWaterDepth;
  uniform float uRipple;
  uniform float uRippleScale;
  uniform float uRippleSpeed;
  uniform float uChop;
  uniform float uChopScale;
  uniform float uSheen;
  uniform float uGloss;
  uniform float uCaustic;
  uniform float uCausticScale;
  uniform float uCausticSpeed;
  uniform float uRimFoam;
  uniform float uRimFoamWidth;

  uniform float uThroatSize;
  uniform float uThroatDepth;
  uniform float uThroatLip;

  uniform float uRings;
  uniform float uRingReach;
  uniform float uRingWidth;
  uniform float uRingTaper;
  uniform float uRingInk;
  uniform float uRingFoam;
  uniform float uRingBristle;
  uniform float uRingBristleScale;
  uniform float uRingWobble;
  uniform float uRingWobbleScale;

  uniform float uSplatter;
  uniform float uSplatterScale;
  uniform float uSplatterSize;
  uniform float uSplatterTail;
  uniform float uSplatterSpread;

  uniform vec3 uColorPaper;
  uniform vec3 uColorPaperShade;
  uniform vec3 uColorInk;
  uniform vec3 uColorInkWash;
  uniform vec3 uColorWater;
  uniform vec3 uColorWaterDeep;
  uniform vec3 uColorFoam;
  uniform vec3 uColorRim;

  uniform vec3  uLightDir;
  uniform float uGlobalGlow;

  varying vec2 vUv;
  varying vec3 vViewDir;

  ${noiseGLSL}
  ${commonGLSL}
  ${RIPPLE_GLSL}

  /**
   * Ink thrown clear of the stroke and dried where it landed.
   *
   * A jittered grid, but every fleck is drawn *out along its own bearing* from
   * the middle of the tide and carries a satellite dot ahead of it — which is
   * what a drop of ink off a moving brush actually leaves. Round dots on a grid
   * read as a particle system that stopped, whatever their spacing.
   */
  float splatterField(vec2 p, float scale, float chance, float size, float tail, float seed) {
    vec2 g = p * scale;
    vec2 n = floor(g);
    vec2 f = fract(g);

    float mark = 0.0;

    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        float cell = dot(n + o, vec2(51.7, 97.3)) + seed;
        float id = hash11(cell);
        if (id > chance) continue;

        vec2 jitter = hash21(cell * 1.73);
        vec2 c = o + jitter - f;

        // The bearing this fleck flew out on, taken from where it actually is.
        vec2 world = (n + o + jitter) / max(scale, 1e-3);
        vec2 bearing = normalize(world + vec2(1e-4, 1e-4));

        // Into the fleck's own frame, then squashed along it: a teardrop.
        vec2 q = vec2(dot(c, bearing), dot(c, vec2(-bearing.y, bearing.x)));
        float stretch = 1.0 + tail * hash11(cell * 3.11);
        // Only the trailing half is drawn out — a drop lands blunt and trails
        // behind, it is not a symmetric lozenge.
        q.x /= q.x < 0.0 ? stretch : 1.0;

        float r = size * (0.30 + hash11(cell * 5.37) * 0.70);
        mark = max(mark, smoothstep(r, r * 0.25, length(q)));

        // The satellite thrown off the front of the landing.
        vec2 s = c - bearing * r * (1.4 + hash11(cell * 7.13));
        mark = max(mark, smoothstep(r * 0.34, 0.0, length(s)) * 0.85);
      }
    }

    return mark;
  }

  void main() {
    // Metres from the centre of the tide. Everything below is in metres.
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float rad = length(p);
    vec2 dir = rad > 1e-4 ? p / rad : vec2(1.0, 0.0);

    /* ---- the sheet, and how far past it anything is drawn ---- */
    // Torn rather than cut. Two frequencies: a slow one for the shape the sheet
    // was torn into, a fast one for the ragged fibres along that tear. One
    // frequency alone leaves a wobbly circle, and a wobbly circle on a floor is
    // still a circle.
    float deckle = fbm3(vec3(dir * uWashDeckleScale, uSeed)) * 0.5 + 0.5;
    deckle = deckle * 0.72 + (snoise(vec3(dir * uWashDeckleScale * 4.3, uSeed * 2.7)) * 0.5 + 0.5) * 0.28;
    float washOuter = uRadius * uWashRadius * (1.0 - uWashDeckle * 0.5 + deckle * uWashDeckle);
    float outer = max(washOuter + uWashBleed, washOuter * uSplatterSpread);

    float aa = fwidth(rad) + 0.01;
    if (rad > outer + aa * 6.0) discard;

    /* ---- how much detail this pixel can actually resolve ---- */
    // Metres of floor one pixel covers. At the far rim, where the floor is
    // nearly edge-on, that is tens of centimetres — and every high-frequency
    // term here (the tooth, the granulation, the caustics, a specular lobe off
    // a derivative normal) then samples a different part of its field in each
    // neighbouring pixel and sparkles into a band of speckle lying across the
    // pool. Fading them as the footprint outgrows their features is what a mip
    // chain does for a texture.
    float footprint = max(fwidth(p.x), fwidth(p.y));
    float detail = 1.0 - smoothstep(0.02, 0.13, footprint);

    // Nothing exists ahead of the soak: the whole painting is revealed by the
    // ink spreading outward, not by an opacity ramp.
    float soak = smoothstep(uSpread + 0.4, uSpread - 0.7, rad);

    /* ---- the paper ---- */
    float tooth = fbm3(vec3(p * uWashToothScale, uSeed * 3.0)) * 0.5 + 0.5;
    // Fibres are long: the sampling frequency is anisotropic on purpose, so
    // they lie in the sheet rather than reading as more noise.
    float fibre = snoise01(vec3(p.x * uWashFibreScale * 0.22, p.y * uWashFibreScale * 3.4, uSeed * 13.0));
    float paper = smoothstep(washOuter + uWashBleed, washOuter - uWashBleed, rad);
    paper *= mix(1.0, tooth * 1.35, uWashTooth * detail);
    paper *= soak * mix(1.0, uWashDry, uDry);

    /* ---- the ink ---- */
    // Dendritic: pigment wicks along the wet fibres, so the boundary grows
    // fingers rather than staying on its own radius. Both octaves are fbm and
    // both are slow — a single high-frequency sine on the bearing gives a bay
    // and a headland at a fixed angular period, which draws a ring of identical
    // teeth around the puddle instead of a stain that spread.
    float lobes = fbm3(vec3(dir * uInkTendrilScale, uSeed * 7.0 + uTime * 0.015));
    float wick = fbm3(vec3(dir * uInkTendrilScale * 2.3, uSeed * 2.3 - uTime * 0.03));
    float inkOuter = uRadius * uInkRadius * (1.0 + (lobes * 0.4 + wick * 0.22) * uInkTendril);

    float ink = smoothstep(inkOuter + uInkFeather, inkOuter - uInkFeather, rad);
    // The stranded rim. Pigment is carried to the drying edge and left there,
    // which is why a watercolour wash is darkest at its outline — and why one
    // without it looks airbrushed.
    float rim = smoothstep(inkOuter - uInkEdgeWidth, inkOuter - uInkEdgeWidth * 0.25, rad) * ink;
    // Granulation: the pigment settling into the tooth of the paper.
    float grain = fbm3(vec3(p * uGranulationScale, uSeed * 11.0)) * 0.5 + 0.5;
    float inkMask = ink * mix(1.0, 0.45 + grain * 0.85, uGranulation * detail);
    inkMask = clamp(inkMask + rim * uInkEdge, 0.0, 1.0) * soak;

    /* ---- the splatter ---- */
    float splat = splatterField(p, uSplatterScale, uSplatter, uSplatterSize, uSplatterTail, uSeed * 17.0);
    // Thrown clear: none of it lands inside the puddle it came out of.
    splat *= smoothstep(uRadius * 0.8, uRadius * 1.1, rad);
    splat *= smoothstep(outer, outer * 0.65, rad) * soak;

    /* ---- the water, wound around the throat ---- */
    float turn = windAngle(rad, uRadius, uSpin);
    vec2 sp = rot2(turn) * p;

    float waterOuter = uRadius * (0.99 + lobes * 0.05);
    float water = smoothstep(waterOuter, waterOuter - 0.4, rad) * uOpen * (1.0 - uDry);

    // Ink suspended in it, sheared into strands by that same rotation — but
    // wound *harder* than the surface is. Pigment sits below the skin of the
    // water where the vortex is tighter, so the veil turning at exactly the
    // speed of the waves above it is the one thing that would flatten the pool
    // back into a single rotating plate.
    vec2 ip = rot2(turn * uInkSwirl) * p;
    float strand = 1.0 - abs(snoise(vec3(ip * uInkVeilScale, uSeed * 5.0 - uTime * 0.06)));
    float veil = pow(clamp(strand, 0.0, 1.0), max(0.05, uInkVeilSharp)) * uInkVeil * water;

    /* ---- the brush ripples ---- */
    vec3 rings = brushRings(
      rad, dir, uRadius, uRingClock, uRings, uRingReach,
      uRingWidth, uRingTaper, uRingBristle, uRingBristleScale,
      uRingWobble, uRingWobbleScale, uSeed
    );
    rings *= soak;

    /* ---- the surface ---- */
    // Waves are sampled in the wound frame so they spiral with the vortex; the
    // chop is not, so the surface still has motion of its own at the rim where
    // the winding is weakest.
    float wave = snoise(vec3(sp * uRippleScale, uTime * uRippleSpeed + uSeed));
    float chop = snoise(vec3(p * uChopScale, uTime * uRippleSpeed * 1.7 + uSeed * 3.0));
    // Only the *chop* is faded out with the pixel footprint. It is the term
    // whose features are smaller than a pixel at the far rim, so it is the term
    // that sparkles; the metre-scale waves and the ripple rings are resolvable
    // at any angle the camera can reach. Fading the whole height field instead
    // takes the specular with it, and a pool with no highlight at a grazing
    // angle — which is the angle this game is played at — stops reading as
    // water at all.
    float height = (wave + chop * uChop * detail) * uRipple * (1.0 + uSwell * 0.5)
                 + rings.z * uRipple * 2.2;

    // The gradient is taken in *world* space — screen derivatives of p invert
    // the pixel footprint — so the highlight is right however the camera lies.
    vec2 dpx = dFdx(p);
    vec2 dpy = dFdy(p);
    float det = dpx.x * dpy.y - dpx.y * dpy.x;
    vec2 grad = vec2(0.0);
    if (abs(det) > 1e-9) {
      float hx = dFdx(height);
      float hy = dFdy(height);
      grad = vec2(hx * dpy.y - hy * dpx.y, -hx * dpy.x + hy * dpx.x) / det;
    }
    vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));
    vec3 L = normalize(uLightDir);
    vec3 V = normalize(vViewDir);
    vec3 H = normalize(L + V);

    // One Blinn lobe. Everything else on this stage is rough; the tight
    // highlight is the cheapest thing that says *water* and the first thing
    // whose absence says *decal*.
    // Not faded by the footprint: the lobe rides the metre-scale waves, which
    // resolve at every angle. Its high-frequency partner was already removed
    // from the height field above.
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), mix(12.0, 140.0, uGloss)) * uSheen * water;
    float sheen = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0) * uSheen * 0.4 * water;

    // Caustics: the interference you get off a shallow disturbed surface.
    vec2 cp = sp * uCausticScale;
    float c1 = snoise(vec3(cp, uTime * uCausticSpeed + uSeed));
    float c2 = snoise(vec3(cp * 1.47 + 13.0, -uTime * uCausticSpeed * 0.8 + uSeed));
    float caustic = pow(clamp(1.0 - abs(c1 + c2) * 0.9, 0.0, 1.0), 6.0) * uCaustic * water * detail;

    // Foam gathered against the wall of the crown, broken up so it is a line of
    // bubbles rather than a stroke of white.
    float foamBand = smoothstep(uRimFoamWidth, 0.0, abs(rad - waterOuter));
    float foamBreak = snoise01(vec3(dir * 7.3, uTime * 0.5 + uSeed)) * 0.7 + 0.3;
    float foam = foamBand * foamBreak * uRimFoam * water;

    /* ---- the throat ---- */
    float throatR = max(0.02, uRadius * uThroatSize * uThroat);
    float throat = smoothstep(throatR, throatR * 0.3, rad) * uThroatDepth * uThroat;
    float lip = smoothstep(uThroatLip, 0.0, abs(rad - throatR)) * uThroat * water;

    /* ---- put the painting together ---- */
    vec3 paperColor = mix(uColorPaperShade, uColorPaper, 0.4 + tooth * 0.6);
    paperColor = mix(paperColor, uColorPaperShade, fibre * uWashFibre);

    vec3 color = paperColor;
    float alpha = paper * uWashOpacity;

    // Ink on the sheet.
    float pigment = clamp(inkMask * uInkOpacity + splat, 0.0, 1.0);
    color = mix(color, uColorInk, pigment);
    alpha = max(alpha, pigment);

    // Water over the ink — but the ink is *in* it, not under it. Two terms:
    // the pigment lying on the paper still darkens the water standing on top of
    // it, and the veil is suspended within it. Composite the water as an opaque
    // layer over the puddle and the ability stops being about ink at all, which
    // is exactly what it did on the first look-dev pass.
    float depth = smoothstep(waterOuter, 0.0, rad);
    vec3 waterColor = mix(uColorWater, uColorWaterDeep, pow(depth, max(0.05, uWaterDepth)));
    waterColor = mix(waterColor, uColorInk, clamp(pigment * 0.9 + veil, 0.0, 1.0));
    float wet = water * uWaterOpacity;
    color = mix(color, waterColor, wet);
    alpha = max(alpha, wet);

    // The hole in the middle of it.
    color = mix(color, uColorInk * 0.12, throat);
    alpha = max(alpha, throat * uWaterOpacity);

    // The stroke goes on last, because it is the mark that was drawn.
    float stroke = clamp(rings.x * uRingInk, 0.0, 1.0);
    color = mix(color, uColorInk, stroke);
    alpha = max(alpha, stroke);

    // Only the wet terms bloom. Multiplying the whole surface by the global
    // glow would blow the paper out to flat white the moment the slider moves.
    //
    // All of them are held *off the pigment*: a specular lobe running across a
    // black wash turns it grey, and grey ink is the one failure this pass
    // cannot come back from. The highlight belongs to the water between the
    // strands, not to the strands.
    // The white lifted by a stroke only exists where there is water to lift —
    // out on the dry paper a ripple is a black mark and nothing else.
    float ringFoam = rings.y * uRingFoam * water;

    float clear = 1.0 - clamp(pigment * 0.75 + veil * 0.85, 0.0, 1.0);
    vec3 emissive = uColorFoam * (foam + ringFoam + caustic * 0.8 * clear)
                  + mix(uColorRim, uColorFoam, 0.55) * (spec + sheen) * clear
                  + uColorRim * lip * 0.5;
    color += emissive * uGlobalGlow;
    alpha = max(alpha, clamp(foam + ringFoam + spec * 0.5 * clear, 0.0, 1.0));

    alpha = clamp(alpha, 0.0, 1.0) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The painted floor. One quad, re-sized and re-shaded from `settings.ink` every
 * frame — an ability-owned mesh rather than a pooled decal, because a decal
 * captures its radius when it spawns and this one has to re-flood under
 * `zoneRadius` while the tide is already standing.
 */
export function createInkPoolMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // Alpha blended, never additive. Ink has to *darken* the stone it is lying
    // on; an additive puddle can only add, so it would glow teal and the floor
    // would show straight through the black.
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 16 },
      uRadius: { value: 5 },
      uSpread: { value: 0 },
      uOpen: { value: 0 },
      uThroat: { value: 0 },
      uSpin: { value: 0 },
      uRingClock: { value: 0 },
      uSwell: { value: 0 },
      uDry: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uSeed: { value: 0 },

      uWashRadius: { value: 1.42 },
      uWashOpacity: { value: 0.82 },
      uWashBleed: { value: 0.55 },
      uWashDeckle: { value: 0.34 },
      uWashDeckleScale: { value: 2.1 },
      uWashTooth: { value: 0.42 },
      uWashToothScale: { value: 5.5 },
      uWashFibre: { value: 0.3 },
      uWashFibreScale: { value: 1.8 },
      uWashDry: { value: 0.55 },

      uInkRadius: { value: 1 },
      uInkOpacity: { value: 0.95 },
      uInkFeather: { value: 0.28 },
      uInkTendril: { value: 0.4 },
      uInkTendrilScale: { value: 3.4 },
      uInkEdge: { value: 0.85 },
      uInkEdgeWidth: { value: 0.5 },
      uGranulation: { value: 0.55 },
      uGranulationScale: { value: 6.5 },
      uInkSwirl: { value: 1.6 },
      uInkVeil: { value: 0.85 },
      uInkVeilScale: { value: 0.85 },
      uInkVeilSharp: { value: 2.2 },

      uWaterOpacity: { value: 0.72 },
      uWaterDepth: { value: 1.35 },
      uRipple: { value: 0.055 },
      uRippleScale: { value: 1.15 },
      uRippleSpeed: { value: 0.9 },
      uChop: { value: 0.4 },
      uChopScale: { value: 4.5 },
      uSheen: { value: 0.85 },
      uGloss: { value: 0.66 },
      uCaustic: { value: 0.55 },
      uCausticScale: { value: 2.4 },
      uCausticSpeed: { value: 0.55 },
      uRimFoam: { value: 0.75 },
      uRimFoamWidth: { value: 0.4 },

      uThroatSize: { value: 0.3 },
      uThroatDepth: { value: 0.9 },
      uThroatLip: { value: 0.16 },

      uRings: { value: 5 },
      uRingReach: { value: 1.5 },
      uRingWidth: { value: 0.2 },
      uRingTaper: { value: 0.65 },
      uRingInk: { value: 1 },
      uRingFoam: { value: 0.55 },
      uRingBristle: { value: 0.7 },
      uRingBristleScale: { value: 9 },
      uRingWobble: { value: 0.09 },
      uRingWobbleScale: { value: 2.4 },

      uSplatter: { value: 0.4 },
      uSplatterScale: { value: 0.95 },
      uSplatterSize: { value: 0.5 },
      uSplatterTail: { value: 2.2 },
      uSplatterSpread: { value: 1.1 },

      uColorPaper: { value: new Color(0.91, 0.89, 0.85) },
      uColorPaperShade: { value: new Color(0.66, 0.64, 0.59) },
      uColorInk: { value: new Color(0.02, 0.03, 0.04) },
      uColorInkWash: { value: new Color(0.13, 0.2, 0.23) },
      uColorWater: { value: new Color(0.11, 0.37, 0.41) },
      uColorWaterDeep: { value: new Color(0.03, 0.13, 0.16) },
      uColorFoam: { value: new Color(0.9, 0.96, 0.94) },
      uColorRim: { value: new Color(0.56, 0.85, 0.82) }
    }),
    vertexShader: POOL_VERTEX,
    fragmentShader: POOL_FRAGMENT
  });

  /**
   * @param {object} state { radius, quadSize, spread, open, throat, spin,
   *   ringClock, swell, dry, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.ink;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uSpread.value = state.spread;
    u.uOpen.value = state.open;
    u.uThroat.value = state.throat;
    u.uSpin.value = state.spin;
    u.uRingClock.value = state.ringClock;
    u.uSwell.value = state.swell * c.swellDepth;
    u.uDry.value = state.dry;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uWashRadius.value = c.washRadius;
    u.uWashOpacity.value = c.washOpacity;
    u.uWashBleed.value = c.washBleed;
    u.uWashDeckle.value = c.washDeckle * g.noiseStrength;
    u.uWashDeckleScale.value = c.washDeckleScale * g.noiseFrequency;
    u.uWashTooth.value = c.washTooth;
    u.uWashToothScale.value = c.washToothScale * g.noiseFrequency;
    u.uWashFibre.value = c.washFibre;
    u.uWashFibreScale.value = c.washFibreScale * g.noiseFrequency;
    u.uWashDry.value = c.washDry;

    u.uInkRadius.value = c.inkRadius;
    u.uInkOpacity.value = c.inkOpacity;
    u.uInkFeather.value = c.inkFeather;
    u.uInkTendril.value = c.inkTendril * g.noiseStrength;
    u.uInkTendrilScale.value = c.inkTendrilScale * g.noiseFrequency;
    u.uInkEdge.value = c.inkEdge;
    u.uInkEdgeWidth.value = c.inkEdgeWidth;
    u.uGranulation.value = c.granulation;
    u.uGranulationScale.value = c.granulationScale * g.noiseFrequency;
    u.uInkSwirl.value = c.inkSwirl;
    u.uInkVeil.value = c.inkVeil * g.shaderIntensity;
    u.uInkVeilScale.value = c.inkVeilScale * g.noiseFrequency;
    u.uInkVeilSharp.value = c.inkVeilSharp;

    u.uWaterOpacity.value = c.waterOpacity * g.opacity;
    u.uWaterDepth.value = c.waterDepth;
    u.uRipple.value = c.ripple * g.noiseStrength;
    u.uRippleScale.value = c.rippleScale * g.noiseFrequency;
    u.uRippleSpeed.value = c.rippleSpeed * g.noiseSpeed;
    u.uChop.value = c.chop;
    u.uChopScale.value = c.chopScale * g.noiseFrequency;
    u.uSheen.value = c.sheen * g.shaderIntensity;
    u.uGloss.value = c.gloss;
    u.uCaustic.value = c.caustic * g.shaderIntensity;
    u.uCausticScale.value = c.causticScale * g.noiseFrequency;
    u.uCausticSpeed.value = c.causticSpeed * g.noiseSpeed;
    u.uRimFoam.value = c.rimFoam;
    u.uRimFoamWidth.value = c.rimFoamWidth;

    u.uThroatSize.value = c.throatSize;
    u.uThroatDepth.value = c.throatDepth;
    u.uThroatLip.value = c.throatLip;

    u.uRings.value = Math.round(c.rings);
    u.uRingReach.value = c.ringReach;
    u.uRingWidth.value = c.ringWidth;
    u.uRingTaper.value = c.ringTaper;
    u.uRingInk.value = c.ringInk;
    u.uRingFoam.value = c.ringFoam;
    u.uRingBristle.value = c.ringBristle;
    u.uRingBristleScale.value = c.ringBristleScale * g.noiseFrequency;
    u.uRingWobble.value = c.ringWobble * g.noiseStrength;
    u.uRingWobbleScale.value = c.ringWobbleScale * g.noiseFrequency;

    u.uSplatter.value = c.splatter;
    u.uSplatterScale.value = c.splatterScale * g.noiseFrequency;
    u.uSplatterSize.value = c.splatterSize;
    u.uSplatterTail.value = c.splatterTail;
    u.uSplatterSpread.value = c.splatterSpread;
    u.uOpacity.value = c.poolOpacity * g.opacity;

    u.uColorPaper.value.copy(getColor(c.colorPaper));
    u.uColorPaperShade.value.copy(getColor(c.colorPaperShade));
    u.uColorInk.value.copy(getColor(c.colorInk));
    u.uColorInkWash.value.copy(getColor(c.colorInkWash));
    u.uColorWater.value.copy(getColor(c.colorWater));
    u.uColorWaterDeep.value.copy(getColor(c.colorWaterDeep));
    u.uColorFoam.value.copy(getColor(c.colorFoam));
    u.uColorRim.value.copy(getColor(c.colorRim));
  };

  return material;
}

/* ==================================================================== */
/* The surface refraction                                                */
/* ==================================================================== */

/**
 * Writes screen-space refraction offsets instead of colour — the mesh lives on
 * `LAYER.DISTORTION`, is invisible to the main pass, and the composite warps
 * the frame by whatever this leaves in the buffer:
 *
 *   R,G → offset encoded around 0.5   B → strength   A → coverage
 *
 * The proxy is the **floor**, not a camera-facing card. A card would bend the
 * frame in front of the water rather than through it, and would swing as the
 * camera orbits; a ground quad bends exactly the pixels the surface covers, and
 * it reads the *same* ripple field the pool is shaded with, so the highlights
 * can never sit somewhere the refraction is not.
 */
const WARP_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uOpen;
  uniform float uSpin;
  uniform float uRingClock;
  uniform float uRings;
  uniform float uRingReach;
  uniform float uRingWidth;
  uniform float uRingTaper;
  uniform float uRingBristle;
  uniform float uRingBristleScale;
  uniform float uRingWobble;
  uniform float uRingWobbleScale;
  uniform float uRippleAmount;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uStrength;
  uniform float uSeed;
  uniform float uShaderIntensity;

  varying vec2 vUv;

  ${noiseGLSL}
  ${RIPPLE_GLSL}

  void main() {
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float rad = length(p);
    vec2 dir = rad > 1e-4 ? p / rad : vec2(1.0, 0.0);

    // Feathered at the boundary: a warp with an edge on it draws the outline of
    // its own proxy across the frame.
    float mask = smoothstep(uRadius * 1.06, uRadius * 0.82, rad) * uOpen;
    if (mask < 0.004) discard;

    float turn = windAngle(rad, uRadius, uSpin);
    vec2 sp = rot2(turn) * p;

    // The chop bends the frame everywhere; the rings bend it where they are.
    float nx = snoise(vec3(sp * uScale, uTime * uSpeed + uSeed));
    float ny = snoise(vec3(sp * uScale + vec2(23.1, 7.9), uTime * uSpeed + uSeed + 5.0));

    vec3 rings = brushRings(
      rad, dir, uRadius, uRingClock, uRings, uRingReach,
      uRingWidth, uRingTaper, uRingBristle, uRingBristleScale,
      uRingWobble, uRingWobbleScale, uSeed
    );
    // A ring is a ridge, so it pushes the frame *outward* along the bearing —
    // which is the one direction a symmetric noise could never give it.
    vec2 ridge = dir * rings.z * uRippleAmount;

    vec2 offset = clamp(vec2(nx, ny) * 0.65 + ridge, vec2(-1.0), vec2(1.0));
    float strength = uStrength * uShaderIntensity * mask;

    gl_FragColor = vec4(offset * 0.5 + 0.5, strength, mask);
  }
`;

const WARP_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export function createInkRefractionMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 12 },
      uRadius: { value: 5 },
      uOpen: { value: 0 },
      uSpin: { value: 0 },
      uRingClock: { value: 0 },
      uRings: { value: 5 },
      uRingReach: { value: 1.5 },
      uRingWidth: { value: 0.2 },
      uRingTaper: { value: 0.65 },
      uRingBristle: { value: 0.7 },
      uRingBristleScale: { value: 9 },
      uRingWobble: { value: 0.09 },
      uRingWobbleScale: { value: 2.4 },
      uRippleAmount: { value: 0.85 },
      uScale: { value: 1.6 },
      uSpeed: { value: 0.7 },
      uStrength: { value: 1 },
      uSeed: { value: 0 }
    }),
    vertexShader: WARP_VERTEX,
    fragmentShader: WARP_FRAGMENT
  });

  /**
   * @param {object} state { radius, quadSize, open, spin, ringClock, strength, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.ink;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uOpen.value = state.open;
    u.uSpin.value = state.spin;
    u.uRingClock.value = state.ringClock;
    u.uSeed.value = state.seed;

    u.uRings.value = Math.round(c.rings);
    u.uRingReach.value = c.ringReach;
    u.uRingWidth.value = c.ringWidth;
    u.uRingTaper.value = c.ringTaper;
    u.uRingBristle.value = c.ringBristle;
    u.uRingBristleScale.value = c.ringBristleScale * g.noiseFrequency;
    u.uRingWobble.value = c.ringWobble * g.noiseStrength;
    u.uRingWobbleScale.value = c.ringWobbleScale * g.noiseFrequency;

    u.uRippleAmount.value = c.warpRipple;
    u.uScale.value = c.warpScale * g.noiseFrequency;
    u.uSpeed.value = c.warpSpeed * g.noiseSpeed;
    u.uStrength.value = state.strength * c.warpStrength * g.distortion;
  };

  return material;
}
