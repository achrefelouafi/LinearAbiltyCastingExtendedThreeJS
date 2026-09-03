import { InstancedMesh, Mesh, Object3D, Vector3, Color, Quaternion, Euler } from 'three';
import { Ability } from './Ability.js';
import { createRockMaterial } from '../materials/RockMaterial.js';
import {
  createRockGeometry,
  createSlabGeometry,
  createTowerGeometry
} from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing, randRange, randSign, lerp } from '../utils/math.js';

const MAX_ROCKS = 96;
const MAX_PLATES = 420;
/** Plates held back for the apron that breaks open around the tower. */
const APRON_PLATES = 64;
const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _side = new Vector3();
const _anchor = new Vector3();
const _scale = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _euler = new Euler();
const _quat = new Quaternion();
const _gradA = new Color();
const _gradB = new Color();

/**
 * EARTH — the power *paves* the ground, then tears it apart.
 *
 * Three beats, in order:
 *   1. a crust of stone plates is laid down along the drawn path, surfacing
 *      flush with the floor as the head passes over it;
 *   2. a fracture wave trails the head by `crackDelay` and breaks that crust —
 *      plates heave, tip over, drop into the seams and slide apart;
 *   3. the cast ends with a tower climbing out of the floor, shouldering a ring
 *      of boulders up around its base.
 *
 * All three are real geometry (instanced plates, instanced rocks, one tower
 * mesh) so they take the scene's shadows, and everything is pooled — a cast
 * allocates nothing.
 */
export class EarthAbility extends Ability {
  constructor(context) {
    super('earth', context);
  }

  createShaders() {
    const environment = this.ctx.environment;

    // A dedicated material instance per mesh: the same material used by both an
    // InstancedMesh and a plain Mesh would compile two program variants, and
    // CSM only tracks the uniforms of the last one it saw.
    this.plateMaterial = createRockMaterial(environment, 0.06);
    this.plateGeometry = createSlabGeometry(Math.random() * 100, 7);
    this.plates = new InstancedMesh(this.plateGeometry, this.plateMaterial, MAX_PLATES);
    this.plates.castShadow = true;
    this.plates.receiveShadow = true;
    this.plates.frustumCulled = false;
    this.plates.count = 0;
    this.plates.layers.set(LAYER.WORLD);
    this.group.add(this.plates);

    this.rockMaterial = createRockMaterial(environment, 0.3);
    this.rockGeometry = createRockGeometry(Math.random() * 100, 1);
    this.rocks = new InstancedMesh(this.rockGeometry, this.rockMaterial, MAX_ROCKS);
    this.rocks.castShadow = true;
    this.rocks.receiveShadow = true;
    this.rocks.frustumCulled = false;
    this.rocks.count = 0;
    // Rocks are solid world geometry: they belong in the depth prepass so that
    // dust and debris fade softly against them.
    this.rocks.layers.set(LAYER.WORLD);
    this.group.add(this.rocks);

    this.towerMaterial = createRockMaterial(environment, 0.1);
    this.towerGeometry = createTowerGeometry(Math.random() * 50);
    this.tower = new Mesh(this.towerGeometry, this.towerMaterial);
    this.tower.castShadow = true;
    this.tower.receiveShadow = true;
    this.tower.frustumCulled = false;
    this.tower.visible = false;
    this.tower.layers.set(LAYER.WORLD);
    this.group.add(this.tower);

    /**
     * Fixed-size record pools — no allocation while casting.
     *
     * A record stores only what the *dice* decided: an anchor, a direction and
     * a set of unitless jitters. Every metre, radian and second is resolved
     * against `settings.earth` in the update loops, so moving a slider reshapes
     * the crust and the boulders that are already standing — including while
     * the clock is paused, which is when the shapes are actually being tuned.
     */
    this.rockRecords = [];
    for (let i = 0; i < MAX_ROCKS; i++) {
      this.rockRecords.push({
        active: false,
        emitted: false,
        ring: false, // one of the boulders shouldered up around the tower
        base: new Vector3(),
        radial: new Vector3(1, 0, 0),
        spread: 0, // offset along `radial`, in units of the governing setting
        sizeScale: 1,
        sizeVariation: 0,
        scaleJitter: new Vector3(1, 1, 1),
        riseJitter: 1,
        spinJitter: 0,
        tiltJitter: 0,
        lifeJitter: 0,
        age: 0
      });
    }

    this.plateRecords = [];
    for (let i = 0; i < MAX_PLATES; i++) {
      this.plateRecords.push({
        active: false,
        cracked: false,
        apron: false, // part of the disc that breaks open around the tower
        base: new Vector3(),
        side: new Vector3(1, 0, 0),
        lateralNorm: 0, // offset along `side`, as a fraction of the crust width
        yaw: 0,
        sizeJitter: 1,
        thicknessJitter: 1,
        tiltJitter: 0,
        tiltHeading: 0,
        liftUp: true,
        liftJitter: 1,
        paintAge: 0,
        crackJitter: 1,
        crackOverride: Infinity // the impact's fracture wave, once it arrives
      });
    }

    this._rockCursor = 0;
    this._plateCursor = 0;
    this._towerAge = -1;
  }

