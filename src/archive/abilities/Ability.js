import { Group, Vector3, Quaternion, Matrix4, Color } from 'three';
import { settings } from '../config/settings.js';
import { saturate, smoothstep, Easing } from '../utils/math.js';
import { getColor } from '../utils/color.js';
import { LAYER } from '../core/Layers.js';

export const AbilityPhase = Object.freeze({
  IDLE: 'idle',
  TRAVEL: 'travel',
  IMPACT: 'impact',
  FADE: 'fade',
  DONE: 'done'
});

const _matrix = new Matrix4();
const _up = new Vector3(0, 1, 0);
const _zero = new Vector3(0, 0, 0);
const _tmpQuat = new Quaternion();

/**
 * Abstract base for every elemental ability.
 *
 * Responsibilities kept here (so subclasses only describe how their element
 * *looks*):
 *   - lifecycle & phase machine (travel → impact → fade → done)
 *   - frame-rate independent, arc-length correct spline traversal with easing
 *   - a moving window of the path used to build trailing ribbons
 *   - dynamic light bookkeeping
 *   - pooling contract (`spawn` must fully reset state; `destroy` must release)
 *
 * Subclasses implement: `createShaders`, `createParticles`, `onSpawn`,
 * `onTravel`, `onImpact`, `onFade`, `onDestroy`.
 *
 * Adding a fifth element therefore means one new file plus a settings block —
 * nothing else in the project changes.
 */
export class Ability {
  /**
   * @param {string} element  key into `settings` ('fire' | 'water' | ...)
   * @param {object} context  shared systems (see AbilityManager)
   */
  constructor(element, context) {
    this.element = element;
    this.ctx = context;

    this.group = new Group();
    this.group.name = `Ability:${element}`;
    this.group.layers.set(LAYER.VFX);
    this.group.matrixAutoUpdate = false;

    this.phase = AbilityPhase.IDLE;
    this.curve = null;
    this.curveLength = 0;

    this.distance = 0; // metres travelled along the spline
    this.u = 0; // normalised progress 0..1
    this.age = 0;
    this.impactTime = 0;
    this.fadeTime = 0;

    this.position = new Vector3();
    this.previousPosition = new Vector3();
    this.tangent = new Vector3(0, 0, 1);
    this.velocity = new Vector3();
    this.orientation = new Quaternion();

    /** Rolling window of path points behind the head, for ribbons. */
    this.trailPoints = [];
    for (let i = 0; i < 64; i++) this.trailPoints.push(new Vector3());
    this.trailCount = 0;

    this.light = null;
    this.lightColor = new Color();
    /** Transient additive light punch (impacts). Decays on its own. */
    this.lightBoost = 0;

    this.createShaders();
    this.createParticles();
  }

  /** Live settings block for this element. */
  get config() {
    return settings[this.element];
  }

  get isActive() {
    return this.phase !== AbilityPhase.IDLE && this.phase !== AbilityPhase.DONE;
  }

  get isFinished() {
    return this.phase === AbilityPhase.DONE;
  }

  /* ------------------------------------------------------------------ */
  /* Subclass hooks                                                      */
  /* ------------------------------------------------------------------ */

  /** Build materials/meshes once, at construction. */
  createShaders() {}

  /** Register the shared particle systems this element needs. */
  createParticles() {}

  /** Called at the start of every cast, after the base state was reset. */
  onSpawn() {}

  /** Per-frame while travelling along the path. */
  onTravel(_dt) {}

  /** One-shot when the head reaches the end of the path. */
  onImpact() {}

  /** Per-frame after the impact, while the effect dies down. */
  onFade(_dt, _t) {}

  /** Release any per-cast resources. */
  onDestroy() {}

  /** How long the impact/fade phases last. Overridable per element. */
  get impactDuration() {
    return 1.1;
  }

