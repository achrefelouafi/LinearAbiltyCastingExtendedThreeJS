import { MathUtils, Vector3 } from 'three';
import { settings } from '../config/settings.js';
import { AirScooter } from '../effects/AirScooter.js';
import { DecalType } from '../effects/GroundDecals.js';
import { getColor } from '../utils/color.js';
import { clamp, damp, Easing, saturate } from '../utils/math.js';

const TAU = Math.PI * 2;

const _p = new Vector3();
const _t = new Vector3();
const _side = new Vector3();

/** Shortest signed angle from `a` to `b`. */
const wrapAngle = (angle) => MathUtils.euclideanModulo(angle + Math.PI, TAU) - Math.PI;

/**
 * Phases of a ride. `idle` is the only one in which the character is back under
 * the animation clip's control.
 */
const Phase = Object.freeze({
  IDLE: 'idle',
  LEAP: 'leap', // arcing through the air toward the head of the path
  RIDE: 'ride', // seated on the ball, following the path
  DISMOUNT: 'dismount' // stepping off at the far end
});

/**
 * Walk mode: turns a drawn path into a ride instead of a cast.
 *
 * The sequence is
 *
 *   leap → land → fold into the meditation pose on an air scooter →
 *   ride the path, banking into its turns → dismount → standing idle
 *
 * and it is driven entirely from the curve `PathDrawer` already produces, so a
 * walk and a cast are the same gesture. The controller owns the character's
 * placement (position, heading, bank) for as long as a ride lasts and hands it
 * straight back afterwards; `CharacterController` never knows about any of it
 * beyond the small placement API it exposes.
 */
export class WalkController {
  /**
   * @param {import('./CharacterController.js').CharacterController} character
   * @param {object} ctx { scene, particles, lights, decals, bursts, shake }
   */
  constructor(character, ctx) {
    this.character = character;
    this.ctx = ctx;

    this.scooter = new AirScooter(ctx);
    ctx.scene.add(this.scooter.group);

    this.phase = Phase.IDLE;
    this.curve = null;
    this.length = 0;
    this.distance = 0; // metres ridden
    this.speed = 0;

    this._from = new Vector3(); // where the leap started
    this._target = new Vector3(); // where it lands
    this._home = new Vector3(); // where the whole sequence started
    this._exit = new Vector3(); // where the dismount started
    this._anchor = new Vector3(); // where the ball is, which is his seat minus him
    this._leapTime = 0;
    this._leapDuration = 0;
    this._rideTime = 0;
    this._dismountTime = 0;
    this._yaw = 0;
    this._lean = 0;
    this._landStanding = false; // the leap home, which ends on foot
  }

  get active() {
    return this.phase !== Phase.IDLE;
  }

  /** Height of the ball's centre above the floor. */
  get ballHeight() {
    return settings.walk.radius + settings.walk.hover;
  }

  /** Height the seat rides at — the ball's top, minus how far he sinks into it. */
  get seatHeight() {
    const c = settings.walk;
    return this.ballHeight + c.radius * (1 - c.seatSink);
  }

  /* ------------------------------------------------------------------ */
  /* entry points                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Ride `curve`. Re-triggering mid-ride is allowed: he simply leaps off
   * whatever he is doing and onto the head of the new path.
   *
   * @returns {boolean} whether the path was long enough to ride
   */
  begin(curve) {
    const length = curve.getLength();
    if (length < 0.5) return false;

    this.scooter.cancel();

    this.curve = curve;
    this.length = length;
    this.distance = 0;
    this.speed = 0;
    this._rideTime = 0;
    this._landStanding = false;

    if (!this.active) this._home.copy(this.character.position);

    this._from.copy(this.character.position);
    curve.getPointAt(0, this._target).setY(this.seatHeight);
    this._startLeap();
    return true;
  }

