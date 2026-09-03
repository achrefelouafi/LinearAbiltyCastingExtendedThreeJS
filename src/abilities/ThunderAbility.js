import { Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createLightningMaterial, BoltPass } from '../materials/LightningMaterial.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

/** Hard ceiling on filaments per bolt. The editor's `strands` slider clamps here. */
const MAX_STRANDS = 24;
/**
 * Samples along one filament. This is the ceiling on how fine a kink can be:
 * anything higher-frequency than one kink per two nodes just aliases, so
 * `jitterScale` above roughly `nodes / (2 × range)` stops adding detail.
 */
const NODES = 72;
/**
 * How many points along the bolt one frame's sparks are split between. Anything
 * lower and each batch reads as a starburst pinned to a single spot.
 */
const SPARK_BATCHES = 6;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _origin = new Vector3();
const _target = new Vector3();

/**
 * THUNDER — a bolt thrown from the hand along the aimed line.
 *
 * One beat, short: a strike front races out from the caster's hand at `speed`
 * and a bundle of lightning filaments is drawn behind it; the bundle then holds
 * for `lifetime`, guttering and re-striking, and blows out over `fadeTime`.
 * Sparks come off it the whole way, the floor underneath takes a branching
 * electric burn and a dark scorch, and the far end gets a shell of ionised air.
 *
 * Everything is generated: the bolt is a strip of camera-facing ribbon whose
 * every vertex is placed by the vertex shader, the burns are shaders on quads,
 * and the sparks, motes, smoke and debris are GPU particles. Nothing is loaded
 * from disk and nothing is a texture.
 *
 * **The rule that makes the editor work.** `IceAbility` keeps a pool of spike
 * records holding nothing but dice rolls; this ability does not even need that,
 * because the *entire* path lives in the shader. A cast captures exactly one
 * number — `_seed`, so two casts do not draw the identical bolt — and resolves
 * every metre, radian and second against `settings.thunder` each frame, on a
 * zero-length frame included. Dragging `jitter` re-kinks a bolt that is already
 * in the air; dragging `spread` re-fans it; dragging `handHeight` lifts the end
 * that leaves the caster. That is the point of pausing with **P** mid-strike.
 *
 * The only other things a cast captures are timestamps. Those are events.
 */
