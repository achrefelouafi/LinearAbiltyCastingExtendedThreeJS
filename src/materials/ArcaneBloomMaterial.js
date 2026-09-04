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
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * The arcane bloom — layer 4, and the thing the whole cast is for.
 *
 * Three passes, and the order they are listed in is the order the eye reads
 * them: the **petals**, which are lit matter and carry the silhouette; the
 * **core**, an additive charge sitting in the middle of them; and the **halo**,
 * the light the core throws onto the air behind it, with the chrono-rings
 * turning inside it.
 *
 * ## The petals are geometry, not cards
 *
 * A flower is the one shape in this project you cannot fake with a billboard.
 * The read is entirely in how the whorls *stack* — outer petals lying almost
 * flat, inner ones cupped and standing, each ring rotated off the last so the
 * gaps never line up — and every one of those facts is a silhouette seen from
 * the side. So a petal is a bent, cupped, twisted sheet placed on an arc:
 *
 *   p(u) = centre + lift + (out·sin a + up·cos a) · (len · u),  a = pitch + curve·u
 *
 * One arc, two angles. `pitch` is where the petal leaves the core and `curve` is
 * how far it keeps turning as it runs out, so a petal that starts at 20° and
 * curves 90° is standing at the base and folded back at the tip — which is what
 * an open bloom actually does, and it comes out of two numbers rather than a
 * modelled mesh.
 *
 * **Opening the bloom is animating `pitch`.** `uOpen` runs 0 → 1 and every
 * petal's pitch is interpolated from the bud's to its whorl's, outer whorls
 * leading (`uOpenStagger`). There is no second pose and nothing is blended.
 *
 * ## And the whole thing turns on one vector
 *
 * That arc is written in the flower's own frame, not the world's, so `uFacing`
 * — the axis the whorls are dealt around — is all it takes to stand the bloom
 * up. Vertical is the flat pose (a rosette seen from above, which is what the
 * geometry gives you if you never think about it); horizontal is a flower
 * standing and looking at something. The ability swings it onto whatever it is
 * about to fire at, and because the two in-plane axes are rebuilt from it per
 * vertex the turn is one continuous rotation rather than a pose blend.
 *
 * ## Why the petals are lit and the core is not
 *
 * The same split the tendrils make, for the same reason. A petal is a *surface*:
 * it takes the key light, it is backlit where the sun is behind it (the wrap
 * term is most of what makes it read as a petal rather than as painted card),
 * it occludes the core, and it drops a shadow into the nest below. The core is
 * not a surface at all — it is the light — so it is additive, unlit, and drawn
 * after everything.
 */

/* -------------------------------------------------------------------- */
/* the petals                                                            */
/* -------------------------------------------------------------------- */

/**
 * The uniform block the bloom is placed and opened by.
 *
 * Owned by the ability, one per cast, and handed to the petals, their shadow,
 * the core and the halo — so all four agree about where the flower is and how
 * far open it is without exchanging anything but this object.
 */
export function createBloomState() {
  return {
    uTime: frame.uTime,
    /** Where the bloom hangs, world space. The ability lifts it as it opens. */
    uCentre: { value: new Vector3() },
    uScale: { value: 1 },
    uSeed: { value: 0 },
    /**
     * The flower's own axis, world space — the way it is *looking*.
     *
     * The whorls are laid out in the plane across this, so it is the one
     * uniform that decides whether the bloom lies open at the sky or stands up
     * and faces a body. `(0,1,0)` is the flat pose; anything horizontal is the
     * standing one. The ability swings it onto whatever it is about to shoot.
     */
    uFacing: { value: new Vector3(0, 0, 1) },
    /** 0 a closed bud, 1 fully open. */
    uOpen: { value: 0 },
    /** The pump every glowing term rides — see `ArborBloomAbility#_pulse`. */
    uCharge: { value: 0 },
    /** 1 while the summon stands, to 0 as it goes. */
    uFade: { value: 1 }
  };
}

