import {
  Color,
  DoubleSide,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * The wild growth — layers 2 and 3 of the breakdown, in one file because they
 * are one shape.
 *
 * A leaf is not decoration scattered near a tendril: it is **clipped to** it.
 * Both materials include the same `vinePoint` / `vineFrame` / `vineRadius`
 * block and are handed the same uniform boxes by identity, so a leaf resolves
 * the exact stem position the tube resolved, on the same frame, from the same
 * numbers. Drag `curl turns` while a summon is standing and the foliage curls
 * with the wood. There is no other way to keep several hundred leaves welded to
 * fourteen animated stems without either baking the stems (and losing the live
 * controls) or reading geometry back off the GPU (and losing the frame).
 *
 * ## Why these are lit materials and not raw shaders
 *
 * Everything else this project draws in the air is additive and unlit, which is
 * right for fire and lightning. Wood is not light — it is *matter*, and matter
 * that does not sit in the sun, take a shadow, occlude what is behind it and
 * pick up the probe reads as a decal wrapped around the scene however good its
 * silhouette is. So the tendrils and the foliage are `MeshStandardMaterial`
 * with their vertex stage replaced: the shading model is three's, the geometry
 * is ours.
 *
 * Two consequences fall out of that and both are load-bearing:
 *
 *  - **the shadow pass needs the same vertex stage.** A depth material built
 *    from the untouched geometry would rasterise a flat sheet of parameter
 *    space somewhere near the origin, so `createVineMaterial` hands back a
 *    matching `MeshDepthMaterial` for the mesh's `customDepthMaterial`.
 *  - **the model matrix must be identity.** The vertex stage writes *world*
 *    positions into `transformed`, so the ability's group and both meshes are
 *    left at the origin, unrotated and unscaled. Move either and the summon
 *    moves twice.
 *
 * @see GrowthGeometry.js for the buffers these run on.
 */

/* -------------------------------------------------------------------- */
/* the shape                                                             */
/* -------------------------------------------------------------------- */

/**
 * The uniform block that *is* the growth, shared by every material that has to
 * agree about where a stem is.
 *
 * One of these per cast (the ability owns it and hands it to the tube, the
 * foliage and both depth materials), so writing it once per frame updates all
 * four. Nothing here is a metre until `syncGrowthShape` resolves it against the
 * live settings — a cast captures a seed and nothing else.
 */
export function createGrowthShape() {
  return {
    uTime: frame.uTime,
    /** Where the summon stands, on the floor. */
    uCentre: { value: new Vector3() },
    uSeed: { value: 0 },
    /** How far the growth front has run, 0..1, before the per-stem stagger. */
    uGrow: { value: 0 },
    /** How much of the growth one stem may lag the first by. */
    uStagger: { value: 0.35 },
    /** How far the wither has eaten back down from the tips, 0..1. */
    uWither: { value: 0 },

    uCount: { value: 12 },
    uRadius: { value: 4 },
    uSeat: { value: 0.72 },
    uSpread: { value: 0.7 },
    uHeight: { value: 3.4 },
    uHeightJitter: { value: 0.4 },
    uRise: { value: 0.78 },
    uBelly: { value: 0.34 },
    uLean: { value: 0.24 },
    uTwist: { value: 0.34 },
    uCurlAt: { value: 0.68 },
    uCurlTurns: { value: 0.55 },
    uCurlPinch: { value: 0.45 },
    uCurlLift: { value: 0.12 },
    uWander: { value: 0.5 },
    uWanderScale: { value: 2.2 },
    uSway: { value: 0.09 },
    uSwaySpeed: { value: 0.8 },
    uThick: { value: 0.115 },
    uTaper: { value: 0.22 },
    uKnots: { value: 0.3 },
    uKnotScale: { value: 9.0 }
  };
}

/**
 * Resolve the shape against `settings.growth`.
 *
 * @param {object} shape the block from `createGrowthShape`
 * @param {object} state { centre, seed, grow, wither }
 */
export function syncGrowthShape(shape, state) {
  const c = settings.growth;
  const g = settings.global;

  shape.uCentre.value.copy(state.centre);
  shape.uSeed.value = state.seed;
  shape.uGrow.value = state.grow;
  shape.uWither.value = state.wither;

  shape.uCount.value = Math.max(1, Math.round(c.vines));
  shape.uRadius.value = Math.max(0.05, c.zoneRadius);
  shape.uSeat.value = c.vineSeat;
  shape.uSpread.value = c.vineSpread * g.randomness;
  shape.uHeight.value = c.vineHeight;
  shape.uHeightJitter.value = c.vineHeightJitter * g.randomness;
  shape.uRise.value = c.vineRise;
  shape.uBelly.value = c.vineBelly;
  shape.uLean.value = c.vineLean;
  shape.uTwist.value = c.vineTwist;
  shape.uCurlAt.value = c.vineCurlAt;
  shape.uCurlTurns.value = c.vineCurlTurns;
  shape.uCurlPinch.value = c.vineCurlPinch;
  shape.uCurlLift.value = c.vineCurlLift;
  shape.uWander.value = c.vineWander * g.noiseStrength;
  shape.uWanderScale.value = c.vineWanderScale * g.noiseFrequency;
  shape.uSway.value = c.vineSway;
  shape.uSwaySpeed.value = c.vineSwaySpeed * g.noiseSpeed;
  shape.uThick.value = c.vineThick;
  shape.uTaper.value = c.vineTaper;
  shape.uKnots.value = c.vineKnots * g.randomness;
  shape.uKnotScale.value = c.vineKnotScale * g.noiseFrequency;
  shape.uStagger.value = c.vineStagger;
}

/**
 * The path a tendril takes, and the frame that rides it.
 *
 * Injected into four shaders. Everything is analytic and everything is a
 * function of `(vine, t)` — there is no state, no buffer and no CPU pass, which
 * is what lets the tube, its foliage and both shadow passes stay in agreement
 * without ever exchanging a number.
 */
const GROWTH_PATH = /* glsl */ `
  #ifndef GROWTH_PATH_INCLUDED
  #define GROWTH_PATH_INCLUDED

  #define GTAU 6.283185307179586
  #define GPI  3.141592653589793

  uniform float uTime;
  uniform vec3  uCentre;
  uniform float uSeed;
  uniform float uGrow;
  uniform float uStagger;
  uniform float uWither;

  uniform float uCount;
  uniform float uRadius;
  uniform float uSeat;
  uniform float uSpread;
  uniform float uHeight;
  uniform float uHeightJitter;
  uniform float uRise;
  uniform float uBelly;
  uniform float uLean;
  uniform float uTwist;
  uniform float uCurlAt;
  uniform float uCurlTurns;
  uniform float uCurlPinch;
  uniform float uCurlLift;
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uSway;
  uniform float uSwaySpeed;
  uniform float uThick;
  uniform float uTaper;
  uniform float uKnots;
  uniform float uKnotScale;

  /**
   * One tendril's dice: bearing scatter, height, handedness, phase.
   *
   * Four hashes of the instance index and the cast's seed, and they are the
   * whole of a stem's identity — which is why re-seeding a cast reshuffles the
   * nest without touching a single control.
   */
  vec4 vineDice(float vine) {
    return vec4(
      hash11(vine * 7.13 + uSeed * 3.11),
      hash11(vine * 3.71 + uSeed * 5.77 + 11.3),
      hash11(vine * 11.9 + uSeed * 2.33 + 27.1),
      hash11(vine * 5.17 + uSeed * 9.71 + 41.9)
    );
  }

  /**
   * How far *this* stem has grown, 0..1.
   *
   * The nest has to come up ragged. Fourteen tendrils that leave the floor on
   * the same frame and stop on the same frame read as one object opening, which
   * is exactly what a summon must not look like — so each lags the first by up
   * to 'uStagger' of the whole climb and then runs its remainder faster.
   */
  float vineGrowth(float vine) {
    float lag = clamp(vineDice(vine).w * uStagger, 0.0, 0.85);
    return clamp((uGrow - lag) / max(1.0 - lag, 1e-3), 0.0, 1.0);
  }

  /** A point on a tendril's centre line. 't' is 0 at the foot, 1 at the tip. */
  vec3 vinePoint(float vine, float t) {
    vec4 d = vineDice(vine);
    float u = clamp(t, 0.0, 1.0);

    float bearing = ((vine + (d.x - 0.5) * uSpread) / max(uCount, 1.0)) * GTAU;
    float hand = d.z < 0.5 ? -1.0 : 1.0;

    float foot = uRadius * uSeat * (0.75 + 0.5 * d.y);
    float height = uHeight * (1.0 - uHeightJitter * 0.5 + uHeightJitter * d.y);

    // How far out the stem is at this height: planted out at the ring, bowed
    // past it at the waist, drawn back in under the bloom. The bow is what
    // makes the nest read as a *cage* rather than as a cone of sticks.
    float radial = mix(foot, foot * uLean, smoothstep(0.0, 1.0, u));
    radial += foot * uBelly * sin(u * GPI);

    float twist = bearing + hand * uTwist * u * GTAU;

    // The tip curls, and that one term is what says "grown" instead of
    // "extruded": the last stretch spirals inward and lifts as it tightens.
    float c = smoothstep(uCurlAt, 1.0, u);
    twist += hand * uCurlTurns * c * c * GTAU;
    radial *= mix(1.0, uCurlPinch, c);

    float y = height * pow(u, max(uRise, 0.05)) + height * uCurlLift * c;
    vec3 p = uCentre + vec3(cos(twist) * radial, y, sin(twist) * radial);

    // Wander (baked into the stem) and sway (alive), both weighted up the stem
    // so the foot stays planted in the floor and only the tip moves.
    float phase = d.w * 31.7;
    p.x += snoise(vec3(u * uWanderScale, phase, uSeed)) * uWander * u;
    p.z += snoise(vec3(u * uWanderScale + 17.1, phase, uSeed + 5.3)) * uWander * u;
    p.x += sin(uTime * uSwaySpeed + phase) * uSway * u * u;
    p.z += sin(uTime * uSwaySpeed * 0.73 + phase * 1.7) * uSway * u * u;

    return p;
  }

  /**
   * Half-width of the stem at t, metres.
   *
   * 'grow' is the stem's own front: the taper that draws a finished tendril to
   * a point at its tip has to follow the front while it is still climbing, or a
   * half-grown stem ends in a flat disc hanging in the air.
   */
  float vineRadius(float vine, float t, float grow) {
    vec4 d = vineDice(vine);
    float u = clamp(t, 0.0, 1.0);

    float r = uThick * (0.72 + 0.56 * d.y) * mix(1.0, uTaper, pow(u, 0.75));
    // Knots. A stem is not a machined rod, and the lumps are most of what sells
    // the wood at the silhouette.
    r *= 1.0 + uKnots * snoise(vec3(u * uKnotScale, d.w * 19.0, uSeed));
    // Written forwards (edge0 < edge1) rather than as a reversed smoothstep:
    // the spec leaves reversed edges undefined, and this one is evaluated with
    // 'grow' at zero on the frame before a cast starts.
    r *= 1.0 - smoothstep(grow - 0.07, grow, u);
    return max(r, 1e-5);
  }

  /**
   * The stem's local frame at t.
   *
   * The reference axis is the stem's own outward radial, taken from the point
   * itself — a smooth function of t by construction. That matters more than it
   * looks: the usual trick (cross the tangent with world up, swap axes near the
   * poles) *flips* somewhere up a tendril that passes through vertical, and a
   * frame that flips between two rows of a tube twists every quad between them
   * into a bow tie.
   */
  void vineFrame(float vine, float t, vec3 here, out vec3 tangent, out vec3 n1, out vec3 n2) {
    float step_ = 0.012;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }

    tangent = (vinePoint(vine, ahead) - here) * flip;
    tangent = dot(tangent, tangent) > 1e-12 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);

    vec3 outward = here - vec3(uCentre.x, here.y, uCentre.z);
    if (dot(outward, outward) < 1e-8) outward = vec3(1.0, 0.0, 0.0);
    outward = normalize(outward);

    n2 = cross(tangent, outward);
    if (dot(n2, n2) < 1e-10) n2 = cross(tangent, vec3(0.0, 0.0, 1.0));
    n2 = normalize(n2);
    n1 = normalize(cross(n2, tangent));
  }

  #endif
`;

/* -------------------------------------------------------------------- */
/* the tendrils                                                          */
/* -------------------------------------------------------------------- */

/**
 * The tube's vertex stage.
 *
 * Written into two globals rather than straight into `transformed`, because
 * three resolves the normal *before* the position (`<beginnormal_vertex>` comes
 * first in the chain) and both come out of the same evaluation.
 */
const VINE_VERTEX_DECL = /* glsl */ `
  attribute float aVine;
  varying vec3  vGrowthWorld;
  varying vec3  vGrowthNormal;
  varying float vGrowthT;
  varying float vGrowthFront;
  varying float vGrowthSeed;
  varying float vGrowthAngle;
  vec3 gPosition;
  vec3 gNormal;

  void growthVertex() {
    float vine = aVine;
    float grow = vineGrowth(vine);
    // The tube is drawn in the *grown* part of the stem, so the whole buffer
    // compresses into it: a tendril extends rather than fading in, and it keeps
    // every one of its samples while it does.
    float t = position.x * grow;

    vec3 here = vinePoint(vine, t);
    vec3 tangent, n1, n2;
    vineFrame(vine, t, here, tangent, n1, n2);

    float angle = position.y * GTAU;
    gNormal = n1 * cos(angle) + n2 * sin(angle);
    gPosition = here + gNormal * vineRadius(vine, t, grow);

    vGrowthWorld = gPosition;
    vGrowthNormal = gNormal;
    vGrowthT = t;
    vGrowthFront = grow;
    vGrowthSeed = vineDice(vine).w;
    vGrowthAngle = position.y;
  }
`;

/** Fragment-side declarations shared by the tube's colour and its shadow. */
const VINE_FRAGMENT_DECL = /* glsl */ `
  uniform vec3  uColorBark;
  uniform vec3  uColorBarkLight;
  uniform vec3  uColorSeam;
  uniform vec3  uColorSeamCore;
  uniform vec3  uColorFront;
  uniform vec3  uColorWither;
  uniform float uBarkScale;
  uniform float uBarkContrast;
  uniform float uFibre;
  uniform float uFibreBands;
  uniform float uFibreScale;
  uniform float uSeamWidth;
  uniform float uSeamBands;
  uniform float uSeamScale;
  uniform float uSeamFlow;
  uniform float uSeamGlow;
  uniform float uSapPulse;
  uniform float uSapSpeed;
  uniform float uSapWidth;
  uniform float uFrontGlow;
  uniform float uFrontWidth;
  uniform float uRimGlow;
  uniform float uRimPower;
  uniform float uWither;
  uniform float uWitherRise;
  uniform float uWitherScale;
  uniform float uWitherEdge;
  uniform float uGlow;
  varying vec3  vGrowthWorld;
  varying vec3  vGrowthNormal;
  varying float vGrowthT;
  varying float vGrowthFront;
  varying float vGrowthSeed;
  varying float vGrowthAngle;
`;

/**
 * The wither, as a `discard`.
 *
 * Opaque the whole way rather than a fading alpha, so the wood never has to
 * sort against the membrane of leaves around it — and so the burn edge can be
 * emissive instead of transparent. It eats from the *tip* down, which is the
 * order a plant actually dies in and, more usefully, the order that keeps the
 * silhouette legible longest: the nest thins before it shortens.
 *
 * `keep` is 1 at the foot and 0 at the tip, blended against a noise field so
 * the line is ragged rather than a wipe.
 */
const WITHER_GLSL = /* glsl */ `
  float growthWither(vec3 world, float t, float seed, out float edge) {
    edge = 0.0;
    if (uWither <= 0.0) return 1.0;
    float n = fbm3(world * uWitherScale + seed * 37.0) * 0.5 + 0.5;
    float keep = mix(n, 1.0 - t, clamp(uWitherRise, 0.0, 1.0));
    edge = 1.0 - smoothstep(0.0, max(uWitherEdge, 1e-3), keep - uWither);
    return keep - uWither;
  }
`;

/**
 * Bark: dark, fibrous wood with something alive running under it.
 *
 * The seams are the zero crossing of an fbm field sampled in the stem's own
 * `(around, along)` space rather than in world space — the one decision in this
 * shader worth arguing about, and the reason the veins *run up the tendril*
 * instead of drifting across it like a texture the stem happens to be passing
 * through. Sampling in world space is right for a static rock (see
 * `ObsidianMaterial`); it is wrong for something that grew.
 */
function vineFragmentBody() {
  return /* glsl */ `
    {
      vec3  N = normalize(vGrowthNormal);
      vec3  V = normalize(vViewPosition);
      // Absolute rather than clamped: on a closed tube seen edge-on the far
      // wall is still wood, and clamping paints it flat black.
      float ndv = abs(dot(N, V));

      /* ---- the wood ---- */
      float grain = fbm3(vGrowthWorld * uBarkScale + vGrowthSeed * 23.0) * 0.5 + 0.5;
      grain = clamp((grain - 0.5) * uBarkContrast + 0.5, 0.0, 1.0);
      // Fibres, in the stem's own frame so they run the length of it.
      float fib = ridged(vec3(vGrowthAngle * uFibreBands, vGrowthT * uFibreScale, vGrowthSeed * 7.0), 4);
      fib = clamp(fib * 0.55, 0.0, 1.0);

      vec3 bark = mix(uColorBark, uColorBarkLight, grain);
      bark *= mix(1.0 - uFibre * 0.6, 1.0 + uFibre * 0.25, fib);
      // Cheap curvature: the far side of a round stem is in its own shadow long
      // before the sun stops reaching it.
      bark *= mix(0.55, 1.1, ndv);
      // Charred back along the burn. Wood that is being eaten away goes *dark*
      // first and glows second; adding light without taking the albedo out
      // bleaches the stump instead of burning it, which reads as bone.
      bark *= mix(1.0, 0.18, clamp(witherEdge, 0.0, 1.0));
      diffuseColor.rgb *= bark;

      /* ---- what is running inside it ---- */
      float f = fbm3(vec3(
        vGrowthAngle * uSeamBands,
        vGrowthT * uSeamScale - uTime * uSeamFlow,
        vGrowthSeed * 13.0
      ));
      float d = abs(f);
      float seam = 1.0 - smoothstep(uSeamWidth * 0.35, uSeamWidth, d);
      float core = 1.0 - smoothstep(0.0, uSeamWidth * 0.35, d);

      // Sap: a bright band climbing the stem, on its own phase per tendril, so
      // the nest pulses out of step with itself instead of flashing as one.
      float wave = fract(uTime * uSapSpeed + vGrowthSeed);
      float sap = exp(-pow((vGrowthT - wave) / max(uSapWidth, 1e-3), 2.0)) * uSapPulse;

      vec3 glow = mix(uColorSeam, uColorSeamCore, clamp(core, 0.0, 1.0));
      glow *= seam * uSeamGlow * (1.0 + sap);

      /* ---- the growing tip ---- */
      // Bright while the front is still moving and all but out once it stops:
      // this is the bud, and a bud that keeps burning after the stem has
      // finished is a lamp on a stick.
      float behind = vGrowthFront - vGrowthT;
      float front = 1.0 - smoothstep(0.0, max(uFrontWidth, 1e-3), behind);
      front *= mix(0.18, 1.0, 1.0 - smoothstep(0.9, 1.0, vGrowthFront));
      glow += uColorFront * front * uFrontGlow;

      /* ---- the sheath of light around the silhouette ---- */
      glow += uColorSeam * pow(1.0 - ndv, max(uRimPower, 0.05)) * uRimGlow;

      /* ---- and the line the wither leaves as it eats back ---- */
      // Only the last of the band is hot: an ember is a *line*, and the noisy
      // threshold that makes the burn ragged would otherwise light half a stem.
      float ember = pow(clamp(witherEdge, 0.0, 1.0), 3.0);
      glow += uColorWither * ember * uWitherEdgeGain;

      glow *= uGlow;
      // The same soft ceiling the rest of the project uses: these terms are
      // independent and stack, and without it a seam crossing the rim sums past
      // ten and the bloom pass smears the stem into a white worm.
      glow /= 1.0 + glow * 0.2;
      totalEmissiveRadiance += glow;
    }
  `;
}

/** Every colour and control the bark shader reads, as its own uniform block. */
function vineLookUniforms() {
  return {
    uColorBark: { value: new Color() },
    uColorBarkLight: { value: new Color() },
    uColorSeam: { value: new Color() },
    uColorSeamCore: { value: new Color() },
    uColorFront: { value: new Color() },
    uColorWither: { value: new Color() },
    uBarkScale: { value: 5.5 },
    uBarkContrast: { value: 1.5 },
    uFibre: { value: 0.55 },
    uFibreBands: { value: 3.0 },
    uFibreScale: { value: 26.0 },
    uSeamWidth: { value: 0.1 },
    uSeamBands: { value: 2.4 },
    uSeamScale: { value: 5.0 },
    uSeamFlow: { value: 0.35 },
    uSeamGlow: { value: 2.6 },
    uSapPulse: { value: 2.2 },
    uSapSpeed: { value: 0.35 },
    uSapWidth: { value: 0.12 },
    uFrontGlow: { value: 4.5 },
    uFrontWidth: { value: 0.09 },
    uRimGlow: { value: 0.5 },
    uRimPower: { value: 2.6 },
    uWitherRise: { value: 0.55 },
    uWitherScale: { value: 3.2 },
    uWitherEdge: { value: 0.16 },
    uWitherEdgeGain: { value: 5.0 },
    uGlow: { value: 1 }
  };
}

/**
 * The tendrils.
 *
 * @param {import('../world/Environment.js').Environment} environment
 * @param {object} shape the block from `createGrowthShape`
 * @returns {THREE.MeshStandardMaterial} with `userData.depth` — the matching
 *   depth material the mesh must be given as its `customDepthMaterial` — and
 *   `userData.sync`.
 */
export function createVineMaterial(environment, shape) {
  const look = vineLookUniforms();
  const uniforms = { ...shape, ...look, uWitherEdgeGain: look.uWitherEdgeGain };

  const material = new MeshStandardMaterial({
    name: 'GrowthVine',
    color: 0xffffff,
    roughness: 0.82,
    metalness: 0.0,
    // The tube is closed, but a stem this thin is read at its silhouette from
    // every side and the far wall is what stops a grazing view showing through
    // the near one where the knots pinch it.
    side: DoubleSide
  });

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${GROWTH_PATH}\n${VINE_VERTEX_DECL}`)
      .replace('#include <beginnormal_vertex>', 'growthVertex();\nvec3 objectNormal = gNormal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = gPosition;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${noiseGLSL}\n${VINE_FRAGMENT_DECL}\nuniform float uWitherEdgeGain;\nuniform float uTime;\n${WITHER_GLSL}`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         float witherEdge;
         if (growthWither(vGrowthWorld, vGrowthT, vGrowthSeed, witherEdge) < 0.0) discard;`
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${vineFragmentBody()}`);
  });

  material.userData.uniforms = uniforms;
  // The shadow has to wither with the wood. Without it a stem that has burned
  // back to a stump goes on laying a full-length shadow across the floor.
  material.userData.depth = createGrowthDepthMaterial(uniforms, VINE_VERTEX_DECL, {
    name: 'vine',
    fragmentDecl: /* glsl */ `
      uniform float uWither;
      uniform float uWitherRise;
      uniform float uWitherScale;
      uniform float uWitherEdge;
      varying vec3  vGrowthWorld;
      varying float vGrowthT;
      varying float vGrowthT;
      varying float vGrowthSeed;
      ${WITHER_GLSL}
    `,
    cull: `float witherEdge;
           if (growthWither(vGrowthWorld, vGrowthT, vGrowthSeed, witherEdge) < 0.0) discard;`
  });

  material.userData.sync = () => {
    const c = settings.growth;
    const g = settings.global;
    const u = uniforms;

    u.uColorBark.value.copy(getColor(c.colorBark));
    u.uColorBarkLight.value.copy(getColor(c.colorBarkLight));
    u.uColorSeam.value.copy(getColor(c.colorSeam));
    u.uColorSeamCore.value.copy(getColor(c.colorSeamCore));
    u.uColorFront.value.copy(getColor(c.colorFront));
    u.uColorWither.value.copy(getColor(c.colorWither));

    u.uBarkScale.value = c.barkScale * g.noiseFrequency;
    u.uBarkContrast.value = c.barkContrast;
    u.uFibre.value = c.barkFibre;
    u.uFibreBands.value = c.barkFibreBands;
    u.uFibreScale.value = c.barkFibreScale;
    u.uSeamWidth.value = c.seamWidth;
    u.uSeamBands.value = c.seamBands;
    u.uSeamScale.value = c.seamScale * g.noiseFrequency;
    u.uSeamFlow.value = c.seamFlow * g.noiseSpeed;
    u.uSeamGlow.value = c.seamGlow * g.shaderIntensity;
    u.uSapPulse.value = c.sapPulse;
    u.uSapSpeed.value = c.sapSpeed * g.noiseSpeed;
    u.uSapWidth.value = c.sapWidth;
    u.uFrontGlow.value = c.frontGlow * g.shaderIntensity;
    u.uFrontWidth.value = c.frontWidth;
    u.uRimGlow.value = c.vineRim * g.fresnel;
    u.uRimPower.value = c.vineRimPower;
    u.uWitherRise.value = c.witherRise;
    u.uWitherScale.value = c.witherScale * g.noiseFrequency;
    u.uWitherEdge.value = c.witherEdge;
    u.uWitherEdgeGain.value = c.witherEdgeGlow * g.shaderIntensity;
    u.uGlow.value = c.vineGlow * g.glow;

    material.roughness = c.barkRoughness;
    material.envMapIntensity = c.barkEnv;
  };

  material.userData.sync();
  return material;
}

