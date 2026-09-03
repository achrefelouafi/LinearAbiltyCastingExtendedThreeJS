import {
  Mesh,
  PlaneGeometry,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2
} from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';

/** Side length of the floor plane, metres — the texture repeat is derived from it. */
const PLANE_SIZE = 400;

/**
 * The stone maps that dress the floor: ambientCG Rock030 (CC0), a rough natural
 * rock tiling. Colour is authored sRGB; the rest are linear data.
 */
const TEXTURE_URLS = {
  map: './textures/cathedral/color.jpg',
  normalMap: './textures/cathedral/normal.jpg',
  roughnessMap: './textures/cathedral/roughness.jpg',
  aoMap: './textures/cathedral/ao.jpg'
};

/**
 * The stage floor.
 *
 * Kept perfectly flat (y = 0) on purpose: the path-drawing raycast, every
 * ability and the earth eruptions all assume a planar surface, and a flat plane
 * makes those interactions exact.
 *
 * The base is a tiled stone flagstone (see `TEXTURE_URLS`), graded toward the
 * cool stage palette so it reads as castle rock rather than a daylit courtyard.
 * On top of the sampled albedo the shader keeps the two things that make the
 * floor sit in this scene: a luminance-preserving tint toward `floorTint`, and a
 * radial light pool that keeps the stage centre readable and sinks the floor
 * into the backdrop long before the plane's edge. When the texture is switched
 * off (or has not loaded yet) the same shader falls back to the original
 * procedural stone, so nothing depends on the download succeeding.
 */
