/**
 * Resource disposal helpers.
 *
 * Three.js does not garbage-collect GPU resources; anything we create must be
 * released explicitly. Every system in this project exposes `dispose()` and
 * routes through these helpers so teardown stays consistent.
 */

export function disposeMaterial(material) {
  if (!material) return;
  if (Array.isArray(material)) return material.forEach(disposeMaterial);
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture) value.dispose();
  }
  if (material.uniforms) {
    for (const name of Object.keys(material.uniforms)) {
      const v = material.uniforms[name]?.value;
      if (v && v.isTexture && v.userData?.ownedByMaterial) v.dispose();
    }
  }
  material.dispose();
}

/** Recursively dispose geometries, materials and textures under `root`. */
export function disposeObject(root) {
  if (!root) return;
  root.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    if (node.material) disposeMaterial(node.material);
  });
  root.parent?.remove(root);
}

/** Remove every child from a group and dispose it. */
export function clearGroup(group) {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i];
    group.remove(child);
    disposeObject(child);
  }
}
