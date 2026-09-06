import {
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import {
  createPillarGeometry,
  createSlingGeometry,
  createTendrilGeometry
} from '../assets/RendGeometry.js';
import { createRendSigilMaterial } from '../materials/RendSigilMaterial.js';
import { createRendTendrilMaterial } from '../materials/RendTendrilMaterial.js';
import { createRendShardMaterial } from '../materials/RendShardMaterial.js';
import {
  createRendHaloMaterial,
  createRendPillarMaterial,
  createRendStarMaterial,
  createRendWarpMaterial
} from '../materials/RendPillarMaterial.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange, hash11 } from '../utils/math.js';

const TAU = Math.PI * 2;

/** Ribbons in the braid. The live count is an editor slider inside this. */
const MAX_TENDRILS = 40;

/** Two shard silhouettes, so the volley is not one sliver rotated. */
const SHARD_VARIANTS = 2;
/** Slivers per variant. */
const SHARD_SLOTS = 30;

/** How many bodies one rend can be holding at once. */
const MAX_MARKS = 8;

/** How many points one frame's motes are split between. One origin is a hose. */
const MOTE_BATCHES = 4;

const _emit = {};
const _pos = new Vector3();
const _at = new Vector3();
const _centre = new Vector3();
const _dir = new Vector3();
const _axis = new Vector3();
const _node = new Object3D();
const _spin = new Quaternion();
const _UP = /* @__PURE__ */ new Vector3(0, 1, 0);

/**
 * The toll, 0..1 — the envelope every glowing pass of this ability is driven off.
 *
 * Two sines a perfect fifth apart, so their sum has no period inside the seconds
 * a cascade stands and it never lands twice on the same rhythm. Where the
 * Astral Void's version is deliberately spiky — matter piling up at an orbit and
 * going in — this one is **weighted high**: the smoothstep pushes it up into a
 * long bright plateau with a short dip in it, because a column of divine light
 * is not a thing that flickers. It swells, and it very briefly breathes.
 *
 * @param {number} t phase, seconds x `pulseRate`
 */
function tollEnvelope(t) {
  const a = Math.sin(t);
  const b = Math.sin(t * 1.5 + 0.9);
  const s = saturate(((a + b * 0.55) / 1.55) * 0.5 + 0.5);
  const smooth = s * s * (3 - 2 * s);
  return Math.sqrt(smooth);
}

/**
 * REND — the Celestial Rend, and the Judgment Cascade it ends on.
 *
 * A far cast built to a four-panel breakdown sheet, and the third cast in the
 * sandbox that picks its own targets. A mote of divine light is thrown to the
 * aimed circle; a **celestial mark** cuts itself into the floor there; **astral
 * tendrils** climb out of the stone and wind toward it; **radiant shards** come
 * in out of the dark from every bearing and drive themselves into the mark, one
 * after another, faster and faster — and then the mark **detonates**: a column
 * of light thirty metres tall stands up out of it with a four-pointed star
 * welded to its head, two halo rings snap open around that star, and everything
 * standing inside the circle is put down where it stands and burned away.
 *
 * ## The four layers, and what makes them one thing
 *
 * The sheet lists them separately and this class is the only place they are not:
 *
 *   1. the **celestial mark** on the floor (`RendSigilMaterial`)
 *   2. the **astral tendrils** climbing out of it (`RendTendrilMaterial`)
 *   3. the **radiant shards** converging on it (`RendShardMaterial`)
 *   4. the **divine impact** — column, star, halos, warp (`RendPillarMaterial`)
 *
 * Four things weld them together, and they are worth more than any of the
 * numbers in the settings block:
 *
 *  - **one clock.** `_markTime` is seconds since the mark landed, and every
 *    beat below is a threshold on it. The tendrils do not start on their own
 *    timer, the shards do not arrive on theirs; the whole sequence is one
 *    function of one number, which is why it can be scrubbed in the editor.
 *  - **the tendrils end where the column begins.** They are drawn onto the
 *    pillar's own axis over the top of their climb, so layer 2 is visibly
 *    feeding layer 4 rather than standing in the same shot as it. Before the
 *    column exists, that same term makes them converge on the marked point —
 *    which is exactly what panel two is showing.
 *  - **the shards are lit by the column.** `shardBeamBleed` puts the pillar's
 *    own gold on the facets that face it, so fifty separate solids read as
 *    debris inside one light rather than as a field that wandered into frame.
 *  - **the shards are also the only solid.** Everything else here is additive
 *    light and cannot occlude anything, and a shot made entirely of light has
 *    no scale. The slivers are in the depth prepass and in the shadow map, and
 *    they are what the eye measures the column against.
 *
 * ## The arrivals accelerate, and that is the whole second act
 *
 * A shard's arrival time is `rendAt − charge · dice^bias`, and with a bias above
 * one the dice pile up near the end. So the strikes start as a lonely one every
 * half second and finish as a hail, and the detonation lands on the frame the
 * hail would have peaked. Spread them evenly and the same fifty shards read as
 * weather.
 *
 * ## What happens to the bodies, and why it is not a knockback
 *
 * This class answers `handlesOwnHits`, so `DummyField` leaves it alone — which
 * matters more here than anywhere else in the set, because the field's default
 * is to throw everything it touches *away* from the impact, and that is the one
 * thing this ability must not do. Judgment does not scatter people. So:
 *
 *  - **marked, then taken.** Bodies inside the circle are picked up when the
 *    mark lands and simply carry a mark until the rend. Nothing moves them.
 *  - **put down where they stand.** At the rend they are felled with an impulse
 *    of *zero* — `Dummy#kill` builds the ragdoll and hands it the blow, and a
 *    blow with no impulse and barely any lift is a body whose legs go out from
 *    under it. It collapses into its own footprint.
 *  - **held there.** `Dummy#carry` is handed a field that is zero sideways and
 *    a light press downward, so the solver's own momentum is scrubbed off every
 *    joint each frame. Without it a corpse that fell across a slope of its own
 *    limbs still slides half a metre, and half a metre is enough to read as
 *    having been pushed.
 *  - **burned away.** `Dummy#consume` is driven up from there, staggered per
 *    body so a circle of six does not go out on one frame, and the column
 *    flares as each one finishes.
 *
 * ## The rule that keeps the editor honest
 *
 * A cast captures one number — a seed — a handful of clocks, and per-shard dice
 * rolls with no units on them. Not one metre, radian or second is recorded: the
 * footprint, the mark, the braid, the shard field, the column, the star, the
 * halos and the reach of the judgment are all resolved against `settings.rend`
 * inside the update loop, which runs on a zero-length frame too. Drag
 * `zoneRadius` while a cascade is standing and every layer re-seats around it,
 * paused or not.
 */
export class CelestialRendAbility extends Ability {
  constructor(context) {
    super('rend', context);
  }

  /**
   * The mark picks its own, and it does not throw them.
   *
   * `DummyField` would otherwise read the cast as a far-cast disc and fling
   * everything in it outward on the frame the front lands — bodies scattered
   * clear of the column that is supposed to be judging them, and every one of
   * them a metre from where the sigil was drawn.
   */
  get handlesOwnHits() {
    return true;
  }

  /** Live instance counts, for the HUD readout. */
  get instanceCount() {
    let count = this.tendrilGeometry.instanceCount;
    for (const mesh of this.shardMeshes) count += mesh.count;
    return count;
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /* ---- layer 1: the celestial mark ---- */
    this.sigilGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.sigilMaterial = createRendSigilMaterial();
    this.sigil = new Mesh(this.sigilGeometry, this.sigilMaterial);
    this.sigil.name = 'RendSigil';
    this.sigil.layers.set(LAYER.VFX);
    this.sigil.renderOrder = 6;
    this.sigil.frustumCulled = false;
    this.sigil.visible = false;
    this.group.add(this.sigil);

    /* ---- layer 2: the astral tendrils ---- */
    this.tendrilGeometry = createTendrilGeometry({
      tendrils: MAX_TENDRILS,
      nodes: 80,
      across: 3
    });
    this.tendrilMaterial = createRendTendrilMaterial();
    this.tendrils = new Mesh(this.tendrilGeometry, this.tendrilMaterial);
    this.tendrils.name = 'RendTendrils';
    this.tendrils.layers.set(LAYER.VFX);
    this.tendrils.renderOrder = 12;
    this.tendrils.frustumCulled = false;
    this.tendrils.matrixAutoUpdate = false;
    this.tendrils.visible = false;
    this.group.add(this.tendrils);

    /* ---- layer 3: the radiant shards ---- */
    this.shardMaterial = createRendShardMaterial(environment);
    this.shardMeshes = [];
    this.shardHeat = [];
    this.shardSeed = [];
    this.shardTone = [];

    for (let v = 0; v < SHARD_VARIANTS; v++) {
      const geometry =
        v === 0
          ? createSlingGeometry({ seed: 3.1, sides: 6, width: 0.055, waist: 0.36, sharp: 0.8 })
          : createSlingGeometry({ seed: 11.7, sides: 5, width: 0.042, waist: 0.44, sharp: 0.95 });

      // All three are rewritten every frame rather than filled once, and that is
      // not a style choice. `_updateShards` **compacts** the live shards to the
      // front of the instance buffer, so instance 3 is a different shard from one
      // frame to the next — a seed or a tone baked into the slot would shuffle
      // underneath the field, and a sliver would visibly change colour halfway
      // through its own flight.
      const seeds = new InstancedBufferAttribute(new Float32Array(SHARD_SLOTS), 1);
      const heat = new InstancedBufferAttribute(new Float32Array(SHARD_SLOTS), 1);
      const tone = new InstancedBufferAttribute(new Float32Array(SHARD_SLOTS), 1);
      geometry.setAttribute('aSeed', seeds);
      geometry.setAttribute('aHeat', heat);
      geometry.setAttribute('aTone', tone);
      this.shardSeed.push(seeds);
      this.shardTone.push(tone);

      const mesh = new InstancedMesh(geometry, this.shardMaterial, SHARD_SLOTS);
      mesh.name = `RendShards${v}`;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid geometry: it belongs in the depth prepass, so the column and the
      // tendrils around a shard are clipped by it and the layers share a space.
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
     * settings in `_updateShards`, so dragging `shardReach` re-throws a volley
     * that is already in the air.
     */
    this.shards = [];
    for (let i = 0; i < SHARD_VARIANTS * SHARD_SLOTS; i++) {
      this.shards.push({
        /** where it comes in from, and where it settles */
        bearing: 0,
        orbitBearing: 0,
        seat: 1,
        loft: 1,
        /** the flight */
        arrive: 0,
        travel: 1,
        curve: 0,
        /** the orbit it is thrown into afterward */
        stagger: 0,
        rise: 1,
        size: 1,
        tumbleX: 0,
        tumbleY: 0,
        tumbleZ: 0,
        phase: 0,
        /** its own dice for the crystal shader, and which palette it is cut from */
        dice: 0,
        tone: 0,
        /** whether its strike has been paid for in sparks yet */
        struck: false
      });
    }

    /* ---- layer 4: the column ---- */
    this.pillarGeometry = createPillarGeometry({ nodes: 80, sides: 60 });
    this.pillarMaterial = createRendPillarMaterial();
    this.pillar = new Mesh(this.pillarGeometry, this.pillarMaterial);
    this.pillar.name = 'RendPillar';
    this.pillar.layers.set(LAYER.VFX);
    this.pillar.renderOrder = 14;
    this.pillar.frustumCulled = false;
    this.pillar.matrixAutoUpdate = false;
    this.pillar.visible = false;
    this.group.add(this.pillar);

    // The refraction proxy rides the same parameter grid, so the warp and the
    // beam can never disagree about where the column is.
    this.warpMaterial = createRendWarpMaterial();
    this.warp = new Mesh(this.pillarGeometry, this.warpMaterial);
    this.warp.name = 'RendWarp';
    this.warp.layers.set(LAYER.DISTORTION);
    this.warp.frustumCulled = false;
    this.warp.matrixAutoUpdate = false;
    this.warp.visible = false;
    this.group.add(this.warp);

    /* ---- ... and the star welded to its head ---- */
    this.starGeometry = new PlaneGeometry(1, 1, 1, 1);
    this.starMaterial = createRendStarMaterial();
    this.star = new Mesh(this.starGeometry, this.starMaterial);
    this.star.name = 'RendStar';
    this.star.layers.set(LAYER.VFX);
    this.star.renderOrder = 20;
    this.star.frustumCulled = false;
    this.star.matrixAutoUpdate = false;
    this.star.visible = false;
    this.group.add(this.star);

    // The smaller one that rides the mote on its way to the point, and stands
    // in the mark while the shards are still coming in. Same shader, same
    // palette, a fraction of the size — it is the *same* star, early.
    this.seedStarMaterial = createRendStarMaterial();
    this.seedStar = new Mesh(this.starGeometry, this.seedStarMaterial);
    this.seedStar.name = 'RendSeedStar';
    this.seedStar.layers.set(LAYER.VFX);
    this.seedStar.renderOrder = 19;
    this.seedStar.frustumCulled = false;
    this.seedStar.matrixAutoUpdate = false;
    this.seedStar.visible = false;
    this.group.add(this.seedStar);

    /* ---- ... and the two halo rings turning about it ---- */
    // Left in the XY plane and laid down by the mesh transform, so the shader
    // can read the ring's own plane straight off `position.xy`.
    this.haloGeometry = new RingGeometry(0.72, 1, 168, 1);
    this.halos = [];
    this.haloMaterials = [];
    for (let i = 0; i < 2; i++) {
      const material = createRendHaloMaterial();
      const mesh = new Mesh(this.haloGeometry, material);
      mesh.name = `RendHalo${i}`;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 18;
      mesh.frustumCulled = false;
      // Yaw last, so the tilt is a lean in the ring's own frame and the spin is
      // about the column. In the default XYZ order the two would compound and
      // the ring would wobble like a dropped coin.
      mesh.rotation.order = 'YXZ';
      mesh.visible = false;
      this.group.add(mesh);
      this.halos.push(mesh);
      this.haloMaterials.push(material);
    }

    /* ---- per-cast state ---- */
    /** Re-rolled per cast, so no two rends are cut the same way. */
    this._seed = 0;
    /** Seconds since the mark landed. Every beat below is a threshold on it. */
    this._markTime = 0;
    /** Metres of travel already paid out in ground marks. */
    this._markDistance = 0;
    /** Phase through the toll, and the envelope it produces. */
    this._pulsePhase = 0;
    this._pulse = 0;
    /** The kick the whole ability takes as something lands. Decays on its own. */
    this._flare = 0;
    /** Whether the rend itself has fired yet. */
    this._rent = false;
    /** How far the shards have wound the mark up, 0..1. */
    this._charge = 0;

    /**
     * The bodies this cascade has hold of.
     *
     * Pre-allocated and reused: a cast that catches six targets must not build
     * six objects, and `_markCount` is how many of these slots are live rather
     * than how long the array is.
     */
    this._marks = [];
    for (let i = 0; i < MAX_MARKS; i++) {
      this._marks.push({ dummy: null, time: 0, eaten: 0, emit: 0, felled: false, gone: false });
    }
    this._markCount = 0;
    /** Reused by `DummyField#findBodies`, so polling allocates nothing. */
    this._found = [];
    /** The blow that takes a body off its feet. Refilled from settings each frame. */
    this._force = { impulse: 0, lift: 0, spin: 0 };
    /**
     * How hard the light presses a held body down. Read by `_sampleHold`, which
     * runs once per joint of every body being judged and is not allowed to make
     * garbage.
     */
    this._hold = { press: 0 };
    /** Bound once: `Dummy#carry` is handed this for every body, every frame. */
    this._field = (x, y, z, out) => this._sampleHold(x, y, z, out);

    // Scratch handed to the materials each frame. One object apiece, reused —
    // syncing a standing cascade allocates nothing.
    this._sigilState = {
      radius: 1,
      quadSize: 1,
      grown: 0,
      front: 0,
      pulse: 0,
      flare: 0,
      shatter: 0,
      fade: 1,
      seed: 0
    };
    this._tendrilState = {
      centre: new Vector3(),
      radius: 1,
      height: 1,
      count: 1,
      grow: 0,
      pulse: 0,
      charge: 0,
      fade: 1,
      seed: 0
    };
    this._pillarState = {
      centre: new Vector3(),
      radius: 1,
      height: 1,
      grown: 0,
      front: 0,
      charge: 0,
      pulse: 0,
      fade: 1,
      seed: 0
    };
    this._starState = { centre: new Vector3(), size: 1, charge: 0, pulse: 0, fade: 1, seed: 0 };
    // Its own object, not the star's: the halos and the shards' key light are
    // both seated off `_starState.centre` further down this frame, and sharing
    // one scratch would move the rings to wherever the mote happens to be.
    this._seedState = { centre: new Vector3(), size: 1, charge: 0, pulse: 0, fade: 1, seed: 0 };
    this._haloState = { outer: 1, seat: 1, band: 1, open: 1, charge: 0, pulse: 0, fade: 1, seed: 0 };
    this._warpState = { centre: new Vector3(), radius: 1, height: 1, grown: 0, strength: 0 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The gold lifted off the mark, and what comes off a body as it goes.
    // Additive and climbing: everything in this ability rises.
    this.motes = particles.get('rend.motes', {
      capacity: 5000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.motes.uniforms.uDrag.value = 1.1;
    this.motes.uniforms.uEndSize.value = 0.12;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.06;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // Velocity-aligned sparks: the trail behind a shard coming in, and the
    // spray off one going into the stone. The only system here that is a line
    // rather than a dot, which is why the volley reads as fast.
    this.sparks = particles.get('rend.sparks', {
      capacity: 4200,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 2.2;
    this.sparks.uniforms.uEndSize.value = 0.24;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.02;
    this.sparks.uniforms.uFadeOut.value = 0.35;
    this.sparks.uniforms.uStretch.value = 0.45;

    // The floor coming up. Lit chips under real gravity — not additive, because
    // this is matter, and additive matter is a spark.
    this.chips = particles.get('rend.chips', {
      capacity: 2200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      stretch: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.6;
    this.chips.uniforms.uEndSize.value = 0.7;
    this.chips.uniforms.uSizeIn.value = 0.04;
    this.chips.uniforms.uFadeIn.value = 0.04;
    this.chips.uniforms.uFadeOut.value = 0.55;

    // The cloud the rend lifts. Non-additive, so it genuinely occludes — it is
    // the one pass here that has to read as matter rather than as light, and it
    // is what gives the column its scale at the foot.
    this.dust = particles.get('rend.dust', {
      capacity: 2600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.dust.uniforms.uDrag.value = 1.8;
    this.dust.uniforms.uEndSize.value = 3.0;
    this.dust.uniforms.uSizeIn.value = 0.14;
    this.dust.uniforms.uFadeIn.value = 0.2;
    this.dust.uniforms.uFadeOut.value = 0.32;

    this.moteEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
    this.trailEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get impactDuration() {
    return Math.max(0.05, settings.rend.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.rend.fadeTime);
  }

  /**
   * The light swells with the toll and kicks as something lands.
   *
   * `lightPulse` is how much of it the envelope owns: at 0 the column lights the
   * stage flat, at 1 it nearly goes out between swells.
   */
  lightShimmer() {
    const c = settings.rend;
    return 1 - c.lightPulse * 0.5 + c.lightPulse * this._pulse + this._charge * 0.35 + this._flare;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the circle indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.rend.zoneRadius);
  }

  /** Where the mote leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.rend;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The middle of the mark — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** The mote's travelling head. Pinned to the middle once it has arrived. */
  _frontPoint(out) {
    const c = settings.rend;
    if (this.phase === AbilityPhase.TRAVEL) {
      this.pointAt(this.u, out);
      out.y = lerp(c.handHeight, c.seedHeight, Easing.outQuad(this.u));
      return out;
    }
    this.pointAt(1, out);
    out.y = c.seedHeight;
    return out;
  }

  /** Seconds after the mark lands that the rend goes off. */
  get _rendAt() {
    const c = settings.rend;
    return Math.max(0.05, c.sigilTime + c.chargeTime);
  }

  /** How far the mark has cut itself out to the boundary, metres. */
  _sigilGrown() {
    const c = settings.rend;
    const grown = Easing.outQuint(saturate(this._markTime / Math.max(0.01, c.sigilTime)));
    // Past the rend it opens out past the circle: panel four's floor is wider
    // than panel one's sigil, and it is the same field either way.
    return this.radius * c.sigilStarOuter * grown * (1 + this._rendAmount() * 0.28);
  }

  /** How far the tendrils have come up, 0..1. */
  _tendrilGrow() {
    const c = settings.rend;
    return Easing.outCubic(
      saturate((this._markTime - c.tendrilDelay) / Math.max(0.01, c.tendrilTime))
    );
  }

  /** How tall the braid climbs right now, metres. */
  _tendrilHeight() {
    const c = settings.rend;
    // Before the rend the braid stands on its own at `tendrilCharge` of the
    // column's height; after it, it runs the whole column. The same number,
    // re-aimed — which is what makes layer 2 read as having been *waiting* for
    // layer 4 rather than as having been replaced by it.
    const height = this._pillarHeight();
    const reach = lerp(height * c.tendrilCharge, height * c.tendrilReach, this._rendAmount());
    return Math.max(0.5, reach);
  }

  /** 0..1 through the detonation itself. */
  _rendAmount() {
    const c = settings.rend;
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    return Easing.outQuint(
      saturate((this._markTime - this._rendAt) / Math.max(0.03, c.rendTime))
    );
  }

  /** How far up the shaft the beam has climbed, 0..1 of its own height. */
  _pillarGrown() {
    const c = settings.rend;
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    // Linear in time rather than eased: this is a front travelling at a speed,
    // and easing it makes the beam look like it is being stretched rather than
    // arriving.
    return saturate((this._markTime - this._rendAt) / Math.max(0.02, c.pillarRise));
  }

  /** The live height of the column, metres. */
  _pillarHeight() {
    return Math.max(1, settings.rend.pillarHeight);
  }

  /** The live radius of the column, metres. */
  _pillarRadius() {
    const c = settings.rend;
    return Math.max(0.05, this.radius * c.pillarRadius);
  }

  /** Where the star hangs, metres above the middle of the mark. */
  _starPoint(out) {
    const c = settings.rend;
    this._centrePoint(out);
    out.y =
      this._pillarHeight() * c.starSeat +
      Math.sin(frame.uTime.value * c.starBobSpeed * TAU + this._seed) * c.starBob;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.rend;

    this.moteEmitter.reset();
    this.sparkEmitter.reset();
    this.dustEmitter.reset();
    this.trailEmitter.reset();

    this._markTime = 0;
    this._markDistance = 0;
    this._flare = 0;
    this._charge = 0;
    this._rent = false;
    // Started somewhere arbitrary in the envelope, so two cascades standing at
    // once are never in step.
    this._pulsePhase = Math.random() * 40;
    this._pulse = 0;
    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    for (let i = 0; i < this._markCount; i++) {
      this._marks[i].dummy = null;
    }
    this._markCount = 0;
    this._found.length = 0;

    this._rollShards();

    this.sigil.visible = false;
    this.tendrils.visible = false;
    this.pillar.visible = false;
    this.warp.visible = false;
    this.star.visible = false;
    for (const halo of this.halos) halo.visible = false;
    for (const mesh of this.shardMeshes) mesh.count = 0;

    this._sync(1, 0);
    this._muzzleFx();
  }

  /**
   * Deal the shard field.
   *
   * Nothing here has a unit on it. `arrive` is the one exception and it is a
   * *fraction* of the charge window, not a timestamp — so dragging `chargeTime`
   * in the editor re-paces a volley that is already inbound rather than leaving
   * half of it stranded.
   */
  _rollShards() {
    const total = this.shards.length;
    for (let i = 0; i < total; i++) {
      const shard = this.shards[i];
      // Spread over the whole circle, but not evenly: a golden-angle walk with
      // jitter, so no two arrive on the same bearing and no wedge is empty.
      shard.bearing = i * 2.399963 + randRange(-0.35, 0.35) + this._seed;
      shard.orbitBearing = Math.random() * TAU;
      shard.seat = randRange(0.35, 1.0);
      shard.loft = randRange(0.12, 1.0);
      // Biased toward the end of the window: the hail is what the detonation
      // lands on top of. `arrive` counts *backward* from the rend, so clustering
      // the arrivals late means clustering this near zero — an exponent above
      // one, not below it. Below one it does the exact opposite and the volley
      // front-loads, which reads as weather that happens to stop.
      shard.arrive = Math.pow(Math.random(), 2.2);
      shard.travel = randRange(0.75, 1.25);
      shard.curve = randRange(-1, 1);
      shard.stagger = Math.pow(Math.random(), 1.6);
      shard.rise = randRange(0.55, 1.4);
      shard.size = randRange(0.6, 1.45);
      shard.tumbleX = randRange(-1, 1);
      shard.tumbleY = randRange(-1, 1);
      shard.tumbleZ = randRange(-1, 1);
      shard.phase = Math.random() * TAU;
      shard.dice = Math.random() * 10;
      // Dealt rather than grouped: the sheet's volley is gold with blue-white
      // scattered through it, and grouping would put a warm half and a cold half
      // on opposite sides of the circle.
      shard.tone = hash11(i * 3.7 + this._seed) < 0.32 ? 1 : 0;
      shard.struck = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame sync                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into every material and
   * every particle system.
   *
   * @param {number} fade      1 while the cascade stands, ramping to 0 as it goes
   * @param {number} collapse  0..1 through the close
   */
  _sync(fade, collapse) {
    const c = settings.rend;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(_centre);
    const radius = this.radius;
    const pulse = this._pulse * saturate(fade);
    const rend = this._rendAmount();

    /* ---- layer 1: the mark ---- */
    const sigil = this._sigilState;
    sigil.radius = radius;
    sigil.quadSize = radius * c.sigilStarOuter * 2.6 + 1.6;
    sigil.grown = travelling ? 0 : this._sigilGrown();
    // The leading edge is only live while the mark is still writing itself on.
    sigil.front = travelling ? 0 : 1 - saturate(this._markTime / Math.max(0.01, c.sigilTime));
    sigil.pulse = pulse;
    sigil.flare = this._flare;
    sigil.shatter = rend * fade;
    sigil.fade = travelling ? 0 : fade;
    sigil.seed = this._seed;
    this.sigilMaterial.userData.sync(sigil);

    this.sigil.visible = !travelling;
    this.sigil.position.set(_centre.x, c.sigilHeight, _centre.z);
    this.sigil.scale.set(sigil.quadSize, 1, sigil.quadSize);

    /* ---- layer 2: the tendrils ---- */
    const grow = travelling ? 0 : this._tendrilGrow() * (1 - saturate(collapse) * 0.85);
    const tendril = this._tendrilState;
    tendril.centre.copy(_centre);
    tendril.radius = radius;
    tendril.height = this._tendrilHeight();
    tendril.count = Math.min(MAX_TENDRILS, Math.max(1, Math.round(c.tendrils)));
    tendril.grow = grow;
    tendril.pulse = pulse;
    tendril.charge = this._charge;
    tendril.fade = fade;
    tendril.seed = this._seed;
    this.tendrilMaterial.userData.sync(tendril);
    this.tendrilGeometry.instanceCount = tendril.count;
    this.tendrils.visible = !travelling && grow > 0.002;

    /* ---- layer 4: the column ---- */
    const grown = this._pillarGrown();
    const standing = !travelling && rend > 0.002 && grown > 0.002;
    const height = this._pillarHeight();
    const shaft = this._pillarRadius() * lerp(0.35, 1, rend) * (1 - Easing.inQuad(saturate(collapse)) * 0.92);

    const pillar = this._pillarState;
    pillar.centre.copy(_centre);
    pillar.radius = shaft;
    pillar.height = height;
    pillar.grown = grown;
    // The hot leading edge, only while the front is still climbing.
    pillar.front = (1 - saturate(grown)) * rend;
    pillar.charge = this._charge;
    pillar.pulse = pulse;
    pillar.fade = fade * rend;
    pillar.seed = this._seed;
    this.pillarMaterial.userData.sync(pillar);
    this.pillar.visible = standing;

    const warp = this._warpState;
    warp.centre.copy(_centre);
    warp.radius = shaft * c.warpReach;
    warp.height = height;
    warp.grown = grown;
    warp.strength = rend * fade;
    this.warpMaterial.userData.sync(warp);
    this.warp.visible = standing;

    /* ---- the star at its head ---- */
    // Opened on its own clock, a beat behind the front reaching it: the star is
    // what the column *arrives* at, so it must not already be there.
    const opened = Easing.outBack(
      saturate((this._markTime - this._rendAt - c.starDelay) / Math.max(0.02, c.starTime))
    );
    const star = this._starState;
    this._starPoint(star.centre);
    star.size = Math.max(0.01, radius * c.starSize) * Math.max(0, opened) * (1 - saturate(collapse));
    star.charge = this._charge;
    star.pulse = pulse;
    star.fade = fade;
    star.seed = this._seed;
    this.starMaterial.userData.sync(star);
    // Not positioned: the vertex stage places it from `uCentre`, so the mesh
    // has to stay at the origin or the offset would be applied twice.
    this.star.visible = standing && star.size > 0.01;

    /* ---- the seed star: the same star, early and small ---- */
    // It rides the mote out to the point and then stands in the mark while the
    // shards come in, and it is swallowed by the column on the frame the rend
    // fires — the seed *becomes* the head of the beam.
    const seed = this._seedState;
    this._frontPoint(_pos);
    const seedSize = Math.max(0.01, radius * c.seedStarSize) *
      (travelling ? Easing.outQuad(saturate(this.age / 0.14)) : 1) *
      (1 - saturate(rend * 2.2));
    seed.centre.copy(_pos);
    seed.size = seedSize;
    seed.charge = this._charge;
    seed.pulse = pulse;
    seed.fade = fade;
    seed.seed = this._seed + 7.3;
    this.seedStarMaterial.userData.sync(seed);
    this.seedStar.visible = seedSize > 0.01;

    /* ---- the halo rings ---- */
    const halo = this._haloState;
    for (let i = 0; i < this.halos.length; i++) {
      const sense = i === 0 ? 1 : -1;
      const scale = i === 0 ? 1 : c.haloSecond;
      const open = saturate(
        (this._markTime - this._rendAt - c.haloDelay - i * c.haloStagger) /
          Math.max(0.02, c.haloTime)
      );

      const outer = Math.max(0.05, radius * c.haloRadius * scale) * (1 - saturate(collapse) * 0.7);
      halo.outer = outer;
      halo.seat = outer * c.haloSeat;
      halo.band = outer * c.haloBand;
      halo.open = open;
      halo.charge = this._charge;
      halo.pulse = pulse;
      halo.fade = fade;
      halo.seed = this._seed + i * 11.7;
      this.haloMaterials[i].userData.sync(halo);

      const mesh = this.halos[i];
      mesh.visible = standing && open > 0.002;
      mesh.position.set(
        star.centre.x,
        star.centre.y + (i === 0 ? c.haloLift : -c.haloLift) * radius,
        star.centre.z
      );
      // Laid down from the XY plane, leaned the opposite way from its partner,
      // and turned about the column. Two rings that lean the same way read as
      // one wide band; two that cross read as an orrery.
      mesh.rotation.set(
        -Math.PI / 2 + sense * c.haloTilt,
        frame.uTime.value * c.haloSpin * TAU * sense + this._seed,
        0
      );
    }

    /* ---- layer 3: the shard material ---- */
    this.shardMaterial.userData.sync();
    const beam = this.shardMaterial.userData.uniforms;
    beam.uBeam.value.set(_centre.x, star.centre.y * 0.5, _centre.z);

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
    this.motes.uniforms.uGlow.value = 1.8 * g.glow;
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
    this.sparks.uniforms.uGlow.value = 2.2 * g.glow;

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

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = c.dustSpeed * g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = 0.5 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Layer 3 — the shards                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Place every shard, and pay for the ones that arrive this frame.
   *
   * Two populations out of one pool, separated by the ability's own clock
   * rather than by a flag: before the rend a shard is **inbound**, after it the
   * same slot is a splinter that was **thrown clear** and is now turning in the
   * light. They can never contend for a slot, because a shard's arrival is by
   * construction before the rend and its throw is by construction after it.
   *
   * The inbound path is closed form — a bearing, a radius that collapses, and a
   * height that falls — so the editor can re-aim a volley that is already in
   * the air, and so a paused frame places the field exactly where an unpaused
   * one would.
   *
   * @param {number} dt
   * @param {number} fade
   */
  _updateShards(dt, fade) {
    const c = settings.rend;
    const g = settings.global;

    this._centrePoint(_centre);
    const radius = this.radius;
    const rendAt = this._rendAt;
    const now = this._markTime;
    const charge = Math.max(0.05, c.chargeTime);
    const height = this._pillarHeight();
    const density = saturate(c.shardDensity * g.particleCount);
    const scale = Math.max(0.01, c.shardSize);

    let struck = 0;

    for (let v = 0; v < SHARD_VARIANTS; v++) {
      const mesh = this.shardMeshes[v];
      const heat = this.shardHeat[v];
      const dice = this.shardSeed[v];
      const tone = this.shardTone[v];
      let used = 0;

      for (let i = 0; i < SHARD_SLOTS; i++) {
        const shard = this.shards[v * SHARD_SLOTS + i];
        // The density slider culls whole shards rather than shrinking them: a
        // field of half-size slivers reads as a field that is further away.
        if ((i + 0.5) / SHARD_SLOTS > density) continue;

        let live = 0;
        let scaleOf = 0;
        let heatOf = 0;

        if (now < rendAt) {
          /* ---- inbound ---- */
          const lands = rendAt - charge * shard.arrive;
          const flight = Math.max(0.12, c.shardFlight * shard.travel);
          const t = (now - (lands - flight)) / flight;
          if (t < 0 || t > 1) continue;

          // Accelerating: a shard that closes at a constant rate is a tracking
          // shot, and one that arrives faster than it left is a strike.
          const k = Easing.inQuad(saturate(t));
          const reach = radius * c.shardReach;
          const r = lerp(reach, radius * 0.06, k);
          const y = lerp(c.shardLoft * shard.loft * height * 0.35, c.seedHeight, k);
          // A little bow on the way in, so fifty slivers are not fifty radii.
          const angle = shard.bearing + shard.curve * c.shardCurve * (1 - k);

          _at.set(_centre.x + Math.cos(angle) * r, y, _centre.z + Math.sin(angle) * r);
          // Leading tip first: the geometry's +Y is the needle end, so the
          // instance is aligned to the direction it is actually travelling.
          _dir.set(_centre.x - _at.x, c.seedHeight - _at.y, _centre.z - _at.z);
          if (_dir.lengthSq() < 1e-6) _dir.set(0, -1, 0);
          _dir.normalize();

          live = 1;
          scaleOf = scale * shard.size * lerp(0.45, 1, saturate(t * 3));
          heatOf = Easing.inQuad(saturate((t - 0.45) / 0.55));

          _node.position.copy(_at);
          _node.quaternion.setFromUnitVectors(_UP, _dir);
          // Rolled about its own travel, so the facets turn as it comes in.
          _spin.setFromAxisAngle(_UP, shard.phase + now * c.shardRoll * TAU);
          _node.quaternion.multiply(_spin);
          _node.scale.set(scaleOf * c.shardGirth, scaleOf, scaleOf * c.shardGirth);

          this._trailFx(dt, _at, _dir, t);

          if (!shard.struck && t > 0.985) {
            shard.struck = true;
            struck++;
          }
        } else {
          /* ---- thrown clear, and turning in the light ---- */
          const age = now - rendAt - shard.stagger * Math.max(0, c.shardScatter);
          if (age < 0) continue;

          const k = Easing.outCubic(saturate(age / Math.max(0.05, c.shardSettle)));
          const seat = radius * c.shardOrbit * (0.35 + 0.65 * shard.seat);
          const r = lerp(radius * 0.12, seat, k);
          // Rising for as long as it lives, so the field slowly empties upward
          // rather than hanging in a fixed shell.
          const y =
            lerp(0.4, height * c.shardCeiling * shard.loft, k) + age * c.shardDrift * shard.rise;
          // Differential: the ones seated near the column lap the ones outside
          // them, which is the same rule the braid is wound by.
          const rate = c.shardSpin * (0.5 + 0.9 * (1 - shard.seat));
          const angle = shard.orbitBearing + age * rate;

          _at.set(_centre.x + Math.cos(angle) * r, y, _centre.z + Math.sin(angle) * r);

          live = 1;
          scaleOf = scale * shard.size * c.shardDebris;
          heatOf = 0.1 + 0.3 * this._pulse;

          _node.position.copy(_at);
          _axis.set(shard.tumbleX, shard.tumbleY, shard.tumbleZ);
          // Three dice can land on nothing; normalising that is a NaN matrix,
          // and one NaN instance takes the whole draw call with it.
          if (_axis.lengthSq() < 1e-6) _axis.set(0, 1, 0);
          _axis.normalize();
          _node.quaternion.setFromAxisAngle(_axis, shard.phase + age * c.shardTumble * TAU);
          _node.scale.set(scaleOf * c.shardGirth, scaleOf, scaleOf * c.shardGirth);
        }

        if (live <= 0) continue;

        _node.updateMatrix();
        mesh.setMatrixAt(used, _node.matrix);
        heat.array[used] = heatOf * fade;
        dice.array[used] = shard.dice;
        tone.array[used] = shard.tone;
        used++;
      }

      mesh.count = used;
      if (used > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        heat.needsUpdate = true;
        dice.needsUpdate = true;
        tone.needsUpdate = true;
      }
    }

    if (struck > 0) this._strikeFx(struck);
  }

  /**
   * The streak an inbound shard drags behind it.
   *
   * Paid out per shard per frame at a rate that rises with how far in it has
   * got, so the trail thickens as the sliver accelerates — which is the only
   * cue the eye has that it is speeding up, since a closing radius on a dark
   * floor is nearly unreadable on its own.
   */
  _trailFx(dt, at, dir, t) {
    const c = settings.rend;
    const g = settings.global;
    if (dt <= 0) return;

    const count = Math.round(
      this.trailEmitter.tick(dt, c.trailRate * (0.25 + t * t * 1.75)) * g.particleCount
    );
    if (count <= 0) return;

    _emit.position = at;
    _emit.radius = 0.06;
    // Backward down the run: the streak is where the shard has been.
    _emit.direction = _pos.copy(dir).multiplyScalar(-1);
    _emit.speed = c.sparkSpeed * 0.5;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.25;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.sparkSize * 0.8;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime * 0.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* The judgment                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Take hold of anything inside the reach that is not already held.
   *
   * Polled every frame rather than resolved once at the rend, because bodies
   * *move*: one thrown across the boundary by another cast has to be caught on
   * the frame it crosses, and one already lying inside the circle when the mark
   * lands is judged exactly like one that walked in. A cascade that took only
   * the living would be the one thing on this stage that reads as a rule rather
   * than as a light.
   *
   * Nothing is done to a body here. It is *marked* — and that is the whole
   * point of the first two panels.
   */
  _capture() {
    const field = this.ctx.dummies;
    if (!field?.findBodies) return;

    const c = settings.rend;
    this._centrePoint(_centre);
    const found = field.findBodies(_centre.x, _centre.z, this.radius * c.judge.reach, this._found);

    for (const dummy of found) {
      if (this._markCount >= MAX_MARKS) break;
      let held = false;
      for (let i = 0; i < this._markCount; i++) {
        if (this._marks[i].dummy === dummy) {
          held = true;
          break;
        }
      }
      if (held || dummy.finished) continue;

      const slot = this._marks[this._markCount++];
      slot.dummy = dummy;
      slot.time = 0;
      slot.eaten = 0;
      slot.emit = 0;
      // A body already lying there when the mark landed has no legs left to go
      // out from under it; it is simply burned where it is.
      slot.felled = !dummy.alive;
      slot.gone = false;
    }
  }

  /** Drop one held body, giving back whatever was taken from its solver. */
  _dropMark(index) {
    const slot = this._marks[index];
    slot.dummy?.release?.();
    slot.dummy = null;
    this._marks[index] = this._marks[this._markCount - 1];
    this._marks[this._markCount - 1] = slot;
    this._markCount--;
  }

  /**
   * The velocity of the light at one point — which is nothing sideways at all.
   *
   * Sampled once per joint of every body being judged, so it reads its state out
   * of `_hold` rather than taking it, and allocates nothing.
   *
   * The whole content of this function is the two zeroes. `Dummy#carry` steers
   * each joint *toward* the field, so a field of zero is a body whose sideways
   * momentum is scrubbed off every frame — which is the difference between a
   * corpse that collapses into its own footprint and one that slumps and then
   * slides half a metre down the slope of its own limbs. Half a metre is enough
   * to read as having been pushed, and being pushed is the one thing this
   * ability must never look like.
   *
   * The vertical is not zero and is not applied as hard: gravity is meant to
   * keep most of its say about how a body falls, and a light press downward is
   * what lays it flat instead of leaving it kneeling.
   */
  _sampleHold(_x, _y, _z, out) {
    out.set(0, -this._hold.press, 0);
  }

  /**
   * Put every marked body down, hold it there, and burn it away.
   *
   * The order is the point and it cannot be reordered:
   *
   *  1. **felled** — with an impulse of zero. `Ragdoll#strike` multiplies the
   *     impulse into every joint's horizontal velocity, so zero is a body whose
   *     legs simply stop holding it. It lands inside its own footprint.
   *  2. **held** — the sideways scrub above, every frame, for as long as it is
   *     being taken. A ragdoll is a relaxation solver and it *will* find a way
   *     to slide if nothing is asking it not to.
   *  3. **taken** — `Dummy#consume` driven up on a per-body stagger, so a
   *     circle of six does not go out on one frame. The light flares as each
   *     one finishes.
   *
   * @param {number} dt
   * @param {number} take how much of the rend has happened, 0..1
   */
  _judge(dt, take) {
    if (dt <= 0 || this._markCount === 0) return;

    const c = settings.rend;
    const jc = c.judge;
    this._centrePoint(_centre);

    this._force.impulse = jc.impulse;
    this._force.lift = jc.lift;
    this._force.spin = jc.spin;
    this._hold.press = jc.press;

    // How much of the gap between the body and a standstill is closed this
    // frame. Clamped through saturate, so it can never exceed 1 whatever dt is.
    const grab = saturate(jc.grab * dt);
    const grabY = saturate(jc.grabY * dt);

    for (let i = this._markCount - 1; i >= 0; i--) {
      const slot = this._marks[i];
      const dummy = slot.dummy;

      if (!dummy || dummy.finished) {
        this._dropMark(i);
        continue;
      }

      slot.time += dt;

      // Before the rend they are only marked. A trickle of gold off each one is
      // the whole of what the first two panels do to a body, and it is enough:
      // the shot reads as having chosen these people.
      if (take <= 0.001) {
        this._markedFx(dt, slot, dummy);
        continue;
      }

      /* ---- 1 · put down where it stands ---- */
      if (!slot.felled) {
        // A direction is still required — `kill` needs one to point the blow —
        // but with `impulse` at zero it scales nothing. The cast's own heading
        // keeps the argument meaningful if the impulse is ever dialled up.
        if (dummy.alive && !dummy.kill(this.direction.x, this.direction.z, this._force)) continue;
        slot.felled = true;
        slot.time = 0;
        this._condemnFx(dummy);
      }

      /* ---- 2 · held exactly there ---- */
      dummy.carry(this._field, grab, grabY, 0);

      /* ---- 3 · and taken ---- */
      // Staggered off the body's own position rather than a counter, so the
      // order is stable across frames and the same circle always goes out in
      // the same order.
      const stagger = hash11(dummy.position.x * 3.1 + dummy.position.z * 7.7 + this._seed) * jc.stagger;
      if (slot.time < stagger) continue;

      slot.eaten = Math.min(1, slot.eaten + jc.devour * take * dt);
      dummy.consume(slot.eaten);
      this._burningFx(dt, slot, dummy, slot.eaten);

      if (slot.eaten >= 1 && !slot.gone) {
        slot.gone = true;
        this._takenFx(dummy);
        this._dropMark(i);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The gather at the caster's hand as the mote leaves it. */
  _muzzleFx() {
    const c = settings.rend;
    const g = settings.global;

    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.3,
      intensity: c.muzzleIntensity,
      opacity: 0.5,
      fresnel: 2.2,
      displace: 0.4,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _pos;
    _emit.radius = 0.4;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.moteSpeed * 2.2;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.8;
    _emit.inherit = null;
    // Drawn onto the hand rather than thrown off it: the mark is *gathered*
    // before it is cast, which is the only way the throw reads as a release.
    _emit.anchor = _pos;
    _emit.size = c.moteSize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime * 0.5;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(c.castMotes * g.particleCount), _emit);
    _emit.anchor = null;

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /**
   * The mote on its way.
   *
   * Paid out per *metre travelled* rather than per second, so the trail has the
   * same density whatever `speed` is dragged to — a marks-per-second trail thins
   * out to nothing the moment the cast gets fast.
   */
  _travelFx(dt) {
    const c = settings.rend;
    const g = settings.global;
    const time = frame.uTime.value;

    this._frontPoint(_pos);

    const count = Math.round(
      this.moteEmitter.tick(dt, c.trailMotes * this.config.speed * 0.02) * g.particleCount
    );
    if (count > 0) {
      _emit.position = _pos;
      _emit.radius = 0.22;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.6).setY(0.5).normalize();
      _emit.speed = c.moteSpeed * 0.9;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.75;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.moteSize * 0.9;
      _emit.sizeVariance = 0.8;
      _emit.life = c.moteLifetime * 0.45;
      _emit.lifeVariance = 0.6;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(count, _emit);

      _emit.size = c.sparkSize * 0.8;
      _emit.speed = c.sparkSpeed * 0.6;
      _emit.life = c.sparkLifetime * 0.3;
      this.sparks.emit(Math.max(1, Math.round(count * 0.45)), _emit);
    }

    // The gilding the mote drags across the floor beneath it, laid down by
    // distance for the same reason.
    const travelled = this.u * this.length;
    if (travelled - this._markDistance < 1.6) return;
    this._markDistance = travelled;

    _pos.y = 0;
    this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
      radius: randRange(0.45, 0.8),
      life: 1.6,
      intensity: 0.3,
      colorA: getColor(c.colorSigilLine),
      colorB: getColor(c.colorSigilDeep),
      height: 0.014
    });
  }

  /** The mark cutting itself into the floor. */
  _markFx() {
    const c = settings.rend;
    const g = settings.global;
    const time = frame.uTime.value;

    const centre = this._centrePoint(_centre);

    this.ctx.bursts.spawn(BurstMode.AIR, centre, {
      radius: c.markBurst * 0.2,
      endRadius: c.markBurst * g.explosionIntensity,
      life: 0.42,
      intensity: c.markIntensity,
      opacity: 0.35,
      fresnel: 2.6,
      displace: 0.35,
      squash: 0.55, // flattened: pressure spreading over the floor
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
      radius: this.radius * 1.25 * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: 0.9,
      colorA: getColor(c.colorSigilCore),
      colorB: getColor(c.colorSigilLine)
    });

    this.ctx.decals.spawn(DecalType.SCORCH, centre, {
      radius: this.radius * 0.9,
      life: c.gildLife,
      intensity: c.gildIntensity,
      colorA: getColor(c.colorGild),
      colorB: getColor(c.colorGildEdge),
      height: 0.008
    });

    _emit.position = centre;
    _emit.radius = this.radius * 0.55;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 2.6;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.moteSize * 1.1;
    _emit.sizeVariance = 0.85;
    _emit.life = c.moteLifetime * 1.2;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.motes.emit(Math.round(c.markMotes * g.particleCount), _emit);

    this.ctx.shake.add(c.markShake * g.explosionIntensity * g.cameraShake, 4.5, 18);
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.markFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
    this._flare = 1;
  }

  /**
   * What a shard does to the stone it goes into.
   *
   * Fired once per frame for however many landed on it, rather than once per
   * shard: at the top of the hail eight arrive in a frame, and eight separate
   * shakes on one frame is one enormous shake with eight times the flash.
   *
   * @param {number} count how many arrived this frame
   */
  _strikeFx(count) {
    const c = settings.rend;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_centre);
    const at = _pos.set(_centre.x, c.seedHeight * 0.4, _centre.z);

    _emit.position = at;
    _emit.radius = this.radius * 0.22;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 1.7;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.sparkSize;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 0.8;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.strikeSparks * count * g.particleCount), _emit);

    _emit.speed = c.chipSpeed;
    _emit.spread = 0.85;
    _emit.size = c.chipSize;
    _emit.life = c.chipLifetime * 0.8;
    _emit.spin = c.chipSpin;
    this.chips.emit(Math.round(c.strikeChips * count * g.particleCount), _emit);
    _emit.spin = 0;

    this.ctx.shake.add(
      Math.min(c.strikeShake * count, c.strikeShake * 3) * g.explosionIntensity * g.cameraShake,
      6.0,
      26
    );
    this.lightBoost = Math.max(
      this.lightBoost,
      c.lightIntensity * 0.14 * count * g.explosionIntensity
    );
    this._flare = Math.max(this._flare, Math.min(1, 0.3 * count));
    // Every arrival winds the mark up a little further. This is what the star
    // in the middle and the tendrils are reading when they brighten.
    this._charge = saturate(this._charge + 0.055 * count);
  }

  /**
   * The rend — the frame the ability actually goes off.
   *
   * Everything here fires once, at the detonation, because the whole third beat
   * of this ability is that the column is *caused* by the mark going off rather
   * than by the cast landing.
   */
  _rendFx() {
    const c = settings.rend;
    const g = settings.global;
    const time = frame.uTime.value;

    const centre = this._centrePoint(_centre);
    const radius = this.radius;

    /* the shell that leaves the mark */
    this.ctx.bursts.spawn(BurstMode.AIR, _pos.set(centre.x, 0.6, centre.z), {
      radius: radius * 0.3,
      endRadius: radius * c.rendBurst * g.explosionIntensity,
      life: 0.55,
      intensity: c.rendIntensity,
      opacity: 0.4,
      fresnel: 2.4,
      displace: 0.5,
      squash: 0.62,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps out across the floor, past the boundary */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.9,
      width: 0.045,
      intensity: 1.1,
      colorA: getColor(c.colorSigilCore),
      colorB: getColor(c.colorSigilLine)
    });

    /* and the floor splitting under it */
    this.ctx.decals.spawn(DecalType.CRACK, centre, {
      radius: radius * c.crackRadius,
      life: c.crackLife,
      intensity: c.crackIntensity,
      growth: 0.35,
      colorA: getColor(c.colorCrack),
      colorB: getColor(c.colorCrackEdge),
      height: 0.014
    });

    this.ctx.decals.spawn(DecalType.DUSTRING, centre, {
      radius: radius * 1.5,
      life: 3.2,
      intensity: 0.45,
      colorA: getColor(c.colorDustB),
      colorB: getColor(c.colorDustC),
      height: 0.016
    });

    /* the gold thrown straight up the shaft */
    _emit.position = _pos.set(centre.x, 0.15, centre.z);
    _emit.radius = radius * c.pillarRadius * 1.1;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 4.5 * g.explosionIntensity;
    _emit.speedVariance = 0.6;
    // Kept tight: this is the column, and a wide cone reads as a firework.
    _emit.spread = 0.14;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.sparkSize * 1.3;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 2.2;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.rendSparks * g.particleCount), _emit);

    /* ... and the gold thrown out along the floor with the ring */
    _emit.radius = radius * 0.4;
    _emit.direction = _dir.set(0, 0.28, 0);
    _emit.speed = c.moteSpeed * 5.5 * g.explosionIntensity;
    _emit.spread = 1.0;
    _emit.size = c.moteSize * 1.2;
    _emit.life = c.moteLifetime * 1.4;
    this.motes.emit(Math.round(c.rendMotes * g.particleCount), _emit);

    /* the floor coming with it */
    _emit.position = _pos.set(centre.x, 0.1, centre.z);
    _emit.radius = radius * 0.55;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.chipSpeed * 1.6 * g.explosionIntensity;
    _emit.spread = 0.7;
    _emit.size = c.chipSize * 1.3;
    _emit.life = c.chipLifetime * 1.3;
    _emit.spin = c.chipSpin;
    this.chips.emit(Math.round(c.rendChips * g.particleCount), _emit);
    _emit.spin = 0;

    _emit.radius = radius * 0.85;
    _emit.speed = c.dustSpeed * 3.2;
    _emit.spread = 1.0;
    _emit.size = c.dustSize * 1.25;
    _emit.life = c.dustLifetime * 1.2;
    _emit.spin = 0.32;
    this.dust.emit(Math.round(c.rendDust * g.particleCount), _emit);
    _emit.spin = 0;

    this.ctx.shake.add(
      c.rendShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.rendFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.6 * g.explosionIntensity;
    this._flare = 1;
    this._charge = 1;
  }

  /** Everything the standing cascade keeps shedding. */
  _holdFx(dt, scale) {
    const c = settings.rend;
    const g = settings.global;
    const time = frame.uTime.value;
    if (scale <= 0.01 || dt <= 0) return;

    this._centrePoint(_centre);
    const radius = this.radius;
    const swell = 0.6 + 0.4 * this._pulse;
    const rend = this._rendAmount();

    // Motes lifted off the mark, over the whole footprint, pulled up the way the
    // tendrils go so the two layers agree about which way is out.
    const motes = Math.round(
      this.moteEmitter.tick(dt, c.moteRate * scale * swell * (0.4 + 0.6 * rend)) * g.particleCount
    );
    if (motes > 0) {
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.35;
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
        _pos.set(
          _centre.x + Math.cos(bearing) * at,
          randRange(0.04, 0.6),
          _centre.z + Math.sin(bearing) * at
        );
        _emit.position = _pos;
        _emit.radius = 0.12;
        this.motes.emit(Math.min(per, remaining), _emit);
        remaining -= per;
      }
    }

    if (rend < 0.05) return;

    // The column pouring upward. Emitted on the shaft's own wall rather than at
    // its axis, or the beam reads as having a hose in the middle of it.
    const sparks = Math.round(this.sparkEmitter.tick(dt, c.pillarSparks * scale * swell) * g.particleCount);
    if (sparks > 0) {
      const bearing = Math.random() * TAU;
      const wall = this._pillarRadius() * randRange(0.55, 1.05);
      _emit.position = _pos.set(
        _centre.x + Math.cos(bearing) * wall,
        randRange(0.1, 1.4),
        _centre.z + Math.sin(bearing) * wall
      );
      _emit.radius = 0.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.sparkSpeed * 3.2;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.1;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.sparkSize;
      _emit.sizeVariance = 0.75;
      _emit.life = c.sparkLifetime * 1.8;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(sparks, _emit);
    }

    // The bank the column stands in, kept low and wide. Its real job is to
    // break the boundary of the mark: a disc with a mathematically exact edge is
    // a decal, and a little dust wandering over it is what stops that edge from
    // being one.
    const dust = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dust > 0) {
      const bearing = Math.random() * TAU;
      _emit.position = _pos.set(
        _centre.x + Math.cos(bearing) * radius * c.dustSeat,
        randRange(0.05, 0.6),
        _centre.z + Math.sin(bearing) * radius * c.dustSeat
      );
      _emit.radius = radius * 0.22;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.size = c.dustSize;
      _emit.sizeVariance = 0.6;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.28;
      this.dust.emit(dust, _emit);
      _emit.spin = 0;
    }
  }

  /**
   * How many particles this body has earned since the last frame.
   *
   * Its own accumulator rather than one of the ability's `RateEmitter`s: those
   * are per *system*, and six bodies sharing one would each get a sixth of the
   * rate while the slider says otherwise. One float per held body is cheaper
   * than being wrong.
   */
  static _owed(slot, dt, rate) {
    slot.emit += Math.max(0, rate) * dt;
    const count = Math.floor(slot.emit);
    slot.emit -= count;
    return count;
  }

  /** The trickle off a body that has been marked and is waiting for it. */
  _markedFx(dt, slot, dummy) {
    const c = settings.rend;
    const g = settings.global;
    if (dt <= 0) return;

    const count = Math.round(
      CelestialRendAbility._owed(slot, dt, c.judge.markMotes) * g.particleCount
    );
    if (count <= 0) return;

    const at = dummy.alive ? dummy.position : dummy.bodyPoint(_at) ?? dummy.position;
    _emit.position = _pos.set(at.x, 0.05, at.z);
    _emit.radius = 0.42;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 0.8;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.2;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.moteSize * 0.8;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime * 0.8;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(count, _emit);
  }

  /** The frame a body's legs go out from under it. */
  _condemnFx(dummy) {
    const c = settings.rend;
    const g = settings.global;

    // Where it actually is. A body felled by another cast a moment earlier can
    // be metres from the spot it was placed at, and `position` is that spot.
    const at = dummy.bodyPoint(_at) ?? dummy.position;

    _emit.position = _pos.set(at.x, 0.9, at.z);
    _emit.radius = 0.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 0.9;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.sparkSize * 0.9;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.judge.condemnSparks * g.particleCount), _emit);

    // A ring of light closing on the spot it is standing in. Small, and on the
    // floor: what is happening to this body is happening *there*.
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos.set(at.x, 0, at.z), {
      radius: c.judge.condemnRing,
      life: 0.6,
      width: 0.06,
      intensity: 0.8,
      colorA: getColor(c.colorSigilCore),
      colorB: getColor(c.colorSigilLine)
    });
  }

  /** The burn itself, rising off a body while it goes. */
  _burningFx(dt, slot, dummy, eaten) {
    const c = settings.rend;
    const g = settings.global;
    if (dt <= 0) return;

    const at = dummy.bodyPoint(_at);
    if (!at) return;

    // Fiercest in the middle of the burn and gone by the end of it, so the
    // ashes stop before the body does rather than after.
    const gate = Math.sin(saturate(eaten) * Math.PI);
    const count = Math.round(
      CelestialRendAbility._owed(slot, dt, c.judge.burnMotes * gate) * g.particleCount
    );
    if (count <= 0) return;

    _emit.position = at;
    _emit.radius = 0.45;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 1.5;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.4;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.moteSize * 0.95;
    _emit.sizeVariance = 0.8;
    _emit.life = c.moteLifetime * 1.1;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(count, _emit);
  }

  /** The flare as a body finishes going. */
  _takenFx(dummy) {
    const c = settings.rend;
    const g = settings.global;

    const at = dummy.bodyPoint(_at) ?? dummy.position;
    _pos.copy(at);

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: 0.12,
      endRadius: c.judge.takenBurst * g.explosionIntensity,
      life: 0.32,
      intensity: 1.6,
      opacity: 0.3,
      fresnel: 2.8,
      displace: 0.4,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _pos;
    _emit.radius = 0.3;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 3.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.55;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.moteSize * 1.1;
    _emit.sizeVariance = 0.8;
    _emit.life = c.moteLifetime * 1.5;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(c.judge.takenMotes * g.particleCount), _emit);

    this.ctx.shake.add(c.judge.takenShake * g.explosionIntensity * g.cameraShake, 5.5, 22);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.45 * g.explosionIntensity);
    this._flare = Math.max(this._flare, 0.85);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._pulsePhase += dt * Math.max(0, settings.rend.pulseRate);
    this._pulse = tollEnvelope(this._pulsePhase);

    this._sync(1, 0);

    // The light rides the mote.
    this._frontPoint(this.position);

    this._travelFx(dt);
    this.ctx.shake.rumble(settings.rend.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    this._markTime = 0;
    this._markFx();
    // Picked up on the frame the sigil lands, so the marked motes start rising
    // off them immediately rather than a frame later.
    this._capture();
  }

  onFade(dt, t) {
    const c = settings.rend;
    const g = settings.global;
    const previous = this._markTime;
    this._markTime += dt;

    // `t` runs 0..1 while the cascade stands, then 1..2 while it closes.
    const collapse = t <= 1 ? 0 : saturate(t - 1);
    const fade = 1 - Easing.inQuad(collapse);

    /* ---- the toll, and the kick, before anything reads them ---- */
    this._pulsePhase += dt * Math.max(0, c.pulseRate);
    this._pulse = tollEnvelope(this._pulsePhase) * (1 - collapse * 0.5);
    this._flare = Math.max(0, this._flare - this._flare * 6.5 * dt - 0.35 * dt);

    /* ---- the one-shot the mark fires as it goes off ---- */
    const rendAt = this._rendAt;
    if (!this._rent && this._markTime >= rendAt && previous < rendAt && dt > 0) {
      this._rent = true;
      this._rendFx();
    }

    const rend = this._rendAmount();

    this._capture();
    this._updateShards(dt, fade);
    this._judge(dt, rend * fade);
    this._sync(fade, collapse);

    // The light climbs the shaft with the front: before the rend it is low in
    // the mark, and once the column is standing it sits partway up it, which is
    // what throws the cascade's gold onto the floor *and* onto the shards.
    this._centrePoint(this.position);
    this.position.y = lerp(
      0.5,
      this._pillarHeight() * c.lightHeight,
      rend * this._pillarGrown()
    );

    this._holdFx(dt, fade * (t <= 1 ? 1 : 0.4));
    this.ctx.shake.rumble(c.holdShake * rend * fade * g.cameraShake, dt);
  }

  onDestroy() {
    // Every body still being taken gets its solver back. Without this a cast
    // that is retired mid-judgment leaves a corpse whose sideways velocity is
    // being scrubbed by an ability that no longer exists.
    for (let i = this._markCount - 1; i >= 0; i--) this._dropMark(i);
    this._markCount = 0;
    this._found.length = 0;

    this.sigil.visible = false;
    this.tendrils.visible = false;
    this.pillar.visible = false;
    this.warp.visible = false;
    this.star.visible = false;
    this.seedStar.visible = false;
    for (const halo of this.halos) halo.visible = false;
    for (const mesh of this.shardMeshes) mesh.count = 0;

    this.sigilMaterial.uniforms.uFade.value = 0;
    this.tendrilMaterial.uniforms.uGrow.value = 0;
    this.pillarMaterial.uniforms.uFade.value = 0;
    this.starMaterial.uniforms.uFade.value = 0;
    this.seedStarMaterial.uniforms.uFade.value = 0;
    for (const material of this.haloMaterials) material.uniforms.uFade.value = 0;
  }

  dispose() {
    this.sigilGeometry.dispose();
    this.tendrilGeometry.dispose();
    this.pillarGeometry.dispose();
    this.starGeometry.dispose();
    this.haloGeometry.dispose();
    for (const mesh of this.shardMeshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }

    this.sigilMaterial.dispose();
    this.tendrilMaterial.dispose();
    this.pillarMaterial.dispose();
    this.warpMaterial.dispose();
    this.starMaterial.dispose();
    this.seedStarMaterial.dispose();
    this.shardMaterial.dispose();
    for (const material of this.haloMaterials) material.dispose();

    super.dispose();
  }
}
