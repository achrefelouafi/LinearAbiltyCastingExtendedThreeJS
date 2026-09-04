import { BufferGeometry, Float32BufferAttribute } from 'three';
import { hash11 } from '../utils/math.js';

/**
 * The broken floor plate — layer 4 of the Crystallized Venom Surge breakdown.
 *
 * A disc of stone cut into convex slabs by a **Voronoi diagram**, built once on
 * the CPU and animated entirely in the vertex shader. Every slab knows its own
 * centroid, so `materials/ShatterStoneMaterial.js` can shrink it toward that
 * point (which opens the seams), heave it out of the floor and cant it over
 * without touching a vertex again. Cracking the ground is therefore three
 * uniforms, not a rebuild.
 *
 * ## Unit space
 *
 * The plate is a disc of radius 1 on y = 0, extruded *downward* to `-depth`.
 * One `mesh.scale` sets the physical reach of the whole thing, which is what
 * makes the crater size a live slider — and it means the heave and the seam gaps
 * are naturally expressed as fractions of the plate, so a two-metre crater and
 * an eight-metre one break the same way rather than one of them looking like
 * gravel and the other like tectonics.
 *
 * ## Why a Voronoi rather than radial cracks
 *
 * Radial cracks from a point are what an *impact* does to a pane. Stone forced
 * up from beneath does not fail radially — it fails along whatever grain is
 * nearest, and the result is a mosaic of chunky, roughly-convex plates. A
 * Voronoi of jittered sites is exactly that mosaic, for free, and clipping it
 * against a ragged boundary polygon keeps the outline from reading as a decal
 * stamped on the floor.
 *
 * Sites are laid out on a **golden-angle spiral**, which distributes them evenly
 * without the ring artefacts of a polar grid, and pushed through a power curve
 * so the cells come out finer near the middle — under the spike — and chunkier
 * at the lip, which is the size gradient a real break has.
 */

/** Golden angle. Successive sites land in the largest remaining gap. */
const GOLDEN = 2.399963229728653;
const TAU = Math.PI * 2;

/**
 * Clip a convex polygon to the half-plane of points closer to `p` than to `q`.
 * Sutherland–Hodgman against the perpendicular bisector — the whole of the
 * Voronoi construction, run once per pair of sites.
 *
 * @param {number[][]} poly [[x, z], …] convex, in increasing-angle order
 */
