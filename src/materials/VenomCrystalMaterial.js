import { MeshStandardMaterial, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Amethyst with venom trapped inside it — layer 1 of the breakdown.
 *
 * Built on MeshStandardMaterial rather than a raw ShaderMaterial so the gems
 * cast and receive the stage's real shadows and catch the HDR probe. Everything
 * that makes them *venomous* is injected on top.
 *
 * The reference frame is doing one thing above all others, and the whole shader
 * is organised around it: the crystals are **cold purple glass lit from within
 * by something green**. Get that backwards — a green crystal with a purple
 * glow — and the image dies, because the venom stops being a substance held
 * inside a gem and becomes a coloured light behind it. So:
 *
 *   - **thickness tint** — a facet seen head-on has the longest path through
 *     the stone and darkens toward `colorDeep`; grazing edges keep the pale
 *     lilac. This is what makes a gem read as a solid you see *into*.
 *   - **venom in the flaws** — ridged noise in *local* space, drifting upward,
 *     pooled at the base and thinning toward the tip. It is the only strongly
 *     emissive term and it is the only green one, so it reads as fluid sealed
 *     in the crystal rather than as a tint on it.
 *   - **dispersion** — the rim term is evaluated at three slightly different
 *     exponents for R/G/B, which splits the silhouette green on one side and
 *     violet on the other. Two lines of code, and it is the difference between
 *     "gem" and "purple plastic".
 *   - **cleavage planes** — ridged noise in *world* space, so the internal
 *     flaws keep a fixed physical size and a whole cluster looks quarried from
 *     one block instead of each spike having its own private texture.
 *   - **frosted tip** — the reference crystals go milky and slightly opaque in
 *     the last third; that band is where the light scatters out instead of
 *     through.
 *   - **the core's light** — `uCore` is where the glow ball (layer 5) is
 *     standing, in world space. Gems near it are lit from that direction, which
 *     is what welds the two layers into one object instead of a glow parked
 *     inside a pile of crystals.
 *   - **birth flash** — a per-instance value driven 1 → 0 as a gem erupts, so
 *     it is briefly incandescent at the moment it tears out of the floor.
 *
 * Per-instance inputs arrive as instanced attributes (`aSeed`, `aBirth`,
 * `aFlow`), so this material is only ever used on an InstancedMesh.
 */
export function createVenomCrystalMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.12,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    // Translucent: the far wall of a gem is part of what you see through the
    // near one, and culling it leaves the slender ones reading as hollow shells.
    side: DoubleSide,
    depthWrite: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorDeep: { value: new Color() },
    uColorBody: { value: new Color() },
    uColorRim: { value: new Color() },
    uColorVenom: { value: new Color() },
    uColorTip: { value: new Color() },
    uDensity: { value: 1.3 },
    uFresnel: { value: 2.1 },
    uFresnelPower: { value: 2.6 },
    uDispersion: { value: 0.55 },
    uFacetSharp: { value: 0.72 },
    uCleave: { value: 0.7 },
    uCleaveScale: { value: 7.5 },
    uVenom: { value: 1.5 },
    uVenomScale: { value: 3.4 },
    uVenomFlow: { value: 0.55 },
    uVenomBase: { value: 0.65 },
    uVenomSharp: { value: 3.0 },
    uTipFrost: { value: 0.5 },
    uTipStart: { value: 0.55 },
    uGlint: { value: 1.2 },
    uGlintScale: { value: 30 },
    uGlintSpeed: { value: 0.6 },
    uGlow: { value: 1.0 },
    uEdgeGlow: { value: 1.2 },
    uBirthGlow: { value: 3.0 },
    /** Where the core is standing, world space, and how far its light carries. */
    uCore: { value: new Vector3() },
    uCoreGlow: { value: 1.2 },
    uCoreRadius: { value: 3.2 },
    uColorCore: { value: new Color() }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aBirth;
         attribute float aFlow;
         varying vec3  vGemLocal;
         varying vec3  vGemWorld;
         varying float vGemSeed;
         varying float vGemBirth;
         varying float vGemFlow;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vGemLocal = transformed;
         vGemSeed = aSeed;
         vGemBirth = aBirth;
         vGemFlow = aFlow;
         #ifdef USE_INSTANCING
           vGemWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vGemWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorDeep;
         uniform vec3  uColorBody;
         uniform vec3  uColorRim;
         uniform vec3  uColorVenom;
         uniform vec3  uColorTip;
         uniform float uDensity;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uDispersion;
         uniform float uFacetSharp;
         uniform float uCleave;
         uniform float uCleaveScale;
         uniform float uVenom;
         uniform float uVenomScale;
         uniform float uVenomFlow;
         uniform float uVenomBase;
         uniform float uVenomSharp;
         uniform float uTipFrost;
         uniform float uTipStart;
         uniform float uGlint;
         uniform float uGlintScale;
         uniform float uGlintSpeed;
         uniform float uGlow;
         uniform float uEdgeGlow;
         uniform float uBirthGlow;
         uniform vec3  uCore;
         uniform float uCoreGlow;
         uniform float uCoreRadius;
         uniform vec3  uColorCore;
         varying vec3  vGemLocal;
         varying vec3  vGemWorld;
         varying float vGemSeed;
         varying float vGemBirth;
         varying float vGemFlow;
         ${noiseGLSL}`
      )
      // Injected once the normal is resolved: with `flatShading` there is no
      // `vNormal` varying, so every view-dependent term here reads the face
      // normal that <normal_fragment_begin> derives from screen derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

           // Head-on you look down the long axis of the gem; at a grazing angle
           // you are only clipping its edge.
           float thickness = clamp(ndv * uDensity, 0.0, 1.0);
           float rim = pow(1.0 - ndv, uFresnelPower);
           float fres = rim * uFresnel;

           // Height up this crystal's own axis, 0 at the floor, 1 at the tip.
           float up = clamp(vGemLocal.y, 0.0, 1.0);

           /* --- the flaws the venom runs in ------------------------------ */
           // World space, so a cluster looks cut from one block.
           vec3  cp     = vGemWorld * uCleaveScale + vGemSeed * 41.0;
           float cleave = smoothstep(0.52, 0.97, ridged(cp, 4));

           /* --- the venom itself ----------------------------------------- */
           // Local space and drifting *up* the crystal: the fluid belongs to
           // this gem and climbs it, rather than the gem sliding through a
           // fixed world-space field as the field is rebuilt each frame.
           vec3 vp = vGemLocal * vec3(uVenomScale * 2.2, uVenomScale, uVenomScale * 2.2);
           vp.y -= uTime * uVenomFlow + vGemFlow * 6.0;
           float fluid = ridged(vp + vGemSeed * 17.0, 4);
           fluid = pow(clamp(fluid, 0.0, 1.0), uVenomSharp);
           // Pooled at the base, thinning toward the tip — venom has weight.
           fluid *= mix(1.0, uVenomBase, up);
           // It gathers in the cleavage planes, because that is where a real
           // inclusion sits: in the flaw, not in the clear body.
           fluid = clamp(fluid * (0.55 + 1.1 * cleave), 0.0, 1.0);

           /* --- body colour ---------------------------------------------- */
           vec3 body = mix(uColorBody, uColorDeep, thickness);
           body = mix(body, uColorRim, cleave * uCleave * 0.35);

           // The milky band the reference crystals have in their last third.
           float frost = smoothstep(uTipStart, 1.0, up) *
                         (0.55 + 0.45 * fbm3(vGemLocal * 11.0 + vGemSeed * 5.0));
           body = mix(body, uColorTip, clamp(frost, 0.0, 1.0) * uTipFrost);

           // Lift the facets that point at the camera so the silhouette reads as
           // a bundle of planes rather than one smooth mass.
           body *= mix(1.0, 0.5 + 0.95 * ndv, uFacetSharp);

           diffuseColor.rgb *= body;

           /* --- dispersion ------------------------------------------------ */
           // The same rim term at three exponents. Red survives longest, blue
           // falls off first, so the silhouette splits warm on one side and
           // green-cyan on the other, the way a faceted stone actually breaks
           // white light.
           vec3 spread = vec3(
             pow(1.0 - ndv, uFresnelPower * (1.0 - 0.30 * uDispersion)),
             rim,
             pow(1.0 - ndv, uFresnelPower * (1.0 + 0.38 * uDispersion))
           );

           /* --- pinpoint glints on the facets ----------------------------- */
           float sp = snoise(vGemWorld * uGlintScale +
                             vec3(0.0, uTime * uGlintSpeed, 0.0) + vGemSeed * 23.0);
           sp = pow(clamp(sp, 0.0, 1.0), 16.0) * smoothstep(0.0, 0.7, fres + 0.25);

           /* --- the core's light ------------------------------------------ */
           // Falls off with distance from the glow ball and is strongest on the
           // facets turned toward it, so the cluster is lit by its own middle.
           vec3  toCore = uCore - vGemWorld;
           float reach  = 1.0 - smoothstep(0.0, max(uCoreRadius, 0.05), length(toCore));
           float facing = clamp(dot(N, normalize(toCore + 1e-4)), 0.0, 1.0);
           float coreLit = reach * reach * (0.35 + 0.65 * facing);

           /* --- everything that emits ------------------------------------- */
           vec3 glow = uColorRim * spread * uEdgeGlow;
           glow += uColorVenom * fluid * uVenom;
           glow += uColorRim * sp * uGlint * 1.4;
           glow += uColorCore * coreLit * uCoreGlow;
           glow += uColorVenom * vGemBirth * uBirthGlow;
           glow *= uGlow;

           // Soft ceiling. Every term above peaks at a grazing angle, so they
           // stack: without this a facet on the silhouette sums past 10 and the
           // gem reads as a white blob wearing the bloom pass — which is exactly
           // what the first build did, and no amount of palette work fixes it,
           // because a blown-out channel has no hue left to correct. A Reinhard
           // rolloff leaves anything under ~1 alone and asymptotes at 1/0.42 =
           // 2.4, low enough that the amethyst survives the light inside it.
           glow /= 1.0 + glow * 0.42;

           totalEmissiveRadiance += glow;

           // Denser through the body, thinner at the edges, and near-solid
           // wherever the venom has pooled — fluid is the one thing in here you
           // cannot see through. The floor matters: at 0.58 the gems were sheer
           // enough that the core behind them showed through and every crystal
           // took its colour, which is how a field of amethyst comes out green.
           diffuseColor.a = clamp(
             diffuseColor.a * (0.8 + 0.3 * fres) + fluid * 0.28 + frost * 0.14,
             0.0, 1.0
           );
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.venom;
    const g = settings.global;

    uniforms.uColorDeep.value.copy(getColor(c.colorDeep));
    uniforms.uColorBody.value.copy(getColor(c.colorGem));
    uniforms.uColorRim.value.copy(getColor(c.colorGemRim));
    uniforms.uColorVenom.value.copy(getColor(c.colorVenom));
    uniforms.uColorTip.value.copy(getColor(c.colorGemTip));
    uniforms.uColorCore.value.copy(getColor(c.colorCore));

    uniforms.uDensity.value = c.depthTint;
    uniforms.uFresnel.value = c.fresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.fresnelPower;
    uniforms.uDispersion.value = c.dispersion;
    uniforms.uFacetSharp.value = c.facetSharp;
    uniforms.uCleave.value = c.cleave * g.shaderIntensity;
    uniforms.uCleaveScale.value = c.cleaveScale * g.noiseFrequency;
    uniforms.uVenom.value = c.venomGlow * g.shaderIntensity;
    uniforms.uVenomScale.value = c.venomScale * g.noiseFrequency;
    uniforms.uVenomFlow.value = c.venomFlow * g.noiseSpeed;
    uniforms.uVenomBase.value = c.venomBase;
    uniforms.uVenomSharp.value = c.venomSharp;
    uniforms.uTipFrost.value = c.tipFrost;
    uniforms.uTipStart.value = c.tipStart;
    uniforms.uGlint.value = c.glint * g.shaderIntensity;
    uniforms.uGlintScale.value = c.glintScale;
    uniforms.uGlintSpeed.value = c.glintSpeed * g.noiseSpeed;
    uniforms.uGlow.value = c.gemGlow * g.glow;
    uniforms.uEdgeGlow.value = c.edgeGlow;
    uniforms.uBirthGlow.value = c.birthGlow;
    uniforms.uCoreGlow.value = c.coreBleed;
    uniforms.uCoreRadius.value = c.coreBleedRadius;

    material.opacity = c.gemOpacity * g.opacity;
    material.envMapIntensity = c.envIntensity;
    material.roughness = c.gemRoughness;
  };

  material.userData.sync();
  return material;
}
