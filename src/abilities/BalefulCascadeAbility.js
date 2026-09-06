import { IcosahedronGeometry, Mesh, PlaneGeometry, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import {
  createBladeGeometry,
  createVolleyGeometry,
  createWispGeometry
} from '../assets/CascadeGeometry.js';
import {
  createCascadeBladeState,
  createCascadeCrownMaterial,
  createCascadeVolleyMaterial,
  createCascadeHeartMaterial,
  createCascadeHaloMaterial,
  syncCascadeBlades
} from '../materials/CascadeBladeMaterial.js';
import { createCascadeMarkMaterial } from '../materials/CascadeMarkMaterial.js';
import { createCascadeGlowMaterial } from '../materials/CascadeGlowMaterial.js';
import { createCascadeWispMaterial } from '../materials/CascadeWispMaterial.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange, hash11 } from '../utils/math.js';

const TAU = Math.PI * 2;
/** The angle a Fibonacci spiral advances by, radians. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Instance capacities. The live counts are editor sliders inside these. */
const MAX_BLADES = 56;
const MAX_SHOTS = 8;
const MAX_WISPS = 28;
/** Throws waiting on their own stagger. Two per shot is more than enough. */
const MAX_QUEUED = 16;

/** How many points one frame's motes are split between. One origin is a hose. */
const MOTE_BATCHES = 4;

const _emit = {};
const _pos = new Vector3();
const _centre = new Vector3();
const _crown = new Vector3();
const _dir = new Vector3();
const _tip = new Vector3();
const _aimAt = new Vector3();
const _spray = new Vector3();

/**
 * The breath, 0..1 — the envelope every glowing pass is driven off.
 *
 * Two sines a fifth apart, so their sum has no period inside the seconds a mark
 * stands and it never lands twice on the same rhythm. Where the Chrono-Summon's
 * version is a plant breathing, this one is **weighted low**: the cube pulls the
 * envelope down into a long dark trough with a short swell at the top of it, so
 * the mark spends most of its time banked and briefly comes up. A thing that
 * glows evenly is friendly. This one should not be.
 *
 * @param {number} t phase, seconds × `pulseRate`
 */
function baleEnvelope(t) {
  const a = Math.sin(t);
  const b = Math.sin(t * 1.5 + 2.31);
  const s = saturate(((a + b * 0.62) / 1.62) * 0.5 + 0.5);
  return s * s * (3 - 2 * s) * s;
}

/**
 * CASCADE — the Baleful Cascade Mark.
 *
 * A far cast, built to a four-panel VFX breakdown sheet, and the second cast in
 * the sandbox that picks its own targets. A shard of cold light runs across the
 * floor to the aimed circle; a **ground glow** opens there; an angular **decal
 * mark** cuts itself on over the top of it; **wisps** climb out of the ring and
 * are drawn inward; and a **core mesh burst** — a crown of faceted blades around
 * a heart — tears up out of the middle of them. Then it goes to work: it marks
 * the nearest body still standing, winds up on it, and **throws its own blades**
 * at it. What a blade goes through comes apart at the waist.
 *
 * ## The four layers, and what makes them one thing
 *
 * The sheet lists them separately and this class is the only place they are not:
 *
 *   1. the **decal mark** on the floor (`CascadeMarkMaterial`)
 *   2. the **rising wisps** (`CascadeWispMaterial`)
 *   3. the **core mesh burst** — crown, volley, heart, halo (`CascadeBladeMaterial`)
 *   4. the **ground glow** under all of it (`CascadeGlowMaterial`)
 *
 * Three things weld them together, and they are worth more than any of the
 * numbers below:
 *
 *  - **one uniform block for every blade.** The crown and the blades in the air
 *    are handed the same `_blades` state by identity, so a shot is drawn with
 *    the section, taper, facets and palette of the crown it left. Nothing is
 *    copied and the two cannot drift.
 *  - **the wisps end where the crown begins.** Their spines are drawn onto the
 *    crown's own axis over the top of the climb, so layer 2 is visibly feeding
 *    layer 3 rather than standing in the same shot as it.
 *  - **the blades are lit by the heart.** `bladeGlow` puts a highlight on the
 *    facets nearest the middle of the burst, so forty separate solids read as
 *    one object with a lamp inside it.
 *
 * ## The crown is a magazine
 *
 * A blade that is thrown **leaves the crown** — its presence goes to zero, the
 * gap is visible, and it grows back over `crownRegrow`. Fire fast enough and
 * the burst visibly thins; leave it alone and it fills back in. That is the
 * whole difference between a summon that is spending something and a turret
 * with an infinite belt, and it costs one float per blade.
 *
 * It also decides *which* blade goes: the one already pointing nearest the
 * body. The shot leaves from that blade's actual tip, so the thing that arrives
 * is the thing that was standing there a frame ago.
 *
 * ## Why this ability aims itself
 *
 * Everything else in the sandbox *reaches*: `DummyField` reads the line a cast
 * publishes and turns it into a kill volume. A mark does not reach — it stands
 * there and picks. So this class answers `handlesOwnHits`, the field leaves it
 * alone, and it asks `findTargets` who is nearby, winds up, throws, and calls
 * `Dummy#kill(..., slice)` itself on the frame a blade's point arrives.
 *
 * A flurry is not all lethal, either. Every blade but the last one through a
 * body draws sparks off it and nothing else; the last one takes it apart. Three
 * blades arriving 70 ms apart with the third one felling the target reads as a
 * flurry. Three simultaneous kills read as a bug.
 *
 * ## The rule that keeps the editor honest
 *
 * A cast captures a seed and a handful of timestamps. Not one metre, radian or
 * second is recorded: the footprint, the glow, the mark, the wisps, the crown,
 * the volley and the light are all resolved against `settings.cascade` inside
 * the update loop, which runs on a zero-length frame too. Drag `footprint
 * radius` while a mark is standing and every layer re-seats around it, paused
 * or not.
 */
export class BalefulCascadeAbility extends Ability {
  constructor(context) {
    super('cascade', context);
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

    /* ---- the block every blade agrees through ---- */
    this._blades = createCascadeBladeState();

    /* ---- layer 4: the ground glow, under everything ---- */
    this.glowGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.glowMaterial = createCascadeGlowMaterial();
    this.glow = this._ground(this.glowGeometry, this.glowMaterial, 'CascadeGlow', 5);

    /* ---- layer 1: the mark over it ---- */
    this.markGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.markMaterial = createCascadeMarkMaterial();
    this.mark = this._ground(this.markGeometry, this.markMaterial, 'CascadeMark', 7);

    /* ---- layer 2: the wisps ---- */
    this.wispGeometry = createWispGeometry({ wisps: MAX_WISPS, nodes: 40, across: 3 });
    this.wispMaterial = createCascadeWispMaterial();
    this.wisps = new Mesh(this.wispGeometry, this.wispMaterial);
    this.wisps.name = 'CascadeWisps';
    this.wisps.layers.set(LAYER.VFX);
    this.wisps.renderOrder = 11;
    this.wisps.frustumCulled = false;
    this.wisps.matrixAutoUpdate = false;
    this.wisps.visible = false;
    this.group.add(this.wisps);

    /* ---- layer 3: the crown, and the blades it throws ---- */
    this.crownGeometry = createBladeGeometry({ blades: MAX_BLADES, nodes: 20, sides: 8 });
    this.crownMaterial = createCascadeCrownMaterial(environment, this._blades);
    this.crown = this._solid(this.crownGeometry, this.crownMaterial, 'CascadeCrown');
    this._crownDir = this.crownGeometry.attributes.aDir;
    this._crownShape = this.crownGeometry.attributes.aShape;

    this.volleyGeometry = createVolleyGeometry({ shots: MAX_SHOTS, nodes: 20, sides: 8 });
    this.volleyMaterial = createCascadeVolleyMaterial(environment, this._blades);
    this.volley = this._solid(this.volleyGeometry, this.volleyMaterial, 'CascadeVolley');
    this._volleyFrom = this.volleyGeometry.attributes.aFrom;
    this._volleyTo = this.volleyGeometry.attributes.aTo;
    this._volleyState = this.volleyGeometry.attributes.aState;

    // The charge the blades converge on. Its own transform, because unlike the
    // crown it is an ordinary mesh that the ability places.
    this.heartGeometry = new IcosahedronGeometry(1, 4);
    this.heartMaterial = createCascadeHeartMaterial(this._blades);
    this.heart = new Mesh(this.heartGeometry, this.heartMaterial);
    this.heart.name = 'CascadeHeart';
    this.heart.layers.set(LAYER.VFX);
    this.heart.renderOrder = 16;
    this.heart.frustumCulled = false;
    this.heart.visible = false;
    this.group.add(this.heart);

    // ... and the light it throws onto the air behind them.
    this.haloGeometry = new PlaneGeometry(1, 1, 1, 1);
    this.haloMaterial = createCascadeHaloMaterial(this._blades);
    this.halo = new Mesh(this.haloGeometry, this.haloMaterial);
    this.halo.name = 'CascadeHalo';
    this.halo.layers.set(LAYER.VFX);
    this.halo.renderOrder = 10; // under the blades: it is the air, not the charge
    this.halo.frustumCulled = false;
    this.halo.visible = false;
    this.group.add(this.halo);

    /* ---- per-cast state ---- */
    /**
     * One slot per blade in flight. `from` / `to` / `state` index straight into
     * the geometry's own buffers, so a flurry never allocates and never uploads
     * anything but the arrays it already owns.
     */
    this._shots = [];
    for (let i = 0; i < MAX_SHOTS; i++) {
      this._shots.push({
        index: i,
        age: 0,
        life: 1,
        /** The body this blade is on its way through, until its point arrives. */
        pending: null,
        /** Whether this is the one that takes the body apart. */
        lethal: false,
        /** Which blade of the crown left, so it knows what to grow back. */
        blade: -1,
        /** Unit heading, flat — the direction the cut is made along. */
        dirX: 0,
        dirZ: 1,
        /** The bow on its path, signed. Mirrored from the vertex stage. */
        curve: 0
      });
    }

    /** Throws waiting out their stagger inside one flurry. */
    this._queued = [];
    for (let i = 0; i < MAX_QUEUED; i++) {
      this._queued.push({ active: false, timer: 0, dummy: null, lethal: false });
    }

    /** How much of each blade is standing in the crown, and its regrow clock. */
    this._present = new Float32Array(MAX_BLADES);
    this._regrow = new Float32Array(MAX_BLADES);

    /** Re-rolled per cast, so no two marks are cut the same way. */
    this._seed = 0;
    /** Seconds since the shard landed. Drives the whole sequence. */
    this._markTime = 0;
    /** Metres of travel already paid out in ground marks. */
    this._markDistance = 0;
    /** Phase through the breath, and the envelope it produces. */
    this._pulsePhase = 0;
    this._pulse = 0;
    /** 0..1 how wound up the heart is. */
    this._charge = 0;
    /** The kick the mark takes as a blade leaves it. Decays on its own. */
    this._flare = 0;
    /** Seconds since the last flurry, and how long this one has wound up. */
    this._fireTimer = 0;
    this._chargeTimer = 0;
    /** The body the crown has settled on while it winds up. */
    this._mark = null;
    /** Reused by `DummyField#findTargets`, so polling allocates nothing. */
    this._targets = [];
    /** Alternates, so consecutive blades of a flurry bow opposite ways. */
    this._curveSide = 1;
    /** Where the crown hangs. Written per frame, read by everything. */
    this._crownAt = new Vector3();

    /** Scratch handed to the ground layers each frame. One object, reused. */
    this._groundState = {
      radius: 1,
      quadSize: 1,
      grown: 0,
      front: 0,
      pulse: 0,
      flare: 0,
      fade: 1,
      seed: 0
    };
    this._wispState = {
      centre: new Vector3(),
      radius: 1,
      count: 1,
      grow: 0,
      pulse: 0,
      charge: 0,
      fade: 1,
      seed: 0
    };
  }

  /** One of the two quads lying on the floor. */
  _ground(geometry, material, name, order) {
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.layers.set(LAYER.VFX);
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * One of the two meshes whose vertices are built in their own shader.
   *
   * Both want the same four things and getting any of them wrong is a
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

    // The cold motes lifted off the mark. Additive and climbing.
    this.motes = particles.get('cascade.motes', {
      capacity: 4000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.motes.uniforms.uDrag.value = 1.2;
    this.motes.uniforms.uEndSize.value = 0.14;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.06;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // Velocity-aligned sparks: the trail behind a blade in the air, and what
    // comes off one going through a body. The only system here that is a line
    // rather than a dot, which is why the flight reads as fast.
    this.sparks = particles.get('cascade.sparks', {
      capacity: 3600,
      shape: ParticleShape.STREAK,
      additive: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 2.4;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.02;
    this.sparks.uniforms.uFadeOut.value = 0.35;

    // Chips of the same crystal the blades are cut from. Not additive: these
    // are matter, and additive matter is a spark.
    this.chips = particles.get('cascade.chips', {
      capacity: 1600,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 1.1;
    this.chips.uniforms.uEndSize.value = 0.7;
    this.chips.uniforms.uSizeIn.value = 0.04;
    this.chips.uniforms.uFadeIn.value = 0.05;
    this.chips.uniforms.uFadeOut.value = 0.4;

    // The low bank the mark stands in. Its real job is to break the boundary of
    // the glow: a disc with a mathematically exact edge is a decal, and a little
    // mist wandering over it is what stops that edge being one.
    this.mist = particles.get('cascade.mist', {
      capacity: 2200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.mist.uniforms.uDrag.value = 2.0;
    this.mist.uniforms.uEndSize.value = 2.9;
    this.mist.uniforms.uSizeIn.value = 0.15;
    this.mist.uniforms.uFadeIn.value = 0.22;
    this.mist.uniforms.uFadeOut.value = 0.32;

    this.moteEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get impactDuration() {
    return Math.max(0.05, settings.cascade.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.cascade.fadeTime);
  }

  /** The light banks with the breath and kicks as a blade leaves. */
  lightShimmer() {
    const c = settings.cascade;
    return 1 - c.lightPulse * 0.5 + c.lightPulse * this._pulse + this._charge * 0.3 + this._flare;
  }

  /** Live instance counts, for the HUD readout. */
  get instanceCount() {
    return (
      this.crownGeometry.instanceCount +
      this.volleyGeometry.instanceCount +
      this.wispGeometry.instanceCount
    );
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.cascade.zoneRadius);
  }

  /** Where the shard leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.cascade;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The centre of the mark — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** The shard's travelling head. Pinned to the centre once it has arrived. */
  _frontPoint(out) {
    const u = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(u, out).setY(0.12);
  }

  /** Where the crown hangs, metres above the middle of the mark. */
  _crownPoint(out) {
    const c = settings.cascade;
    this._centrePoint(out);
    out.y =
      c.crownHeight -
      c.crownRise * (1 - this._crownLift()) +
      Math.sin(frame.uTime.value * c.crownBobSpeed * TAU) * c.crownBob * this._crownLift();
    return out;
  }

  /** How far the glow has opened out to the boundary, metres. */
  _glowGrown() {
    const c = settings.cascade;
    return (
      this.radius *
      c.glowSpillReach *
      Easing.outQuint(saturate(this._markTime / Math.max(0.01, c.glowTime)))
    );
  }

  /** How far the mark has cut itself out to the boundary, metres. */
  _markGrown() {
    const c = settings.cascade;
    return this.radius * Easing.outQuint(saturate(this._markTime / Math.max(0.01, c.markTime)));
  }

  /** How far the wisps have come up, 0..1. */
  _wispGrow() {
    const c = settings.cascade;
    return Easing.outCubic(
      saturate((this._markTime - c.wispDelay) / Math.max(0.01, c.wispTime))
    );
  }

  /** How far the crown has lifted out of the mark, 0..1. Height rides it. */
  _crownLift() {
    const c = settings.cascade;
    return Easing.outCubic(
      saturate((this._markTime - c.crownDelay * 0.6) / Math.max(0.01, c.crownTime * 1.3))
    );
  }

  /** How far the blades have grown, 0..1, before each blade's own stagger. */
  _crownGrow() {
    const c = settings.cascade;
    return Easing.outCubic(
      saturate((this._markTime - c.crownDelay) / Math.max(0.01, c.crownTime))
    );
  }

  /** Whether the crown is formed, and settled, enough to throw. */
  get _armed() {
    const c = settings.cascade;
    if (!c.throwEnabled) return false;
    return this._markTime >= c.crownDelay + c.crownTime + c.fireDelay;
  }

  /** How many blades are standing in the crown right now. */
  get _bladeCount() {
    const c = settings.cascade;
    const total =
      Math.max(0, Math.round(c.crownSpears)) +
      Math.max(0, Math.round(c.crownBlades)) +
      Math.max(0, Math.round(c.crownShards));
    return Math.min(MAX_BLADES, Math.max(1, total));
  }

  /**
   * A step that walks every index of `count` exactly once, in an order that is
   * nowhere near sequential.
   *
   * The crown's headings come off a Fibonacci spiral, whose consecutive indices
   * sit at nearly the same latitude — so dealing the three populations as three
   * blocks of that sequence would put every spear round one pole. Walking the
   * spiral with a stride coprime to its length keeps the counts exact and
   * scatters each population over the whole sphere.
   */
  _stride(count) {
    let stride = Math.max(1, Math.round(count * 0.618));
    for (let guard = 0; guard < count; guard++) {
      let a = stride;
      let b = count;
      while (b) {
        const t = a % b;
        a = b;
        b = t;
      }
      if (a === 1) return stride;
      stride = (stride % count) + 1;
    }
    return 1;
  }

  /* ------------------------------------------------------------------ */
  /* The crown                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Deal every blade in the crown into the instanced attributes.
   *
   * Runs before anything reads a blade, every frame, and resolves each heading,
   * length, roll and tone from the live settings — so this is where the crown
   * re-cuts itself under a slider, including on a zero-length frame. The whole
   * pass is a few hundred float writes; the alternative (deriving it in the
   * shader like the Chrono-Summon's tendrils) would be marginally cheaper and
   * would make it impossible for the ability to answer the only question it
   * actually has: *where is the point of blade seventeen*.
   *
   * @param {number} dt        seconds, for the regrow clocks
   * @param {number} grow      0..1 the crown assembling
   * @param {number} collapse  0..1 through the wither
   */
  _dealCrown(dt, grow, collapse) {
    const c = settings.cascade;
    const g = settings.global;
    const count = this._bladeCount;
    const dirs = this._crownDir.array;
    const shape = this._crownShape.array;

    const spears = Math.max(0, Math.round(c.crownSpears));
    const blades = Math.max(0, Math.round(c.crownBlades));
    const scale = Math.max(0.01, c.crownScale);
    const jitter = c.crownJitter * g.randomness;
    const flatten = Math.max(0.05, c.crownFlatten);
    const stagger = saturate(c.crownStagger);
    const stride = this._stride(count);

    const time = frame.uTime.value;
    const spin = time * c.crownSpin * TAU + this._seed;
    const tilt = c.crownTilt * Math.sin(time * c.crownTiltSpeed * TAU + this._seed);
    const cs = Math.cos(spin);
    const ss = Math.sin(spin);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);

    const regrowDelay = Math.max(0, c.crownRegrowDelay);
    const regrowRate = 1 / Math.max(0.02, c.crownRegrow);

    for (let i = 0; i < count; i++) {
      /* ---- which way it points ---- */
      const slot = (i * stride) % count;
      const k = (slot + 0.5) / count;
      let y = 1 - 2 * k;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = slot * GOLDEN_ANGLE + this._seed;
      let x = ring * Math.cos(phi);
      let z = ring * Math.sin(phi);

      // Squashed toward the equator: a crown dealt evenly over a sphere reads
      // as a ball of spines from every angle, and the panel is a *star*.
      y *= flatten;

      x += (hash11(i * 1.7 + this._seed) - 0.5) * jitter;
      y += (hash11(i * 2.3 + this._seed) - 0.5) * jitter;
      z += (hash11(i * 3.1 + this._seed) - 0.5) * jitter;

      // Tipped, then turned. The tilt is a slow nod rather than a fixed lean,
      // so the crown never settles into one silhouette.
      const y1 = y * ct - z * st;
      const z1 = y * st + z * ct;
      const x2 = x * cs + z1 * ss;
      const z2 = -x * ss + z1 * cs;

      const inv = 1 / Math.max(1e-4, Math.hypot(x2, y1, z2));
      const i3 = i * 3;
      dirs[i3] = x2 * inv;
      dirs[i3 + 1] = y1 * inv;
      dirs[i3 + 2] = z2 * inv;

      /* ---- how long it is ---- */
      const dice = hash11(i * 4.7 + this._seed * 1.3);
      const base = i < spears ? c.spearLength : i < spears + blades ? c.bladeLength : c.shardLength;
      const length = base * scale * (1 + (dice - 0.5) * 2 * c.crownLengthJitter * g.randomness);

      /* ---- how much of it is standing ---- */
      if (this._regrow[i] > 0) {
        this._regrow[i] = Math.max(0, this._regrow[i] - dt);
      } else if (this._present[i] < 1) {
        this._present[i] = saturate(this._present[i] + regrowRate * dt);
      }

      const lag = stagger * hash11(i * 5.9 + this._seed * 2.1);
      const opened = saturate((grow - lag) / Math.max(0.05, 1 - lag));
      // Overshoot on the way out: a blade that eases to a stop reads as
      // inflating, and one that overshoots reads as *thrown* out of the middle.
      const punch = Math.max(0, Easing.outBack(opened));
      // Going the other way it **retracts**, on the same stagger. The fragment
      // stage can eat a blade back from its point, and that is what draws the
      // burn line — but on its own it leaves a flat white cut face standing in
      // the air, which reads as chopped rather than as drawn back in. The
      // length is what actually takes the blade away; the cull only finishes it.
      const dying = saturate((collapse - lag * 0.4) / Math.max(0.15, 1 - lag * 0.4));
      const live = punch * this._present[i] * (1 - Easing.inQuad(dying));

      const i4 = i * 4;
      shape[i4] = length;
      shape[i4 + 1] = hash11(i * 6.3 + this._seed * 3.7) * TAU;
      shape[i4 + 2] = live;
      // Two stones dealt across the crown: the violet ones are the barbs the
      // reference sheet puts under the teal, and they are dealt rather than
      // grouped so no wedge of the burst is all one colour.
      shape[i4 + 3] =
        hash11(i * 7.1 + this._seed * 4.3) < c.crownViolet
          ? 0.65 + 0.35 * hash11(i * 8.9 + this._seed)
          : 0.3 * hash11(i * 9.7 + this._seed);
    }

    this.crownGeometry.instanceCount = count;
    this._crownDir.needsUpdate = true;
    this._crownShape.needsUpdate = true;
  }

  /**
   * The tip of blade `i`, in world space — the point a throw leaves from.
   *
   * Read straight back out of the buffers `_dealCrown` just wrote, so it is the
   * position that will actually be drawn this frame rather than a second guess
   * at it.
   */
  _bladeTip(i, out) {
    const c = settings.cascade;
    const dirs = this._crownDir.array;
    const shape = this._crownShape.array;
    const i3 = i * 3;
    const seat = Math.max(0.01, c.crownInner * Math.max(0.01, c.crownScale));
    const reach = seat + shape[i * 4] * shape[i * 4 + 2];
    return out.set(
      this._crownAt.x + dirs[i3] * reach,
      this._crownAt.y + dirs[i3 + 1] * reach,
      this._crownAt.z + dirs[i3 + 2] * reach
    );
  }

  /**
   * The blade best placed to be thrown at `(dx, dz)` — the one already pointing
   * that way, and grown enough to leave.
   *
   * @returns {number} its index, or −1 if the crown is spent
   */
  _pickBlade(dx, dz) {
    const dirs = this._crownDir.array;
    const shape = this._crownShape.array;
    const count = this.crownGeometry.instanceCount;
    let best = -1;
    let bestDot = -2;

    for (let i = 0; i < count; i++) {
      if (this._present[i] < 0.72) continue;
      if (shape[i * 4 + 2] < 0.5) continue;
      const i3 = i * 3;
      const dot = dirs[i3] * dx + dirs[i3 + 2] * dz;
      if (dot > bestDot) {
        bestDot = dot;
        best = i;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.sparkEmitter.reset();
    this.mistEmitter.reset();

    this._markDistance = 0;
    this._markTime = 0;
    this._charge = 0;
    this._flare = 0;
    // Primed, so the *first* flurry goes the moment the crown is armed.
    // Starting at zero would make it stand there for a whole interval after
    // `fireDelay` had already said it was ready, and the two waits read as one
    // long hesitation rather than as a cadence.
    this._fireTimer = Math.max(0, settings.cascade.throwInterval);
    this._chargeTimer = 0;
    this._mark = null;
    this._targets.length = 0;
    this._curveSide = 1;
    // Started somewhere arbitrary in the envelope, so two marks standing at
    // once are never in step.
    this._pulsePhase = Math.random() * 40;
    this._pulse = 0;
    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this._present.fill(1);
    this._regrow.fill(0);
    for (const shot of this._shots) this._retireShot(shot);
    for (const queued of this._queued) queued.active = false;

    this.volley.visible = false;
    this._crownPoint(this._crownAt);

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
   * @param {number} fade      1 while the mark stands, ramping to 0 as it goes
   * @param {number} collapse  0..1 through the wither
   */
  _sync(fade, collapse) {
    const c = settings.cascade;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(_centre);
    const radius = this.radius;
    const pulse = this._pulse * saturate(fade);
    const flare = this._flare;

    /* ---- layer 4: the ground glow ---- */
    const ground = this._groundState;
    ground.radius = radius;
    ground.quadSize = radius * c.glowSpillReach * 2 + 1.6;
    ground.grown = travelling ? 0 : this._glowGrown();
    ground.front = 0;
    ground.pulse = pulse;
    ground.flare = flare;
    ground.fade = travelling ? 0 : fade;
    ground.seed = this._seed;
    this.glowMaterial.userData.sync(ground);

    this.glow.visible = !travelling;
    this.glow.position.set(_centre.x, c.glowHeight, _centre.z);
    this.glow.scale.set(ground.quadSize, 1, ground.quadSize);

    /* ---- layer 1: the mark ---- */
    ground.quadSize = radius * c.markStarOuter * 2 + 1.4;
    ground.grown = travelling ? 0 : this._markGrown();
    // The leading edge is only live while the mark is still cutting itself on.
    ground.front = travelling
      ? 0
      : 1 - saturate(this._markTime / Math.max(0.01, c.markTime));
    this.markMaterial.userData.sync(ground);

    this.mark.visible = !travelling;
    this.mark.position.set(_centre.x, c.markHeight, _centre.z);
    this.mark.scale.set(ground.quadSize, 1, ground.quadSize);

    /* ---- layer 2: the wisps ---- */
    const wispGrow = travelling ? 0 : this._wispGrow() * (1 - saturate(collapse));
    const wisp = this._wispState;
    wisp.centre.copy(_centre);
    wisp.radius = radius;
    wisp.count = Math.min(MAX_WISPS, Math.max(1, Math.round(c.wisps)));
    wisp.grow = wispGrow;
    wisp.pulse = pulse;
    wisp.charge = this._charge;
    wisp.fade = fade;
    wisp.seed = this._seed;
    this.wispMaterial.userData.sync(wisp);
    this.wispGeometry.instanceCount = wisp.count;
    this.wisps.visible = !travelling && wispGrow > 0.002;

    /* ---- layer 3: the crown ---- */
    const lift = travelling ? 0 : this._crownLift();
    const scale = Math.max(0.01, c.crownScale);

    const state = this._blades;
    state.uCentre.value.copy(this._crownAt);
    state.uScale.value = scale;
    state.uSeed.value = this._seed;
    state.uCharge.value = this._charge;
    state.uFade.value = fade;
    state.uCollapse.value = saturate((collapse - 0.45) / 0.55);
    state.uPulse.value = pulse;
    syncCascadeBlades(state);

    this.crownMaterial.userData.sync();
    this.volleyMaterial.userData.sync();

    this.crown.visible = !travelling && lift > 0.002;

    const heartRadius = Math.max(0.02, c.heartSize * scale) * (1 + this._charge * c.heartSwell);
    this.heart.visible = this.crown.visible;
    this.heart.position.copy(this._crownAt);
    this.heart.scale.setScalar(heartRadius);
    this.heartMaterial.userData.sync();

    const haloSize = Math.max(0.05, c.haloSize * scale);
    this.haloMaterial.userData.sync(haloSize);
    this.halo.visible = this.crown.visible;
    this.halo.position.copy(this._crownAt);

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
    this.motes.uniforms.uGlow.value = 1.6 * g.glow;
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
    this.sparks.uniforms.uGlow.value = 2.0 * g.glow;

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    this.chips.uniforms.uSizeScale.value = c.chipSize * g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = c.chipLifetime * 0.5 * g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;

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
    this.mist.uniforms.uTurbulence.value = 0.45 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* The volley                                                          */
  /* ------------------------------------------------------------------ */

  /** Put a slot back in the rack. */
  _retireShot(shot) {
    shot.age = 0;
    shot.pending = null;
    shot.lethal = false;
    shot.blade = -1;
    this._volleyState.array[shot.index * 4 + 3] = 0;
  }

  /** The first slot not currently carrying a blade, or null. */
  _freeShot() {
    for (const shot of this._shots) {
      if (this._volleyState.array[shot.index * 4 + 3] < 0.5) return shot;
    }
    return null;
  }

  /**
   * A point on a blade's flight path.
   *
   * The same quadratic the vertex stage walks, and it has to stay that way:
   * this is what the trail is emitted along, so a curve that disagreed by ten
   * centimetres would lay the sparks beside the blade rather than behind it.
   */
  _pathPoint(shot, q, out) {
    const c = settings.cascade;
    const from = this._volleyFrom.array;
    const to = this._volleyTo.array;
    const i3 = shot.index * 3;

    const ax = from[i3];
    const ay = from[i3 + 1];
    const az = from[i3 + 2];
    const bx = to[i3];
    const by = to[i3 + 1];
    const bz = to[i3 + 2];

    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const span = Math.max(0.05, Math.hypot(dx, dy, dz));
    const ux = dx / span;
    const uy = dy / span;
    const uz = dz / span;

    // side = normalize(cross(dir, up)), lift = cross(side, dir)
    let sx = -uz;
    let sz = ux;
    const sl = Math.max(1e-4, Math.hypot(sx, sz));
    sx /= sl;
    sz /= sl;
    const lx = -sz * uy;
    const ly = sz * ux - sx * uz;
    const lz = sx * uy;

    const bow = shot.curve * c.throwCurve * span;
    const loft = c.throwLoft * span;
    const cx = (ax + bx) * 0.5 + sx * bow + lx * loft;
    const cy = (ay + by) * 0.5 + ly * loft;
    const cz = (az + bz) * 0.5 + sz * bow + lz * loft;

    const m = 1 - q;
    return out.set(
      m * m * ax + 2 * m * q * cx + q * q * bx,
      m * m * ay + 2 * m * q * cy + q * q * by,
      m * m * az + 2 * m * q * cz + q * q * bz
    );
  }

  /** How far down its path a blade has got, 0..1. Mirrors the vertex stage. */
  _pathReach(life) {
    const q = saturate(life / Math.max(1e-3, settings.cascade.throwStrike));
    return 1 - Math.pow(1 - q, 2.4);
  }

  /**
   * Choose, wind up, throw.
   *
   * The order matters more than any of the numbers: the crown *marks* a body,
   * spends `throwWarmup` visibly winding up on it — which is what the heart's
   * charge and the lit blade tips are showing you — and only then lets a flurry
   * go. Something that fires the instant a target walks into range is a turret;
   * something that takes a breath first is a thing deciding.
   */
  _aim(dt, fade) {
    const c = settings.cascade;

    if (!this._armed || fade < 0.5) {
      this._mark = null;
      this._chargeTimer = 0;
      this._charge = Math.max(0, this._charge - dt * 3.2);
      return;
    }

    this._fireTimer += dt;

    // Whoever it was aiming at may have been felled by the last flurry, or
    // burned away while this one was winding up.
    if (this._mark && !this._mark.alive) {
      this._mark = null;
      this._chargeTimer = 0;
    }

    if (!this._mark) {
      if (this._fireTimer < Math.max(0.02, c.throwInterval)) {
        this._charge = Math.max(0, this._charge - dt * 2.4);
        return;
      }
      const found = this.ctx.dummies?.findTargets?.(
        this._crownAt.x,
        this._crownAt.z,
        c.throwRange,
        this._targets
      );
      this._mark = found && found.length ? found[0] : null;
      this._chargeTimer = 0;
      if (!this._mark) {
        this._charge = Math.max(0, this._charge - dt * 2.4);
        return;
      }
    }

    this._chargeTimer += dt;
    const warmup = Math.max(0.01, c.throwWarmup);
    this._charge = saturate(this._chargeTimer / warmup);
    if (this._chargeTimer < warmup) return;

    /* ---- throw ---- */
    const bodies = Math.max(1, Math.round(c.throwTargets));
    this._queueFlurry(this._mark);
    if (bodies > 1) {
      // The rest come off the same list, skipping the one already marked.
      let taken = 1;
      for (let i = 0; i < this._targets.length && taken < bodies; i++) {
        const other = this._targets[i];
        if (other !== this._mark && other.alive) {
          this._queueFlurry(other);
          taken++;
        }
      }
    }

    this._mark = null;
    this._chargeTimer = 0;
    this._fireTimer = 0;
  }

  /**
   * Book one body's worth of blades.
   *
   * Only the **last** one is lethal. Everything before it goes through and
   * draws sparks, which is what makes a flurry read as a flurry: a body that
   * comes apart on the first of three arrivals leaves the other two hitting a
   * corpse, and three that land on the same frame read as one blade with a
   * rendering bug.
   */
  _queueFlurry(dummy) {
    const c = settings.cascade;
    const blades = Math.max(1, Math.round(c.throwBlades));
    const stagger = Math.max(0, c.throwStagger);

    for (let n = 0; n < blades; n++) {
      let queued = null;
      for (const slot of this._queued) {
        if (!slot.active) {
          queued = slot;
          break;
        }
      }
      if (!queued) return;
      queued.active = true;
      queued.timer = n * stagger;
      queued.dummy = dummy;
      queued.lethal = n === blades - 1;
    }
  }

  /** Let out whatever has waited out its stagger. */
  _stepQueue(dt) {
    for (const queued of this._queued) {
      if (!queued.active) continue;
      queued.timer -= dt;
      if (queued.timer > 0) continue;
      queued.active = false;
      if (queued.dummy && queued.dummy.alive) this._throwBlade(queued.dummy, queued.lethal);
      queued.dummy = null;
    }
  }

  /** Send one blade of the crown at one body. */
  _throwBlade(dummy, lethal) {
    const c = settings.cascade;
    const g = settings.global;

    const shot = this._freeShot();
    if (!shot) return;

    // Where up the body it lands, and therefore what the blade is aimed at.
    _aimAt.set(
      dummy.position.x,
      settings.dummies.height * saturate(c.throwAim),
      dummy.position.z
    );

    let dx = _aimAt.x - this._crownAt.x;
    let dz = _aimAt.z - this._crownAt.z;
    const flat = Math.hypot(dx, dz);
    if (flat > 1e-4) {
      dx /= flat;
      dz /= flat;
    } else {
      dx = this.direction.x;
      dz = this.direction.z;
    }

    const blade = this._pickBlade(dx, dz);
    // The crown is spent. Nothing is thrown, and the interval is reset short so
    // it tries again as soon as a blade has grown back rather than waiting out
    // a whole cadence with a full magazine.
    if (blade < 0) {
      this._fireTimer = Math.max(0, c.throwInterval - 0.25);
      return;
    }

    this._bladeTip(blade, _tip);

    const i3 = shot.index * 3;
    this._volleyFrom.array[i3] = _tip.x;
    this._volleyFrom.array[i3 + 1] = _tip.y;
    this._volleyFrom.array[i3 + 2] = _tip.z;
    this._volleyTo.array[i3] = _aimAt.x;
    this._volleyTo.array[i3 + 1] = _aimAt.y;
    this._volleyTo.array[i3 + 2] = _aimAt.z;

    this._curveSide = -this._curveSide;
    shot.curve = this._curveSide * randRange(0.55, 1);
    shot.age = 0;
    shot.life = Math.max(0.05, c.throwLife);
    shot.pending = dummy;
    shot.lethal = lethal;
    shot.blade = blade;
    shot.dirX = dx;
    shot.dirZ = dz;

    const i4 = shot.index * 4;
    this._volleyState.array[i4] = 0;
    this._volleyState.array[i4 + 1] = Math.random() * 10;
    this._volleyState.array[i4 + 2] = shot.curve;
    this._volleyState.array[i4 + 3] = 1;

    // The blade leaves the crown, and the gap it leaves is the point.
    this._present[blade] = 0;
    this._regrow[blade] = c.crownRegrowDelay;

    this._charge = 1;
    this._flare = Math.max(this._flare, 1);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.3 * g.explosionIntensity);
    this.ctx.shake.add(c.throwShake * g.explosionIntensity * g.cameraShake, 4.5, 26);
    this.ctx.flash.trigger(getColor(c.colorFlash), c.throwFlash * g.explosionIntensity);

    this._launchFx(_tip, dx, dz);
  }

  /**
   * Advance every blade in the air, and part whatever each one goes through.
   *
   * The cut lands on the frame the blade's **point** reaches the body rather
   * than on the frame it was thrown. That is a fifth of a second apart at the
   * shipped numbers and it is worth every frame of it: a body that comes apart
   * before the blade has crossed the gap is the single tell that separates a
   * mark that is doing something from a mark that is playing an animation.
   */
  _stepVolley(dt) {
    const c = settings.cascade;
    const state = this._volleyState.array;
    let live = 0;

    for (const shot of this._shots) {
      const i4 = shot.index * 4;
      if (state[i4 + 3] < 0.5) continue;
      live++;

      shot.age += dt;
      const life = saturate(shot.age / shot.life);
      state[i4] = life;

      if (shot.pending && life >= c.throwStrike) {
        const dummy = shot.pending;
        shot.pending = null;
        // Where the blade's point actually arrived. Both halves of the wound
        // are hung off this rather than off the body's own cut point: this is
        // the spot the geometry says the edge went through, it is the spot the
        // blade is standing in on the frame it lands, and it cannot be moved
        // out from under the spray by a solver that has already started.
        this._pathPoint(shot, 1, _pos);
        if (shot.lethal) {
          if (dummy.alive && dummy.kill(shot.dirX, shot.dirZ, c.cutHit, true)) {
            this._cutFx(_pos, shot.dirX, shot.dirZ);
          }
        } else {
          this._grazeFx(_pos, shot.dirX, shot.dirZ);
        }
      }

      if (life < 1) this._trailFx(shot, life, dt);
      else this._retireShot(shot);
    }

    this._volleyFrom.needsUpdate = true;
    this._volleyTo.needsUpdate = true;
    this._volleyState.needsUpdate = true;
    this.volleyGeometry.instanceCount = MAX_SHOTS;
    this.volley.visible = live > 0;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The flash at the caster's hand as the shard leaves it. */
  _muzzleFx() {
    const c = settings.cascade;
    const g = settings.global;

    this._handPoint(_pos);

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.moteSpeed * 3.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.6;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime * 0.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(c.castMotes * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /** What comes off the crown as a blade tears out of it. */
  _launchFx(at, dirX, dirZ) {
    const c = settings.cascade;
    const g = settings.global;
    const time = frame.uTime.value;

    _emit.position = at;
    _emit.radius = 0.12;
    _emit.direction = _dir.set(dirX, 0.15, dirZ).normalize();
    _emit.speed = c.sparkSpeed * 1.5;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.55;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime * 0.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.launchSparks * g.particleCount), _emit);

    _emit.direction = _dir.set(dirX, 0.5, dirZ).normalize();
    _emit.speed = c.chipSpeed;
    _emit.spread = 0.8;
    _emit.size = 0.09;
    _emit.life = c.chipLifetime * 0.7;
    _emit.spin = c.chipSpin;
    this.chips.emit(Math.round(c.launchChips * g.particleCount), _emit);
  }

  /**
   * The trail a blade lays behind it.
   *
   * Emitted along the path it has actually flown since the last frame rather
   * than at the point it happens to be on this one — at the speed these move,
   * one emission per frame is a dotted line.
   */
  _trailFx(shot, life, dt) {
    const c = settings.cascade;
    const g = settings.global;
    if (dt <= 0) return;

    const count = Math.round(this.sparkEmitter.tick(dt, c.trailRate) * g.particleCount);
    if (count <= 0) return;

    const reach = this._pathReach(life);
    const previous = this._pathReach(saturate((shot.age - dt) / shot.life));
    const time = frame.uTime.value;

    _emit.radius = c.throwLength * 0.18;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 0.35;
    _emit.speedVariance = 0.9;
    _emit.spread = 1;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.07;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime * 0.45;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;

    const per = Math.max(1, Math.ceil(count / MOTE_BATCHES));
    let remaining = count;
    while (remaining > 0) {
      this._pathPoint(shot, lerp(previous, reach, Math.random()), _pos);
      _emit.position = _pos;
      this.sparks.emit(Math.min(per, remaining), _emit);
      remaining -= per;
    }
  }

  /**
   * A blade going through a body that is not being felled by it.
   *
   * Deliberately small: what sells the flurry is that the first two arrivals
   * *do* something visible, not that they do as much as the last one.
   */
  _grazeFx(at, dirX, dirZ) {
    const c = settings.cascade;
    const g = settings.global;

    _emit.position = _pos.copy(at);
    _emit.radius = 0.14;
    _emit.direction = _dir.set(dirX, 0.45, dirZ).normalize();
    _emit.speed = c.cutSpeed * 0.6;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 0.5;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.grazeSparks * g.particleCount), _emit);

    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.1 * g.explosionIntensity);
  }

  /**
   * What comes out of a body the blade has just gone through.
   *
   * The spray goes out **across** the blade rather than along it. A wound is
   * made by an edge, and an edge throws what it opens sideways — a fan on the
   * cut plane reads as a slice, and the same particles fired down the flight
   * path read as an explosion the blade happened to be near.
   *
   * @param {THREE.Vector3} at   where the point went through
   * @param {number} dirX the blade's heading, flat
   * @param {number} dirZ
   */
  _cutFx(at, dirX, dirZ) {
    const c = settings.cascade;
    const g = settings.global;
    const time = frame.uTime.value;

    _pos.copy(at);

    // Across the cut, both ways, and lifted a little. Straight up is a
    // fountain; straight out along the blade is a hose.
    _spray.set(-dirZ, 0.35, dirX).normalize();

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _spray;
    _emit.speed = c.cutSpeed;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.45;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 0.8;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.cutSparks * 0.5 * g.particleCount), _emit);

    _emit.direction = _spray.set(dirZ, 0.35, -dirX).normalize();
    this.sparks.emit(Math.round(c.cutSparks * 0.5 * g.particleCount), _emit);

    _emit.direction = _dir.set(dirX, 0.6, dirZ).normalize();
    _emit.speed = c.cutSpeed * 0.55;
    _emit.spread = 0.9;
    _emit.size = 0.1;
    _emit.life = c.moteLifetime * 0.7;
    this.motes.emit(Math.round(c.cutMotes * g.particleCount), _emit);

    _emit.speed = c.chipSpeed * 1.2;
    _emit.size = 0.11;
    _emit.life = c.chipLifetime;
    _emit.spin = c.chipSpin;
    this.chips.emit(Math.round(c.cutChips * g.particleCount), _emit);

    this.ctx.shake.add(c.cutShake * g.explosionIntensity * g.cameraShake, 5.0, 24);
    this.ctx.flash.trigger(getColor(c.colorFlash), c.cutFlash * g.explosionIntensity);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.5 * g.explosionIntensity);
  }

  /** The shard running across the floor: sparks off it, marks under it. */
  _creepFx(dt) {
    const c = settings.cascade;
    const g = settings.global;
    const time = frame.uTime.value;

    const count = Math.round(this.moteEmitter.tick(dt, c.creepRate) * g.particleCount);
    if (count > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.25).setY(1).normalize();
      _emit.speed = c.moteSpeed * 1.4;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.085;
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
        _emit.radius = 0.24;
        this.motes.emit(Math.min(per, remaining), _emit);
        remaining -= per;
      }
    }

    // Marks paid out per metre of travel, jittered off the line so they do not
    // read as a dotted trail.
    const step = 1 / Math.max(0.05, c.stainRate);
    while (this.front - this._markDistance >= step) {
      this._markDistance += step;
      const s = saturate(this._markDistance / this.length);
      this.pointAt(s, _pos);
      _pos.x += this.side.x * randRange(-0.4, 0.4);
      _pos.z += this.side.z * randRange(-0.4, 0.4);

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
   * Everything the standing mark sheds.
   *
   * @param {number} scale 0..1 — thinned out as it goes
   */
  _auraFx(dt, scale) {
    const c = settings.cascade;
    const g = settings.global;
    const time = frame.uTime.value;
    if (scale <= 0.01 || dt <= 0) return;

    this._centrePoint(_centre);
    const radius = this.radius;

    // Motes lifted off the mark, over the whole footprint. Pulled up the way
    // the wisps go, so the two layers agree about which way is out.
    const motes = Math.round(
      this.moteEmitter.tick(dt, c.moteRate * scale * (0.6 + 0.4 * this._pulse)) * g.particleCount
    );
    if (motes > 0) {
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.moteSize;
      _emit.sizeVariance = 0.8;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      let remaining = motes;
      const per = Math.ceil(motes / Math.min(motes, MOTE_BATCHES));
      while (remaining > 0) {
        const bearing = Math.random() * TAU;
        const at = radius * Math.sqrt(Math.random()) * c.moteSeat;
        _pos.set(_centre.x + Math.cos(bearing) * at, randRange(0.04, 0.5), _centre.z + Math.sin(bearing) * at);
        _emit.position = _pos;
        _emit.radius = 0.12;
        this.motes.emit(Math.min(per, remaining), _emit);
        remaining -= per;
      }
    }

    // The bank the mark stands in, kept low and wide.
    const mist = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (mist > 0) {
      const bearing = Math.random() * TAU;
      _pos.set(
        _centre.x + Math.cos(bearing) * radius * c.mistSeat,
        randRange(0.05, 0.55),
        _centre.z + Math.sin(bearing) * radius * c.mistSeat
      );
      _emit.position = _pos;
      _emit.radius = radius * 0.24;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.size = c.mistSize;
      _emit.sizeVariance = 0.6;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      this.mist.emit(mist, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // The light rides the shard, just off the floor.
    this._frontPoint(this.position);
    this.position.y += 0.3;

    this._creepFx(dt);
    this.ctx.shake.rumble(settings.cascade.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.cascade;
    const g = settings.global;
    const time = frame.uTime.value;

    this._markTime = 0;

    const centre = this._centrePoint(_centre);

    /* the ring that snaps outward across the floor, past the boundary */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
      radius: this.radius * 1.3 * g.explosionIntensity,
      life: 0.8,
      width: 0.05,
      intensity: 0.9,
      colorA: getColor(c.colorGlowRim),
      colorB: getColor(c.colorMarkCore)
    });

    /* the stain the mark stands on, and leaves behind */
    this.ctx.decals.spawn(DecalType.SCORCH, centre, {
      radius: this.radius * 0.95,
      life: c.stainLife,
      intensity: c.stainIntensity,
      colorA: getColor(c.colorStain),
      colorB: getColor(c.colorStainEdge),
      height: 0.01
    });

    /* everything the floor gives up as the mark is cut into it */
    _emit.position = centre;
    _emit.radius = this.radius * 0.55;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 3.2;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.85;
    _emit.life = c.moteLifetime * 1.3;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.motes.emit(Math.round(c.landMotes * g.particleCount), _emit);

    _emit.radius = this.radius * 0.5;
    _emit.speed = c.sparkSpeed * 1.4;
    _emit.spread = 0.8;
    _emit.size = 0.08;
    _emit.life = c.sparkLifetime;
    this.sparks.emit(Math.round(c.landSparks * g.particleCount), _emit);

    _emit.radius = this.radius * 0.75;
    _emit.speed = c.mistSpeed * 3.4;
    _emit.spread = 1.0;
    _emit.size = 1.3;
    _emit.life = c.mistLifetime * 1.1;
    _emit.spin = 0.35;
    this.mist.emit(Math.round(c.landMist * g.particleCount), _emit);

    this.ctx.shake.add(
      c.landShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.landFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.1 * g.explosionIntensity;
    this._flare = 1;
  }

  onFade(dt, t) {
    const c = settings.cascade;
    const g = settings.global;
    const previousMarkTime = this._markTime;
    this._markTime += dt;

    // `t` runs 0..1 while the mark stands, then 1..2 while it goes.
    const collapse = t <= 1 ? 0 : saturate(t - 1);
    const fade = 1 - Easing.inQuad(collapse);

    /* ---- the breath, and the kick, before anything reads them ---- */
    this._pulsePhase += dt * Math.max(0, c.pulseRate);
    this._pulse = baleEnvelope(this._pulsePhase) * (1 - collapse * 0.6);
    this._flare = Math.max(0, this._flare - this._flare * 7 * dt - 0.4 * dt);

    /* ---- the crown is dealt before anything asks it a question ---- */
    this._crownPoint(this._crownAt);
    this._dealCrown(dt, this._crownGrow(), collapse);

    /* ---- the one-shot the crown fires as it finishes forming ---- */
    const formed = c.crownDelay + c.crownTime;
    if (previousMarkTime < formed && this._markTime >= formed && dt > 0) {
      this._crownFx();
    }

    this._aim(dt, fade);
    this._stepQueue(dt);
    this._stepVolley(dt);
    this._sync(fade, collapse);

    // The light sits inside the crown once there is one, and low in the mark
    // before that.
    this._centrePoint(this.position);
    this.position.y = lerp(0.35, this._crownAt.y, saturate(c.lightHeight) * this._crownLift());

    this._auraFx(dt, fade * (t <= 1 ? 1 : 0.35));
    this.ctx.shake.rumble(c.holdShake * fade * g.cameraShake, dt);
  }

  /** What the burst throws as the last blade snaps into place. */
  _crownFx() {
    const c = settings.cascade;
    const g = settings.global;
    const time = frame.uTime.value;

    _crown.copy(this._crownAt);

    _emit.position = _crown;
    _emit.radius = c.crownScale * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 1.6;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.crownSparks * g.particleCount), _emit);

    _emit.speed = c.moteSpeed * 2.2;
    _emit.size = 0.1;
    _emit.life = c.moteLifetime * 1.2;
    this.motes.emit(Math.round(c.crownMotes * g.particleCount), _emit);

    _emit.speed = c.chipSpeed * 0.9;
    _emit.size = 0.1;
    _emit.life = c.chipLifetime;
    _emit.spin = c.chipSpin;
    this.chips.emit(Math.round(c.crownChips * g.particleCount), _emit);

    this.ctx.shake.add(c.crownShake * g.explosionIntensity * g.cameraShake, 2.8, 20);
    this.ctx.flash.trigger(getColor(c.colorFlash), c.crownFlash * g.explosionIntensity);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.8 * g.explosionIntensity);
    this._flare = 1;
  }

  onDestroy() {
    for (const shot of this._shots) this._retireShot(shot);
    for (const queued of this._queued) {
      queued.active = false;
      queued.dummy = null;
    }
    this._volleyState.needsUpdate = true;
    this._mark = null;
    this._targets.length = 0;

    this.glow.visible = false;
    this.mark.visible = false;
    this.wisps.visible = false;
    this.crown.visible = false;
    this.volley.visible = false;
    this.heart.visible = false;
    this.halo.visible = false;

    this.glowMaterial.uniforms.uFade.value = 0;
    this.markMaterial.uniforms.uFade.value = 0;
    this.wispMaterial.uniforms.uGrow.value = 0;
    this._blades.uFade.value = 0;
  }

  dispose() {
    this.glowGeometry.dispose();
    this.markGeometry.dispose();
    this.wispGeometry.dispose();
    this.crownGeometry.dispose();
    this.volleyGeometry.dispose();
    this.heartGeometry.dispose();
    this.haloGeometry.dispose();

    this.glowMaterial.dispose();
    this.markMaterial.dispose();
    this.wispMaterial.dispose();
    this.crownMaterial.userData.depth.dispose();
    this.crownMaterial.dispose();
    this.volleyMaterial.userData.depth.dispose();
    this.volleyMaterial.dispose();
    this.heartMaterial.dispose();
    this.haloMaterial.dispose();

    super.dispose();
  }
}
