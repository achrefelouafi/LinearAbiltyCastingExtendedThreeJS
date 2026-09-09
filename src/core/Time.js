/**
 * Frame timer.
 *
 * Wall time for UI/cooldowns and a bounded simulation delta. The 100 ms
 * simulation budget accommodates the supported 15 FPS idle mode. Visibility
 * changes reset both clocks; long stalls still cannot create huge steps.
 */
export class Time {
  constructor(maxDelta = 0.1) {
    this.maxDelta = maxDelta;
    this.elapsed = 0;
    this.delta = 0;
    this.rawDelta = 0;
    this._last = performance.now() / 1000;
  }

  /** @returns {number} clamped seconds since the previous tick */
  tick() {
    const now = performance.now() / 1000;
    this.rawDelta = Math.max(0, now - this._last);
    this.delta = Math.min(this.rawDelta, this.maxDelta);
    this._last = now;
    this.elapsed += this.delta;
    return this.delta;
  }

  /** Call after a long pause (asset load, tab switch) to avoid a jump. */
  reset() {
    this._last = performance.now() / 1000;
    this.delta = 0;
    this.rawDelta = 0;
  }
}
