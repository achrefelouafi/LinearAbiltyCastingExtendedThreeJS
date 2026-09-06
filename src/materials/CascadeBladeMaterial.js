import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  ShaderMaterial,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms, frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * The core mesh burst — layer 3 of the breakdown sheet, and the thing the whole
 * ability is *for*.
 *
 * Four materials in one file because they are one object: the blades standing
 * in the crown, the blades in the air, the heart they converge on and the light
 * it throws behind them. The crown and the volley share the same cross-section,
 * the same taper, the same facets and the same shading function by *identity* —
 * one uniform block, handed to both — so a blade that leaves the crown is
 * unarguably the blade that was in it a frame earlier. That is the single most
 * important thing in the file. A thrown blade drawn by a second, similar shader
 * reads as a projectile the crown happened to spawn; this one reads as the
 * crown spending itself.
 *
 * ## Why these are lit materials
 *
 * Almost everything this project draws in the air is additive and unlit, which
 * is right for fire and lightning. A blade is neither. It is a solid with
 * facets, and the whole read of the reference sheet's third panel is *planes
 * catching light at different angles* — so the crown and the volley are
 * `MeshStandardMaterial` with their vertex stage replaced and their emissive
 * stage extended. The sun, the probe and the stage's shadows are three's; the
 * geometry and everything that glows are ours.
 *
 * `flatShading` is not a style choice. Three derives the normal from screen
 * derivatives under it, so every facet of the eight-sided section takes the key
 * light on its own and the silhouette breaks into planes — which is what
 * separates a crystal from a carrot at forty instances.
 *
 * Two consequences, both load-bearing:
 *
 *  - **the shadow pass needs the same vertex stage**, or the depth material
 *    rasterises the raw parameter grid — a metre-wide sheet at the origin. Both
 *    materials hand back a matching `MeshDepthMaterial` in `userData.depth`.
 *  - **the model matrix must stay identity.** The vertex stage writes *world*
 *    positions, so the ability's group and both meshes are left at the origin.
 *
 * @see CascadeGeometry.js for the buffers these run on.
 */

/* -------------------------------------------------------------------- */
/* the block every blade agrees through                                  */
/* -------------------------------------------------------------------- */

/**
 * The shape, the palette and the shading of a blade — shared by the crown, the
 * volley and both of their depth materials.
 *
 * One of these per cast. The ability writes it once a frame and four shaders
 * change together; nothing here is a metre until `syncCascadeBlades` resolves
 * it against the live settings.
 */
export function createCascadeBladeState() {
  return {
    uTime: frame.uTime,

    /** Where the crown hangs, world space. Also lights the blades nearest it. */
    uCentre: { value: new Vector3() },
    /** Master size of the crown, metres. */
    uScale: { value: 1 },
    uSeed: { value: 0 },
    /** 0..1 how wound up the heart is. Every glowing term rides it. */
    uCharge: { value: 0 },
    /** 1 while the mark stands, ramping to 0 as it goes. */
    uFade: { value: 1 },
    /** 0..1 through the collapse — the blades are eaten from the point down. */
    uCollapse: { value: 0 },
    /** The breath. */
    uPulse: { value: 0 },

    /* ---- the section: what makes it a blade and not a spindle ---- */
    uWaist: { value: 0.24 },
    uRootPower: { value: 0.62 },
    uTipPower: { value: 0.85 },
    uWidth: { value: 0.115 },
    uThick: { value: 0.42 },
    uEdge: { value: 0.75 },
    uBow: { value: 0.045 },
    uTwist: { value: 0.35 },

    /* ---- the look ---- */
    uColorBody: { value: new Color() },
    uColorFacet: { value: new Color() },
    uColorBodyDeep: { value: new Color() },
    uColorFacetDeep: { value: new Color() },
    uColorEdge: { value: new Color() },
    uColorVein: { value: new Color() },
    uColorHot: { value: new Color() },
    uColorHeart: { value: new Color() },

    uEdgeGlow: { value: 2.6 },
    uEdgePower: { value: 5.0 },
    uRim: { value: 1.1 },
    uRimPower: { value: 2.6 },
    uTipGlow: { value: 1.4 },
    uTipStart: { value: 0.55 },
    uVein: { value: 0.9 },
    uVeinScale: { value: 5.5 },
    uVeinBands: { value: 3.0 },
    uVeinSharp: { value: 3.4 },
    uHeartBleed: { value: 1.5 },
    uHeartReach: { value: 2.4 },
    uChargeGain: { value: 1.8 },
    uBurnGlow: { value: 4.0 },
    uGlow: { value: 1 }
  };
}

/**
 * Resolve the shared block against `settings.cascade`.
 *
 * @param {object} state the block from `createCascadeBladeState`
 */
