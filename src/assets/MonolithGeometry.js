import { BufferGeometry, Float32BufferAttribute } from 'three';
import { createAsteroidGeometry } from './ProceduralGeometry.js';
import { hash11, lerp } from '../utils/math.js';

/**
 * The monolith — layer 1 of the Brutalist Earth Blast breakdown.
 *
 * A slab of stone torn out of the floor: a straight-sided, slightly tapered
 * prism on an irregular polygonal footprint, capped by a **sheared break plane**
 * with a chamfered lip. Nothing about it is round.
 *
 * ## Why not the crystal generator
 *
 * `createCrystalGeometry` builds a radial prism that closes to a point, and a
 * point is the one thing this shape must not have — a tapered spike reads as
 * quartz however you shade it. The brutalist reference is the opposite: parallel
 * walls, a footprint that is nearer a rectangle than a circle, and a top that
 * ends in a *fracture* rather than a tip. Three details carry all of that:
 *
 *   - `flatten` squashes the footprint on local X, which is what turns a column
 *     into a slab. It is the single most important control in here — a slab seen
 *     edge-on is a blade and seen flat-on is a wall, and one cluster containing
 *     both is what gives the blast its silhouette.
 *   - `shear` tilts the top face off horizontal. A flat top reads as *cut*; a
 *     tilted one reads as *snapped*, and the whole population tilting different
 *     ways is most of what says "this was one piece of ground a second ago".
 *   - `bevel` chamfers the break edge. Real broken concrete never has a knife
 *     edge, and the chamfer is a face that catches the key light on its own —
 *     it draws the bright line along the top of every slab in the reference.
 *
 * ## Unit space
 *
 * Base ring on y = 0, tallest corner of the break plane at y = 1, footprint
 * inside a circle of radius 0.5. Identical to the crystal convention, so an
 * instance scales footprint and height independently and `aUp` reads straight
 * off as "how far up this slab am I" — which is what the dust coating and the
 * damp base in `materials/MonolithStoneMaterial.js` key off.
 *
 * All shading is triplanar in **world space**, so there are no UVs here and the
 * stone grain stays a fixed physical size no matter how far an instance is
 * stretched. A three-metre slab and a knee-high block are the same rock.
 */

const TAU = Math.PI * 2;

/** Where the wall rings sit. Straight sides need very few. */
const RING_T = [0, 0.18, 0.46, 0.74, 1.0];

/**
 * One slab of stone.
 *
 * @param {object} options
 * @param {number} [options.seed]    deterministic shape seed
 * @param {number} [options.sides]   vertices in the footprint (4–7 read best)
 * @param {number} [options.taper]   top width as a fraction of the base
 * @param {number} [options.flatten] squash on local X — low is a slab, 1 a column
 * @param {number} [options.chip]    how far the footprint wanders off a clean prism
 * @param {number} [options.shear]   tilt of the top break plane, × the height
 * @param {number} [options.bevel]   chamfer inset at the break edge
 * @param {number} [options.lean]    lateral drift of the axis from base to top
 * @returns {THREE.BufferGeometry} carrying aFace / aUp
 */
