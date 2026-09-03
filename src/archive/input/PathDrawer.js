import { Raycaster, Plane, Vector3, CatmullRomCurve3, MathUtils } from 'three';
import { settings } from '../config/settings.js';
import { EventEmitter } from '../utils/EventEmitter.js';
import { PathTrail } from '../effects/PathTrail.js';

const GROUND_PLANE = new Plane(new Vector3(0, 1, 0), 0);

/**
 * Turns a mouse drag into a smooth, castable spline.
 *
 * Pipeline:
 *   pointer NDC → raycast onto the ground plane → jitter-filtered sample list
 *   → exponential smoothing → CatmullRomCurve3 → uniform arc-length resample.
 *
 * The resampled polyline is what the preview ribbon and the abilities consume,
 * so the visible trail and the ability trajectory are guaranteed to agree.
 *
 * Emits: `cast` (curve, points, length), `start`, `cancel`.
 */
export class PathDrawer extends EventEmitter {
  constructor(camera) {
    super();
    this.camera = camera;
    this.raycaster = new Raycaster();
    this.raycaster.far = 500;

    /** Raw (filtered) samples on the ground. */
    this.samples = [];
    /** Smoothed + resampled polyline, reused every frame. */
    this.resampled = [];
    this.resampledCount = 0;

    this.trail = new PathTrail(240);
    this.active = false;

    this._hit = new Vector3();
    this._smoothed = new Vector3();
    this._tmp = new Vector3();

    // Pre-allocate the resample buffer so drawing never allocates.
    for (let i = 0; i < 320; i++) this.resampled.push(new Vector3());
  }

  get object3D() {
    return this.trail.mesh;
  }

  /** Project a pointer position onto the ground plane. @returns {boolean} hit */
  _project(pointer, out) {
    this.raycaster.setFromCamera(pointer, this.camera);
    return this.raycaster.ray.intersectPlane(GROUND_PLANE, out) !== null;
  }

  begin(pointer) {
    if (!this._project(pointer, this._hit)) return;
    this.samples.length = 0;
    this._smoothed.copy(this._hit);
    this.samples.push(this._hit.clone());
    this.active = true;
    this.trail.hide();
    this.emit('start', this._hit);
  }

  move(pointer) {
    if (!this.active) return;
    if (!this._project(pointer, this._hit)) return;

    const input = settings.input;

    // Exponential smoothing removes hand tremor without adding latency.
    this._smoothed.lerp(this._hit, MathUtils.clamp(1 - input.smoothing, 0.05, 1));

    const last = this.samples[this.samples.length - 1];
    if (last && this._smoothed.distanceTo(last) < input.minPointDistance) return;
    if (this.samples.length >= input.maxPoints) return;

    this.samples.push(this._smoothed.clone());
    this._rebuild();
  }

  end() {
    if (!this.active) return;
    this.active = false;

    const length = this.pathLength();
    if (this.samples.length < 3 || length < settings.input.minPathLength) {
      this.trail.hide();
      this.samples.length = 0;
      this.emit('cancel');
      return;
    }

    const curve = this._buildCurve();
    this.trail.release(); // burn the preview away
    this.emit('cast', curve, this.resampled, this.resampledCount, length);
    this.samples.length = 0;
  }

  pathLength() {
    let total = 0;
    for (let i = 1; i < this.samples.length; i++) total += this.samples[i].distanceTo(this.samples[i - 1]);
    return total;
  }

  _buildCurve() {
    // CatmullRom needs at least 2 points; we guarantee 3+ before calling.
    const curve = new CatmullRomCurve3(
      this.samples.map((p) => p.clone()),
      false,
      'catmullrom',
      settings.input.curveTension
    );
    curve.arcLengthDivisions = Math.max(64, this.samples.length * 8);
    return curve;
  }

  /** Resample the current stroke into `this.resampled` for the preview ribbon. */
  _rebuild() {
    if (this.samples.length < 2) return;

    const curve = this._buildCurve();
    const length = curve.getLength();
    const wanted = MathUtils.clamp(Math.round(length * settings.input.samplesPerUnit), 2, this.resampled.length);

    for (let i = 0; i < wanted; i++) {
      curve.getPointAt(i / (wanted - 1), this.resampled[i]);
      this.resampled[i].y = settings.trail.height;
    }
    this.resampledCount = wanted;
    this.trail.setPoints(this.resampled, wanted);
  }

  update(dt) {
    this.trail.update(dt);
  }

  dispose() {
    this.trail.dispose();
    this.clear();
  }
}
