/** Render scales, coarsest last. Each step is roughly 30% less fill. */
const STEPS = [1, 0.85, 0.7, 0.6];
/** Seconds of *active* time behind every decision. */
const WINDOW = 2;
/** Slower than this multiple of the budget for a whole window → step down. */
const OVER = 1.35;
/** Faster than this for `CALM` consecutive windows → step back up. */
const UNDER = 1.1;
const CALM = 3;
/**
 * Ceiling on the rate the budget is measured against.
 *
 * A cap above this is a smoothness preference, not a claim about what the
 * device must manage — and measuring against it would read a 60 Hz panel as
 * permanently late and walk the resolution to the floor on hardware that is
 * perfectly fine. Falling short of 60 is the signal worth acting on.
 */
const CEILING = 60;

/**
 * Frame-time driven render scale.
 *
 * The fixed pixel-ratio cap is a guess made before the app has seen the
 * device; this is the correction afterwards. It multiplies that cap and never
 * raises it, so a user who picked 1.0 never silently gets 1.5.
 *
 * Two things make the signal usable. Idle frames are excluded outright — they
 * are throttled on purpose, so their interval says nothing about whether the
 * GPU is keeping up. And the budget is measured against at most `CEILING`,
 * because a cap above the panel's own refresh rate can never be met and would
 * otherwise read as a permanent overrun.
 *
 * Inferring the panel's refresh rate from the shortest interval seen was the
 * obvious alternative and is wrong: a device that is behind from its very
 * first frame records *that* as the display rate and then never asks for help.
 */
export class AdaptiveResolution {
  constructor() {
    this.index = 0;
    this._elapsed = 0;
    this._frames = 0;
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
    this._calm = 0;
  }

  /**
   * @param {number}  dt        wall seconds since the previous frame
   * @param {number}  targetFps the cap the loop is aiming at right now
   * @param {boolean} active    whether this frame was drawn at the active rate
   * @returns {boolean} whether `scale` changed
   */
  sample(dt, targetFps, active) {
    // A stall (tab switch, shader compile, GC) is not a resolution problem.
    if (!active || !(dt > 0) || dt > 1) return false;

    this._elapsed += dt;
    this._frames++;
    if (this._elapsed < WINDOW) return false;

    const budget = 1 / Math.min(CEILING, Math.max(1, targetFps));
    const measured = this._elapsed / this._frames;
    this._elapsed = 0;
    this._frames = 0;

    if (measured > budget * OVER) {
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
