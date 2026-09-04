/**
 * Render layers.
 *
 * WORLD       — opaque environment + character. Written to the depth prepass,
 *               receives shadows, is what soft particles fade against.
 * VFX         — every transparent ability mesh and particle system.
 * DISTORTION  — invisible-to-the-main-pass proxies that write screen-space UV
 *               offsets for heat shimmer / water refraction.
 * CONTACT     — additional layer flag on the character only, so the contact
 *               shadow pass captures it without also capturing grass or VFX.
 * SHAPED      — opaque ability geometry whose *vertex stage* is hand written
 *               (the Chrono-Summon's tendrils, foliage and petals, which are
 *               placed from parameter space in the shader). It has to cast and
 *               receive the sun like anything on WORLD, but it must stay out
 *               of the depth prepass: that pass draws the whole layer with one
 *               `overrideMaterial`, which would rasterise the raw parameter
 *               buffer — a metre-wide sheet at the origin — instead of the
 *               summon. Its own `customDepthMaterial` handles the shadow map,
 *               where three does respect it.
 */
export const LAYER = Object.freeze({
  WORLD: 0,
  VFX: 1,
  DISTORTION: 2,
  CONTACT: 3,
  SHAPED: 4
});

/** Put an object and all of its descendants on a single layer. */
export function setLayerRecursive(object, layer) {
  object.traverse((node) => node.layers.set(layer));
  return object;
}
