/**
 * Frame timer.
 *
 * Two clocks from one tick. `delta` drives the simulation and is bounded at
 * 100 ms — enough for the supported 15 FPS idle mode, but never enough for a
 * stall to teleport an ability. `rawDelta` is unbounded wall time, on purpose:
 * cooldowns, the camera and the aim indicator are all saturating or clamped,
 * and they should reflect how long the user actually waited. Visibility
 * changes reset both.
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