/* -------------------------------------------------------------------- */
/* the foliage                                                           */
/* -------------------------------------------------------------------- */

/**
 * A leaf, placed on the stem it belongs to.
 *
 * The blade's *outline* is in the geometry rather than in an alpha test, and
 * that is deliberate: a shaped silhouette antialiases with the rest of the
 * frame, needs no sorting, and — the part that actually matters here — casts a
 * shadow shaped like a leaf. A cut-out quad casts a shadow shaped like a quad
 * unless the depth pass repeats the test, and several hundred alpha-tested
 * shadow fragments is a real cost for an outline the geometry can simply have.
 */
const LEAF_VERTEX_DECL = /* glsl */ `
  attribute float aLeaf;
  uniform float uLeafStart;
  uniform float uLeafEnd;
  uniform float uLeafSize;
  uniform float uLeafSizeJitter;
  uniform float uLeafAspect;
  uniform float uLeafBias;
  uniform float uLeafPoint;
  uniform float uLeafPitch;
  uniform float uLeafPitchJitter;
  uniform float uLeafDroop;
  uniform float uLeafCup;
  uniform float uLeafOpen;
  uniform float uLeafFlutter;
  uniform float uLeafFlutterSpeed;

  varying vec3  vLeafWorld;
  varying vec3  vLeafNormal;
  varying vec2  vLeafUv;
  varying float vLeafSeed;
  varying float vLeafOpen;
  vec3 gPosition;
  vec3 gNormal;

  /** Half-width of the blade at u, in metres, for a leaf 'len' long. */
  float leafHalfWidth(float u, float len) {
    float shaped = pow(clamp(u, 0.0, 1.0), max(uLeafBias, 0.05));
    return len * uLeafAspect * pow(sin(shaped * GPI), max(uLeafPoint, 0.05));
  }

  /**
   * One point on one blade.
   *
   * Evaluated three times per vertex so the normal can be taken as a proper
   * cross product of the two surface derivatives — a leaf that is drooping,
   * cupped *and* fluttering has no normal worth guessing at, and a wrong one
   * on a lit material is instantly obvious as the light sweeps past.
   */
  vec3 leafPoint(float u, float v, vec3 base, vec3 axis, vec3 lateral, vec3 up, float len) {
    float halfWidth = leafHalfWidth(u, len);
    // The blade sags along its own length, and the sag is what separates
    // foliage from a fan of blades.
    float sag = uLeafDroop * len * u * u;
    vec3 p = base + axis * (len * u) - up * sag;
    p += lateral * (v * halfWidth);
    // ... and it channels across, edges above the midrib.
    p += up * (uLeafCup * halfWidth * v * v);
    return p;
  }

  void growthVertex() {
    float host = mod(aLeaf, max(uCount, 1.0));
    float d0 = hash11(aLeaf * 1.37 + uSeed * 2.11);
    float d1 = hash11(aLeaf * 2.71 + uSeed * 3.37);
    float d2 = hash11(aLeaf * 3.91 + uSeed * 5.93);
    float d3 = hash11(aLeaf * 5.13 + uSeed * 7.71);

    float t = mix(uLeafStart, uLeafEnd, d0);
    float grow = vineGrowth(host);

    // A leaf unfurls once the growth front has gone *past* where it is clipped
    // on — which is the whole reason the foliage reads as having grown out of
    // the stem rather than as having been dressed onto it afterwards.
    float open = smoothstep(t, t + max(uLeafOpen, 1e-3), grow);
    // And it curls up and drops as the nest withers, tip-first like the wood.
    open *= 1.0 - smoothstep(0.0, 1.0, clamp((uWither - (1.0 - t) * 0.55) * 2.2, 0.0, 1.0));
    vLeafOpen = open;

    vec3 anchor = vinePoint(host, t);
    vec3 tangent, n1, n2;
    vineFrame(host, t, anchor, tangent, n1, n2);

    float roll = d1 * GTAU;
    vec3 outward = n1 * cos(roll) + n2 * sin(roll);
    vec3 base = anchor + outward * vineRadius(host, t, grow) * 0.85;

    // The stalk leaves the stem sideways and forward: 'pitch' is how far it is
    // swung from square toward the tip of the tendril it grows on.
    float pitch = uLeafPitch + (d3 - 0.5) * uLeafPitchJitter;
    float flutter = sin(uTime * uLeafFlutterSpeed + d3 * GTAU) * uLeafFlutter;
    pitch += flutter;

    vec3 axis = normalize(outward * cos(pitch) + tangent * sin(pitch));
    vec3 lateral = cross(axis, outward);
    if (dot(lateral, lateral) < 1e-10) lateral = cross(axis, vec3(0.0, 1.0, 0.0));
    lateral = normalize(lateral);
    vec3 up = normalize(cross(lateral, axis));

    float len = uLeafSize * (1.0 - uLeafSizeJitter * 0.5 + uLeafSizeJitter * d2) * open;

    float u = position.x;
    float v = position.y;
    gPosition = leafPoint(u, v, base, axis, lateral, up, len);

    // Two neighbours, mirrored at the edges so the tip and the rim still have
    // something to look at.
    float du = u < 0.98 ? 0.02 : -0.02;
    float dv = v < 0.98 ? 0.02 : -0.02;
    vec3 pu = leafPoint(u + du, v, base, axis, lateral, up, len);
    vec3 pv = leafPoint(u, v + dv, base, axis, lateral, up, len);
    vec3 tu = (pu - gPosition) * sign(du);
    vec3 tv = (pv - gPosition) * sign(dv);
    gNormal = cross(tu, tv);
    gNormal = dot(gNormal, gNormal) > 1e-14 ? normalize(gNormal) : up;

    vLeafWorld = gPosition;
    vLeafNormal = gNormal;
    vLeafUv = vec2(u, v);
    vLeafSeed = d2;
  }
`;

