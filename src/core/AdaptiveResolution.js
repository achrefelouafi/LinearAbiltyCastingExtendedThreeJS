/** Render scales, coarsest last. Each step is roughly 30% less fill. */
const STEPS = [1, 0.85, 0.7, 0.6];
/** Seconds of *active* time behind every decision. */
const WINDOW = 2;
/** Slower than this multiple of the budget for a whole window → step down. */
const OVER = 1.35;
/** Faster than this for `CALM` consecutive windows → step back up. */
const UNDER = 1.1;
const CALM = 3;
// A high user cap is a preference, not evidence of the display refresh rate.
const CEILING = 60;

/**
 * Cadence alone cannot distinguish a slow display from an overloaded renderer.
 * Require measured CPU/GPU work above budget before lowering resolution.
 * Without timing evidence we conservatively keep the current pixel budget.
 */
export class AdaptiveResolution {
  constructor() {
    this.index = 0;
    this._elapsed = 0;
    this._frames = 0;
    this._workTotal = 0;
    this._gpuTotal = 0;
    this._gpuSamples = 0;
    this._calm = 0;
  }

  get scale() {
    return STEPS[this.index];
  }

  /** Back to full resolution, e.g. when the setting is switched off. */
  reset() {
    this.index = 0;
    this._elapsed = 0;
    this._frames = 0;
    this._workTotal = 0;
    this._gpuTotal = 0;
    this._gpuSamples = 0;
    this._calm = 0;
  }

  /**
   * @param {number}  dt        wall seconds since the previous frame
   * @param {number}  targetFps the cap the loop is aiming at right now
   * @param {boolean} active    whether this frame was drawn at the active rate
   * @param {number} workMs measured CPU/GPU work, excluding frame-cap waiting
   * @param {number|null} gpuMs newly completed GPU timing, if available
   * @returns {boolean} whether `scale` changed
   */
  sample(dt, targetFps, active, workMs = 0, gpuMs = null) {
    // A stall (tab switch, shader compile, GC) is not a resolution problem.
    if (!active || !(dt > 0) || dt > 1) return false;

    const budget = 1 / Math.min(CEILING, Math.max(1, targetFps));
    this._workTotal += Number.isFinite(workMs) ? workMs : 0;
    if (Number.isFinite(gpuMs)) {
      this._gpuTotal += gpuMs;
      this._gpuSamples++;
    }
    this._elapsed += dt;
    this._frames++;
    if (this._elapsed < WINDOW) return false;

    const busy = Math.max(this._workTotal / this._frames,
      this._gpuSamples >= 2 ? this._gpuTotal / this._gpuSamples : 0) > budget * OVER * 1000;
    const measured = this._elapsed / this._frames;
    this._elapsed = 0;
    this._frames = 0;
    this._workTotal = 0;
    this._gpuTotal = 0;
    this._gpuSamples = 0;

    if (measured > budget * OVER && busy) {
      this._calm = 0;
      if (this.index >= STEPS.length - 1) return false;
      this.index++;
      return true;
    }

    if (measured < budget * UNDER) {
      this._calm++;
      if (this.index === 0 || this._calm < CALM) return false;
      this._calm = 0;
      this.index--;
      return true;
    }

    this._calm = 0;
    return false;
  }
}
