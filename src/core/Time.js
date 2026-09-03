/**
 * Frame timer.
 *
 * A three-line replacement for THREE.Clock (deprecated in recent releases) that
 * also owns the delta clamp: a background tab or a long shader compile must
 * never hand the simulation a multi-second step.
 */
export class Time {
  constructor(maxDelta = 1 / 20) {
    this.maxDelta = maxDelta;
    this.elapsed = 0;
    this.delta = 0;
    this._last = performance.now() / 1000;
  }

  /** @returns {number} clamped seconds since the previous tick */
  tick() {
    const now = performance.now() / 1000;
    this.delta = Math.min(now - this._last, this.maxDelta);
    this._last = now;
    this.elapsed += this.delta;
    return this.delta;
  }

  /** Call after a long pause (asset load, tab switch) to avoid a jump. */
  reset() {
    this._last = performance.now() / 1000;
    this.delta = 0;
  }
}