const LEAF_FRAGMENT_DECL = /* glsl */ `
  uniform vec3  uColorLeaf;
  uniform vec3  uColorLeafTip;
  uniform vec3  uColorLeafDeep;
  uniform vec3  uColorVein;
  uniform float uVeinCount;
  uniform float uVeinWidth;
  uniform float uVeinSkew;
  uniform float uRibWidth;
  uniform float uVeinGlow;
  uniform float uLeafTranslucency;
  uniform float uLeafSheen;
  uniform float uLeafMottle;
  uniform float uGlow;
  uniform vec3  uLightDir;
  varying vec3  vLeafWorld;
  varying vec3  vLeafNormal;
  varying vec2  vLeafUv;
  varying float vLeafSeed;
  varying float vLeafOpen;
`;

/**
 * The blade: a green sheet that the light goes *through*.
 *
 * Two terms carry it. The venation is drawn in the leaf's own `(u, v)` space —
 * a midrib down the spine and laterals fanning off it — and it is emissive
 * rather than dark, because these are bioluminescent. And the translucency is a
 * plain wrap term against the stage's key direction: a leaf with the sun behind
 * it lights up from behind, and without that one line every leaf on the far
 * side of the nest is a black chip.
 */
function leafFragmentBody() {
  return /* glsl */ `
    {
      float u = clamp(vLeafUv.x, 0.0, 1.0);
      float v = vLeafUv.y;
      vec3  N = normalize(vLeafNormal);
      vec3  V = normalize(vViewPosition);

      /* ---- the blade ---- */
      float mottle = fbm3(vLeafWorld * 7.0 + vLeafSeed * 41.0) * 0.5 + 0.5;
      vec3 blade = mix(uColorLeafDeep, uColorLeaf, smoothstep(0.0, 0.55, u));
      blade = mix(blade, uColorLeafTip, smoothstep(0.55, 1.0, u));
      blade *= 1.0 + (mottle - 0.5) * uLeafMottle;
      diffuseColor.rgb *= blade;

      /* ---- the venation ---- */
      // The midrib runs the length of the blade and thins out with it.
      float rib = 1.0 - smoothstep(0.0, max(uRibWidth, 1e-3), abs(v));
      // The laterals fan: skewing the band coordinate by |v| is what tips them
      // away from square and toward the tip, which is what a leaf's veins do.
      float lat = abs(fract(u * uVeinCount + abs(v) * uVeinSkew) - 0.5) * 2.0;
      lat = 1.0 - smoothstep(0.0, max(uVeinWidth, 1e-3), lat);
      // Nothing runs off the edge of the blade or out past the tip.
      lat *= smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.82, 1.0, u));
      lat *= 1.0 - smoothstep(0.55, 0.95, abs(v));

      float veins = clamp(rib + lat * 0.8, 0.0, 1.5);

      /* ---- light through it ---- */
      // Wrapped rather than clamped: the sheet is thin, so what is behind it
      // reaches the camera. This is the whole of the subsurface read.
      float back = clamp(dot(-N, normalize(uLightDir)), 0.0, 1.0);
      float through = pow(back, 2.2) * uLeafTranslucency;
      // A little specular sheen off the cuticle, so a wet leaf catches the sky.
      float sheen = pow(clamp(dot(reflect(-V, N), normalize(uLightDir)), 0.0, 1.0), 24.0);

      vec3 glow = uColorVein * veins * uVeinGlow;
      glow += uColorLeafTip * through;
      glow += vec3(1.0) * sheen * uLeafSheen;
      glow *= uGlow * clamp(vLeafOpen, 0.0, 1.0);
      glow /= 1.0 + glow * 0.25;
      totalEmissiveRadiance += glow;
    }
  `;
}

