import { Matrix4, Mesh, Object3D, PlaneGeometry, Vector3 } from 'three';
import { Ability } from './Ability.js';
import { createSerpentMaterial, SerpentPass } from '../materials/CyberSerpentMaterial.js';
import { createNeonTrailMaterial } from '../materials/NeonTrailMaterial.js';
import { createCircuitFieldMaterial } from '../materials/CircuitFieldMaterial.js';
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

/** Hard ceilings. The editor's sliders clamp here. */
const MAX_GHOSTS = 8;
const MAX_TRAILS = 8;

/** Tessellation of one trail ribbon. Nothing about its *shape* lives here. */
const TRAIL_NODES = 110;

/** How many points along the body one frame's motes are split between. */
const MOTE_BATCHES = 4;

const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _head = new Vector3();
const _tail = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _worldUp = new Vector3(0, 1, 0);
const _basis = new Matrix4();

/**
 * CYBER SERPENT — a holographic construct thrown down the aimed line.
 *
 * Five layers, in the order the eye reads them:
 *
 *  1. **the construct** — `public/models/snake.glb`, stripped of its authored
 *     material and redrawn as a glowing wireframe over a near-empty interior.
 *     It swims: the vertex stage rebuilds a local frame from an analytic spine
 *     every frame, so the body undulates behind a leading head and the normals
 *     travel with it. See `materials/CyberSerpentMaterial.js`.
 *  2. **the energy inside it** — the same mesh, barely inflated, weighted so it
 *     is brightest where a view ray takes the longest path through the volume.
 *  3. **the ribbons** — a nest of helices wound about the flight line, all of
 *     them one instanced draw. See `materials/NeonTrailMaterial.js`.
 *  4. **the wake** — the body again, N lagged copies of it, each holding the
 *     pose the serpent had when it was there, eroded into vapour; plus the
 *     drifting mist the particle system carries.
 *  5. **the rune board** — a routed circuit laid on the floor along the line,
 *     dark until the nose passes over it. See `materials/CircuitFieldMaterial.js`.
 *
 * Everything but the mesh is generated, and the mesh contributes nothing except
 * a silhouette: the file's material and texture are dropped at load time and
 * every pixel here is written by these shaders.
 *
 * **The rule that makes the editor work.** A cast captures exactly one number —
 * `_seed`, so two serpents do not swim identically — plus timestamps. Every
 * metre, radian and second is resolved against `settings.cyber` each frame, on a
 * zero-length frame included: dragging `bodyLength` re-scales a serpent already
 * in the air, dragging `sway` re-swims it, dragging `runeCell` re-routes the
 * board under it. That is what pausing with **P** mid-flight is for.
 */
