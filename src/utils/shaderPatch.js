/**
 * Compose `onBeforeCompile` callbacks.
 *
 * Several systems want to patch the same built-in material (CSM injects its
 * cascade lookup, we inject procedural colour). Assigning `onBeforeCompile`
 * naively would silently clobber whichever ran first, so all patching goes
 * through here.
 */
export function patchOnBeforeCompile(material, fn) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    fn.call(this, shader, renderer);
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
