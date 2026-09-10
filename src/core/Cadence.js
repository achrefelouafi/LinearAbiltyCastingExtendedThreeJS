/** Periodic refresh budget that preserves remainder across display frames. */
export class Cadence {
  constructor() {
    this.elapsed = 0;
    this.first = true;
  }

  due(dt, fps) {
    const interval = 1 / Math.max(1, fps);
    this.elapsed += dt;
    if (this.first || !Number.isFinite(dt)) {
      this.first = false;
      this.elapsed = 0;
      return true;
    }
    if (this.elapsed + 1e-6 < interval) return false;
    this.elapsed = Math.max(0, this.elapsed - Math.floor((this.elapsed + 1e-6) / interval) * interval);
    return true;
  }
}
