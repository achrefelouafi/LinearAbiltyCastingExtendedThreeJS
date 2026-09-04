import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Sphere,
  Vector3
} from 'three';

/**
 * Parameter-space geometry for the Arborist's Growth Chrono-Summon.
 *
 * Nothing in this file knows a single metre. Every buffer here is a **grid in
 * parameter space** — one axis along a thing, one across it — and the material's
 * vertex shader is what turns a `(u, v)` pair into a world position. The tendril
 * that grows out of the floor, the leaf clipped to it and the petal on the bloom
 * are all the same three-line construction, and they are built this way for the
 * same reason the beam and the bolt are (`ProceduralGeometry.js`):
 *
 *  - **the shape stays a live control.** How far a tendril leans, how hard its
 *    tip curls, how far a petal bends back — all of it is a uniform, so dragging
 *    a slider re-cuts a summon that is already standing, including while the
 *    sandbox is paused. Baking any of it into vertices would mean rebuilding a
 *    buffer per frame instead.
 *  - **one instance is one thing.** The instance index is the *only* per-object
 *    input: the shader derives the tendril's bearing, its handedness, its height
 *    and its dice from it. Adding a tendril is `instanceCount++`, and it costs
 *    nothing to have the capacity standing by.
 *
 * The bounds are meaningless for the same reason (the geometry is placed in the
 * vertex stage), so every mesh built on these must set `frustumCulled = false`.
 */

/** Everything in here is placed in world space by a shader; cull it manually. */
const HUGE_BOUNDS = /* @__PURE__ */ new Sphere(new Vector3(), 1e4);

/**
 * A grid of quads in parameter space, and the index buffer that ties it.
 *
 * @param {number} rows     samples along the first axis
 * @param {number} columns  samples across the second
 * @param {(row: number, column: number) => [number, number]} map  → the (x, y)
 *   the vertex carries. The z is always 0; nothing reads it.
 * @param {boolean} [flip]  wind the triangles the other way
 */
function parameterGrid(rows, columns, map, flip = false) {
  const positions = new Float32Array(rows * columns * 3);
  let v = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < columns; j++) {
      const [x, y] = map(i, j);
      positions[v++] = x;
      positions[v++] = y;
      positions[v++] = 0;
    }
  }

  const quads = (rows - 1) * (columns - 1);
  const indices = new Uint16Array(quads * 6);
  let k = 0;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < columns - 1; j++) {
      const a = i * columns + j;
      const b = a + columns;
      if (flip) {
        indices[k++] = a;
        indices[k++] = a + 1;
        indices[k++] = b;
        indices[k++] = b;
        indices[k++] = a + 1;
        indices[k++] = b + 1;
      } else {
        indices[k++] = a;
        indices[k++] = b;
        indices[k++] = a + 1;
        indices[k++] = b;
        indices[k++] = b + 1;
        indices[k++] = a + 1;
      }
    }
  }

  return { positions, indices };
}

/** Wrap a parameter grid up as one instanced draw, indexed by `attribute`. */
function instanced(grid, count, attribute) {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(grid.positions, 3));
  geometry.setIndex(new BufferAttribute(grid.indices, 1));

  const index = new Float32Array(count);
  for (let i = 0; i < count; i++) index[i] = i;
  geometry.setAttribute(attribute, new InstancedBufferAttribute(index, 1));

  geometry.instanceCount = count;
  geometry.boundingSphere = HUGE_BOUNDS;
  return geometry;
}

/**
 * The wild-growth tendrils — layer 2 of the breakdown.
 *
 * One instance is one tendril, drawn as a closed tube: `position = (t, a, 0)`
 * with `t` running 0 → 1 from the foot to the tip and `a` running 0 → 1 once
 * around the stem. A real tube rather than a camera-facing ribbon, because these
 * are *woody* — the silhouette has to bow correctly when the camera orbits, they
 * have to occlude each other where they cross, and they have to cast a shadow
 * that is a stem and not a strip.
 *
 * The seam column is duplicated so `a` reaches a full 1.0 instead of wrapping to
 * 0: the bark is sampled in world space, so a wrap would not show, but a
 * duplicated seam costs one column and removes the question entirely.
 *
 * @param {object} options
 * @param {number} [options.vines] instance capacity — the live count is `instanceCount`
 * @param {number} [options.nodes] samples along a stem; the curl's detail ceiling
 * @param {number} [options.sides] facets around it (8–12 reads round enough)
 */
