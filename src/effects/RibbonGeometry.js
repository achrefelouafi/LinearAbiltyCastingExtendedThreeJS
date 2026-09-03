import { BufferGeometry, BufferAttribute, Vector3, Sphere, DynamicDrawUsage } from 'three';

const _tangent = new Vector3();
const _side = new Vector3();
const _view = new Vector3();
const _up = new Vector3(0, 1, 0);
const _p = new Vector3();
const _normal = new Vector3();

export const RibbonMode = Object.freeze({
  /** Ribbon lies in the ground plane — used for the cast preview. */
  FLAT: 'flat',
  /** Ribbon always faces the camera — used for flame streams. */
  BILLBOARD: 'billboard',
  /** Ribbon keeps a fixed normal supplied per update — used for water twists. */
  ORIENTED: 'oriented',
  /**
   * Vertical curtain: the lower edge sits on the polyline and the upper edge is
   * `width` above it. Used for the fire stream and the wind ribbons, where the
   * effect needs real height rather than a camera-facing strip.
   */
  UPRIGHT: 'upright'
});

/**
 * A re-usable, pre-allocated triangle-strip ribbon.
 *
 * Every trail-like effect in the project (cast preview, fire stream, water
 * ribbon, wind spirals) is a ribbon along a polyline, so they all share this
 * builder. Buffers are allocated once at construction; `build()` only rewrites
 * the vertices it needs and moves the draw range — no per-frame allocation and
 * no geometry churn.
 *
 * Vertex attributes produced:
 *  - position  world-space (geometry is used with an identity matrix)
 *  - uv        x = along the ribbon (0..1), y = across (0..1)
 *  - aDist     arc length ratio along the ribbon (0..1)
 *  - aSide     -1 / +1 which edge the vertex is on
 *  - aRandom   stable per-vertex noise seed
 *
 * With `{ frame: true }` two more attributes are written:
 *  - aCenter   the polyline point this vertex was offset from
 *  - aTangent  the polyline tangent there
 * They let a fragment shader reconstruct the curve's local frame, which is what
 * the volumetric fire raymarcher needs: the ribbon is only a proxy hull for it,
 * the actual flame lives around `aCenter` / `aTangent`.
 */
