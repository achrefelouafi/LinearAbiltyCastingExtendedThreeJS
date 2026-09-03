import { MeshStandardMaterial, Color, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Burning rock — the meteor and the chunks it breaks into.
 *
 * Built on MeshStandardMaterial rather than a raw ShaderMaterial for the same
 * reason the ice is: the rock is *solid*, so it has to cast and receive the
 * stage's real shadows and pick up the HDR probe. The stylisation is injected on
 * top:
 *
 *   - **lava seams** — the signature. Cracks are the zero crossing of an fbm
 *     field: `1 - smoothstep(0, width, abs(fbm))` draws a thin, branching sheet
 *     wherever the noise changes sign, which is what a fracture actually looks
 *     like — meandering and forked, never a scratch. A second, finer octave
 *     adds the twigs that split off the main seams.
 *   - **the field is sampled in LOCAL space**, so the cracks are welded to the
 *     rock and tumble with it. Sampling in world space (as the ice fracture
 *     does, deliberately, so a whole field looks quarried from one block) would
 *     make the seams swim across a spinning meteor and instantly read as fake.
 *   - **soot** — the rock is charred in a halo either side of every seam, which
 *     is what keeps the glow from looking painted on.
 *   - **charge** — `uCharge` runs 0 → 1 as the meteor bears down on its target.
 *     It widens and brightens the seams, so the rock visibly heats up on the way
 *     in and the explosion is something you saw coming.
 *   - **leading-face heat** — the facets pointing along the direction of travel
 *     take the compression heat and go white; the trailing side stays dark.
 *   - **per-chunk cooling** — `aHeat` is driven from 1 to 0 per instance, so the
 *     debris thrown out of the impact dims as it lands.
 *
 * Per-instance inputs arrive as instanced attributes (`aSeed`, `aHeat`), so this
 * material is only ever used on an InstancedMesh.
 */
export function createMeteorMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    // Faceted, like the crystals: it is what makes a low-poly rock read as rock
    // rather than as a smooth ball with a texture on it.
    flatShading: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorRock: { value: new Color() },
    uColorChar: { value: new Color() },
    uColorCrack: { value: new Color() },
    uColorHot: { value: new Color() },
    uCrackScale: { value: 2.4 },
    uCrackWidth: { value: 0.1 },
    uCrackBranches: { value: 0.65 },
    uCrackGlow: { value: 3.2 },
    uFlow: { value: 0.7 },
    uFlowSpeed: { value: 0.9 },
    uRockScale: { value: 3.4 },
    uFacetTint: { value: 0.35 },
    uCavity: { value: 0.45 },
    uSoot: { value: 0.8 },
    uRimHeat: { value: 1.1 },
    uLead: { value: 1.6 },
    uLeadSharp: { value: 2.6 },
    /** Unit heading of the meteor, world space — drives the leading-face heat. */
    uHeading: { value: new Vector3(0, 0, 1) },
    uCharge: { value: 0 },
    uGlow: { value: 1 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aHeat;
         varying vec3  vRockLocal;
         varying vec3  vRockNormalW;
         varying float vRockSeed;
         varying float vRockHeat;`
      )
      // `objectNormal` is declared by <beginnormal_vertex>, which runs before
      // this chunk; three only ever takes it into *view* space, and the
      // leading-face term needs it in world space.
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vRockLocal = transformed;
         vRockSeed = aSeed;
         vRockHeat = aHeat;
         #ifdef USE_INSTANCING
           vRockNormalW = normalize(mat3(modelMatrix) * (instanceMatrix * vec4(objectNormal, 0.0)).xyz);
         #else
           vRockNormalW = normalize(mat3(modelMatrix) * objectNormal);
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorRock;
         uniform vec3  uColorChar;
         uniform vec3  uColorCrack;
         uniform vec3  uColorHot;
         uniform float uCrackScale;
         uniform float uCrackWidth;
         uniform float uCrackBranches;
         uniform float uCrackGlow;
         uniform float uFlow;
         uniform float uFlowSpeed;
         uniform float uRockScale;
         uniform float uFacetTint;
         uniform float uCavity;
         uniform float uSoot;
         uniform float uRimHeat;
         uniform float uLead;
         uniform float uLeadSharp;
         uniform vec3  uHeading;
         uniform float uCharge;
         uniform float uGlow;
         varying vec3  vRockLocal;
         varying vec3  vRockNormalW;
         varying float vRockSeed;
         varying float vRockHeat;
         ${noiseGLSL}`
      )
      // Injected once the normal is resolved: with `flatShading` there is no
      // `vNormal` varying, so the view-dependent terms have to read the face
      // normal <normal_fragment_begin> derives from screen-space derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
           float rim = pow(1.0 - ndv, 2.2);

           /*
            * The seam, as a cross-section rather than as a line.
            *
            * "distance" is how far this fragment is from the nearest zero
            * crossing of the crack field, and the three bands cut out of it are
            * what make the crack read as a *split in stone* instead of a bright
            * worm painted over it:
            *
            *   fissure — the open gap. There is no rock here, so the albedo is
            *             killed and only the magma below shows.
            *   lip     — a much wider charred band either side of it. A crack is
            *             a shadow first and a light second; without this the
            *             glow just sits on top of the surface.
            *   core    — the middle of the gap, the only part hot enough to run
            *             white.
            *
            * Local space throughout, so the whole network is welded to the rock
            * and tumbles with it.
            */
           vec3  p  = vRockLocal * uCrackScale + vRockSeed * 19.0;
           float f1 = fbm3(p);
           float f2 = fbm3(p * 2.7 + 11.3);

           // The charge prises the seams open as the meteor heats up.
           float width = max(0.004, uCrackWidth * (1.0 + uCharge * 0.8));
           float distance = min(abs(f1), abs(f2) / max(uCrackBranches, 0.05));

           float fissure = 1.0 - smoothstep(width * 0.35, width, distance);
           float lip     = 1.0 - smoothstep(width, width * 2.0, distance);
           float core    = 1.0 - smoothstep(0.0, width * 0.45, distance);

           // Magma is not static: brightness crawls along the inside of a seam.
           float pulse = snoise(vRockLocal * 4.0 + vec3(0.0, uTime * uFlowSpeed, 0.0) + vRockSeed * 7.0);
           float flow  = mix(1.0, 0.45 + 0.75 * (pulse * 0.5 + 0.5), uFlow);

           /* --- the rock itself --- */
           float mottle = fbm3(vRockLocal * uRockScale + vRockSeed * 31.0) * 0.5 + 0.5;
           vec3  rock   = mix(uColorRock, uColorChar, smoothstep(0.3, 0.85, mottle));

           // Per-facet value break-up. The geometric normal in *object* space is
           // constant across a triangle, so hashing it gives every flat face its
           // own shade — the thing that separates cut stone from a noise-painted
           // ball, and it costs two derivatives.
           vec3  faceN = normalize(cross(dFdx(vRockLocal), dFdy(vRockLocal)));
           float facet = hash13(faceN * 37.0 + vRockSeed + 0.5);
           rock *= 1.0 + (facet - 0.5) * uFacetTint;

           // Cheap curvature occlusion: craters and cut faces sit closer to the
           // centre than the lumps do, so radius doubles as a cavity term.
           float cavity = smoothstep(0.55, 1.0, length(vRockLocal));
           rock *= mix(1.0 - uCavity, 1.0, cavity);

           // Charred around every seam, and gone entirely inside one.
           rock = mix(rock, uColorChar, lip * uSoot);
           rock *= 1.0 - fissure * 0.92;

           // Hard lighting contrast across the facets, so the silhouette reads
           // as a bundle of planes rather than one smooth mass.
           rock *= mix(0.55, 1.15, ndv);
           diffuseColor.rgb *= rock;

           /* --- what is burning --- */
           // The gap is the only thing that emits, and only its middle runs
           // white. Everything else is rock.
           float heat = fissure * flow * vRockHeat;
           vec3  glow = mix(uColorCrack, uColorHot, core * core) * heat * uCrackGlow;

           // A sheath of heat around the silhouette, and the compression heat on
           // the leading facets. Both are squared against the charge: at launch
           // this is a cold rock with lit cracks, and it is only on the way down
           // that the whole thing starts to burn.
           float charge2 = uCharge * uCharge;
           glow += uColorCrack * rim * uRimHeat * vRockHeat * charge2;

           float lead = pow(clamp(dot(normalize(vRockNormalW), uHeading), 0.0, 1.0), uLeadSharp);
           glow += uColorHot * lead * uLead * vRockHeat * charge2;

           glow *= uGlow;

           // The same soft ceiling the ice uses: these terms are independent and
           // stack, and without it a seam crossing the rim sums past 10 and the
           // bloom pass smears the whole rock into a white blob.
           glow /= 1.0 + glow * 0.22;

           totalEmissiveRadiance += glow;
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /**
   * Pull the palette and every shading control from the live settings.
   * @param {number} charge 0..1 — how far into its run-up the meteor is
   * @param {THREE.Vector3} heading unit direction of travel, world space
   */
  material.userData.sync = (charge = 0, heading = null) => {
    const c = settings.meteor;
    const g = settings.global;

    uniforms.uColorRock.value.copy(getColor(c.colorRock));
    uniforms.uColorChar.value.copy(getColor(c.colorChar));
    uniforms.uColorCrack.value.copy(getColor(c.colorCrack));
    uniforms.uColorHot.value.copy(getColor(c.colorHot));

    uniforms.uCrackScale.value = c.crackScale * g.noiseFrequency;
    uniforms.uCrackWidth.value = c.crackWidth;
    uniforms.uCrackBranches.value = c.crackBranches;
    uniforms.uCrackGlow.value = c.crackGlow * g.shaderIntensity;
    uniforms.uFlow.value = c.crackFlow;
    uniforms.uFlowSpeed.value = c.crackFlowSpeed * g.noiseSpeed;
    uniforms.uRockScale.value = c.rockScale * g.noiseFrequency;
    uniforms.uFacetTint.value = c.facetTint * g.randomness;
    uniforms.uCavity.value = c.cavity;
    uniforms.uSoot.value = c.soot;
    uniforms.uRimHeat.value = c.rimHeat * g.fresnel;
    uniforms.uLead.value = c.leadGlow;
    uniforms.uLeadSharp.value = c.leadSharp;
    uniforms.uCharge.value = charge;
    uniforms.uGlow.value = c.glow * g.glow;

    if (heading) uniforms.uHeading.value.copy(heading);
    material.envMapIntensity = c.envIntensity;
  };

  material.userData.sync();
  return material;
}
