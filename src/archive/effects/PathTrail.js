import { Mesh, Vector3 } from 'three';
import { RibbonGeometry, RibbonMode } from './RibbonGeometry.js';
import { TrailMaterial } from '../materials/TrailMaterial.js';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { saturate } from '../utils/math.js';

/**
 * The glowing ribbon that follows the cursor while a path is being drawn, and
 * burns away once the ability is released.
 */
export class PathTrail {
  constructor(maxSegments = 220) {
    this.ribbon = new RibbonGeometry(maxSegments);
    this.material = new TrailMaterial();
    this.mesh = new Mesh(this.ribbon.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = 20;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'PathTrail';
    this.mesh.visible = false;

    this._points = [];
    this._count = 0;
    this._dissolving = false;
    this._dissolve = 0;
    this._head = 1;
  }

  /**
   * Replace the displayed polyline (world space, already on the ground).
   * Points are copied: the caller's buffer is recycled between strokes and the
   * trail may still be dissolving from the previous one.
   */
  setPoints(points, count = points.length) {
    while (this._points.length < count) this._points.push(new Vector3());
    for (let i = 0; i < count; i++) this._points[i].copy(points[i]);
    this._count = count;
    this.mesh.visible = count >= 2;
    this._dissolving = false;
    this._dissolve = 0;
    this.material.uniforms.uDissolve.value = 0;
  }

  /** Start the burn-away animation; the ribbon hides itself when finished. */
  release() {
    if (!this.mesh.visible) return;
    this._dissolving = true;
  }

  hide() {
    this.mesh.visible = false;
    this._dissolving = false;
    this._dissolve = 0;
    this.ribbon.clear();
  }

  update(dt) {
    if (!this.mesh.visible) return;

    this.material.sync();

    if (this._dissolving) {
      this._dissolve += dt * settings.trail.dissolveSpeed;
      this.material.uniforms.uDissolve.value = saturate(this._dissolve);
      if (this._dissolve >= 1.15) this.hide();
    }

    if (this._count >= 2) {
      const taper = settings.trail.taper;
      this.ribbon.build(this._points, {
        count: this._count,
        width: settings.trail.width,
        mode: RibbonMode.FLAT,
        // Bell-shaped taper: thin at both ends, full width in the middle.
        widthProfile: (t) => 1 - taper * (1 - Math.pow(Math.sin(Math.PI * saturate(t)), 0.45))
      });
    }
  }

  dispose() {
    this.ribbon.dispose();
    this.material.dispose();
  }
}
