import { MeshStandardMaterial, Color } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Procedurally shaded rock.
 *
 * Built on MeshStandardMaterial so erupting boulders cast and receive the
 * scene's cascaded shadows and pick up the HDR environment — the stylisation
 * (strata, moss on upward faces, hot glow in the fresh cracks) is injected.
 */
export function createRockMaterial(environment, mossAmount = 1) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.02,
    flatShading: true
  });

  const uniforms = {
    uColorRock: { value: getColor(settings.earth.colorRock).clone() },
    uColorDark: { value: getColor(settings.earth.colorRockDark).clone() },
    uColorMoss: { value: getColor(settings.earth.colorMoss).clone() },
    uGlowColor: { value: new Color(1, 0.45, 0.12) },
    uGlow: { value: 0 },
    // Ground plates lie flat, so the upward-facing moss term would otherwise
    // cover every one of them completely.
    uMoss: { value: mossAmount }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vRockWorld;
         varying vec3 vRockLocal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vRockLocal = transformed;
         #ifdef USE_INSTANCING
           vRockWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vRockWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uColorRock;
         uniform vec3 uColorDark;
         uniform vec3 uColorMoss;
         uniform vec3 uGlowColor;
         uniform float uGlow;
         uniform float uMoss;
         varying vec3 vRockWorld;
         varying vec3 vRockLocal;
         ${noiseGLSL}`
      )
      // Injected after the normal is resolved: with `flatShading` there is no
      // `vNormal` varying, so the moss term has to read the face normal that
      // <normal_fragment_begin> derives from screen-space derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           // Strata and grain.
           float strata = snoise01(vRockLocal * vec3(2.0, 9.0, 2.0));
           float grain = fbm3(vRockWorld * 5.5) * 0.5 + 0.5;
           vec3 rock = mix(uColorDark, uColorRock, strata * 0.6 + grain * 0.5);

           // Moss clings to upward-facing surfaces.
           vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
           float upness = clamp(dot(normalize(normal), upView), 0.0, 1.0);
           float moss = smoothstep(0.55, 0.95, upness) * smoothstep(0.35, 0.7, grain);
           rock = mix(rock, uColorMoss, moss * 0.65 * uMoss);

           // A thin seam of heat where the rock was torn out of the ground.
           // Keep the threshold tight: a wide band turns the boulders into
           // glowing tiger stripes.
           float crack = smoothstep(0.90, 0.99, 1.0 - abs(strata - 0.5) * 2.0);
           diffuseColor.rgb *= rock;
           totalEmissiveRadiance += uGlowColor * crack * uGlow;
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /** Refresh the palette from the editor. */
  material.userData.sync = (glow = 0) => {
    uniforms.uColorRock.value.copy(getColor(settings.earth.colorRock));
    uniforms.uColorDark.value.copy(getColor(settings.earth.colorRockDark));
    uniforms.uColorMoss.value.copy(getColor(settings.earth.colorMoss));
    uniforms.uGlowColor.value.copy(getColor(settings.earth.lightColor));
    uniforms.uGlow.value = glow * settings.earth.glow * settings.global.glow;
  };

  return material;
}