  createParticles() {
    const particles = this.ctx.particles;

    this.dust = particles.get('earth.dust', {
      capacity: 2600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uGravity.value.set(0, 0.25, 0);
    this.dust.uniforms.uDrag.value = 2.1;
    this.dust.uniforms.uEndSize.value = 3.0;
    this.dust.uniforms.uFadeIn.value = 0.12;
    this.dust.uniforms.uFadeOut.value = 0.3;

    this.debris = particles.get('earth.debris', {
      capacity: 2200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.debris.uniforms.uGravity.value.set(0, -13.0, 0);
    this.debris.uniforms.uDrag.value = 0.25;
    this.debris.uniforms.uEndSize.value = 0.9;
    this.debris.uniforms.uFadeOut.value = 0.75;

    this.dustEmitter = new RateEmitter();
    this.debrisEmitter = new RateEmitter();
  }

  get trailLength() {
    return 4;
  }

  /** The tower rises, stands, and only then does anything start to withdraw. */
  get impactDuration() {
    const c = settings.earth;
    return Math.max(0.6, c.towerRiseTime + Math.max(0, c.towerHold));
  }

  get fadeDuration() {
    return 1.9; // long enough for the crust and the tower to sink out of sight
  }

  /** Earth lurches forward in surges instead of gliding. */
  speedProfile(u) {
    return 0.82 + 0.35 * Math.abs(Math.sin(u * 9.0));
  }

  onSpawn() {
    this.dustEmitter.reset();
    this.debrisEmitter.reset();
    for (const record of this.rockRecords) record.active = false;
    for (const record of this.plateRecords) record.active = false;
    this.rocks.count = 0;
    this.plates.count = 0;
    this._rockCursor = 0;
    this._plateCursor = 0;
    this._nextRockDistance = 0;
    this._nextPlateDistance = 0;
    this._towerAge = -1;
    this.tower.visible = false;
    this.tower.rotation.set(0, 0, 0);
    this._crackDistance = 0;

    // Plate spacing is chosen per cast so that even a very long path still fits
    // inside the instance budget instead of overwriting its own start.
    const c = settings.earth;
    // Plates overlap heavily on purpose: before the fracture the crust has to
    // read as one continuous slab, not as scattered tiles.
    const step = Math.max(0.1, (c.plateSize * 0.45) / Math.max(0.2, c.crustDensity));
    this._plateAcross = Math.max(2, Math.round(c.crustWidth / step));
    this._plateRowSpacing = Math.max(
      step,
      (this.curveLength * this._plateAcross) / (MAX_PLATES - APRON_PLATES)
    );
  }

  _syncUniforms() {
    const c = settings.earth;
    const g = settings.global;

    this.plateMaterial.userData.sync(0.09);
    this.rockMaterial.userData.sync(0.12);
    // The tower's faces are large and flat, so the hot-seam term spreads into
    // glowing bands on them where it reads as a thin fissure on a boulder.
    this.towerMaterial.userData.sync(0.05);

    const rock = getColor(c.colorRock);
    const dark = getColor(c.colorRockDark);

    this.dust.setGradient(
      _gradA.copy(rock).multiplyScalar(1.35),
      rock,
      dark,
      _gradB.copy(dark).multiplyScalar(0.6)
    );
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uOpacity.value = c.dustAmount * 0.55 * g.opacity;
    this.dust.uniforms.uTurbulence.value = 0.45 * g.turbulence;

    this.debris.setGradient(rock, rock, dark, dark);
    this.debris.uniforms.uSizeScale.value = c.debrisSize * g.particleSize * 7;
    this.debris.uniforms.uLifeScale.value = g.particleLifetime;
    this.debris.uniforms.uSpeedScale.value = g.particleSpeed;
    this.debris.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* The crust                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Lay one plate at `lateralNorm` across `base`, measured in fractions of the
   * band it belongs to. `paintDelay` staggers when it surfaces; how long it
   * stays whole afterwards is derived live from `crackDelay`, so the crust
   * reads as painted first and broken second.
   */
  _spawnPlate(base, side, lateralNorm, apron, paintDelay) {
    const record = this.plateRecords[this._plateCursor];
    this._plateCursor = (this._plateCursor + 1) % MAX_PLATES;

    record.active = true;
    record.cracked = false;
    record.apron = apron;
    record.base.copy(base).setY(0);
    record.side.copy(side);
    record.lateralNorm = lateralNorm;
    record.yaw = Math.random() * TAU;
    record.sizeJitter = randRange(0.85, 1.35);
    record.thicknessJitter = randRange(0.7, 1.4);
    record.paintAge = this.age + paintDelay;
    record.crackJitter = randRange(0.85, 1.35);
    record.crackOverride = Infinity;

    record.tiltJitter = randRange(0.2, 1);
    record.tiltHeading = Math.random() * TAU;

    // Roughly half the plates ride up over the fracture and the rest drop into
    // it — a field that only ever rises reads as inflating, not breaking.
    record.liftUp = Math.random() < 0.55;
    record.liftJitter = record.liftUp ? randRange(0.25, 1) : randRange(0.3, 1.1);
  }

  /** Radius of the apron disc, in metres. */
  _apronRadius(c) {
    return Math.max(0.6, c.towerRockRadius * 1.7);
  }

  /** Where a plate currently sits, at the live crust/apron width. */
  _platePosition(record, c, out) {
    const width = record.apron ? this._apronRadius(c) : c.crustWidth;
    return out.copy(record.base).addScaledVector(record.side, record.lateralNorm * width);
  }

  /** Plates thin out toward the edge of the band so the crust frays. */
  _plateSizeScale(record) {
    if (record.apron) return lerp(1, 0.6, saturate(Math.abs(record.lateralNorm)));
    return lerp(1, 0.55, saturate(Math.abs(record.lateralNorm) * 2));
  }

  /** Absolute age at which this plate lets go. */
  _plateCrackTime(record, c) {
    let delay;
    if (record.apron) {
      // The apron breaks outward from the tower, not on the crust's schedule.
      const distance = Math.abs(record.lateralNorm) * this._apronRadius(c);
      delay = Math.min(c.crackDelay, 0.1) + distance * 0.05;
    } else {
      delay = c.crackDelay * record.crackJitter;
    }
    return Math.min(record.crackOverride, record.paintAge + Math.max(0.02, delay));
  }

  /** One row of plates across the path, with a ragged, thinning edge. */
  _paveRow(centre, side) {
    const c = settings.earth;
    const across = this._plateAcross;
    // The row's own jitter is stored as a fraction too, so widening the crust
    // later spreads the whole row instead of only its ideal positions.
    const jitterNorm = this._plateRowSpacing / Math.max(0.05, c.crustWidth);

    for (let i = 0; i < across; i++) {
      const lateralNorm = (i + 0.5) / across - 0.5 + randRange(-0.3, 0.3) * jitterNorm;
      const edge = saturate(Math.abs(lateralNorm) * 2);
      // Thin the outer band out so the crust frays into the floor.
      if (Math.random() < edge * edge * 0.45) continue;

      // Not `_pos`: the caller hands its own scratch in as `centre`, and
      // writing through it would drift the row a little further each plate.
      _anchor.copy(centre).addScaledVector(this.tangent, randRange(-0.45, 0.45) * this._plateRowSpacing);
      this._spawnPlate(_anchor, side, lateralNorm, false, randRange(0, 0.06));
    }
  }

  /** A disc of crust that breaks open where the tower is about to surface. */
  _paveDisc(centre, count) {
    const radius = this._apronRadius(settings.earth);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU;
      const distanceNorm = Math.sqrt(Math.random());
      _side.set(Math.cos(angle), 0, Math.sin(angle));
      this._spawnPlate(centre, _side, distanceNorm, true, distanceNorm * radius * 0.02);
    }
  }

  /** Dust, chips and the odd crack decal at the moment a plate lets go. */
  _fractureFx(record, radius, tilt) {
    const c = settings.earth;
    const g = settings.global;
    const time = frame.uTime.value;

    _emit.position = this._platePosition(record, c, _pos).setY(0.08);
    _emit.radius = radius * 0.45;
    _emit.direction = _dir
      .set(Math.cos(record.tiltHeading) * tilt, 1.6, Math.sin(record.tiltHeading) * tilt)
      .normalize();
    _emit.speed = c.debrisVelocity * 0.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.debrisLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 7;
    _emit.tint = null;
    _emit.time = time;
    this.debris.emit(Math.round(2 * g.particleCount), _emit);

    // Only some of the plates puff: every one of a few hundred smoking at once
    // buries the crust in haze and hides the fracture that is the whole point.
    if (Math.random() < 0.35) {
      _emit.speed = 0.5;
      _emit.spread = 1.0;
      _emit.size = 0.4;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime * 0.6;
      _emit.spin = 0.6;
      this.dust.emit(Math.round(2 * c.dustAmount * g.particleCount), _emit);
    }
  }

  /**
   * @param {number} retract 0..1 — the whole crust withdrawing into the floor.
   */
  _updatePlates(retract) {
    const c = settings.earth;
    const g = settings.global;
    const now = this.age;
    const paintTime = Math.max(0.03, c.paintTime);
    const snapTime = Math.max(0.05, c.crackSharpness);

    for (let i = 0; i < MAX_PLATES; i++) {
      const record = this.plateRecords[i];
      const paint = record.active ? saturate((now - record.paintAge) / paintTime) : 0;

      if (paint <= 0) {
        _dummy.position.set(0, -999, 0);
        _dummy.scale.setScalar(0.0001);
        _dummy.quaternion.identity();
        _dummy.updateMatrix();
        this.plates.setMatrixAt(i, _dummy.matrix);
        continue;
      }

      /* Every dimension is resolved here, from the live settings — never read
         back from a value captured when the plate was laid. */
      const radius = Math.max(0.05, c.plateSize * this._plateSizeScale(record) * record.sizeJitter);
      const thickness = Math.max(0.02, c.plateThickness * record.thicknessJitter);
      const tilt = c.plateTilt * record.tiltJitter * g.randomness;
      const throwHeight = record.liftUp
        ? c.plateLift * record.liftJitter
        : -c.plateLift * c.crackDepth * record.liftJitter;

      let bite = 0;
      let lift = 0;
      const crackAt = this._plateCrackTime(record, c);
      if (now >= crackAt) {
        if (!record.cracked) {
          record.cracked = true;
          this._fractureFx(record, radius, tilt);
        }
        const since = now - crackAt;
        const snap = Easing.outBack(saturate(since / snapTime));
        const settle = Easing.inOutCubic(saturate((since - snapTime) / 1.1));
        bite = snap;
        lift = throwHeight * (snap - settle * 0.45);
      } else {
        // Lengthening `crackDelay` puts a plate back before its own fracture:
        // let it be whole again, and break a second time when time catches up.
        record.cracked = false;
      }

      const emerge = Easing.outQuint(paint);
      const sink = retract > 0 ? Easing.inCubic(retract) : 0;
      const grow = lerp(0.86, 1, emerge);

      // A tilted plate levers up on its low edge instead of hovering: raising
      // it by the sag of that edge keeps the slab in contact with the floor.
      const pivot = Math.sin(Math.abs(tilt * bite)) * radius * 0.5 * (record.liftUp ? 1 : 0.5);

      _euler.set(
        Math.cos(record.tiltHeading) * tilt * bite,
        record.yaw,
        Math.sin(record.tiltHeading) * tilt * bite,
        'YXZ'
      );
      _quat.setFromEuler(_euler);

      this._platePosition(record, c, _dummy.position);
      _dummy.position.addScaledVector(
        record.side,
        (record.lateralNorm >= 0 ? 1 : -1) * bite * c.plateSpread
      );
      _dummy.position.y =
        lift +
        pivot -
        (1 - emerge) * thickness * 1.6 -
        sink * (thickness * 1.8 + Math.max(0, lift) + 0.3);
      _dummy.quaternion.copy(_quat);
      _dummy.scale.set(radius * grow, thickness, radius * grow);
      _dummy.updateMatrix();
      this.plates.setMatrixAt(i, _dummy.matrix);

      if (retract >= 1) record.active = false;
    }

    this.plates.count = MAX_PLATES;
    this.plates.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */
  /* Heaved boulders                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Vector3} base    anchor on the floor
   * @param {Vector3} radial  unit direction the boulder is offset along
   * @param {number} spread   that offset, in units of the setting governing it
   *                          (`crustWidth` along the path, `towerRockRadius`
   *                          for the ring around the tower)
   */
  _spawnRock(base, radial, spread, ring, sizeScale = 1, delay = 0) {
    const record = this.rockRecords[this._rockCursor];
    this._rockCursor = (this._rockCursor + 1) % MAX_ROCKS;

    record.active = true;
    record.emitted = false;
    record.ring = ring;
    record.age = -delay;
    record.base.copy(base).setY(0);
    record.radial.copy(radial);
    record.spread = spread;
    record.sizeScale = sizeScale;
    record.sizeVariation = randRange(-0.45, 0.65);
    record.scaleJitter.set(randRange(0.85, 1.25), randRange(0.8, 1.3), randRange(0.85, 1.25));
    record.riseJitter = 0.6 + Math.random() * 0.8;
    record.spinJitter = randRange(-1, 1);
    record.tiltJitter = randRange(-0.5, 0.5);
    record.lifeJitter = randRange(0, 0.5);
  }

  /** Where a boulder currently stands, at the live spacing settings. */
  _rockPosition(record, c, g, out) {
    const offset = record.ring
      ? record.spread * c.towerRockRadius
      : record.spread * c.crustWidth * g.randomness;
    return out.copy(record.base).addScaledVector(record.radial, offset);
  }

  _rockScale(record, c, g, out) {
    const randomness = c.rockRandomness * g.randomness;
    const size = Math.max(0.01, c.rockSize * record.sizeScale * (1 + record.sizeVariation * randomness));
    return out.copy(record.scaleJitter).multiplyScalar(size);
  }

  /** Seconds a boulder stands before it sinks back. */
  _rockLife(record, c, g) {
    // The tower's ring has to stay up exactly as long as the tower does.
    if (record.ring) return Math.max(0.05, c.towerRiseTime + Math.max(0, c.towerHold));
    return c.lifetime * 0.8 + c.sinkDelay + record.lifeJitter * c.rockRandomness * g.randomness;
  }

  /** Eruption feedback for a rock that has just broken the surface. */
  _rockBreachFx(position, size) {
    const c = settings.earth;

    _emit.position = _pos.copy(position).setY(0.1);
    _emit.radius = size * 0.6;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.debrisVelocity;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.7;
    _emit.life = c.debrisLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 6;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.debris.emit(Math.round(6 * settings.global.particleCount), _emit);

    this.ctx.decals.spawn(DecalType.DUSTRING, position, {
      radius: size * 1.6,
      life: 1.1,
      intensity: c.dustAmount * 0.7,
      colorA: getColor(c.colorRock),
      colorB: getColor(c.colorRockDark)
    });
  }

  _updateRocks(dt, retract) {
    const c = settings.earth;
    const g = settings.global;

    for (let i = 0; i < MAX_ROCKS; i++) {
      const record = this.rockRecords[i];

      if (record.active) {
        record.age += dt;
        if (record.age >= 0 && !record.emitted) {
          record.emitted = true;
          this._rockBreachFx(
            this._rockPosition(record, c, g, _anchor),
            this._rockScale(record, c, g, _scale).x
          );
        }
      }

      if (!record.active || record.age < 0) {
        _dummy.position.set(0, -999, 0);
        _dummy.scale.setScalar(0.0001);
        _dummy.quaternion.identity();
        _dummy.updateMatrix();
        this.rocks.setMatrixAt(i, _dummy.matrix);
        continue;
      }

      const t = record.age;
      const life = this._rockLife(record, c, g);
      const rise = c.riseHeight * record.riseJitter * (0.5 + c.groundDisplacement);
      this._rockScale(record, c, g, _scale);

      // Rise with an overshoot, hold, then sink back into the ground.
      const riseDuration = Math.max(0.08, 1 / Math.max(0.5, c.riseSpeed));
      let height;
      if (t < riseDuration) {
        height = Easing.outBack(t / riseDuration) * rise;
      } else if (t < life) {
        const hold = (t - riseDuration) / Math.max(0.001, life - riseDuration);
        height = rise * (1 - Easing.inCubic(hold) * 0.12);
      } else {
        const sink = saturate((t - life) / 0.8);
        height = rise * (1 - Easing.inOutCubic(sink)) - sink * _scale.y;
      }

      // The end of the cast pulls anything still standing back under.
      if (retract > 0) height -= Easing.inCubic(retract) * (rise + _scale.y * 1.5);

      if (t > life + 0.85 || retract >= 1) {
        record.active = false;
        continue;
      }

      const tilt = record.tiltJitter * c.rockRandomness * g.randomness;
      _euler.set(tilt, record.spinJitter * c.tumble * t, tilt * 0.6);
      _quat.setFromEuler(_euler);

      this._rockPosition(record, c, g, _dummy.position);
      _dummy.position.y = height - _scale.y * 0.25;
      _dummy.quaternion.copy(_quat);
      _dummy.scale.copy(_scale);
      _dummy.updateMatrix();
      this.rocks.setMatrixAt(i, _dummy.matrix);
    }

    this.rocks.count = MAX_ROCKS;
    this.rocks.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._syncUniforms();

    const c = settings.earth;

    /* --- pave the crust behind the head ------------------------------ */
    while (this.distance >= this._nextPlateDistance && this.u < 1) {
      const u = saturate(this._nextPlateDistance / this.curveLength);
      this.curve.getPointAt(u, _pos);
      this.curve.getTangentAt(u, _dir);
      _side.crossVectors(_dir, _up).normalize();
      this._paveRow(_pos, _side);
      this._nextPlateDistance += this._plateRowSpacing;
    }

    /* --- boulders heaved up through it ------------------------------- */
    const spacing = Math.max(0.25, c.rockSpacing / Math.max(0.05, c.rockCount));
    while (this.distance >= this._nextRockDistance && this.u < 1) {
      const u = saturate(this._nextRockDistance / this.curveLength);
      this.curve.getPointAt(u, _pos);
      this.curve.getTangentAt(u, _dir);
      _side.crossVectors(_dir, _up).normalize();

      // Boulders follow the fracture wave, not the head: the ground has to be
      // broken before anything can come through it.
      this._spawnRock(_pos, _side, randRange(-1, 1) * 0.35, false, 1, c.crackDelay * 0.9);

      this._nextRockDistance += spacing;
    }

    /* --- fissures fanning out beyond the crust ----------------------- */
    if (this.distance - this._crackDistance > 2.4) {
      this._crackDistance = this.distance;
      _side.crossVectors(this.tangent, _up).normalize();
      _pos.copy(this.position).addScaledVector(_side, randRange(0.6, 1.1) * c.crustWidth * randSign());
      this.ctx.decals.spawn(DecalType.CRACK, _pos, {
        radius: 1.1 + c.crackWidth,
        life: 6,
        width: c.crackWidth,
        intensity: 0.45,
        // A dark second colour keeps these reading as fissures: the decal's
        // glow term turns a bright one into a starburst on the floor.
        colorA: getColor(c.colorRockDark),
        colorB: getColor(c.colorRockDark)
      });
    }

    this._updatePlates(0);
    this._updateRocks(dt, 0);
    this._emitDust(dt);

    // Continuous low rumble while the wave travels.
    this.ctx.shake.rumble(0.05 * c.shakeIntensity, dt);
  }

  _emitDust(dt) {
    const c = settings.earth;
    const g = settings.global;
    const time = frame.uTime.value;

    const dustCount = Math.round(this.dustEmitter.tick(dt, 18 * c.dustAmount) * g.particleCount);
    if (dustCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.12);
      _emit.radius = c.crustWidth * 0.4;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 1.1;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.7;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const pebbleCount = Math.round(this.debrisEmitter.tick(dt, c.pebbleRate) * g.particleCount);
    if (pebbleCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.15);
      _emit.radius = 0.4;
      _emit.direction = _dir.copy(this.tangent).multiplyScalar(0.4).setY(1);
      _emit.speed = c.debrisVelocity * 0.55;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.8;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.debrisLifetime * 0.8;
      _emit.spin = 8;
      _emit.time = time;
      this.debris.emit(pebbleCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = settings.earth;
    const g = settings.global;
    const time = frame.uTime.value;

    /* the tower starts fully buried and climbs out in onFade */
    this._towerAge = 0;
    this.tower.visible = true;
    this.tower.position.copy(this.position);
    this.tower.position.y = -c.towerHeight;
    this.tower.rotation.set(0, Math.random() * TAU, 0);
    this.tower.scale.set(c.towerWidth, c.towerHeight, c.towerWidth);

    /* an apron of crust for it to break through */
    this._paveDisc(this.position, APRON_PLATES);

    /* the fracture wave races outward from the impact and catches up with
       every plate that is still whole */
    for (const record of this.plateRecords) {
      if (!record.active || record.cracked) continue;
      const distance = this._platePosition(record, c, _pos).distanceTo(this.position);
      record.crackOverride = Math.min(record.crackOverride, this.age + 0.05 + distance * 0.035);
    }

    /* boulders shouldered up around the base */
    const rockCount = Math.min(MAX_ROCKS - 8, Math.round(c.towerRocks));
    for (let i = 0; i < rockCount; i++) {
      const angle = (i / rockCount) * TAU + randRange(-0.35, 0.35);
      _side.set(Math.cos(angle), 0, Math.sin(angle));
      this._spawnRock(
        this.position,
        _side,
        randRange(0.55, 1.6),
        true,
        randRange(0.35, 0.95),
        randRange(0, 0.3)
      );
    }

    /* dust dome + ground marks */
    _pos.copy(this.position).setY(0.4);
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.towerWidth * 0.5,
      endRadius: c.towerWidth * 3.2 * g.explosionIntensity,
      life: 1.2,
      intensity: 0.55,
      opacity: 0.75 * c.dustAmount,
      displace: 0.5,
      squash: 0.5,
      colorA: getColor(c.colorRock),
      colorB: getColor(c.colorRockDark),
      colorC: getColor(c.colorRockDark)
    });

    // Fissures ring the tower rather than sitting under it — the apron of
    // broken plates already covers the ground it came through.
    for (let i = 0; i < 5; i++) {
      const angle = Math.random() * TAU;
      const radius = randRange(2.2, 4.0) * Math.max(c.towerWidth, c.towerRockRadius * 0.9);
      _pos.set(
        this.position.x + Math.cos(angle) * radius,
        0,
        this.position.z + Math.sin(angle) * radius
      );
      this.ctx.decals.spawn(DecalType.CRACK, _pos, {
        radius: randRange(1.2, 2.6),
        life: 8,
        width: c.crackWidth,
        intensity: 0.55,
        colorA: getColor(c.colorRockDark),
        colorB: getColor(c.colorRockDark)
      });
    }

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.position, {
      radius: c.towerWidth * 3.5 * g.explosionIntensity,
      life: 0.8,
      width: 0.07,
      intensity: 0.8,
      colorA: getColor(c.colorRock),
      colorB: getColor(c.lightColor)
    });

    /* debris + dust burst */
    _pos.copy(this.position).setY(0.3);
    _emit.position = _pos;
    _emit.radius = c.towerWidth * 0.7;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.debrisVelocity * 2.1;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.debrisLifetime * 1.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = time;
    this.debris.emit(Math.round(190 * g.particleCount), _emit);

    _emit.speed = 3.0;
    _emit.spread = 1.0;
    _emit.size = 1.7;
    _emit.life = c.dustLifetime * 1.6;
    _emit.spin = 0.8;
    this.dust.emit(Math.round(120 * g.particleCount), _emit);

    /* the ground shake this element is known for */
    this.ctx.shake.add(0.55 * c.shakeIntensity * g.explosionIntensity, 1 / Math.max(0.1, c.shakeDuration), 17);
    this.ctx.flash.trigger(getColor(c.colorRock), c.explosionFlash * g.explosionIntensity * 0.3);
    this.lightBoost = c.lightIntensity * 1.5 * g.explosionIntensity;
  }

  /** Grinding dust and chips thrown out where the shaft leaves the floor. */
  _towerBaseFx(dt) {
    const c = settings.earth;
    const g = settings.global;
    const time = frame.uTime.value;

    const count = Math.round(this.dustEmitter.tick(dt, 70 * c.dustAmount) * g.particleCount);
    if (count <= 0) return;

    _emit.position = _pos.copy(this.position).setY(0.25);
    _emit.radius = c.towerWidth * 0.9;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 1.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 1.2;
    _emit.sizeVariance = 0.6;
    _emit.life = c.dustLifetime * 1.1;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.6;
    _emit.tint = null;
    _emit.time = time;
    this.dust.emit(count, _emit);

    _emit.speed = c.debrisVelocity * 0.7;
    _emit.size = 0.12;
    _emit.life = c.debrisLifetime * 0.8;
    _emit.spin = 8;
    this.debris.emit(Math.round(count * 0.4), _emit);
  }

  onFade(dt) {
    const c = settings.earth;
    this._syncUniforms();

    let retract = 0;

    if (this._towerAge >= 0) {
      this._towerAge += dt;
      const p = this._towerAge;
      const rise = Math.max(0.05, c.towerRiseTime);
      const standing = rise + Math.max(0, c.towerHold);
      const climb = saturate(p / rise);
      retract = saturate((p - standing) / 1.5);

      const height = c.towerHeight;
      const emerge = Easing.outQuint(climb);
      this.tower.scale.set(c.towerWidth, height, c.towerWidth);
      this.tower.position.y = -height * (1 - emerge) - Easing.inCubic(retract) * height * 1.2;

      // A short lean that damps out once it stops moving, so the tower lands
      // with weight instead of freezing mid-air.
      const after = Math.max(0, p - rise);
      this.tower.rotation.z = climb < 1 ? 0 : Math.sin(after * 21) * 0.022 * Math.exp(-after * 4.5);

      this.tower.visible = retract < 1;

      if (climb < 1) {
        this._towerBaseFx(dt);
        this.ctx.shake.rumble(0.18 * c.shakeIntensity, dt);
      } else if (p < c.shakeDuration + rise) {
        this.ctx.shake.rumble(0.08 * c.shakeIntensity, dt);
      }
    }

    this._updatePlates(retract);
    this._updateRocks(dt, retract);
  }

  onDestroy() {
    this.tower.visible = false;
    this._towerAge = -1;
    for (const record of this.rockRecords) record.active = false;
    for (const record of this.plateRecords) record.active = false;
    this.rocks.count = 0;
    this.plates.count = 0;
  }

  dispose() {
    this.rockGeometry.dispose();
    this.plateGeometry.dispose();
    this.towerGeometry.dispose();
    this.rockMaterial.dispose();
    this.plateMaterial.dispose();
    this.towerMaterial.dispose();
    this.rocks.dispose();
    this.plates.dispose();
    super.dispose();
  }
}