  get fadeDuration() {
    return 1.2;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Begin a cast along `curve`.
   * @param {THREE.CatmullRomCurve3} curve
   */
  spawn(curve) {
    this.curve = curve;
    this.curveLength = Math.max(0.001, curve.getLength());

    this.distance = 0;
    this.u = 0;
    this.age = 0;
    this.impactTime = 0;
    this.fadeTime = 0;
    this.trailCount = 0;
    this.phase = AbilityPhase.TRAVEL;

    this._samplePath(0, this.position);
    curve.getTangentAt(0, this.tangent);
    this._tiltTangent(0);
    this.previousPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this._updateOrientation(1);

    this.light = this.ctx.lights.acquire();

    this.group.visible = true;
    this.onSpawn();
  }

  /**
   * Advance along the spline. Arc-length parameterised and delta-time driven,
   * so the ability travels at a constant metres-per-second regardless of frame
   * rate or how unevenly the player drew the path.
   */
  followPath(dt) {
    const speed = this.config.speed * settings.global.speed;

    // Ease in from a standstill and settle slightly before the impact so the
    // motion has weight instead of switching on and off.
    //
    // The ease-in is driven by elapsed time, not by progress: keying it off `u`
    // would multiply the very first step by zero and the ability could never
    // leave the start of the path.
    const easeIn = smoothstep(0, 0.16, this.age);
    const easeOut = 1 - 0.35 * smoothstep(0.82, 1.0, this.u);
    const profile = this.speedProfile(this.u);

    this.distance += speed * easeIn * easeOut * profile * dt;
    const previousU = this.u;
    this.u = saturate(this.distance / this.curveLength);

    this.previousPosition.copy(this.position);
    this._samplePath(this.u, this.position);
    this.curve.getTangentAt(this.u, this.tangent);
    this._tiltTangent(this.u);

    if (dt > 1e-5) {
      this.velocity.copy(this.position).sub(this.previousPosition).multiplyScalar(1 / dt);
    }

    // Orientation follows the direction of travel, smoothed to kill jitter on
    // tight curve segments.
    this._updateOrientation(1 - Math.pow(0.0015, dt));

    this._updateTrailWindow();

    return this.u >= 1 && previousU < 1;
  }

  /** Per-element speed shaping (wind gusts, earth lurches). */
  speedProfile(_u) {
    return 1;
  }

  /**
   * Height above the drawn path, in metres, at normalised progress `u`.
   *
   * The path is always drawn on the ground, but not every element crawls along
   * it — fire flies. Overriding this lifts the head, the trailing window, the
   * dynamic light and every particle emission point together, so an element only
   * has to describe its altitude, never re-derive its own trajectory.
   */
  pathHeight(_u) {
    return 0;
  }

  /** Point on the trajectory (the curve plus this element's flight height). */
  _samplePath(u, out) {
    const t = saturate(u);
    this.curve.getPointAt(t, out);
    const height = this.pathHeight(t);
    if (height !== 0) out.y += height;
    return out;
  }

  /**
   * Pitch the tangent by the slope of `pathHeight`, so a flying element points
   * where it is actually going while it climbs and levels off.
   */
  _tiltTangent(u) {
    const e = 0.01;
    const slope =
      (this.pathHeight(saturate(u + e)) - this.pathHeight(saturate(u - e))) /
      (2 * e * this.curveLength);
    if (slope === 0) return;
    this.tangent.y += slope;
    this.tangent.normalize();
  }

  _updateOrientation(alpha) {
    _matrix.lookAt(this.tangent, _zero, _up);
    _tmpQuat.setFromRotationMatrix(_matrix);
    this.orientation.slerp(_tmpQuat, saturate(alpha));
  }

  /**
   * Fill `trailPoints` with the section of the path just behind the head.
   * Length is per element (`streamLength` / `ribbonLength`).
   */
  _updateTrailWindow(lengthOverride) {
    const window = lengthOverride ?? this.trailLength;
    const uSpan = Math.min(1, window / this.curveLength);
    const uStart = Math.max(0, this.u - uSpan);
    const count = this.trailPoints.length;

    for (let i = 0; i < count; i++) {
      const t = uStart + (this.u - uStart) * (i / (count - 1));
      this._samplePath(t, this.trailPoints[i]);
    }
    this.trailCount = this.u > 0.001 ? count : 0;
  }

  /** World-space length of the trailing ribbon. */
  get trailLength() {
    return 6;
  }

  update(dt) {
    if (!this.isActive) return;
    this.age += dt;

    switch (this.phase) {
      case AbilityPhase.TRAVEL: {
        const reachedEnd = this.followPath(dt);
        this.onTravel(dt);
        this._updateLight(dt, 1);
        if (reachedEnd) {
          this.phase = AbilityPhase.IMPACT;
          this.impactTime = 0;
          this.onImpact();
        }
        // A path that outlives its element still has to end eventually.
        if (this.age > this.config.lifetime * settings.global.lifetime * 4) {
          this.phase = AbilityPhase.IMPACT;
          this.onImpact();
        }
        break;
      }

      case AbilityPhase.IMPACT: {
        this.impactTime += dt;
        const t = saturate(this.impactTime / this.impactDuration);
        this.onFade(dt, t);
        this._updateLight(dt, 1 - Easing.inQuad(t) * 0.35);
        if (t >= 1) {
          this.phase = AbilityPhase.FADE;
          this.fadeTime = 0;
        }
        break;
      }

      case AbilityPhase.FADE: {
        this.fadeTime += dt;
        const t = saturate(this.fadeTime / this.fadeDuration);
        this.onFade(dt, 1 + t);
        this._updateLight(dt, (1 - t) * 0.4);
        if (t >= 1) this.phase = AbilityPhase.DONE;
        break;
      }

      default:
        break;
    }
  }

  _updateLight(dt, scale) {
    if (!this.light) return;
    const cfg = this.config;
    this.lightColor.copy(getColor(cfg.lightColor));
    // Flicker keeps the light from reading as a static lamp.
    const flicker = 0.85 + 0.15 * Math.sin(this.age * 34) * Math.sin(this.age * 11.3);
    this.ctx.lights.set(
      this.light,
      this.position,
      this.lightColor,
      cfg.lightIntensity * scale * flicker + this.lightBoost,
      cfg.lightRadius * (1 + this.lightBoost * 0.02),
      dt
    );
    this.lightBoost = Math.max(0, this.lightBoost - this.lightBoost * 4.5 * dt - 0.5 * dt);
  }

  /** Return to the pool. Must leave the instance reusable. */
  destroy() {
    this.onDestroy();
    this.ctx.lights.release(this.light);
    this.light = null;
    this.group.visible = false;
    this.phase = AbilityPhase.IDLE;
    this.curve = null;
  }

  /** Free GPU resources (app teardown only — not part of pooling). */
  dispose() {
    this.group.parent?.remove(this.group);
  }
}