export function syncCascadeBlades(state) {
  const c = settings.cascade;
  const g = settings.global;

  state.uWaist.value = c.bladeWaist;
  state.uRootPower.value = c.bladeRootPower;
  state.uTipPower.value = c.bladeTipPower;
  state.uWidth.value = c.bladeWidth;
  state.uThick.value = c.bladeThick;
  state.uEdge.value = c.bladeEdge;
  state.uBow.value = c.bladeBow;
  state.uTwist.value = c.bladeTwist;

  state.uColorBody.value.copy(getColor(c.colorBladeBody));
  state.uColorFacet.value.copy(getColor(c.colorBladeFacet));
  state.uColorBodyDeep.value.copy(getColor(c.colorBladeBodyDeep));
  state.uColorFacetDeep.value.copy(getColor(c.colorBladeFacetDeep));
  state.uColorEdge.value.copy(getColor(c.colorBladeEdge));
  state.uColorVein.value.copy(getColor(c.colorBladeVein));
  state.uColorHot.value.copy(getColor(c.colorBladeHot));
  state.uColorHeart.value.copy(getColor(c.colorHeart));

  state.uEdgeGlow.value = c.bladeEdgeGlow * g.shaderIntensity;
  state.uEdgePower.value = c.bladeEdgePower;
  state.uRim.value = c.bladeRim * g.fresnel;
  state.uRimPower.value = c.bladeRimPower;
  state.uTipGlow.value = c.bladeTipGlow * g.shaderIntensity;
  state.uTipStart.value = c.bladeTipStart;
  state.uVein.value = c.bladeVein * g.shaderIntensity;
  state.uVeinScale.value = c.bladeVeinScale * g.noiseFrequency;
  state.uVeinBands.value = c.bladeVeinBands;
  state.uVeinSharp.value = c.bladeVeinSharp;
  state.uHeartBleed.value = c.bladeHeartBleed;
  state.uHeartReach.value = c.bladeHeartReach;
  state.uChargeGain.value = c.bladeChargeGain;
  state.uBurnGlow.value = c.bladeBurnGlow * g.shaderIntensity;
  state.uGlow.value = c.bladeGlow * g.glow;
}

/* -------------------------------------------------------------------- */
/* the shape                                                             */
/* -------------------------------------------------------------------- */

/**
 * The blade itself: its taper, its cross-section and the frame it is built in.
 *
 * Injected into four vertex shaders (two colour, two depth). Everything is
 * analytic and everything is a function of the parameter pair, so the blade in
 * the crown and the blade fifteen metres away going through somebody are the
 * same nine lines of arithmetic with a different root and a different heading.
 */
const BLADE_SHAPE = /* glsl */ `
#ifndef CASCADE_BLADE_SHAPE
#define CASCADE_BLADE_SHAPE

#define CTAU 6.283185307179586
#define CPI  3.141592653589793

uniform float uWaist;
uniform float uRootPower;
uniform float uTipPower;
uniform float uWidth;
uniform float uThick;
uniform float uEdge;
uniform float uBow;
uniform float uTwist;

/**
 * Half-width at t, as a fraction of the blade's length.
 *
 * Two powers meeting at the waist: a fast swell off the root and a long draw
 * out to the point. Both ends reach exactly zero, so the blade closes on a
 * genuine point at either end rather than on a flat cap the camera can catch.
 */
float bladeWidth(float t) {
  float waist = clamp(uWaist, 0.02, 0.95);
  float rise = pow(clamp(t / waist, 0.0, 1.0), max(uRootPower, 0.05));
  float fall = pow(clamp((1.0 - t) / (1.0 - waist), 0.0, 1.0), max(uTipPower, 0.05));
  return rise * fall;
}

/**
 * The cross-section, in the (n1, n2) plane of the blade's own frame.
 *
 * A lens, not a circle. The thickness is pinched to nothing at the two angles
 * where the width is greatest, so what comes out has a sharp edge down each
 * side and a spine ridge along each face — and a view straight down the edge
 * shows a line rather than a tube.
 */
vec2 bladeSection(float a) {
  float ang = a * CTAU;
  float x = cos(ang);
  float y = sin(ang);
  float pinch = pow(1.0 - abs(x), max(uEdge, 0.05));
  return vec2(x, y * clamp(uThick, 0.02, 4.0) * pinch);
}

/** A stable pair of axes across the heading, rolled by the blade's own dice. */
void bladeFrame(vec3 axis, float roll, out vec3 n1, out vec3 n2) {
  vec3 guide = abs(axis.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 e1 = normalize(cross(axis, guide));
  vec3 e2 = cross(axis, e1);
  float cr = cos(roll);
  float sr = sin(roll);
  n1 = e1 * cr + e2 * sr;
  n2 = e2 * cr - e1 * sr;
}

/**
 * One vertex of a blade rooted at root, pointing along axis, len metres long.
 *
 * The twist is applied to the section frame only and the bow to the spine only,
 * so a blade can wind about itself without its curve winding with it.
 */
vec3 bladeVertex(vec3 root, vec3 axis, float roll, float len, float t, float a, out vec3 nrm) {
  vec3 b1, b2;
  bladeFrame(axis, roll, b1, b2);

  float tw = t * uTwist;
  float ct = cos(tw);
  float st = sin(tw);
  vec3 n1 = b1 * ct + b2 * st;
  vec3 n2 = b2 * ct - b1 * st;

  vec3 spine = root + axis * (t * len) + b1 * (sin(t * CPI) * uBow * len);
  float w = bladeWidth(t) * uWidth * len;

  vec2 s0 = bladeSection(a);
  vec2 s1 = bladeSection(a + 0.008);
  vec2 tangent = s1 - s0;
  vec2 flatN = normalize(vec2(tangent.y, -tangent.x) + 1e-6);
  nrm = normalize(n1 * flatN.x + n2 * flatN.y);

  return spine + (n1 * s0.x + n2 * s0.y) * w;
}

#endif
`;

