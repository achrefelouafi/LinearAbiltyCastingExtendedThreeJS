import {
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Sphere,
  Vector3
} from 'three';
import { hash11 } from '../utils/math.js';

/**
 * Parameter-space geometry for the Celestial Rend.
 *
 * Same construction as `CascadeGeometry.js` and `GrowthGeometry.js`: every
 * buffer built here is a **grid in parameter space** — one axis along a thing,
 * one across it — and a vertex shader turns each `(u, v)` pair into a world
 * position. The tendril winding up the column and the column itself are two
 * shaders reading two grids that hold no metres at all, which is what lets the
 * editor re-cut a pillar that is already standing.
 *
 * The exception is `createSlingGeometry`, which is a real solid: a shard has to
 * cast a shadow and take the stage's key light on its facets, and neither of
 * those survives a silhouette that only exists after the vertex stage.
 *
 * Bounds are meaningless for everything placed in a shader, so every mesh built
 * on those must set `frustumCulled = false`.
 */

/** Everything placed in world space by a shader; cull it by hand. */
const HUGE_BOUNDS = /* @__PURE__ */ new Sphere(new Vector3(), 1e4);

const TAU = Math.PI * 2;

/**
 * A grid of quads in parameter space, and the index buffer that ties it.
 *
 * @param {number} rows     samples along the first axis
 * @param {number} columns  samples across the second
 * @param {(row: number, column: number) => [number, number]} map → the (x, y)
 *   each vertex carries. The z is always 0; nothing reads it.
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
  const indices = new Uint32Array(quads * 6);
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

/* ---------------------------------------------------------------------- */
/* 2 · the astral tendrils                                                 */
/* ---------------------------------------------------------------------- */

/**
 * The ribbons that climb the column — layer 2 of the breakdown sheet.
 *
 * `position = (t, v, 0)` with `t` along the climb and `v` running −1 → 1 across
 * the ribbon. A strip rather than a tube, because a tendril has no volume: the
 * material billboards it about its own spine, so it presents full width from
 * every angle and never shows the paper edge a fixed strip would.
 *
 * Nearly every row is spent on the climb. It has to be: these wind two and a
 * half turns around a thirty-metre column, and a helix sampled at twenty nodes
 * is a spiral staircase.
 *
 * @param {object} options
 * @param {number} [options.tendrils] instance capacity — the live count is `instanceCount`
 * @param {number} [options.nodes]    samples up the climb
 * @param {number} [options.across]   samples across the ribbon
 */
export function createTendrilGeometry({ tendrils = 30, nodes = 76, across = 3 } = {}) {
  const rows = Math.max(2, Math.round(nodes));
  const columns = Math.max(2, Math.round(across));
  const count = Math.max(1, Math.round(tendrils));

  const geometry = instanced(
    parameterGrid(rows, columns, (i, j) => [i / (rows - 1), (j / (columns - 1)) * 2 - 1]),
    count
  );

  const index = new Float32Array(count);
  for (let i = 0; i < count; i++) index[i] = i;
  geometry.setAttribute('aTendril', new InstancedBufferAttribute(index, 1));

  return geometry;
}

/* ---------------------------------------------------------------------- */
/* 3 · the pillar                                                          */
/* ---------------------------------------------------------------------- */

/**
 * The column of judgment — one open-ended cylinder in parameter space.
 *
 * `position = (t, a, 0)` with `t` climbing 0 → 1 from the floor to the top of
 * the shaft and `a` running 0 → 1 once around it. The seam column is duplicated
 * so `a` reaches a full 1.0 rather than wrapping, which matters here more than
 * it does on a tube: the flutes running up this thing are a function of `a`, and
 * a wrapped seam puts a visible zip up one side of the beam.
 *
 * Both caps are left open. The shaft is drawn double-sided and additive, so what
 * the eye reads as the beam's brightness is the far wall summed with the near
 * one — a cap would be a lid of light across the top of it.
 *
 * @param {object} options
 * @param {number} [options.nodes] samples up the shaft; the flare's detail ceiling
 * @param {number} [options.sides] facets around it
 */