/**
 * The foliage.
 *
 * @param {import('../world/Environment.js').Environment} environment
 * @param {object} shape the block from `createGrowthShape` — the *same object*
 *   the tendrils were given, which is what welds the leaves to the wood
 */
export function createLeafMaterial(environment, shape) {
  const uniforms = {
    ...shape,
    uLightDir: frame.uLightDir,

    uLeafStart: { value: 0.14 },
    uLeafEnd: { value: 0.97 },
    uLeafSize: { value: 0.42 },
    uLeafSizeJitter: { value: 0.6 },
    uLeafAspect: { value: 0.42 },
    uLeafBias: { value: 0.72 },
    uLeafPoint: { value: 0.78 },
    uLeafPitch: { value: 0.55 },
    uLeafPitchJitter: { value: 0.9 },
    uLeafDroop: { value: 0.34 },
    uLeafCup: { value: 0.22 },
    uLeafOpen: { value: 0.12 },
    uLeafFlutter: { value: 0.09 },
    uLeafFlutterSpeed: { value: 1.7 },

    uColorLeaf: { value: new Color() },
    uColorLeafTip: { value: new Color() },
    uColorLeafDeep: { value: new Color() },
    uColorVein: { value: new Color() },
    uVeinCount: { value: 7 },
    uVeinWidth: { value: 0.09 },
    uVeinSkew: { value: 0.55 },
    uRibWidth: { value: 0.09 },
    uVeinGlow: { value: 1.5 },
    uLeafTranslucency: { value: 1.1 },
    uLeafSheen: { value: 0.35 },
    uLeafMottle: { value: 0.3 },
    uGlow: { value: 1 }
  };

  const material = new MeshStandardMaterial({
    name: 'GrowthLeaf',
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0.0,
    // A leaf is a sheet: it has no inside, so both faces are the leaf and both
    // have to be lit.
    side: DoubleSide
  });

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${GROWTH_PATH}\n${LEAF_VERTEX_DECL}`)
      .replace('#include <beginnormal_vertex>', 'growthVertex();\nvec3 objectNormal = gNormal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = gPosition;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${LEAF_FRAGMENT_DECL}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         // A leaf that has not opened yet is a point, but a point is still a
         // fragment or two at the near plane. Cut them.
         if (vLeafOpen < 0.02) discard;`
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${leafFragmentBody()}`);
  });

  material.userData.uniforms = uniforms;
  material.userData.depth = createGrowthDepthMaterial(uniforms, LEAF_VERTEX_DECL, {
    name: 'leaf',
    fragmentDecl: 'varying float vLeafOpen;',
    cull: 'if (vLeafOpen < 0.02) discard;'
  });

  material.userData.sync = () => {
    const c = settings.growth;
    const g = settings.global;
    const u = uniforms;

    u.uLeafStart.value = c.leafStart;
    u.uLeafEnd.value = c.leafEnd;
    u.uLeafSize.value = c.leafSize;
    u.uLeafSizeJitter.value = c.leafSizeJitter * g.randomness;
    u.uLeafAspect.value = c.leafAspect;
    u.uLeafBias.value = c.leafBias;
    u.uLeafPoint.value = c.leafPoint;
    u.uLeafPitch.value = c.leafPitch;
    u.uLeafPitchJitter.value = c.leafPitchJitter * g.randomness;
    u.uLeafDroop.value = c.leafDroop;
    u.uLeafCup.value = c.leafCup;
    u.uLeafOpen.value = c.leafOpen;
    u.uLeafFlutter.value = c.leafFlutter;
    u.uLeafFlutterSpeed.value = c.leafFlutterSpeed * g.noiseSpeed;

    u.uColorLeaf.value.copy(getColor(c.colorLeaf));
    u.uColorLeafTip.value.copy(getColor(c.colorLeafTip));
    u.uColorLeafDeep.value.copy(getColor(c.colorLeafDeep));
    u.uColorVein.value.copy(getColor(c.colorLeafVein));
    u.uVeinCount.value = c.leafVeins;
    u.uVeinWidth.value = c.leafVeinWidth;
    u.uVeinSkew.value = c.leafVeinSkew;
    u.uRibWidth.value = c.leafRibWidth;
    u.uVeinGlow.value = c.leafVeinGlow * g.shaderIntensity;
    u.uLeafTranslucency.value = c.leafTranslucency;
    u.uLeafSheen.value = c.leafSheen;
    u.uLeafMottle.value = c.leafMottle * g.randomness;
    u.uGlow.value = c.leafGlow * g.glow;

    material.roughness = c.leafRoughness;
    material.envMapIntensity = c.leafEnv;
  };

  material.userData.sync();
  return material;
}

/* -------------------------------------------------------------------- */
/* the shadow                                                            */
/* -------------------------------------------------------------------- */

/**
 * The same vertex stage again, for the depth pass.
 *
 * Without this the shadow map is rendered from `position` as it sits in the
 * buffer — a flat sheet of parameter space stacked at the origin — and the
 * summon casts a shadow that belongs to nothing on screen. The colour pass and
 * this one share the uniform *boxes*, so there is no chance of the two
 * disagreeing about where a stem is: one write updates both.
 *
 * @param {object} uniforms the block the colour material was given
 * @param {string} vertexDecl its vertex stage
 * @param {object} options
 * @param {string} options.name distinguishes this depth shader from the other
 *   one built here. Both are installed by *this* function, so three cannot tell
 *   them apart from the patch's source text — see `patchOnBeforeCompile`.
 * @param {string} [options.fragmentDecl] uniforms, varyings and helpers the cull
 *   test needs — the depth stage shares nothing with the colour stage but the
 *   uniform boxes, so anything it reads has to be declared again here
 * @param {string} [options.cull] an extra fragment-side test, for geometry that
 *   is collapsed or burned away rather than absent
 */
function createGrowthDepthMaterial(uniforms, vertexDecl, { name, fragmentDecl = '', cull = '' } = {}) {
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

  patchOnBeforeCompile(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${GROWTH_PATH}\n${vertexDecl}`)
      .replace('#include <begin_vertex>', 'growthVertex();\nvec3 transformed = gPosition;');

    if (cull) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${fragmentDecl}`)
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>\n${cull}`
        );
    }
  }, `growth-depth:${name}`);

  return material;
}