/* -------------------------------------------------------------------- */
/* the look                                                              */
/* -------------------------------------------------------------------- */

/** Fragment-side declarations shared by the crown and the volley. */
const BLADE_LOOK = /* glsl */ `
  uniform float uTime;
  uniform vec3  uCentre;
  uniform float uCharge;
  uniform float uFade;
  uniform float uCollapse;
  uniform float uPulse;

  uniform vec3  uColorBody;
  uniform vec3  uColorFacet;
  uniform vec3  uColorBodyDeep;
  uniform vec3  uColorFacetDeep;
  uniform vec3  uColorEdge;
  uniform vec3  uColorVein;
  uniform vec3  uColorHot;
  uniform vec3  uColorHeart;

  uniform float uEdgeGlow;
  uniform float uEdgePower;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uTipGlow;
  uniform float uTipStart;
  uniform float uVein;
  uniform float uVeinScale;
  uniform float uVeinBands;
  uniform float uVeinSharp;
  uniform float uHeartBleed;
  uniform float uHeartReach;
  uniform float uChargeGain;
  uniform float uBurnGlow;
  uniform float uGlow;

  varying vec3  vBladeWorld;
  varying float vBladeT;
  varying float vBladeA;
  varying float vBladeSeed;
  varying float vBladeTone;
  varying float vBladeHeat;

  /**
   * Everything a blade emits, from the resolved face normal.
   *
   * Written once and called from both materials. The body colour comes back in
   * tint (a multiplier on the albedo) and the return value is what goes into
   * the emissive — so the two passes cannot drift apart, however differently
   * they are placed.
   *
   * @param burn 0..1 nothing, → 1 on the line the blade is being eaten back to
   */
  vec3 bladeGlow(vec3 N, float burn, out vec3 tint) {
    float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
    float rim = pow(1.0 - ndv, max(uRimPower, 0.05));

    /* --- the body: two stones dealt across the crown ------------------ */
    vec3 body  = mix(uColorBody,  uColorBodyDeep,  vBladeTone);
    vec3 facet = mix(uColorFacet, uColorFacetDeep, vBladeTone);
    tint = mix(body, facet, ndv * 0.85);

    /* --- the two sharp edges ------------------------------------------ */
    // The section's width axis is where the blade closes to a line, so the
    // edge term is the same cosine the geometry was built on. It is what draws
    // the silhouette against a dark stage, and the reason the crown reads as
    // cut glass rather than as a pile of cones.
    float edge = pow(abs(cos(vBladeA * CTAU)), max(uEdgePower, 0.5));
    edge *= smoothstep(0.02, 0.2, vBladeT);

    /* --- the flaws the mark runs in ----------------------------------- */
    // Blade-local, so the veins belong to this blade and turn with it rather
    // than sliding through a field pinned to the world.
    vec3 vp = vec3(vBladeT * uVeinScale, vBladeA * uVeinBands, vBladeSeed * 13.0);
    float vein = pow(clamp(ridged(vp, 4), 0.0, 1.0), max(uVeinSharp, 0.2));
    vein *= smoothstep(0.05, 0.4, vBladeT);

    /* --- lit by the heart it grew out of ------------------------------ */
    // N arrives in view space (three resolves it there), so the direction to
    // the heart is taken into view space too rather than dotted across two
    // frames — the difference is a highlight that tracks the camera instead of
    // the burst, and it is visible the moment the rig orbits.
    vec3 toHeart = uCentre - vBladeWorld;
    float reach = 1.0 - smoothstep(0.0, max(uHeartReach, 0.05), length(toHeart));
    vec3 heartView = (viewMatrix * vec4(toHeart, 0.0)).xyz;
    float facing = clamp(dot(N, normalize(heartView + 1e-4)), 0.0, 1.0);
    float heart = reach * reach * (0.25 + 0.75 * facing);

    /* --- the point ---------------------------------------------------- */
    float tip = smoothstep(clamp(uTipStart, 0.0, 0.98), 1.0, vBladeT);

    float wound = 1.0 + uCharge * uChargeGain + uPulse * 0.35 + vBladeHeat;

    vec3 glow = uColorEdge * edge * uEdgeGlow;
    glow += uColorEdge * rim * uRim;
    glow += uColorVein * vein * uVein;
    glow += uColorHeart * heart * uHeartBleed;
    glow += uColorHot * tip * uTipGlow;
    glow *= wound;
    glow += uColorHot * burn * uBurnGlow;
    glow *= uGlow * uFade;

    // Soft ceiling, and it has to be a hard one. Every term above peaks
    // somewhere on the silhouette and they stack: unrolled, a facet turned
    // edge-on sums past ten, the blade goes white, and the whole burst is a
    // star-shaped hole in the frame wearing the bloom pass. What the reference
    // sheet actually shows is a *dark* blade with a lit edge, so the ceiling is
    // set where a blade can still take the sun on its facets and only the edge
    // is allowed to run away.
    return glow / (1.0 + glow * 1.6);
  }
`;