const PETAL_VERTEX_DECL = /* glsl */ `
  #define BTAU 6.283185307179586
  #define BPI  3.141592653589793

  attribute float aPetal;

  uniform vec3  uCentre;
  uniform float uScale;
  uniform float uSeed;
  uniform float uOpen;
  uniform float uTime;
  uniform vec3  uFacing;

  uniform vec3  uWhorlCount;
  uniform vec3  uWhorlLength;
  uniform vec3  uWhorlPitch;
  uniform vec3  uWhorlCurve;
  uniform vec3  uWhorlWidth;
  uniform vec3  uWhorlLift;
  uniform vec3  uWhorlRoll;
  uniform float uPitchClosed;
  uniform float uBudLength;
  uniform float uOpenStagger;
  uniform float uWidthBias;
  uniform float uWidthPoint;
  uniform float uCup;
  uniform float uTwist;
  uniform float uSpin;
  uniform float uJitter;

  varying vec3  vPetalWorld;
  varying vec3  vPetalNormal;
  varying vec2  vPetalUv;
  varying float vPetalWhorl;
  varying float vPetalSeed;
  varying float vPetalLive;
  vec3 gPosition;
  vec3 gNormal;

  /** Pick the component of a vec3 that a whorl index names. */
  float whorlPick(vec3 v, float whorl) {
    return whorl < 0.5 ? v.x : (whorl < 1.5 ? v.y : v.z);
  }

  /** Half-width of the blade at u, metres. */
  float petalHalfWidth(float u, float len, float width) {
    float shaped = pow(clamp(u, 0.0, 1.0), max(uWidthBias, 0.05));
    return len * width * pow(sin(shaped * BPI), max(uWidthPoint, 0.05));
  }

  /**
   * One point on one petal.
   *
   * Evaluated three times per vertex so the normal is a real cross product of
   * the surface derivatives. A petal is bent, cupped and twisted at once; there
   * is no analytic normal worth writing out, and a wrong one on a lit material
   * is instantly obvious the moment the key light sweeps across the bloom.
   */
  vec3 petalPoint(
    float u, float v,
    vec3 base, vec3 outDir, vec3 upDir, vec3 sideDir,
    float pitch, float curve, float len, float width
  ) {
    float a = pitch + curve * u;
    vec3 radial = outDir * sin(a) + upDir * cos(a);
    vec3 along  = outDir * cos(a) - upDir * sin(a);

    vec3 p = base + radial * (len * u);

    float w = petalHalfWidth(u, len, width);
    // The blade twists about its own spine toward the tip: the single thing
    // that stops a whorl of petals reading as a paper fan.
    float tw = uTwist * u * u;
    vec3 nrm0 = normalize(cross(along, sideDir));
    vec3 side = sideDir * cos(tw) + nrm0 * sin(tw);
    vec3 nrm  = nrm0 * cos(tw) - sideDir * sin(tw);

    p += side * (v * w);
    // ... and it channels along it, edges standing above the midrib.
    p += nrm * (uCup * w * (1.0 - v * v));
    return p;
  }

  void bloomVertex() {
    /* ---- which whorl, and where in it ---- */
    float idx = aPetal;
    float whorl = 0.0;
    float within = idx;
    if (within >= uWhorlCount.x) { within -= uWhorlCount.x; whorl = 1.0; }
    if (whorl > 0.5 && within >= uWhorlCount.y) { within -= uWhorlCount.y; whorl = 2.0; }
    float count = max(whorlPick(uWhorlCount, whorl), 1.0);
    // Capacity past the live count is collapsed rather than drawn. Cheaper than
    // three draw calls, and the count stays a live slider.
    float live = step(within, count - 0.5) * step(whorl, 2.5);

    float seed = hash11(idx * 4.17 + uSeed * 3.7);
    vPetalWhorl = whorl;
    vPetalSeed = seed;
    vPetalLive = live;

    /* ---- where it points ---- */
    float roll = whorlPick(uWhorlRoll, whorl);
    float spin = uSpin * uTime * BTAU * (mod(whorl, 2.0) < 0.5 ? 1.0 : -1.0);
    float angle = (within / count) * BTAU + roll + spin + (seed - 0.5) * uJitter;

    // The frame the whorls are dealt around. uFacing is the flower's axis and
    // the two others span its face: with the axis vertical this is the old flat
    // pose exactly (petals in the ground plane), and with it horizontal the
    // bloom is standing and looking down the axis. Derived here rather than
    // handed in because it has to stay a single continuous rotation as the
    // ability swings the axis onto a new body — three uniforms drifting out of
    // orthogonality mid-turn would shear the petals.
    vec3 upDir = normalize(uFacing);
    vec3 planeX = cross(vec3(0.0, 1.0, 0.0), upDir);
    float planeLen = length(planeX);
    // Straight up or straight down: no world-up to take a bearing from, so fall
    // back to +X, which reproduces the original pose.
    planeX = planeLen > 1e-3 ? planeX / planeLen : vec3(1.0, 0.0, 0.0);
    vec3 planeY = normalize(cross(upDir, planeX));

    vec3 outDir = planeX * cos(angle) + planeY * sin(angle);
    vec3 sideDir = planeY * cos(angle) - planeX * sin(angle);

    /* ---- how far open ---- */
    // Outer first. A bloom whose whorls open together is a shape scaling up;
    // one whose whorls open in sequence is a flower.
    float lag = clamp(whorl * uOpenStagger, 0.0, 0.9);
    float o = clamp((uOpen - lag) / max(1.0 - lag, 1e-3), 0.0, 1.0);
    o = o * o * (3.0 - 2.0 * o);

    float pitch = mix(uPitchClosed, whorlPick(uWhorlPitch, whorl), o);
    float curve = whorlPick(uWhorlCurve, whorl) * o;
    float len = whorlPick(uWhorlLength, whorl) * uScale * mix(uBudLength, 1.0, o);
    len *= 1.0 + (seed - 0.5) * 0.14;
    float width = whorlPick(uWhorlWidth, whorl);

    vec3 base = uCentre + upDir * (whorlPick(uWhorlLift, whorl) * uScale);

    float u = position.x;
    float v = position.y;
    gPosition = petalPoint(u, v, base, outDir, upDir, sideDir, pitch, curve, len, width);

    // Mirrored at the far edges so the tip and the rim still have a neighbour.
    float du = u < 0.98 ? 0.015 : -0.015;
    float dv = v < 0.98 ? 0.015 : -0.015;
    vec3 pu = petalPoint(u + du, v, base, outDir, upDir, sideDir, pitch, curve, len, width);
    vec3 pv = petalPoint(u, v + dv, base, outDir, upDir, sideDir, pitch, curve, len, width);
    vec3 tu = (pu - gPosition) * sign(du);
    vec3 tv = (pv - gPosition) * sign(dv);
    gNormal = cross(tu, tv);
    gNormal = dot(gNormal, gNormal) > 1e-14 ? normalize(gNormal) : upDir;

    gPosition = mix(uCentre, gPosition, live);

    vPetalWorld = gPosition;
    vPetalNormal = gNormal;
    vPetalUv = vec2(u, v);
  }
`;

