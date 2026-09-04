import { MeshStandardMaterial, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { getStoneTextures, STONE_TILE_METRES } from '../loaders/StoneTextures.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';

/**
 * The stone of the Monolith Rift — layers 1, 3 and 4 of the breakdown.
 *
 * Three materials, one surface model. All of them are a real `MeshStandardMaterial`
 * — sun, shadows, IBL, the whole physical stack — with a **triplanar projection
 * of the ambientCG Rock030 scan** patched over the map slots, plus the handful
 * of things a *blast* does to rock that a static texture cannot know about.
 *
 * ## Why triplanar rather than UVs
 *
 * Every piece of geometry here is either procedurally generated per cast or
 * stretched by a per-instance matrix that is different every time — a three
 * metre blade and a knee-high block come out of the same unit slab. Any UV set
 * baked into that would swim: the grain would stretch with the instance and a
 * tall slab would show a smeared rock while the block beside it showed a fine
 * one. Sampling in **world metres** off the world normal fixes the grain to
 * physical size, so every stone in the cluster is made of the same rock, and the
 * floor it came out of is made of it too.
 *
 * The cost is three texture fetches per map instead of one. At the instance
 * counts here that is nothing, and it buys the single thing the reference is
 * built on: the slabs have to look photographed.
 *
 * ## What is added on top of the scan
 *
 *   - **Cement dust settling.** `uDustCoat` climbs over the life of the cast and
 *     pales every up-facing surface, patchily, killing its roughness contrast
 *     and flattening its normal. Freshly erupted stone is clean and dark; a
 *     second later it is wearing the cloud. This is the difference between rocks
 *     standing in dust and rocks that were *in the explosion*.
 *   - **Fresh fracture.** `aFace` marks the faces that did not exist a moment
 *     ago. They are paler, rougher and unweathered, which is what separates a
 *     broken slab from a boulder.
 *   - **Damp root.** The bottom of a slab came from under the floor: darker,
 *     slightly less rough, and occluded.
 *
 * The three factories install *different* shaders, so each passes its own
 * `key` to `registerShadowCasterWithPatch` — see `utils/shaderPatch.js`.
 */

/* ---------------------------------------------------------------------- */
/* The shared surface model                                                */
/* ---------------------------------------------------------------------- */

const STONE_PARS = /* glsl */ `
  uniform sampler2D uAlbedoMap;
  uniform sampler2D uNormalMap;
  uniform sampler2D uRoughMap;
  uniform sampler2D uAOMap;
  uniform float uTexAmount;
  uniform float uTexScale;
  uniform float uNormalScale;
  uniform float uStoneRough;
  uniform float uStoneFloor;
  uniform float uStoneAO;
  uniform float uDustCoat;
  uniform float uDustSharp;
  uniform float uDustScale;
  uniform vec3  uColorStone;
  uniform vec3  uColorStoneDeep;
  uniform vec3  uColorDust;
  uniform vec3  uColorGrade;
  uniform float uDesat;
  uniform float uGrade;

  struct Stone {
    vec3  albedo;
    vec3  normal;   // world space
    float rough;
    float ao;
  };

  // Written by sampleStone in the map stage, read by the roughness, normal and
  // ambient-occlusion stages further down the shader. There is no varying to
  // carry them through, and repeating three texture fetches to recover them
  // would cost more than the globals do.
  float gStoneAO = 1.0;
  float gRoughness = 1.0;
  vec3  gStoneNormal = vec3(0.0, 1.0, 0.0);

  /**
   * Projection weights. A high power keeps the seams between the three planes
   * narrow, which matters on a slab: a soft blend across a vertical wall reads
   * as the grain fading out halfway up it.
   */
  vec3 triWeights(vec3 n) {
    vec3 b = pow(abs(n), vec3(6.0));
    return b / max(dot(b, vec3(1.0)), 1e-4);
  }

  vec3 triColor(sampler2D tex, vec3 p, vec3 w, float s) {
    return texture2D(tex, p.yz * s).rgb * w.x
         + texture2D(tex, p.zx * s).rgb * w.y
         + texture2D(tex, p.xy * s).rgb * w.z;
  }

  /**
   * Whiteout-blended triplanar normal: each projection is read as a tangent
   * space normal, swizzled into the orientation of its own plane, and summed by
   * the same weights the colour uses. Cheaper and steadier than building a real
   * tangent frame per plane, and on rock nobody can tell.
   */
  vec3 triNormal(sampler2D tex, vec3 p, vec3 n, vec3 w, float s, float strength) {
    vec3 nx = texture2D(tex, p.yz * s).xyz * 2.0 - 1.0;
    vec3 ny = texture2D(tex, p.zx * s).xyz * 2.0 - 1.0;
    vec3 nz = texture2D(tex, p.xy * s).xyz * 2.0 - 1.0;
    nx.xy *= strength;
    ny.xy *= strength;
    nz.xy *= strength;
    nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
    ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
    nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
    return normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
  }

  /**
   * The scan, projected onto a surface.
   *
   * uTexAmount is the loader's handshake: 0 until all four maps have landed,
   * and the procedural fallback carries the shading until they do. See
   * loaders/StoneTextures.js.
   */
  Stone sampleStone(vec3 wp, vec3 wn, float seed) {
    vec3 w = triWeights(wn);
    float s = uTexScale;

    Stone st;

    /* the procedural stand-in — broad value variation, no fine detail, so it
       never aliases while it is on screen */
    float macro = fbm3(wp * 0.6 + seed * 13.0) * 0.5 + 0.5;
    vec3 fallback = mix(uColorStoneDeep, uColorStone, smoothstep(0.25, 0.8, macro));

    vec3 sampled = triColor(uAlbedoMap, wp, w, s);
    st.albedo = mix(fallback, sampled, uTexAmount);

    float rough = triColor(uRoughMap, wp, w, s).r;
    st.rough = mix(0.92, rough, uTexAmount);

    float ao = triColor(uAOMap, wp, w, s).r;
    st.ao = mix(1.0, ao, uTexAmount);

    st.normal = mix(wn, triNormal(uNormalMap, wp, wn, w, s, uNormalScale), uTexAmount);

    // The scan is a *natural* rock and comes out faintly olive. Brutalist
    // concrete is neutral, so the albedo is pulled toward its own luminance and
    // then tinted — and the tint is normalised to unit luminance first, so it
    // shifts the hue and leaves the value alone. Grading after the sample
    // rather than editing the texture keeps this a live slider, and keeps the
    // floor (which uses the same maps, ungraded) reading as the same rock.
    float lum = dot(st.albedo, vec3(0.299, 0.587, 0.114));
    st.albedo = mix(st.albedo, vec3(lum), uDesat);
    vec3 tint = uColorGrade / max(1e-4, dot(uColorGrade, vec3(0.299, 0.587, 0.114)));
    st.albedo = mix(st.albedo, st.albedo * tint, uGrade);
    return st;
  }

  /**
   * Cement dust settling on a surface.
   *
   * Up-facing first, patchy, and gated on how much of the cloud has come down
   * yet. Returned as a coverage so the caller can pale the albedo, flatten the
   * normal and kill the roughness contrast with the one number.
   */
  float dustCoverage(vec3 wp, vec3 wn) {
    if (uDustCoat <= 0.001) return 0.0;
    float up = saturate(wn.y);
    float mottle = fbm3(wp * uDustScale) * 0.5 + 0.5;
    float face = pow(up, max(0.05, uDustSharp));
    return saturate(face * uDustCoat * (0.45 + 0.85 * mottle));
  }

  /** Apply that coverage to a sampled surface. Dust is pale, flat and matte. */
  void applyDust(inout Stone st, float coverage) {
    st.albedo = mix(st.albedo, uColorDust, coverage * 0.88);
    st.rough = mix(st.rough, 1.0, coverage * 0.8);
    st.normal = normalize(mix(st.normal, vec3(0.0, 1.0, 0.0), coverage * 0.35));
    st.ao = mix(st.ao, mix(st.ao, 1.0, 0.6), coverage);
  }
`;

/** Uniform block every one of the three materials shares. */
function stoneUniforms() {
  const textures = getStoneTextures();
  return {
    uTime: frame.uTime,
    uAlbedoMap: { value: textures.map },
    uNormalMap: { value: textures.normalMap },
    uRoughMap: { value: textures.roughnessMap },
    uAOMap: { value: textures.aoMap },
    uTexAmount: { value: 0 },
    uTexScale: { value: 1 / STONE_TILE_METRES },
    uNormalScale: { value: 1.35 },
    uStoneRough: { value: 1.0 },
    uStoneFloor: { value: 0.34 },
    uStoneAO: { value: 1.0 },
    uDustCoat: { value: 0 },
    uDustSharp: { value: 1.6 },
    uDustScale: { value: 1.4 },
    uColorStone: { value: new Color(0.62, 0.6, 0.57) },
    uColorStoneDeep: { value: new Color(0.24, 0.23, 0.22) },
    uColorDust: { value: new Color(0.78, 0.74, 0.68) },
    uColorGrade: { value: new Color(0.78, 0.77, 0.74) },
    uDesat: { value: 0.35 },
    uGrade: { value: 0.4 }
  };
}

/** Pull the settings every stone material shares. `amount` is the load gate. */
function syncStone(uniforms, c, g) {
  const textures = getStoneTextures();
  // Ease the scan in rather than popping it, in case the first cast of the
  // session goes off inside the couple of frames the JPEGs are still landing.
  const target = textures.state.amount * saturate(c.texAmount);
  uniforms.uTexAmount.value += (target - uniforms.uTexAmount.value) * 0.25;

  uniforms.uTexScale.value = 1 / Math.max(0.05, c.texScale);
  uniforms.uNormalScale.value = c.normalScale;
  uniforms.uStoneRough.value = c.stoneRough;
  // The scan's roughness map dips low enough in its crevices to put a wet,
  // glossy vein across a face at a grazing angle, which on a slab this size
  // reads as quartz rather than as concrete. Stone has a floor.
  uniforms.uStoneFloor.value = c.stoneRoughFloor;
  uniforms.uStoneAO.value = c.stoneAO;
  uniforms.uDustSharp.value = c.dustCoatSharp;
  uniforms.uDustScale.value = c.dustCoatScale * g.noiseFrequency;
  uniforms.uColorStone.value.copy(getColor(c.colorStone));
  uniforms.uColorStoneDeep.value.copy(getColor(c.colorStoneDeep));
  uniforms.uColorDust.value.copy(getColor(c.colorDustCoat));
  uniforms.uColorGrade.value.copy(getColor(c.colorStoneGrade));
  uniforms.uDesat.value = c.stoneDesat;
  uniforms.uGrade.value = c.stoneGrade;
}

/* ---------------------------------------------------------------------- */
/* 1 · the monoliths                                                       */
/* ---------------------------------------------------------------------- */

/**
 * The slabs themselves. Instanced, so the world position and world normal are
 * built through `instanceMatrix` by hand — three only carries them as far as
 * view space, and the triplanar projection needs world.
 *
 * The normal is divided by the squared instance basis lengths first, exactly as
 * three's own `defaultnormal_vertex` does: these instances are scaled hard and
 * non-uniformly (footprint one way, height the other), and without that
 * correction the chamfer of a tall slab would light as though it were lying
 * down.
 */
export function createMonolithMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    envMapIntensity: 1.0,
    side: DoubleSide
  });

  const uniforms = {
    ...stoneUniforms(),
    uBreakPale: { value: 0.45 },
    uDamp: { value: 0.55 },
    uDampHeight: { value: 0.22 },
    uGrime: { value: 0.5 },
    uColorDamp: { value: new Color(0.16, 0.15, 0.15) }
  };

  environment.registerShadowCasterWithPatch(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aFace;
           attribute float aUp;
           attribute float aSeed;

           varying vec3  vRiftWorld;
           varying vec3  vRiftNormal;
           varying float vRiftFace;
           varying float vRiftUp;
           varying float vRiftSeed;`
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
           {
             vec3 on = objectNormal;
             #ifdef USE_INSTANCING
               mat3 im = mat3(instanceMatrix);
               on /= vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
               on = im * on;
             #endif
             vRiftNormal = normalize(mat3(modelMatrix) * on);
           }`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           {
             vec4 wp = vec4(transformed, 1.0);
             #ifdef USE_INSTANCING
               wp = instanceMatrix * wp;
             #endif
             vRiftWorld = (modelMatrix * wp).xyz;
             vRiftFace = aFace;
             vRiftUp = aUp;
             vRiftSeed = aSeed;
           }`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3  vRiftWorld;
           varying vec3  vRiftNormal;
           varying float vRiftFace;
           varying float vRiftUp;
           varying float vRiftSeed;

           uniform float uBreakPale;
           uniform float uDamp;
           uniform float uDampHeight;
           uniform float uGrime;
           uniform vec3  uColorDamp;

           ${noiseGLSL}
           ${STONE_PARS}`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec3 wn = normalize(vRiftNormal);
             Stone st = sampleStone(vRiftWorld, wn, vRiftSeed);

             // Slab-to-slab value variation. Without it a cluster reads as one
             // rock that happens to be in pieces.
             st.albedo *= 0.78 + 0.44 * fract(vRiftSeed * 0.618 + 0.31);

             /* --- the faces that did not exist a second ago --------------- */
             // Unweathered stone is paler, flatter in colour and rougher; the
             // grime that darkens a exposed face has not reached it.
             float fresh = vRiftFace;
             vec3 pale = mix(st.albedo, vec3(dot(st.albedo, vec3(0.33))), 0.45) * 1.35;
             st.albedo = mix(st.albedo, pale, fresh * uBreakPale);
             st.rough = mix(st.rough, min(1.0, st.rough + 0.14), fresh);

             // ...and the weathering on the faces that did, which is a slow
             // vertical streaking rather than a wash.
             float streak = fbm3(vec3(vRiftWorld.xz * 2.6, vRiftWorld.y * 0.6)) * 0.5 + 0.5;
             st.albedo *= mix(1.0, 0.72 + 0.4 * streak, (1.0 - fresh) * uGrime);

             /* --- the root, which was under the floor -------------------- */
             float damp = 1.0 - smoothstep(0.0, max(0.02, uDampHeight), vRiftUp);
             st.albedo = mix(st.albedo, uColorDamp, damp * uDamp);
             st.rough = mix(st.rough, st.rough * 0.78, damp * uDamp);
             st.ao *= mix(1.0, 0.55, damp);

             /* --- and the cloud coming back down on all of it ------------ */
             applyDust(st, dustCoverage(vRiftWorld, wn));

             diffuseColor.rgb *= st.albedo;
             gStoneAO = mix(1.0, st.ao, uStoneAO);
             gStoneNormal = st.normal;
             gRoughness = st.rough;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = clamp(gRoughness * uStoneRough, uStoneFloor, 1.0);`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           normal = normalize((viewMatrix * vec4(gStoneNormal, 0.0)).xyz) * faceDirection;`
        )
        .replace(
          '#include <aomap_fragment>',
          `#include <aomap_fragment>
           reflectedLight.indirectDiffuse *= gStoneAO;
           reflectedLight.indirectSpecular *= mix(1.0, gStoneAO, 0.6);`
        );
    },
    'rift-monolith'
  );

  material.userData.uniforms = uniforms;

  /** @param {number} dustCoat 0..1 — how much of the cloud has settled */
  material.userData.sync = (dustCoat) => {
    const c = settings.quake;
    const g = settings.global;

    syncStone(uniforms, c, g);
    uniforms.uDustCoat.value = saturate(dustCoat) * c.dustCoat;
    uniforms.uBreakPale.value = c.breakPale;
    uniforms.uDamp.value = c.damp;
    uniforms.uDampHeight.value = c.dampHeight;
    uniforms.uGrime.value = c.grime;
    uniforms.uColorDamp.value.copy(getColor(c.colorDamp));
    material.envMapIntensity = c.envIntensity;
  };

  return material;
}