/* -------------------------------------------------------------------- */
/* layer 3a — the crown                                                  */
/* -------------------------------------------------------------------- */

/**
 * The crown's vertex stage.
 *
 * Written into globals rather than straight into `transformed`, because three
 * resolves the normal before the position and both come out of one evaluation.
 */
const CROWN_VERTEX_DECL = /* glsl */ `
  attribute vec3 aDir;
  attribute vec4 aShape;

  uniform vec3  uCentre;
  uniform float uInner;
  uniform float uPulse;
  uniform float uSwell;
  uniform float uCollapse;

  varying vec3  vBladeWorld;
  varying float vBladeT;
  varying float vBladeA;
  varying float vBladeSeed;
  varying float vBladeTone;
  varying float vBladeHeat;
  varying float vBladeLive;

  vec3 gPosition;
  vec3 gNormal;

  void cascadeVertex() {
    float len   = aShape.x;
    float roll  = aShape.y;
    float live  = clamp(aShape.z, 0.0, 1.0);
    float tone  = aShape.w;

    vec3 axis = normalize(aDir + vec3(0.0, 1e-5, 0.0));

    // A blade extends out of the heart rather than fading in, and it keeps
    // every one of its samples while it does — the whole buffer compresses into
    // however much of it has grown.
    float reach = len * live;
    // The seat breathes, so the crown opens and closes on the mark's pulse
    // instead of hanging at a fixed radius.
    float seat = uInner * (1.0 + uPulse * uSwell) * mix(1.0, 0.55, clamp(uCollapse, 0.0, 1.0));
    vec3 root = uCentre + axis * seat;

    float t = position.x;
    gPosition = bladeVertex(root, axis, roll, reach, t, position.y, gNormal);

    vBladeWorld = gPosition;
    vBladeT = t;
    vBladeA = position.y;
    vBladeSeed = fract(roll * 0.15915494 + tone * 3.7);
    vBladeTone = tone;
    vBladeHeat = 0.0;
    vBladeLive = live;
  }
`;

/** The crown's own fragment terms, on top of the shared look. */
const CROWN_FRAGMENT_DECL = /* glsl */ `
  varying float vBladeLive;
`;

/**
 * How a blade is eaten back as the mark collapses.
 *
 * From the point down rather than from the root up: a crown that dissolves at
 * its roots leaves forty splinters hanging in the air with nothing holding
 * them, while one eaten from the tips is visibly being drawn back into the
 * thing that made it. Shared with the depth pass, or a blade half gone goes on
 * laying a whole shadow.
 */
const CROWN_CULL = /* glsl */ `
  float cascadeCrownCull(float t, float collapse, out float burn) {
    float line = 1.0 - clamp(collapse, 0.0, 1.0) * 1.06;
    burn = (1.0 - smoothstep(0.0, 0.09, line - t)) * step(0.001, collapse);
    return line - t;
  }
`;

/**
 * The crown of blades.
 *
 * @param {import('../world/Environment.js').Environment} environment
 * @param {object} state the block from `createCascadeBladeState`
 * @returns {THREE.MeshStandardMaterial} with `userData.depth` — the matching
 *   depth material the mesh must be given as its `customDepthMaterial`.
 */