const PETAL_FRAGMENT_DECL = /* glsl */ `
  uniform vec3  uColorOuter;
  uniform vec3  uColorMid;
  uniform vec3  uColorInner;
  uniform vec3  uColorBase;
  uniform vec3  uColorMargin;
  uniform vec3  uColorVein;
  uniform float uMargin;
  uniform float uMarginGlow;
  uniform float uVeins;
  uniform float uVeinWidth;
  uniform float uVeinSkew;
  uniform float uRibWidth;
  uniform float uVeinGlow;
  uniform float uTipGlow;
  uniform float uTranslucency;
  uniform float uRimGlow;
  uniform float uRimPower;
  uniform float uShimmer;
  uniform float uShimmerScale;
  uniform float uShimmerSpeed;
  uniform float uCharge;
  uniform float uChargeGain;
  uniform float uFade;
  uniform float uGlow;
  uniform float uTime;
  uniform vec3  uLightDir;
  varying vec3  vPetalWorld;
  varying vec3  vPetalNormal;
  varying vec2  vPetalUv;
  varying float vPetalWhorl;
  varying float vPetalSeed;
  varying float vPetalLive;
`;

function petalFragmentBody() {
  return /* glsl */ `
    {
      float u = clamp(vPetalUv.x, 0.0, 1.0);
      float v = vPetalUv.y;
      vec3  N = normalize(vPetalNormal);
      vec3  V = normalize(vViewPosition);

      /* ---- the blade ---- */
      // Each whorl has its own hue: the outer ones are the cold green of the
      // canopy, the innermost is the gold at the heart of the flower.
      vec3 body = vPetalWhorl < 0.5
        ? uColorOuter
        : (vPetalWhorl < 1.5 ? uColorMid : uColorInner);
      vec3 blade = mix(uColorBase, body, smoothstep(0.0, 0.5, u));
      // The pale margin down both edges. It is what draws the *outline* of a
      // petal against the petal behind it, and without it a whorl is one leaf.
      float margin = smoothstep(1.0 - max(uMargin, 1e-3), 1.0, abs(v));
      blade = mix(blade, uColorMargin, margin * 0.85);
      diffuseColor.rgb *= blade;

      /* ---- the venation ---- */
      float rib = 1.0 - smoothstep(0.0, max(uRibWidth, 1e-3), abs(v));
      float lat = abs(fract(u * uVeins + abs(v) * uVeinSkew) - 0.5) * 2.0;
      lat = 1.0 - smoothstep(0.0, max(uVeinWidth, 1e-3), lat);
      lat *= smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.8, 1.0, u));
      lat *= 1.0 - smoothstep(0.5, 0.95, abs(v));
      float veins = clamp(rib * 0.9 + lat * 0.7, 0.0, 1.6);

      /* ---- light through it, and light along its edge ---- */
      float back = clamp(dot(-N, normalize(uLightDir)), 0.0, 1.0);
      float through = pow(back, 2.0) * uTranslucency;
      float ndv = abs(dot(N, V));
      float rim = pow(1.0 - ndv, max(uRimPower, 0.05));

      /* ---- the chrono shimmer ---- */
      // A slow band of light crossing the whole bloom in world space, so it
      // sweeps *across* the whorls rather than each petal carrying its own.
      float shim = snoise(vPetalWorld * uShimmerScale - vec3(0.0, uTime * uShimmerSpeed, 0.0));
      shim = pow(clamp(shim * 0.5 + 0.5, 0.0, 1.0), 5.0) * uShimmer;

      vec3 glow = uColorVein * veins * uVeinGlow;
      glow += uColorMargin * margin * uMarginGlow;
      glow += body * through;
      glow += uColorMargin * rim * uRimGlow;
      // The tip lights as the core charges — the bloom visibly winds up before
      // it fires, which is the only warning the lance gives. In the petal's own
      // hue, carried toward the margin: lighting every tip with the *inner*
      // whorl's gold washes the outer petals cream and costs the bloom its
      // colour, which is the one thing the reference sheet is emphatic about.
      vec3 tip = mix(body, uColorMargin, 0.6);
      glow += tip * smoothstep(0.55, 1.0, u) * uTipGlow * (1.0 + uCharge * uChargeGain);
      glow += uColorMargin * shim;

      glow *= uGlow * uFade;
      glow /= 1.0 + glow * 0.22;
      totalEmissiveRadiance += glow;
    }
  `;
}