export class CyberSerpentAbility extends Ability {
  constructor(context) {
    super('cyber', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const model = this.ctx.models?.serpent;
    if (!model) {
      throw new Error('[CyberSerpent] the serpent geometry is missing — see App#load');
    }
    this.model = model;

    /* ---- the body: five passes over one mesh, on one transform ---- */
    this.body = new Object3D();
    this.body.name = 'CyberSerpent:body';
    this.group.add(this.body);

    // Back to front. The order is not about correctness — everything here is
    // additive with depth writes off — but keeping the wire last means it is the
    // pass that survives when several of them saturate.
    const passes = [
      [SerpentPass.WAKE, model.ghostGeometry, LAYER.VFX, 11],
      [SerpentPass.AURA, model.geometry, LAYER.VFX, 12],
      [SerpentPass.FILL, model.geometry, LAYER.VFX, 13],
      [SerpentPass.WIRE, model.geometry, LAYER.VFX, 15],
      [SerpentPass.WARP, model.geometry, LAYER.DISTORTION, 0]
    ];

    this.bodyMaterials = [];
    for (const [pass, geometry, layer, renderOrder] of passes) {
      const material = createSerpentMaterial(pass);
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(layer);
      mesh.renderOrder = renderOrder;
      this.body.add(mesh);
      this.bodyMaterials.push(material);
    }

    /* ---- the trails: every ribbon in one instanced draw ---- */
    this.trailGeometry = createBoltRibbonGeometry(TRAIL_NODES, MAX_TRAILS);
    this.trailMaterial = createNeonTrailMaterial();
    this.trailMesh = new Mesh(this.trailGeometry, this.trailMaterial);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.matrixAutoUpdate = false;
    this.trailMesh.layers.set(LAYER.VFX);
    this.trailMesh.renderOrder = 14;
    this.group.add(this.trailMesh);

    /* ---- the rune board on the floor ---- */
    this.fieldGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.fieldMaterial = createCircuitFieldMaterial();
    this.fieldMesh = new Mesh(this.fieldGeometry, this.fieldMaterial);
    this.fieldMesh.frustumCulled = false;
    this.fieldMesh.layers.set(LAYER.VFX);
    this.fieldMesh.renderOrder = 7;
    this.group.add(this.fieldMesh);

    /** Re-rolled per cast so no two serpents swim the same. */
    this._seed = 0;
    this._ghostCount = 1;
    this._trailCount = 1;
    /** Metres of front travel already paid out in rune sparks. */
    this._sparkedTo = 0;
    /** Seconds since the strike — drives the shatter and the board's shock ring. */
    this._blastTime = -1;

    // Scratch handed to all five body passes each frame. One object, reused.
    this._bodyState = { form: 0, shatter: 0, fade: 1, seed: 0 };
    this._trailState = {
      head: new Vector3(),
      dir: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      up: new Vector3(0, 1, 0),
      span: 1,
      strands: 1,
      fade: 1,
      seed: 0
    };
    this._fieldState = {
      span: 1,
      width: 1,
      front: 0,
      impact: 1,
      blast: 0,
      blastGain: 0,
      fade: 1,
      seed: 0
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Data motes shed off the construct: small, bright, additive, and pulled
    // about by curl noise so they drift rather than fall.
    this.motes = particles.get('cyber.motes', {
      capacity: 4200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.motes.uniforms.uDrag.value = 1.35;
    this.motes.uniforms.uEndSize.value = 0.05;
    this.motes.uniforms.uSizeIn.value = 0.02;
    this.motes.uniforms.uFadeIn.value = 0.05;
    this.motes.uniforms.uFadeOut.value = 0.4;

    // Velocity-stretched streaks: the sparks torn off the head and thrown out
    // of the strike.
    this.sparks = particles.get('cyber.sparks', {
      capacity: 4000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.6;
    this.sparks.uniforms.uEndSize.value = 0.15;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    // The wake field itself: cold vapour left hanging in the corridor. Not
    // additive — it has to *occlude* the ribbons behind it or it reads as more
    // glow rather than as air.
    this.wake = particles.get('cyber.wake', {
      capacity: 2400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.wake.uniforms.uDrag.value = 1.9;
    this.wake.uniforms.uEndSize.value = 3.4;
    this.wake.uniforms.uSizeIn.value = 0.14;
    this.wake.uniforms.uFadeIn.value = 0.2;
    this.wake.uniforms.uFadeOut.value = 0.32;

    this.moteEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
    this.wakeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // Four body passes plus the wake copies, the ribbons and the board.
    return 5 + this._ghostCount + this._trailCount;
  }

  /** The strike: how long the construct takes to come apart. */
  get impactDuration() {
    return Math.max(0.05, settings.cyber.shatterTime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.cyber.fadeTime);
  }

  /**
   * A construct does not gutter like a flame or hum like a beam — it is being
   * *computed*, so the light steps between levels on a clock and occasionally
   * drops a frame of it.
   */
  lightShimmer() {
    const c = settings.cyber;
    const step = Math.floor(this.age * c.lightPulseSpeed);
    const held = 0.72 + 0.28 * ((step * 0.618) % 1);
    return 1 - c.lightPulse * (1 - held);
  }

  /* ------------------------------------------------------------------ */
  /* Where the body is — every metre resolved from live settings          */
  /* ------------------------------------------------------------------ */

  /**
   * The nose, in world space.
   *
   * The base class puts `position` on the floor because that is what the aim
   * indicator targets; the serpent flies, so the height is applied here. It
   * leaves the caster's hand low and settles onto its cruise height over the
   * first `riseDistance` metres, which is what makes the launch read as a throw
   * rather than as a spawn.
   */
  _headPoint(out) {
    const c = settings.cyber;
    this.pointAt(this.u, out);
    const rise = Easing.outCubic(saturate((this.u * this.length) / Math.max(0.1, c.riseDistance)));
    out.y = lerp(c.launchHeight, c.flightHeight, rise);
    out.y += Math.sin(this.age * c.bobSpeed * TAU) * c.bob * rise;
    return out;
  }

  /**
   * A point on the swimming body, `s` back from the nose (0..1).
   *
   * Mirrors `spineAt()` in the vertex shader so the motes, the sparks and the
   * vapour sit on the animal the GPU is drawing instead of near it. The one
   * thing it leaves out is the bank roll, which moves the *surface* and not the
   * spine.
   */
  _bodyPoint(s, out) {
    const c = settings.cyber;
    const g = settings.global;
    const length = c.bodyLength;
    const time = frame.uTime.value;
    const amp = c.sway * lerp(c.swayRoot, 1, s) * length;

    const lateral =
      Math.sin((s * c.swayWaves - time * c.swaySpeed * g.animationSpeed) * TAU + this._seed * 6.1) * amp;
    const vertical =
      Math.sin(
        (s * c.swayPitchWaves - time * c.swaySpeed * 0.61 * g.animationSpeed) * TAU + this._seed * 2.7 + 1.31
      ) *
      amp *
      c.swayPitch;

    this._headPoint(out);
    return out
      .addScaledVector(this.direction, -s * length)
      .addScaledVector(_right, lateral)
      .addScaledVector(_up, vertical);
  }

  /** The body's flight frame, written into the module scratch vectors. */
  _frame() {
    const c = settings.cyber;
    // `Ability#side` is `direction × up`, which is left of the heading; the
    // shader's local +X is `up × direction`. Taking the shader's convention here
    // is what keeps the serpent the right way up.
    _right.crossVectors(_worldUp, this.direction).normalize();
    // Banked into the swim: the roll is the lateral *velocity* of the spine, so
    // the body leans into each stroke instead of rolling on its own clock.
    const time = frame.uTime.value;
    const roll =
      -Math.cos(-time * c.swaySpeed * settings.global.animationSpeed * TAU + this._seed * 6.1) * c.bank;
    if (roll !== 0) _right.applyAxisAngle(this.direction, roll);
    _up.crossVectors(this.direction, _right).normalize();
  }

  /** How much of the body has assembled behind the nose, 0..1. */
  get form() {
    const c = settings.cyber;
    return Easing.outQuad(saturate(this.age / Math.max(0.01, c.formTime)));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    for (const emitter of [this.moteEmitter, this.sparkEmitter, this.wakeEmitter]) emitter.reset();

    this._sparkedTo = 0;
    this._blastTime = -1;
    this._seed = Math.random() * 100;

    this._frame();
    this._syncUniforms(0, 0, 1);
    this._castFx();
  }

  /** The construct compiling in the caster's hand and letting go. */
  _castFx() {
    const c = settings.cyber;
    const g = settings.global;

    this._headPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.castBurst * 0.2,
      endRadius: c.castBurst * g.explosionIntensity,
      life: 0.42,
      intensity: c.castBurstGlow,
      // As thin as the strike's, and for the same reason: `fresnel` scales the
      // rim rather than tightening it, so anything generous here puts a milky
      // dome over the caster on the frame the serpent is compiling out of.
      opacity: 0.35,
      fresnel: 1.2,
      displace: 0.3,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstC)
    });

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.origin, {
      radius: c.castBurst * 2.0 * g.explosionIntensity,
      life: 0.5,
      width: 0.05,
      intensity: 0.85,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    _emit.position = _pos;
    _emit.radius = 0.2;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.sparkSpeed * 1.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.75;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.castSparks * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the cast's state into all three systems.
   *
   * @param {number} dt      seconds (unused by the shaders, kept for symmetry
   *                         with the abilities that ease a second light)
   * @param {number} shatter 0..1 — the construct coming apart
   * @param {number} fade    1 while it is flying, ramping to 0 as it dies
   */
  _syncUniforms(dt, shatter, fade) {
    const c = settings.cyber;
    const g = settings.global;

    this._frame();

    /* ---- the body ---- */
    this._ghostCount = Math.max(1, Math.min(MAX_GHOSTS, Math.round(c.ghosts)));
    this.model.ghostGeometry.instanceCount = this._ghostCount;

    const state = this._bodyState;
    state.form = this.form;
    state.shatter = shatter;
    state.fade = fade;
    state.seed = this._seed;
    for (const material of this.bodyMaterials) material.userData.sync(state);

    this._headPoint(_head);
    // The object's origin sits half a body length behind the nose, because the
    // canonical body has its head at local z = +0.5.
    this.body.position.copy(_head).addScaledVector(this.direction, -0.5 * c.bodyLength);
    _basis.makeBasis(_right, _up, this.direction);
    this.body.quaternion.setFromRotationMatrix(_basis);
    this.body.scale.setScalar(Math.max(0.01, c.bodyLength));

    /* ---- the ribbons ---- */
    this._trailCount = Math.max(1, Math.min(MAX_TRAILS, Math.round(c.trails)));
    this.trailGeometry.instanceCount = this._trailCount;

    const trail = this._trailState;
    trail.head.copy(_head);
    trail.dir.copy(this.direction);
    trail.side.copy(_right);
    trail.up.copy(_up);
    // The ribbons cannot reach further back than the serpent has flown, or they
    // would hang out of the caster's back.
    trail.span = Math.max(0.5, Math.min(c.trailLength, this.front + c.bodyLength * 0.5));
    trail.strands = this._trailCount;
    // The ribbons are *carried* by the construct, so they go with it: they snap
    // back rather than hanging in the air over the debris.
    trail.fade = fade * (1 - shatter * 0.9);
    trail.seed = this._seed;
    this.trailMaterial.userData.sync(trail);

    /* ---- the rune board ---- */
    const span = this.length + c.runeOverrun;
    const width = Math.max(0.2, c.runeWidth * 2);
    const field = this._fieldState;
    field.span = span;
    field.width = width;
    field.front = Math.min(this.front, this.length);
    field.impact = this.length;
    field.blast = this._blastTime < 0 ? 0 : this._blastTime * c.runeBlastSpeed;
    field.blastGain = this._blastTime < 0 ? 0 : Math.max(0, 1 - this._blastTime / Math.max(0.05, c.runeBlastLife));
    field.fade = fade;
    field.seed = this._seed;
    this.fieldMaterial.userData.sync(field);

    this.fieldMesh.position.set(
      this.origin.x + this.direction.x * span * 0.5,
      c.runeHeight,
      this.origin.z + this.direction.z * span * 0.5
    );
    this.fieldMesh.rotation.y = Math.atan2(-this.direction.z, this.direction.x);
    this.fieldMesh.scale.set(span, 1, width);

    /* ---- the particle systems ---- */
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
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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
    this.sparks.uniforms.uGlow.value = c.sparkGlow * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

    this.wake.setGradient(
      getColor(c.colorWakeA),
      getColor(c.colorWakeB),
      getColor(c.colorWakeC),
      getColor(c.colorWakeD)
    );
    this.wake.uniforms.uGravity.value.set(0, c.wakeRise, 0);
    this.wake.uniforms.uSizeScale.value = c.wakeSize * g.particleSize;
    this.wake.uniforms.uLifeScale.value = c.wakeLifetime * 0.5 * g.particleLifetime;
    this.wake.uniforms.uSpeedScale.value = c.wakeSpeed * g.particleSpeed;
    this.wake.uniforms.uOpacity.value = c.wakeOpacity * g.opacity;
    this.wake.uniforms.uTurbulence.value = c.wakeTurbulence * g.turbulence;
  }

  /**
   * What the construct sheds while it flies.
   * @param {number} scale 0..1 — thinned out as it dies
   */
  _bodyFx(dt, scale) {
    const c = settings.cyber;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this.model.radius * c.bodyLength;
    // Only the part of the body that has assembled is allowed to shed anything.
    const reach = Math.max(0.05, this.form);

    let moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      // Split across the length: one emission point per frame reads as a jet
      // coming off a single scale rather than as a body shedding.
      const per = Math.ceil(moteCount / MOTE_BATCHES);
      while (moteCount > 0) {
        const s = Math.random() * reach;
        this._bodyPoint(s, _pos);
        _emit.position = _pos;
        _emit.radius = radius * 1.4;
        // Off the body and *backwards*: the motes are being left behind, not
        // thrown forward with it.
        _emit.direction = _dir
          .copy(this.direction)
          .multiplyScalar(-c.moteDrift)
          .addScaledVector(_up, 0.35)
          .normalize();
        this.motes.emit(Math.min(per, moteCount), _emit);
        moteCount -= per;
      }
    }

    const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (sparkCount > 0) {
      // Off the head, where it is going through the air.
      this._bodyPoint(randRange(0, 0.2), _pos);
      _emit.position = _pos;
      _emit.radius = radius * 1.1;
      _emit.direction = _dir
        .copy(this.direction)
        .multiplyScalar(-0.85)
        .addScaledVector(_right, randRange(-1, 1))
        .addScaledVector(_up, randRange(-0.3, 0.9))
        .normalize();
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.5;
      _emit.size = 0.13;
      _emit.sizeVariance = 0.75;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.6;
      _emit.spin = 0;
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }

    const wakeCount = Math.round(this.wakeEmitter.tick(dt, c.wakeRate * scale) * g.particleCount);
    if (wakeCount > 0) {
      // Left behind the tail, which is where a wake is.
      this._bodyPoint(reach * randRange(0.55, 1), _tail);
      _emit.position = _tail;
      _emit.radius = radius * 2.6;
      _emit.direction = _dir
        .copy(this.direction)
        .multiplyScalar(-0.6)
        .addScaledVector(_right, randRange(-1, 1) * 0.6)
        .setY(0.35)
        .normalize();
      _emit.speed = c.wakeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.6;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.wakeLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0.35;
      _emit.time = time;
      this.wake.emit(wakeCount, _emit);
    }
  }

  /** Sparks struck off the floor as the nose crosses it. */
  _groundFx() {
    const c = settings.cyber;
    const g = settings.global;
    const step = 1 / Math.max(0.05, c.groundSparkRate);

    while (this.front - this._sparkedTo >= step) {
      this._sparkedTo += step;
      const s = saturate(this._sparkedTo / this.length);
      this.pointAt(s, _pos);
      const wander = c.runeWidth * 0.5;
      _pos.x += _right.x * randRange(-wander, wander);
      _pos.z += _right.z * randRange(-wander, wander);
      _pos.y = 0.03;

      _emit.position = _pos;
      _emit.radius = 0.08;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.4).setY(1).normalize();
      _emit.speed = c.sparkSpeed * 0.55;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime * 0.7;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.sparks.emit(Math.round(c.groundSparks * g.particleCount), _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.cyber;
    const g = settings.global;

    this._syncUniforms(dt, 0, 1);
    // The light rides the nose, not the floor under it.
    this._headPoint(this.position);

    this._bodyFx(dt, 1);
    this._groundFx();
    this.ctx.shake.rumble(c.rumble * g.cameraShake, dt);
  }

  onImpact() {
    const c = settings.cyber;
    const g = settings.global;
    const time = frame.uTime.value;

    this._blastTime = 0;
    this._headPoint(_head);
    this.pointAt(1, _tail);

    /*
     * The construct decompiling.
     *
     * STORM rather than AIR or FIRE, and the choice matters: that mode keeps the
     * body of the shell *empty* and draws filaments racing over its surface, so
     * what expands is a cage of arcs rather than a ball. Every other mode is a
     * volume, and a volume here fogs out the one thing the strike exists to
     * show — the body coming apart inside it.
     *
     * `fresnel` is a *scale* on the rim term, not a power (see BurstSphere), so
     * pushing it up brightens the whole shell instead of tightening it. Low.
     */
    this.ctx.bursts.spawn(BurstMode.STORM, _head, {
      radius: c.burstSize * 0.18,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.55,
      intensity: c.burstIntensity,
      opacity: 0.42,
      fresnel: 1.4,
      displace: 0.5,
      squash: 0.92,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps out across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _tail, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.6,
      width: 0.045,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });
    this.ctx.decals.spawn(DecalType.ARC, _tail, {
      radius: c.arcRadius * g.explosionIntensity,
      life: c.arcLife,
      width: 0.08,
      intensity: c.arcIntensity,
      colorA: getColor(c.colorArcA),
      colorB: getColor(c.colorArcB),
      height: 0.018
    });

    /* the body's own fragments, thrown */
    _emit.position = _head;
    _emit.radius = 0.3;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.25).setY(0.5).normalize();
    _emit.speed = c.sparkSpeed * 2.6;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.7;
    _emit.lifeVariance = 0.65;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.speed = c.moteSpeed * 2.2;
    _emit.size = 0.1;
    _emit.life = c.moteLifetime * 1.4;
    this.motes.emit(Math.round(c.burstMotes * g.particleCount), _emit);

    _emit.position = _tail;
    _emit.radius = 0.6;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.wakeSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 1.2;
    _emit.life = c.wakeLifetime * 1.2;
    _emit.spin = 0.5;
    this.wake.emit(Math.round(60 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      26
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.3 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.cyber;

    if (this._blastTime >= 0) this._blastTime += dt;

    // `t` runs 0..1 while the construct comes apart, then 1..2 while what is
    // left of it dims out.
    const shatter = saturate(t);
    let fade = 1;
    if (t > 1) fade = 1 - Easing.inQuad(saturate(t - 1));

    this._syncUniforms(dt, shatter, fade);
    this._headPoint(this.position);

    // The debris keeps shedding for the first half of the shatter, then stops:
    // fragments that go on spitting motes read as a fire rather than as a thing
    // that has been switched off.
    this._bodyFx(dt, Math.max(0, 1 - shatter * 1.8) * fade);

    if (t <= 1) this.ctx.shake.rumble(c.burnShake * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._ghostCount = 1;
    this._trailCount = 1;
    this._blastTime = -1;
    this.model.ghostGeometry.instanceCount = 1;
    this.trailGeometry.instanceCount = 1;
    for (const material of this.bodyMaterials) {
      material.uniforms.uFade.value = 0;
      material.uniforms.uShatter.value = 0;
      material.uniforms.uForm.value = 0;
    }
    this.trailMaterial.uniforms.uFade.value = 0;
    this.fieldMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    // `model.geometry` is shared by every pooled instance and owned by the app,
    // so it is not disposed here.
    for (const material of this.bodyMaterials) material.dispose();
    this.trailGeometry.dispose();
    this.trailMaterial.dispose();
    this.fieldGeometry.dispose();
    this.fieldMaterial.dispose();
    super.dispose();
  }
}
