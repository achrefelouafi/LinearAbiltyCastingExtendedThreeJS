/**
 * Compose `onBeforeCompile` callbacks.
 *
 * Several systems want to patch the same built-in material (CSM injects its
 * cascade lookup, we inject procedural colour). Assigning `onBeforeCompile`
 * naively would silently clobber whichever ran first, so all patching goes
 * through here.
 *
 * ## Why it also rewrites the cache key
 *
 * three caches compiled programs, and the key it uses ends in
 * `customProgramCacheKey()` — whose default implementation is
 * `onBeforeCompile.toString()`. Every function installed above has the *same*
 * source text, so two materials that patch the same base material with the same
 * parameters (both MeshStandardMaterial, no maps, double sided, no skinning,
 * say) produce identical keys, and the second one silently renders with the
 * first one's shader. Nothing errors; the geometry simply comes out as
 * whatever the other material was going to draw.
 *
 * Folding the *patch's* own identity into the key is what separates them. It is
 * the patch's source text rather than its object identity on purpose: two
 * materials built by the same factory genuinely should share one program, and
 * keying off identity would compile the same shader once per pooled ability.
 *
 * @param {THREE.Material} material
 * @param {(shader: object, renderer: object) => void} fn
 * @param {string} [key] use when one factory installs *different* shaders
 *   through the same function — its source text cannot tell them apart, so it
 *   has to be told.
 */
export function patchOnBeforeCompile(material, fn, key = null) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    fn.call(this, shader, renderer);
  };

  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = function () {
    return `${previousKey()}|${key ?? fn.toString()}`;
  };

  return material;
}

/**
 * Replace a token in a shader string, throwing in dev if the token vanished
 * after a three.js upgrade — silent no-ops here are painful to debug.
 */
export function replaceChunk(source, token, replacement) {
  if (!source.includes(token)) {
    console.warn(`[shaderPatch] token not found: ${token}`);
    return source;
  }
  return source.replace(token, replacement);
}

/** Prepend declarations to a shader stage. */
export function prependChunk(source, code) {
  return `${code}\n${source}`;
}
