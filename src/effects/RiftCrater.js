import { Mesh } from 'three';
import { createShatterPlateGeometry } from '../assets/ShatterGeometry.js';
import { createRiftCraterMaterial } from '../materials/MonolithStoneMaterial.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { saturate, Easing } from '../utils/math.js';

/**
 * The broken floor at the impact — the bed the monoliths stand in.
 *
 * A disc of the stage floor cut into Voronoi slabs, heaved and canted by the
 * thing coming up underneath it. Without this the blast is a pile of rocks
 * sitting *on* an untouched floor, and the eye reads that instantly: the ground
 * has to have failed, or nothing came out of it.
 *
 * Owned by the cast rather than pooled globally, exactly as `ShatterPlate` is
 * for the Venom Surge — one cast makes one crater, hanging it off the ability
 * recycles it with the ability for free, and `core/App.js` never hears about it.
 *
 * The geometry is re-cut only when a *shape* control moves (slab count,
 * thickness, how ragged the outline is); everything else is a uniform, so
 * dragging the heave or the tilt reshapes a crater that is already lying on the
 * floor. Cutting a sixty-cell Voronoi is well under a millisecond.
 */
export class RiftCrater {
  /**
   * @param {import('../world/Environment.js').Environment} environment
   */
  constructor(environment) {
    this.material = createRiftCraterMaterial(environment);
    this._shapeKey = '';

    this.mesh = new Mesh(this._buildGeometry(), this.material);
    // On WORLD so it takes the sun and the monoliths' shadows. Not a caster:
    // three builds the shadow depth from the *material*, not from the patch, so
    // a casting plate would throw the shadow of the undeformed flat disc — a
    // hard dark circle on the floor. What has to cast here is the slabs, and
    // they do.
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;

    this.age = 0;
    this.radius = 1;
    this.active = false;
    this._state = { grown: 0, sink: 0 };
  }

  _buildGeometry() {
    const c = settings.quake;
    return createShatterPlateGeometry({
      seed: 7 + Math.random() * 40,
      cells: c.plateCells,
      depth: c.plateDepth,
      bias: c.plateBias,
      ragged: c.plateRagged
    });
  }

  /** Re-cut the plate when a control the uniforms cannot express has moved. */
  _syncGeometry() {
    const c = settings.quake;
    const key = `${Math.round(c.plateCells)}|${c.plateDepth.toFixed(3)}|${c.plateBias.toFixed(3)}|${c.plateRagged.toFixed(3)}`;
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    const previous = this.mesh.geometry;
    this.mesh.geometry = this._buildGeometry();
    previous.dispose();
  }

  /**
   * Break the floor open.
   * @param {THREE.Vector3} position on the floor
   * @param {number} radius metres
   */
  spawn(position, radius) {
    this.age = 0;
    this.radius = Math.max(0.2, radius);
    this.active = true;

    this._syncGeometry();
    // A whisker above the floor: co-planar with it, the two z-fight across the
    // whole disc, and the fight is worse than the offset.
    this.mesh.position.set(position.x, 0.014, position.z);
    this.mesh.rotation.y = Math.random() * Math.PI * 2;
    this.mesh.scale.setScalar(this.radius);
    this.mesh.visible = true;

    this._state.grown = 0;
    this._state.sink = 0;
    this.material.userData.sync(this._state, 0);
  }

  /**
   * @param {number} dt
   * @param {number} sink 0..1, the crater withdrawing at the end of the cast
   * @param {number} dustCoat 0..1, how much of the cloud has settled on it
   */
  update(dt, sink = 0, dustCoat = 0) {
    if (!this.active) return;
    this.age += dt;

    this._syncGeometry();

    // The fracture races out at a fixed metres-per-second, so a wide crater
    // takes longer to finish breaking than a narrow one — which is the only
    // reason a big one feels heavier than a small one.
    const speed = settings.quake.plateGrowth;
    this._state.grown = saturate((this.age * speed) / this.radius);
    this._state.sink = Easing.inCubic(saturate(sink));

    this.material.userData.sync(this._state, dustCoat);
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
