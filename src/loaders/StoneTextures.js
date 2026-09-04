import { TextureLoader, RepeatWrapping, SRGBColorSpace } from 'three';

/**
 * The shared photographic stone set — ambientCG **Rock030** (CC0), the same four
 * maps `world/Ground.js` dresses the floor with.
 *
 * The Monolith Rift is the one ability in the sandbox whose geometry is supposed
 * to read as *real rock* rather than as a shader, and no amount of procedural
 * fbm gets there: the thing that says photogrammetry is the correlated
 * albedo/normal/roughness of an actual scan. Rather than ship a second copy of
 * one, the ability borrows the floor's — which is right in more than the obvious
 * way, because the slabs it heaves up are meant to be *made of this floor*.
 *
 * ## Why this is a module singleton and not a field on `App`
 *
 * Abilities are constructed lazily, by the pool, on the first cast — long after
 * `App#load` has finished, and with no route back to `Ground`. Threading the
 * textures through `AbilityManager`'s context would make every future ability
 * pay for one ability's asset. A module-level lazy loader costs nothing until
 * something asks, and the browser serves the second request out of the HTTP
 * cache, so the bytes are fetched once regardless.
 *
 * ## The `amount` handshake
 *
 * `TextureLoader#load` hands back a `Texture` immediately and fills its image in
 * later. Bound to a sampler before that, it draws as flat black — a black
 * monolith for the first frames of the very first cast. So the loader publishes
 * `state.amount`, which stays 0 until all four maps have landed and then eases
 * to 1; the materials blend the sampled stone against their procedural fallback
 * by exactly that number. If the download never lands, the ability simply keeps
 * the fallback shading and nothing errors.
 */
const TEXTURE_URLS = {
  map: './textures/cathedral/color.jpg',
  normalMap: './textures/cathedral/normal.jpg',
  roughnessMap: './textures/cathedral/roughness.jpg',
  aoMap: './textures/cathedral/ao.jpg'
};

/** Metres one tile of the source scan covers. Textures are sampled in metres. */
export const STONE_TILE_METRES = 2.6;

let cache = null;

/**
 * The four maps, loading on the first call and shared by every caller after.
 *
 * @returns {{ map: THREE.Texture, normalMap: THREE.Texture,
 *             roughnessMap: THREE.Texture, aoMap: THREE.Texture,
 *             state: { amount: number, loaded: number } }}
 */
export function getStoneTextures() {
  if (cache) return cache;

  const loader = new TextureLoader();
  const state = { amount: 0, loaded: 0 };
  const textures = {};

  for (const [slot, url] of Object.entries(TEXTURE_URLS)) {
    const texture = loader.load(url, () => {
      state.loaded++;
      // All four or nothing: a normal map arriving before its albedo would
      // shade the slabs with the grain of one rock and the colour of none.
      if (state.loaded >= 4) state.amount = 1;
    });
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    // three clamps this to the hardware maximum. Worth having: these are
    // sampled triplanar on faces that go edge-on to the camera constantly.
    texture.anisotropy = 8;
    // TextureLoader assumes linear data; only the colour map is authored sRGB.
    if (slot === 'map') texture.colorSpace = SRGBColorSpace;
    textures[slot] = texture;
  }

  cache = { ...textures, state };
  return cache;
}