/**
 * The petals.
 *
 * @param {import('../world/Environment.js').Environment} environment
 * @param {object} state the block from `createBloomState`
 */
export function createPetalMaterial(environment, state) {
  const uniforms = {
    ...state,
    uLightDir: frame.uLightDir,

    uWhorlCount: { value: new Vector3(10, 8, 6) },
    uWhorlLength: { value: new Vector3(1.0, 0.72, 0.44) },
    uWhorlPitch: { value: new Vector3(1.16, 0.86, 0.5) },
    uWhorlCurve: { value: new Vector3(0.62, 0.5, 0.34) },
    uWhorlWidth: { value: new Vector3(0.34, 0.36, 0.42) },
    uWhorlLift: { value: new Vector3(-0.05, 0.03, 0.09) },
    uWhorlRoll: { value: new Vector3(0, 0.31, 0.62) },
    uPitchClosed: { value: 0.16 },
    uBudLength: { value: 0.45 },
    uOpenStagger: { value: 0.22 },
    uWidthBias: { value: 0.68 },
    uWidthPoint: { value: 0.8 },
    uCup: { value: 0.22 },
    uTwist: { value: 0.22 },
    uSpin: { value: 0.008 },
    uJitter: { value: 0.1 },

    uColorOuter: { value: new Color() },
    uColorMid: { value: new Color() },
    uColorInner: { value: new Color() },
    uColorBase: { value: new Color() },
    uColorMargin: { value: new Color() },
    uColorVein: { value: new Color() },
    uMargin: { value: 0.3 },
    uMarginGlow: { value: 0.9 },
    uVeins: { value: 6 },
    uVeinWidth: { value: 0.1 },
    uVeinSkew: { value: 0.7 },
    uRibWidth: { value: 0.07 },
    uVeinGlow: { value: 1.6 },
    uTipGlow: { value: 0.8 },
    uTranslucency: { value: 1.4 },
    uRimGlow: { value: 0.7 },
    uRimPower: { value: 2.4 },
    uShimmer: { value: 0.6 },
    uShimmerScale: { value: 1.6 },
    uShimmerSpeed: { value: 0.7 },
    uChargeGain: { value: 2.2 },
    uGlow: { value: 1 }
  };

  const material = new MeshStandardMaterial({
    name: 'ArcaneBloomPetal',
    color: 0xffffff,
    roughness: 0.44,
    metalness: 0.0,
    side: DoubleSide
  });

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${PETAL_VERTEX_DECL}`)
      .replace('#include <beginnormal_vertex>', 'bloomVertex();\nvec3 objectNormal = gNormal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = gPosition;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${PETAL_FRAGMENT_DECL}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         if (vPetalLive < 0.5) discard;`
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${petalFragmentBody()}`);
  });

  material.userData.uniforms = uniforms;
  material.userData.depth = createPetalDepthMaterial(uniforms);

  material.userData.sync = () => {
    const c = settings.growth;
    const g = settings.global;
    const u = uniforms;

    u.uWhorlCount.value.set(
      Math.max(1, Math.round(c.whorlOuter)),
      Math.max(1, Math.round(c.whorlMid)),
      Math.max(1, Math.round(c.whorlInner))
    );
    u.uWhorlLength.value.set(c.petalLengthOuter, c.petalLengthMid, c.petalLengthInner);
    u.uWhorlPitch.value.set(c.petalPitchOuter, c.petalPitchMid, c.petalPitchInner);
    u.uWhorlCurve.value.set(c.petalCurveOuter, c.petalCurveMid, c.petalCurveInner);
    u.uWhorlWidth.value.set(c.petalWidthOuter, c.petalWidthMid, c.petalWidthInner);
    u.uWhorlLift.value.set(c.petalLiftOuter, c.petalLiftMid, c.petalLiftInner);
    u.uWhorlRoll.value.set(0, c.petalRoll, c.petalRoll * 2);
    u.uPitchClosed.value = c.petalPitchClosed;
    u.uBudLength.value = c.petalBudLength;
    u.uOpenStagger.value = c.petalOpenStagger;
    u.uWidthBias.value = c.petalWidthBias;
    u.uWidthPoint.value = c.petalWidthPoint;
    u.uCup.value = c.petalCup;
    u.uTwist.value = c.petalTwist;
    u.uSpin.value = c.bloomSpin;
    u.uJitter.value = c.petalJitter * g.randomness;

    u.uColorOuter.value.copy(getColor(c.colorPetalOuter));
    u.uColorMid.value.copy(getColor(c.colorPetalMid));
    u.uColorInner.value.copy(getColor(c.colorPetalInner));
    u.uColorBase.value.copy(getColor(c.colorPetalBase));
    u.uColorMargin.value.copy(getColor(c.colorPetalMargin));
    u.uColorVein.value.copy(getColor(c.colorPetalVein));
    u.uMargin.value = c.petalMargin;
    u.uMarginGlow.value = c.petalMarginGlow * g.shaderIntensity;
    u.uVeins.value = c.petalVeins;
    u.uVeinWidth.value = c.petalVeinWidth;
    u.uVeinSkew.value = c.petalVeinSkew;
    u.uRibWidth.value = c.petalRibWidth;
    u.uVeinGlow.value = c.petalVeinGlow * g.shaderIntensity;
    u.uTipGlow.value = c.petalTipGlow * g.shaderIntensity;
    u.uTranslucency.value = c.petalTranslucency;
    u.uRimGlow.value = c.petalRim * g.fresnel;
    u.uRimPower.value = c.petalRimPower;
    u.uShimmer.value = c.petalShimmer * g.shaderIntensity;
    u.uShimmerScale.value = c.petalShimmerScale * g.noiseFrequency;
    u.uShimmerSpeed.value = c.petalShimmerSpeed * g.noiseSpeed;
    u.uChargeGain.value = c.petalChargeGain;
    u.uGlow.value = c.petalGlow * g.glow;

    material.roughness = c.petalRoughness;
    material.envMapIntensity = c.petalEnv;
  };

  material.userData.sync();
  return material;
}

/** The petals again, for the shadow map — see the note in GrowthVineMaterial. */
function createPetalDepthMaterial(uniforms) {
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

  patchOnBeforeCompile(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${PETAL_VERTEX_DECL}`)
      .replace('#include <begin_vertex>', 'bloomVertex();\nvec3 transformed = gPosition;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPetalLive;')
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\nif (vPetalLive < 0.5) discard;'
      );
  });

  return material;
}

