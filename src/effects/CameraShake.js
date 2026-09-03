import { Vector3 } from 'three';
import { settings } from '../config/settings.js';

/**
 * Additive camera shake driven by layered noise.
 *
 * Multiple impacts stack into a single trauma value; the offset is derived from
 * smooth pseudo-noise rather than white noise so the motion reads as weight
 * rather than jitter. Trauma decays quadratically, which is what makes small
 * hits feel snappy and big ones feel heavy.
 */
export class CameraShake {
  constructor(rig) {
    this.rig = rig;
    this.trauma = 0;
    this.decay = 1.6;
    this.frequency = 22;
    this._time = 0;
    this._offset = new Vector3();
  }

  /**
   * @param {number} amount    0..1 trauma to add
   * @param {number} [decay]   trauma units per second
   * @param {number} [frequency]
   */
  add(amount, decay = 1.6, frequency = 22) {
    this.trauma = Math.min(1, this.trauma + amount * settings.global.cameraShake);
    this.decay = decay;
    this.frequency = frequency;
  }

  /** Sustained rumble (earth). Call every frame while the effect lasts. */
  rumble(amount, dt) {
    this.trauma = Math.min(1, this.trauma + amount * settings.global.cameraShake * dt * 3);
  }

  update(dt) {
    this._time += dt;

    if (this.trauma <= 0.0001) {
      this.rig.shakeOffset.set(0, 0, 0);
      this.rig.shakeRoll = 0;
      return;
    }

    // Quadratic falloff: perceptually linear shake for a linear trauma decay.
    const shake = this.trauma * this.trauma;
    const t = this._time * this.frequency;

    // Cheap smooth noise from summed sines at incommensurate frequencies.
    const nx = Math.sin(t * 1.0) * 0.6 + Math.sin(t * 2.31 + 1.7) * 0.4;
    const ny = Math.sin(t * 1.37 + 4.2) * 0.6 + Math.sin(t * 2.79 + 0.3) * 0.4;
    const nz = Math.sin(t * 0.83 + 2.9) * 0.6 + Math.sin(t * 3.11 + 5.1) * 0.4;

    this._offset.set(nx, ny * 0.7, nz).multiplyScalar(shake * 0.55);
    this.rig.shakeOffset.copy(this._offset);
    this.rig.shakeRoll = nz * shake * 0.035;

    this.trauma = Math.max(0, this.trauma - this.decay * dt);
  }

  reset() {
    this.trauma = 0;
    this.rig.shakeOffset.set(0, 0, 0);
    this.rig.shakeRoll = 0;
  }
}
