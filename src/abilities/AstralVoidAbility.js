import {
  Mesh,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  InstancedMesh,
  InstancedBufferAttribute,
  Object3D,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createHorizonMaterial, createLensMaterial } from '../materials/SingularityMaterial.js';
import { createAstralNebulaMaterial } from '../materials/AstralNebulaMaterial.js';
import { createCosmicRingMaterial, createShockWarpMaterial } from '../materials/CosmicShockMaterial.js';
import { createVoidShardMaterial } from '../materials/VoidShardMaterial.js';
import { createCrystalGeometry, createShardGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

const TAU = Math.PI * 2;

/** Tessellation of the shockwave annulus. */
const RING_SEGMENTS = 168;
/**
 * Radial rings. The vertex stage lifts the wave packet off the floor, so this
 * is not decoration: at 24 the crest is visibly faceted, because the packet is
 * under a metre deep and the ring is a dozen metres across.
 */
const RING_BANDS = 48;

/** Facets around the nebula's proxy. It is only a scissor; it never shades. */
const NEBULA_SEGMENTS = 40;
const NEBULA_RINGS = 28;

/** Two shard silhouettes, so the debris field is not one shape rotated. */
const SHARD_VARIANTS = 2;
/** Instances per variant. */
const SHARD_SLOTS = 28;

/** How many bodies one hole can have hold of at once. */
const MAX_GRIPS = 8;

/**
 * How the tangential current falls away outside the horizon, as an exponent on
 * `core / distance`.
 *
 * A free vortex is 1, and at 1 the swirl out at the rim is a fraction of the
 * inward pull — a body caught on the edge arrives at the middle on very nearly
 * a straight line. Slackening it keeps the two comparable the whole way in,
 * which is the difference between something being *wound* into the hole and
 * something falling down a drain.
 */
const SWIRL_FALLOFF = 0.55;

/** How many points one frame's ejecta is split between. One origin reads as a hose. */
const EJECTA_BATCHES = 4;

const _emit = {};
const _pos = new Vector3();
const _at = new Vector3();
const _core = new Vector3();
const _dir = new Vector3();
const _node = new Object3D();

/**
 * The flare envelope, 0..1 — the irregular pulse every pass of this ability is
 * driven off.
 *
 * Two sines at incommensurate frequencies (1 and φ), so their sum has no period
 * and within the seconds a hole stands it never lands twice on the same rhythm.
 * Deliberately *spikier* than the Sumi Tide's swell: water heaves, an accretion
 * disc flares — matter piles up at the innermost stable orbit, goes in, and the
 * hole brightens for a moment. Sharpening this is the fastest way to make the
 * blast read as violent rather than as a lamp.
 */
function flareEnvelope(t) {
  const a = Math.sin(t);
  const b = Math.sin(t * 1.6180339887 + 2.4);
  return saturate(((a + b * 0.9) / 1.9) * 0.5 + 0.5);
}

/**
 * ASTRAL — the Void Blast, and the only ability in the set that takes what it
 * catches out of the world entirely.
 *
 * A pinprick of collapsed space is thrown to the aimed circle, already bending
 * the frame around itself on the way. Where it lands it inflates, holds for a
 * breath, and then **collapses** — and that collapse is the blast: a nebula of
 * gold and cosmic violet erupts out of the point, a planar shockwave rips
 * across the floor, void-shards are thrown clear and immediately caught in the
 * currents, and everything standing in the circle is wound in, lifted off the
 * stone and pulled into the hole until there is nothing left of it. Then the
 * hole closes on itself and takes the light with it.
 *
 * Five passes, one per panel of the reference sheet:
 *
 *   1. **the singularity core** — a pitch-black disc with a photon ring welded
 *      to its edge, expanding and then violently collapsing to start the blast;
 *   2. **the event horizon distortion** — a real screen-space lens on
 *      LAYER.DISTORTION that wraps the *whole finished frame* around the hole,
 *      this ability's other four layers included;
 *   3. **the astral nebula burst** — a raymarched, oblate, differentially
 *      sheared cloud of gas: deep cosmic purples in the body, brilliant gold in
 *      the throat, wound into arms that spiral into the middle;
 *   4. **the stardust ejecta** — thousands of micro-stars spiralling in on a
 *      collapsing orbit, and instanced crystalline void-shards tumbling with
 *      them, going incandescent as the tide of gravity strains them apart;
 *   5. **the cosmic shockwave** — an expanding planar ring of astral energy
 *      lying on the floor, lifting a crest of displaced air and shoving the
 *      frame outward through the refraction buffer as it goes.
 *
 * **One envelope makes those five things one thing.** `_churn` is evaluated
 * once per frame and handed to every material, the light, the emitters and the
 * camera: the disc brightens, the gas thickens, the ring pulses, ejecta comes
 * faster — and when a flare crosses `flareThreshold` on the way up the hole
 * *feeds*: a throw of ejecta, a knock on the camera, a punch of light. Nothing
 * here free-runs on its own sine.
 *
 * **What happens to the bodies is the point.** This class answers
 * `handlesOwnHits`, so `DummyField` leaves it alone. Instead it asks
 * `findBodies` who is standing — or already lying — inside the reach, knocks
 * the living *inward*, and then keeps hold of all of them. What it does from
 * there is three beats, and they have to arrive in this order or the hole reads
 * as a light with a suction sound:
 *
 *   - **taken** — the well carries the body's weight (`Dummy#carry`'s buoyancy)
 *     so it leaves the stone. It has to: the solver scrubs the slide off
 *     anything touching the floor, and a corpse lying on it is a corpse no
 *     amount of gravity can turn.
 *   - **wound** — it spirals in and tumbles end over end, both winding up the
 *     nearer the middle it gets, and stretching as it goes, because the pull is
 *     sampled per *joint* and the joints nearest the hole are pulled hardest.
 *   - **taken apart** — inside the horizon it is consumed (`Dummy#consume`),
 *     burning away from wherever the void has hold of it rather than on a
 *     timer, and the hole flares on the frame it finishes.
 *
 * **The rule that makes the editor work.** A cast captures one number — a seed
 * — a handful of clocks, and per-shard dice rolls with no units on them. Not
 * one metre, radian or second is recorded: the horizon, the nebula, the ring,
 * the debris field and the grip are all resolved against `settings.astral`
 * inside the update loop, which runs on a zero-length frame too. Drag
 * `coreRadius` while a hole is standing and the shadow, the ring, the gas
 * cavity, the lens, the shard orbits and the reach of the swallow all re-scale
 * around it.
 */
export class AstralVoidAbility extends Ability {
  constructor(context) {
    super('astral', context);
  }

  /**
   * The hole picks its own, and keeps them.
   *
   * `DummyField` would otherwise read the cast as a far-cast disc and fling
   * everything in it *outward* on the frame the front lands — the exact
   * opposite of what gravity does, and it would throw the bodies clear of the
   * thing that is supposed to be eating them.
   */
  get handlesOwnHits() {
    return true;
  }

  /** Shards currently drawn. HUD readout only. */
  get instanceCount() {
    let count = 0;
    for (const mesh of this.shardMeshes) count += mesh.count;
    return count;
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /* ---- layer 1: the singularity ---- */
    this.horizonGeometry = new PlaneGeometry(1, 1);
    this.horizonMaterial = createHorizonMaterial();
    this.horizon = new Mesh(this.horizonGeometry, this.horizonMaterial);
    this.horizon.name = 'VoidHorizon';
    this.horizon.layers.set(LAYER.VFX);
    // Under the nebula on purpose: the gas march stops analytically at the
    // shadow, so gas in *front* of the hole has to composite over a disc that
    // is already there.
    this.horizon.renderOrder = 11;
    this.horizon.frustumCulled = false;
    this.horizon.visible = false;
    this.group.add(this.horizon);

    /* ---- layer 2: the lens ---- */
    this.lensGeometry = new PlaneGeometry(1, 1);
    this.lensMaterial = createLensMaterial();
    this.lens = new Mesh(this.lensGeometry, this.lensMaterial);
    this.lens.name = 'VoidLens';
    this.lens.layers.set(LAYER.DISTORTION);
    this.lens.frustumCulled = false;
    this.lens.visible = false;
    this.group.add(this.lens);

    /* ---- layer 3: the nebula ---- */
    // A sphere drawn back faces only. It is a scissor and nothing else: it
    // exists to rasterise the pixels the cloud could cover, and the far faces
    // are the ones that stay behind the camera when it is standing inside it.
    this.nebulaGeometry = new SphereGeometry(1, NEBULA_SEGMENTS, NEBULA_RINGS);
    this.nebulaMaterial = createAstralNebulaMaterial();
    this.nebula = new Mesh(this.nebulaGeometry, this.nebulaMaterial);
    this.nebula.name = 'AstralNebula';
    this.nebula.layers.set(LAYER.VFX);
    this.nebula.renderOrder = 12;
    this.nebula.frustumCulled = false;
    this.nebula.visible = false;
    this.group.add(this.nebula);

    /* ---- layer 5: the shockwave ---- */
    // One unit annulus shared by the visible wave and its refraction proxy, so
    // the two can never disagree about where the front is.
    this.ringGeometry = new RingGeometry(0, 1, RING_SEGMENTS, RING_BANDS);
    this.ringMaterial = createCosmicRingMaterial();
    this.ring = new Mesh(this.ringGeometry, this.ringMaterial);
    this.ring.name = 'CosmicShock';
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.layers.set(LAYER.VFX);
    this.ring.renderOrder = 6;
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.group.add(this.ring);

    this.warpMaterial = createShockWarpMaterial();
    this.warp = new Mesh(this.ringGeometry, this.warpMaterial);
    this.warp.name = 'CosmicShockWarp';
    this.warp.rotation.x = -Math.PI / 2;
    this.warp.layers.set(LAYER.DISTORTION);
    this.warp.frustumCulled = false;
    this.warp.visible = false;
    this.group.add(this.warp);

    /* ---- layer 4: the void-shards ---- */
    this.shardMaterial = createVoidShardMaterial(environment);
    this.shardMeshes = [];
    this.shardHeat = [];

    for (let v = 0; v < SHARD_VARIANTS; v++) {
      const geometry = v === 0
        ? createCrystalGeometry({ seed: 3.1 + v, sides: 5, taper: 0.06, roughness: 0.55, bend: 0.3 })
        : createShardGeometry(11 + v, 6);
      // Centred on its own middle, so an instance tumbles about itself rather
      // than swinging around a pivot at its foot.
      geometry.translate(0, -0.5, 0);

      const seeds = new InstancedBufferAttribute(new Float32Array(SHARD_SLOTS), 1);
      const heat = new InstancedBufferAttribute(new Float32Array(SHARD_SLOTS), 1);
      for (let i = 0; i < SHARD_SLOTS; i++) seeds.array[i] = Math.random() * 10;
      geometry.setAttribute('aSeed', seeds);
      geometry.setAttribute('aHeat', heat);

      const mesh = new InstancedMesh(geometry, this.shardMaterial, SHARD_SLOTS);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid geometry: it belongs in the depth prepass, so the gas around a
      // shard is clipped by it and the two layers occupy one space.
      mesh.layers.set(LAYER.WORLD);
      mesh.renderOrder = 2;
      this.group.add(mesh);

      this.shardMeshes.push(mesh);
      this.shardHeat.push(heat);
    }

    /**
     * One record per shard, holding nothing but dice rolls.
     *
     * Every metre, radian and second a shard occupies is resolved from live
     * settings in `_updateShards`, so dragging `shardReach` re-throws a debris
     * field that is already falling.
     */
    this.shards = [];
    for (let i = 0; i < SHARD_VARIANTS * SHARD_SLOTS; i++) {
      this.shards.push({
        bearing: 0,
        lift: 0,
        reach: 1,
        delay: 0,
        life: 1,
        size: 1,
        aspect: 1,
        sense: 1,
        tumbleX: 0,
        tumbleY: 0,
        tumbleZ: 0,
        phase: 0
      });
    }

    /** Re-rolled per cast, so no two blasts wind the same way. */
    this._seed = 0;
    /** Seconds since the singularity landed. Drives every clock below. */
    this._bloomTime = 0;
    /** Whether the collapse has fired yet. */
    this._blasted = false;
    /** ... and whether the hole has closed on itself. */
    this._closed = false;
    /** How much of the hole is left, 1 while it stands and 0 once it has gone. */
    this._shrink = 1;
    /** Metres of stroke already paid out in ground marks. */
    this._markDistance = 0;
    /** Phase through the flare envelope, and the envelope it produces. */
    this._churnPhase = 0;
    this._churnRaw = 0;
    this._churn = 0;
    /** Which side of the ring is beamed. Integrated, so the rate is live. */
    this._beamPhase = 0;
    /** How far the shockwave has travelled, metres. Integrated for the same reason. */
    this._shockFront = 0;

    /**
     * The bodies this hole has hold of.
     *
     * Pre-allocated and reused: a cast that catches four targets must not build
     * four objects, and `_gripCount` is how many of these slots are live rather
     * than how long the array is.
     */
    this._grips = [];
    for (let i = 0; i < MAX_GRIPS; i++) {
      this._grips.push({ dummy: null, time: 0, eaten: 0, marked: false });
    }
    this._gripCount = 0;
    /** Reused by `DummyField#findBodies`, so polling allocates nothing. */
    this._found = [];
    /** The blow that takes a body off its feet, refilled from settings each cast. */
    this._force = { impulse: 0, lift: 0, spin: 0 };
    /**
     * Everything `_sampleFlow` needs to answer *how fast is the void here*.
     *
     * Refilled per body per frame rather than closed over, because the sampler
     * runs once per joint of every body the hole is holding — two hundred times
     * in a frame with a full circle — and neither it nor the loop around it is
     * allowed to make garbage.
     */
    this._flow = {
      cx: 0, // the middle of the hole
      cy: 0,
      cz: 0,
      sx: 0, // the body's own centre, which it tumbles about
      sy: 0,
      sz: 0,
      core: 1, // the horizon, metres — the solid-body middle of the swirl
      well: 1, // where the pull is half its peak, metres
      pull: 0, // inward, m/s, at the middle
      swirl: 0, // tangential at the horizon, m/s
      wx: 0, // the body's own angular velocity, rad/s
      wy: 0,
      wz: 0
    };
    /** Bound once: `Dummy#carry` is handed this for every body, every frame. */
    this._field = (x, y, z, out) => this._sampleFlow(x, y, z, out);

    // Scratch state handed to the materials each frame. One object apiece,
    // reused — syncing a standing hole allocates nothing.
    this._horizonState = { size: 1, horizon: 1, beamPhase: 0, churn: 0, fade: 1, seed: 0 };
    this._lensState = { size: 1, horizon: 1, phase: 0, strength: 0 };
    this._nebulaState = {
      centre: new Vector3(),
      radius: 1,
      hole: 1,
      cavity: 0.2,
      churn: 0,
      drain: 0,
      fade: 1,
      seed: 0
    };
    this._ringState = { reach: 1, front: 0, fade: 1, seed: 0 };
    this._warpState = { reach: 1, front: 0, strength: 0 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The micro-stars. Additive and on the swirl path, which is the whole
    // reason this system exists: with a *negative* expansion a particle's orbit
    // collapses onto its anchor over its own lifetime, so the dust genuinely
    // spirals into the hole and arrives there as it dies. Nothing else in the
    // engine draws an infall.
    this.stardust = particles.get('astral.stardust', {
      capacity: 5000,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      softFade: 0.3
    });
    this.stardust.uniforms.uDrag.value = 0.4;
    this.stardust.uniforms.uEndSize.value = 0.15;
    this.stardust.uniforms.uSizeIn.value = 0.05;
    this.stardust.uniforms.uFadeIn.value = 0.08;
    this.stardust.uniforms.uFadeOut.value = 0.45;
    // Weightless: these are in orbit, and a gravity vector pointing at the
    // floor would drag every star out of the plane it is supposed to be in.
    this.stardust.uniforms.uGravity.value.set(0, 0, 0);

    // The gold thrown clear. Velocity-stretched streaks under almost no
    // gravity, because what they are falling toward is sideways.
    this.embers = particles.get('astral.embers', {
      capacity: 3000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.embers.uniforms.uDrag.value = 1.1;
    this.embers.uniforms.uGravity.value.set(0, -1.2, 0);
    this.embers.uniforms.uEndSize.value = 0.25;
    this.embers.uniforms.uSizeIn.value = 0.03;
    this.embers.uniforms.uFadeIn.value = 0.03;
    this.embers.uniforms.uFadeOut.value = 0.4;
    this.embers.uniforms.uStretch.value = 0.4;

    // The rubble. Lit chips under real gravity — the only pass here that is
    // allowed to fall on the floor, because it is the one made of stone.
    this.chips = particles.get('astral.chips', {
      capacity: 2200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      stretch: true,
      softFade: 0.2
    });
    this.chips.uniforms.uDrag.value = 0.5;
    this.chips.uniforms.uGravity.value.set(0, -7.5, 0);
    this.chips.uniforms.uEndSize.value = 0.75;
    this.chips.uniforms.uSizeIn.value = 0.04;
    this.chips.uniforms.uFadeIn.value = 0.03;
    this.chips.uniforms.uFadeOut.value = 0.65;

    // The stone the shockwave lifts. Non-additive, so it genuinely occludes —
    // it is the one thing in this ability that has to read as *matter* rather
    // than as light, and it is what gives the blast its scale.
    this.dust = particles.get('astral.dust', {
      capacity: 2400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.dust.uniforms.uDrag.value = 1.7;
    this.dust.uniforms.uGravity.value.set(0, -0.6, 0);
    this.dust.uniforms.uEndSize.value = 3.2;
    this.dust.uniforms.uSizeIn.value = 0.14;
    this.dust.uniforms.uFadeIn.value = 0.2;
    this.dust.uniforms.uFadeOut.value = 0.3;

    this.starEmitter = new RateEmitter();
    this.emberEmitter = new RateEmitter();
    this.chipEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
    this.trailEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** The hole forms, blows, and stands there feeding. */
  get impactDuration() {
    return Math.max(0.05, settings.astral.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.astral.fadeTime);
  }

  /**
   * The light does not flicker — it *feeds*.
   *
   * `lightPulse` is how much of it the flare envelope owns: at 0 the hole is
   * lit flat, at 1 it nearly goes out between flares.
   */
  lightShimmer() {
    const c = settings.astral;
    return 1 - c.lightPulse * 0.5 + c.lightPulse * this._churn * 1.5;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the circle indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.astral.zoneRadius);
  }

  /** Where the singularity is thrown from, in world space. */
  _handPoint(out) {
    const c = settings.astral;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /**
   * The middle of the hole.
   *
   * Off the floor, and that is a mechanic rather than a look: a body has to be
   * *lifted* into this thing, and a hole sitting on the stone would only ever
   * drag corpses along it.
   */
  _corePoint(out) {
    const c = settings.astral;
    if (this.phase === AbilityPhase.TRAVEL) {
      // On the way, the seed rides the front and climbs from the hand to the
      // height it will hang at.
      this.pointAt(this.u, out);
      out.y = lerp(c.handHeight, c.coreHeight, Easing.outQuad(this.u));
      return out;
    }
    this.pointAt(1, out);
    out.y = c.coreHeight;
    return out;
  }

  /**
   * The radius of the shadow right now, metres.
   *
   * Panel one of the reference, in one function: a seed that inflates, then
   * snaps shut on itself — and it is the snap that starts the blast, not the
   * arrival. A hole that is simply *there* on the frame it lands has nothing to
   * collapse, and the whole ability loses its first beat.
   */
  _horizonRadius() {
    const c = settings.astral;
    if (this.phase === AbilityPhase.TRAVEL) {
      return Math.max(0.01, c.coreRadius * c.seedSize);
    }

    const t = this._bloomTime;
    const swell = Easing.outQuad(saturate(t / Math.max(0.02, c.coreSwell)));
    const pinch = Easing.inCubic(saturate((t - c.coreSwell) / Math.max(0.03, c.corePinch)));
    const open = lerp(c.seedSize, c.coreBloom, swell);
    return Math.max(0.01, c.coreRadius * lerp(open, 1, pinch) * this._shrink);
  }

  /** How far the eruption has got, 0..1. Starts at the collapse, not the landing. */
  _blastAmount() {
    const c = settings.astral;
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    return Easing.outQuint(
      saturate((this._bloomTime - c.coreSwell) / Math.max(0.05, c.burstTime))
    );
  }

  /** How far the pull reaches, metres — and what a body has to be inside to be caught. */
  get pullRadius() {
    return Math.max(0.5, this.radius * settings.astral.grip.reach);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.starEmitter.reset();
    this.emberEmitter.reset();
    this.chipEmitter.reset();
    this.dustEmitter.reset();
    this.trailEmitter.reset();

    this._markDistance = 0;
    this._bloomTime = 0;
    this._blasted = false;
    this._closed = false;
    this._shockFront = 0;
    this._shrink = 1;
    // Started somewhere arbitrary in the envelope, so two holes standing at
    // once are never in step.
    this._churnPhase = Math.random() * 40;
    this._churnRaw = 0;
    this._churn = 0;
    this._beamPhase = Math.random() * TAU;
    this._releaseGrips();
    this._rollShards();
    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this._sync(1, 0);
    this._muzzleFx();
  }

  /**
   * Re-roll the debris field.
   *
   * Unitless, every one of them: a bearing in turns, a lift as a fraction of
   * the reach, a delay as a fraction of the hold. The metres arrive later, from
   * settings, on the frame the shard is drawn.
   */
  _rollShards() {
    for (const shard of this.shards) {
      shard.bearing = Math.random() * TAU;
      // Thrown mostly along the equator, because that is where the gas is —
      // cubing a signed roll keeps a few of them well out of the plane without
      // scattering the field into a ball.
      const lift = Math.random() * 2 - 1;
      shard.lift = lift * lift * lift;
      shard.reach = randRange(0.55, 1.0);
      // Squared, so most of them are thrown at the moment of the collapse and a
      // thin tail keeps arriving while the hole stands.
      shard.delay = Math.random() * Math.random();
      shard.life = randRange(0.65, 1.0);
      shard.size = randRange(0.55, 1.0);
      shard.aspect = randRange(0.22, 0.7);
      shard.sense = Math.random() < 0.82 ? 1 : -1;
      shard.tumbleX = randRange(-1, 1);
      shard.tumbleY = randRange(-1, 1);
      shard.tumbleZ = randRange(-1, 1);
      shard.phase = Math.random() * TAU;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame sync                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into every material.
   *
   * @param {number} fade 1 while the hole is live, ramping to 0 as it closes
   * @param {number} dry  0..1 through the collapse
   */
  _sync(fade, dry) {
    const c = settings.astral;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._corePoint(_core);
    const horizon = this._horizonRadius();
    const blast = this._blastAmount();
    const churn = this._churn * saturate(fade);

    /* ---- the singularity ---- */
    const horizonState = this._horizonState;
    // The quad has to contain the halo, and the halo is measured in horizon
    // radii — so the mesh grows with the hole and every threshold in the shader
    // stays a shape rather than a distance.
    horizonState.size = horizon * c.haloReach;
    horizonState.horizon = horizon;
    horizonState.beamPhase = this._beamPhase;
    horizonState.churn = churn;
    horizonState.fade = fade;
    horizonState.seed = this._seed;
    this.horizonMaterial.userData.sync(horizonState);

    this.horizon.visible = horizon > 0.005;
    this.horizon.position.copy(_core);

    /* ---- the lens ---- */
    const lensState = this._lensState;
    lensState.size = horizon * c.lensReach;
    lensState.horizon = horizon;
    lensState.phase = this._beamPhase;
    lensState.strength = fade;
    this.lensMaterial.userData.sync(lensState);

    this.lens.visible = this.horizon.visible;
    this.lens.position.copy(_core);

    /* ---- the nebula ---- */
    const nebulaState = this._nebulaState;
    const reach = Math.max(0.2, c.nebulaRadius * blast * (1 - dry * 0.3));
    nebulaState.centre.copy(_core);
    nebulaState.radius = reach;
    nebulaState.hole = horizon;
    // The eye has to be a little wider than the shadow, or the gas clips
    // through the photon ring and the two layers stop being one object.
    nebulaState.cavity = saturate((horizon * c.nebulaCavity) / reach);
    nebulaState.churn = churn;
    nebulaState.drain = Easing.inQuad(dry);
    nebulaState.fade = fade;
    nebulaState.seed = this._seed;
    this.nebulaMaterial.userData.sync(nebulaState);

    this.nebula.visible = !travelling && blast > 0.004;
    this.nebula.position.copy(_core);
    // The proxy has to contain every metre the analytic shape can reach, or the
    // cloud would be clipped by the box that is only supposed to find it.
    this.nebula.scale.setScalar(reach * 1.18);

    /* ---- the shockwave ---- */
    const shockReach = Math.max(0.5, c.shockRadius * g.explosionIntensity);
    const travelled = saturate(this._shockFront / shockReach);
    // Energy over a growing circumference: the wave loses its punch as it goes.
    const shockFade = (1 - travelled) * (1 - travelled) * fade;

    const ringState = this._ringState;
    ringState.reach = shockReach;
    ringState.front = this._shockFront;
    ringState.fade = shockFade;
    ringState.seed = this._seed;
    this.ringMaterial.userData.sync(ringState);

    this.ring.visible = !travelling && this._blasted && shockFade > 0.004;
    this.ring.position.set(_core.x, c.shockHeight, _core.z);

    const warpState = this._warpState;
    warpState.reach = shockReach;
    warpState.front = this._shockFront;
    warpState.strength = shockFade;
    this.warpMaterial.userData.sync(warpState);

    this.warp.visible = this.ring.visible;
    this.warp.position.set(_core.x, c.shockHeight + 0.35, _core.z);

    /* ---- the shards ---- */
    this.shardMaterial.userData.sync();
    this.shardMaterial.userData.uniforms.uCore.value.copy(_core);

    /* ---- the particle gradients ---- */
    this.stardust.setGradient(
      getColor(c.colorStarA),
      getColor(c.colorStarB),
      getColor(c.colorStarC),
      getColor(c.colorStarD)
    );
    this.embers.setGradient(
      getColor(c.colorEmberA),
      getColor(c.colorEmberB),
      getColor(c.colorEmberC),
      getColor(c.colorEmberD)
    );
    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );

    // The stars' orbit, live: both are read every frame by every star already
    // in flight, so dragging them re-winds the whole infall.
    this.stardust.uniforms.uSwirl.value = c.starSwirl * g.noiseSpeed;
    // Negative: the orbit *collapses* onto its anchor. This one number is the
    // difference between dust orbiting a hole and dust being eaten by one.
    this.stardust.uniforms.uSwirlExpand.value = -saturate(c.starInfall);
  }

  /* ------------------------------------------------------------------ */
  /* The debris field                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Place every shard, from nothing but the clock and its own dice roll.
   *
   * The orbit is Kepler-flavoured rather than Keplerian, and deliberately so —
   * it has to be closed-form, because a record that integrated its own position
   * could not be re-scaled by the editor mid-flight. Two choices do the work:
   *
   *  - the radius decays as `(1 - s)^(2/3)`, which is the profile that makes
   *    the winding integrate to a **logarithm**. So the angle is
   *    `-ln(1 - s)`: the shard turns faster and faster the further in it gets,
   *    and its last half-metre is a blur. That divergence is the read.
   *  - the winding rate carries `reach^-0.5`, so a shard thrown closer laps one
   *    thrown wide. Differential rotation is what makes a debris field look
   *    like it is in orbit rather than on a turntable.
   *
   * Before that, `outQuint` over the first fifth of the shard's life throws it
   * *clear* of the middle, because these are ejecta first and satellites
   * second.
   */
  _updateShards(scale) {
    const c = settings.astral;
    const g = settings.global;
    const spread = Math.max(0.05, c.shardSpread);
    const horizon = this._horizonRadius();
    this._corePoint(_core);

    const used = [0, 0];

    for (let i = 0; i < this.shards.length; i++) {
      const shard = this.shards[i];
      const variant = i % SHARD_VARIANTS;
      const slot = (i / SHARD_VARIANTS) | 0;

      const delay = shard.delay * c.shardStagger;
      const life = Math.max(0.15, shard.life * c.shardLife);
      const s = (this._bloomTime - c.coreSwell - delay) / life;

      // Not thrown yet, already gone, or the hole is closing and taking the
      // whole field with it.
      if (s < 0 || s >= 1 || scale <= 0.01) {
        _node.position.set(0, -999, 0);
        _node.quaternion.identity();
        _node.scale.setScalar(0.0001);
        _node.updateMatrix();
        this.shardMeshes[variant].setMatrixAt(slot, _node.matrix);
        this.shardHeat[variant].array[slot] = 0;
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      const reach = this.radius * spread * shard.reach;
      // Out fast, then the long fall in.
      const thrown = Easing.outQuint(saturate(s / 0.2));
      const infall = Math.pow(1 - s, 2 / 3);
      const r = Math.max(horizon * 0.35, reach * thrown * infall);

      // The winding. It diverges as the shard arrives, which is the point.
      const wind =
        c.shardOrbit * shard.sense * Math.pow(Math.max(reach, 0.3), -0.5) *
        -Math.log(Math.max(1 - s, 0.02));
      const bearing = shard.bearing + wind;

      _node.position.set(
        _core.x + Math.cos(bearing) * r,
        _core.y + shard.lift * reach * c.shardLoft * thrown * infall,
        _core.z + Math.sin(bearing) * r
      );

      // Tumbling, and winding up with everything else: an object being torn in
      // is not turning at the rate it was thrown at.
      const spin = c.shardTumble * (1 + (1 - infall) * 3.5) * g.noiseSpeed;
      const turn = shard.phase + this._bloomTime * spin;
      _node.rotation.set(
        shard.tumbleX * turn,
        shard.tumbleY * turn * 1.31,
        shard.tumbleZ * turn * 0.77
      );

      // Crushed rather than faded: a shard does not dissolve on approach, it
      // goes over the horizon and stops existing.
      const crush = 1 - Easing.inQuad(saturate((s - c.shardCrush) / Math.max(0.02, 1 - c.shardCrush)));
      const size = c.shardSize * shard.size * g.randomness * crush * scale;
      _node.scale.set(size * shard.aspect, size, size * shard.aspect * 0.85);
      _node.updateMatrix();

      this.shardMeshes[variant].setMatrixAt(slot, _node.matrix);
      // How deep in the well it is — the material reads this as strain, and it
      // is what lights the veins and finally whites the shard out.
      this.shardHeat[variant].array[slot] = saturate(1 - (r - horizon) / Math.max(0.5, reach * 0.7));
      used[variant] = Math.max(used[variant], slot + 1);
    }

    for (let v = 0; v < SHARD_VARIANTS; v++) {
      this.shardMeshes[v].count = used[v];
      this.shardMeshes[v].instanceMatrix.needsUpdate = true;
      this.shardHeat[v].needsUpdate = true;
    }
  }

  /* ------------------------------------------------------------------ */
  /* The grip                                                            */
  /* ------------------------------------------------------------------ */

  /** Which slot has hold of this body, if any. */
  _gripOf(dummy) {
    for (let i = 0; i < this._gripCount; i++) {
      if (this._grips[i].dummy === dummy) return this._grips[i];
    }
    return null;
  }

  /** Drop a slot without disturbing the order of the ones still live. */
  _dropGrip(index) {
    const last = this._gripCount - 1;
    const slot = this._grips[index];
    this._grips[index] = this._grips[last];
    this._grips[last] = slot;
    slot.dummy?.release();
    slot.dummy = null;
    slot.time = 0;
    slot.eaten = 0;
    slot.marked = false;
    this._gripCount = last;
  }

  /** Let go of everything. Whatever is left falls wherever it has got to. */
  _releaseGrips() {
    for (let i = 0; i < this._gripCount; i++) {
      this._grips[i].dummy?.release();
      this._grips[i].dummy = null;
      this._grips[i].time = 0;
      this._grips[i].eaten = 0;
      this._grips[i].marked = false;
    }
    this._gripCount = 0;
  }

  /**
   * Take hold of anything inside the reach that is not already held.
   *
   * Polled every frame rather than resolved once at the blast, because the hole
   * *moves* bodies: one thrown across the boundary by another cast has to be
   * caught on the frame it crosses, not ignored for the rest of the hole's life.
   *
   * A body still on its feet is knocked down first, and knocked **inward** —
   * the one detail that says gravity. Everything else on this stage throws
   * bodies away from the impact; a corpse that flew outward from a black hole
   * would undo the read before the gas even reached it.
   */
  _capture() {
    const field = this.ctx.dummies;
    if (!field?.findBodies) return;

    const c = settings.astral;
    const gc = c.grip;
    this._corePoint(_core);

    const found = field.findBodies(_core.x, _core.z, this.pullRadius, this._found);

    this._force.impulse = gc.impulse;
    this._force.lift = gc.lift;
    this._force.spin = gc.spin;

    for (const dummy of found) {
      if (this._gripCount >= MAX_GRIPS) break;
      if (this._gripOf(dummy)) continue;

      if (dummy.alive) {
        const at = dummy.position;
        _dir.set(_core.x - at.x, 0, _core.z - at.z);
        // A body standing exactly under the hole has no direction to be pulled
        // in, so it takes the cast's own.
        if (_dir.lengthSq() < 1e-6) _dir.copy(this.direction);
        else _dir.normalize();
        if (!dummy.kill(_dir.x, _dir.z, this._force)) continue;
      } else if (!dummy.bodyPoint(_at)) {
        // Down, but with no solver to take hold of — nothing to pull.
        continue;
      }

      const slot = this._grips[this._gripCount++];
      slot.dummy = dummy;
      slot.time = 0;
      slot.eaten = 0;
      slot.marked = false;
    }
  }

  /**
   * The velocity of the void at one point, in world space.
   *
   * Sampled once per joint of every body the hole is holding, so it reads its
   * state out of `_flow` rather than taking it, and allocates nothing.
   *
   * Three terms, and each of them is doing a specific job:
   *
   *  - **the pull**, toward the middle in three dimensions, as
   *    `well² / (d² + well²)` — an inverse square *softened* at a radius rather
   *    than a bare 1/r². Both halves of that matter. A bare inverse square is
   *    singular at the middle, so two joints either side of it get opposite
   *    velocities of unbounded size, the bones between them cannot absorb the
   *    difference, and the body shivers apart instead of falling in. And
   *    referencing the falloff to the *horizon* rather than to a well radius
   *    would leave a body four metres out being tugged at two percent of the
   *    peak, which is a hole that only eats what is already inside it.
   *    Softened, the differential across one body is still large — the near
   *    shoulder is pulled measurably harder than the far one — and *that* is
   *    the stretch. It is the closest this solver comes to spaghettification,
   *    and it falls out of the field rather than out of an animation.
   *  - **the swirl**, tangential about the vertical through the hole. Solid
   *    body inside the horizon, falling off outside it, for the same reason.
   *  - **the tumble**, the body's own rotation about its own centre, as a
   *    proper omega x r. A rigid rotation satisfies every distance constraint
   *    in the solver exactly, so the projection pass leaves it alone and the
   *    body keeps turning; put the same energy in as a shear instead and the
   *    constraints quietly eat it within two frames.
   *
   * @param {number} x world-space point
   * @param {number} y
   * @param {number} z
   * @param {import('three').Vector3} out written in place
   */
  _sampleFlow(x, y, z, out) {
    const f = this._flow;

    const dx = f.cx - x;
    const dy = f.cy - y;
    const dz = f.cz - z;
    const distance = Math.max(1e-3, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const core = Math.max(0.35, f.core);
    const well = Math.max(0.5, f.well);
    const pull = (f.pull * well * well) / (distance * distance + well * well);

    // Tangential, about the vertical axis through the hole.
    const rx = x - f.cx;
    const rz = z - f.cz;
    const flat = Math.max(1e-3, Math.hypot(rx, rz));
    const swirl =
      f.swirl * (flat < core ? flat / core : Math.pow(core / flat, SWIRL_FALLOFF));

    // The body's own turn: omega x r, about its own centre.
    const px = x - f.sx;
    const py = y - f.sy;
    const pz = z - f.sz;
    const spinX = f.wy * pz - f.wz * py;
    const spinY = f.wz * px - f.wx * pz;
    const spinZ = f.wx * py - f.wy * px;

    out.set(
      (dx / distance) * pull - (rz / flat) * swirl + spinX,
      (dy / distance) * pull + spinY,
      (dz / distance) * pull + (rx / flat) * swirl + spinZ
    );
  }

  /**
   * Wind everything this hole is holding into it, and take it apart.
   *
   * The current is a **velocity the body is dragged toward**, not a force
   * applied to it, and that is a correctness decision before it is an artistic
   * one: the solver consumes a bounded number of substeps per frame, so a
   * per-frame acceleration accumulates velocity the positions cannot follow and
   * on a slow frame the body leaves the map. Steering toward a target velocity
   * is unconditionally stable at any frame rate.
   *
   * The **weight** is a separate problem and needs a separate answer. Gravity is
   * integrated once per substep while this arrives once per frame, so a
   * velocity match strong enough to lift a corpse at sixty frames throws it off
   * the stage at six. `Dummy#carry` takes a buoyancy for exactly this: the well
   * carries the body's weight where the weight is applied, and the field is
   * left to do what it is good at, which is everything else.
   *
   * @param {number} dt
   * @param {number} hold how much of the hole there is, 0..1
   */
  _drag(dt, hold) {
    if (dt <= 0 || hold <= 0.001) return;

    const c = settings.astral;
    const gc = c.grip;
    const reach = this.pullRadius;
    const horizon = this._horizonRadius();
    this._corePoint(_core);

    // How much of the gap between the body and the void is closed this frame.
    // Clamped through saturate, so it can never exceed 1 whatever dt is.
    const grab = saturate(gc.grab * dt);

    const f = this._flow;
    f.cx = _core.x;
    f.cy = _core.y;
    f.cz = _core.z;
    // The swirl turns as one body inside the horizon — the one place a
    // singular field would tear a corpse in half.
    f.core = horizon;
    // ... and the pull is referenced to the *zone*, not to the horizon, so a
    // body standing on the boundary is actually taken.
    f.well = Math.max(0.5, this.radius * gc.well);

    for (let i = this._gripCount - 1; i >= 0; i--) {
      const slot = this._grips[i];
      const dummy = slot.dummy;

      if (!dummy || dummy.finished) {
        this._dropGrip(i);
        continue;
      }
      const at = dummy.bodyPoint(_at);
      if (!at) {
        this._dropGrip(i);
        continue;
      }

      slot.time += dt;

      const dx = _core.x - at.x;
      const dy = _core.y - at.y;
      const dz = _core.z - at.z;
      const distance = Math.max(1e-3, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const closeness = 1 - saturate(distance / reach);

      // How much of the void is on this body yet. Eased in, because a body that
      // snaps to the current on the frame it is caught reads as one that was
      // dropped onto a turntable.
      const wound = Easing.outCubic(saturate(slot.time / Math.max(0.05, gc.windUp))) * hold;

      f.sx = at.x;
      f.sy = at.y;
      f.sz = at.z;
      f.pull = gc.pull * wound;
      f.swirl = gc.swirl * wound;

      // The tumble: a yaw about its own vertical, plus a cartwheel about the
      // axis it is travelling round on. Both wind up as it closes, which is the
      // beat that says the middle of this thing is where you do not want to be.
      const rate = TAU * wound * (0.4 + closeness * 1.6);
      const tx = -(at.z - _core.z);
      const tz = at.x - _core.x;
      const tl = Math.max(1e-3, Math.hypot(tx, tz));
      f.wx = (tx / tl) * gc.cartwheel * rate;
      f.wy = gc.tumble * rate;
      f.wz = (tz / tl) * gc.cartwheel * rate;

      // The well takes the weight, so the body leaves the stone. It has to: the
      // solver scrubs the slide off any joint touching the floor, and a corpse
      // lying on it will not turn however hard it is pulled.
      const buoyancy = saturate(gc.buoy * wound * (0.35 + closeness * 0.9));
      dummy.carry(this._field, grab * wound, grab * wound, buoyancy);

      /* ---- and then it is taken apart ---- */
      // Gated on being *inside* the horizon rather than on a clock, so going
      // is the end of the spiral rather than something that happened along the
      // way. `late` is the failsafe: a body the pull cannot reach — one wedged
      // against the far wall, a `pull` turned down to nothing in the editor —
      // is taken where it lies rather than orbiting forever.
      const mouth = Math.max(0.3, horizon * gc.swallow);
      const bite = saturate((mouth - distance) / Math.max(0.25, mouth * 0.8));
      const late = saturate((slot.time - gc.windUp - gc.spiral) / 1.2);
      const eating = Math.max(bite, late) * hold;

      if (eating > 0.001) {
        slot.eaten = Math.min(1, slot.eaten + eating * gc.devour * dt);
        dummy.consume(slot.eaten);

        if (!slot.marked && slot.eaten > 0.04) {
          slot.marked = true;
          this._swallowFx(at);
        }
      }

      if (slot.eaten >= 1) {
        this._consumedFx(at);
        this._dropGrip(i);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Effects                                                             */
  /* ------------------------------------------------------------------ */

  /** The seed being drawn together at the caster's hand. */
  _muzzleFx() {
    const c = settings.astral;
    const g = settings.global;
    const time = frame.uTime.value;

    this._handPoint(_pos);

    _emit.position = _pos;
    _emit.radius = 0.5;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.emberSpeed * 0.5;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    // Orbiting the hand and collapsing onto it: the singularity is *gathered*
    // before it is thrown, which is the only way the throw reads as a release.
    _emit.anchor = _pos;
    _emit.size = c.starSize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.starLifetime * 0.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.stardust.emit(Math.round(70 * g.particleCount), _emit);

    _emit.anchor = null;
    _emit.radius = 0.16;
    _emit.speed = c.emberSpeed * 1.4;
    _emit.size = c.emberSize;
    _emit.life = c.emberLifetime * 0.5;
    this.embers.emit(Math.round(24 * g.particleCount), _emit);
  }

  /**
   * The seed on its way.
   *
   * Paid out per *metre travelled* rather than per second, so the trail has the
   * same density whatever `speed` is dragged to — a marks-per-second trail
   * thins out to nothing the moment the cast gets fast.
   */
  _travelFx(dt) {
    const c = settings.astral;
    const g = settings.global;
    const time = frame.uTime.value;

    this._corePoint(_pos);

    const stars = this.trailEmitter.tick(dt, c.trailStars * this.config.speed * 0.02);
    if (stars > 0) {
      _emit.position = _pos;
      _emit.radius = 0.34;
      // Dragged along behind: the trail is matter the seed has already passed
      // and is still pulling on, so it leans backward down the line.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.65).setY(0.35).normalize();
      _emit.speed = c.emberSpeed * 0.6;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.7;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.starSize * 0.85;
      _emit.sizeVariance = 0.8;
      _emit.life = c.starLifetime * 0.45;
      _emit.lifeVariance = 0.6;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.stardust.emit(stars, _emit);

      _emit.size = c.emberSize * 0.8;
      _emit.speed = c.emberSpeed * 0.9;
      _emit.life = c.emberLifetime * 0.35;
      this.embers.emit(Math.max(1, Math.round(stars * 0.4)), _emit);
    }

    // The mark the seed drags across the floor beneath it, laid down by
    // distance for the same reason.
    const travelled = this.u * this.length;
    if (travelled - this._markDistance < 1.4) return;
    this._markDistance = travelled;

    _pos.y = 0;
    this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
      radius: randRange(0.5, 0.85),
      life: 1.8,
      intensity: 0.35,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorNebulaEdge),
      height: 0.014
    });
  }

  /**
   * The collapse — the frame the ability actually goes off.
   *
   * Everything here fires once, at the bottom of the pinch, because the whole
   * first beat of this ability is that the blast is *caused* by the core
   * imploding rather than by the cast landing.
   */
  _blastFx() {
    const c = settings.astral;
    const g = settings.global;
    const time = frame.uTime.value;

    this._corePoint(_core);
    const radius = this.radius;

    /* the ring that snaps out across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _core, {
      radius: c.shockRadius * g.explosionIntensity * 0.85,
      life: 0.85,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockHot),
      colorB: getColor(c.colorShockBody)
    });

    /* and the mark it leaves under the hole. Muted on purpose: this decal runs
       its second colour hot for the first part of its life, and a saturated
       stop there throws a bright star across a floor that is meant to look
       burnt rather than lit. */
    this.ctx.decals.spawn(DecalType.SCORCH, _core, {
      radius: c.scorchRadius,
      life: c.scorchLife,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorScorchEmber),
      height: 0.012
    });

    this.ctx.decals.spawn(DecalType.DUSTRING, _core, {
      radius: c.scorchRadius * 1.35,
      life: 3.4,
      intensity: 0.5,
      colorA: getColor(c.colorDustB),
      colorB: getColor(c.colorDustC),
      height: 0.016
    });

    /* the gold thrown out of the middle */
    _emit.radius = 0.35;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.sizeVariance = 0.8;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;

    const ejecta = Math.round(c.blastEmbers * g.particleCount);
    const perBatch = Math.max(1, Math.ceil(ejecta / EJECTA_BATCHES));
    for (let n = 0; n < ejecta; n += perBatch) {
      // Thrown along the equator with a little scatter, so the ejecta arrives
      // in the plane the gas is already in rather than as a ball.
      const a = Math.random() * TAU;
      _emit.position = _core;
      _emit.direction = _dir.set(Math.cos(a), randRange(-0.35, 0.35), Math.sin(a)).normalize();
      _emit.speed = c.emberSpeed * 3.4 * g.explosionIntensity;
      _emit.size = c.emberSize * 1.35;
      _emit.life = c.emberLifetime * 1.3;
      this.embers.emit(Math.min(perBatch, ejecta - n), _emit);
    }

    /* the floor coming with it */
    _emit.position = _pos.set(_core.x, 0.1, _core.z);
    _emit.radius = radius * 0.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.chipSpeed * g.explosionIntensity;
    _emit.spread = 0.85;
    _emit.size = c.chipSize * 1.3;
    _emit.life = c.chipLifetime * 1.2;
    this.chips.emit(Math.round(c.blastChips * g.particleCount), _emit);

    _emit.radius = radius * 0.7;
    _emit.speed = c.dustSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = c.dustSize * 1.2;
    _emit.life = c.dustLifetime * 1.15;
    _emit.spin = 0.35;
    this.dust.emit(Math.round(c.blastDust * g.particleCount), _emit);
    _emit.spin = 0;

    /* the stars, born on a shell and already falling in */
    this._emitStars(Math.round(c.blastStars * g.particleCount), 1.0);

    this.ctx.shake.add(
      c.blastShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.blastFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.3 * g.explosionIntensity;
  }

  /**
   * Stars born on a shell around the hole and immediately in orbit.
   *
   * The anchor is the middle and the emission point is out on the shell, which
   * is what the swirl path reads as the orbit to collapse: with a negative
   * expansion the offset between the two shrinks to nothing over the star's own
   * lifetime, so it arrives at the hole exactly as it dies. No CPU work per
   * frame, no per-particle bookkeeping, and it is a genuine spiral rather than
   * a fade toward a point.
   */
  _emitStars(count, spread) {
    if (count <= 0) return;
    const c = settings.astral;
    const time = frame.uTime.value;

    this._corePoint(_core);
    const shell = this.radius * c.starShell * spread;

    _emit.anchor = _core;
    _emit.radius = shell * 0.22;
    _emit.direction = _dir.set(0, 1, 0);
    // Weightless and speedless: everything these do is the orbit.
    _emit.speed = 0;
    _emit.speedVariance = 0;
    _emit.spread = 0;
    _emit.inherit = null;
    _emit.size = c.starSize;
    _emit.sizeVariance = 0.85;
    _emit.life = c.starLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;

    // Split between bearings, or a whole frame's worth of stars is one clump
    // going round together.
    const perBatch = Math.max(1, Math.ceil(count / 6));
    for (let n = 0; n < count; n += perBatch) {
      const a = Math.random() * TAU;
      const r = shell * randRange(0.55, 1.0);
      // Flattened toward the disc, like everything else here.
      _pos.set(
        _core.x + Math.cos(a) * r,
        _core.y + randRange(-1, 1) * shell * c.starLoft,
        _core.z + Math.sin(a) * r
      );
      _emit.position = _pos;
      this.stardust.emit(Math.min(perBatch, count - n), _emit);
    }
    _emit.anchor = null;
  }

  /** Everything the standing hole keeps throwing. */
  _holdFx(dt, scale) {
    if (scale <= 0.001) return;

    const c = settings.astral;
    const g = settings.global;
    const time = frame.uTime.value;
    const surge = 1 + this._churn * c.churnDepth;

    this._corePoint(_core);

    /* --- the infall --- */
    const stars = this.starEmitter.tick(dt, c.starRate * scale * surge * g.particleCount);
    this._emitStars(stars, 1.0);

    /* --- gold torn off the disc --- */
    const embers = this.emberEmitter.tick(dt, c.emberRate * scale * surge * g.particleCount);
    if (embers > 0) {
      const a = Math.random() * TAU;
      const r = this.radius * c.starShell * randRange(0.25, 0.7);
      _pos.set(
        _core.x + Math.cos(a) * r,
        _core.y + randRange(-0.4, 0.4) * r,
        _core.z + Math.sin(a) * r
      );
      _emit.position = _pos;
      _emit.radius = 0.25;
      // Tangential: this is matter being flung off something that is turning.
      _emit.direction = _dir.set(-Math.sin(a) * 0.95, randRange(-0.2, 0.5), Math.cos(a) * 0.95).normalize();
      _emit.speed = c.emberSpeed * surge;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.emberSize;
      _emit.sizeVariance = 0.75;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(embers, _emit);
    }

    /* --- and the floor being lifted at the wavefront --- */
    // Emitted where the wave actually is, not at the middle: this is stone the
    // shock is picking up as it passes, and it has to arrive at the same metre
    // the crest is standing on.
    const front = this._shockFront;
    const reach = Math.max(0.5, c.shockRadius * g.explosionIntensity);
    if (front > 0.2 && front < reach) {
      const wave = 1 - saturate(front / reach);
      const dust = this.dustEmitter.tick(dt, c.dustRate * wave * g.particleCount);
      if (dust > 0) {
        const a = Math.random() * TAU;
        _pos.set(_core.x + Math.cos(a) * front, 0.15, _core.z + Math.sin(a) * front);
        _emit.position = _pos;
        _emit.radius = c.shockWidth * 1.6;
        _emit.direction = _dir.set(Math.cos(a) * 0.65, 1, Math.sin(a) * 0.65).normalize();
        _emit.speed = c.dustSpeed;
        _emit.speedVariance = 0.7;
        _emit.spread = 0.75;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = c.dustSize;
        _emit.sizeVariance = 0.6;
        _emit.life = c.dustLifetime;
        _emit.lifeVariance = 0.45;
        _emit.spin = 0.3;
        _emit.tint = null;
        _emit.time = time;
        this.dust.emit(dust, _emit);
        _emit.spin = 0;
      }

      const chips = this.chipEmitter.tick(dt, c.chipRate * wave * g.particleCount);
      if (chips > 0) {
        const a = Math.random() * TAU;
        _pos.set(_core.x + Math.cos(a) * front, 0.1, _core.z + Math.sin(a) * front);
        _emit.position = _pos;
        _emit.radius = c.shockWidth;
        _emit.direction = _dir.set(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5).normalize();
        _emit.speed = c.chipSpeed * 0.7;
        _emit.speedVariance = 0.8;
        _emit.spread = 0.6;
        _emit.size = c.chipSize;
        _emit.sizeVariance = 0.7;
        _emit.life = c.chipLifetime;
        _emit.lifeVariance = 0.5;
        _emit.time = time;
        this.chips.emit(chips, _emit);
      }
    }
  }

  /** The hole feeding: a throw of gold, a knock, and a punch of light. */
  _flareFx(scale) {
    const c = settings.astral;
    const g = settings.global;
    const time = frame.uTime.value;

    this._corePoint(_core);

    const count = Math.round(c.flareEmbers * scale * g.particleCount);
    if (count > 0) {
      const a = Math.random() * TAU;
      _emit.position = _core;
      _emit.radius = this._horizonRadius() * 1.4;
      // Along the equator, hard: a flare is the innermost gas going in and
      // throwing a jet of it back out along the plane it came from.
      _emit.direction = _dir.set(Math.cos(a), randRange(-0.25, 0.25), Math.sin(a)).normalize();
      _emit.speed = c.emberSpeed * 2.2;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.45;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.emberSize * 1.2;
      _emit.sizeVariance = 0.8;
      _emit.life = c.emberLifetime * 1.1;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(count, _emit);
    }

    this._emitStars(Math.round(c.flareStars * scale * g.particleCount), 1.15);

    this.ctx.shake.add(c.flareShake * scale * g.explosionIntensity, 3.0, 22);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.22 * scale);
  }

  /**
   * A body crossing the horizon.
   *
   * The most important beat in the ability, and the reason the grip bothers to
   * track which bodies it has started on: something being taken apart has to
   * *make the hole react*. Nothing here is ambient — every one of these is
   * fired at a point, once, because a body arrived at it.
   */
  _swallowFx(at) {
    const c = settings.astral;
    const g = settings.global;
    const gc = c.grip;
    const time = frame.uTime.value;

    _pos.copy(at);

    _emit.position = _pos;
    _emit.radius = 0.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.emberSpeed * 1.5;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.emberSize * 1.1;
    _emit.sizeVariance = 0.8;
    _emit.life = c.emberLifetime * 0.9;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(Math.round(gc.swallowEmbers * g.particleCount), _emit);

    // Stars torn off the body itself, joining the infall it is already in.
    this._corePoint(_core);
    _emit.anchor = _core;
    _emit.radius = 0.45;
    _emit.speed = 0;
    _emit.speedVariance = 0;
    _emit.spread = 0;
    _emit.size = c.starSize * 1.1;
    _emit.life = c.starLifetime * 0.8;
    this.stardust.emit(Math.round(gc.swallowStars * g.particleCount), _emit);
    _emit.anchor = null;

    this.ctx.shake.add(gc.swallowShake * g.explosionIntensity * g.cameraShake, 3.4, 24);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.3);
  }

  /**
   * And the flare when there is nothing left of it.
   *
   * The hole is what reacts, not the spot the body was last at: whatever was
   * there has gone *into* the middle, so the light, the knock and the jet of
   * gold all come out of the middle. The last of the body is the one thing
   * thrown from where it actually was.
   */
  _consumedFx(at) {
    const c = settings.astral;
    const g = settings.global;
    const time = frame.uTime.value;

    this._corePoint(_core);

    _emit.position = _pos.copy(at);
    _emit.anchor = _core;
    _emit.radius = 0.3;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 0;
    _emit.speedVariance = 0;
    _emit.spread = 0;
    _emit.inherit = null;
    _emit.size = c.starSize * 1.3;
    _emit.sizeVariance = 0.7;
    _emit.life = c.starLifetime * 0.6;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.stardust.emit(Math.round(c.grip.swallowStars * 0.8 * g.particleCount), _emit);
    _emit.anchor = null;

    this.ctx.flash.trigger(getColor(c.colorFlash), c.blastFlash * 0.35 * g.explosionIntensity);
    this.ctx.shake.add(c.grip.swallowShake * 1.6 * g.explosionIntensity * g.cameraShake, 3.0, 20);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.55);
    this._flareFx(1.15);
  }

  /**
   * Step the flare envelope, and feed if this frame is the one that crossed.
   *
   * Advanced before anything reads it, so the frame a flare lands on is the
   * frame every material, the light and the emitters see it on.
   */
  _advanceChurn(dt, fade, dry) {
    const c = settings.astral;

    this._churnPhase += dt * Math.max(0, c.churnRate);
    const shaped = Math.pow(flareEnvelope(this._churnPhase), Math.max(0.05, c.churnSharp));

    // Crossing on the way *up* only: a flare is the moment the hole feeds, not
    // every frame it happens to be bright.
    if (this._churnRaw < c.flareThreshold && shaped >= c.flareThreshold && dry < 0.7 && dt > 0) {
      this._flareFx(fade);
    }

    this._churnRaw = shaped;
    // A closing hole stops flaring but does not stop being modulated — it just
    // does it more and more weakly.
    this._churn = shaped * (1 - dry * 0.7);
  }

  /** Turn the hole and push the wavefront. Both integrate, so both are live. */
  _advanceClocks(dt) {
    const c = settings.astral;
    const g = settings.global;

    this._beamPhase += c.ringSpin * TAU * (1 + this._churn * 0.35) * g.noiseSpeed * dt;
    if (this._blasted) {
      this._shockFront += c.shockSpeed * g.explosionIntensity * dt;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._advanceClocks(dt);
    this._sync(1, 0);

    // The camera frames the seed, and the light rides inside it.
    this._corePoint(this.position);

    this._travelFx(dt);
    this.ctx.shake.rumble(settings.astral.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.astral;
    const g = settings.global;
    const time = frame.uTime.value;

    this._bloomTime = 0;
    this._blasted = false;
    this._shockFront = 0;

    this._corePoint(_core);

    // The arrival is an *implosion*, not an explosion: matter rushing inward,
    // a shove of air, and nothing else. Everything loud waits for the collapse.
    _emit.position = _core;
    _emit.radius = this.radius * 0.95;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 0;
    _emit.speedVariance = 0;
    _emit.spread = 0;
    _emit.inherit = null;
    _emit.anchor = _core;
    _emit.size = c.starSize * 1.2;
    _emit.sizeVariance = 0.8;
    // Short lives, so the whole inrush arrives at the middle exactly as the
    // core snaps shut.
    _emit.life = Math.max(0.12, c.coreSwell + c.corePinch);
    _emit.lifeVariance = 0.25;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.stardust.emit(Math.round(c.implodeStars * g.particleCount), _emit);
    _emit.anchor = null;

    this.ctx.shake.add(c.implodeShake * g.explosionIntensity * g.cameraShake, 4.5, 16);
    this.lightBoost = c.lightIntensity * 0.35 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.astral;
    this._bloomTime += dt;

    // `t` runs 0..1 while the hole stands, then 1..2 while it closes.
    const dry = t <= 1 ? 0 : saturate(t - 1);
    const fade = 1 - Easing.inQuad(dry);
    // The hole shrinks to a point rather than fading out where it hangs. It is
    // the only honest way for one of these to leave.
    this._shrink = 1 - Easing.inCubic(dry);

    // The collapse: the one frame this ability actually goes off on.
    if (!this._blasted && this._bloomTime >= c.coreSwell + c.corePinch * 0.55) {
      this._blasted = true;
      this._blastFx();
    }

    this._advanceChurn(dt, fade, dry);
    this._advanceClocks(dt);
    this._sync(fade, dry);
    this._updateShards(fade);

    // Still fishing while the hole is live: a body knocked into the reach by
    // something else is caught the frame it crosses.
    if (this._blasted && dry < 0.6) this._capture();
    this._drag(dt, this._blasted ? fade : 0);

    // The camera frames the hole, and the light sits inside it.
    this._corePoint(this.position);

    this._holdFx(dt, fade * (t <= 1 ? 1 : 0.4));
    this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);

    // The last frame: the hole closes on itself and takes the light with it.
    if (dry > 0.985 && !this._closed) {
      this._closed = true;
      this.ctx.flash.trigger(getColor(c.colorCollapseFlash), c.collapseFlash);
      this.ctx.shake.add(
        c.collapseShake * settings.global.explosionIntensity * settings.global.cameraShake,
        5.0,
        26
      );
    }
  }

  onDestroy() {
    this._releaseGrips();
    this._closed = false;
    this._shrink = 1;
    this.horizon.visible = false;
    this.lens.visible = false;
    this.nebula.visible = false;
    this.ring.visible = false;
    this.warp.visible = false;
    for (const mesh of this.shardMeshes) mesh.count = 0;
    this.horizonMaterial.uniforms.uFade.value = 0;
    this.nebulaMaterial.uniforms.uFade.value = 0;
    this.ringMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    this.horizonGeometry.dispose();
    this.lensGeometry.dispose();
    this.nebulaGeometry.dispose();
    this.ringGeometry.dispose();
    for (const mesh of this.shardMeshes) mesh.geometry.dispose();
    this.horizonMaterial.dispose();
    this.lensMaterial.dispose();
    this.nebulaMaterial.dispose();
    this.ringMaterial.dispose();
    this.warpMaterial.dispose();
    this.shardMaterial.dispose();
    super.dispose();
  }
}
