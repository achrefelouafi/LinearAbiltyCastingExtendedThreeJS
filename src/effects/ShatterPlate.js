import { Mesh } from 'three';
import { createShatterPlateGeometry } from '../assets/ShatterGeometry.js';
import { createShatterStoneMaterial } from '../materials/ShatterStoneMaterial.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { saturate, Easing } from '../utils/math.js';

/**
 * One broken floor plate, owned by the cast that made it.
 *
 * Deliberately *not* a global pooled system like `DecalSystem`: a Venom Surge
 * makes exactly one plate, at the impact, and
 * hanging it off the ability means it is recycled by the ability pool for free
 * and `core/App.js` never hears about it.
 *
 * The geometry is rebuilt only when a *shape* control moves — slab count,
 * thickness, how ragged the outline is. Those cannot be expressed as a uniform,
 * and cutting a fifty-cell Voronoi is well under a millisecond, so they stay
 * live sliders the same way the crystal facet count does: a shape key, and a
 * rebuild when it changes.
 */
export class ShatterPlate {
  /**
   * @param {import('../world/Environment.js').Environment} environment
   */
  constructor(environment) {
    this.material = createShatterStoneMaterial(environment);
    this._shapeKey = '';

    this.mesh = new Mesh(this._buildGeometry(), this.material);
    // On WORLD so it takes the sun and the gems' shadows; not a caster, because
    // three would build that shadow from the undeformed disc. See the material.
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;

    this.age = 0;
    this.radius = 1;
    this.active = false;
    this._state = { grown: 0, sink: 0, fade: 1 };
  }

  _buildGeometry() {
    const c = settings.venom;
    return createShatterPlateGeometry({
      seed: 3 + Math.random() * 40,
      cells: c.slabCount,
      depth: c.slabDepth,
      bias: c.slabBias,
      ragged: c.slabRagged
    });
  }

  /** Re-cut the plate when a control the uniforms cannot express has moved. */
  _syncGeometry() {
    const c = settings.venom;
    const key = `${Math.round(c.slabCount)}|${c.slabDepth.toFixed(3)}|${c.slabBias.toFixed(3)}|${c.slabRagged.toFixed(3)}`;
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    const previous = this.mesh.geometry;
    this.mesh.geometry = this._buildGeometry();
    previous.dispose();
  }

  /**
   * Tear the floor open.
   * @param {THREE.Vector3} position on the floor
   * @param {number} radius metres
   */
  spawn(position, radius) {
    this.age = 0;
    this.radius = Math.max(0.2, radius);
    this.active = true;

    this._syncGeometry();
    this.mesh.position.set(position.x, 0.012, position.z);
    this.mesh.rotation.y = Math.random() * Math.PI * 2;
    this.mesh.scale.setScalar(this.radius);
    this.mesh.visible = true;

    this._state.grown = 0;
    this._state.sink = 0;
    this._state.fade = 1;
    this.material.userData.sync(this._state);
  }

  /**
   * @param {number} dt
   * @param {number} sink 0..1, the plate withdrawing at the end of the cast
   * @param {number} fade 0..1 on the seam light only — the stone stays stone
   */
  update(dt, sink = 0, fade = 1) {
    if (!this.active) return;
    this.age += dt;

    this._syncGeometry();

    // The fracture races out at a fixed metres-per-second, so a wide plate
    // takes longer to finish breaking than a narrow one — which is the only
    // reason a big crater feels heavier than a small one.
    const speed = settings.venom.slabGrowth;
    this._state.grown = saturate((this.age * speed) / this.radius);
    this._state.sink = Easing.inCubic(saturate(sink));
    this._state.fade = saturate(fade);

    this.material.userData.sync(this._state);
  }

  hide() {
    this.active = false;
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