/* ---------------------------------------------------------------------- */
/* 3 · the shrapnel                                                        */
/* ---------------------------------------------------------------------- */

/**
 * The flying chunks. The same scan, sampled at the same physical scale — a
 * twenty centimetre block therefore shows twenty centimetres of rock, which is
 * the whole reason the debris does not read as gravel sprites.
 *
 * Deliberately darker than the slabs and with no dust coating: shrapnel is in
 * the air, it is seen against the cloud, and in the reference it is almost a
 * silhouette. Chunks that pale out into the dust behind them disappear.
 */
export function createDebrisMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    side: DoubleSide
  });

  const uniforms = {
    ...stoneUniforms(),
    uDarken: { value: 0.45 }
  };

  environment.registerShadowCasterWithPatch(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aSeed;
           varying vec3  vChipWorld;
           varying vec3  vChipNormal;
           varying float vChipSeed;`
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
           {
             vec3 on = objectNormal;
             #ifdef USE_INSTANCING
               mat3 im = mat3(instanceMatrix);
               on /= vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
               on = im * on;
             #endif
             vChipNormal = normalize(mat3(modelMatrix) * on);
           }`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           {
             vec4 wp = vec4(transformed, 1.0);
             #ifdef USE_INSTANCING
               wp = instanceMatrix * wp;
             #endif
             vChipWorld = (modelMatrix * wp).xyz;
             vChipSeed = aSeed;
           }`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3  vChipWorld;
           varying vec3  vChipNormal;
           varying float vChipSeed;
           uniform float uDarken;

           ${noiseGLSL}
           ${STONE_PARS}`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec3 wn = normalize(vChipNormal);
             Stone st = sampleStone(vChipWorld, wn, vChipSeed);
             // A block torn out of the ground is mostly fresh fracture, so the
             // per-chunk spread is wide: some are pale, some are almost black.
             st.albedo *= mix(0.45, 1.25, fract(vChipSeed * 0.618 + 0.11));
             st.albedo *= 1.0 - uDarken;
             diffuseColor.rgb *= st.albedo;
             gStoneAO = mix(1.0, st.ao, uStoneAO);
             gStoneNormal = st.normal;
             gRoughness = st.rough;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = clamp(gRoughness * uStoneRough, uStoneFloor, 1.0);`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           normal = normalize((viewMatrix * vec4(gStoneNormal, 0.0)).xyz) * faceDirection;`
        )
        .replace(
          '#include <aomap_fragment>',
          `#include <aomap_fragment>
           reflectedLight.indirectDiffuse *= gStoneAO;`
        );
    },
    'rift-debris'
  );

  material.userData.uniforms = uniforms;

  material.userData.sync = () => {
    const c = settings.quake;
    syncStone(uniforms, c, settings.global);
    uniforms.uDarken.value = c.shrapnelDarken;
    // Chips are small: the scan has to be read finer or every one of them is a
    // single flat patch of the same pixel.
    uniforms.uTexScale.value = 1 / Math.max(0.05, c.texScale * c.shrapnelTexScale);
    uniforms.uDustCoat.value = 0;
  };

  return material;
}