export function createCascadeCrownMaterial(environment, state) {
  const own = {
    uInner: { value: 0.28 },
    uSwell: { value: 0.12 }
  };
  const uniforms = { ...state, ...own };

  const material = new MeshStandardMaterial({
    name: 'CascadeCrown',
    color: 0xffffff,
    roughness: 0.24,
    metalness: 0.15,
    flatShading: true,
    // The section closes to a line at both edges, so the far wall is what the
    // camera sees through the near one wherever a blade is turned edge-on.
    side: DoubleSide
  });

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BLADE_SHAPE}\n${CROWN_VERTEX_DECL}`)
      .replace('#include <beginnormal_vertex>', 'cascadeVertex();\nvec3 objectNormal = gNormal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = gPosition;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${noiseGLSL}\n#define CTAU 6.283185307179586\n${BLADE_LOOK}\n${CROWN_FRAGMENT_DECL}\n${CROWN_CULL}`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         if (vBladeLive < 0.004) discard;
         float cascadeBurn;
         if (cascadeCrownCull(vBladeT, uCollapse, cascadeBurn) < 0.0) discard;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3 tint;
           vec3 glow = bladeGlow(normalize(normal), cascadeBurn, tint);
           diffuseColor.rgb *= tint;
           totalEmissiveRadiance += glow;
         }`
      );
  });

  material.userData.uniforms = uniforms;
  material.userData.depth = createCascadeDepthMaterial(uniforms, CROWN_VERTEX_DECL, BLADE_SHAPE, {
    name: 'crown',
    fragmentDecl: /* glsl */ `
      uniform float uCollapse;
      varying float vBladeT;
      varying float vBladeLive;
      ${CROWN_CULL}
    `,
    cull: `if (vBladeLive < 0.004) discard;
           float cascadeBurn;
           if (cascadeCrownCull(vBladeT, uCollapse, cascadeBurn) < 0.0) discard;`
  });

  material.userData.sync = () => {
    const c = settings.cascade;
    own.uInner.value = Math.max(0.01, c.crownInner * Math.max(0.01, c.crownScale));
    own.uSwell.value = c.crownSwell;
    material.roughness = c.bladeRoughness;
    material.metalness = c.bladeMetalness;
    material.envMapIntensity = c.bladeEnv;
  };

  material.userData.sync();
  return material;
}

/* -------------------------------------------------------------------- */
/* layer 3b — the blades in the air                                      */
/* -------------------------------------------------------------------- */

/**
 * The volley's vertex stage.
 *
 * The path is a quadratic through a control point pushed off the line, so a
 * flurry fans out and converges rather than arriving as a bundle of parallel
 * rods — and the blade is aligned to the *tangent* of that curve, so it is
 * always pointing where it is actually going. Past the strike it keeps going:
 * a blade that stops inside a body is a spear, and this one goes through.
 */
const VOLLEY_VERTEX_DECL = /* glsl */ `
  attribute vec3 aFrom;
  attribute vec3 aTo;
  attribute vec4 aState;

  uniform float uStrike;
  uniform float uHold;
  uniform float uOverrun;
  uniform float uCurve;
  uniform float uLoft;
  uniform float uLength;
  uniform float uSmear;
  uniform float uSpinRate;
  uniform float uHeat;
  uniform float uFlare;

  varying vec3  vBladeWorld;
  varying float vBladeT;
  varying float vBladeA;
  varying float vBladeSeed;
  varying float vBladeTone;
  varying float vBladeHeat;
  varying float vBladeLive;
  varying float vBladeSpend;

  vec3 gPosition;
  vec3 gNormal;

  vec3 volleyPath(vec3 a, vec3 b, vec3 ctrl, float q) {
    float m = 1.0 - q;
    return m * m * a + 2.0 * m * q * ctrl + q * q * b;
  }

  void cascadeVertex() {
    float life  = aState.x;
    float seed  = aState.y;
    float curve = aState.z;
    float live  = aState.w;

    vec3 delta = aTo - aFrom;
    float span = max(length(delta), 0.05);
    vec3 dir = delta / span;
    vec3 side = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
    vec3 lift = cross(side, dir);
    vec3 ctrl = mix(aFrom, aTo, 0.5) + side * (curve * uCurve * span) + lift * (uLoft * span);

    // Arrival: eased so it *lands* rather than stopping dead, and the frame it
    // reaches 1.0 is the frame the ability parts the body (see _stepVolley).
    float q = clamp(life / max(uStrike, 1e-3), 0.0, 1.0);
    q = 1.0 - pow(1.0 - q, 2.4);

    vec3 here = volleyPath(aFrom, aTo, ctrl, q);
    vec3 ahead = volleyPath(aFrom, aTo, ctrl, min(q + 0.02, 1.0));
    vec3 behind = volleyPath(aFrom, aTo, ctrl, max(q - 0.02, 0.0));
    vec3 axis = normalize(ahead - behind + dir * 1e-4);

    // ... and out the other side. The overrun is what makes it a cut rather
    // than an impalement, and it is why the two halves are already parting by
    // the time the blade is clear of them.
    float past = clamp((life - uStrike) / max(1.0 - uStrike, 1e-3), 0.0, 1.0);
    here += axis * (past * uOverrun);

    // Longer while it is fast: a smear the geometry does itself, so it survives
    // a paused frame where a post-process motion blur would not.
    float len = uLength * (1.0 + uSmear * (1.0 - clamp(life / max(uStrike, 1e-3), 0.0, 1.0)));
    float spend = clamp((life - uHold) / max(1.0 - uHold, 1e-3), 0.0, 1.0);
    len *= mix(1.0, 0.72, spend);

    float roll = seed * 17.0 + life * uSpinRate * CTAU;
    // Rooted *behind* the path point, so the point of the blade is the thing
    // that arrives and the body is cut on the frame it does.
    vec3 root = here - axis * len;

    float t = position.x;
    gPosition = bladeVertex(root, axis, roll, len * live, t, position.y, gNormal);

    vBladeWorld = gPosition;
    vBladeT = t;
    vBladeA = position.y;
    vBladeSeed = seed;
    vBladeTone = fract(seed * 2.7);
    // Hot the whole way and incandescent for the two frames it is going
    // through something.
    vBladeHeat = uHeat + uFlare * exp(-pow((life - uStrike) / 0.07, 2.0));
    vBladeLive = live;
    vBladeSpend = spend;
  }