export class ThunderAbility extends Ability {
  constructor(context) {
    super('thunder', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.geometry = createBoltRibbonGeometry(NODES, MAX_STRANDS);

    // Two passes over the same filaments: a wide, soft halo underneath and the
    // hot core on top. Drawing the halo as real ribbon rather than faking it
    // with bloom is what keeps the glow *attached* to every kink.
    this.glowMaterial = createLightningMaterial(BoltPass.GLOW);
    this.coreMaterial = createLightningMaterial(BoltPass.CORE);
    this.boltMaterials = [this.glowMaterial, this.coreMaterial];

    this.meshes = [];
    for (const [index, material] of this.boltMaterials.entries()) {
      const mesh = new Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      // Halo first so the core adds on top of it.
      mesh.renderOrder = 11 + index * 2;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }

    /** Re-rolled per cast so no two bolts draw the same shape. */
    this._seed = 0;
    this._strandCount = 1;
    /** Metres of front travel already paid out in ground burns. */
    this._burnDistance = 0;

    // Scratch state handed to both materials each frame. One object, reused —
    // syncing the bolt allocates nothing.
    this._state = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 0,
      fade: 1,
      seed: 0,
      strands: 1
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Sparks: velocity-stretched streaks under gravity. The signature of the
    // reference frame, and the reason this system asks for `stretch`.
    this.sparks = particles.get('thunder.sparks', {
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

    // The slow ionised motes that hang in the air around the bolt.
    this.motes = particles.get('thunder.motes', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.6;
    this.motes.uniforms.uEndSize.value = 0.15;
    this.motes.uniforms.uSizeIn.value = 0.06;
    this.motes.uniforms.uFadeIn.value = 0.08;
    this.motes.uniforms.uFadeOut.value = 0.4;

    // Haze off the scorched floor. Non-additive so it genuinely occludes.
    this.smoke = particles.get('thunder.smoke', {
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

    // Chips blown off the floor under the strike.
    this.debris = particles.get('thunder.debris', {
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
    this.moteEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.debrisEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // Two passes over the same filaments.
    return this._strandCount * this.meshes.length;
  }

  /** The bolt holds after it lands, then blows out. */
  get impactDuration() {
    return Math.max(0.05, settings.thunder.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.thunder.fadeTime);
  }

  /** Lightning gutters where ice glints — a hard, quantised stutter. */
  lightShimmer() {
    const c = settings.thunder;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    // Deterministic hash of the step index: the light snaps between levels on
    // the same clock the bolt's own flicker runs on.
    const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
    return 1 - saturate(c.lightFlicker) * noise;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry of the bolt — every metre resolved from live settings       */
  /* ------------------------------------------------------------------ */

  /**
   * Where the bolt leaves the caster, in world space.
   *
   * The base class puts `origin` on the floor because that is what the aim
   * indicator targets; a bolt comes out of a hand, so the offsets are applied
   * here rather than baked into the cast.
   */
  _handPoint(out) {
    const c = settings.thunder;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** Where it lands. */
  _impactPoint(out) {
    this.pointAt(1, out);
    out.y = settings.thunder.endHeight;
    return out;
  }

  /**
   * A point on the bolt's *axis* at `s` along it, 0..1.
   *
   * This mirrors the first stage of the vertex shader exactly — the same lerp,
   * the same sag — so the sparks and burns the CPU spawns sit on the bolt the
   * GPU actually draws instead of near it.
   */
  _axisPoint(s, out) {
    const c = settings.thunder;
    const t = saturate(s);
    out
      .copy(this.origin)
      .addScaledVector(this.direction, lerp(c.handForward, this.length, t))
      .addScaledVector(this.side, c.handSide * (1 - t));
    out.y = lerp(c.handHeight, c.endHeight, t) + c.sag * Math.sin(t * Math.PI);
    return out;
  }

  /** Half-width of the bundle at `s`, metres — how far sparks may be thrown. */
  _bundleRadius(s) {
    const c = settings.thunder;
    return lerp(c.spreadNear, c.spread, Math.pow(saturate(s), Math.max(0.01, c.spreadCurve)));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sparkEmitter.reset();
    this.moteEmitter.reset();
    this.smokeEmitter.reset();
    this.debrisEmitter.reset();
    this._burnDistance = 0;

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this._syncUniforms(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into both bolt passes.
   * @param {number} fade 1 while the bolt is lit, ramping to 0 as it blows out
   */
  _syncUniforms(fade) {
    const c = settings.thunder;
    const g = settings.global;
    const state = this._state;

    this._handPoint(state.origin);
    this._impactPoint(state.target);
    state.side.copy(this.side);
    state.progress = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    state.fade = fade;
    state.seed = this._seed;

    this._strandCount = Math.max(1, Math.min(MAX_STRANDS, Math.round(c.strands)));
    state.strands = this._strandCount;
    this.geometry.instanceCount = this._strandCount;

    for (const material of this.boltMaterials) material.userData.sync(state);

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

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = 0.9 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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

  /** The flash at the caster's hand as the bolt leaves it. */
  _muzzleFx() {
    const c = settings.thunder;
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
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });

    _emit.position = _pos;
    _emit.radius = 0.18;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.sparkSpeed * 1.5;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(40 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  /**
   * Sparks, motes, smoke and debris shed along the length of the bolt.
   * @param {number} scale 0..1 — thinned out once the bolt is only holding
   */
  _boltFx(dt, scale) {
    const c = settings.thunder;
    const g = settings.global;
    const time = frame.uTime.value;
    // Only the drawn part of the bolt is allowed to throw anything.
    const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.02, this.u) : 1;

    let sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (sparkCount > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.45).setY(0.55).normalize();
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

      // Spread the frame's sparks over several points along the bolt rather
      // than firing them all from one. A beam sheds along its whole length, and
      // a single origin makes every batch read as a starburst — which is very
      // obviously wrong once you look at it.
      const batches = Math.min(sparkCount, SPARK_BATCHES);
      const per = Math.ceil(sparkCount / batches);
      while (sparkCount > 0) {
        const s = randRange(0.05, 1) * reach;
        this._axisPoint(s, _pos);
        _emit.position = _pos;
        _emit.radius = this._bundleRadius(s) * 1.1 + 0.05;
        this.sparks.emit(Math.min(per, sparkCount), _emit);
        sparkCount -= per;
      }
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const s = Math.random() * reach;
      this._axisPoint(s, _pos);
      _emit.position = _pos;
      _emit.radius = this._bundleRadius(s) * 1.6 + 0.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      // Smoke comes off the *floor*, not the bolt — it is the scorch burning.
      this.pointAt(Math.random() * reach, _pos).setY(0.15);
      _emit.position = _pos;
      _emit.radius = c.scorchRadius * 2.5;
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

    const debrisCount = Math.round(this.debrisEmitter.tick(dt, c.debrisRate * scale) * g.particleCount);
    if (debrisCount > 0) {
      this.pointAt(Math.random() * reach, _pos).setY(0.06);
      _emit.position = _pos;
      _emit.radius = c.scorchRadius * 1.8;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.3).setY(1).normalize();
      _emit.speed = c.debrisSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.8;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.debrisLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 8;
      _emit.time = time;
      this.debris.emit(debrisCount, _emit);
    }
  }

  /** Burns laid on the floor as the strike front passes over it. */
  _groundFx() {
    const c = settings.thunder;
    const step = 1 / Math.max(0.05, c.arcRate);

    while (this.front - this._burnDistance >= step) {
      this._burnDistance += step;
      const s = saturate(this._burnDistance / this.length);
      this.pointAt(s, _pos);
      // Jittered off the axis so the marks do not read as a dotted line.
      const wander = this._bundleRadius(s) * 0.8;
      _pos.x += this.side.x * randRange(-wander, wander);
      _pos.z += this.side.z * randRange(-wander, wander);

      this.ctx.decals.spawn(DecalType.ARC, _pos, {
        radius: c.arcRadius * randRange(0.7, 1.2),
        life: c.arcLife,
        width: c.arcBranches,
        intensity: c.arcIntensity,
        colorA: getColor(c.colorEmber),
        colorB: getColor(c.colorArc)
      });

      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.scorchRadius * randRange(0.7, 1.3),
        life: c.scorchLife,
        intensity: c.scorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorEmber),
        height: 0.015
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._syncUniforms(1);

    // The light rides the tip of the bolt, not the floor under it. `advance()`
    // has already put `position` on the ground line, so lift it onto the axis.
    this._axisPoint(this.u, this.position);

    this._boltFx(dt, 1);
    this._groundFx();

    this.ctx.shake.rumble(settings.thunder.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.thunder;
    const g = settings.global;
    const time = frame.uTime.value;

    this._impactPoint(_pos);

    /* the shell of ionised air */
    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.7,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.6,
      displace: 0.6,
      squash: 0.8,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor */
    this.pointAt(1, _target);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.6,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* a wide burn where it grounded out */
    this.ctx.decals.spawn(DecalType.ARC, _target, {
      radius: c.arcRadius * 2.4,
      life: c.arcLife * 1.6,
      width: c.arcBranches,
      intensity: c.arcIntensity,
      colorA: getColor(c.colorEmber),
      colorB: getColor(c.colorArc)
    });
    this.ctx.decals.spawn(DecalType.SCORCH, _target, {
      radius: c.scorchRadius * 2.6,
      life: c.scorchLife * 1.4,
      intensity: c.scorchIntensity * 1.3,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorEmber),
      height: 0.015
    });

    /* sparks and chips blown out of the strike */
    _emit.position = _pos;
    _emit.radius = 0.3;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.7).normalize();
    _emit.speed = c.sparkSpeed * 2.2;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.22;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.5;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.position = _target;
    _emit.radius = c.scorchRadius * 2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.debrisSpeed * 1.8;
    _emit.spread = 0.85;
    _emit.size = 0.14;
    _emit.life = c.debrisLifetime * 1.3;
    _emit.spin = 10;
    this.debris.emit(Math.round(c.burstDebris * g.particleCount), _emit);

    _emit.speed = c.smokeSpeed * 2.2;
    _emit.spread = 1.0;
    _emit.size = 1.5;
    _emit.life = c.smokeLifetime * 1.3;
    _emit.spin = 0.5;
    this.smoke.emit(Math.round(45 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      26
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the bolt holds, then 1..2 while it blows out. The
    // blow-out is cubic so the bolt hangs on and then goes, rather than dimming.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._syncUniforms(fade);

    // The light stays at the impact point once the front has arrived.
    this._axisPoint(1, this.position);

    // Thinned as it dies: a bolt that is guttering out is not still shedding at
    // full rate, but it does keep throwing sparks until it lets go.
    this._boltFx(dt, fade * (t <= 1 ? 0.6 : 0.35));
  }

  onDestroy() {
    this._strandCount = 1;
    this.geometry.instanceCount = 1;
    for (const material of this.boltMaterials) material.uniforms.uFade.value = 0;
  }

  dispose() {
    this.geometry.dispose();
    for (const material of this.boltMaterials) material.dispose();
    super.dispose();
  }
}