/* ---------------------------------------------------------------------- */
/* 4 · the crater floor                                                    */
/* ---------------------------------------------------------------------- */

/**
 * The floor coming apart at the impact.
 *
 * Shades and animates the Voronoi plate from `assets/ShatterGeometry.js` — the
 * same generator the Venom Surge cuts its plate with, and the reason it lives in
 * `assets/` rather than inside that ability. Everything below the geometry is
 * different: where the venom plate is lit from underneath by the fluid in the
 * seam, this one is *rock*, and the only light in the crack is the sky failing
 * to reach the bottom of it.
 *
 * The break is four uniforms in the vertex stage:
 *
 *   - `uGrown` — the fracture racing out from the middle. A slab compares it
 *     against its own radius, so the plate lets go in a ring rather than all at
 *     once, which is the single thing that reads as a break rather than a prop
 *     being switched on.
 *   - `uGap` — each slab shrinks toward its own centroid, opening the seams
 *     while keeping the mosaic obviously one plate.
 *   - `uHeave` / `uTilt` — lifted and canted about that same centroid, hardest
 *     in the middle where the monoliths came through.
 *
 * A slab pivots, so `objectNormal` has to take the same rotation — otherwise the
 * lighting stays flat while the geometry tips, which reads as a printed texture
 * sliding under a light. The rotated normal is also what the triplanar
 * projection samples along, so getting it wrong would additionally slide the
 * grain across the stone.
 */
