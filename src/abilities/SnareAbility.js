import { Mesh, PlaneGeometry, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createSnareCageMaterial, createSnareFieldMaterial, SnarePass } from '../materials/SnareMaterial.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing, randRange } from '../utils/math.js';

/**
 * Hard ceilings per role. The editor's sliders clamp here, and their sum is the
 * instance count the strip is built with — one buffer, allocated once.
 */
const MAX_LEASH = 6;
const MAX_COLUMN = 16;
const MAX_TENDRIL = 20;
const MAX_RIM = 14;
const MAX_FILAMENTS = MAX_LEASH + MAX_COLUMN + MAX_TENDRIL + MAX_RIM;

/**
 * Samples along one filament. The ceiling on how fine a kink can be: anything
 * higher-frequency than one kink per two nodes just aliases.
 */
const NODES = 64;

/** How many points one frame's sparks are split between. A single origin reads as a starburst. */
const SPARK_BATCHES = 5;
/** ... and the same for the updraft, which would otherwise be a rotating hose. */
const UPDRAFT_BATCHES = 4;

const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();

/**
 * SNARE — the first **far cast**: a trap planted at a point.
 *
 * The other four abilities are shots fired along a line. This one is aimed with
 * a circle (see `effects/ZoneIndicator.js`), and the deal that circle strikes
 * with the player is the whole design of the ability: the thick boundary it
 * draws before the click is where the tendrils stop, where the rim arcs run and
 * where the field burns after it. One number, `zoneRadius`, drives the
 * indicator and every part of the effect, so dragging it re-scales the promise
 * and the payoff together — including on a trap that is already standing.
 *
 * Four beats, though only three phases:
 *
 *   1. **travel** — a leash of current is whipped out across the floor toward
 *      the point, laying burns as it goes.
 *   2. **snap** — the first `snapTime` of the impact phase: the leash is
 *      dropped, the ring slams open past its radius and pulls back onto it, and
 *      the column tears up out of the middle.
 *   3. **hold** — the rest of `lifetime`: the cage re-strikes, tendrils crawl,
 *      rim arcs travel, and the air over the whole disc is hauled up into the
 *      pillar.
 *   4. **collapse** — `fadeTime`: the pillar thins to a thread and goes out.
 *
 * Everything is generated. The cage is one instanced ribbon strip whose four
 * roles are decided in the vertex shader (`materials/SnareMaterial.js`), the
 * field is one quad of signed distance and warped noise, the burns are the
 * shared decals, and the sparks, updraft, smoke and chips are GPU particles.
 *
 * **The rule that makes the editor work.** A cast captures one number — a seed
 * — and a handful of timestamps. Not one metre, radian or second is recorded:
 * the footprint, the column, the tendrils, the rim arcs and the field are all
 * resolved against `settings.snare` inside the update loop, which runs on a
 * zero-length frame too.
 */
