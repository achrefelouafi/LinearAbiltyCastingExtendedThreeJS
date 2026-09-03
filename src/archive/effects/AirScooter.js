import { Color, Group, Mesh, SphereGeometry, Vector3 } from 'three';
import { AirScooterMaterial } from '../materials/AirScooterMaterial.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { BurstMode } from './BurstSphere.js';
import { DecalType } from './GroundDecals.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate } from '../utils/math.js';

const UP = new Vector3(0, 1, 0);
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _tint = new Color();

/** Seconds the ball takes to puff into existence / to blow apart. */
const BIRTH_TIME = 0.28;
const DEATH_TIME = 0.45;

/**
 * The air ball the avatar rides in walk mode: one shader sphere, a point light,
 * a stream of dust and the two impacts that bracket its life.
 *
 * It owns no motion of its own — `WalkController` tells it where the ride has
 * got to every frame and this class turns that into an orientation (the ball
 * spins about world-up), a squash, a light and some debris.
 */
export class AirScooter {
  /**
   * @param {object} ctx { scene, particles, lights, decals, bursts, shake }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new Group();
    this.group.name = 'AirScooter';
    this.group.visible = false;

    this.material = new AirScooterMaterial();
    this.mesh = new Mesh(new SphereGeometry(1, 48, 32), this.material);
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = 12;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    this.dust = ctx.particles.get('walk.dust', {
      capacity: 900,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      softFade: 0.4
    });
    this.dust.uniforms.uGravity.value.set(0, -0.35, 0);
    this.dust.uniforms.uDrag.value = 0.9;
    this.dust.uniforms.uEndSize.value = 0.6;
    this.dust.uniforms.uSwirlExpand.value = 1.5;
    this.dustEmitter = new RateEmitter();

    this.light = null;
    this._birth = 0; // 0..1 puff-in
    this._death = 0; // 0..1 dissipation, only once released
    this._releasing = false;
    this._spin = 0; // accumulated rolling angle, radians
  }

  get active() {
    return this.group.visible;
  }

  /* ------------------------------------------------------------------ */