`;

const VOLLEY_FRAGMENT_DECL = /* glsl */ `
  varying float vBladeLive;
  varying float vBladeSpend;
`;

/**
 * How a thrown blade goes.
 *
 * Eaten from the root forward, which is the opposite end to the crown's
 * collapse and the right one here: what is left last is the point, still
 * travelling, and the blade reads as spending itself into the cut rather than
 * as a prop being switched off.
 */
const VOLLEY_CULL = /* glsl */ `
  float cascadeVolleyCull(float t, float spend, out float burn) {
    burn = (1.0 - smoothstep(0.0, 0.12, t - spend)) * step(0.001, spend);
    return t - spend;
  }
`;

/**
 * The blades in the air.
 *
 * @param {import('../world/Environment.js').Environment} environment
 * @param {object} state the block from `createCascadeBladeState`
 */
export function createCascadeVolleyMaterial(environment, state) {
  const own = {
    uStrike: { value: 0.34 },
    uHold: { value: 0.5 },
    uOverrun: { value: 2.2 },
    uCurve: { value: 0.22 },
    uLoft: { value: 0.06 },
    uLength: { value: 1.1 },
    uSmear: { value: 0.55 },
    uSpinRate: { value: 1.6 },
    uHeat: { value: 0.9 },
    uFlare: { value: 2.6 }
  };
  const uniforms = { ...state, ...own };

  const material = new MeshStandardMaterial({
    name: 'CascadeVolley',
    color: 0xffffff,
    roughness: 0.2,
    metalness: 0.1,
    flatShading: true,
    side: DoubleSide
  });

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BLADE_SHAPE}\n${VOLLEY_VERTEX_DECL}`)
      .replace('#include <beginnormal_vertex>', 'cascadeVertex();\nvec3 objectNormal = gNormal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = gPosition;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${noiseGLSL}\n#define CTAU 6.283185307179586\n${BLADE_LOOK}\n${VOLLEY_FRAGMENT_DECL}\n${VOLLEY_CULL}`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         if (vBladeLive < 0.5) discard;
         float cascadeBurn;
         if (cascadeVolleyCull(vBladeT, vBladeSpend, cascadeBurn) < 0.0) discard;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3 tint;
           vec3 glow = bladeGlow(normalize(normal), cascadeBurn, tint);
           diffuseColor.rgb *= tint;
           totalEmissiveRadiance += glow;
         }`
      );
  });

  material.userData.uniforms = uniforms;
  material.userData.depth = createCascadeDepthMaterial(uniforms, VOLLEY_VERTEX_DECL, BLADE_SHAPE, {
    name: 'volley',
    fragmentDecl: /* glsl */ `
      varying float vBladeT;
      varying float vBladeLive;
      varying float vBladeSpend;
      ${VOLLEY_CULL}
    `,
    cull: `if (vBladeLive < 0.5) discard;
           float cascadeBurn;
           if (cascadeVolleyCull(vBladeT, vBladeSpend, cascadeBurn) < 0.0) discard;`
  });

  material.userData.sync = () => {
    const c = settings.cascade;
    const g = settings.global;

    own.uStrike.value = c.throwStrike;
    own.uHold.value = c.throwHold;
    own.uOverrun.value = c.throwOverrun;
    own.uCurve.value = c.throwCurve;
    own.uLoft.value = c.throwLoft;
    own.uLength.value = c.throwLength;
    own.uSmear.value = c.throwSmear;
    own.uSpinRate.value = c.throwSpin;
    own.uHeat.value = c.throwHeat * g.shaderIntensity;
    own.uFlare.value = c.throwFlare * g.shaderIntensity;

    material.roughness = c.bladeRoughness * 0.8;
    material.metalness = c.bladeMetalness;
    material.envMapIntensity = c.bladeEnv;
  };

  material.userData.sync();
  return material;
}

/* -------------------------------------------------------------------- */
/* the shadow pass                                                       */
/* -------------------------------------------------------------------- */

/**
 * A depth material running the same vertex stage as the colour one.
 *
 * It shares the uniform *boxes*, so the two cannot disagree about where a blade
 * is: one write updates both. Both depth materials are installed by this one
 * function, so three cannot tell their shaders apart from the patch's source
 * text — hence the explicit key (see `utils/shaderPatch.js`).
 */
function createCascadeDepthMaterial(uniforms, vertexDecl, shape, { name, fragmentDecl = '', cull = '' } = {}) {
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${shape}\n${vertexDecl}`)
        .replace('#include <begin_vertex>', 'cascadeVertex();\nvec3 transformed = gPosition;');

      if (cull) {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${fragmentDecl}`)
          .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${cull}`);
      }
    },
    `cascade-depth:${name}`
  );

  return material;
}

