import { IcosahedronGeometry, BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { hash11 } from '../utils/math.js';

/**
 * CPU-side procedural geometry.
 *
 * The project ships no mesh assets beyond the character, so rocks and spikes
 * are generated here at boot and then instanced. Displacement uses a cheap
 * seeded value noise — good enough for silhouettes that are always seen in
 * motion, and deterministic so a given seed always yields the same rock.
 */

/** Seeded 3D value noise (smooth, |value| <= 1). */
function valueNoise3(x, y, z, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;

  const fade = (t) => t * t * (3 - 2 * t);
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  const corner = (i, j, k) => hash11((xi + i) * 157.1 + (yi + j) * 311.7 + (zi + k) * 74.7 + seed * 13.3) * 2 - 1;

  const lerp = (a, b, t) => a + (b - a) * t;

  const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), u);
  const x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), u);
  const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), u);
  const x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), u);

  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

function fbm3(x, y, z, seed, octaves = 3) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 7);
    frequency *= 2.07;
    amplitude *= 0.5;
  }
  return value;
}

/**
 * A chunky, faceted boulder.
 * @param {number} seed
 * @param {number} [detail] icosahedron subdivision (0-2)
 */
export function createRockGeometry(seed = 1, detail = 1) {
  const geometry = new IcosahedronGeometry(0.5, detail);
  const position = geometry.attributes.position;
  const v = new Vector3();

  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const n = fbm3(v.x * 3.4, v.y * 3.4, v.z * 3.4, seed, 3);
    const flatten = 1 - Math.abs(v.y) * 0.18; // rocks sit wider than they are tall
    v.multiplyScalar((1 + n * 0.42) * flatten);
    position.setXYZ(i, v.x, v.y, v.z);
  }

  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  geometry.computeVertexNormals(); // faceted look: the icosphere is non-indexed
  return geometry;
}

/**
 * A flat, irregular ground plate — the unit the earth crust is paved with.
 *
 * Unit space: an n-gon of radius 0.5 in XZ whose top surface sits slightly
 * above y = 0 and whose underside reaches y = -1. Thickness is therefore the
 * instance's Y scale alone, so a plate can be made thicker without changing its
 * footprint, and its top stays flush with the floor at y = 0.
 */
export function createSlabGeometry(seed = 7, sides = 7) {
  const rim = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + (hash11(seed * 3.1 + i * 1.7) - 0.5) * 0.75;
    const radius = 0.5 * (0.72 + hash11(seed * 7.7 + i * 2.3) * 0.5);
    // A little relief on the top face: a perfectly flat card reads as paper.
    rim.push([Math.cos(angle) * radius, 0.06 + hash11(seed + i * 5.5) * 0.16, Math.sin(angle) * radius]);
  }

  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);
  const centre = [0, 0.25, 0];

  for (let i = 0; i < sides; i++) {
    const a = rim[i];
    const b = rim[(i + 1) % sides];
    const aDown = [a[0], -1, a[2]];
    const bDown = [b[0], -1, b[2]];

    push(centre); push(b); push(a); // top face, fan from the centre
    push(a); push(b); push(aDown); // fracture wall
    push(b); push(bDown); push(aDown);
    push([0, -1, 0]); push(aDown); push(bDown); // underside
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The finale tower: a squared-off obelisk on a stepped plinth.
 *
 * Unit space: base at y = 0, apex at y = 1, one unit wide at the plinth — so an
 * instance scales height and footprint independently, and driving `position.y`
 * from -height to 0 slides the whole thing up out of the floor.
 */
export function createTowerGeometry(seed = 11) {
  const SIDES = 4;

  /** Square cross-section of half-width `r`, weathered by noise. */
  const ring = (y, r) =>
    Array.from({ length: SIDES }, (_, i) => {
      const angle = (i / SIDES) * Math.PI * 2 + Math.PI / SIDES;
      const x = Math.cos(angle) * Math.SQRT2;
      const z = Math.sin(angle) * Math.SQRT2;
      const wear = 1 + fbm3(x * 2.0, y * 3.0, z * 2.0, seed, 2) * 0.07;
      return [x * r * wear, y, z * r * wear];
    });

  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);

  const bridge = (lower, upper) => {
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      push(upper[i]); push(upper[j]); push(lower[i]);
      push(upper[j]); push(lower[j]); push(lower[i]);
    }
  };

  const plinthBottom = ring(0, 0.6);
  const plinthTop = ring(0.045, 0.575);
  const shaftBottom = ring(0.05, 0.5);
  const shaftTop = ring(0.87, 0.32);
  const apex = [0, 1, 0];

  bridge(plinthBottom, plinthTop);
  bridge(plinthTop, shaftBottom); // the ledge where the shaft meets the plinth
  bridge(shaftBottom, shaftTop);

  for (let i = 0; i < SIDES; i++) {
    const j = (i + 1) % SIDES;
    push(shaftTop[i]); push(apex); push(shaftTop[j]); // pyramidion
    push([0, 0, 0]); push(plinthBottom[i]); push(plinthBottom[j]); // underside
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Small flat shard used for the earth debris instances. */
export function createShardGeometry(seed = 5) {
  const geometry = new IcosahedronGeometry(0.5, 0);
  const position = geometry.attributes.position;
  const v = new Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    v.y *= 0.45;
    v.multiplyScalar(1 + fbm3(v.x * 5, v.y * 5, v.z * 5, seed, 2) * 0.5);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.deleteAttribute('normal');
  geometry.computeVertexNormals();
  return geometry;
}