/* -------------------------------------------------------------------- */
/* the core                                                              */
/* -------------------------------------------------------------------- */

const CORE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uBoil;
  uniform float uBoilScale;

  varying vec3  vLocal;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;
  varying float vDisp;

  ${noiseGLSL}

  void main() {
    // The charge is not a sphere. Displacing along the normal by a slow fbm
    // gives it a boiling silhouette, which is the difference between a light
    // source and a light that is *alive*.
    vec3 sample_ = normal * uBoilScale + vec3(uSeed * 5.3) - vec3(0.0, uTime * 0.55, 0.0);
    float n = fbm4(sample_) * 0.7 + ridged(sample_ * 1.6, 4) * 0.3;
    vDisp = n;

    vec3 displaced = position + normal * n * uBoil;
    vec4 world = modelMatrix * vec4(displaced, 1.0);
    vLocal = normalize(position);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CORE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uCharge;
  uniform float uChargeGain;
  uniform float uOpen;
  uniform float uFade;
  uniform float uIntensity;
  uniform float uCoreFill;
  uniform float uRimPower;
  uniform float uRimGain;
  uniform float uFilament;
  uniform float uFilamentScale;
  uniform float uFilamentSpeed;
  uniform float uPetalShadow;
  uniform vec3  uColorCore;
  uniform vec3  uColorMid;
  uniform vec3  uColorEdge;
  uniform float uGlobalGlow;
  uniform float uSoftFade;
  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec3  vLocal;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;
  varying float vDisp;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float ndv = clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0);

    // Weighted *toward* the axis rather than the rim: the path a view ray takes
    // through a ball of light is longest through the middle, so the middle is
    // what has to be white. Rim-weighting a core gives you a bubble.
    float depth = pow(ndv, max(uCoreFill, 0.05));
    float rim = pow(1.0 - ndv, max(uRimPower, 0.05)) * uRimGain;

    // Filaments turning inside it — the chrono thread, wound up.
    vec3 q = vLocal * uFilamentScale + vec3(0.0, uTime * uFilamentSpeed, uSeed * 3.1);
    float fil = ridged(q, 4) * 0.5;
    fil = pow(clamp(fil, 0.0, 1.0), 3.0) * uFilament;

    float energy = depth + rim + fil;
    vec3 color = gradient4(uColorCore, uColorCore, uColorMid, uColorEdge, 1.0 - depth);
    color *= energy * uIntensity * (1.0 + uCharge * uChargeGain);
    // The bloom's own petals are in front of it from most angles and this pass
    // is additive, so it would otherwise burn straight through them. Fading it
    // toward the closed bud is what keeps the charge *inside* the flower.
    color *= mix(uPetalShadow, 1.0, clamp(uOpen, 0.0, 1.0));
    color *= uGlobalGlow * uFade;

    float alpha = clamp(energy * 0.85, 0.0, 1.0) * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The charge at the heart of the bloom.
 *
 * Additive, unlit, drawn late, and soft-faded against the depth prepass so it
 * does not cut a hard sphere out of the petals it is sitting inside.
 *
 * @param {object} state the block from `createBloomState`
 */
