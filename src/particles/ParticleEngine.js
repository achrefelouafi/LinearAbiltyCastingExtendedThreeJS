import { ParticleSystem } from './ParticleSystem.js';
import { settings } from '../config/settings.js';

/**
 * Owns every particle system in the app.
 *
 * Systems are created lazily by name and *shared* between every instance of an
 * ability, which is what makes the pools meaningful: casting fire twenty times
 * recycles the same ember buffer instead of building a new one.
 */
export class ParticleEngine {
  constructor(scene) {
    this.scene = scene;
    this.systems = new Map();
  }

  /**
   * Fetch (or lazily create) a shared system.
   * @param {string} name
   * @param {object} options see ParticleSystem
   * @returns {ParticleSystem}
   */
  get(name, options) {
    let system = this.systems.get(name);
    if (!system) {
      system = new ParticleSystem({ name, ...options });
      this.systems.set(name, system);
      this.scene.add(system.object3D);
    }
    return system;
  }

  /** Upload the frame's spawn data. Called once, after all abilities update. */
  flush() {
    for (const system of this.systems.values()) system.flush();
  }

  /**
   * Number of particles currently alive, for the HUD.
   * Walks the pools, so call it on the stats interval — not every frame.
   */
  countLive(time) {
    let total = 0;
    for (const system of this.systems.values()) total += system.countLive(time);
    return total;
  }

  reset() {
    for (const system of this.systems.values()) system.reset();
  }

  dispose() {
    for (const system of this.systems.values()) {
      this.scene.remove(system.object3D);
      system.dispose();
    }
    this.systems.clear();
  }
}

/**
 * Fractional-rate emitter.
 *
 * Emitting `rate * dt` particles per frame would truncate to zero at high frame
 * rates and burst at low ones; accumulating the remainder makes emission
 * genuinely frame-rate independent.
 */
export class RateEmitter {
  constructor(rate = 30) {
    this.rate = rate;
    this._accumulator = 0;
  }

  /** @returns {number} whole particles to spawn this frame */
  tick(dt, rate = this.rate) {
    this._accumulator += rate * settings.global.emissionRate * dt;
    const count = Math.floor(this._accumulator);
    this._accumulator -= count;
    // Never let a stall dump thousands of particles in a single frame.
    return Math.min(count, 240);
  }

  reset() {
    this._accumulator = 0;
  }
}
