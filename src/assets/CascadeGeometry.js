import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Sphere,
  Vector3
} from 'three';

/**
 * Parameter-space geometry for the Baleful Cascade Mark.
 *
 * Same construction as `GrowthGeometry.js` and for the same reasons: every
 * buffer here is a **grid in parameter space** — one axis along a thing, one
 * across it — and a vertex shader turns each `(u, v)` pair into a world
 * position. The blade in the crown, the blade in the air and the wisp climbing
 * out of the mark are three shaders reading three grids that hold no metres at
 * all.
 *
 * What is different here is **who deals the instances**. The Chrono-Summon
 * derives a tendril's bearing from its instance index inside the shader, which
 * is right for something that only has to be drawn. This ability has to *throw*
 * a blade, so it needs to know where that blade's tip is in world space before
 * it can launch anything from it — and a shader cannot answer a question. So
 * the crown is dealt on the CPU into instanced attributes (`aDir`, `aShape`)
 * that the ability rewrites every frame, resolved from the live settings on the
 * frame they are read, exactly as if the shader had derived them. The rule the
 * project runs on is unbroken: nothing is captured at spawn, and dragging a
 * slider re-cuts a crown that is already standing.
 *
 * Bounds are meaningless — everything is placed in the vertex stage — so every
 * mesh built on these must set `frustumCulled = false`.
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
 */
function parameterGrid(rows, columns, map) {
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
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
      indices[k++] = a + 1;
    }
  }

  return { positions, indices };
}

/** Wrap a parameter grid up as one instanced draw. */
function instanced(grid, count) {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(grid.positions, 3));
  geometry.setIndex(new BufferAttribute(grid.indices, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = HUGE_BOUNDS;
  return geometry;
}

/** An instanced attribute of `size` floats per instance, filled with `fill`. */
function slot(geometry, name, count, size, fill = 0) {
  const array = new Float32Array(count * size);
  if (fill !== 0) array.fill(fill);
  const attribute = new InstancedBufferAttribute(array, size);
  attribute.setUsage(DynamicDrawUsage); // rewritten every frame
  geometry.setAttribute(name, attribute);
  return attribute;
}

/**
 * The tube every blade in this ability is drawn as.
 *
 * `position = (t, a, 0)` with `t` running 0 → 1 from the root to the point and
 * `a` running 0 → 1 once around it. The **cross-section is not round**: the
 * material pinches the thickness to nothing at two opposite angles, so what
 * this grid actually rasterises is a lens with a sharp edge down each side and
 * a spine ridge along each face. Eight facets is what makes it read as *cut*
 * rather than as a spindle — with flat shading each one takes the sun on its
 * own, which is the whole difference between a crystal and a carrot.
 *
 * The seam column is duplicated so `a` reaches a full 1.0 rather than wrapping.
 *
 * @param {object} options
 * @param {number} [options.blades] instance capacity — the live count is `instanceCount`
 * @param {number} [options.nodes]  samples along a blade; the taper's detail ceiling
 * @param {number} [options.sides]  facets around it
 */
export function createBladeGeometry({ blades = 56, nodes = 20, sides = 8 } = {}) {
  const rows = Math.max(2, Math.round(nodes));
  const facets = Math.max(3, Math.round(sides));
  const columns = facets + 1;
  const count = Math.max(1, Math.round(blades));

  const geometry = instanced(
    parameterGrid(rows, columns, (i, j) => [i / (rows - 1), j / facets]),
    count
  );

  /** Unit heading out of the heart. Dealt by the ability, spun by the ability. */
  slot(geometry, 'aDir', count, 3);
  /** (length metres, roll radians, presence 0..1, tone 0 teal → 1 violet). */
  slot(geometry, 'aShape', count, 4);

  return geometry;
}

/**
 * The blades in the air — the same tube, on the same grid, told where it is
 * going instead of which way it points.
 *
 * One instance per shot in flight, so a flurry of six is one draw call. The
 * endpoints and the clock arrive per instance rather than as uniform arrays
 * because the crown already works that way, and a shot that is drawn from a
 * different buffer to the blade it left reads as a different object.
 *
 * @param {object} options
 * @param {number} [options.shots] instance capacity — one per blade in flight
 * @param {number} [options.nodes] samples along it
 * @param {number} [options.sides] facets around it
 */
export function createVolleyGeometry({ shots = 8, nodes = 20, sides = 8 } = {}) {
  const rows = Math.max(2, Math.round(nodes));
  const facets = Math.max(3, Math.round(sides));
  const columns = facets + 1;
  const count = Math.max(1, Math.round(shots));

  const geometry = instanced(
    parameterGrid(rows, columns, (i, j) => [i / (rows - 1), j / facets]),
    count
  );

  /** Where it left the crown, and the point on the body it is going through. */
  slot(geometry, 'aFrom', count, 3);
  slot(geometry, 'aTo', count, 3);
  /** (life 0..1, seed, curve — signed, live 0/1). */
  slot(geometry, 'aState', count, 4);

  return geometry;
}

/**
 * The rising wisps — layer 2.
 *
 * `position = (t, v, 0)` with `t` along the climb and `v` running −1 → 1 across
 * the ribbon. A strip rather than a tube, because a wisp has no volume: it is
 * billboarded about its own spine in the vertex stage, so it presents its full
 * width to the camera from every angle and never shows an edge-on seam.
 *
 * Three columns is enough for the width, and the rows are all spent on the
 * climb — the S the spine takes is the entire silhouette of this layer.
 *
 * @param {object} options
 * @param {number} [options.wisps]  instance capacity
 * @param {number} [options.nodes]  samples up the climb
 * @param {number} [options.across] samples across the ribbon
 */
export function createWispGeometry({ wisps = 28, nodes = 40, across = 3 } = {}) {
  const rows = Math.max(2, Math.round(nodes));
  const columns = Math.max(2, Math.round(across));
  const count = Math.max(1, Math.round(wisps));

  const geometry = instanced(
    parameterGrid(rows, columns, (i, j) => [i / (rows - 1), (j / (columns - 1)) * 2 - 1]),
    count
  );

  const index = new Float32Array(count);
  for (let i = 0; i < count; i++) index[i] = i;
  geometry.setAttribute('aWisp', new InstancedBufferAttribute(index, 1));

  return geometry;
}
