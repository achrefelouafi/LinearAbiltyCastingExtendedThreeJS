import { MeshStandardMaterial, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The floor coming apart — layer 4 of the breakdown.
 *
 * Shades and *animates* the Voronoi plate from `assets/ShatterGeometry.js`. The
 * geometry is a flat unit disc cut into slabs and never changes; every frame of
 * the break happens here, in the vertex stage, from six uniforms:
 *
 *   - `uGrown` — the fracture racing out from the middle. Each slab compares it
 *     against its own radius, so the plate breaks outward in a ring instead of
 *     the whole disc popping at once, which is the single thing that sells it
 *     as a *break* rather than a prop being switched on.
 *   - `uGap` — every slab shrinks toward its own centroid, opening the seams.
 *     Shrinking rather than translating is what keeps the pattern coherent: the
 *     pieces still obviously came from one plate.
 *   - `uHeave` / `uTilt` — lifted and canted about an axis through that same
 *     centroid, hardest in the middle where the spike came through.
 *   - `uSink` — the whole thing withdrawing at the end of the cast.
 *
 * Because a slab pivots about its centroid, `objectNormal` has to take the same
 * rotation or the lighting stays flat while the geometry tips — which reads as
 * a printed texture sliding under a light. `shatterFrame` is therefore computed
 * twice, once for the normal and once for the position, rather than passed
 * between the two chunks: three's include order gives us no varying to carry it
 * in, and the maths is a dozen instructions.
 *
 * ## Shadows and the depth prepass
 *
 * The plate does not cast. three builds the shadow depth material from the
 * *material*, not from this patch, so a casting plate would throw the shadow of
 * the undeformed flat disc — a hard dark circle on the floor. The same is true
 * of the soft-particle depth prepass, but there the error is only the few
 * centimetres a slab has lifted, which is invisible; the shadow would not be.
 * What matters visually is the *gems* casting onto the plate, and they do.
 */
export function createShatterStoneMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0.0,
    flatShading: true,
    side: DoubleSide
  });

  const uniforms = {
    uTime: frame.uTime,
    uGrown: { value: 0 },
    uGap: { value: 0.06 },
    uHeave: { value: 0.07 },
    uTilt: { value: 0.35 },
    uSink: { value: 0 },
    uDepth: { value: 0.085 },
    uSeamGlow: { value: 2.2 },
    uSeamReach: { value: 0.12 },
    uGrain: { value: 0.6 },
    uGrainScale: { value: 7.0 },
    uSpeck: { value: 0.35 },
    uLipLight: { value: 0.4 },
    uFade: { value: 1 },
    uColorStone: { value: new Color(0.55, 0.54, 0.52) },
    uColorStoneDark: { value: new Color(0.22, 0.21, 0.21) },
    uColorSeam: { value: new Color(0.5, 1.0, 0.2) },
    uColorStain: { value: new Color(0.35, 0.55, 0.15) }
  };

  /**
   * The per-slab rigid motion, shared by the normal and the position.
   * Returns the rotation as an axis/angle plus the lift, all in unit space.
   */
  const FRAME_FN = /* glsl */ `
    #define SHATTER_TAU 6.283185307179586

    void shatterFrame(out vec3 axis, out float ang, out float lift, out float open) {
      vec2  c      = aCell.xy;
      float radial = length(c);

      // The fracture front, in unit radius. A slab is still whole until the
      // front has passed its centroid, and takes a moment to let go after.
      open = smoothstep(radial - 0.26, radial + 0.05, uGrown);

      // Hardest in the middle, where the surge came through; the lip barely
      // moves, which is what keeps the plate reading as attached to the floor.
      float profile = 1.0 - smoothstep(0.1, 1.0, radial);

      float yaw = aRand.z * SHATTER_TAU;
      axis = vec3(cos(yaw), 0.0, sin(yaw));
      ang  = uTilt * (aRand.y * 2.0 - 1.0) * open * profile;
      lift = uHeave * (0.2 + 0.8 * aRand.x) * open * profile;
    }

    vec3 shatterRotate(vec3 v, vec3 axis, float ang) {
      float s = sin(ang);
      float c = cos(ang);
      return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
    }
  `;

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3  aCell;
         attribute vec3  aRand;
         attribute float aEdge;
         attribute float aWall;

         uniform float uGrown;
         uniform float uGap;
         uniform float uHeave;
         uniform float uTilt;
         uniform float uSink;
         uniform float uDepth;

         varying vec3  vStoneWorld;
         varying vec3  vStoneRand;
         varying float vStoneEdge;
         varying float vStoneWall;
         varying float vStoneDepth;
         varying float vStoneOpen;

         ${FRAME_FN}`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         {
           vec3 axis; float ang; float lift; float open;
           shatterFrame(axis, ang, lift, open);
           objectNormal = shatterRotate(objectNormal, axis, ang);
         }`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec3 axis; float ang; float lift; float open;
           shatterFrame(axis, ang, lift, open);

           vec2  c     = aCell.xy;
           // Shrink toward the slab's own centroid: the seams open, and the
           // mosaic still obviously came from one plate.
           vec2  local = (transformed.xz - c) * (1.0 - uGap * (0.5 + 0.95 * aRand.x));

           vec3 v = vec3(local.x, transformed.y, local.y);
           v = shatterRotate(v, axis, ang);

           transformed = vec3(c.x + v.x, v.y + lift - uSink * (uDepth * 4.0 + 0.35), c.y + v.z);

           vStoneEdge  = aEdge;
           vStoneWall  = aWall;
           vStoneRand  = aRand;
           vStoneOpen  = open;
           // 0 at the surface, 1 at the bottom of the exposed wall.
           vStoneDepth = clamp(-position.y / max(uDepth, 1e-4), 0.0, 1.0);
           vStoneWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         }`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform float uSeamGlow;
         uniform float uSeamReach;
         uniform float uGrain;
         uniform float uGrainScale;
         uniform float uSpeck;
         uniform float uLipLight;
         uniform float uFade;
         uniform vec3  uColorStone;
         uniform vec3  uColorStoneDark;
         uniform vec3  uColorSeam;
         uniform vec3  uColorStain;

         varying vec3  vStoneWorld;
         varying vec3  vStoneRand;
         varying float vStoneEdge;
         varying float vStoneWall;
         varying float vStoneDepth;
         varying float vStoneOpen;

         ${noiseGLSL}`
      )
      // Broken rock is rougher than the weathered face it was part of.
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = mix(roughnessFactor, min(1.0, roughnessFactor + 0.12), vStoneWall);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           // At a grazing angle one pixel covers tens of centimetres of floor,
           // and every fine term resolves to a random value in its neighbour —
           // which aliases into a bolt of white speckle lying across the plate.
           // Fade the fine detail as the pixel outgrows it; the mip chain a
           // texture would have had.
           float footprint = max(fwidth(vStoneWorld.x), fwidth(vStoneWorld.z));
           float detail    = 1.0 - smoothstep(0.02, 0.13, footprint);

           float grain = fbm3(vStoneWorld * uGrainScale + vStoneRand.x * 31.0);
           float speck = snoise(vStoneWorld * uGrainScale * 5.0) * 0.5 + 0.5;

           vec3 stone = mix(uColorStone, uColorStoneDark, smoothstep(0.3, 0.72, grain) * uGrain);
           // Slab-to-slab value variation. Without it the plate reads as one
           // rock with lines drawn on it rather than as separate pieces.
           stone *= 0.82 + 0.36 * vStoneRand.y;
           stone *= 1.0 + (speck - 0.5) * uSpeck * detail;

           // The exposed wall is the inside of the stone: unweathered, and in
           // deep shade at the bottom of the crack.
           stone = mix(stone, stone * 1.14, vStoneWall * uLipLight);
           stone *= mix(1.0, 0.28, vStoneWall * vStoneDepth);

           // Venom that has run down into the break and stained the rock.
           float stain = smoothstep(0.35, 1.0, vStoneDepth) * vStoneWall;
           stain += (1.0 - smoothstep(0.0, uSeamReach, vStoneEdge)) * (1.0 - vStoneWall) * 0.55;
           stone = mix(stone, uColorStain, clamp(stain, 0.0, 1.0) * 0.5);

           diffuseColor.rgb *= stone;

           /* --- the light coming up out of the crack --------------------- */
           // Brightest at the bottom of the wall, where the source is, and
           // spilling a little way over the lip onto the top face.
           float wall = vStoneWall * pow(vStoneDepth, 0.7);
           float lip  = (1.0 - vStoneWall) * (1.0 - smoothstep(0.0, uSeamReach, vStoneEdge));

           // The seam breathes rather than sitting at a fixed value: fluid is
           // moving down there.
           float breathe = 0.72 + 0.28 * sin(uTime * 3.1 + vStoneRand.z * 21.0);

           vec3 glow = uColorSeam * (wall * 1.0 + lip * 0.55) * uSeamGlow * breathe;
           glow *= vStoneOpen * uFade;
           glow /= 1.0 + glow * 0.3;

           totalEmissiveRadiance += glow;
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /**
   * Pull the live settings.
   * @param {object} state per-plate values the settings cannot know
   */
  material.userData.sync = (state) => {
    const c = settings.venom;
    const g = settings.global;

    uniforms.uGrown.value = state.grown;
    uniforms.uSink.value = state.sink;
    uniforms.uFade.value = state.fade;
    uniforms.uDepth.value = c.slabDepth;

    uniforms.uGap.value = c.slabGap;
    uniforms.uHeave.value = c.slabHeave;
    uniforms.uTilt.value = c.slabTilt;
    uniforms.uSeamGlow.value = c.seamGlow * g.glow * g.shaderIntensity;
    uniforms.uSeamReach.value = c.seamReach;
    uniforms.uGrain.value = c.stoneGrain;
    uniforms.uGrainScale.value = c.stoneGrainScale * g.noiseFrequency;
    uniforms.uSpeck.value = c.stoneSpeck;
    uniforms.uLipLight.value = c.stoneLip;

    uniforms.uColorStone.value.copy(getColor(c.colorStone));
    uniforms.uColorStoneDark.value.copy(getColor(c.colorStoneDark));
    uniforms.uColorSeam.value.copy(getColor(c.colorSeam));
    uniforms.uColorStain.value.copy(getColor(c.colorStain));
  };

  return material;
}