export function createBloomCoreMaterial(state) {
  const material = new ShaderMaterial({
    name: 'ArcaneBloomCore',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: state.uCentre,
      uScale: state.uScale,
      uSeed: state.uSeed,
      uOpen: state.uOpen,
      uCharge: state.uCharge,
      uFade: state.uFade,
      uChargeGain: { value: 2.4 },
      uIntensity: { value: 2.6 },
      uCoreFill: { value: 1.7 },
      uRimPower: { value: 2.2 },
      uRimGain: { value: 0.9 },
      uBoil: { value: 0.14 },
      uBoilScale: { value: 2.6 },
      uFilament: { value: 1.0 },
      uFilamentScale: { value: 4.5 },
      uFilamentSpeed: { value: 0.5 },
      uPetalShadow: { value: 0.35 },
      uSoftFade: { value: 0.4 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorMid: { value: new Color(0.4, 1, 0.8) },
      uColorEdge: { value: new Color(0.05, 0.5, 0.3) }
    }),
    vertexShader: CORE_VERTEX,
    fragmentShader: CORE_FRAGMENT
  });

  material.userData.sync = () => {
    const c = settings.growth;
    const g = settings.global;
    const u = material.uniforms;

    u.uIntensity.value = c.coreIntensity * g.shaderIntensity;
    u.uChargeGain.value = c.coreChargeGain;
    u.uCoreFill.value = c.coreFill;
    u.uRimPower.value = c.coreRimPower;
    u.uRimGain.value = c.coreRim * g.fresnel;
    u.uBoil.value = c.coreBoil * g.turbulence;
    u.uBoilScale.value = c.coreBoilScale * g.noiseFrequency;
    u.uFilament.value = c.coreFilament;
    u.uFilamentScale.value = c.coreFilamentScale * g.noiseFrequency;
    u.uFilamentSpeed.value = c.coreFilamentSpeed * g.noiseSpeed;
    u.uPetalShadow.value = c.coreBudDim;
    u.uSoftFade.value = c.coreSoftFade;
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorMid.value.copy(getColor(c.colorCoreMid));
    u.uColorEdge.value.copy(getColor(c.colorCoreEdge));
  };

  material.userData.sync();
  return material;
}