export class SnareAbility extends Ability {
  constructor(context) {
    super('snare', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.geometry = createBoltRibbonGeometry(NODES, MAX_FILAMENTS);

    // Two passes over the same filaments: a wide, soft halo underneath and the
    // hot cores on top. Drawing the glow as real ribbon rather than leaving it
    // to bloom is what keeps it attached to every kink.
    this.glowMaterial = createSnareCageMaterial(SnarePass.GLOW);
    this.coreMaterial = createSnareCageMaterial(SnarePass.CORE);
    this.cageMaterials = [this.glowMaterial, this.coreMaterial];

    this.meshes = [];
    for (const [index, material] of this.cageMaterials.entries()) {
      const mesh = new Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 11 + index * 2;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }

    /* ---- the field on the floor ---- */
    this.fieldGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.fieldMaterial = createSnareFieldMaterial();
    this.field = new Mesh(this.fieldGeometry, this.fieldMaterial);
    this.field.name = 'SnareField';
    this.field.layers.set(LAYER.VFX);
    this.field.renderOrder = 7; // over the decals, under the cage
    this.field.frustumCulled = false;
    this.group.add(this.field);

    /** Re-rolled per cast so no two traps draw the same shape. */
    this._seed = 0;
    /** Seconds since the ring started opening. Drives the snap, nothing else. */
    this._openTime = 0;
    /** Metres of leash travel already paid out in ground burns. */
    this._burnDistance = 0;
    this._filamentCount = 1;

    // Scratch state handed to the materials each frame. One object, reused —
    // syncing the trap allocates nothing.
    this._state = {
      centre: new Vector3(),
      hand: new Vector3(),
      front: new Vector3(),
      radius: 1,
      height: 1,
      fade: 1,
      seed: 0,
      counts: { leash: 0, column: 0, tendril: 0, rim: 0 }
    };
    this._fieldState = { radius: 1, quadSize: 1, fade: 1, seed: 0 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Sparks: velocity-stretched streaks under gravity, thrown off the cage.
    this.sparks = particles.get('snare.sparks', {
      capacity: 4000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.4;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    // The updraft — this ability's signature system. Motes picked up off the
    // whole disc and hauled inward and up the column, which is the read that
    // says the trap is pulling on the air rather than sitting in it.
    this.updraft = particles.get('snare.updraft', {
      capacity: 3000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.updraft.uniforms.uDrag.value = 0.9;
    this.updraft.uniforms.uEndSize.value = 0.2;
    this.updraft.uniforms.uSizeIn.value = 0.05;
    this.updraft.uniforms.uFadeIn.value = 0.1;
    this.updraft.uniforms.uFadeOut.value = 0.45;

    // Haze scoured off the burnt floor. Non-additive so it genuinely occludes.
    this.smoke = particles.get('snare.smoke', {
      capacity: 2000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.8;
    this.smoke.uniforms.uEndSize.value = 3.0;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.16;
    this.smoke.uniforms.uFadeOut.value = 0.3;

    // Chips torn off the floor inside the ring.
    this.debris = particles.get('snare.debris', {
      capacity: 1600,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.debris.uniforms.uDrag.value = 0.25;
    this.debris.uniforms.uEndSize.value = 0.8;
    this.debris.uniforms.uFadeOut.value = 0.7;

    this.sparkEmitter = new RateEmitter();
    this.updraftEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.debrisEmitter = new RateEmitter();
    this.arcEmitter = new RateEmitter();
    this.pulseEmitter = new RateEmitter();
    this.ringEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._filamentCount * this.meshes.length;
  }

  /** The trap snaps open, then stands. */
  get impactDuration() {
    return Math.max(0.05, settings.snare.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.snare.fadeTime);
  }

  /** A cage gutters where ice glints — a hard, quantised stutter. */
  lightShimmer() {
    const c = settings.snare;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
    return 1 - saturate(c.lightFlicker) * noise;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** Where the leash leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.snare;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The centre of the trap — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** The leash's travelling tip. Pinned to the centre once it has arrived. */
  _frontPoint(out) {
    const c = settings.snare;
    const u = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(u, out).setY(c.leashCling);
  }

  /**
   * How far open the ring is, 0..1, and how far up the column has climbed.
   *
   * Both are pure functions of `_openTime` against the live `snapTime`, so the
   * snap re-times itself if the slider moves mid-cast. The ring overshoots its
   * radius and pulls back onto it — the same curve the indicator snaps out on,
   * which is what makes the trap look like the circle *becoming* real rather
   * than a second, unrelated animation.
   */
  _openAmount() {
    const snap = Math.max(0.01, settings.snare.snapTime);
    const t = saturate(this._openTime / snap);
    const bump = Math.sin(Math.PI * Math.pow(t, 1.7));
    return Easing.outCubic(t) * (1 + 0.16 * bump);
  }

  _climbAmount() {
    // The pillar is slower off the mark than the ring: the ground goes first,
    // then the air breaks down over it.
    const snap = Math.max(0.01, settings.snare.snapTime) * 1.7;
    return Easing.outCubic(saturate(this._openTime / snap));
  }

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.snare.zoneRadius);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sparkEmitter.reset();
    this.updraftEmitter.reset();
    this.smokeEmitter.reset();
    this.debrisEmitter.reset();
    this.arcEmitter.reset();
    this.pulseEmitter.reset();
    this.ringEmitter.reset();

    this._burnDistance = 0;
    this._openTime = 0;
    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;
    this.field.rotation.y = Math.random() * TAU;

    this._sync(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into both cage passes,
   * the field and the four particle systems.
   *
   * @param {number} fade 1 while the trap is lit, ramping to 0 as it collapses
   */
  _sync(fade) {
    const c = settings.snare;
    const g = settings.global;
    const state = this._state;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(state.centre);
    this._handPoint(state.hand);
    this._frontPoint(state.front);

    const open = travelling ? 0 : this._openAmount();
    state.radius = Math.max(0.05, this.radius * open);
    state.height = Math.max(0.05, c.height * (travelling ? 0 : this._climbAmount()));
    state.fade = fade;
    state.seed = this._seed;

    // Roles are retired by setting their count to zero, which is how the whip
    // disappears the instant the ring takes over.
    const counts = state.counts;
    counts.leash = travelling ? clampCount(c.leashStrands, MAX_LEASH) : 0;
    counts.column = travelling ? 0 : clampCount(c.strands, MAX_COLUMN);
    counts.tendril = travelling ? 0 : clampCount(c.tendrils, MAX_TENDRIL);
    counts.rim = travelling ? 0 : clampCount(c.rimArcs, MAX_RIM);

    this._filamentCount = counts.leash + counts.column + counts.tendril + counts.rim;
    this.geometry.instanceCount = Math.max(1, this._filamentCount);

    for (const material of this.cageMaterials) material.userData.sync(state);

    /* --- the field --- */
    const fieldState = this._fieldState;
    fieldState.radius = state.radius;
    fieldState.quadSize = (this.radius + c.fieldBoundary + 0.6) * 2;
    fieldState.fade = travelling ? 0 : fade;
    fieldState.seed = this._seed;
    this.fieldMaterial.userData.sync(fieldState);

    this.field.visible = !travelling;
    this.field.position.set(state.centre.x, c.fieldHeight, state.centre.z);
    this.field.scale.set(fieldState.quadSize, 1, fieldState.quadSize);

    /* --- the particle systems, all four of them --- */
    this.sparks.setGradient(
      getColor(c.colorSparkA),
      getColor(c.colorSparkB),
      getColor(c.colorSparkC),
      getColor(c.colorSparkD)
    );
    this.sparks.uniforms.uGravity.value.set(0, c.sparkGravity, 0);
    this.sparks.uniforms.uSizeScale.value = c.sparkSize * g.particleSize * 7;
    this.sparks.uniforms.uLifeScale.value = c.sparkLifetime * 0.5 * g.particleLifetime;
    this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.sparks.uniforms.uOpacity.value = g.opacity;
    this.sparks.uniforms.uGlow.value = c.glow * 0.6 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

    this.updraft.setGradient(
      getColor(c.colorUpdraftA),
      getColor(c.colorUpdraftB),
      getColor(c.colorUpdraftC),
      getColor(c.colorUpdraftD)
    );
    // Positive gravity: the column is lifting them, not dropping them.
    this.updraft.uniforms.uGravity.value.set(0, c.updraftRise, 0);
    this.updraft.uniforms.uSizeScale.value = c.updraftSize * g.particleSize * 7;
    this.updraft.uniforms.uLifeScale.value = c.updraftLifetime * 0.5 * g.particleLifetime;
    this.updraft.uniforms.uSpeedScale.value = g.particleSpeed;
    this.updraft.uniforms.uOpacity.value = g.opacity;
    this.updraft.uniforms.uGlow.value = 1.1 * g.glow;
    this.updraft.uniforms.uTurbulence.value = c.updraftTurbulence * g.turbulence;

    this.smoke.setGradient(
      getColor(c.colorSmokeA),
      getColor(c.colorSmokeB),
      getColor(c.colorSmokeC),
      getColor(c.colorSmokeD)
    );
    this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
    this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize;
    this.smoke.uniforms.uLifeScale.value = c.smokeLifetime * 0.5 * g.particleLifetime;
    this.smoke.uniforms.uSpeedScale.value = c.smokeSpeed * g.particleSpeed;
    this.smoke.uniforms.uOpacity.value = c.smokeOpacity * g.opacity;
    this.smoke.uniforms.uTurbulence.value = 0.35 * g.turbulence;

    this.debris.setGradient(
      getColor(c.colorDebrisA),
      getColor(c.colorDebrisB),
      getColor(c.colorDebrisC),
      getColor(c.colorDebrisD)
    );
    this.debris.uniforms.uGravity.value.set(0, c.debrisGravity, 0);
    this.debris.uniforms.uSizeScale.value = c.debrisSize * g.particleSize * 7;
    this.debris.uniforms.uLifeScale.value = g.particleLifetime;
    this.debris.uniforms.uSpeedScale.value = g.particleSpeed;
    this.debris.uniforms.uOpacity.value = g.opacity;
  }

  /** The flash at the caster's hand as the leash leaves it. */
  _muzzleFx() {
    const c = settings.snare;
    const g = settings.global;

    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.muzzleSize * 0.2,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.3,
      intensity: c.muzzleIntensity,
      opacity: 0.9,
      fresnel: 1.5,
      displace: 0.5,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.sparkSpeed * 1.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(34 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
  }

  /** Sparks off the leash and burns under it, while it races to the point. */
  _leashFx(dt) {
    const c = settings.snare;
    const g = settings.global;
    const time = frame.uTime.value;

    const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * 0.5) * g.particleCount);
    if (sparkCount > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.6).normalize();
      _emit.speed = c.sparkSpeed * 0.8;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime * 0.8;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      let remaining = sparkCount;
      const per = Math.ceil(sparkCount / Math.min(sparkCount, SPARK_BATCHES));
      while (remaining > 0) {
        this.pointAt(randRange(0.1, 1) * this.u, _pos).setY(c.leashCling + 0.05);
        _emit.position = _pos;
        _emit.radius = 0.22;
        this.sparks.emit(Math.min(per, remaining), _emit);
        remaining -= per;
      }
    }

    // Burns paid out per metre of travel, jittered off the line so they do not
    // read as a dotted trail.
    const step = 1 / Math.max(0.05, c.trailRate);
    while (this.front - this._burnDistance >= step) {
      this._burnDistance += step;
      const s = saturate(this._burnDistance / this.length);
      this.pointAt(s, _pos);
      _pos.x += this.side.x * randRange(-0.4, 0.4);
      _pos.z += this.side.z * randRange(-0.4, 0.4);

      this.ctx.decals.spawn(DecalType.ARC, _pos, {
        radius: c.arcRadius * randRange(0.5, 0.85),
        life: c.arcLife * 0.7,
        width: c.arcBranches,
        intensity: c.arcIntensity * 0.8,
        colorA: getColor(c.colorEmber),
        colorB: getColor(c.colorArc)
      });
    }
  }

  /**
   * Everything the standing trap sheds: sparks off the cage, the updraft, haze,
   * chips, burns around the rim, pressure shells and dust rings.
   *
   * @param {number} scale 0..1 — thinned out as the trap collapses
   */
  _fieldFx(dt, scale) {
    const c = settings.snare;
    const g = settings.global;
    const time = frame.uTime.value;
    const centre = this._state.centre;
    const radius = this._state.radius;
    const height = this._state.height;

    /* --- sparks, thrown off the column and off the rim --- */
    let sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (sparkCount > 0) {
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.16;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const per = Math.ceil(sparkCount / Math.min(sparkCount, SPARK_BATCHES));
      while (sparkCount > 0) {
        // Two thirds up the pillar, one third off the boundary — the column is
        // the loud part, but a rim with no sparks reads as painted on.
        if (Math.random() < 0.66) {
          _pos.copy(centre).setY(randRange(0.1, 1) * height);
          _emit.radius = radius * c.columnSpread * 1.4 + 0.1;
          _emit.direction = _dir.set(0, 1, 0);
        } else {
          const a = Math.random() * TAU;
          _pos.set(centre.x + Math.cos(a) * radius, 0.08, centre.z + Math.sin(a) * radius);
          _emit.radius = 0.25;
          _emit.direction = _dir.set(Math.cos(a) * 0.4, 1, Math.sin(a) * 0.4).normalize();
        }
        _emit.position = _pos;
        this.sparks.emit(Math.min(per, sparkCount), _emit);
        sparkCount -= per;
      }
    }

    /* --- the updraft: picked up off the disc, hauled in and up --- */
    let updraftCount = Math.round(
      this.updraftEmitter.tick(dt, c.updraftRate * scale) * g.particleCount
    );
    if (updraftCount > 0) {
      _emit.speed = c.updraftSpeed;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.25; // tight: these are being pulled, not thrown
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.6;
      _emit.life = c.updraftLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const per = Math.ceil(updraftCount / Math.min(updraftCount, UPDRAFT_BATCHES));
      while (updraftCount > 0) {
        const a = Math.random() * TAU;
        const r = radius * (1 - c.updraftInset) * Math.sqrt(Math.random());
        _pos.set(centre.x + Math.cos(a) * r, randRange(0.05, 0.5), centre.z + Math.sin(a) * r);
        _emit.position = _pos;
        _emit.radius = 0.2;
        // Inward and up — the swirl comes from the curl noise, not from a
        // tangential velocity, so it stays soft rather than reading as a fan.
        _emit.direction = _dir
          .set(centre.x - _pos.x, 0, centre.z - _pos.z)
          .normalize()
          .multiplyScalar(0.8)
          .setY(1)
          .normalize();
        this.updraft.emit(Math.min(per, updraftCount), _emit);
        updraftCount -= per;
      }
    }

    /* --- haze off the burnt floor --- */
    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random());
      _pos.set(centre.x + Math.cos(a) * r, 0.15, centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.25;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }

    /* --- chips torn off the floor --- */
    const debrisCount = Math.round(
      this.debrisEmitter.tick(dt, c.debrisRate * scale) * g.particleCount
    );
    if (debrisCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random());
      _pos.set(centre.x + Math.cos(a) * r, 0.06, centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.3;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.debrisSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.7;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.debrisLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 8;
      _emit.time = time;
      this.debris.emit(debrisCount, _emit);
    }

    /* --- burns walking around the boundary --- */
    const arcCount = this.arcEmitter.tick(dt, c.arcRate * scale);
    for (let i = 0; i < arcCount; i++) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.72, 1.02);
      _pos.set(centre.x + Math.cos(a) * r, 0, centre.z + Math.sin(a) * r);
      this.ctx.decals.spawn(DecalType.ARC, _pos, {
        radius: c.arcRadius * randRange(0.7, 1.25),
        life: c.arcLife,
        width: c.arcBranches,
        intensity: c.arcIntensity,
        colorA: getColor(c.colorEmber),
        colorB: getColor(c.colorArc)
      });
    }

    /* --- pressure shells shed off the foot of the pillar --- */
    // Kept low, small and faint on purpose. A shell this size released halfway
    // up the column hangs in the air as a faceted glass dome — it needs the
    // floor under it to read as pressure coming off the strike rather than as
    // a bubble parked in mid-air.
    const pulseCount = this.pulseEmitter.tick(dt, c.pulseRate * scale);
    for (let i = 0; i < pulseCount; i++) {
      _pos.copy(centre).setY(height * randRange(0.02, 0.14));
      this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
        radius: c.pulseSize * 0.25,
        endRadius: c.pulseSize * g.explosionIntensity,
        life: 0.42,
        intensity: c.pulseIntensity,
        opacity: 0.3,
        fresnel: 2.2,
        displace: 0.5,
        squash: 0.45, // flattened: pressure spreading over the floor
        colorA: getColor(c.colorBurstA),
        colorB: getColor(c.colorBurstB),
        colorC: getColor(c.colorBurstC)
      });
    }

    /* --- dust rings pushed out across the floor --- */
    const ringCount = this.ringEmitter.tick(dt, c.ringRate * scale);
    for (let i = 0; i < ringCount; i++) {
      this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
        radius: radius * 1.05,
        life: 0.7,
        width: 0.06,
        intensity: 0.6,
        colorA: getColor(c.colorShockA),
        colorB: getColor(c.colorShockB)
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);

    // The light rides the tip of the leash, a little off the floor.
    this._frontPoint(this.position);
    this.position.y += 0.3;

    this._leashFx(dt);
    this.ctx.shake.rumble(settings.snare.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.snare;
    const g = settings.global;
    const time = frame.uTime.value;

    this._openTime = 0;
    this._centrePoint(_pos);

    /* the shell of ionised air the ring throws off as it opens */
    // Short and squashed: the shell has to be gone before the trap settles, or
    // the standing pillar spends its whole life inside a dome.
    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.45,
      intensity: c.burstIntensity,
      opacity: 0.6,
      fresnel: 1.6,
      displace: 0.6,
      squash: 0.55,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor, past the boundary */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.65,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* the dark burn the trap stands on */
    this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
      radius: c.scorchRadius,
      life: c.scorchLife,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorEmber),
      height: 0.012
    });

    /* burns struck around the boundary as it grounds out */
    const marks = 6;
    for (let i = 0; i < marks; i++) {
      const a = (i / marks + Math.random() * 0.1) * TAU;
      const r = this.radius * randRange(0.85, 1.0);
      this._centrePoint(_pos);
      _pos.x += Math.cos(a) * r;
      _pos.z += Math.sin(a) * r;
      this.ctx.decals.spawn(DecalType.ARC, _pos, {
        radius: c.arcRadius * randRange(1.1, 1.7),
        life: c.arcLife * 1.5,
        width: c.arcBranches,
        intensity: c.arcIntensity,
        colorA: getColor(c.colorEmber),
        colorB: getColor(c.colorArc)
      });
    }

    /* sparks and chips blown out of the snap */
    this._centrePoint(_pos);
    _emit.position = _pos;
    _emit.radius = this.radius * 0.35;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 1.9;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.radius = this.radius * 0.6;
    _emit.speed = c.debrisSpeed * 1.7;
    _emit.spread = 0.8;
    _emit.size = 0.13;
    _emit.life = c.debrisLifetime * 1.3;
    _emit.spin = 10;
    this.debris.emit(Math.round(c.burstDebris * g.particleCount), _emit);

    _emit.speed = c.smokeSpeed * 2.0;
    _emit.spread = 1.0;
    _emit.size = 1.4;
    _emit.life = c.smokeLifetime * 1.2;
    _emit.spin = 0.5;
    this.smoke.emit(Math.round(40 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.4 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.snare;
    this._openTime += dt;

    // `t` runs 0..1 while the trap stands, then 1..2 while it collapses. Cubic
    // on the way out so the pillar hangs on and then goes, rather than dimming.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._sync(fade);

    // The light climbs into the column and stays there.
    this._centrePoint(this.position);
    this.position.y = this._state.height * saturate(c.lightHeight);

    this._fieldFx(dt, fade * (t <= 1 ? 1 : 0.4));
    this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._filamentCount = 1;
    this.geometry.instanceCount = 1;
    this.field.visible = false;
    for (const material of this.cageMaterials) material.uniforms.uFade.value = 0;
    this.fieldMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.fieldGeometry.dispose();
    for (const material of this.cageMaterials) material.dispose();
    this.fieldMaterial.dispose();
    super.dispose();
  }
}

/** Clamp a slider to its role's hard ceiling, and never below one filament. */
function clampCount(value, max) {
  return Math.max(0, Math.min(max, Math.round(value)));
}
