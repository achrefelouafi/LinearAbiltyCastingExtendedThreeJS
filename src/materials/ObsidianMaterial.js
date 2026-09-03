import { MeshStandardMaterial, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Volcanic glass with the melt still trapped inside it — the monoliths the ward
 * heaves up out of the floor.
 *
 * Built on MeshStandardMaterial rather than a raw ShaderMaterial for the same
 * reason the meteor and the ice are: these are *solid*, so they cast and receive
 * the stage's real shadows, sit in the depth prepass (which is what lets the
 * membrane, the smoke and the embers soft-fade against them) and pick up the HDR
 * probe. The stylisation is injected on top.
 *
 * **The sub-surface read is the whole point of this file.** The veins are not
 * drawn on the surface: the field is sampled twice along the *view ray*, at two
 * depths behind the fragment, so what you see slides as the camera moves — the
 * parallax you get looking into a piece of glass with something suspended in it.
 * A surface-sampled vein is welded to the silhouette and always reads as paint.
 * Two further things sell it:
 *
 *   - the veins are weighted by `n·v`, so they are strong where you look *into*
 *     a face and almost gone at grazing angles, which is how depth in a
 *     translucent solid actually behaves;
 *   - the field is sampled in **world space**, so every slab in the ring looks
 *     quarried out of the same block instead of each carrying its own private
 *     copy of the same pattern.
 *
 * `uFlashY` is a height in metres that climbs the slabs once per heartbeat: the
 * "sub-surface vein flash". It is driven from `WardAbility` off the same
 * envelope the membrane and the runes use, so the ring lights from the bottom up
 * in time with everything else.
 *
 * Per-instance inputs arrive as instanced attributes (`aSeed`), so this material
 * is only ever used on an InstancedMesh.
 */
