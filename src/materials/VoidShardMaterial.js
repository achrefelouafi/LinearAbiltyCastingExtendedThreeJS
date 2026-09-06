import { MeshStandardMaterial, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The void-shards — the solid half of layer 4.
 *
 * Thousands of micro-stars are particles and belong in the particle engine.
 * The *shards* are not: they are hand-sized pieces of crystallised void torn
 * out of the floor and caught in the currents around the hole, and the reason
 * they are real instanced geometry rather than more billboards is that they
 * have to **tumble**. A chip that turns end over end shows a facet catching the
 * stage's sun one frame and a black silhouette the next, and nothing sold as a
 * sprite ever does that. They are also the only thing in this ability with a
 * hard edge, which is what gives the gas around them a sense of scale.
 *
 * Built on MeshStandardMaterial rather than a raw ShaderMaterial so they take
 * the real key light, the rim, the HDR probe and the stage's shadows like any
 * other solid. Everything that makes them *void* is injected on top:
 *
 *  - **near-black body, violet rim.** The stone itself is barely there; what
 *    draws the silhouette against a dark floor is a fresnel in the same violet
 *    the nebula is made of, so a shard reads as cut from the same material as
 *    the blast rather than as debris that wandered in.
 *  - **veins that answer to the hole.** Ridged noise in the shard's own local
 *    space, lit gold and driven by `aHeat` — how deep in the gravity well this
 *    particular shard is. A shard out at the rim is a black chip; one about to
 *    cross the horizon is glowing along every flaw, and it got there by
 *    travelling, not by a timer.
 *  - **tidal white-out.** Past a certain heat the veins stop being veins and
 *    the whole shard goes incandescent. That is the frame before it is
 *    swallowed, and it is what makes the swallow legible at a distance.
 *
 * Per-instance inputs arrive as instanced attributes, so this material is only
 * ever used on an InstancedMesh.
 */
export function createVoidShardMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.34,
    metalness: 0.2,
    // Crisp facets: these are faceted crystals, and smooth shading turns them
    // into pebbles at the size they are drawn.
    flatShading: true,
    side: DoubleSide
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorBody: { value: new Color() },
    uColorFacet: { value: new Color() },
    uColorRim: { value: new Color() },
    uColorVein: { value: new Color() },
    uColorHot: { value: new Color() },
    uFresnel: { value: 1.6 },
    uFresnelPower: { value: 2.4 },
    uVein: { value: 1.4 },
    uVeinScale: { value: 6.5 },
    uVeinSharp: { value: 3.2 },
    uGlint: { value: 1.1 },
    uGlintScale: { value: 26 },
    uHeatGlow: { value: 4.5 },
    uGlow: { value: 1 },
    /** Where the hole is, so a shard is lit from the thing that is eating it. */
    uCore: { value: new Vector3() },
    uCoreGlow: { value: 1.4 },
    uCoreRadius: { value: 6 },
    uColorCore: { value: new Color() }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aHeat;
         varying vec3  vShardLocal;
         varying vec3  vShardWorld;
         varying float vShardSeed;
         varying float vShardHeat;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vShardLocal = transformed;
         vShardSeed = aSeed;
         vShardHeat = aHeat;
         #ifdef USE_INSTANCING
           vShardWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vShardWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorBody;
         uniform vec3  uColorFacet;
         uniform vec3  uColorRim;
         uniform vec3  uColorVein;
         uniform vec3  uColorHot;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uVein;
         uniform float uVeinScale;
         uniform float uVeinSharp;
         uniform float uGlint;
         uniform float uGlintScale;
         uniform float uHeatGlow;
         uniform float uGlow;
         uniform vec3  uCore;
         uniform float uCoreGlow;
         uniform float uCoreRadius;
         uniform vec3  uColorCore;
         varying vec3  vShardLocal;
         varying vec3  vShardWorld;
         varying float vShardSeed;
         varying float vShardHeat;
         ${noiseGLSL}`
      )
      // Injected once the normal is resolved: with flatShading there is no
      // vNormal varying, so every view-dependent term below reads the face
      // normal that <normal_fragment_begin> derives from screen derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
           float rim = pow(1.0 - ndv, uFresnelPower);
           float heat = clamp(vShardHeat, 0.0, 1.0);

           /* --- the body ------------------------------------------------- */
           // Facets turned toward the camera are lifted a little so the shape
           // reads as a bundle of planes rather than one black mass.
           vec3 body = mix(uColorBody, uColorFacet, ndv * 0.75);
           diffuseColor.rgb *= body;

           /* --- the flaws the void runs in -------------------------------- */
           // Local space, so the veins belong to this shard and turn with it
           // instead of it sliding through a field pinned to the world.
           vec3  vp    = vShardLocal * uVeinScale + vShardSeed * 31.0;
           float vein  = pow(clamp(ridged(vp, 4), 0.0, 1.0), uVeinSharp);
           // Nothing until the shard is deep enough in the well to be strained.
           float strain = smoothstep(0.05, 0.75, heat);

           /* --- pinpoint glints on the facets ----------------------------- */
           float sp = snoise(vShardWorld * uGlintScale + vShardSeed * 19.0);
           sp = pow(clamp(sp, 0.0, 1.0), 16.0) * smoothstep(0.0, 0.6, rim + 0.2);

           /* --- lit by the thing that is eating it ------------------------ */
           vec3  toCore = uCore - vShardWorld;
           float reach  = 1.0 - smoothstep(0.0, max(uCoreRadius, 0.05), length(toCore));
           float facing = clamp(dot(N, normalize(toCore + 1e-4)), 0.0, 1.0);
           float coreLit = reach * reach * (0.3 + 0.7 * facing);

           /* --- everything that emits -------------------------------------- */
           vec3 glow = uColorRim * rim * uFresnel;
           glow += uColorVein * vein * strain * uVein;
           glow += uColorRim * sp * uGlint;
           glow += uColorCore * coreLit * uCoreGlow;
           // The last beat before it is swallowed: the flaws stop being flaws
           // and the whole shard goes incandescent.
           glow += uColorHot * pow(heat, 3.0) * uHeatGlow;
           glow *= uGlow;

           // Soft ceiling. Every term above peaks at a grazing angle and they
           // stack; without a rolloff a facet on the silhouette sums past ten
           // and the shard is a white blob wearing the bloom pass.
           glow /= 1.0 + glow * 0.3;

           totalEmissiveRadiance += glow;
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.astral;
    const g = settings.global;

    uniforms.uColorBody.value.copy(getColor(c.colorShardBody));
    uniforms.uColorFacet.value.copy(getColor(c.colorShardFacet));
    uniforms.uColorRim.value.copy(getColor(c.colorShardRim));
    uniforms.uColorVein.value.copy(getColor(c.colorShardVein));
    uniforms.uColorHot.value.copy(getColor(c.colorShardHot));
    uniforms.uColorCore.value.copy(getColor(c.colorPhoton));

    uniforms.uFresnel.value = c.shardFresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.shardFresnelPower;
    uniforms.uVein.value = c.shardVein * g.shaderIntensity;
    uniforms.uVeinScale.value = c.shardVeinScale * g.noiseFrequency;
    uniforms.uVeinSharp.value = c.shardVeinSharp;
    uniforms.uGlint.value = c.shardGlint * g.shaderIntensity;
    uniforms.uGlintScale.value = c.shardGlintScale;
    uniforms.uHeatGlow.value = c.shardHeatGlow;
    uniforms.uCoreGlow.value = c.shardCoreBleed;
    uniforms.uCoreRadius.value = c.shardCoreRadius;
    uniforms.uGlow.value = g.glow;

    material.roughness = c.shardRoughness;
    material.metalness = c.shardMetalness;
    material.envMapIntensity = c.shardEnvIntensity;
  };

  material.userData.sync();
  return material;
}