export function createVineGeometry({ vines = 14, nodes = 56, sides = 9 } = {}) {
  const rows = Math.max(2, Math.round(nodes));
  const facets = Math.max(3, Math.round(sides));
  const columns = facets + 1;

  const grid = parameterGrid(rows, columns, (i, j) => [i / (rows - 1), j / facets]);
  return instanced(grid, Math.max(1, Math.round(vines)), 'aVine');
}

/**
 * The foliage clipped to those tendrils — layer 3.
 *
 * One instance is one leaf: `position = (u, v, 0)` with `u` from the stalk to
 * the tip and `v` across, −1 to 1. The silhouette is *not* in this buffer — it is
 * an SDF cut in the fragment shader, so the leaf's outline, its serration and
 * its midrib are all live controls and one geometry serves every shape. What the
 * rows buy is the **bend**: a leaf is a surface that droops and cups, and a
 * single quad can do neither.
 *
 * @param {object} options
 * @param {number} [options.leaves] instance capacity
 * @param {number} [options.along]  samples from stalk to tip
 * @param {number} [options.across] samples across the blade
 */
export function createLeafGeometry({ leaves = 220, along = 7, across = 5 } = {}) {
  const rows = Math.max(2, Math.round(along));
  const columns = Math.max(2, Math.round(across));

  const grid = parameterGrid(rows, columns, (i, j) => [
    i / (rows - 1),
    (j / (columns - 1)) * 2 - 1
  ]);
  return instanced(grid, Math.max(1, Math.round(leaves)), 'aLeaf');
}

/**
 * The arcane bloom's petals — layer 4.
 *
 * Same parameterisation as a leaf and a different shader on it, because a petal
 * is the same *kind* of object: a bent sheet with a spine, cut to an outline in
 * the fragment stage. What differs is that a petal is placed by its whorl rather
 * than by a host stem, and that it unfurls — the pitch it stands at is a
 * uniform, so the whole bloom opens by animating one number.
 *
 * More rows than a leaf gets: a petal curls back on itself much harder, and the
 * silhouette of that curl is the first thing the eye reads about the flower.
 *
 * @param {object} options
 * @param {number} [options.petals] instance capacity across every whorl
 * @param {number} [options.along]  samples from base to tip
 * @param {number} [options.across] samples across the petal
 */
export function createPetalGeometry({ petals = 48, along = 11, across = 7 } = {}) {
  const rows = Math.max(2, Math.round(along));
  const columns = Math.max(2, Math.round(across));

  const grid = parameterGrid(rows, columns, (i, j) => [
    i / (rows - 1),
    (j / (columns - 1)) * 2 - 1
  ]);
  return instanced(grid, Math.max(1, Math.round(petals)), 'aPetal');
}

/**
 * The lances the bloom fires — a tube in parameter space, one instance per shot.
 *
 * `position = (t, a, 0)`, exactly as the tendrils, and for the same reason the
 * beam ability uses a tube rather than a ribbon: a lance this hot has to have a
 * cross-section, so the far wall adds through the near one and the silhouette
 * stays a rod from every angle. Each instance reads its own endpoints out of a
 * small uniform array, so a volley of four is one draw call.
 *
 * @param {object} options
 * @param {number} [options.lances] instance capacity — one per shot in flight
 * @param {number} [options.nodes]  samples along a lance
 * @param {number} [options.sides]  facets around it
 */
export function createLanceGeometry({ lances = 6, nodes = 40, sides = 12 } = {}) {
  const rows = Math.max(2, Math.round(nodes));
  const facets = Math.max(3, Math.round(sides));
  const columns = facets + 1;

  const grid = parameterGrid(rows, columns, (i, j) => [i / (rows - 1), j / facets]);
  return instanced(grid, Math.max(1, Math.round(lances)), 'aLance');
}