function clipToBisector(poly, px, pz, qx, qz) {
  const dx = qx - px;
  const dz = qz - pz;
  const mx = (px + qx) * 0.5;
  const mz = (pz + qz) * 0.5;

  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    // Signed distance to the bisector, positive on `q`'s side.
    const fa = (a[0] - mx) * dx + (a[1] - mz) * dz;
    const fb = (b[0] - mx) * dx + (b[1] - mz) * dz;
    const insideA = fa <= 0;
    const insideB = fb <= 0;

    if (insideA) out.push(a);
    if (insideA !== insideB) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * A shattered stone plate in unit space.
 *
 * @param {object} options
 * @param {number} [options.seed]   deterministic layout seed
 * @param {number} [options.cells]  slabs the disc is cut into
 * @param {number} [options.rim]    vertices in the boundary polygon
 * @param {number} [options.depth]  slab thickness, fraction of the radius
 * @param {number} [options.bias]   <0.5 makes the middle cells finer
 * @param {number} [options.jitter] how far sites wander off the spiral
 * @param {number} [options.ragged] how far the outline bites in, 0..1
 * @returns {THREE.BufferGeometry} carrying aCell / aRand / aEdge / aWall
 */
export function createShatterPlateGeometry({
  seed = 3,
  cells = 56,
  rim = 44,
  depth = 0.085,
  bias = 0.44,
  jitter = 0.55,
  ragged = 0.22
} = {}) {
  const count = Math.max(3, Math.round(cells));

  /* --- the ragged outline every cell is clipped against ---------------- */
  const boundary = [];
  for (let i = 0; i < rim; i++) {
    const angle = (i / rim) * TAU;
    // Two octaves of angular wobble: a slow lobing plus a per-vertex bite, so
    // the lip reads as broken rather than as a scalloped cookie cutter.
    const lobe = Math.sin(angle * 3 + seed) * 0.5 + Math.sin(angle * 7 - seed * 2.3) * 0.28;
    const bite = hash11(seed * 3.7 + i * 1.31);
    const r = 1 - ragged * (0.35 + 0.65 * bite) + lobe * ragged * 0.35;
    boundary.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }

  /* --- sites ----------------------------------------------------------- */
  const sites = [];
  for (let i = 0; i < count; i++) {
    const base = Math.pow((i + 0.5) / count, bias);
    const wobbleR = (hash11(seed * 5.1 + i * 2.7) - 0.5) * jitter * 0.9;
    const wobbleA = (hash11(seed * 9.3 + i * 4.1) - 0.5) * jitter * (TAU / Math.sqrt(count));
    const r = Math.min(0.98, Math.max(0, base * (1 + wobbleR / Math.sqrt(count))));
    const angle = i * GOLDEN + wobbleA;
    sites.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }

  /* --- cut, then build ------------------------------------------------- */
  const positions = [];
  const cellData = []; // vec3: centroid.x, centroid.z, cell index
  const rands = []; // vec3: lift / tilt / thickness dice, one triple per cell
  const edges = []; // 1 at the centroid, 0 on the rim
  const walls = []; // 0 top face, 1 side wall

  let built = 0;

  for (let c = 0; c < count; c++) {
    let poly = boundary;
    for (let o = 0; o < count; o++) {
      if (o === c) continue;
      poly = clipToBisector(poly, sites[c][0], sites[c][1], sites[o][0], sites[o][1]);
      if (poly.length < 3) break;
    }
    if (poly.length < 3) continue;

    // The *polygon's* centroid, not the site: a site can sit well off centre in
    // a lopsided cell, and every animation below pivots about this point.
    let cx = 0;
    let cz = 0;
    for (const p of poly) {
      cx += p[0];
      cz += p[1];
    }
    cx /= poly.length;
    cz /= poly.length;

    const index = built++;
    const r0 = hash11(seed * 13.7 + index * 3.9);
    const r1 = hash11(seed * 17.1 + index * 7.3);
    const r2 = hash11(seed * 23.9 + index * 5.1);
    // Thickness varies per slab, so the exposed walls are not a uniform band.
    const thickness = depth * (0.55 + 0.75 * r2);

    const push = (x, y, z, edge, wall) => {
      positions.push(x, y, z);
      cellData.push(cx, cz, index);
      rands.push(r0, r1, r2);
      edges.push(edge);
      walls.push(wall);
    };

    /* top face — a fan from the centroid.
       Wound b-then-a: increasing angle in the XZ plane faces -Y. */
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      push(cx, 0, cz, 1, 0);
      push(b[0], 0, b[1], 0, 0);
      push(a[0], 0, a[1], 0, 0);
    }

    /* side walls — the broken faces the venom light comes up through */
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      push(a[0], 0, a[1], 0, 0);
      push(b[0], 0, b[1], 0, 0);
      push(a[0], -thickness, a[1], 0, 1);

      push(b[0], 0, b[1], 0, 0);
      push(b[0], -thickness, b[1], 0, 1);
      push(a[0], -thickness, a[1], 0, 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aCell', new Float32BufferAttribute(cellData, 3));
  geometry.setAttribute('aRand', new Float32BufferAttribute(rands, 3));
  geometry.setAttribute('aEdge', new Float32BufferAttribute(edges, 1));
  geometry.setAttribute('aWall', new Float32BufferAttribute(walls, 1));
  // Non-indexed with per-face normals: stone that broke, not stone that was cast.
  geometry.computeVertexNormals();

  geometry.userData.cells = built;
  return geometry;
}