  /** Puff the ball into existence under the rider. */
  spawn(position) {
    const c = settings.walk;

    this._birth = 0;
    this._death = 0;
    this._releasing = false;
    this._spin = 0;
    this.dustEmitter.reset();

    this.group.visible = true;
    this.mesh.position.copy(position);
    this.mesh.scale.setScalar(0.001);
    this.light = this.light ?? this.ctx.lights.acquire();

    const inner = getColor(c.colorInner);
    const outer = getColor(c.colorOuter);

    // The air gets punched out from under him as the ball compresses.
    this.ctx.bursts.spawn(BurstMode.AIR, position, {
      radius: c.radius * 0.5,
      endRadius: c.radius * 4.5,
      life: 0.45,
      intensity: 0.9 * settings.global.glow,
      fresnel: c.fresnel,
      displace: 0.3,
      colorA: outer,
      colorB: inner,
      colorC: inner
    });
    _pos.set(position.x, 0.02, position.z);
    this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
      radius: c.radius * 5.0,
      life: 1.0,
      intensity: 0.7,
      colorA: inner,
      colorB: outer
    });
    this._puff(position, 60, 4.0);
    this.ctx.shake.add(0.18 * c.landShake * settings.global.explosionIntensity, 0.9, 22);
  }

  /**
   * @param {Vector3} position  ball centre
   * @param {Vector3} side      the rider's left, horizontal — aims the dust
   * @param {number}  distance  metres ridden so far (winds the surface round)
   * @param {number}  speed     metres/second, drives the dust
   * @param {number}  dt
   */
  update(dt, position, side, distance, speed) {
    if (!this.group.visible) return;

    const c = settings.walk;
    this.material.sync();

    if (this._releasing) {
      this._death = saturate(this._death + dt / DEATH_TIME);
      if (this._death >= 1) {
        this._retire();
        return;
      }
    } else {
      this._birth = saturate(this._birth + dt / BIRTH_TIME);
    }

    const birth = Easing.outBack(this._birth);
    const fade = 1 - Easing.outQuad(this._death);
    this.material.uniforms.uBirth.value = this._birth;
    this.material.uniforms.uFade.value = fade;

    /* ---- placement ---- */
    this.mesh.position.copy(position);

    // It spins about world-up only — a hovering disc of air rather than a ball
    // rolling along the ground, so the streamlines read as a vortex under him
    // and the silhouette stays put. Still driven by distance, so it winds up
    // and unwinds with the ride.
    this._spin = distance / Math.max(0.05, c.radius);
    this.mesh.quaternion.setFromAxisAngle(UP, this._spin);

    // Squashed under the rider's weight, and blown out again as it dies. The
    // squash axis is world-up, which the spin leaves untouched.
    const squash = 1 - c.squash * (1 - this._death * 0.6);
    const grow = c.radius * birth * (1 + this._death * 0.7);
    this.mesh.scale.set(grow, grow * squash, grow);

    /* ---- light ---- */
    if (this.light) {
      _pos.copy(position).setY(position.y + c.radius * 0.4);
      this.ctx.lights.set(
        this.light,
        _pos,
        getColor(c.lightColor),
        c.lightIntensity * birth * fade,
        c.lightRadius,
        dt
      );
    }

    /* ---- dust shed under the ball ---- */
    if (!this._releasing) {
      const rate = c.dustRate * (0.35 + 0.65 * saturate(speed / Math.max(0.5, c.speed)));
      const count = Math.round(this.dustEmitter.tick(dt, rate) * settings.global.particleCount);
      if (count > 0) {
        _pos.copy(position).setY(Math.max(0.04, position.y - c.radius * 0.75));
        _emit.position = _pos;
        _emit.radius = c.radius * 1.15;
        // Thrown outward and backward, the way a hovercraft skirts its cushion.
        _dir.copy(side).cross(UP).normalize().multiplyScalar(-1);
        _emit.direction = _dir;
        _emit.speed = speed * 0.35 + 0.6;
        _emit.speedVariance = 0.6;
        _emit.spread = 0.85;
        _emit.inherit = null;
        _emit.anchor = position;
        _emit.size = 0.12;
        _emit.sizeVariance = 0.6;
        _emit.life = c.dustLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = frame.uTime.value;
        this.dust.emit(count, _emit);
      }
    }

    this._syncDustLook();
  }

  /** Blow the ball apart at the end of the ride. */
  release() {
    if (!this.group.visible || this._releasing) return;
    const c = settings.walk;
    this._releasing = true;
    this._death = 0;

    const inner = getColor(c.colorInner);
    const outer = getColor(c.colorOuter);

    this.ctx.bursts.spawn(BurstMode.AIR, this.mesh.position, {
      radius: c.radius,
      endRadius: c.radius * 6.0,
      life: 0.6,
      intensity: 1.1 * settings.global.glow,
      fresnel: c.fresnel,
      displace: 0.35,
      colorA: outer,
      colorB: inner,
      colorC: inner
    });
    _pos.set(this.mesh.position.x, 0.02, this.mesh.position.z);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.radius * 7.0,
      life: 0.6,
      width: 0.05,
      intensity: 0.8,
      colorA: outer,
      colorB: inner
    });
    this._puff(this.mesh.position, 90, 5.5);
    this.ctx.shake.add(0.14 * c.landShake * settings.global.explosionIntensity, 0.8, 20);
  }

  /** Kill it outright — mode switches and "clear effects". */
  cancel() {
    this._retire();
  }

  /* ------------------------------------------------------------------ */

  _retire() {
    this.group.visible = false;
    this._releasing = false;
    this._birth = 0;
    this._death = 0;
    if (this.light) {
      this.ctx.lights.release(this.light);
      this.light = null;
    }
  }

  /** One outward puff of dust — used on both the spawn and the dismount. */
  _puff(position, count, speed) {
    const c = settings.walk;
    _pos.copy(position);
    _emit.position = _pos;
    _emit.radius = c.radius * 0.9;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = speed;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = _pos;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.6;
    _emit.life = c.dustLifetime * 1.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this._syncDustLook();
    this.dust.emit(Math.round(count * settings.global.particleCount), _emit);
  }

  _syncDustLook() {
    const c = settings.walk;
    const g = settings.global;
    const inner = getColor(c.colorInner);
    const outer = getColor(c.colorOuter);
    this.dust.setGradient(inner, outer, outer, _tint.copy(outer).multiplyScalar(0.4));
    // `dustSize` scales the emitted size rather than replacing it, the way every
    // other system here works — otherwise the motes come out the size of the ball.
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize * 3.0;
    this.dust.uniforms.uLifeScale.value = g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = 0.35 * g.opacity;
    this.dust.uniforms.uGlow.value = c.glow * 0.7;
    this.dust.uniforms.uSwirl.value = c.spin * 3.0;
  }

  dispose() {
    this._retire();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