  /** Abandon the ride and put him back on his feet where he stands. */
  cancel() {
    if (!this.active) return;
    this.scooter.cancel();
    this.phase = Phase.IDLE;
    this.curve = null;
    this.character.setPose('idle', settings.walk.poseBlend);
    this.character.resetPlacement();
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    if (dt > 0) {
      switch (this.phase) {
        case Phase.LEAP:
          this._updateLeap(dt);
          break;
        case Phase.RIDE:
          this._updateRide(dt);
          break;
        case Phase.DISMOUNT:
          this._updateDismount(dt);
          break;
        default:
          break;
      }
    }

    // The ball keeps animating through the dismount and the fade after it, so
    // it is updated outside the phase switch. It only tracks him while he is
    // riding: once he steps off, it stays where he left it and dissipates there.
    if (this.scooter.active) {
      if (this.phase === Phase.RIDE) {
        this._anchor.set(this.character.position.x, this.ballHeight, this.character.position.z);
      }
      _side.set(Math.cos(this._yaw), 0, -Math.sin(this._yaw)); // the rider's left
      this.scooter.update(dt, this._anchor, _side, this.distance, this.speed);
    }
  }

  /* ------------------------------------------------------------------ */
  /* leap                                                                */
  /* ------------------------------------------------------------------ */

  _startLeap() {
    const c = settings.walk;
    const reach = _p.copy(this._target).setY(0).distanceTo(_t.copy(this._from).setY(0));

    this.phase = Phase.LEAP;
    this._leapTime = 0;
    this._leapDuration = clamp(reach / Math.max(0.5, c.jumpSpeed), c.jumpMin, c.jumpMax);
    this._yaw = this.character.facing;

    // He pushes off: a ring of dust at the take-off point.
    _p.set(this._from.x, 0.02, this._from.z);
    this.ctx.decals.spawn(DecalType.DUSTRING, _p, {
      radius: 1.4,
      life: 0.8,
      intensity: 0.5,
      colorA: getColor(c.colorInner),
      colorB: getColor(c.colorOuter)
    });
  }

  _updateLeap(dt) {
    const c = settings.walk;
    this._leapTime += dt;
    const t = saturate(this._leapTime / Math.max(0.05, this._leapDuration));

    // Horizontal travel is near-linear (it is a jump, not an ease); the height
    // is the parabola through both ends.
    _p.lerpVectors(this._from, this._target, t);
    _p.y += c.jumpHeight * 4 * t * (1 - t);
    this.character.root.position.copy(_p);

    this._faceLeap(dt, t);
    this._lean = damp(this._lean, 0, 0.01, dt); // any bank from a cut-short ride
    this.character.setLean(this._lean);

    // Legs fold up in the air so he arrives already in the pose — held back to
    // `tuck` so the fold reads as part of the landing, not of the take-off.
    if (!this._landStanding && t >= c.tuck && !this.character.isSitting) {
      this.character.setPose('sitting', c.poseBlend);
    }

    if (t < 1) return;

    /* ---- landing ---- */
    this.character.root.position.copy(this._target);

    if (this._landStanding) {
      this.character.resetPlacement();
      this.phase = Phase.IDLE;
      this.curve = null;
      this._land(0.5);
      return;
    }

    this._anchor.set(this._target.x, this.ballHeight, this._target.z);
    this.scooter.spawn(this._anchor);
    this.phase = Phase.RIDE;
    this._rideTime = 0;
    this.distance = 0;
    this.speed = 0;
    this._land(1);
  }

  /**
   * Aim the leap. He starts out facing where he is going and turns onto the
   * path's own heading as he comes down, so the ride begins already lined up.
   */
  _faceLeap(dt, t) {
    _t.copy(this._target).sub(this._from).setY(0);
    const travel = _t.lengthSq() > 1e-4 ? Math.atan2(_t.x, _t.z) : this._yaw;

    let target = travel;
    if (this.curve && !this._landStanding) {
      this.curve.getTangentAt(0, _t).setY(0);
      if (_t.lengthSq() > 1e-6) {
        const along = Math.atan2(_t.x, _t.z);
        target = travel + wrapAngle(along - travel) * (t * t);
      }
    }
    this._turnTo(target, dt, 0.0005);
  }

  /** Dust and a small camera kick when he touches down. */
  _land(scale) {
    const c = settings.walk;
    _p.set(this.character.position.x, 0.02, this.character.position.z);
    this.ctx.decals.spawn(DecalType.DUSTRING, _p, {
      radius: 2.2 * scale,
      life: 1.0,
      intensity: 0.6 * scale,
      colorA: getColor(c.colorInner),
      colorB: getColor(c.colorOuter)
    });
    this.ctx.shake.add(0.22 * c.landShake * settings.global.explosionIntensity * scale, 1.0, 24);
  }