/* -------------------------------------------------------------------- */
/* layer 3c — the heart                                                  */
/* -------------------------------------------------------------------- */

const HEART_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uBoil;
  uniform float uBoilScale;
  uniform float uCharge;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;
  varying float vDisp;

  ${noiseGLSL}

  void main() {
    vec3 n = normalize(normal);
    // The silhouette churns rather than sitting still: a sphere with a clean
    // outline at this size reads as a bead, and what the panel wants is
    // something with pressure in it.
    float d = snoise(n * uBoilScale + vec3(0.0, uTime * 0.7, uSeed * 5.0));
    vec3 here = position * (1.0 + d * uBoil * (1.0 + uCharge * 0.6));

    vec4 world = modelMatrix * vec4(here, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * n);
    vViewDir = normalize(cameraPosition - world.xyz);
    vDisp = d;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const HEART_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uCharge;
  uniform float uFade;
  uniform float uPulse;
  uniform float uFill;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uFilament;
  uniform float uFilamentScale;
  uniform float uFilamentSpeed;
  uniform float uIntensity;
  uniform float uChargeGain;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorMid;
  uniform vec3  uColorEdge;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;
  varying float vDisp;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float ndv = clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0);
    // Weighted toward the axis: the path a view ray takes through a shell is
    // longest looking straight at the middle, so that is where the white goes.
    float core = pow(ndv, max(uFill, 0.05));
    float rim = pow(1.0 - ndv, max(uRimPower, 0.05)) * uRim;

    vec3 fp = vNormalW * uFilamentScale + vec3(0.0, uTime * uFilamentSpeed, uSeed * 9.0);
    float threads = pow(clamp(ridged(fp, 4), 0.0, 1.0), 3.0) * uFilament;

    float wound = 1.0 + uCharge * uChargeGain + uPulse * 0.3;
    float energy = (core + rim + threads) * wound;

    vec3 color = mix(uColorEdge, uColorMid, clamp(core * 1.4, 0.0, 1.0));
    color = mix(color, uColorCore, clamp(pow(core, 2.2) + uCharge * 0.4, 0.0, 1.0));
    color *= energy * uIntensity * uFade;

    float alpha = clamp(energy * 0.85, 0.0, 1.0) * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    color /= 1.0 + color * 0.1;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The heart the blades converge on.
 *
 * The one part of this layer that is not matter, so it is the one part drawn
 * additively. It is also the reason the crown reads as a single object: the
 * blades are lit *from it* (see `bladeGlow`), so the nearest facets carry a
 * highlight coming from the middle of the burst rather than only from the
 * stage's sun. A lamp parked in a pile of rocks is what that term buys off.
 */
export function createCascadeHeartMaterial(state) {
  const material = new ShaderMaterial({
    name: 'CascadeHeart',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: state.uSeed,
      uCharge: state.uCharge,
      uFade: state.uFade,
      uPulse: state.uPulse,
      uBoil: { value: 0.14 },
      uBoilScale: { value: 2.4 },
      uFill: { value: 1.6 },
      uRim: { value: 0.9 },
      uRimPower: { value: 2.2 },
      uFilament: { value: 1.0 },
      uFilamentScale: { value: 4.2 },
      uFilamentSpeed: { value: 0.6 },
      uIntensity: { value: 1.5 },
      uChargeGain: { value: 2.6 },
      uSoftFade: { value: 0.4 },
      uColorCore: { value: new Color() },
      uColorMid: { value: new Color() },
      uColorEdge: { value: new Color() }
    }),
    vertexShader: HEART_VERTEX,
    fragmentShader: HEART_FRAGMENT
  });

  material.userData.sync = () => {
    const c = settings.cascade;
    const g = settings.global;
    const u = material.uniforms;

    u.uBoil.value = c.heartBoil * g.noiseStrength;
    u.uBoilScale.value = c.heartBoilScale * g.noiseFrequency;
    u.uFill.value = c.heartFill;
    u.uRim.value = c.heartRim * g.fresnel;
    u.uRimPower.value = c.heartRimPower;
    u.uFilament.value = c.heartFilament * g.shaderIntensity;
    u.uFilamentScale.value = c.heartFilamentScale * g.noiseFrequency;
    u.uFilamentSpeed.value = c.heartFilamentSpeed * g.noiseSpeed;
    u.uIntensity.value = c.heartIntensity * g.shaderIntensity * g.glow;
    u.uChargeGain.value = c.heartChargeGain;
    u.uSoftFade.value = c.heartSoftFade;

    u.uColorCore.value.copy(getColor(c.colorHeartCore));
    u.uColorMid.value.copy(getColor(c.colorHeart));
    u.uColorEdge.value.copy(getColor(c.colorHeartEdge));
  };

  return material;
}