/* -------------------------------------------------------------------- */
/* the halo and the chrono rings                                         */
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
  uniform float uOpen;
  uniform float uFade;
  uniform float uGlow;
  uniform float uFalloff;
  uniform float uRays;
  uniform float uRayCount;
  uniform float uRaySharp;
  uniform float uRaySpin;
  uniform float uRingA;
  uniform float uRingB;
  uniform float uRingWidth;
  uniform float uRingSpin;
  uniform float uTicks;
  uniform float uTickCount;
  uniform float uTickWidth;
  uniform vec3  uColorHalo;
  uniform vec3  uColorRing;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}

  #define HTAU 6.283185307179586

  void main() {
    vec2 p = vUv * 2.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);

    /* ---- the bloom of light itself ---- */
    float halo = pow(clamp(1.0 - r, 0.0, 1.0), max(uFalloff, 0.05));

    /* ---- rays combed out of it ---- */
    float sweep = ang + uTime * uRaySpin * HTAU;
    float ray = pow(clamp(0.5 + 0.5 * cos(sweep * uRayCount), 0.0, 1.0), max(uRaySharp, 1.0));
    // Never at the very centre (a star of hard spokes meeting in a point reads
    // as a lens artefact) and gone before the rim.
    ray *= smoothstep(0.05, 0.3, r) * (1.0 - smoothstep(0.55, 1.0, r)) * uRays;

    /* ---- the chrono rings ---- */
    float aa = fwidth(r) + 1e-4;
    float w = max(uRingWidth, aa * 1.5);
    float ringA = (1.0 - smoothstep(0.0, w, abs(r - uRingA))) * (uRingWidth / w);
    float ringB = (1.0 - smoothstep(0.0, w, abs(r - uRingB))) * (uRingWidth / w);

    // Ticks around the outer ring, counter-turning against the inner one: this
    // is the only place the summon says *chrono* out loud, so it is a dial.
    float tickAngle = ang + uTime * uRingSpin * HTAU;
    float tick = step(1.0 - uTickWidth, abs(fract(tickAngle / HTAU * uTickCount) * 2.0 - 1.0));
    ringB *= mix(1.0, tick, clamp(uTicks, 0.0, 1.0));

    vec3 color = uColorHalo * halo * (1.0 + uCharge * 1.5);
    color += uColorHalo * ray;
    color += uColorRing * (ringA + ringB) * (0.7 + 0.6 * uCharge);

    float alpha = clamp(halo + ray * 0.7 + (ringA + ringB) * 0.8, 0.0, 1.0);
    alpha *= uFade * smoothstep(0.0, 0.35, uOpen);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color * uGlow * uGlobalGlow, alpha);
  }