export class RibbonGeometry {
  constructor(maxSegments = 128, { frame = false } = {}) {
    this.maxSegments = maxSegments;
    this.hasFrame = frame;
    const vertexCount = (maxSegments + 1) * 2;

    this.geometry = new BufferGeometry();
    this.positions = new Float32Array(vertexCount * 3);
    this.normals = new Float32Array(vertexCount * 3);
    this.uvs = new Float32Array(vertexCount * 2);
    this.dists = new Float32Array(vertexCount);
    this.sides = new Float32Array(vertexCount);
    this.randoms = new Float32Array(vertexCount);
    this.centers = frame ? new Float32Array(vertexCount * 3) : null;
    this.tangents = frame ? new Float32Array(vertexCount * 3) : null;

    for (let i = 0; i < vertexCount; i++) {
      this.sides[i] = i % 2 === 0 ? -1 : 1;
      this.randoms[i] = Math.random();
    }

    const indices = new Uint16Array(maxSegments * 6);
    for (let s = 0; s < maxSegments; s++) {
      const a = s * 2;
      indices.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], s * 6);
    }

    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('aNormal', new BufferAttribute(this.normals, 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('uv', new BufferAttribute(this.uvs, 2).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('aDist', new BufferAttribute(this.dists, 1).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('aSide', new BufferAttribute(this.sides, 1));
    this.geometry.setAttribute('aRandom', new BufferAttribute(this.randoms, 1));
    if (frame) {
      this.geometry.setAttribute('aCenter', new BufferAttribute(this.centers, 3).setUsage(DynamicDrawUsage));
      this.geometry.setAttribute('aTangent', new BufferAttribute(this.tangents, 3).setUsage(DynamicDrawUsage));
    }
    this.geometry.setIndex(new BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new Sphere(new Vector3(), 1000);

    this.segmentCount = 0;
  }

  /**
   * Rebuild the ribbon from a polyline.
   *
   * @param {Vector3[]} points        polyline in world space (>= 2 points)
   * @param {object}    options
   * @param {number}    options.width base half-width in world units
   * @param {string}    [options.mode] one of RibbonMode
   * @param {Vector3}   [options.cameraPosition] required for BILLBOARD
   * @param {Vector3}   [options.normal] fixed normal for ORIENTED
   * @param {(t:number, i:number) => number} [options.widthProfile] 0..1 → multiplier
   * @param {number}    [options.count] number of points to use (defaults to points.length)
   */
  build(points, options) {
    const count = Math.min(options.count ?? points.length, this.maxSegments + 1);
    if (count < 2) {
      this.segmentCount = 0;
      this.geometry.setDrawRange(0, 0);
      return this;
    }

    const {
      width = 0.5,
      mode = RibbonMode.BILLBOARD,
      cameraPosition = null,
      normal = null,
      widthProfile = null,
      twist = 0,
      twistPhase = 0
    } = options;

    // First pass: arc length so UVs and profiles are parameterised by distance,
    // not by index — this keeps textures from stretching on uneven point spacing.
    let total = 0;
    for (let i = 1; i < count; i++) total += points[i].distanceTo(points[i - 1]);
    const invTotal = total > 1e-5 ? 1 / total : 0;

    let travelled = 0;
    for (let i = 0; i < count; i++) {
      const point = points[i];

      if (i > 0) travelled += point.distanceTo(points[i - 1]);
      const t = travelled * invTotal;

      // Tangent from neighbouring samples (central difference where possible).
      if (i === 0) _tangent.copy(points[1]).sub(points[0]);
      else if (i === count - 1) _tangent.copy(points[count - 1]).sub(points[count - 2]);
      else _tangent.copy(points[i + 1]).sub(points[i - 1]);
      if (_tangent.lengthSq() < 1e-10) _tangent.set(0, 0, 1);
      _tangent.normalize();

      const upright = mode === RibbonMode.UPRIGHT;

      if (upright) {
        _side.copy(_up);
      } else if (mode === RibbonMode.FLAT) {
        _side.crossVectors(_tangent, _up);
      } else if (mode === RibbonMode.ORIENTED && normal) {
        _side.crossVectors(_tangent, normal);
      } else {
        _view.copy(cameraPosition ?? _up).sub(point);
        _side.crossVectors(_tangent, _view);
      }
      if (_side.lengthSq() < 1e-10) _side.set(1, 0, 0);
      _side.normalize();

      // Optional twist: roll the ribbon around its own tangent as it advances,
      // which is what gives the water ribbon its corkscrew.
      if (twist !== 0) _side.applyAxisAngle(_tangent, twist * t + twistPhase);

      // Surface normal for lighting / fresnel in the ribbon shaders.
      _normal.crossVectors(_tangent, _side).normalize();

      const scaled = width * (widthProfile ? widthProfile(t, i) : 1);
      // Upright ribbons grow from the polyline; the others straddle it.
      const lowOffset = upright ? 0 : -scaled * 0.5;
      const highOffset = upright ? scaled : scaled * 0.5;

      const i2 = i * 2;
      _p.copy(point).addScaledVector(_side, lowOffset);
      this.positions[i2 * 3 + 0] = _p.x;
      this.positions[i2 * 3 + 1] = _p.y;
      this.positions[i2 * 3 + 2] = _p.z;

      _p.copy(point).addScaledVector(_side, highOffset);
      this.positions[(i2 + 1) * 3 + 0] = _p.x;
      this.positions[(i2 + 1) * 3 + 1] = _p.y;
      this.positions[(i2 + 1) * 3 + 2] = _p.z;

      for (let v = 0; v < 2; v++) {
        this.normals[(i2 + v) * 3 + 0] = _normal.x;
        this.normals[(i2 + v) * 3 + 1] = _normal.y;
        this.normals[(i2 + v) * 3 + 2] = _normal.z;
      }

      if (this.hasFrame) {
        for (let v = 0; v < 2; v++) {
          const o = (i2 + v) * 3;
          this.centers[o + 0] = point.x;
          this.centers[o + 1] = point.y;
          this.centers[o + 2] = point.z;
          this.tangents[o + 0] = _tangent.x;
          this.tangents[o + 1] = _tangent.y;
          this.tangents[o + 2] = _tangent.z;
        }
      }

      this.uvs[i2 * 2 + 0] = t;
      this.uvs[i2 * 2 + 1] = 0;
      this.uvs[(i2 + 1) * 2 + 0] = t;
      this.uvs[(i2 + 1) * 2 + 1] = 1;

      this.dists[i2] = t;
      this.dists[i2 + 1] = t;
    }

    this.segmentCount = count - 1;

    const vertexCount = count * 2;
    const { position, uv, aDist: dist, aNormal: normals, aCenter, aTangent } = this.geometry.attributes;

    const uploads = [
      [position, 3],
      [normals, 3],
      [uv, 2],
      [dist, 1]
    ];
    if (this.hasFrame) uploads.push([aCenter, 3], [aTangent, 3]);

    for (const [attribute, itemSize] of uploads) {
      attribute.needsUpdate = true;
      attribute.clearUpdateRanges?.();
      attribute.addUpdateRange?.(0, vertexCount * itemSize);
    }

    this.geometry.setDrawRange(0, this.segmentCount * 6);
    return this;
  }

  /** Hide the ribbon without touching its buffers. */
  clear() {
    this.segmentCount = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.geometry.dispose();
  }
}
