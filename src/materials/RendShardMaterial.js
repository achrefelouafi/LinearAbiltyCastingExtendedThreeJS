import { Color, DoubleSide, MeshStandardMaterial, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The Radiant Shards — layer 3, and the only solid in the ability.
 *
 * Everything else the Celestial Rend draws is light: additive, unlit, and
 * incapable of occluding anything. That is a problem, because a shot made
 * entirely of light has no scale — the eye has nothing with a hard edge to
 * measure the column against. The shards are that thing. They are real
 * geometry, they are in the depth prepass, they cast into the shadow map, and
 * they take the stage's own key light on their facets.
 *
 * Which is also why this is a `MeshStandardMaterial` with its emissive stage
 * extended rather than a raw shader: the sun, the probe and the stage's shadows
 * are three's, and only the things that make a shard *divine* are injected on
 * top of them.
 *
 *  - **crystal, not stone.** A pale body that lifts where it faces the camera,
 *    so the sliver reads as a bundle of planes rather than one grey mass, with
 *    a hard rim in the ability's own gold drawing the silhouette against a dark
 *    floor.
 *  - **a lit spine.** Ridged noise in the shard's *local* space, so the flaw
 *    belongs to this shard and turns with it instead of the shard sliding
 *    through a field pinned to the world. It runs hot along the length, which
 *    is what makes a sliver read as a blade of light rather than as a splinter.
 *  - **two populations.** `aTone` deals each shard warm or cold. The reference
 *    sheet's third panel is gold shards with blue-white ones scattered among
 *    them, and dealing rather than grouping is what stops one side of the
 *    converging volley being all one colour.
 *  - **incandescence on arrival.** `aHeat` is how close this shard is to the
 *    moment it goes in. Past a point the flaws stop being flaws and the whole
 *    sliver goes white — that is the frame before it strikes, and it is what
 *    makes the strike legible at fifteen metres.
 *  - **lit by the column.** A shard near the shaft picks up its light on the
 *    facets that face it. Without this the debris field reads as having
 *    wandered into the shot; with it, it reads as being *in* the light.
 *
 * Per-instance inputs arrive as instanced attributes, so this material is only
 * ever used on an InstancedMesh.
 */
export function createRendShardMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.22,
    metalness: 0.1,
    // Crisp facets: these are cut crystal, and smooth shading turns them into
    // pebbles at the size they are drawn.
    flatShading: true,
    side: DoubleSide
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorBody: { value: new Color() },
    uColorFacet: { value: new Color() },
    uColorWarm: { value: new Color() },
    uColorCold: { value: new Color() },
    uColorVein: { value: new Color() },
    uColorHot: { value: new Color() },
    uFresnel: { value: 1.8 },
    uFresnelPower: { value: 2.2 },
    uVein: { value: 1.6 },
    uVeinScale: { value: 5.0 },
    uVeinSharp: { value: 2.6 },
    uSpine: { value: 1.4 },
    uSpinePower: { value: 2.2 },
    uGlint: { value: 1.2 },
    uGlintScale: { value: 22 },
    uHeatGlow: { value: 6.0 },
    uGlow: { value: 1 },
    /** The column, so a shard is lit by the thing it is falling into. */
    uBeam: { value: new Vector3() },
    uBeamGlow: { value: 1.6 },
    uBeamRadius: { value: 8 },
    uColorBeam: { value: new Color() }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aHeat;
         attribute float aTone;
         varying vec3  vShardLocal;
         varying vec3  vShardWorld;
         varying float vShardSeed;
         varying float vShardHeat;
         varying float vShardTone;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vShardLocal = transformed;
         vShardSeed = aSeed;
         vShardHeat = aHeat;
         vShardTone = aTone;
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
         uniform vec3  uColorWarm;
         uniform vec3  uColorCold;
         uniform vec3  uColorVein;
         uniform vec3  uColorHot;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uVein;
         uniform float uVeinScale;
         uniform float uVeinSharp;
         uniform float uSpine;
         uniform float uSpinePower;
         uniform float uGlint;
         uniform float uGlintScale;
         uniform float uHeatGlow;
         uniform float uGlow;
         uniform vec3  uBeam;
         uniform float uBeamGlow;
         uniform float uBeamRadius;
         uniform vec3  uColorBeam;
         varying vec3  vShardLocal;
         varying vec3  vShardWorld;
         varying float vShardSeed;
         varying float vShardHeat;
         varying float vShardTone;
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
           vec3  tone = mix(uColorWarm, uColorCold, clamp(vShardTone, 0.0, 1.0));

           /* --- the body ------------------------------------------------- */
           vec3 body = mix(uColorBody, uColorFacet, ndv * 0.8);
           diffuseColor.rgb *= body;

           /* --- the flaws it is lit through ------------------------------ */
           // Local space, so the veins belong to this shard and turn with it.
           vec3  vp   = vShardLocal * uVeinScale + vShardSeed * 31.0;
           float vein = pow(clamp(ridged(vp, 4), 0.0, 1.0), uVeinSharp);

           /* --- and the spine down its length ----------------------------- */
           // The geometry is a spindle a unit long on its own +Y, so the
           // distance off that axis is the two other components. Hot on the
           // axis and dark at the facets, which is what makes a sliver read as
           // a blade of light rather than as a splinter of glass.
           float off = length(vShardLocal.xz) / 0.06;
           float spine = pow(clamp(1.0 - off, 0.0, 1.0), uSpinePower) * uSpine;

           /* --- pinpoint glints on the facets ----------------------------- */
           float sp = snoise(vShardWorld * uGlintScale + vShardSeed * 19.0);
           sp = pow(clamp(sp, 0.0, 1.0), 16.0) * smoothstep(0.0, 0.6, rim + 0.2);

           /* --- lit by the column ----------------------------------------- */
           // Measured to the column's *axis* rather than to a point on it: the
           // beam is thirty metres tall, and a point light at its foot would
           // leave everything hanging beside its head unlit.
           vec2  toAxis = uBeam.xz - vShardWorld.xz;
           float reach  = 1.0 - smoothstep(0.0, max(uBeamRadius, 0.05), length(toAxis));
           vec3  toBeam = normalize(vec3(toAxis.x, 0.0, toAxis.y) + 1e-4);
           float facing = clamp(dot(N, toBeam), 0.0, 1.0);
           float beamLit = reach * reach * (0.35 + 0.65 * facing);

           /* --- everything that emits -------------------------------------- */
           vec3 glow = tone * rim * uFresnel;
           glow += uColorVein * vein * uVein * (0.35 + 0.65 * heat);
           glow += tone * spine;
           glow += uColorHot * sp * uGlint;
           glow += uColorBeam * beamLit * uBeamGlow;
           // The last beat before it goes in: the flaws stop being flaws and
           // the whole sliver goes incandescent.
           glow += uColorHot * pow(heat, 2.6) * uHeatGlow;
           glow *= uGlow;

           // Soft ceiling. Every term above peaks at a grazing angle and they
           // stack; without a rolloff a facet on the silhouette sums past ten
           // and the shard is a white blob wearing the bloom pass.
           glow /= 1.0 + glow * 0.28;

           totalEmissiveRadiance += glow;
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.rend;
    const g = settings.global;

    uniforms.uColorBody.value.copy(getColor(c.colorShardBody));
    uniforms.uColorFacet.value.copy(getColor(c.colorShardFacet));
    uniforms.uColorWarm.value.copy(getColor(c.colorShardWarm));
    uniforms.uColorCold.value.copy(getColor(c.colorShardCold));
    uniforms.uColorVein.value.copy(getColor(c.colorShardVein));
    uniforms.uColorHot.value.copy(getColor(c.colorShardHot));
    uniforms.uColorBeam.value.copy(getColor(c.colorPillarBody));

    uniforms.uFresnel.value = c.shardFresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.shardFresnelPower;
    uniforms.uVein.value = c.shardVein * g.shaderIntensity;
    uniforms.uVeinScale.value = c.shardVeinScale * g.noiseFrequency;
    uniforms.uVeinSharp.value = c.shardVeinSharp;
    uniforms.uSpine.value = c.shardSpine * g.shaderIntensity;
    uniforms.uSpinePower.value = c.shardSpinePower;
    uniforms.uGlint.value = c.shardGlint * g.shaderIntensity;
    uniforms.uGlintScale.value = c.shardGlintScale;
    uniforms.uHeatGlow.value = c.shardHeatGlow;
    uniforms.uBeamGlow.value = c.shardBeamBleed;
    uniforms.uBeamRadius.value = c.shardBeamRadius;
    uniforms.uGlow.value = g.glow;

    material.roughness = c.shardRoughness;
    material.metalness = c.shardMetalness;
    material.envMapIntensity = c.shardEnvIntensity;
  };

  material.userData.sync();
  return material;
}