`;

/**
 * The light the core throws onto the air, and the dial turning inside it.
 *
 * @param {object} state the block from `createBloomState`
 */
export function createBloomHaloMaterial(state) {
  const material = new ShaderMaterial({
    name: 'ArcaneBloomHalo',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: state.uSeed,
      uOpen: state.uOpen,
      uCharge: state.uCharge,
      uFade: state.uFade,
      uSize: { value: 3 },
      uGlow: { value: 1 },
      uFalloff: { value: 2.6 },
      uRays: { value: 0.5 },
      uRayCount: { value: 14 },
      uRaySharp: { value: 6 },
      uRaySpin: { value: 0.02 },
      uRingA: { value: 0.52 },
      uRingB: { value: 0.78 },
      uRingWidth: { value: 0.012 },
      uRingSpin: { value: -0.05 },
      uTicks: { value: 0.8 },
      uTickCount: { value: 48 },
      uTickWidth: { value: 0.45 },
      uColorHalo: { value: new Color() },
      uColorRing: { value: new Color() }
    }),
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT
  });

  material.userData.sync = (size) => {
    const c = settings.growth;
    const g = settings.global;
    const u = material.uniforms;

    u.uSize.value = size;
    u.uGlow.value = c.haloGlow * g.glow;
    u.uFalloff.value = c.haloFalloff;
    u.uRays.value = c.haloRays * g.shaderIntensity;
    u.uRayCount.value = Math.max(2, Math.round(c.haloRayCount));
    u.uRaySharp.value = c.haloRaySharp;
    u.uRaySpin.value = c.haloRaySpin;
    u.uRingA.value = c.haloRingInner;
    u.uRingB.value = c.haloRingOuter;
    u.uRingWidth.value = c.haloRingWidth;
    u.uRingSpin.value = c.haloRingSpin;
    u.uTicks.value = c.haloTicks;
    u.uTickCount.value = Math.max(1, Math.round(c.haloTickCount));
    u.uTickWidth.value = c.haloTickWidth;
    u.uColorHalo.value.copy(getColor(c.colorHalo));
    u.uColorRing.value.copy(getColor(c.colorHaloRing));
  };

  material.userData.sync(3);
  return material;
}