export function createMonolithGeometry({
  seed = 1,
  sides = 5,
  taper = 0.74,
  flatten = 0.58,
  chip = 0.24,
  shear = 0.32,
  bevel = 0.14,
  lean = 0.12
} = {}) {
  const facets = Math.max(3, Math.round(sides));
  const squash = Math.max(0.12, flatten);

  /* --- the footprint -------------------------------------------------- */
  // Angles and radii are rolled once and shared by every ring, so the walls
  // stay continuous vertical edges rather than twisting into a screw.
  const angles = [];
  const radii = [];
  for (let i = 0; i < facets; i++) {
    const jitter = (hash11(seed * 3.13 + i * 7.7) - 0.5) * (TAU / facets) * 0.7 * chip * 2.4;
    angles.push((i / facets) * TAU + jitter);
    radii.push(0.5 * (1 + (hash11(seed * 8.9 + i * 4.3) - 0.5) * chip * 1.1));
  }

  /* --- the break plane ------------------------------------------------ */
  const shearAngle = hash11(seed * 2.71) * TAU;
  const shearX = Math.cos(shearAngle);
  const shearZ = Math.sin(shearAngle);
  const leanAngle = hash11(seed * 1.93) * TAU;
  const leanX = Math.cos(leanAngle) * lean;
  const leanZ = Math.sin(leanAngle) * lean;

  /**
   * Height of the break plane over a footprint point. The projection runs
   * -0.5..0.5 across the slab, so the tallest corner lands exactly on y = 1 and
   * `shear` is honestly "how much of its own height the top face drops".
   */
  const breakY = (x, z) => 1 - shear * (0.5 + (x * shearX + z * shearZ));

  /** A footprint vertex at parametric height `t`, before the shear. */
  const wall = (i, t) => {
    const width = 1 - (1 - taper) * Math.pow(t, 0.85);
    // Chipping grows with height: a slab is cleanest where it was still joined
    // to the bedrock and most broken up where it tore free.
    const wobble = 1 + (hash11(seed * 11.1 + i * 3.9) - 0.5) * chip * 0.5 * t;
    const r = radii[i] * width * wobble;
    return [Math.cos(angles[i]) * r * squash + leanX * t * t, Math.sin(angles[i]) * r];
  };

  const positions = [];
  const faces = [];
  const ups = [];

  const push = (x, y, z, face, up) => {
    positions.push(x, y, z);
    faces.push(face);
    ups.push(up);
  };

  /* --- walls ---------------------------------------------------------- */
  // The last wall ring stops just short of the break plane; the gap between it
  // and the inset cap is the chamfer.
  const drop = bevel * 0.75;

  for (let ring = 0; ring < RING_T.length - 1; ring++) {
    const t0 = RING_T[ring];
    const t1 = RING_T[ring + 1];
    const top = ring === RING_T.length - 2;

    for (let i = 0; i < facets; i++) {
      const j = (i + 1) % facets;

      const a0 = wall(i, t0);
      const b0 = wall(j, t0);
      const a1 = wall(i, t1);
      const b1 = wall(j, t1);

      // Below the top ring the walls are plumb; the top ring follows the break
      // plane down, so the wall meets the chamfer at a constant offset.
      const ya0 = t0;
      const yb0 = t0;
      const ya1 = top ? breakY(a1[0], a1[1]) - drop : t1;
      const yb1 = top ? breakY(b1[0], b1[1]) - drop : t1;

      push(a0[0], ya0, a0[1], 0, t0);
      push(b0[0], yb0, b0[1], 0, t0);
      push(a1[0], ya1, a1[1], 0, t1);

      push(b0[0], yb0, b0[1], 0, t0);
      push(b1[0], yb1, b1[1], 0, t1);
      push(a1[0], ya1, a1[1], 0, t1);
    }
  }

  /* --- the chamfer, and the break face it frames ---------------------- */
  const rim = [];
  const cap = [];
  for (let i = 0; i < facets; i++) {
    const w = wall(i, 1);
    const inset = [w[0] * (1 - bevel), w[1] * (1 - bevel)];
    rim.push([w[0], breakY(w[0], w[1]) - drop, w[1]]);
    cap.push([inset[0], breakY(inset[0], inset[1]), inset[1]]);
  }

  for (let i = 0; i < facets; i++) {
    const j = (i + 1) % facets;
    // 0.55 rather than 1: the chamfer is a *fresh* face like the cap, but it is
    // the one the weathering reaches first, so it sits between the two.
    push(rim[i][0], rim[i][1], rim[i][2], 0.55, 1);
    push(rim[j][0], rim[j][1], rim[j][2], 0.55, 1);
    push(cap[i][0], cap[i][1], cap[i][2], 0.55, 1);

    push(rim[j][0], rim[j][1], rim[j][2], 0.55, 1);
    push(cap[j][0], cap[j][1], cap[j][2], 0.55, 1);
    push(cap[i][0], cap[i][1], cap[i][2], 0.55, 1);
  }

  // The break itself, fanned from the middle of the plane. Given a shallow
  // dish so it is not a mirror-flat polygon catching one specular.
  const centre = [leanX, breakY(leanX, leanZ) - bevel * 0.18, leanZ];
  for (let i = 0; i < facets; i++) {
    const j = (i + 1) % facets;
    push(centre[0], centre[1], centre[2], 1, 1);
    push(cap[i][0], cap[i][1], cap[i][2], 1, 1);
    push(cap[j][0], cap[j][1], cap[j][2], 1, 1);
  }

  /* --- the root ------------------------------------------------------- */
  // Seen only while the slab is still tilting out of the floor, but a hole
  // there reads as a paper cut-out the instant the camera drops.
  for (let i = 0; i < facets; i++) {
    const j = (i + 1) % facets;
    const a = wall(i, 0);
    const b = wall(j, 0);
    push(0, 0, 0, 1, 0);
    push(b[0], 0, b[1], 1, 0);
    push(a[0], 0, a[1], 1, 0);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aFace', new Float32BufferAttribute(faces, 1));
  geometry.setAttribute('aUp', new Float32BufferAttribute(ups, 1));
  // Non-indexed with per-face normals: the walls have to be genuinely flat, and
  // all of the surface detail comes from the triplanar normal map on top.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A chunk of geometric shrapnel — layer 3.
 *
 * The asteroid generator with its craters switched off and its cuts turned up:
 * what is left is a lump whose every face is a planar fracture, which is exactly
 * what a block of concrete looks like after it has been shattered rather than
 * eroded. Detail 1 (rather than 3) both keeps it cheap at eighty instances and
 * keeps the facets *large*, which is what makes the silhouette read as angular
 * while it tumbles past the camera.
 */
export function createDebrisGeometry(seed = 1) {
  return createAsteroidGeometry({
    seed: seed * 7.3 + 11,
    detail: 1,
    lumpiness: 0.22,
    noiseScale: 1.8,
    roughness: 0.09,
    cuts: 9,
    cutDepth: 0.44,
    craters: 0
  });
}

/**
 * The five slab silhouettes a cast draws from.
 *
 * Each is its own InstancedMesh, so this is five draw calls — and it buys the
 * one kind of variety per-instance scaling cannot, because the *proportions of
 * the footprint* differ. Instance 0 is the flattest (a wall), 4 the chunkiest
 * (a block), and the tiers in the ability pick which range they draw from.
 *
 * @param {number} variant 0..4
 * @param {object} c live `settings.quake`
 */
export function monolithVariantOptions(variant, c) {
  const t = variant / 4;
  return {
    seed: 3.7 + variant * 23.9,
    sides: Math.round(lerp(4, c.sides, t)),
    taper: lerp(c.taper, Math.min(0.98, c.taper + 0.18), t),
    // Flat walls first, chunky blocks last.
    flatten: lerp(c.flatten, Math.min(1, c.flatten + 0.55), t),
    chip: c.chip * lerp(0.75, 1.35, t),
    shear: c.shear * lerp(1.25, 0.6, t),
    bevel: c.bevel,
    lean: c.stoneBend * lerp(1.1, 0.5, t)
  };
}
