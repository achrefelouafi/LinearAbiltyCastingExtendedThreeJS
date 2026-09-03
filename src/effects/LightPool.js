import { PointLight } from 'three';
import { settings } from '../config/settings.js';
import { damp } from '../utils/math.js';

const POOL_SIZE = 6;

/**
 * A fixed set of dynamic point lights shared by every ability.
 *
 * The lights are created once and stay in the scene forever — adding or
 * removing a light changes the lighting program's cache key and forces three to
 * recompile *every* material, which is the classic cause of a hitch when a VFX
 * spawns. Unused lights simply sit at zero intensity.
 */
export class LightPool {
  constructor(scene) {
    this.lights = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const light = new PointLight(0xffffff, 0, 10, 2);
      light.castShadow = false;
      light.intensity = 0;
      light.visible = true;
      scene.add(light);
      this.lights.push({ light, inUse: false, target: 0 });
    }
  }

  /** @returns {object|null} a handle, or null when the pool is exhausted */
  acquire() {
    for (const entry of this.lights) {
      if (!entry.inUse) {
        entry.inUse = true;
        entry.target = 0;
        entry.light.intensity = 0;
        return entry;
      }
    }
    return null;
  }

  /**
   * Drive an acquired light. Intensity/​distance are eased toward the target so
   * editor changes and ability fades never pop.
   */
  set(entry, position, color, intensity, distance, dt) {
    if (!entry) return;
    entry.light.position.copy(position);
    entry.light.color.copy(color);
    entry.target = intensity * settings.global.lightIntensity;
    entry.light.intensity = damp(entry.light.intensity, entry.target, 0.0005, dt);
    entry.light.distance = distance * settings.global.lightRadius;
  }

  release(entry) {
    if (!entry) return;
    entry.inUse = false;
    entry.target = 0;
  }

  /** Fade released lights out instead of cutting them. */
  update(dt) {
    for (const entry of this.lights) {
      if (!entry.inUse && entry.light.intensity > 0.001) {
        entry.light.intensity = damp(entry.light.intensity, 0, 0.0001, dt);
      }
    }
  }

  reset() {
    for (const entry of this.lights) {
      entry.inUse = false;
      entry.target = 0;
      entry.light.intensity = 0;
    }
  }

  dispose() {
    for (const entry of this.lights) entry.light.parent?.remove(entry.light);
    this.lights.length = 0;
  }
}
