import {
  Box3,
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Sphere,
  Vector3
} from 'three';
import { hash11 } from '../utils/math.js';

/**
 * Turns an authored mesh into the parameter space the Cyber Serpent's shaders
 * are written against.
 *
 * Everything else in this project is generated, so this is the one place a
 * loaded asset is allowed to dictate a shape — and the price of that is that
 * nothing downstream may know anything about the file. The shaders are written
 * against a **canonical body**:
 *
 *   - the flight axis is local **+Z**, with the head at `z = +0.5` and the tail
 *     at `z = -0.5`, so `0.5 - position.z` reads straight off as "how far back
 *     down the body am I" — which is what every wave, reveal and dissolve in
 *     `CyberSerpentMaterial` keys off;
 *   - the **rear** of the body sits on the axis, and whatever the sculpt did
 *     with the head (this one rears up) is kept, because that pose is the read;
 *   - one unit long, so the ability scales it straight to metres.
 *
 * The export is measured rather than assumed: the long axis is found, the head
 * is identified as the denser end (a head carries the polygons, a tail is a
 * tube), and the flight line is the median of the rear slices' bounding
 * centres. Swap the mesh and this still yields a serpent flying nose-first
 * down +Z.
 *
 * Four attributes are added, none of which the file has:
 *
 *   `aBary`  — barycentric coordinates, the wireframe pass's whole basis. They
 *              need the geometry non-indexed, which is also what the shatter
 *              needs, so the two features cost one copy between them.
 *   `aFacet` — the triangle's centroid, so a fragment (and the vertex stage,
 *              once the body comes apart) can talk about *its facet* rather
 *              than about itself.
 *   `aBurst` — the unit direction that facet flies on when it does: outward off
 *              the spine, biased forward and up, jittered per facet so the
 *              debris is a cloud and not a starburst.
 *   `aSeed`  — one stable die roll per facet, which is what the glitch, the
 *              shatter delay and the flicker all sample.
 */

/** z-slices the spine profile is measured in. */
const SLICES = 48;

/**
 * The fraction of the body, measured from the tail, whose axis *is* the flight
 * line. Deliberately not the whole body: a serpent's head is raised, and
 * centring on the lot would drop the head onto the axis and take the pose with
 * it.
 */
const BODY_FRACTION = 0.55;

const _box = new Box3();
const _matrix = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();

/** The mesh with the most triangles anywhere under `root`. */
function findRenderableMesh(root) {
  let best = null;
  let bestCount = -1;
  root.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const count = node.geometry.index
      ? node.geometry.index.count
      : node.geometry.attributes.position.count;
    if (count > bestCount) {
      best = node;
      bestCount = count;
    }
  });
  return best;
}

/** Rotate the geometry so its longest dimension runs along +Z. */
function orientLongAxisToZ(geometry) {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(_a);
  if (size.z >= size.x && size.z >= size.y) return;
  // A quarter turn about the *other* axis, so up survives wherever it can: an
  // export lying along X keeps its Y, one standing along Y is laid down.
  if (size.x > size.y) geometry.applyMatrix4(_matrix.makeRotationY(-Math.PI / 2));
  else geometry.applyMatrix4(_matrix.makeRotationX(Math.PI / 2));
}

/**
 * Put the head at +Z.
 *
 * The head is the denser end — jaws, eyes and horns are where the triangles
 * are. Counting them is cheap and needs to know nothing about the animal.
 */
function orientHeadToPlusZ(geometry) {
  const position = geometry.attributes.position;
  geometry.computeBoundingBox();
  const middle = (geometry.boundingBox.min.z + geometry.boundingBox.max.z) * 0.5;

  let front = 0;
  let back = 0;
  for (let i = 0; i < position.count; i++) {
    if (position.getZ(i) > middle) front++;
    else back++;
  }
  if (front < back) geometry.applyMatrix4(_matrix.makeRotationY(Math.PI));
}

/**
 * Where the flight axis runs: the median of the rear slices' bounding centres.
 *
 * Median rather than mean, and bounding centres rather than vertex averages,
 * because both alternatives are pulled about by tessellation — one dense ring
 * of vertices under the belly would drag a mean straight through the floor of
 * the mesh.
 */
function measureFlightAxis(geometry, out) {
  const position = geometry.attributes.position;
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  const span = Math.max(1e-6, max.z - min.z);

  const bounds = new Array(SLICES).fill(null);

  for (let i = 0; i < position.count; i++) {
    const z = position.getZ(i);
    // Only the rear of the body gets a vote on where the axis is.
    if (z > min.z + span * BODY_FRACTION) continue;
    const slot = Math.min(SLICES - 1, Math.max(0, Math.floor(((z - min.z) / span) * SLICES)));
    const x = position.getX(i);
    const y = position.getY(i);
    const box = bounds[slot];
    if (box) {
      box[0] = Math.min(box[0], x);
      box[1] = Math.max(box[1], x);
      box[2] = Math.min(box[2], y);
      box[3] = Math.max(box[3], y);
    } else {
      bounds[slot] = [x, x, y, y];
    }
  }

  const xs = [];
  const ys = [];
  for (const box of bounds) {
    if (!box) continue;
    xs.push((box[0] + box[1]) * 0.5);
    ys.push((box[2] + box[3]) * 0.5);
  }
  if (!xs.length) return out.set(0, 0, (min.z + max.z) * 0.5);

  xs.sort((p, q) => p - q);
  ys.sort((p, q) => p - q);
  const middle = xs.length >> 1;
  return out.set(xs[middle], ys[middle], (min.z + max.z) * 0.5);
}