  /* ------------------------------------------------------------------ */
  /* ride                                                                */
  /* ------------------------------------------------------------------ */

  _updateRide(dt) {
    const c = settings.walk;
    this._rideTime += dt;

    /* ---- how fast he is going ---- */
    const remaining = Math.max(0, this.length - this.distance);
    const rampIn = Easing.outCubic(saturate(this._rideTime / Math.max(0.01, c.accel)));
    // Glide to a stop over the last `brake` seconds' worth of path, but never
    // below a crawl or the ride would asymptote and never finish.
    const brakeDistance = Math.max(0.05, c.speed * c.brake);
    const rampOut = MathUtils.lerp(0.22, 1, Easing.outQuad(saturate(remaining / brakeDistance)));
    this.speed = c.speed * rampIn * rampOut;
    this.distance += this.speed * dt;

    /* ---- where that puts him ---- */
    const u = saturate(this.distance / this.length);
    this.curve.getPointAt(u, _p);
    this.curve.getTangentAt(u, _t).setY(0);

    const heading = _t.lengthSq() > 1e-6 ? Math.atan2(_t.x, _t.z) : this._yaw;
    const turn = this._turnTo(heading, dt, c.turnDamping);

    // A hair of bounce, and a little more of it the faster he is moving.
    const bob =
      Math.sin(this._rideTime * c.bobRate * TAU) * c.bob * saturate(this.speed / Math.max(0.5, c.speed));
    this.character.root.position.set(_p.x, this.seatHeight + bob, _p.z);

    /* ---- bank into the turn ---- */
    // Positive `turn` is a left-hand turn, and banking into it drops his left
    // shoulder — which is a *negative* roll about the rig's forward axis.
    const rate = Math.max(0.05, c.leanRate);
    const target = -clamp(turn / rate, -1, 1) * c.lean * MathUtils.DEG2RAD;
    this._lean = damp(this._lean, target, c.leanDamping, dt);
    this.character.setLean(this._lean);

    if (this.distance >= this.length - 1e-4) this._startDismount();
  }

  /* ------------------------------------------------------------------ */
  /* dismount                                                            */
  /* ------------------------------------------------------------------ */

  _startDismount() {
    this.phase = Phase.DISMOUNT;
    this._dismountTime = 0;
    this._exit.copy(this.character.position);
    this.scooter.release();
    this.character.setPose('idle', settings.walk.poseBlend);
  }

  _updateDismount(dt) {
    const c = settings.walk;
    this._dismountTime += dt;
    const t = saturate(this._dismountTime / Math.max(0.05, c.dismountTime));
    const e = Easing.outCubic(t);

    // He steps off forward as the ball drops away under him.
    _t.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
    _p.copy(this._exit).addScaledVector(_t, e * 0.45);
    _p.y = MathUtils.lerp(this._exit.y, 0, e);
    this.character.root.position.copy(_p);

    this._lean = damp(this._lean, 0, 0.0005, dt);
    this.character.setLean(this._lean);

    if (t < 1) return;

    this.character.resetPlacement();
    this._land(0.7);

    // Optionally hop back to where the whole thing started.
    if (settings.walk.returnHome && this._home.distanceTo(this.character.position) > 0.5) {
      this._from.copy(this.character.position);
      this._target.copy(this._home).setY(0);
      this._landStanding = true;
      this._startLeap();
      return;
    }

    this.phase = Phase.IDLE;
    this.curve = null;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Swing the heading toward `target`.
   * @returns {number} the angular velocity actually used, radians/second
   */
  _turnTo(target, dt, rate) {
    const delta = wrapAngle(target - this._yaw);
    const step = delta * (1 - Math.pow(rate, dt));
    this._yaw += step;
    this.character.setFacing(this._yaw);
    return step / Math.max(dt, 1e-4);
  }

  dispose() {
    this.scooter.dispose();
    this.ctx.scene.remove(this.scooter.group);
  }
}