export function createObsidianMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.24,
    metalness: 0.0,
    // Faceted: conchoidal fracture is what makes a lump of glass read as
    // obsidian rather than as a smooth dark pebble.
    flatShading: true,
    // The slabs are heaved through the floor and shear off at the base, so the
    // wedge is an open shell: culling the far wall left the ones tipped away
    // from the camera looking hollow. The veins are read along the view ray,
    // which is exactly the term that needs the back wall to be there.
    side: DoubleSide
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorRock: { value: new Color() },
    uColorChar: { value: new Color() },
    uColorVein: { value: new Color() },
    uColorVeinCore: { value: new Color() },
    uVeinScale: { value: 2.3 },
    uVeinWidth: { value: 0.075 },
    uVeinBranches: { value: 0.62 },
    uVeinDepth: { value: 0.28 },
    uVeinGlow: { value: 3.6 },
    uVeinFlow: { value: 0.8 },
    uVeinFlowSpeed: { value: 0.9 },
    uFlashY: { value: -10 },
    uFlashWidth: { value: 1.0 },
    uFlashGain: { value: 2.2 },
    uFacetTint: { value: 0.42 },
    uCavity: { value: 0.4 },
    uRimLight: { value: 0.9 },
    uFade: { value: 1 },
    uGlow: { value: 1 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         varying vec3  vObsLocal;
         varying vec3  vObsWorld;
         varying float vObsSeed;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vObsLocal = transformed;
         vObsSeed = aSeed;
         #ifdef USE_INSTANCING
           vObsWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vObsWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorRock;
         uniform vec3  uColorChar;
         uniform vec3  uColorVein;
         uniform vec3  uColorVeinCore;
         uniform float uVeinScale;
         uniform float uVeinWidth;
         uniform float uVeinBranches;
         uniform float uVeinDepth;
         uniform float uVeinGlow;
         uniform float uVeinFlow;
         uniform float uVeinFlowSpeed;
         uniform float uFlashY;
         uniform float uFlashWidth;
         uniform float uFlashGain;
         uniform float uFacetTint;
         uniform float uCavity;
         uniform float uRimLight;
         uniform float uFade;
         uniform float uGlow;
         varying vec3  vObsLocal;
         varying vec3  vObsWorld;
         varying float vObsSeed;
         ${noiseGLSL}

         /**
          * How much vein is at q, and how close to its middle.
          *
          * The vein is the zero crossing of an fbm field — the same construction
          * the meteor's lava seams use, because it is what a fracture actually
          * looks like: meandering, forked, never a scratch. A second, finer
          * octave supplies the twigs.
          *
          * Returns x = the vein, y = its hot middle.
          */
         vec2 veinField(vec3 q) {
           float f1 = fbm3(q * uVeinScale);
           float f2 = fbm3(q * uVeinScale * 2.7 + 11.3);
           float d = min(abs(f1), abs(f2) / max(uVeinBranches, 0.05));
           float body = 1.0 - smoothstep(uVeinWidth * 0.4, uVeinWidth, d);
           float core = 1.0 - smoothstep(0.0, uVeinWidth * 0.4, d);
           return vec2(body, core);
         }`
      )
      // Injected once the normal is resolved: with `flatShading` there is no
      // `vNormal` varying, so the view-dependent terms have to read the face
      // normal that <normal_fragment_begin> derives from screen derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
           float rim = pow(1.0 - ndv, 2.4);

           /* --- the glass --- */
           float mottle = fbm3(vObsLocal * 3.6 + vObsSeed * 31.0) * 0.5 + 0.5;
           vec3  rock   = mix(uColorRock, uColorChar, smoothstep(0.25, 0.9, mottle));

           // Per-facet value break-up. The geometric normal in object space is
           // constant across a triangle, so hashing it gives every flat face its
           // own shade — the thing that separates cut stone from a noise-painted
           // ball, and it costs two derivatives.
           vec3  faceN = normalize(cross(dFdx(vObsLocal), dFdy(vObsLocal)));
           float facet = hash13(faceN * 37.0 + vObsSeed + 0.5);
           rock *= 1.0 + (facet - 0.5) * uFacetTint;

           // Cheap curvature occlusion: cut faces sit closer to the axis than
           // the shoulders do, so radius doubles as a cavity term.
           float cavity = smoothstep(0.35, 0.9, length(vObsLocal.xz) * 2.0);
           rock *= mix(1.0 - uCavity, 1.0, cavity);
           rock *= mix(0.5, 1.15, ndv);
           diffuseColor.rgb *= rock;

           /* --- what is trapped in it --- */
           // Sampled along the view ray at two depths: the melt is *behind* the
           // surface, so it has to slide as the camera moves. This is the whole
           // sub-surface read.
           vec3 V = normalize(cameraPosition - vObsWorld);
           vec2 near = veinField(vObsWorld - V * uVeinDepth * 0.55);
           vec2 far  = veinField(vObsWorld - V * uVeinDepth * 1.5 + vec3(7.1, 3.3, 5.9));

           float veins = near.x + far.x * 0.45;
           float core  = near.y + far.y * 0.3;
           // Strong looking into a face, nearly gone at a grazing angle: depth
           // in a translucent solid, rather than a pattern on its skin.
           veins *= mix(0.28, 1.0, ndv);
           core  *= mix(0.28, 1.0, ndv);

           // The melt crawls inside the vein rather than sitting still.
           float pulse = snoise(vObsWorld * 2.2 + vec3(0.0, uTime * uVeinFlowSpeed, 0.0) + vObsSeed * 7.0);
           veins *= mix(1.0, 0.4 + 0.8 * (pulse * 0.5 + 0.5), uVeinFlow);

           // The heartbeat, climbing the slab as a band of light.
           float wave = exp(-pow((vObsWorld.y - uFlashY) / max(uFlashWidth, 0.05), 2.0)) * uFlashGain;

           vec3 glow = mix(uColorVein, uColorVeinCore, clamp(core, 0.0, 1.0));
           glow *= veins * uVeinGlow * (1.0 + wave);
           // A sheath of heat around the silhouette — the slab is standing in a
           // pool of melt, and its edges catch it.
           glow += uColorVein * rim * uRimLight * (0.35 + wave * 0.65);

           glow *= uGlow * uFade;
           // The same soft ceiling the meteor uses: these terms are independent
           // and stack, and without it a vein crossing the rim sums past ten and
           // the bloom pass smears the slab into a white blob.
           glow /= 1.0 + glow * 0.22;

           totalEmissiveRadiance += glow;
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /**
   * Pull the palette and every shading control from the live settings.
   *
   * @param {object} state { flashY, fade }
   */
  material.userData.sync = (state) => {
    const c = settings.ward;
    const g = settings.global;

    uniforms.uColorRock.value.copy(getColor(c.colorObsidian));
    uniforms.uColorChar.value.copy(getColor(c.colorObsidianChar));
    uniforms.uColorVein.value.copy(getColor(c.colorVein));
    uniforms.uColorVeinCore.value.copy(getColor(c.colorVeinCore));

    uniforms.uVeinScale.value = c.veinScale * g.noiseFrequency;
    uniforms.uVeinWidth.value = c.veinWidth;
    uniforms.uVeinBranches.value = c.veinBranches;
    uniforms.uVeinDepth.value = c.veinDepth;
    uniforms.uVeinGlow.value = c.veinGlow * g.shaderIntensity;
    uniforms.uVeinFlow.value = c.veinFlow;
    uniforms.uVeinFlowSpeed.value = c.veinFlowSpeed * g.noiseSpeed;
    uniforms.uFlashY.value = state.flashY;
    uniforms.uFlashWidth.value = c.flashWidth;
    uniforms.uFlashGain.value = c.veinFlash;
    uniforms.uFacetTint.value = c.facetTint * g.randomness;
    uniforms.uCavity.value = c.cavity;
    uniforms.uRimLight.value = c.rimLight * g.fresnel;
    uniforms.uFade.value = state.fade;
    uniforms.uGlow.value = c.obsidianGlow * g.glow;

    material.roughness = c.glassRough;
    material.envMapIntensity = c.envIntensity;
  };

  material.userData.sync({ flashY: -10, fade: 1 });
  return material;
}
