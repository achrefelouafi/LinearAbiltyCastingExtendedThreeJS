import { Mesh, PlaneGeometry, CylinderGeometry, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createInkPoolMaterial, createInkRefractionMaterial } from '../materials/InkPoolMaterial.js';
import { createInkCrownMaterial, createInkColumnMaterial } from '../materials/InkCrownMaterial.js';
import { createInkVolumeMaterial } from '../materials/InkVolumeMaterial.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing, randRange } from '../utils/math.js';

const TAU = Math.PI * 2;

/** Tessellation of the crown. High around, because the scallops live there. */
const CROWN_SEGMENTS = 192;
const CROWN_RINGS = 22;
/** ... and of the jet, which is narrow and does most of its shaping up its length. */
const COLUMN_SEGMENTS = 72;
const COLUMN_RINGS = 28;

/** Radial segments on the volume's proxy cylinder. */
const VOLUME_SEGMENTS = 48;
/**
 * A regular polygon *inscribes* its circle, so a proxy scaled to the analytic
 * radius cuts the corners off the volume it is supposed to find — and a marched
 * cloud with flats on its silhouette is the one tell you cannot explain away.
 * Scaling by the reciprocal of the inradius circumscribes it instead.
 */
const VOLUME_CIRCUMSCRIBE = 1 / Math.cos(Math.PI / VOLUME_SEGMENTS);

/** How many bodies one tide can have hold of at once. */
const MAX_GRIPS = 16;

/**
 * How the tangential current falls away outside the throat, as an exponent on
 * `core / distance`.
 *
 * A real free vortex is 1 — and at 1 the swirl out at the boundary is a third
 * of the inward pull, so a body caught on the rim arrives at the middle on what
 * is very nearly a straight line. Slackening it keeps the two comparable the
 * whole way in, which is the difference between something being wound in and
 * something going down a drain.
 */
const SWIRL_FALLOFF = 0.6;

/**
 * Ceiling on the centrifugal correction, metres/second — see `_sampleFlow`.
 *
 * The correction is bounded on its own at the settings this ships with, and
 * this is here for the ones it does not: the editor can put the swirl at twenty
 * metres a second and the grab at a tenth, and the product of those two is a
 * body leaving the stage on the frame the water reaches it.
 */
const MAX_CENTRIFUGE = 14;

/** How many points one frame's droplets are split between. One origin reads as a hose. */
const RIM_BATCHES = 5;

const _emit = {};
const _pos = new Vector3();
const _at = new Vector3();
const _centre = new Vector3();
const _dir = new Vector3();

/**
 * The swell, 0..1 — the envelope every pass of this ability is driven off.
 *
 * Two sines at incommensurate frequencies (1 and φ). Their sum has no period,
 * so within the five seconds a tide stands it never lands twice on the same
 * rhythm. Deliberately *smoother* than the Caustic Bloom's boil, which is a sum
 * of three raised to a power: a chemical reaction spikes and vents, water
 * heaves. Sharpening this envelope is the fastest way to make the tide read as
 * a pulsing light instead of as a mass of moving liquid.
 */
function swellEnvelope(t) {
  const a = Math.sin(t);
  const b = Math.sin(t * 1.6180339887 + 1.7);
  return saturate(((a + b * 0.8) / 1.8) * 0.5 + 0.5);
}

/**
 * INK — the Sumi Tide, and the only ability in the set that takes hold of what
 * it catches instead of hitting it.
 *
 * A loaded brush stroke runs across the floor to the aimed circle. Where it
 * lands, paper soaks into the stone, black ink floods it, a wall of water
 * stands up around the boundary and a jet of ink goes up the middle. Then the
 * jet falls back, a throat opens in the centre, and everything standing in the
 * circle is wound around it and pulled under.
 *
 * Five passes, one per panel of the reference sheet — and four of them are the
 * *same surface*, because stacked as four decals they would sort against each
 * other and read as four things on a floor rather than as one painting:
 *
 *   1. **the expanding ink puddle** — a watercolour wash on paper, with
 *      dendritic wicking at its boundary, a stranded dark rim where the pigment
 *      dried, and granulation settling into the tooth;
 *   2. **the brush-stroke ripples** — rings drawn as strokes, loaded at the
 *      start and skipping off the tooth through the middle, launched by the
 *      swell rather than free-running;
 *   3. **the suspended ink wisps** — a raymarched volume that *absorbs* the
 *      frame, hollowed into a funnel and wound hardest nearest the axis;
 *   4. **the water surface distortion** — a refraction proxy lying on the floor
 *      that reads the same ripple field the surface is shaded with, so the warp
 *      and the highlights cannot drift apart;
 *   5. **the ink splatter** — teardrop flecks drawn out along their own bearing
 *      with satellites, thrown clear of the stroke and dried where they landed.
 *
 * **The swell is what makes those five things one thing.** `_swell` is
 * evaluated once per frame and handed to every material, the light, the
 * emitters and the camera: the pool breathes, the crown heaves, the ink veil
 * thickens, the vortex speeds up, spray comes faster — and when a swell crosses
 * `tideThreshold` on the way up, the tide *surges*: a ripple across the pool, a
 * throw of spray off the crown and a knock on the camera. Nothing here
 * free-runs on its own sine.
 *
 * **What happens to the bodies is the point.** This class answers
 * `handlesOwnHits`, so `DummyField` leaves it alone. Instead it asks
 * `findBodies` who is standing — or already lying — inside the circle, knocks
 * the living *inward* rather than outward, and then keeps hold of all of them.
 *
 * What it does to them from there is three beats, and they have to arrive in
 * this order or the ability reads as a hole in the floor: the water gets
 * *under* them and floats them on the surface; it winds them in — each body
 * spinning about its own axis while the vortex carries it round, both winding
 * up the nearer the middle it gets, and the whole spiral closing on the axis
 * over `spiral` seconds rather than settling on whatever ring the current
 * happens to balance at; and only once one has actually *arrived* does the
 * floor come out from under it (`Dummy#sink`) and take it down. They break the
 * surface one at a time, at the middle, each with its own splash, and the
 * stage's own opaque floor is what hides them.
 *
 * **The rule that makes the editor work.** A cast captures one number — a seed
 * — and a handful of clocks. Not one metre, radian or second is recorded: the
 * footprint, the wash, the crown, the jet, the volume and the grip are all
 * resolved against `settings.ink` inside the update loop, which runs on a
 * zero-length frame too. Drag `zoneRadius` while a tide is standing and the
 * whole thing — paper, ink, water, crown, vortex and the pull on the bodies —
 * re-scales around it.
 */
export class SumiTideAbility extends Ability {
  constructor(context) {
    super('ink', context);
  }