/* -------------------------------------------------------------------- */
/* layer 3d — the halo                                                   */
/* -------------------------------------------------------------------- */

const HALO_VERTEX = /* glsl */ `
  uniform float uSize;
  varying vec2 vUv;

  void main() {
    vUv = position.xy;
    // Billboarded in view space: the quad's own orientation is thrown away and
    // the corners are offset in the camera's plane, so the halo faces the lens
    // from any angle without the ability having to aim it.
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uSize;
    gl_Position = projectionMatrix * mv;
  }
`;

const HALO_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uCharge;
  uniform float uFade;
  uniform float uPulse;
  uniform float uGlow;
  uniform float uFalloff;
  uniform float uRays;
  uniform float uRayCount;
  uniform float uRaySharp;
  uniform float uRaySpin;
  uniform float uRingSeat;
  uniform float uRingWidth;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}

  #define HTAU 6.283185307179586

  void main() {
    float r = length(vUv) * 2.0;
    if (r > 1.0) discard;

    float body = pow(clamp(1.0 - r, 0.0, 1.0), max(uFalloff, 0.05));

    // Spokes combed out of the burst. Not evenly bright: a hash per spoke keeps
    // the fan from reading as a machined gear.
    float ang = atan(vUv.y, vUv.x) / HTAU + uTime * uRaySpin;
    float cell = ang * max(uRayCount, 1.0);
    float spoke = abs(fract(cell) - 0.5) * 2.0;
    spoke = pow(clamp(1.0 - spoke, 0.0, 1.0), max(uRaySharp, 0.5));
    spoke *= 0.55 + 0.45 * hash11(floor(cell) + uSeed * 3.0);
    spoke *= smoothstep(1.0, 0.25, r) * smoothstep(0.0, 0.16, r) * uRays;

    float ring = 1.0 - smoothstep(0.0, max(uRingWidth, 1e-3), abs(r - clamp(uRingSeat, 0.05, 0.98)));

    float energy = (body + spoke + ring * 0.7) * (1.0 + uCharge * 1.1 + uPulse * 0.4);
    vec3 color = mix(uColorOuter, uColorInner, clamp(body * 1.6 + spoke, 0.0, 1.0));
    color *= energy * uGlow * uFade;

    float alpha = clamp(energy, 0.0, 1.0) * uFade;
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    color /= 1.0 + color * 0.14;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The light the burst throws onto the air behind it.
 *
 * Drawn under the heart and under the blades, because it is the air and not the
 * charge. Its whole job is to stop the crown reading as forty separate objects:
 * a single soft disc behind them ties the silhouette together and gives the
 * bloom pass something to spread that is not a facet.
 */
export function createCascadeHaloMaterial(state) {
  const material = new ShaderMaterial({
    name: 'CascadeHalo',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: state.uSeed,
      uCharge: state.uCharge,
      uFade: state.uFade,
      uPulse: state.uPulse,
      uSize: { value: 2 },
      uGlow: { value: 0.5 },
      uFalloff: { value: 2.6 },
      uRays: { value: 0.3 },
      uRayCount: { value: 16 },
      uRaySharp: { value: 6 },
      uRaySpin: { value: 0.02 },
      uRingSeat: { value: 0.62 },
      uRingWidth: { value: 0.05 },
      uColorInner: { value: new Color() },
      uColorOuter: { value: new Color() }
    }),
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT
  });

  /** @param {number} size radius in metres — the ability resolves it per frame */
  material.userData.sync = (size) => {
    const c = settings.cascade;
    const g = settings.global;
    const u = material.uniforms;

    u.uSize.value = size;
    u.uGlow.value = c.haloGlow * g.glow;
    u.uFalloff.value = c.haloFalloff;
    u.uRays.value = c.haloRays * g.shaderIntensity;
    u.uRayCount.value = Math.max(1, Math.round(c.haloRayCount));
    u.uRaySharp.value = c.haloRaySharp;
    u.uRaySpin.value = c.haloRaySpin;
    u.uRingSeat.value = c.haloRingSeat;
    u.uRingWidth.value = c.haloRingWidth;

    u.uColorInner.value.copy(getColor(c.colorHaloInner));
    u.uColorOuter.value.copy(getColor(c.colorHaloOuter));
  };

  return material;
}