export function createPillarGeometry({ nodes = 72, sides = 56 } = {}) {
  const rows = Math.max(2, Math.round(nodes));
  const facets = Math.max(3, Math.round(sides));
  const columns = facets + 1;

  const grid = parameterGrid(rows, columns, (i, j) => [i / (rows - 1), j / facets]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(grid.positions, 3));
  geometry.setIndex(new BufferAttribute(grid.indices, 1));
  geometry.boundingSphere = HUGE_BOUNDS;
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* the shard itself — the one solid in the ability                         */
/* ---------------------------------------------------------------------- */

/**
 * A shard of crystallised light: a long faceted spindle, pointed at both ends.
 *
 * The reference sheet's third panel is not made of rocks. Every shard in it is
 * a **sliver** — eight or ten times longer than it is wide, drawn to a needle at
 * the leading end and to a shorter point at the trailing one, with flat facets
 * down its length catching different amounts of light. That asymmetry is the
 * whole silhouette: a symmetric spindle reads as a rice grain, and the moment
 * one end is sharper than the other the shape acquires a direction and starts
 * reading as something *thrown*.
 *
 * Built on the CPU rather than in a shader because it is the only thing here
 * that has to occlude, cast a shadow and take the stage's key light on its
 * facets — none of which survive a silhouette that only exists after the vertex
 * stage. Normals are left to the material's `flatShading`, which derives them
 * from screen derivatives, so every facet takes the sun on its own.
 *
 * Unit length along **+Y**, centred on its own middle, so an instance tumbles
 * about itself rather than swinging around a pivot at its foot.
 *
 * @param {object} options
 * @param {number} [options.seed]    deterministic shape seed
 * @param {number} [options.sides]   facets around it — 5 to 7 read best
 * @param {number} [options.rows]    samples along it
 * @param {number} [options.width]   half-thickness at the waist, × the length
 * @param {number} [options.waist]   0..1, where along it the widest point sits
 * @param {number} [options.sharp]   how fast it closes to its points
 * @param {number} [options.jitter]  how far facets are pushed off a clean lathe
 */
export function createSlingGeometry({
  seed = 3,
  sides = 6,
  rows = 13,
  width = 0.055,
  waist = 0.38,
  sharp = 0.85,
  jitter = 0.3
} = {}) {
  const facets = Math.max(3, Math.round(sides));
  const steps = Math.max(4, Math.round(rows));

  // One radius scale per facet, held for the whole length: the shard is a
  // *prism* drawn to a point, so a facet that is proud at the waist has to stay
  // proud all the way to the tip. Re-rolling per row would sand it into a lump.
  const facetScale = new Float32Array(facets);
  for (let j = 0; j < facets; j++) {
    facetScale[j] = 1 + (hash11(seed * 7.31 + j * 2.17) - 0.5) * 2 * jitter;
  }
  // ... and one lean, so the sliver is not dead straight.
  const leanX = (hash11(seed * 3.7) - 0.5) * 0.12;
  const leanZ = (hash11(seed * 5.9 + 1.3) - 0.5) * 0.12;

  const vertexCount = (steps - 2) * facets + 2; // the two tips are single points
  const positions = new Float32Array(vertexCount * 3);
  let v = 0;

  /**
   * The half-thickness at `t`, 0 at the trailing point and 1 at the leading one.
   *
   * Two power curves meeting at the waist rather than one sine, because the two
   * ends are not the same shape: the leading end is drawn out into a needle and
   * the trailing one closes short and blunt.
   */
  const profile = (t) => {
    const k = t <= waist ? t / Math.max(1e-4, waist) : (1 - t) / Math.max(1e-4, 1 - waist);
    const power = t <= waist ? sharp : sharp * 1.9;
    return Math.pow(Math.max(0, k), power);
  };

  // The trailing point.
  positions[v++] = leanX * -0.5;
  positions[v++] = -0.5;
  positions[v++] = leanZ * -0.5;

  for (let i = 1; i < steps - 1; i++) {
    const t = i / (steps - 1);
    const y = t - 0.5;
    const r = width * profile(t);
    // A slow twist down the length, so facets do not all present at once.
    const roll = t * 0.55 + seed;
    for (let j = 0; j < facets; j++) {
      const a = (j / facets) * TAU + roll;
      const rr = r * facetScale[j];
      positions[v++] = Math.cos(a) * rr + leanX * y;
      positions[v++] = y;
      positions[v++] = Math.sin(a) * rr + leanZ * y;
    }
  }

  // The leading point.
  positions[v++] = leanX * 0.5;
  positions[v++] = 0.5;
  positions[v++] = leanZ * 0.5;

  const bands = steps - 3; // quad bands between the interior rings
  const indices = new Uint16Array((facets * 2 + bands * facets * 2) * 3);
  let k = 0;

  const ring = (i) => 1 + (i - 1) * facets; // first vertex of interior ring i
  const tail = 0;
  const head = vertexCount - 1;

  // The fan closing the trailing point.
  for (let j = 0; j < facets; j++) {
    indices[k++] = tail;
    indices[k++] = ring(1) + ((j + 1) % facets);
    indices[k++] = ring(1) + j;
  }

  // The body.
  for (let i = 1; i < steps - 2; i++) {
    const a = ring(i);
    const b = ring(i + 1);
    for (let j = 0; j < facets; j++) {
      const n = (j + 1) % facets;
      indices[k++] = a + j;
      indices[k++] = a + n;
      indices[k++] = b + j;
      indices[k++] = a + n;
      indices[k++] = b + n;
      indices[k++] = b + j;
    }
  }

  // ... and the fan closing the leading point.
  const last = ring(steps - 2);
  for (let j = 0; j < facets; j++) {
    indices[k++] = head;
    indices[k++] = last + j;
    indices[k++] = last + ((j + 1) % facets);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