export class Ground {
  constructor(environment) {
    this.environment = environment;

    this.material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: settings.environment.floorRoughness,
      metalness: 0.0,
      dithering: true
    });
    this.material.normalScale = new Vector2(
      settings.environment.floorNormalScale,
      settings.environment.floorNormalScale
    );

    /** The four stone maps, filled in by `loadTextures`. Null until then. */
    this.textures = null;
    this._textured = false;

    this.uniforms = {
      uFloorColor: { value: getColor(settings.environment.floorColor).clone() },
      uFloorTint: { value: getColor(settings.environment.floorTint).clone() },
      uTexTint: { value: settings.environment.floorTexTint },
      uSheen: { value: settings.environment.floorSheen },
      uPool: { value: settings.environment.floorPool },
      uTime: { value: 0 }
    };

    environment.registerShadowCasterWithPatch(this.material, (shader) => {
      shader.uniforms.uFloorColor = this.uniforms.uFloorColor;
      shader.uniforms.uFloorTint = this.uniforms.uFloorTint;
      shader.uniforms.uTexTint = this.uniforms.uTexTint;
      shader.uniforms.uSheen = this.uniforms.uSheen;
      shader.uniforms.uPool = this.uniforms.uPool;
      shader.uniforms.uTime = this.uniforms.uTime;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vGroundWorld;`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vGroundWorld;
           uniform vec3 uFloorColor;
           uniform vec3 uFloorTint;
           uniform float uTexTint;
           uniform float uSheen;
           uniform float uPool;
           uniform float uTime;
           ${noiseGLSL}`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec3 wp = vGroundWorld;

             #ifdef USE_MAP
               // The stone albedo is already in diffuseColor. Grade it toward the
               // stage's cool floor tint without dragging its brightness down:
               // normalising the tint to unit luminance shifts the hue and leaves
               // the value to the light pool below.
               vec3 tint = uFloorTint;
               float tl = max(1e-4, dot(tint, vec3(0.299, 0.587, 0.114)));
               vec3 graded = diffuseColor.rgb * (tint / tl);
               diffuseColor.rgb = mix(diffuseColor.rgb, graded, clamp(uTexTint, 0.0, 1.0));
             #else
               // No texture: the original procedural dark stone. Broad, smooth
               // variation with a warmer wash drifting through it — anything
               // higher frequency reads as gravel and fights the clean look.
               float macro = fbm3(wp * 0.018);
               float tintMask = smoothstep(-0.5, 0.6, macro);
               vec3 base = mix(uFloorColor, uFloorTint, tintMask * 0.5);
               base *= 1.0 + fbm3(wp * 0.09 + 11.0) * 0.05;
               base *= 1.0 + (snoise01(wp * 0.7) - 0.5) * 0.06;
               diffuseColor.rgb *= base;
             #endif

             // Radial light pool: the stage centre stays readable and the floor
             // sinks toward the backdrop long before the plane's edge. Shared by
             // both paths, because it is what welds the floor into the scene.
             float dist = length(wp.xz);
             float pool = mix(1.0, smoothstep(40.0, 5.0, dist), clamp(uPool, 0.0, 1.0));
             diffuseColor.rgb *= mix(0.18, 1.0, pool);
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           {
             // Break the sheen up: broad patches of smoother stone catch the key
             // light and the elemental glows, the rest stays matte. Rides on top
             // of the roughness map when one is present.
             float polish = smoothstep(0.3, 0.85, fbm3(vGroundWorld * 0.06 + 3.0) * 0.5 + 0.5);
             roughnessFactor *= mix(1.0, 0.45, polish * clamp(uSheen, 0.0, 1.0));
           }`
        );
    });

    this.mesh = new Mesh(new PlaneGeometry(PLANE_SIZE, PLANE_SIZE, 1, 1), this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'Ground';
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    this.group = this.mesh;
  }

  /**
   * Load the stone maps and attach them. Called during boot so the maps are in
   * place before the shader is compiled — no first-cast recompile — but the
   * ground renders fine (procedural fallback) if this is skipped or fails.
   *
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async loadTextures(assets) {
    const entries = await Promise.all(
      Object.entries(TEXTURE_URLS).map(async ([slot, url]) => [slot, await assets.loadTexture(url)])
    );

    const maxAniso = this.environment.renderer?.gl.capabilities.getMaxAnisotropy?.() ?? 1;
    const textures = {};
    for (const [slot, texture] of entries) {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.anisotropy = maxAniso;
      // TextureLoader assumes linear data; only the colour map is authored sRGB.
      if (slot === 'map') texture.colorSpace = SRGBColorSpace;
      textures[slot] = texture;
    }

    this.textures = textures;
    this._applyTiling();
    this._setTextured(settings.environment.floorTexture);
  }

  /**
   * Point every map at the same tiling, derived from metres-per-tile. Only the
   * repeat is touched — that feeds the texture's UV matrix (auto-updated each
   * render), so there is no image re-upload and this is safe to call per frame.
   */
  _applyTiling() {
    if (!this.textures) return;
    const repeat = PLANE_SIZE / Math.max(0.1, settings.environment.floorTextureScale);
    if (repeat === this._repeat) return;
    this._repeat = repeat;
    for (const texture of Object.values(this.textures)) texture.repeat.set(repeat, repeat);
  }

  /** Attach or detach the stone maps. Flipping this recompiles once (USE_MAP). */
  _setTextured(on) {
    if (!this.textures || on === this._textured) return;
    for (const slot of Object.keys(TEXTURE_URLS)) {
      this.material[slot] = on ? this.textures[slot] : null;
    }
    this.material.needsUpdate = true;
    this._textured = on;
  }

  update(elapsed) {
    const env = settings.environment;
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uFloorColor.value.copy(getColor(env.floorColor));
    this.uniforms.uFloorTint.value.copy(getColor(env.floorTint));
    this.uniforms.uTexTint.value = env.floorTexTint;
    this.uniforms.uSheen.value = env.floorSheen;
    this.uniforms.uPool.value = env.floorPool;
    this.material.roughness = env.floorRoughness;
    this.material.normalScale.set(env.floorNormalScale, env.floorNormalScale);

    if (this.textures) {
      this._applyTiling();
      this._setTextured(env.floorTexture);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this.textures) {
      for (const texture of Object.values(this.textures)) texture.dispose();
    }
  }
}