export function createRiftCraterMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    side: DoubleSide
  });

  const uniforms = {
    ...stoneUniforms(),
    uGrown: { value: 0 },
    uGap: { value: 0.05 },
    uHeave: { value: 0.07 },
    uTilt: { value: 0.4 },
    uSink: { value: 0 },
    uDepth: { value: 0.09 },
    uWallDark: { value: 0.75 },
    uSeamDust: { value: 0.5 },
    uColorDamp: { value: new Color(0.13, 0.12, 0.12) }
  };

  /** The per-slab rigid motion, shared by the normal and the position. */
  const FRAME_FN = /* glsl */ `
    #define RIFT_TAU 6.283185307179586

    void riftFrame(out vec3 axis, out float ang, out float lift, out float open) {
      vec2  c      = aCell.xy;
      float radial = length(c);

      // A slab is whole until the front has passed its centroid, and takes a
      // moment to let go after it has.
      open = smoothstep(radial - 0.28, radial + 0.04, uGrown);

      // Hardest in the middle, where the slabs came up; the lip barely moves,
      // which is what keeps the plate attached to the floor around it.
      float profile = 1.0 - smoothstep(0.08, 1.0, radial);

      float yaw = aRand.z * RIFT_TAU;
      axis = vec3(cos(yaw), 0.0, sin(yaw));
      ang  = uTilt * (aRand.y * 2.0 - 1.0) * open * profile;
      lift = uHeave * (0.15 + 0.85 * aRand.x) * open * profile;
    }

    vec3 riftRotate(vec3 v, vec3 axis, float ang) {
      float s = sin(ang);
      float c = cos(ang);
      return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
    }
  `;

  environment.registerShadowCasterWithPatch(
    material,
    (shader) => {
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

           varying vec3  vRiftWorld;
           varying vec3  vRiftNormal;
           varying vec3  vRiftRand;
           varying float vRiftEdge;
           varying float vRiftWall;
           varying float vRiftDepth;
           varying float vRiftOpen;

           ${FRAME_FN}`
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
           {
             vec3 axis; float ang; float lift; float open;
             riftFrame(axis, ang, lift, open);
             objectNormal = riftRotate(objectNormal, axis, ang);
             vRiftNormal = normalize(mat3(modelMatrix) * objectNormal);
           }`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           {
             vec3 axis; float ang; float lift; float open;
             riftFrame(axis, ang, lift, open);

             vec2 c = aCell.xy;
             // Shrink toward the slab's own centroid: the seams open and the
             // mosaic still obviously came from one plate.
             vec2 local = (transformed.xz - c) * (1.0 - uGap * (0.5 + 0.95 * aRand.x));

             vec3 v = vec3(local.x, transformed.y, local.y);
             v = riftRotate(v, axis, ang);

             transformed = vec3(c.x + v.x, v.y + lift - uSink * (uDepth * 4.0 + 0.4), c.y + v.z);

             vRiftEdge  = aEdge;
             vRiftWall  = aWall;
             vRiftRand  = aRand;
             vRiftOpen  = open;
             // 0 at the surface, 1 at the bottom of the exposed wall.
             vRiftDepth = clamp(-position.y / max(uDepth, 1e-4), 0.0, 1.0);
             vRiftWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
           }`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3  vRiftWorld;
           varying vec3  vRiftNormal;
           varying vec3  vRiftRand;
           varying float vRiftEdge;
           varying float vRiftWall;
           varying float vRiftDepth;
           varying float vRiftOpen;

           uniform float uWallDark;
           uniform float uSeamDust;
           uniform vec3  uColorDamp;

           ${noiseGLSL}
           ${STONE_PARS}`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec3 wn = normalize(vRiftNormal);
             Stone st = sampleStone(vRiftWorld, wn, vRiftRand.x * 7.0);

             // Slab-to-slab variation, as on the monoliths.
             st.albedo *= 0.82 + 0.36 * vRiftRand.y;

             // The exposed wall is the inside of the stone: unweathered near the
             // lip, and in deep shade at the bottom of the crack. That gradient
             // is the entire reason a heaved plate reads as having depth.
             st.albedo = mix(st.albedo, st.albedo * 1.18, vRiftWall * 0.6);
             float shade = vRiftWall * pow(vRiftDepth, 0.65) * uWallDark;
             st.albedo = mix(st.albedo, uColorDamp, shade);
             st.ao *= 1.0 - shade * 0.8;
             st.rough = mix(st.rough, min(1.0, st.rough + 0.1), vRiftWall);

             // Powdered stone drifted along the seams and over the lips.
             float seam = (1.0 - smoothstep(0.0, 0.18, vRiftEdge)) * (1.0 - vRiftWall);
             st.albedo = mix(st.albedo, uColorDust, seam * uSeamDust * 0.5);

             applyDust(st, dustCoverage(vRiftWorld, wn));

             diffuseColor.rgb *= st.albedo;
             gStoneAO = mix(1.0, st.ao, uStoneAO);
             gStoneNormal = st.normal;
             gRoughness = st.rough;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = clamp(gRoughness * uStoneRough, uStoneFloor, 1.0);`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           normal = normalize((viewMatrix * vec4(gStoneNormal, 0.0)).xyz) * faceDirection;`
        )
        .replace(
          '#include <aomap_fragment>',
          `#include <aomap_fragment>
           reflectedLight.indirectDiffuse *= gStoneAO;
           reflectedLight.indirectSpecular *= mix(1.0, gStoneAO, 0.6);`
        );
    },
    'rift-crater'
  );

  material.userData.uniforms = uniforms;

  /**
   * @param {object} state per-plate values the settings cannot know
   * @param {number} dustCoat 0..1 — how much of the cloud has settled
   */
  material.userData.sync = (state, dustCoat) => {
    const c = settings.quake;
    const g = settings.global;

    syncStone(uniforms, c, g);
    uniforms.uDustCoat.value = saturate(dustCoat) * c.dustCoat;

    uniforms.uGrown.value = state.grown;
    uniforms.uSink.value = state.sink;
    uniforms.uDepth.value = c.plateDepth;
    uniforms.uGap.value = c.plateGap;
    uniforms.uHeave.value = c.plateHeave;
    uniforms.uTilt.value = c.plateTilt;
    uniforms.uWallDark.value = c.plateWallDark;
    uniforms.uSeamDust.value = c.plateSeamDust;
    uniforms.uColorDamp.value.copy(getColor(c.colorDamp));
  };

  return material;
}