  /**
   * The tide picks its own, and holds them.
   *
   * `DummyField` would otherwise read the cast as a far-cast disc and fell
   * everything in it outward on the frame the front lands — which is the exact
   * opposite of what a whirlpool does to a body, and would throw them clear of
   * the thing that is supposed to be swallowing them.
   */
  get handlesOwnHits() {
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the painted floor ---- */
    this.poolGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.poolMaterial = createInkPoolMaterial();
    this.pool = new Mesh(this.poolGeometry, this.poolMaterial);
    this.pool.name = 'InkPool';
    this.pool.layers.set(LAYER.VFX);
    this.pool.renderOrder = 5; // under the marks, so stains land on top of it
    this.pool.frustumCulled = false;
    this.pool.visible = false;
    this.group.add(this.pool);

    /* ---- the water bending the frame ---- */
    this.warpGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.warpMaterial = createInkRefractionMaterial();
    this.warp = new Mesh(this.warpGeometry, this.warpMaterial);
    this.warp.name = 'InkRefraction';
    this.warp.layers.set(LAYER.DISTORTION);
    this.warp.frustumCulled = false;
    this.warp.visible = false;
    this.group.add(this.warp);

    /* ---- the wall of water at the boundary ---- */
    // A bare unit cylinder: every metre of the crown is built in the vertex
    // stage from live settings, so this buffer is never rebuilt and the mesh is
    // never scaled.
    this.crownGeometry = new CylinderGeometry(1, 1, 1, CROWN_SEGMENTS, CROWN_RINGS, true)
      .translate(0, 0.5, 0);
    this.crownMaterial = createInkCrownMaterial();
    this.crown = new Mesh(this.crownGeometry, this.crownMaterial);
    this.crown.name = 'InkCrown';
    this.crown.layers.set(LAYER.VFX);
    this.crown.renderOrder = 11;
    this.crown.frustumCulled = false;
    this.crown.visible = false;
    this.group.add(this.crown);

    /* ---- and the jet up the middle ---- */
    this.columnGeometry = new CylinderGeometry(1, 1, 1, COLUMN_SEGMENTS, COLUMN_RINGS, true)
      .translate(0, 0.5, 0);
    this.columnMaterial = createInkColumnMaterial();
    this.column = new Mesh(this.columnGeometry, this.columnMaterial);
    this.column.name = 'InkColumn';
    this.column.layers.set(LAYER.VFX);
    this.column.renderOrder = 12;
    this.column.frustumCulled = false;
    this.column.visible = false;
    this.group.add(this.column);

    /* ---- the ink hanging in the water ---- */
    // A *closed* unit cylinder drawn back faces only. It is a scissor and
    // nothing else: it exists to rasterise the pixels the volume could cover,
    // and the caps are there so looking straight down the column still fills the
    // middle of the screen.
    this.volumeGeometry = new CylinderGeometry(1, 1, 1, VOLUME_SEGMENTS, 1, false)
      .translate(0, 0.5, 0);
    this.volumeMaterial = createInkVolumeMaterial();
    this.volume = new Mesh(this.volumeGeometry, this.volumeMaterial);
    this.volume.name = 'InkVolume';
    this.volume.layers.set(LAYER.VFX);
    this.volume.renderOrder = 10;
    this.volume.frustumCulled = false;
    this.volume.visible = false;
    this.group.add(this.volume);

    /** Re-rolled per cast, so no two tides bleed the same way. */
    this._seed = 0;
    /** Seconds since the flood landed. Drives every clock below. */
    this._bloomTime = 0;
    /** Metres of stroke already paid out in ground marks. */
    this._markDistance = 0;
    /** Phase through the swell, and the envelope it produces. */
    this._swellPhase = 0;
    this._swellRaw = 0;
    this._swell = 0;
    /** Accumulated vortex rotation, radians — integrated so the rate is live. */
    this._spin = 0;
    /** Accumulated ring travel, in sweeps. Same reason. */
    this._ringClock = 0;

    /**
     * The bodies this tide has hold of.
     *
     * Pre-allocated and reused: a cast that catches six targets must not build
     * six objects, and `_gripCount` is how many of these slots are live rather
     * than how long the array is.
     */
    this._grips = [];
    for (let i = 0; i < MAX_GRIPS; i++) {
      // `reach` is how far out the tide found this one. It is the whole of the
      // wind-in schedule: the water is winding *this* body from *there* to the
      // middle, and a body caught on the rim has further to come than one
      // caught beside the throat.
      this._grips.push({ dummy: null, time: 0, reach: 0, under: false, depth: 0 });
    }
    this._gripCount = 0;
    /** Reused by `DummyField#findBodies`, so polling allocates nothing. */
    this._found = [];
    /** The blow that takes a body off its feet, refilled from settings each cast. */
    this._force = { impulse: 0, lift: 0, spin: 0 };
    /**
     * Everything `_sampleFlow` needs to answer *how fast is the water here*:
     * where the vortex is, how hard it is turning, and which body it is being
     * asked about. Refilled per body per frame rather than closed over, because
     * the sampler runs once per joint of every body the tide is holding and
     * neither it nor the loop around it is allowed to make garbage.
     */
    this._flow = {
      cx: 0, // the axis
      cz: 0,
      sx: 0, // the body's own centre, which it spins about
      sy: 0, // ... and rides at, which is not the same as where each joint is
      sz: 0,
      radius: 1,
      core: 1, // the solid-body middle — the throat, in metres
      flow: 0, // inward, m/s
      wx: 0, // the winch: one inward velocity for the whole body, m/s
      wz: 0,
      swirl: 0, // tangential at the edge of the core, m/s
      spin: 0, // the body's own turn, radians/second
      slip: 0, // seconds of lag in the grip — what the orbit has to be paid for
      ride: 0, // the height the water carries it at
      buoy: 0, // how hard it is held there
      rise: 0, // ... and the fastest it may be moved to get there
      lift: 0, // how much of that survives — none of it, once the throat has it
      sink: 0 // and how fast it is being taken down instead
    };
    /** Bound once: `Dummy#carry` is handed this for every body, every frame. */
    this._field = (x, y, z, out) => this._sampleFlow(x, y, z, out);

    // Scratch state handed to the materials each frame. One object apiece,
    // reused — syncing a standing tide allocates nothing.
    this._poolState = {
      radius: 1,
      quadSize: 1,
      spread: 0,
      open: 0,
      throat: 0,
      spin: 0,
      ringClock: 0,
      swell: 0,
      dry: 0,
      fade: 1,
      seed: 0
    };
    this._warpState = {
      radius: 1,
      quadSize: 1,
      open: 0,
      spin: 0,
      ringClock: 0,
      strength: 0,
      seed: 0
    };
    this._crownState = { radius: 1, height: 1, rise: 0, fall: 0, swell: 0, fade: 1, seed: 0 };
    this._columnState = { radius: 1, height: 1, rise: 0, swell: 0, fade: 1, seed: 0 };
    this._volumeState = {
      centre: new Vector3(),
      radius: 1,
      height: 1,
      swell: 0,
      drain: 0,
      fade: 1,
      seed: 0
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Water thrown off the crown. Non-additive and heavy: a droplet is a lens,
    // not a spark, and an additive one is a firefly with a blue tint on it.
    this.droplets = particles.get('ink.droplets', {
      capacity: 3000,
      shape: ParticleShape.DROPLET,
      additive: false,
      stretch: true,
      softFade: 0.25
    });
    this.droplets.uniforms.uDrag.value = 0.35;
    this.droplets.uniforms.uEndSize.value = 0.55;
    this.droplets.uniforms.uSizeIn.value = 0.04;
    this.droplets.uniforms.uFadeIn.value = 0.05;
    this.droplets.uniforms.uFadeOut.value = 0.65;

    // The fine spray that comes off a crest. Light enough to hang, so it is the
    // pass that actually reads at the top of the wall.
    this.spray = particles.get('ink.spray', {
      capacity: 3000,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.35
    });
    this.spray.uniforms.uDrag.value = 1.5;
    this.spray.uniforms.uEndSize.value = 0.45;
    this.spray.uniforms.uSizeIn.value = 0.06;
    this.spray.uniforms.uFadeIn.value = 0.08;
    this.spray.uniforms.uFadeOut.value = 0.35;

    // Pigment. Dark, non-additive, and the one system here that is *supposed*
    // to take light out of the frame.
    this.flecks = particles.get('ink.flecks', {
      capacity: 2400,
      shape: ParticleShape.DROPLET,
      additive: false,
      curl: true,
      stretch: true,
      softFade: 0.2
    });
    this.flecks.uniforms.uDrag.value = 0.8;
    this.flecks.uniforms.uEndSize.value = 0.7;
    this.flecks.uniforms.uSizeIn.value = 0.05;
    this.flecks.uniforms.uFadeIn.value = 0.05;
    this.flecks.uniforms.uFadeOut.value = 0.55;

    // The low haze over the water. Its real job is to break the crown's
    // boundary: a lathe has a mathematically exact edge, and a little mist
    // wandering across it is what stops that edge being a visible wall.
    this.haze = particles.get('ink.haze', {
      capacity: 1800,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.haze.uniforms.uDrag.value = 1.9;
    this.haze.uniforms.uEndSize.value = 2.6;
    this.haze.uniforms.uSizeIn.value = 0.16;
    this.haze.uniforms.uFadeIn.value = 0.22;
    this.haze.uniforms.uFadeOut.value = 0.3;

    this.dropletEmitter = new RateEmitter();
    this.sprayEmitter = new RateEmitter();
    this.fleckEmitter = new RateEmitter();
    this.hazeEmitter = new RateEmitter();
    this.trailEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** The flood lands, then the tide stands and turns. */
  get impactDuration() {
    return Math.max(0.05, settings.ink.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.ink.fadeTime);
  }

  /**
   * The light does not flicker — it heaves.
   *
   * `lightSwell` is how much of it the envelope owns: at 0 the tide is lit
   * flat, at 1 it nearly goes out between swells.
   */
  lightShimmer() {
    const c = settings.ink;
    return 1 - c.lightSwell * 0.5 + c.lightSwell * this._swell * 1.3;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.ink.zoneRadius);
  }

  /** Where the stroke leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.ink;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The centre of the tide — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** The stroke's travelling head. Pinned to the centre once it has arrived. */
  _frontPoint(out) {
    const u = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(u, out).setY(0.08);
  }

  /** How far the paper and the ink have soaked out across the floor, metres. */
  _soakAmount() {
    const c = settings.ink;
    const flood = Math.max(0.01, c.floodTime);
    // The sheet goes down first and fastest; everything else is painted on it.
    return this.radius * c.washRadius * c.splatterSpread *
      Easing.outQuint(saturate(this._bloomTime / (flood * 0.85)));
  }

  /** How full the water is, 0..1. */
  _openAmount() {
    const c = settings.ink;
    return Easing.outCubic(saturate(this._bloomTime / Math.max(0.01, c.floodTime)));
  }

  /**
   * How far the throat has opened, 0..1.
   *
   * Deliberately late: the flood has to land, the jet has to stand and fall, and
   * only then does the middle give way. A vortex that is already turning on the
   * frame the water arrives has nothing to arrive *into*.
   */
  _throatAmount() {
    const c = settings.ink;
    return Easing.inOutCubic(
      saturate((this._bloomTime - c.drainTime) / Math.max(0.05, c.drainTime * 0.8))
    );
  }

  /** How far the crown has stood up, and how far it has fallen back. */
  _crownRise() {
    const c = settings.ink;
    return Easing.outCubic(saturate(this._bloomTime / Math.max(0.02, c.crownRise)));
  }

  _crownFall() {
    const c = settings.ink;
    return Easing.inOutQuad(
      saturate((this._bloomTime - c.crownRise) / Math.max(0.05, c.crownFall))
    );
  }

  /** The height of the wall right now, metres. */
  get crownHeight() {
    const c = settings.ink;
    // It falls back to a standing wall rather than to nothing: this is the
    // boundary of a zone that has to stay readable for five seconds, and a
    // splash that collapses completely takes the footprint with it.
    return Math.max(0.02, c.crownHeight * this._crownRise() * (1 - this._crownFall() * 0.62));
  }

  /** How far the jet has climbed, 0..1 — up fast, hold, then back into the throat. */
  _columnRise() {
    const c = settings.ink;
    const up = Easing.outQuad(saturate(this._bloomTime / Math.max(0.02, c.columnRise)));
    const down = Easing.inCubic(
      saturate((this._bloomTime - c.columnRise - c.columnHold) / Math.max(0.05, c.columnFall))
    );
    return up * (1 - down);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dropletEmitter.reset();
    this.sprayEmitter.reset();
    this.fleckEmitter.reset();
    this.hazeEmitter.reset();
    this.trailEmitter.reset();

    this._markDistance = 0;
    this._bloomTime = 0;
    // Started somewhere arbitrary in the envelope, so two tides standing at
    // once are never in step — the whole point of an irregular swell.
    this._swellPhase = Math.random() * 40;
    this._swellRaw = 0;
    this._swell = 0;
    this._spin = 0;
    this._ringClock = 0;
    this._releaseGrips();
    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this._sync(1, 0);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame sync                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into all five materials.
   *
   * @param {number} fade 1 while the tide is live, ramping to 0 as it drains
   * @param {number} dry  0..1 through the drain
   */
  _sync(fade, dry) {
    const c = settings.ink;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(_centre);
    const centreX = _centre.x;
    const centreZ = _centre.z;
    const radius = this.radius;
    const swell = this._swell * saturate(fade);
    const open = travelling ? 0 : this._openAmount() * (1 - dry);
    const throat = travelling ? 0 : this._throatAmount() * (1 - dry);

    /* ---- the painted floor ---- */
    const pool = this._poolState;
    pool.radius = radius;
    pool.quadSize = (radius * c.washRadius * Math.max(1, c.splatterSpread) + 1.4) * 2;
    pool.spread = travelling ? 0 : this._soakAmount();
    pool.open = open;
    pool.throat = throat;
    pool.spin = this._spin;
    pool.ringClock = this._ringClock;
    pool.swell = swell;
    pool.dry = dry;
    // The paper is the last thing to go: the water drains out of it long before
    // the stain does, so the pool's own fade trails the ability's.
    pool.fade = travelling ? 0 : Math.max(fade, 1 - Easing.inQuad(dry) * 0.75);
    pool.seed = this._seed;
    this.poolMaterial.userData.sync(pool);

    this.pool.visible = !travelling;
    this.pool.position.set(centreX, c.poolHeight, centreZ);
    this.pool.scale.set(pool.quadSize, 1, pool.quadSize);

    /* ---- the refraction ---- */
    const warp = this._warpState;
    warp.radius = radius;
    warp.quadSize = radius * 2.4;
    warp.open = open;
    warp.spin = this._spin;
    warp.ringClock = this._ringClock;
    warp.strength = travelling ? 0 : fade;
    warp.seed = this._seed;
    this.warpMaterial.userData.sync(warp);

    this.warp.visible = !travelling && open > 0.001;
    this.warp.position.set(centreX, c.poolHeight + 0.004, centreZ);
    this.warp.scale.set(warp.quadSize, 1, warp.quadSize);

    /* ---- the crown ---- */
    const crown = this._crownState;
    crown.radius = radius;
    crown.height = c.crownHeight;
    crown.rise = travelling ? 0 : this._crownRise() * (1 - this._crownFall() * 0.62) * (1 - dry);
    crown.fall = travelling ? 0 : this._crownFall();
    crown.swell = swell;
    crown.fade = fade;
    crown.seed = this._seed;
    this.crownMaterial.userData.sync(crown);

    // Scale 1: the lathe builds itself in world metres from `uRadius`, so
    // scaling the mesh would scale the shape twice.
    this.crown.visible = !travelling && crown.rise > 0.002;
    this.crown.position.set(centreX, 0, centreZ);

    /* ---- the jet ---- */
    const column = this._columnState;
    column.radius = radius;
    column.height = c.columnHeight;
    column.rise = travelling ? 0 : this._columnRise() * (1 - dry);
    column.swell = swell;
    column.fade = fade;
    column.seed = this._seed;
    this.columnMaterial.userData.sync(column);

    this.column.visible = !travelling && column.rise > 0.004;
    this.column.position.set(centreX, 0, centreZ);

    /* ---- the suspended ink ---- */
    const volume = this._volumeState;
    volume.centre.set(centreX, 0, centreZ);
    volume.radius = radius;
    volume.height = Math.max(0.05, c.wispHeight * (0.35 + open * 0.65));
    volume.swell = swell;
    // The ink is pulled down into the throat as the tide drains rather than
    // fading out where it hangs.
    volume.drain = Easing.inQuad(dry);
    volume.fade = fade;
    volume.seed = this._seed;
    this.volumeMaterial.userData.sync(volume);

    // The proxy has to contain every metre the analytic shape can reach, or the
    // volume would be clipped by the box that is only supposed to find it.
    const span =
      radius * (1 + Math.max(0, c.wispFlare) + Math.max(0, c.wispSkirt) + Math.max(0, c.wispLobe)) *
      VOLUME_CIRCUMSCRIBE;
    this.volume.visible = !travelling && open > 0.01;
    this.volume.position.set(centreX, 0, centreZ);
    this.volume.scale.set(span, volume.height, span);

    /* ---- the particle gradients ---- */
    this.droplets.setGradient(
      getColor(c.colorDropletA),
      getColor(c.colorDropletB),
      getColor(c.colorDropletC),
      getColor(c.colorDropletD)
    );
    this.spray.setGradient(
      getColor(c.colorSprayA),
      getColor(c.colorSprayB),
      getColor(c.colorSprayC),
      getColor(c.colorSprayD)
    );
    this.flecks.setGradient(
      getColor(c.colorFleckA),
      getColor(c.colorFleckB),
      getColor(c.colorFleckC),
      getColor(c.colorFleckD)
    );
    this.haze.setGradient(
      getColor(c.colorHazeA),
      getColor(c.colorHazeB),
      getColor(c.colorHazeC),
      getColor(c.colorHazeD)
    );
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
    // Hands the body its weight back — a corpse the water has finished with and
    // is still holding up is a corpse that hangs where it was let go of.
    slot.dummy?.release();
    this._grips[index] = this._grips[last];
    this._grips[last] = slot;
    slot.dummy = null;
    slot.time = 0;
    slot.reach = 0;
    slot.under = false;
    slot.depth = 0;
    this._gripCount = last;
  }

  /** Let go of everything. The floor comes back under whoever is still above it. */
  _releaseGrips() {
    for (let i = 0; i < this._gripCount; i++) {
      this._grips[i].dummy?.release();
      this._grips[i].dummy = null;
      this._grips[i].time = 0;
      this._grips[i].reach = 0;
      this._grips[i].under = false;
      this._grips[i].depth = 0;
    }
    this._gripCount = 0;
  }

  /**
   * Take hold of anything inside the circle that is not already held.
   *
   * Polled every frame rather than resolved once on impact, because the tide
   * *moves* bodies: one thrown across the boundary by another cast has to be
   * caught on the frame it crosses, not ignored for the rest of the zone's life.
   *
   * A body still on its feet is knocked down first, and knocked **inward** —
   * the one detail that says whirlpool. Everything the rest of the stage does
   * throws bodies away from the impact; this one pulls them into it, and a
   * corpse that flies outward from a vortex would undo the read before the
   * water even reaches it.
   */
  _capture() {
    const field = this.ctx.dummies;
    if (!field?.findBodies) return;

    const c = settings.ink;
    const gc = c.grip;
    this._centrePoint(_centre);

    const found = field.findBodies(_centre.x, _centre.z, this.radius, this._found);

    this._force.impulse = gc.impulse;
    this._force.lift = gc.lift;
    this._force.spin = gc.spin;

    for (const dummy of found) {
      if (this._gripCount >= MAX_GRIPS) break;
      if (this._gripOf(dummy)) continue;

      if (dummy.alive) {
        const at = dummy.position;
        _dir.set(_centre.x - at.x, 0, _centre.z - at.z);
        // A body standing exactly on the point has no direction to be pulled
        // in, so it takes the cast's own.
        if (_dir.lengthSq() < 1e-6) _dir.copy(this.direction);
        else _dir.normalize();
        if (!dummy.kill(_dir.x, _dir.z, this._force)) continue;
      } else {
        const at = dummy.bodyPoint(_at);
        // Down, but with no solver to take hold of — nothing to pull.
        if (!at) continue;
        // Already under: this one has been swallowed, by this tide or another.
        // Re-gripping it would start its descent clock again from a floor of
        // zero, and the tide would appear to spit it back out.
        if (at.y < -0.2) continue;
      }

      const slot = this._grips[this._gripCount++];
      slot.dummy = dummy;
      slot.time = 0;
      // Measured off the solver, not off `position`: `kill` has just built the
      // ragdoll, so this is where the body actually is rather than the spot it
      // was standing on before the water hit it.
      const from = dummy.bodyPoint(_at) ?? dummy.position;
      slot.reach = Math.hypot(from.x - _centre.x, from.z - _centre.z);
      slot.under = false;
      slot.depth = 0;
    }
  }

  /**
   * The velocity of the water at one point, in world space.
   *
   * Sampled once per joint of every body the tide is holding — two hundred
   * times in a frame with a full circle — so it reads its state out of `_flow`
   * rather than taking it, and allocates nothing.
   *
   * Horizontally it is a **Rankine vortex**: solid-body rotation inside the
   * throat, falling away outside it. The core is the whole point. A free vortex
   * goes as 1/r and is singular on the axis, so two joints either side of the
   * middle are handed opposite velocities of unbounded size, the bones between
   * them cannot absorb the difference, and the body shivers apart instead of
   * turning. Inside a solid-body core the field *is* a rotation, and a rotation
   * is a motion every distance constraint in the solver already agrees with —
   * so a body that reaches the middle is simply turned, hard, which is the
   * thing being drawn. The core is `throatSize` wide because that is the hole
   * painted on the floor: the water turns as one exactly where the picture says
   * there is a hole to turn into.
   *
   * The inward pull carries a **centrifugal correction**, and without it none of
   * the rest of this works. Steering a body toward a velocity cannot hold it on
   * a curve: a first-order match at rate `grab` slips by `a / grab` against any
   * acceleration it is asked to produce, and the acceleration a circular orbit
   * needs is `v² / r` — which at these speeds is *metres per second* of drift
   * outward. Uncorrected, a tide parks everything it catches on the ring where
   * that drift happens to cancel the inward pull and turns it there for the rest
   * of its life, which looks for all the world like a deliberate design decision
   * and is why it took a trace to find. Adding the slip back makes `flow` mean
   * what it says: metres per second of inward drift, actually delivered. Inside
   * the core the swirl goes as r, so `v² / r` goes to *zero* on the axis rather
   * than to infinity — the solid-body middle that keeps the field from tearing
   * bodies apart is what keeps this term finite too.
   *
   * On top of that comes **the winch** — `wx, wz`, one velocity for the whole
   * body, computed once in `_drag` and added to every joint unchanged. It is
   * what actually delivers a body to the middle, and it has to be uniform for
   * the same reason the vertical does. A radial inflow sampled per joint is a
   * *convergent* field: it asks the near shoulder and the far one to move
   * toward each other, the distance constraints refuse, and the projection pass
   * spends the pull on squeezing the body instead of carrying it. Worse, it
   * fails hardest exactly where the ability needs it most — a body straddling
   * the axis is pulled equally in every direction and goes nowhere at all,
   * which is why tides used to park their catch on a ring a metre out and turn
   * it there until the water drained. A uniform translation is a rigid motion,
   * and the solver passes rigid motions through untouched.
   *
   * Two more things go on top of that. The body's own spin about its own axis,
   * which is the difference between something caught in a tornado and something
   * on a turntable. And the vertical: a spring holding it at the height the
   * water carries it at — `lift` — until the throat opens under it and `sink`
   * takes that away.
   *
   * The vertical is the one term measured from the **body**, not from the point
   * being sampled, and it has to be. A spring that reads each joint's own height
   * pulls every one of them onto the same plane, and within a second what is
   * floating in the water is a paper cut-out of a person. Reading the body's
   * centre once gives every joint the same vertical velocity, which lifts the
   * body without touching its shape — which is what floating does.
   *
   * @param {number} x world-space point
   * @param {number} y
   * @param {number} z
   * @param {import('three').Vector3} out written in place
   */
  /* eslint-disable-next-line no-unused-vars -- `y` completes the sample point */
  _sampleFlow(x, y, z, out) {
    const f = this._flow;

    const dx = f.cx - x;
    const dz = f.cz - z;
    const distance = Math.max(1e-3, Math.hypot(dx, dz));
    const nx = dx / distance;
    const nz = dz / distance;
    const reach = saturate(distance / f.radius);

    // Right-handed about +Y, so the spiral turns the same way the pool and the
    // volume are wound. Opposite senses here and in the shaders is the kind of
    // mismatch nobody can name and everybody notices.
    const swirl =
      f.swirl *
      (distance < f.core ? distance / f.core : Math.pow(f.core / distance, SWIRL_FALLOFF));
    // Weighted by how far out the body is, so nothing sits on the rim while the
    // middle turns without it — and deliberately the *weaker* of the two out
    // there, because a body that crosses the circle on a straight line has been
    // sucked in, and the point of this ability is that you watch it go round.
    // Plus what the orbit costs: see above, this is not optional.
    const centrifuge = Math.min(MAX_CENTRIFUGE, ((swirl * swirl) / distance) * f.slip);
    const flow = f.flow * (0.25 + reach * 0.9) + centrifuge;

    // The body's own turn: omega x r, about the vertical through its hips. A
    // rigid rotation satisfies every bone length exactly, so the projection
    // pass leaves it alone and the body keeps spinning — put the same energy in
    // as a shear instead and the constraints quietly eat it within two frames.
    const spinX = (z - f.sz) * f.spin;
    const spinZ = -(x - f.sx) * f.spin;

    // A spring toward the height the water is carrying it at, clamped both ways
    // so a body that arrives three metres out of position is drawn up to the
    // surface rather than fired at it. Off the body's centre, never off `y`.
    let rise = (f.ride - f.sy) * f.buoy;
    rise = Math.min(f.rise, Math.max(-f.rise, rise));

    out.set(
      nx * flow - nz * swirl + spinX + f.wx,
      rise * f.lift - f.sink,
      nz * flow + nx * swirl + spinZ + f.wz
    );
  }

  /**
   * Wind everything this tide is holding into the throat.
   *
   * The current is a **velocity the body is dragged toward**, not a force
   * applied to it — and that is a correctness decision before it is an artistic
   * one. Pushing a fixed acceleration every frame blows the solver up: it
   * consumes a bounded number of substeps per frame, so on a slow frame the
   * velocity keeps accumulating while the positions cannot follow, and the body
   * leaves the map. (It reached 574 metres up on the look-dev pass that found
   * this.) Steering toward a target velocity is unconditionally stable at any
   * frame rate, and it is also what water actually does to something floating
   * in it.
   *
   * It arrives per **joint** (`Dummy#carry`), not per body, and that is the
   * whole difference between a whirlpool and a magnet: the water half a metre
   * nearer the axis is measurably faster than the water at the far shoulder, so
   * sampling the field where each joint actually is turns the body as well as
   * carrying it.
   *
   * Three beats, and they have to be legible in this order:
   *
   *  1. **taken** — the water gets under the body (`wade`) and holds it at the
   *     surface (`float`). It has to leave the stone: the solver scrubs the
   *     slide off anything touching the floor, so a corpse lying on it is a
   *     corpse no vortex can turn. `wound` eases all of this in over `windUp`,
   *     because a body that snaps to the current on the frame it is caught
   *     reads as one that was dropped onto a turntable.
   *  2. **wound in** — it spins about its own axis while the vortex carries it
   *     round, and the whole spiral closes on the middle over `spiral` seconds.
   *     This is the part the ability is *for*, and it starts the moment the
   *     water floods rather than when the throat opens: gate the whole grip on
   *     the throat and everything the flood caught lies still on the floor
   *     through a second and a half of whirlpool that is not yet a whirlpool.
   *
   *     The closing is a **schedule the water holds the body to**, not a current
   *     and a hope. `reach` is where the tide found this one and `spiral` is how
   *     long it has to bring it in, so the wanted radius is known at every
   *     instant and the winch commands whatever inward speed the body needs to
   *     be on it (`SumiTideAbility#_sampleFlow`, `wx`/`wz`). Left open-loop it
   *     does not arrive: steering toward a velocity slips by `a / grab` against
   *     the `v² / r` an orbit costs, which at these speeds is *metres per
   *     second* of outward drift, and a body finds the ring where that drift
   *     cancels the pull and turns there for the rest of the cast. The
   *     centrifugal term below still feeds that forward so the winch has little
   *     to do; the schedule is what makes arriving certain rather than likely.
   *  3. **swallowed** — at the middle, and only there. `inside` gates the
   *     descent on the body being at the *axis* rather than merely somewhere in
   *     the hole, so going under reads as the end of the spiral instead of
   *     something that happened to it on the way. `late` is the failsafe: a body
   *     the water genuinely cannot move — wedged on another, or a `spiral`
   *     turned to nothing in the editor — is taken where it lies rather than
   *     left turning on the surface forever.
   *
   * Vertically the match is proportional to how much hold the water has. In air
   * gravity owns the body completely; in water it does not, and a body that
   * free-falls through the surface that is supposed to be swallowing it has
   * disappeared rather than been taken.
   *
   * The floor is taken out from under a body as the water takes hold
   * (`Dummy#sink`), and put back if the tide ends before it does.
   *
   * @param {number} dt
   * @param {number} flood how much water there is, 0..1 — what turns the bodies
   * @param {number} throat how far the middle has given way, 0..1 — what eats them
   */
  _drag(dt, flood, throat) {
    if (dt <= 0) return;

    const c = settings.ink;
    const gc = c.grip;
    const radius = this.radius;
    this._centrePoint(_centre);

    // How much of the gap between the body and the water is closed this frame.
    const grab = saturate(gc.grab * dt);

    const f = this._flow;
    f.cx = _centre.x;
    f.cz = _centre.z;
    f.radius = radius;
    // The turning core *is* the hole painted on the floor.
    f.core = Math.max(0.3, radius * c.throatSize);
    f.buoy = gc.buoy;
    f.rise = gc.rise;

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

      const dx = _centre.x - at.x;
      const dz = _centre.z - at.z;
      const distance = Math.max(1e-3, Math.hypot(dx, dz));
      const reach = saturate(distance / radius);

      // How much of the water is on this body yet.
      const wound = Easing.outCubic(saturate(slot.time / Math.max(0.05, gc.windUp))) * flood;

      // Where the spiral has got to with this one. `reach` is where it was
      // found and the schedule closes that to nothing over `spiral` seconds,
      // easing at both ends so the body is drawn off its mark rather than
      // yanked, and set down on the axis rather than fired through it.
      const spiral = Math.max(0.2, gc.spiral);
      const wind = Easing.inOutCubic(saturate((slot.time - gc.windUp) / spiral));
      const want = slot.reach * (1 - wind);
      // The winch: one velocity for the whole body, along the line to the axis,
      // and never outward — a body already ahead of its own schedule is left to
      // the current. See `_sampleFlow` for why this cannot be sampled per joint.
      const winch = gc.winch * Math.max(0, distance - want) * wound;
      f.wx = (dx / distance) * winch;
      f.wz = (dz / distance) * winch;

      // At the middle — the only place the water has earned the right to take it
      // down — or out of patience, whichever comes first. Deliberately tight:
      // this opens as the body crosses into the inner half of the throat and is
      // only complete on the axis, so the water closes over it where the
      // picture says the hole is and not a metre short of it.
      const inside = saturate((f.core * 0.55 - distance) / Math.max(0.15, f.core * 0.45));
      const late = saturate((slot.time - gc.hold - spiral) / 0.8);
      // Eased in over most of a second: a body that drops the instant the
      // throat reaches it never appears to have been *taken*, and the whole
      // point of the hold is that you watch it turn before it goes.
      const held = throat * saturate((slot.time - gc.hold) / 0.9) * Math.max(inside, late);

      f.sx = at.x;
      f.sy = at.y;
      f.sz = at.z;
      f.flow = gc.flow * wound;
      f.swirl = gc.swirl * wound;
      // Faster the nearer the axis it gets — angular momentum, near enough, and
      // the beat that says the middle of this thing is where you do not want to
      // be. The vortex's own solid-body core already turns a body once per
      // orbit; this is the spin on top of that, and it is the one that reads.
      f.spin = gc.tumble * TAU * (0.35 + (1 - reach) * 0.85) * wound;
      // Carried highest out on the wall and let down toward the middle, and
      // heaving with the swell — because nothing in this ability free-runs on
      // its own sine, the bodies included.
      f.ride = gc.float * (0.6 + reach * 0.4) * (0.7 + this._swell * 0.6) + c.poolHeight;
      f.lift = (1 - held) * wound;
      f.sink = gc.sink * held;

      // The last argument is the half a velocity cannot do: the water taking the
      // body's weight. Without it the vertical match has to out-pull gravity
      // once a frame against a solver that applies it five times, and the body
      // settles a slip-speed below wherever it is being held — which is under
      // the floor, which is under the picture.
      const hold = Math.max(wound, held);
      // How far behind the water this body runs, in seconds — the lag the
      // centrifugal correction has to pay for. It is the *effective* rate that
      // matters, not the setting: a grip that has only half taken hold slips
      // twice as far.
      f.slip = 1 / Math.max(0.5, gc.grab * hold);
      dummy.carry(this._field, grab * hold, grab * Math.max(wound * 0.85, held), hold);

      // The water gets *under* it before it can turn it. The solver scrubs the
      // slide off any joint touching the floor, so a corpse lying on the stone
      // will not spin however hard the current pulls: the stone goes first, by
      // a little, and the buoyancy above holds the body at the surface rather
      // than letting it fall into the gap that just opened under it.
      slot.depth = Math.max(slot.depth, gc.wade * wound);

      // The floor opens *in step with* the hold, and only ever downward.
      //
      // Dropping it to full depth the moment the water touches the body gives
      // gravity a three-metre hole and nothing to resist it: the corpse free
      // falls, hits the bottom in a fifth of a second, and the swallow is over
      // before it is legible. Lowering it as the current takes hold keeps the
      // body riding just above its own floor the whole way down. Never raising
      // it matters just as much — the hold weakens as the tide drains, and a
      // floor that came back up would spit a submerged body out through the
      // water that swallowed it.
      // Integrated at the sink speed rather than mapped off the hold, so the
      // floor can never descend faster than the water is carrying the body
      // down. Mapping it straight onto an eased 0..1 hold looks equivalent and
      // is not: the throat opens on a cubic, which for half a second outruns
      // the current by a factor of two and drops the body into free fall.
      if (held > 0.01) {
        slot.depth = Math.min(gc.depth, slot.depth + gc.sink * held * dt);
      }
      if (slot.depth > 0.001) dummy.sink(slot.depth);

      if (!slot.under && held > 0.02 && at.y < 0.08) {
        slot.under = true;
        this._swallowFx(at);
      }

      // Deep enough to be gone: the opaque floor is doing the hiding now, and
      // there is nothing left to pay for.
      if (at.y < -gc.depth * 0.7) this._dropGrip(i);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Effects                                                             */
  /* ------------------------------------------------------------------ */

  /** The brush being loaded at the caster's hand. */
  _muzzleFx() {
    const c = settings.ink;
    const g = settings.global;
    const time = frame.uTime.value;

    this._handPoint(_pos);

    _emit.position = _pos;
    _emit.radius = 0.14;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.fleckSpeed * 2.2;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.6;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.fleckSize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.fleckLifetime * 0.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.flecks.emit(Math.round(26 * g.particleCount), _emit);

    _emit.speed = c.spraySpeed * 1.6;
    _emit.size = c.spraySize;
    _emit.life = c.sprayLifetime * 0.55;
    this.spray.emit(Math.round(18 * g.particleCount), _emit);
  }

  /**
   * The stroke running across the floor.
   *
   * Paid out per *metre travelled* rather than per second, so the trail has the
   * same density whatever `speed` is dragged to — a marks-per-second trail
   * thins out to nothing the moment the cast gets fast.
   */
  _strokeFx(dt) {
    const c = settings.ink;
    const g = settings.global;
    const time = frame.uTime.value;

    this._frontPoint(_pos);

    const flecks = this.trailEmitter.tick(dt, c.trailInk * this.config.speed * 0.02);
    if (flecks > 0) {
      _emit.position = _pos;
      _emit.radius = 0.3;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
      _emit.speed = c.fleckSpeed * 0.8;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.75;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.fleckSize * 0.8;
      _emit.sizeVariance = 0.8;
      _emit.life = c.fleckLifetime * 0.7;
      _emit.lifeVariance = 0.6;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.flecks.emit(flecks, _emit);

      // Spray is paid out against the same metre of travel, so the two halves
      // of the stroke stay in proportion however either rate is dragged.
      _emit.speed = c.spraySpeed * 0.7;
      _emit.size = c.spraySize * 0.8;
      _emit.life = c.sprayLifetime * 0.5;
      const ratio = c.trailSpray / Math.max(1e-3, c.trailInk);
      this.spray.emit(Math.max(1, Math.round(flecks * ratio)), _emit);
    }

    // The wet mark the brush leaves, laid down by distance for the same reason.
    const travelled = this.u * this.length;
    if (travelled - this._markDistance < 0.9) return;
    this._markDistance = travelled;

    _pos.y = 0;
    this.ctx.decals.spawn(DecalType.FOAM, _pos, {
      radius: randRange(0.5, 0.9),
      life: 2.4,
      intensity: 0.5,
      width: 0.1,
      colorA: getColor(c.colorInkWash),
      colorB: getColor(c.colorStain),
      height: 0.012
    });
  }

  /**
   * Everything the standing tide keeps throwing.
   *
   * @param {number} scale how live the tide still is, 0..1
   */
  _tideFx(dt, scale) {
    if (scale <= 0.001) return;

    const c = settings.ink;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this.radius;
    const surge = 1 + this._swell * c.swellDepth;

    this._centrePoint(_centre);
    const centreX = _centre.x;
    const centreZ = _centre.z;
    const rim = this.crownHeight;

    /* --- droplets off the crown, all the way round --- */
    const drops = this.dropletEmitter.tick(dt, c.dropletRate * scale * surge * g.particleCount);
    if (drops > 0) {
      const perBatch = Math.max(1, Math.ceil(drops / RIM_BATCHES));
      _emit.radius = 0.22;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.4;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.dropletSize;
      _emit.sizeVariance = 0.7;
      _emit.life = c.dropletLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      for (let n = 0; n < drops; n += perBatch) {
        const a = Math.random() * TAU;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        _pos.set(centreX + cos * radius, rim * randRange(0.65, 1.05), centreZ + sin * radius);
        _emit.position = _pos;
        // Thrown off the lip, leaning outward — water leaves a crown over its
        // own rim, not straight up out of it.
        _emit.direction = _dir.set(cos * 0.55, 1, sin * 0.55).normalize();
        _emit.speed = c.dropletSpeed * surge;
        this.droplets.emit(Math.min(perBatch, drops - n), _emit);
      }
    }

    /* --- and the spray that hangs above it --- */
    const sprayCount = this.sprayEmitter.tick(dt, c.sprayRate * scale * surge * g.particleCount);
    if (sprayCount > 0) {
      const a = Math.random() * TAU;
      _pos.set(centreX + Math.cos(a) * radius * 0.98, rim * 0.95, centreZ + Math.sin(a) * radius * 0.98);
      _emit.position = _pos;
      _emit.radius = radius * 0.28;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.spraySpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.size = c.spraySize;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sprayLifetime;
      _emit.lifeVariance = 0.5;
      _emit.time = time;
      this.spray.emit(sprayCount, _emit);
    }

    /* --- pigment torn off the vortex --- */
    const fleckCount = this.fleckEmitter.tick(dt, c.fleckRate * scale * surge * g.particleCount);
    if (fleckCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.2, 0.7);
      _pos.set(centreX + Math.cos(a) * r, randRange(0.05, 0.5), centreZ + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.3;
      // Tangential: the flecks are being flung off something that is turning.
      _emit.direction = _dir.set(-Math.sin(a) * 0.9, 0.8, Math.cos(a) * 0.9).normalize();
      _emit.speed = c.fleckSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.55;
      _emit.size = c.fleckSize;
      _emit.sizeVariance = 0.8;
      _emit.life = c.fleckLifetime;
      _emit.lifeVariance = 0.55;
      _emit.time = time;
      this.flecks.emit(fleckCount, _emit);
    }

    /* --- the haze lying on the water --- */
    const hazeCount = this.hazeEmitter.tick(dt, c.hazeRate * scale * g.particleCount);
    if (hazeCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.35, 1.0);
      _pos.set(centreX + Math.cos(a) * r, 0.12, centreZ + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.2;
      _emit.direction = _dir.set(-Math.sin(a) * 0.6, 0.35, Math.cos(a) * 0.6).normalize();
      _emit.speed = c.hazeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.8;
      _emit.size = c.hazeSize;
      _emit.sizeVariance = 0.5;
      _emit.life = c.hazeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.haze.emit(hazeCount, _emit);
      _emit.spin = 0;
    }
  }

  /** The tide heaving: a ripple across the pool, spray off the wall, a knock. */
  _surgeFx(scale) {
    const c = settings.ink;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this.radius;

    this._centrePoint(_centre);

    const count = Math.round(c.tideSpray * scale * g.particleCount);
    if (count > 0) {
      _emit.position = _pos.set(_centre.x, this.crownHeight * 0.8, _centre.z);
      _emit.radius = radius * 0.9;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.spraySpeed * 1.7;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.7;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.spraySize * 1.2;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sprayLifetime * 1.2;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spray.emit(count, _emit);
    }

    if (c.tideRipple > 0.001) {
      this.ctx.decals.spawn(DecalType.RIPPLE, _centre, {
        radius: radius * 1.15,
        life: 0.9,
        width: 0.05,
        intensity: c.tideRipple * scale,
        colorA: getColor(c.colorShockA),
        colorB: getColor(c.colorShockB),
        height: c.poolHeight + 0.008
      });
    }

    this.ctx.shake.add(c.tideShake * scale * g.explosionIntensity, 2.8, 20);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.18 * scale);
  }

  /**
   * A body breaking the surface.
   *
   * The single most important beat in the ability, and the reason the grip
   * bothers to track which bodies have already gone under: water that closes
   * over something has to *react* on the frame it does. Nothing here is
   * ambient — every one of these is fired at a point, once, because a body
   * arrived at it.
   */
  _swallowFx(at) {
    const c = settings.ink;
    const g = settings.global;
    const gc = c.grip;
    const time = frame.uTime.value;

    _pos.set(at.x, 0.05, at.z);

    _emit.position = _pos;
    _emit.radius = 0.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dropletSpeed * 1.5;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.75;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.dropletSize * 1.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.dropletLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.droplets.emit(Math.round(gc.splashDroplets * g.particleCount), _emit);

    _emit.radius = 0.5;
    _emit.speed = c.spraySpeed * 1.3;
    _emit.spread = 0.9;
    _emit.size = c.spraySize;
    _emit.life = c.sprayLifetime;
    this.spray.emit(Math.round(gc.splashSpray * g.particleCount), _emit);

    // Ink comes up as the body goes down — the pigment it displaced.
    _emit.radius = 0.35;
    _emit.speed = c.fleckSpeed * 0.9;
    _emit.size = c.fleckSize;
    _emit.life = c.fleckLifetime * 0.8;
    this.flecks.emit(Math.round(gc.splashDroplets * 0.5 * g.particleCount), _emit);

    if (gc.splashFoam > 0.001) {
      this.ctx.decals.spawn(DecalType.RIPPLE, _pos, {
        radius: 1.5,
        life: 1.1,
        width: 0.06,
        intensity: gc.splashFoam,
        colorA: getColor(c.colorShockA),
        colorB: getColor(c.colorShockB),
        height: c.poolHeight + 0.01
      });
    }

    this.ctx.shake.add(gc.splashShake * g.explosionIntensity * g.cameraShake, 3.4, 22);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.25);
  }

  /**
   * Step the swell, and surge if this frame is the one that crossed.
   *
   * Advanced before anything reads it, so the frame a swell lands on is the
   * frame every material, the light and the emitters see it on.
   */
  _advanceSwell(dt, fade, dry) {
    const c = settings.ink;

    this._swellPhase += dt * Math.max(0, c.swellRate);
    const shaped = Math.pow(swellEnvelope(this._swellPhase), Math.max(0.05, c.swellSharp));

    // Crossing on the way *up* only: a surge is the moment the water heaves,
    // not every frame it happens to be high.
    if (this._swellRaw < c.tideThreshold && shaped >= c.tideThreshold && dry < 0.8 && dt > 0) {
      this._surgeFx(fade);
    }

    this._swellRaw = shaped;
    // A draining tide stops surging, but does not stop being modulated — it
    // just does it more and more weakly.
    this._swell = shaped * (1 - dry * 0.7);
  }

  /** Turn the vortex and pay out the ripples. Both integrate, so both are live. */
  _advanceClocks(dt, throat) {
    const c = settings.ink;
    const g = settings.global;

    // The vortex is slow while the water is only standing there and winds up as
    // the throat opens — the rotation and the mechanic share one number.
    this._spin += c.throatSpin * (0.3 + throat * 0.7) * (1 + this._swell * 0.3) * g.noiseSpeed * dt;
    this._ringClock += (c.ringSpeed / Math.max(0.1, c.ringReach)) * g.noiseSpeed * dt;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // The light rides the head of the stroke, just off the floor.
    this._frontPoint(this.position);
    this.position.y += 0.28;

    this._strokeFx(dt);
    this.ctx.shake.rumble(settings.ink.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.ink;
    const g = settings.global;
    const time = frame.uTime.value;

    this._bloomTime = 0;

    const centre = this._centrePoint(_centre);

    /* the dome of spray the flood throws as it lands */
    // Flattened and thin: this is water spreading over a floor, and anything
    // solider parks a pale hemisphere in the middle of the tide for half a
    // second — exactly what a fireball-style burst does here.
    this.ctx.bursts.spawn(BurstMode.WATER, centre, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.45,
      intensity: c.burstIntensity,
      opacity: 0.4,
      fresnel: 2.2,
      displace: 0.5,
      squash: 0.5,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor, past the boundary */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.8,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* the mark the tide stands on, and leaves behind */
    this.ctx.decals.spawn(DecalType.FOAM, centre, {
      radius: c.stainRadius,
      life: c.stainLife,
      intensity: c.stainIntensity,
      colorA: getColor(c.colorInkWash),
      colorB: getColor(c.colorStain),
      height: 0.014
    });

    /* everything the water throws on the frame it lands */
    _emit.position = centre;
    _emit.radius = this.radius * 0.75;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dropletSpeed * 2.4;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.dropletSize * 1.3;
    _emit.sizeVariance = 0.8;
    _emit.life = c.dropletLifetime * 1.2;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.droplets.emit(Math.round(150 * g.particleCount), _emit);

    _emit.radius = this.radius * 0.5;
    _emit.speed = c.fleckSpeed * 2.6;
    _emit.spread = 0.95;
    _emit.size = c.fleckSize * 1.2;
    _emit.life = c.fleckLifetime * 1.3;
    this.flecks.emit(Math.round(120 * g.particleCount), _emit);

    _emit.radius = this.radius * 0.85;
    _emit.speed = c.spraySpeed * 2.0;
    _emit.spread = 0.9;
    _emit.size = c.spraySize * 1.3;
    _emit.life = c.sprayLifetime * 1.3;
    this.spray.emit(Math.round(110 * g.particleCount), _emit);

    _emit.radius = this.radius * 0.7;
    _emit.speed = c.hazeSpeed * 3.2;
    _emit.spread = 1.0;
    _emit.size = c.hazeSize * 1.2;
    _emit.life = c.hazeLifetime * 1.1;
    _emit.spin = 0.35;
    this.haze.emit(Math.round(44 * g.particleCount), _emit);
    _emit.spin = 0;

    this.ctx.shake.add(
      c.floodShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.floodFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.1 * g.explosionIntensity;

    // Take hold on the same frame the water arrives, so nothing standing in the
    // circle is left on its feet for even one frame of the flood.
    this._capture();
  }

  onFade(dt, t) {
    const c = settings.ink;
    this._bloomTime += dt;

    // `t` runs 0..1 while the tide stands, then 1..2 while it drains.
    const dry = t <= 1 ? 0 : saturate(t - 1);
    const fade = 1 - Easing.inQuad(dry);
    const throat = this._throatAmount() * (1 - dry);

    this._advanceSwell(dt, fade, dry);
    this._advanceClocks(dt, throat);
    this._sync(fade, dry);

    // Still fishing while the water is live: a body knocked into the circle by
    // something else is caught the frame it crosses the boundary.
    if (dry < 0.5) this._capture();
    // Two envelopes, not one: the water turns a body from the moment it floods,
    // and only the *swallow* waits for the middle to give way.
    this._drag(dt, this._openAmount() * (1 - dry), throat);

    // The light sits low, inside the crown — where the water is.
    this._centrePoint(this.position);
    this.position.y = Math.max(0.2, this.crownHeight * saturate(c.lightHeight));

    this._tideFx(dt, fade * (t <= 1 ? 1 : 0.35));
    this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._releaseGrips();
    this.pool.visible = false;
    this.warp.visible = false;
    this.crown.visible = false;
    this.column.visible = false;
    this.volume.visible = false;
    this.poolMaterial.uniforms.uFade.value = 0;
    this.crownMaterial.uniforms.uFade.value = 0;
    this.columnMaterial.uniforms.uFade.value = 0;
    this.volumeMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    this.poolGeometry.dispose();
    this.warpGeometry.dispose();
    this.crownGeometry.dispose();
    this.columnGeometry.dispose();
    this.volumeGeometry.dispose();
    this.poolMaterial.dispose();
    this.warpMaterial.dispose();
    this.crownMaterial.dispose();
    this.columnMaterial.dispose();
    this.volumeMaterial.dispose();
    super.dispose();
  }
}
