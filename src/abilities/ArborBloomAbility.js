import { IcosahedronGeometry, Mesh, PlaneGeometry, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import {
  createVineGeometry,
  createLeafGeometry,
  createPetalGeometry,
  createLanceGeometry
} from '../assets/GrowthGeometry.js';
import {
  createGrowthShape,
  createVineMaterial,
  createLeafMaterial,
  syncGrowthShape
} from '../materials/GrowthVineMaterial.js';
import {
  createBloomState,
  createPetalMaterial,
  createBloomCoreMaterial,
  createBloomHaloMaterial
} from '../materials/ArcaneBloomMaterial.js';
import { createNatureSigilMaterial } from '../materials/NatureSigilMaterial.js';
import { createGrowthLanceMaterial, MAX_LANCES } from '../materials/GrowthLanceMaterial.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

const TAU = Math.PI * 2;

/** Instance capacities. The live counts are editor sliders inside these. */
const MAX_VINES = 18;
const MAX_LEAVES = 340;
const MAX_PETALS = 32;

/** How many points one frame's motes are split between. One origin reads as a hose. */
const MOTE_BATCHES = 4;

const _emit = {};
const _pos = new Vector3();
const _centre = new Vector3();
const _bloom = new Vector3();
const _dir = new Vector3();
const _aimAt = new Vector3();

/**
 * The breath, 0..1 — the envelope every glowing pass is driven off.
 *
 * Two sines a fifth apart. Their sum has no period inside the eight seconds a
 * summon stands, so it never lands twice on the same rhythm — but unlike the
 * acid aura's boil this one is *smooth*: a plant does not surge, it breathes,
 * and the difference between the two abilities is entirely in the shape of this
 * one function.
 *
 * @param {number} t phase, seconds × `pulseRate`
 */
function breathEnvelope(t) {
  const a = Math.sin(t);
  const b = Math.sin(t * 1.5 + 2.31);
  return saturate((a + b * 0.62) / 1.62 * 0.5 + 0.5);
}

/**
 * GROWTH — the Arborist's Growth Chrono-Summon.
 *
 * A seed of green light runs across the floor to the aimed circle. A nature
 * sigil opens there and races out to the boundary; a nest of woody tendrils
 * tears up out of it, climbing and curling and unfurling foliage as the growth
 * front passes; and an arcane bloom rises out of the middle of them and opens,
 * whorl by whorl, over a core that is visibly winding up. Then it goes to work:
 * a lance of green light to the nearest body still standing, one at a time, and
 * what it goes through comes apart at the waist.
 *
 * ## The five layers, and what makes them one thing
 *
 * The reference sheet lists them separately and this class is the only place
 * they are not:
 *
 *   1. the **nature sigil** on the floor (`NatureSigilMaterial`)
 *   2. the **tendrils** (`GrowthVineMaterial`)
 *   3. the **foliage** clipped to them (same file, same path function)
 *   4. the **arcane bloom** — petals, core, halo (`ArcaneBloomMaterial`)
 *   5. **motes, pollen, mist** and the leaves that drift off it (particles)
 *
 * Two shared uniform blocks are what hold them together. `_shape` is the growth
 * — where a stem is, how far it has climbed, how far it has withered — and it
 * is handed to the tendril tube, the foliage, and *both* of their shadow
 * materials. `_bloomState` is the flower — where it hangs, how open it is, how
 * charged. Four of the six materials read one or the other by identity, so a
 * single write per frame keeps every pass in agreement and a leaf can never
 * come off the stem it is clipped to.
 *
 * ## Why this is the only ability that aims itself
 *
 * Everything else in the sandbox *reaches*: `DummyField` reads the line a cast
 * publishes and turns it into a kill volume. A summon does not reach — it
 * stands there and picks. So this class answers `handlesOwnHits`, the field
 * leaves it alone, and it asks `findTargets` who is nearby, charges, fires one
 * lance, and calls `Dummy#kill(..., slice)` itself. The cut is not a special
 * effect on top of the kill; it *is* the kill, and it happens on the frame the
 * lance's head reaches the body (see `_stepLances`).
 *
 * ## The rule that keeps the editor honest
 *
 * A cast captures a seed and a handful of timestamps. Not one metre, radian or
 * second is recorded: the footprint, the nest, the bloom, the lances and the
 * light are all resolved against `settings.growth` inside the update loop,
 * which runs on a zero-length frame too. Drag `footprint radius` while a summon
 * is standing and the sigil, the tendrils, the foliage and the bloom all
 * re-seat around it, paused or not.
 */
export class ArborBloomAbility extends Ability {
  constructor(context) {
    super('growth', context);
  }

  /** The field must not fell what this is about to pick out one at a time. */
  get handlesOwnHits() {
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /* ---- the two blocks every pass agrees through ---- */
    this._shape = createGrowthShape();
    this._bloomState = createBloomState();

    /* ---- layer 1: the sigil ---- */
    this.sigilGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.sigilMaterial = createNatureSigilMaterial();
    this.sigil = new Mesh(this.sigilGeometry, this.sigilMaterial);
    this.sigil.name = 'NatureSigil';
    this.sigil.layers.set(LAYER.VFX);
    this.sigil.renderOrder = 6;
    this.sigil.frustumCulled = false;
    this.sigil.visible = false;
    this.group.add(this.sigil);

    /* ---- layer 2: the tendrils ---- */
    this.vineGeometry = createVineGeometry({ vines: MAX_VINES, nodes: 56, sides: 9 });
    this.vineMaterial = createVineMaterial(environment, this._shape);
    this.vines = this._solid(this.vineGeometry, this.vineMaterial, 'GrowthVines');

    /* ---- layer 3: the foliage ---- */
    this.leafGeometry = createLeafGeometry({ leaves: MAX_LEAVES, along: 7, across: 5 });
    this.leafMaterial = createLeafMaterial(environment, this._shape);
    this.foliage = this._solid(this.leafGeometry, this.leafMaterial, 'GrowthFoliage');

    /* ---- layer 4: the bloom ---- */
    this.petalGeometry = createPetalGeometry({ petals: MAX_PETALS, along: 14, across: 9 });
    this.petalMaterial = createPetalMaterial(environment, this._bloomState);
    this.petals = this._solid(this.petalGeometry, this.petalMaterial, 'ArcaneBloom');

    // The charge inside them. Its own transform, because unlike everything
    // above it is an ordinary mesh that the ability places.
    this.coreGeometry = new IcosahedronGeometry(1, 4);
    this.coreMaterial = createBloomCoreMaterial(this._bloomState);
    this.core = new Mesh(this.coreGeometry, this.coreMaterial);
    this.core.name = 'ArcaneBloomCore';
    this.core.layers.set(LAYER.VFX);
    this.core.renderOrder = 16;
    this.core.frustumCulled = false;
    this.core.visible = false;
    this.group.add(this.core);

    // And the light it throws onto the air behind it.
    this.haloGeometry = new PlaneGeometry(1, 1, 1, 1);
    this.haloMaterial = createBloomHaloMaterial(this._bloomState);
    this.halo = new Mesh(this.haloGeometry, this.haloMaterial);
    this.halo.name = 'ArcaneBloomHalo';
    this.halo.layers.set(LAYER.VFX);
    this.halo.renderOrder = 15; // under the core: it is the air, not the charge
    this.halo.frustumCulled = false;
    this.halo.visible = false;
    this.group.add(this.halo);

    /* ---- the lances ---- */
    this.lanceGeometry = createLanceGeometry({ lances: MAX_LANCES, nodes: 40, sides: 12 });
    this.lanceMaterial = createGrowthLanceMaterial();
    this.lances = new Mesh(this.lanceGeometry, this.lanceMaterial);
    this.lances.name = 'GrowthLances';
    this.lances.layers.set(LAYER.VFX);
    this.lances.renderOrder = 18; // over everything: it is the brightest thing here
    this.lances.frustumCulled = false;
    this.lances.matrixAutoUpdate = false;
    this.lances.visible = false;
    this.group.add(this.lances);

    /**
     * One slot per shot in flight. `from` / `to` / `state` are *the material's
     * own uniform values*, written in place — a volley never allocates and
     * never uploads anything but the arrays it already owns.
     */
    this._lanceSlots = [];
    for (let i = 0; i < MAX_LANCES; i++) {
      this._lanceSlots.push({
        age: 0,
        life: 1,
        /** The body this shot is on its way to, until its head arrives. */
        pending: null,
        /** Unit heading of the shot, flat — the direction the cut is made along. */
        dirX: 0,
        dirZ: 1,
        from: this.lanceMaterial.uniforms.uOrigin.value[i],
        to: this.lanceMaterial.uniforms.uTarget.value[i],
        state: this.lanceMaterial.uniforms.uState.value[i]
      });
    }

    /* ---- per-cast state ---- */
    /** Re-rolled per cast, so no two nests grow the same way. */
    this._seed = 0;
    /** Seconds since the seed landed. Drives the whole sequence. */
    this._bloomTime = 0;
    /** Metres of travel already paid out in ground marks. */
    this._markDistance = 0;
    /** Phase through the breath, and the envelope it produces. */
    this._pulsePhase = 0;
    this._pulse = 0;
    /** 0..1 how wound up the core is. */
    this._charge = 0;
    /** Whether the nest has already thrown its foliage. One-shot. */
    this._shed = false;
    /** Seconds until the next shot may leave, and how long this one has charged. */
    this._fireTimer = 0;
    this._chargeTimer = 0;
    /** The body the bloom has settled on, while it winds up. */
    this._mark = null;
    /** Reused by `DummyField#findTargets`, so polling allocates nothing. */
    this._targets = [];
    /** Which way the flower is looking, and where it is swinging to. */
    this._facing = new Vector3(0, 0, 1);
    this._facingTarget = new Vector3(0, 0, 1);
    /** Where the charge sits — the point a lance and its gout leave from. */
    this._lightAt = new Vector3();

    /** Scratch handed to the sigil each frame. One object, reused. */
    this._sigilState = {
      radius: 1,
      quadSize: 1,
      grown: 0,
      front: 0,
      pulse: 0,
      fade: 1,
      seed: 0
    };
    this._shapeState = { centre: new Vector3(), seed: 0, grow: 0, wither: 0 };
  }

  /**
   * One of the three meshes whose vertices are built in their own shader.
   *
   * All of them want the same four things and getting any of them wrong is a
   * different, equally confusing bug: the matching depth material (or the
   * shadow is a sheet at the origin), `SHAPED` (or the depth prepass rasterises
   * that sheet into the soft-particle buffer), no frustum culling (the buffer's
   * own bounds mean nothing), and an identity transform (the vertex stage
   * writes world positions, so any transform would be applied twice).
   */
  _solid(geometry, material, name) {
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.customDepthMaterial = material.userData.depth;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(LAYER.SHAPED);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The spirit motes lifted off the nest. Additive and climbing.
    this.motes = particles.get('growth.motes', {
      capacity: 4000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.motes.uniforms.uDrag.value = 1.1;
    this.motes.uniforms.uEndSize.value = 0.15;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.07;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // Heavier flecks that hang in the air rather than rising out of it. Not
    // additive: pollen is *matter*, and additive matter is a spark.
    this.pollen = particles.get('growth.pollen', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.3
    });
    this.pollen.uniforms.uDrag.value = 1.9;
    this.pollen.uniforms.uEndSize.value = 0.6;
    this.pollen.uniforms.uSizeIn.value = 0.09;
    this.pollen.uniforms.uFadeIn.value = 0.16;
    this.pollen.uniforms.uFadeOut.value = 0.5;

    // The low bank the nest stands in. Its real job is to break the boundary of
    // the sigil: a circle with a mathematically exact edge is a decal, and a
    // little mist wandering over it is what stops that edge being one.
    this.mist = particles.get('growth.mist', {
      capacity: 2200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.mist.uniforms.uDrag.value = 1.9;
    this.mist.uniforms.uEndSize.value = 2.8;
    this.mist.uniforms.uSizeIn.value = 0.15;
    this.mist.uniforms.uFadeIn.value = 0.22;
    this.mist.uniforms.uFadeOut.value = 0.32;

    // Leaves shed off the nest. The one system in the project the LEAF
    // silhouette was actually built for.
    this.drift = particles.get('growth.drift', {
      capacity: 1400,
      shape: ParticleShape.LEAF,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.drift.uniforms.uDrag.value = 1.4;
    this.drift.uniforms.uEndSize.value = 0.9;
    this.drift.uniforms.uSizeIn.value = 0.05;
    this.drift.uniforms.uFadeIn.value = 0.08;
    this.drift.uniforms.uFadeOut.value = 0.4;

    this.moteEmitter = new RateEmitter();
    this.pollenEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
    this.driftEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get impactDuration() {
    return Math.max(0.05, settings.growth.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.growth.fadeTime);
  }

  /** The light breathes with everything else, and flares as a lance leaves. */
  lightShimmer() {
    const c = settings.growth;
    return 1 - c.lightPulse * 0.5 + c.lightPulse * this._pulse + this._charge * 0.35;
  }

  /** Live instance counts, for the HUD readout. */
  get instanceCount() {
    return (
      this.vineGeometry.instanceCount +
      this.leafGeometry.instanceCount +
      this.petalGeometry.instanceCount
    );
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.growth.zoneRadius);
  }

  /** Where the seed leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.growth;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The centre of the summon — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** The seed's travelling head. Pinned to the centre once it has arrived. */
  _frontPoint(out) {
    const u = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(u, out).setY(0.12);
  }

  /** How far the sigil has raced out to the boundary, metres. */
  _sigilGrown() {
    const c = settings.growth;
    return this.radius * Easing.outQuint(saturate(this._bloomTime / Math.max(0.01, c.sigilTime)));
  }

  /** How far the nest has climbed, 0..1, before each stem's own stagger. */
  _vineGrow() {
    const c = settings.growth;
    return Easing.outCubic(
      saturate((this._bloomTime - c.vineDelay) / Math.max(0.01, c.vineTime))
    );
  }

  /** How far out of the nest the bud has lifted, 0..1. Scale and height ride it. */
  _bloomLift() {
    const c = settings.growth;
    return Easing.outCubic(
      saturate((this._bloomTime - c.bloomDelay * 0.6) / Math.max(0.01, c.bloomTime * 1.3))
    );
  }

  /** How far the whorls have opened, 0..1. */
  _bloomOpen() {
    const c = settings.growth;
    return Easing.outCubic(
      saturate((this._bloomTime - c.bloomDelay) / Math.max(0.01, c.bloomTime))
    );
  }

  /** Whether the bloom is open enough, and settled enough, to fire. */
  get _armed() {
    const c = settings.growth;
    if (!c.laserEnabled) return false;
    return this._bloomTime >= c.bloomDelay + c.bloomTime + c.fireDelay;
  }

  /** Where the flower hangs. Rises out of the nest as it opens, then breathes. */
  _bloomPoint(out, lift) {
    const c = settings.growth;
    this._centrePoint(out);
    out.y =
      c.bloomHeight -
      c.bloomRise * (1 - lift) +
      Math.sin(frame.uTime.value * c.bloomBobSpeed * TAU) * c.bloomBob * lift;
    return out;
  }

  /**
   * Where the charge sits: up the flower's own axis from the petal bases,
   * in the throat of the inner whorl.
   *
   * The whorls all bend onto the lily's side, so the bases are the one part of
   * the bloom with nothing in front of them. A core left there is buried under
   * the cup from the front and blazes out of the back unobstructed — the lamp
   * on the wrong face. Seated up the axis the petals close over it, the glow
   * comes out through the gold, and what the back shows is a lit shell. The
   * lance and its gout leave from here too, so the shot comes out of the light
   * rather than out of the stalk.
   *
   * The seat rides `open`, so the charge climbs into the throat as the whorls
   * come apart and sinks back to the base as they close. A fixed seat would
   * have it standing off the point of a closed bud.
   */
  _lightPoint(out, scale, open) {
    const seat = settings.growth.coreSeat * scale * saturate(open);
    return out
      .copy(this._bloomState.uCentre.value)
      .addScaledVector(this._facing, seat);
  }

  /* ------------------------------------------------------------------ */
  /* Where the flower is looking                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Where up a body a lance lands, and therefore what the bloom looks at.
   *
   * Shared by the aim and the shot on purpose: the flower has to be facing the
   * exact point the lance will leave from, or the light comes off the back of
   * a petal.
   */
  _aimPoint(out, dummy) {
    return out.set(
      dummy.position.x,
      settings.dummies.height * saturate(settings.growth.laserAim),
      dummy.position.z
    );
  }

  /**
   * The axis to deal the whorls around, to face `aim` — or, with no `aim`, to
   * face back down the cast at the caster.
   *
   * **Idle is the caster, not the heading.** A summon with nothing to shoot,
   * left looking the way it was thrown, stands there showing the camera the
   * back of the flower: broad petal undersides, the core a blur behind them,
   * and none of the structure the layer is for. The player is the audience, so
   * with no body to pick it comes round and presents itself, and turns off that
   * onto whatever it fires at.
   *
   * Two dials sit on top of the heading. `bloomAimPitch` is how far the flower
   * will tip onto a body's *height*: a summon hanging three metres up, aiming
   * fully at a target at its own feet, is a flower looking at the floor, and
   * the silhouette this whole layer exists for goes with it. `bloomStand` then
   * blends the finished axis back toward world up, which is the flat pose the
   * geometry falls into on its own — 1 stands the bloom up, 0 lays it open at
   * the sky.
   */
  _facingFor(out, aim) {
    const c = settings.growth;
    const centre = this._bloomState.uCentre.value;

    if (aim) {
      out.set(
        aim.x - centre.x,
        (aim.y - centre.y) * saturate(c.bloomAimPitch),
        aim.z - centre.z
      );
    } else {
      out.copy(this.direction).setY(0).negate();
    }
    if (out.lengthSq() < 1e-8) out.copy(this.direction).setY(0).negate();
    if (out.lengthSq() < 1e-8) out.set(0, 0, -1);
    out.normalize();

    const stand = saturate(c.bloomStand);
    out.set(out.x * stand, lerp(1, out.y, stand), out.z * stand);
    return out.lengthSq() > 1e-8 ? out.normalize() : out.set(0, 1, 0);
  }

  /**
   * Swing the flower toward whatever it has settled on.
   *
   * An exponential approach, so it is frame-rate independent and eases *into*
   * the heading. A bloom that snaps onto a body is a turret again; one that
   * takes a moment to come round reads as the thing deciding, which is the same
   * reason the core spends `laserWarmup` winding up before a lance leaves.
   */
  _turnBloom(dt) {
    const target = this._facingTarget;
    if (dt <= 0 || target.lengthSq() < 1e-8) return;

    const rate = Math.max(0, settings.growth.bloomTurnRate);
    const k = rate > 0 ? 1 - Math.exp(-rate * dt) : 1;

    // Dead behind it, and a straight lerp would pass through zero length on the
    // way. Nudged off the axis so the turn has a plane to happen in.
    if (this._facing.dot(target) < -0.9995) {
      this._facing.x += 0.02;
      this._facing.normalize();
    }

    this._facing.lerp(target, k);
    if (this._facing.lengthSq() < 1e-8) this._facing.copy(target);
    else this._facing.normalize();
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.pollenEmitter.reset();
    this.mistEmitter.reset();
    this.driftEmitter.reset();

    this._markDistance = 0;
    this._bloomTime = 0;
    this._charge = 0;
    // Primed, so the *first* shot goes the moment the bloom is armed. Starting
    // at zero would make the summon stand there for a whole interval after
    // `fireDelay` had already said it was ready, and the two waits read as one
    // long hesitation rather than as a cadence.
    this._fireTimer = Math.max(0, settings.growth.laserInterval);
    this._chargeTimer = 0;
    this._mark = null;
    this._shed = false;
    this._targets.length = 0;
    this.lances.visible = false;
    // Started somewhere arbitrary in the envelope, so two summons standing at
    // once are never in step.
    this._pulsePhase = Math.random() * 40;
    this._pulse = 0;
    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    // It comes up looking the way the cast was thrown, and turns off that onto
    // the first body it picks.
    this._facingFor(this._facingTarget, null);
    this._facing.copy(this._facingTarget);

    for (const slot of this._lanceSlots) this._retireLance(slot);

    this._sync(1, 0);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame sync                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into all six materials
   * and the four particle systems.
   *
   * @param {number} fade      1 while the summon stands, ramping to 0 as it goes
   * @param {number} collapse  0..1 through the wither
   */
  _sync(fade, collapse) {
    const c = settings.growth;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(_centre);
    const radius = this.radius;
    const pulse = this._pulse * saturate(fade);

    /* ---- layer 1: the sigil ---- */
    const sigil = this._sigilState;
    sigil.radius = radius;
    sigil.quadSize = (radius + 1.4) * 2;
    sigil.grown = travelling ? 0 : this._sigilGrown();
    // The leading edge is only live while the mark is still opening.
    sigil.front = travelling
      ? 0
      : 1 - saturate(this._bloomTime / Math.max(0.01, c.sigilTime));
    sigil.pulse = pulse;
    sigil.fade = travelling ? 0 : fade;
    sigil.seed = this._seed;
    this.sigilMaterial.userData.sync(sigil);

    this.sigil.visible = !travelling;
    this.sigil.position.set(_centre.x, c.sigilHeight, _centre.z);
    this.sigil.scale.set(sigil.quadSize, 1, sigil.quadSize);

    /* ---- layers 2 and 3: the nest ---- */
    const grow = travelling ? 0 : this._vineGrow();
    const shape = this._shapeState;
    shape.centre.copy(_centre);
    shape.seed = this._seed;
    shape.grow = grow;
    // The wither is held off for the first breath of the collapse: the bloom
    // closes first, and only then does the wood start to go.
    shape.wither = saturate((collapse - 0.12) / 0.88);
    syncGrowthShape(this._shape, shape);
    this.vineMaterial.userData.sync();
    this.leafMaterial.userData.sync();

    const vines = Math.min(MAX_VINES, Math.max(1, Math.round(c.vines)));
    this.vineGeometry.instanceCount = vines;
    // Leaves are dealt round the stems (`mod(aLeaf, count)`), so the count is
    // rounded to a whole number of them per stem — otherwise the last stem
    // carries one extra and reads as the bushy one.
    const perVine = Math.floor(Math.min(MAX_LEAVES, Math.max(0, Math.round(c.leaves))) / vines);
    this.leafGeometry.instanceCount = Math.max(0, perVine * vines);

    this.vines.visible = !travelling && grow > 0.001;
    this.foliage.visible = this.vines.visible && this.leafGeometry.instanceCount > 0;

    /* ---- layer 4: the bloom ---- */
    const lift = travelling ? 0 : this._bloomLift();
    // Closing back to a bud is the *same* control running backwards. There is
    // no second pose, and nothing is blended.
    const open = travelling ? 0 : this._bloomOpen() * (1 - Easing.inQuad(saturate(collapse)));
    const scale = c.bloomScale * lerp(0.3, 1, lift) * lerp(1, 0.72, saturate(collapse));

    const state = this._bloomState;
    this._bloomPoint(state.uCentre.value, lift);
    state.uScale.value = scale;
    state.uSeed.value = this._seed;
    state.uOpen.value = open;
    state.uCharge.value = this._charge;
    state.uFade.value = fade;
    state.uFacing.value.copy(this._facing);

    this.petalMaterial.userData.sync();
    this.coreMaterial.userData.sync();

    const petals =
      Math.max(1, Math.round(c.whorlOuter)) +
      Math.max(1, Math.round(c.whorlMid)) +
      Math.max(1, Math.round(c.whorlInner));
    this.petalGeometry.instanceCount = Math.min(MAX_PETALS, petals);
    this.petals.visible = !travelling && lift > 0.002;

    this._lightPoint(this._lightAt, scale, open);
    _bloom.copy(this._lightAt);
    const coreRadius = Math.max(0.02, c.coreSize * scale);
    this.core.visible = this.petals.visible;
    this.core.position.copy(_bloom);
    this.core.scale.setScalar(coreRadius);

    const haloSize = Math.max(0.05, c.haloSize * scale);
    this.haloMaterial.userData.sync(haloSize);
    this.halo.visible = this.petals.visible && open > 0.02;
    this.halo.position.copy(_bloom);

    /* ---- the lances ---- */
    this.lanceMaterial.userData.sync();

    /* ---- layer 5: the particle systems ---- */
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
    this.motes.uniforms.uGlow.value = 1.5 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.pollen.setGradient(
      getColor(c.colorPollenA),
      getColor(c.colorPollenB),
      getColor(c.colorPollenC),
      getColor(c.colorPollenD)
    );
    this.pollen.uniforms.uGravity.value.set(0, c.pollenRise, 0);
    this.pollen.uniforms.uSizeScale.value = c.pollenSize * g.particleSize * 7;
    this.pollen.uniforms.uLifeScale.value = c.pollenLifetime * 0.5 * g.particleLifetime;
    this.pollen.uniforms.uSpeedScale.value = g.particleSpeed;
    this.pollen.uniforms.uOpacity.value = g.opacity;

    this.mist.setGradient(
      getColor(c.colorMistA),
      getColor(c.colorMistB),
      getColor(c.colorMistC),
      getColor(c.colorMistD)
    );
    this.mist.uniforms.uGravity.value.set(0, c.mistRise, 0);
    this.mist.uniforms.uSizeScale.value = c.mistSize * g.particleSize;
    this.mist.uniforms.uLifeScale.value = c.mistLifetime * 0.5 * g.particleLifetime;
    this.mist.uniforms.uSpeedScale.value = c.mistSpeed * g.particleSpeed;
    this.mist.uniforms.uOpacity.value = c.mistOpacity * g.opacity;
    this.mist.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.drift.setGradient(
      getColor(c.colorDriftA),
      getColor(c.colorDriftB),
      getColor(c.colorDriftC),
      getColor(c.colorDriftD)
    );
    this.drift.uniforms.uGravity.value.set(0, c.driftGravity, 0);
    this.drift.uniforms.uSizeScale.value = c.driftSize * g.particleSize * 7;
    this.drift.uniforms.uLifeScale.value = c.driftLifetime * 0.5 * g.particleLifetime;
    this.drift.uniforms.uSpeedScale.value = g.particleSpeed;
    this.drift.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* The lances                                                          */
  /* ------------------------------------------------------------------ */

  /** Put a slot back in the rack. */
  _retireLance(slot) {
    slot.age = 0;
    slot.pending = null;
    slot.state.set(0, slot.state.y, 1, 0);
  }

  /** The first slot not currently carrying a shot, or null. */
  _freeLance() {
    for (const slot of this._lanceSlots) {
      if (slot.state.w < 0.5) return slot;
    }
    return null;
  }

  /**
   * Choose, charge, fire.
   *
   * The order matters more than any of the numbers: the bloom *marks* a body
   * (`_mark`), spends `laserWarmup` visibly winding up on it — which is what
   * the core's charge and the lit petal tips are showing you — and only then
   * lets a lance go. A summon that fires the instant a target walks into range
   * reads as a turret; one that takes a breath first reads as something
   * deciding.
   */
  _aim(dt, fade) {
    const c = settings.growth;

    // Before anything else, and on every path out of here: the flower keeps
    // coming round to its heading whether or not it is allowed to shoot, so it
    // is still looking at the last body it fired at while it waits out the
    // interval, and it does not un-aim itself as the summon withers.
    this._turnBloom(dt);

    if (!this._armed || fade < 0.5) {
      this._mark = null;
      this._chargeTimer = 0;
      this._charge = Math.max(0, this._charge - dt * 3.2);
      this._facingFor(this._facingTarget, null);
      return;
    }

    this._fireTimer += dt;

    // Whoever it was aiming at may have been felled by the last shot, or burned
    // away while this one was winding up.
    if (this._mark && !this._mark.alive) {
      this._mark = null;
      this._chargeTimer = 0;
    }

    if (!this._mark) {
      if (this._fireTimer < Math.max(0.02, c.laserInterval)) {
        this._charge = Math.max(0, this._charge - dt * 2.4);
        return;
      }
      this._centrePoint(_centre);
      const found = this.ctx.dummies?.findTargets?.(_centre.x, _centre.z, c.laserRange, this._targets);
      this._mark = found && found.length ? found[0] : null;
      this._chargeTimer = 0;
      if (!this._mark) {
        this._charge = Math.max(0, this._charge - dt * 2.4);
        // Nothing left standing in reach: it comes back round to the caster
        // rather than spending the rest of its life staring at a corpse. Only
        // on an *empty* sweep — between the shots of a live exchange the
        // heading is held, or the flower would wobble on every interval.
        this._facingFor(this._facingTarget, null);
        return;
      }
    }

    // It looks at what it is about to shoot, for the whole wind-up. This is
    // most of what the warmup is *for*: the turn is the only warning a body
    // gets, and it is what puts the flower's face — not its back — behind the
    // lance when one leaves.
    this._facingFor(this._facingTarget, this._aimPoint(_aimAt, this._mark));

    this._chargeTimer += dt;
    const warmup = Math.max(0.01, c.laserWarmup);
    this._charge = saturate(this._chargeTimer / warmup);
    if (this._chargeTimer < warmup) return;

    /* ---- fire ---- */
    const volley = Math.max(1, Math.round(c.laserVolley));
    this._fireLance(this._mark);
    if (volley > 1) {
      // The rest of the volley comes off the same list, skipping the one that
      // is already on its way.
      for (let i = 1; i < volley && i < this._targets.length; i++) {
        const other = this._targets[i];
        if (other !== this._mark && other.alive) this._fireLance(other);
      }
    }

    this._mark = null;
    this._chargeTimer = 0;
    this._fireTimer = 0;
  }

  /** Send one lance at one body. */
  _fireLance(dummy) {
    const c = settings.growth;
    const g = settings.global;
    const slot = this._freeLance();
    if (!slot) return;

    slot.from.copy(this._lightAt);
    this._aimPoint(slot.to, dummy);

    // The heading of the shot, flat. This is what the cut plane is tipped along
    // and the direction the two halves are driven apart on.
    const dx = slot.to.x - slot.from.x;
    const dz = slot.to.z - slot.from.z;
    const flat = Math.hypot(dx, dz);
    slot.dirX = flat > 1e-4 ? dx / flat : this.direction.x;
    slot.dirZ = flat > 1e-4 ? dz / flat : this.direction.z;

    slot.age = 0;
    slot.life = Math.max(0.05, c.laserLife);
    slot.pending = dummy;
    slot.state.set(0, Math.random() * 10, Math.max(0.01, c.laserWidth), 1);

    this._charge = 1;
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.35 * g.explosionIntensity);
    this.ctx.shake.add(c.laserShake * g.explosionIntensity * g.cameraShake, 4.0, 26);
    this.ctx.flash.trigger(getColor(c.colorFlash), c.laserFlash * g.explosionIntensity);

    // The bloom throws a gout of motes as it discharges.
    this._muzzleMotes();
  }

  /**
   * Advance every shot, and part whatever each one is going through.
   *
   * The cut lands on the frame the lance's **head** reaches the body rather
   * than on the frame it was fired. That is fifty milliseconds apart at the
   * shipped numbers and it is worth every one of them: a body that comes apart
   * before the light has crossed the gap is the single tell that separates a
   * summon that is doing something from a summon that is playing an animation.
   */
  _stepLances(dt) {
    const c = settings.growth;
    let any = false;

    for (const slot of this._lanceSlots) {
      if (slot.state.w < 0.5) continue;
      any = true;

      slot.age += dt;
      const life = saturate(slot.age / slot.life);
      slot.state.x = life;

      if (slot.pending && life >= c.lanceStrike) {
        const dummy = slot.pending;
        slot.pending = null;
        if (dummy.alive && dummy.kill(slot.dirX, slot.dirZ, c.laserHit, true)) {
          this._cutFx(dummy, slot.dirX, slot.dirZ);
        }
      }

      if (life >= 1) this._retireLance(slot);
    }

    this.lances.visible = any;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The flash at the caster's hand as the seed leaves it. */
  _muzzleFx() {
    const c = settings.growth;
    const g = settings.global;

    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.WATER, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.3,
      intensity: c.muzzleIntensity,
      opacity: 0.7,
      fresnel: 1.8,
      displace: 0.5,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.moteSpeed * 3.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.6;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime * 0.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(c.seedMotes * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /** The gout the bloom sheds as a lance leaves it. */
  _muzzleMotes() {
    const c = settings.growth;
    const g = settings.global;

    _emit.position = _bloom.copy(this._lightAt);
    _emit.radius = 0.28;
    // Out of the flower's face, lifted a little: a gout that leaves along the
    // shot is the discharge, one that goes straight up is a fountain.
    _emit.direction = _dir.copy(this._facing).setY(this._facing.y + 0.3).normalize();
    _emit.speed = c.moteSpeed * 2.6;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.8;
    _emit.life = c.moteLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(46 * g.particleCount), _emit);
  }

  /**
   * What comes out of a body the lance has just gone through.
   *
   * @param {number} dirX the shot's heading, flat — the spray follows the cut
   * @param {number} dirZ
   */
  _cutFx(dummy, dirX, dirZ) {
    const c = settings.growth;
    const g = settings.global;
    const time = frame.uTime.value;

    _pos.copy(dummy.cutPoint);

    // Out along the cut and a little upward. Straight up reads as a fountain,
    // straight out as a hose.
    _dir.set(dirX, 0.5, dirZ).normalize();

    _emit.position = _pos;
    _emit.radius = 0.18;
    _emit.direction = _dir;
    _emit.speed = c.cutSpeed;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.8;
    _emit.life = c.moteLifetime * 0.8;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.motes.emit(Math.round(c.cutMotes * g.particleCount), _emit);

    _emit.speed = c.cutSpeed * 0.7;
    _emit.size = 0.18;
    _emit.life = c.driftLifetime * 0.7;
    _emit.spin = c.driftSpin;
    this.drift.emit(Math.round(c.cutLeaves * g.particleCount), _emit);

    // Small, brief and barely there. A wound is a *line*, and a shell around
    // it at any size the eye can measure reads as a bubble the body is standing
    // in — which is exactly what a pressure burst looks like at 1.5 metres.
    // What sells the cut is the leaves coming out of it, not a dome over it.
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: 0.1,
      endRadius: c.cutBurst * g.explosionIntensity,
      life: 0.22,
      intensity: 1.2,
      opacity: 0.22,
      fresnel: 3.0,
      displace: 0.5,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });
  }

  /** The seed running across the floor: sparks off it, marks under it. */
  _creepFx(dt) {
    const c = settings.growth;
    const g = settings.global;
    const time = frame.uTime.value;

    const count = Math.round(this.moteEmitter.tick(dt, c.creepRate) * g.particleCount);
    if (count > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.25).setY(1).normalize();
      _emit.speed = c.moteSpeed * 1.3;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime * 0.55;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      let remaining = count;
      const per = Math.ceil(count / Math.min(count, MOTE_BATCHES));
      while (remaining > 0) {
        this.pointAt(randRange(0.15, 1) * this.u, _pos).setY(0.08);
        _emit.position = _pos;
        _emit.radius = 0.26;
        this.motes.emit(Math.min(per, remaining), _emit);
        remaining -= per;
      }
    }

    // Marks paid out per metre of travel, jittered off the line so they do not
    // read as a dotted trail.
    const step = 1 / Math.max(0.05, c.trailRate);
    while (this.front - this._markDistance >= step) {
      this._markDistance += step;
      const s = saturate(this._markDistance / this.length);
      this.pointAt(s, _pos);
      _pos.x += this.side.x * randRange(-0.45, 0.45);
      _pos.z += this.side.z * randRange(-0.45, 0.45);

      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.stainRadius * randRange(0.6, 1.1),
        life: c.stainLife * 0.6,
        intensity: c.stainIntensity * 0.8,
        colorA: getColor(c.colorStain),
        colorB: getColor(c.colorStainEdge),
        height: 0.024
      });
    }
  }

  /**
   * Everything the standing summon sheds.
   *
   * @param {number} scale 0..1 — thinned out as the nest withers
   */
  _auraFx(dt, scale) {
    const c = settings.growth;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_centre);
    const radius = this.radius;
    const height = c.vineHeight;
    // The breath is felt in the *rate* as well as in the brightness: the nest
    // visibly gives up more of itself on the way up.
    const surge = 1 + this._pulse * c.pulseDepth;

    /* --- spirit motes off the nest --- */
    let motes = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale * surge) * g.particleCount);
    if (motes > 0) {
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.6;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const per = Math.ceil(motes / Math.min(motes, MOTE_BATCHES));
      while (motes > 0) {
        // On the ring the stems are planted on, at a random height up them —
        // which is where the light on the wood actually is.
        const a = Math.random() * TAU;
        const r = radius * c.vineSeat * randRange(0.7, 1.15);
        _pos.set(
          _centre.x + Math.cos(a) * r,
          randRange(0.05, height * 0.95),
          _centre.z + Math.sin(a) * r
        );
        _emit.position = _pos;
        _emit.radius = 0.3;
        this.motes.emit(Math.min(per, motes), _emit);
        motes -= per;
      }
    }

    /* --- pollen hanging around the bloom --- */
    const pollen = Math.round(this.pollenEmitter.tick(dt, c.pollenRate * scale) * g.particleCount);
    if (pollen > 0) {
      _bloom.copy(this._bloomState.uCentre.value);
      _emit.position = _bloom;
      _emit.radius = radius * 0.45;
      _emit.direction = _dir.set(0, -0.2, 0).normalize();
      _emit.speed = c.pollenSpeed;
      _emit.speedVariance = 0.9;
      _emit.spread = 1.0;
      _emit.size = 0.11;
      _emit.sizeVariance = 0.7;
      _emit.life = c.pollenLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.time = time;
      this.pollen.emit(pollen, _emit);
    }

    /* --- the low bank the nest stands in --- */
    const mist = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (mist > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.5, 1.05);
      _pos.set(_centre.x + Math.cos(a) * r, 0.14, _centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.2;
      _emit.direction = _dir
        .set(Math.cos(a) * c.mistSpread, 0.3, Math.sin(a) * c.mistSpread)
        .normalize();
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.8;
      _emit.size = 0.85;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.mist.emit(mist, _emit);
    }

    /* --- and the leaves that come off it --- */
    const drift = Math.round(this.driftEmitter.tick(dt, c.driftRate * scale) * g.particleCount);
    if (drift > 0) {
      const a = Math.random() * TAU;
      const r = radius * c.vineSeat * randRange(0.6, 1.1);
      _pos.set(
        _centre.x + Math.cos(a) * r,
        randRange(height * 0.35, height * 1.05),
        _centre.z + Math.sin(a) * r
      );
      _emit.position = _pos;
      _emit.radius = 0.35;
      _emit.direction = _dir.set(Math.cos(a) * 0.4, 0.2, Math.sin(a) * 0.4).normalize();
      _emit.speed = c.driftSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.7;
      _emit.size = 0.16;
      _emit.sizeVariance = 0.6;
      _emit.life = c.driftLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = c.driftSpin;
      _emit.time = time;
      this.drift.emit(drift, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // The light rides the seed, just off the floor.
    this._frontPoint(this.position);
    this.position.y += 0.35;

    this._creepFx(dt);
    this.ctx.shake.rumble(settings.growth.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.growth;
    const g = settings.global;
    const time = frame.uTime.value;

    this._bloomTime = 0;

    const centre = this._centrePoint(_centre);

    /* the shell the sigil throws as it opens */
    this.ctx.bursts.spawn(BurstMode.AIR, centre, {
      radius: c.rootBurst * 0.2,
      endRadius: c.rootBurst * g.explosionIntensity,
      life: 0.42,
      intensity: c.rootIntensity,
      opacity: 0.4,
      fresnel: 2.4,
      displace: 0.4,
      squash: 0.5, // flattened: pressure spreading over the floor
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor, past the boundary */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
      radius: this.radius * 1.25 * g.explosionIntensity,
      life: 0.8,
      width: 0.05,
      intensity: 0.9,
      colorA: getColor(c.colorSigil),
      colorB: getColor(c.colorSigilCore)
    });

    /* the mark the summon stands on, and leaves behind */
    this.ctx.decals.spawn(DecalType.SCORCH, centre, {
      radius: this.radius * 0.95,
      life: c.stainLife,
      intensity: c.stainIntensity,
      colorA: getColor(c.colorStain),
      colorB: getColor(c.colorStainEdge),
      height: 0.012
    });

    /* everything the floor gives up as the roots come through it */
    _emit.position = centre;
    _emit.radius = this.radius * 0.6;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 3.0;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.85;
    _emit.life = c.moteLifetime * 1.3;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.motes.emit(Math.round(c.rootMotes * g.particleCount), _emit);

    _emit.radius = this.radius * 0.7;
    _emit.speed = c.driftSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 0.17;
    _emit.life = c.driftLifetime;
    _emit.spin = c.driftSpin;
    this.drift.emit(Math.round(c.rootLeaves * g.particleCount), _emit);

    _emit.radius = this.radius * 0.75;
    _emit.speed = c.mistSpeed * 3.2;
    _emit.spread = 1.0;
    _emit.size = 1.3;
    _emit.life = c.mistLifetime * 1.1;
    _emit.spin = 0.35;
    this.mist.emit(Math.round(c.rootMist * g.particleCount), _emit);

    this.ctx.shake.add(
      c.rootShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.lightBoost = c.lightIntensity * 1.1 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.growth;
    const g = settings.global;
    const previousBloomTime = this._bloomTime;
    this._bloomTime += dt;

    // `t` runs 0..1 while the summon stands, then 1..2 while it withers.
    const collapse = t <= 1 ? 0 : saturate(t - 1);
    const fade = 1 - Easing.inQuad(collapse);

    /* ---- the breath, before anything reads it ---- */
    this._pulsePhase += dt * Math.max(0, c.pulseRate);
    this._pulse = breathEnvelope(this._pulsePhase) * (1 - collapse * 0.6);

    /* ---- the one-shot the bloom fires as it opens ---- */
    const opened = c.bloomDelay + c.bloomTime;
    if (previousBloomTime < opened && this._bloomTime >= opened && dt > 0) {
      this._bloomFx();
    }

    this._aim(dt, fade);
    this._stepLances(dt);
    this._sync(fade, collapse);

    // The light sits inside the flower once there is one, and low in the nest
    // before that.
    this._centrePoint(this.position);
    this.position.y = lerp(
      0.4,
      this._bloomState.uCentre.value.y,
      saturate(c.lightHeight) * this._bloomLift()
    );

    this._auraFx(dt, fade * (t <= 1 ? 1 : 0.35));
    this.ctx.shake.rumble(c.holdShake * fade * g.cameraShake, dt);

    // The nest is torn apart as it goes, once and heavily rather than as a
    // trickle: a summon that dissolves quietly leaves the eye with nothing to
    // follow.
    if (collapse > 0 && !this._shed && dt > 0) {
      this._shed = true;
      this._witherFx();
    }
  }

  /** What the flower throws as its whorls come open. */
  _bloomFx() {
    const c = settings.growth;
    const g = settings.global;
    const time = frame.uTime.value;

    _bloom.copy(this._lightAt);

    this.ctx.bursts.spawn(BurstMode.AIR, _bloom, {
      radius: 0.3,
      endRadius: c.bloomScale * 2.6 * g.explosionIntensity,
      life: 0.5,
      intensity: 1.6,
      opacity: 0.45,
      fresnel: 2.2,
      displace: 0.35,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _bloom;
    _emit.radius = c.bloomScale * 0.7;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 2.2;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.8;
    _emit.life = c.moteLifetime * 1.2;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.motes.emit(Math.round(c.bloomMotes * g.particleCount), _emit);

    _emit.speed = c.pollenSpeed * 3.0;
    _emit.size = 0.12;
    _emit.life = c.pollenLifetime;
    this.pollen.emit(Math.round(c.bloomPollen * g.particleCount), _emit);

    _emit.speed = c.driftSpeed * 2.0;
    _emit.size = 0.17;
    _emit.life = c.driftLifetime;
    _emit.spin = c.driftSpin;
    this.drift.emit(Math.round(c.bloomLeaves * g.particleCount), _emit);

    this.ctx.shake.add(c.bloomShake * g.explosionIntensity * g.cameraShake, 2.6, 20);
    this.ctx.flash.trigger(getColor(c.colorFlash), c.bloomFlash * g.explosionIntensity);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.8 * g.explosionIntensity);
  }

  /** The nest shedding its foliage as it goes. */
  _witherFx() {
    const c = settings.growth;
    const g = settings.global;

    this._centrePoint(_centre);
    _emit.position = _pos.set(_centre.x, c.vineHeight * 0.55, _centre.z);
    _emit.radius = this.radius * c.vineSeat;
    _emit.direction = _dir.set(0, -0.15, 0).normalize();
    _emit.speed = c.driftSpeed * 1.4;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.17;
    _emit.sizeVariance = 0.7;
    _emit.life = c.driftLifetime * 1.2;
    _emit.lifeVariance = 0.5;
    _emit.spin = c.driftSpin;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.drift.emit(Math.round(c.witherLeaves * g.particleCount), _emit);
  }

  onDestroy() {
    for (const slot of this._lanceSlots) this._retireLance(slot);
    this._mark = null;
    this._shed = false;
    this._targets.length = 0;

    this.sigil.visible = false;
    this.vines.visible = false;
    this.foliage.visible = false;
    this.petals.visible = false;
    this.core.visible = false;
    this.halo.visible = false;
    this.lances.visible = false;
    this.sigilMaterial.uniforms.uFade.value = 0;
    this._bloomState.uFade.value = 0;
    this._bloomState.uOpen.value = 0;
    this._shape.uGrow.value = 0;
  }

  dispose() {
    this.sigilGeometry.dispose();
    this.vineGeometry.dispose();
    this.leafGeometry.dispose();
    this.petalGeometry.dispose();
    this.coreGeometry.dispose();
    this.haloGeometry.dispose();
    this.lanceGeometry.dispose();

    this.sigilMaterial.dispose();
    this.vineMaterial.userData.depth.dispose();
    this.vineMaterial.dispose();
    this.leafMaterial.userData.depth.dispose();
    this.leafMaterial.dispose();
    this.petalMaterial.userData.depth.dispose();
    this.petalMaterial.dispose();
    this.coreMaterial.dispose();
    this.haloMaterial.dispose();
    this.lanceMaterial.dispose();

    super.dispose();
  }
}
