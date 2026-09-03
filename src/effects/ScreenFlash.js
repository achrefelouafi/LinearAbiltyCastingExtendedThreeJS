import { Color } from 'three';
import { settings } from '../config/settings.js';
import { damp } from '../utils/math.js';

/**
 * Full-screen colour flash for impacts.
 *
 * Holds nothing but state — the composite pass reads `color` and `strength`
 * every frame, so a flash costs no extra draw call.
 */
export class ScreenFlash {
  constructor() {
    this.color = new Color(1, 1, 1);
    this.strength = 0;
    this._decay = 0.0004;
  }

  /**
   * @param {THREE.Color} color
   * @param {number} strength 0..1
   * @param {number} [decay]  fraction remaining after one second
   */
  trigger(color, strength, decay = 0.0004) {
    const scaled = strength * settings.post.flashStrength;
    if (scaled <= this.strength) return;
    this.color.copy(color);
    this.strength = Math.min(1, scaled);
    this._decay = decay;
  }

  update(dt) {
    if (this.strength <= 0.0005) {
      this.strength = 0;
      return;
    }
    this.strength = damp(this.strength, 0, this._decay, dt);
  }

  reset() {
    this.strength = 0;
  }
}