/**
 * Build the serpent's render geometry from a loaded glTF scene.
 *
 * @param {THREE.Object3D} root      the glTF scene
 * @param {object} [options]
 * @param {number} [options.ghosts]  copies the wake geometry instances
 * @returns {{geometry: THREE.BufferGeometry,
 *            ghostGeometry: THREE.InstancedBufferGeometry,
 *            radius: number, triangles: number}}
 *   `radius` is the body's half-width in canonical units — what the ability
 *   sizes the trails, the spray and the light against.
 */
export function buildSerpentGeometry(root, { ghosts = 6 } = {}) {
  const mesh = findRenderableMesh(root);
  if (!mesh) throw new Error('[SerpentGeometry] the model has no renderable mesh');

  root.updateMatrixWorld(true);

  const source = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();

  orientLongAxisToZ(geometry);
  orientHeadToPlusZ(geometry);

  /* ---- canonical space: one unit long, head at +0.5, rear on the axis ---- */
  const axis = measureFlightAxis(geometry, new Vector3());
  _box.copy(geometry.boundingBox);
  const length = Math.max(1e-5, _box.max.z - _box.min.z);
  const scale = 1 / length;

  geometry.applyMatrix4(_matrix.makeTranslation(-axis.x, -axis.y, -axis.z));
  geometry.applyMatrix4(_matrix.makeScale(scale, scale, scale));

  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  // Nothing samples a map on this body — every pass is procedural — and an
  // attribute that is never read is still uploaded and still bound.
  geometry.deleteAttribute('uv');
  geometry.deleteAttribute('uv1');
  geometry.deleteAttribute('tangent');
  geometry.deleteAttribute('color');

  /* ---- the four attributes the shaders actually run on ---- */
  const position = geometry.attributes.position;
  const count = position.count;
  const triangles = Math.floor(count / 3);

  const bary = new Float32Array(count * 3);
  const facet = new Float32Array(count * 3);
  const burst = new Float32Array(count * 3);
  const seed = new Float32Array(count);

  // The *body's* half-width, measured over the rear half only. Taking the whole
  // mesh would return the distance to the raised head instead, and every spray
  // radius sized against it would emit from a shell around the animal.
  let radius = 0;
  for (let i = 0; i < count; i++) {
    if (position.getZ(i) > 0) continue;
    radius = Math.max(radius, Math.hypot(position.getX(i), position.getY(i)));
  }
  if (radius <= 1e-5) radius = 0.05;

  for (let t = 0; t < triangles; t++) {
    const i0 = t * 3;
    _a.fromBufferAttribute(position, i0);
    _b.fromBufferAttribute(position, i0 + 1);
    _c.fromBufferAttribute(position, i0 + 2);
    _a.add(_b).add(_c).multiplyScalar(1 / 3);

    const roll = hash11(t + 1);

    // Off the spine, then thrown forward and up: debris from something that was
    // travelling, rather than from a bomb.
    _b.set(_a.x, _a.y, 0);
    if (_b.lengthSq() < 1e-8) _b.set(hash11(t + 7.3) - 0.5, hash11(t + 11.9) - 0.5, 0);
    _b.normalize();
    _c.set(hash11(t + 31.7) - 0.5, hash11(t + 53.1) - 0.5, hash11(t + 71.3) - 0.5);
    _b.addScaledVector(_c, 1.15);
    _b.x += 0;
    _b.y += 0.35;
    _b.z += 0.45;
    _b.normalize();

    for (let v = 0; v < 3; v++) {
      const i = i0 + v;
      bary[i * 3 + v] = 1;
      facet[i * 3 + 0] = _a.x;
      facet[i * 3 + 1] = _a.y;
      facet[i * 3 + 2] = _a.z;
      burst[i * 3 + 0] = _b.x;
      burst[i * 3 + 1] = _b.y;
      burst[i * 3 + 2] = _b.z;
      seed[i] = roll;
    }
  }

  geometry.setAttribute('aBary', new BufferAttribute(bary, 3));
  geometry.setAttribute('aFacet', new BufferAttribute(facet, 3));
  geometry.setAttribute('aBurst', new BufferAttribute(burst, 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seed, 1));

  // The vertex stage moves the body a long way off its rest pose (the sway, the
  // inflate, and the shatter most of all), so the authored bounds are a lie.
  // The ability turns culling off; this only stops three recomputing them.
  geometry.boundingSphere = new Sphere(new Vector3(), 4);
  geometry.boundingBox = null;

  /* ---- the wake: the same body, drawn again at a lag ---- */
  const ghostGeometry = new InstancedBufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    // Shared by identity, so the wake costs no extra vertex memory and no
    // second upload.
    ghostGeometry.setAttribute(name, attribute);
  }
  const ghostIndex = new Float32Array(Math.max(1, Math.round(ghosts)));
  for (let i = 0; i < ghostIndex.length; i++) ghostIndex[i] = i;
  ghostGeometry.setAttribute('aGhost', new InstancedBufferAttribute(ghostIndex, 1));
  ghostGeometry.instanceCount = ghostIndex.length;
  ghostGeometry.boundingSphere = new Sphere(new Vector3(), 12);

  return { geometry, ghostGeometry, radius, triangles };
}
