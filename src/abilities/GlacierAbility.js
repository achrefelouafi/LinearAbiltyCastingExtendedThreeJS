import {
  InstancedMesh,
  InstancedBufferAttribute,
  Mesh,
  PlaneGeometry,
  CylinderGeometry,
  Object3D,
  Vector3,
  Quaternion
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createGlacierMaterial } from '../materials/GlacierMaterial.js';
import { createFrostFieldMaterial, createFrostVeilMaterial } from '../materials/FrostFieldMaterial.js';
import { createCrystalGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

/** Hard ceiling on shards per cast. The editor's count slider clamps to this. */
const MAX_SPIKES = 320;
/**
 * Distinct crystal shapes in the crown. Each is its own InstancedMesh — three
 * draw calls buys real silhouette variety that per-instance scaling alone
 * cannot, because the *facets* differ, not just the proportions.
 */
const VARIANTS = 3;
const SLOTS = Math.ceil(MAX_SPIKES / VARIANTS);
const TAU = Math.PI * 2;

/**
 * What a shard is for. The role decides where it stands, how tall it is, which
 * way it leans and — the part that carries the whole cast — *when* it goes up.
 */
const Role = Object.freeze({
  RING: 0, // the wall of blades on the boundary
  SKIRT: 1, // the broken shards banked against its foot, inside and out
  CORE: 2 // the spire in the middle — off by default, the middle stays clear
});

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _lean = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _spin = new Quaternion();
const _tilt = new Quaternion();

/** Shortest signed angle from `b` to `a`, radians, -π..π. */
function angleDelta(a, b) {
  const d = a - b;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * GLACIAL CROWN — the second **far cast**, and the one that comes out of the
 * floor. Reference for the look: `Hud7Xfg3LH.jpg`.
 *
 * The Voltaic Snare answers a circle with a cage of current standing *in* the
 * air. This one answers it with geometry: a cold front races along the floor to
 * the aimed point, the disc freezes outward to the boundary the indicator drew,
 * and a wall of crystal tears up out of the ground *around* it — a ring of
 * blades leaning outward with a skirt of wreckage banked against their feet —
 * which stands, glints, breathes cold off its rim, and then shatters plate by
 * plate and sinks back into the floor.
 *
 * The **middle stays open**. Every shard is seated in a band about `zoneRadius`
 * and nothing is planted in the centre of the footprint, because the read of the
 * ability is a wall you are looking *into*: fill the disc and the ring stops
 * being a ring. What lives inside it is air — snow falling through it, glitter
 * lifting off the sheet — and the frozen ground under that. The spire is kept as
 * a control (`coreShare`) but ships at zero.
 *
 * Four beats, though only three phases:
 *
 *   1. **travel** — the front runs out across the floor, laying rime as it goes.
 *   2. **bloom** — the first `snapTime` of the impact phase: the sheet freezes
 *      outward, and the ring erupts as a *sweep*. The blade nearest the caster
 *      goes first and the wave runs around both sides to meet at the far side,
 *      so the crown closes rather than appearing, with the skirt banking up
 *      against its feet behind the wave.
 *   3. **hold** — the rest of `lifetime`: the ice glints, a curtain of cold air
 *      spills off the rim, snow drifts down through it, rime creeps around the
 *      boundary and late shards keep pushing up through the sheet.
 *   4. **collapse** — the shards break into plates from the inside out, the
 *      wreckage sinks, and the sheet thaws back toward the middle.
 *
 * Everything is generated. The shards are procedural crystals shaded by
 * `materials/GlacierMaterial.js` (which owns the freeze front and the shatter),
 * the sheet and the curtain are two shaders in `materials/FrostFieldMaterial.js`
 * and the mist, chips, glitter and snow are GPU particles.
 *
 * **The rule that makes the editor work.** A shard record holds nothing but
 * dice — a role, a bearing, a unitless radial fraction and a handful of jitters.
 * Not one metre, radian or second is captured: the seat of the ring, the height
 * of a blade, the lean, the sheet and the curtain are all resolved against
 * `settings.glacier` inside the update loop, which runs on a zero-length frame
 * too. Dragging `zoneRadius` re-scales a crown that is already standing, with
 * the clock stopped.
 *
 * The only values a record *does* capture are timestamps — the moment its own
 * eruption was triggered. Those are events, not dimensions.
 */
export class GlacierAbility extends Ability {
  constructor(context) {
    super('glacier', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    this.material = createGlacierMaterial(environment);

    /** Signature of the geometry controls, so a rebuild only happens on a change. */
    this._shapeKey = '';

    this.meshes = [];
    this.seedAttributes = [];
    this.birthAttributes = [];
    this.growAttributes = [];
    this.shatterAttributes = [];

    for (let v = 0; v < VARIANTS; v++) {
      const geometry = this._buildGeometry(v);

      const seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const births = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const grows = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const shatters = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      for (let i = 0; i < SLOTS; i++) seeds.array[i] = Math.random() * 10;
      geometry.setAttribute('aSeed', seeds);
      geometry.setAttribute('aBirth', births);
      geometry.setAttribute('aGrow', grows);
      geometry.setAttribute('aShatter', shatters);

      const mesh = new InstancedMesh(geometry, this.material, SLOTS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid world geometry: it belongs in the depth prepass so the mist, the
      // snow and the curtain all fade softly where they intersect it.
      mesh.layers.set(LAYER.WORLD);
      mesh.renderOrder = 2;
      this.group.add(mesh);

      this.meshes.push(mesh);
      this.seedAttributes.push(seeds);
      this.birthAttributes.push(births);
      this.growAttributes.push(grows);
      this.shatterAttributes.push(shatters);
    }

    /* ---- the sheet of ice on the floor ---- */
    this.fieldGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.fieldMaterial = createFrostFieldMaterial();
    this.field = new Mesh(this.fieldGeometry, this.fieldMaterial);
    this.field.name = 'FrostField';
    this.field.layers.set(LAYER.VFX);
    this.field.renderOrder = 7; // over the decals, under the crystals
    this.field.frustumCulled = false;
    this.field.visible = false;
    this.group.add(this.field);

    /* ---- the curtain of cold air standing on the boundary ---- */
    // Open-ended unit cylinder: radius 1, height 1 about the origin, so placing
    // it is a scale and a lift. The flare and the billow happen in the shader.
    this.veilGeometry = new CylinderGeometry(1, 1, 1, 72, 12, true);
    this.veilMaterial = createFrostVeilMaterial();
    this.veil = new Mesh(this.veilGeometry, this.veilMaterial);
    this.veil.name = 'FrostVeil';
    this.veil.layers.set(LAYER.VFX);
    this.veil.renderOrder = 9;
    this.veil.frustumCulled = false;
    this.veil.visible = false;
    this.group.add(this.veil);

    /**
     * Fixed-size record pool — a cast allocates nothing.
     *
     * See the class comment: dice only, no dimensions.
     */
    this.records = [];
    for (let i = 0; i < MAX_SPIKES; i++) {
      this.records.push({
        role: Role.SKIRT,
        angle: 0, // bearing about the centre, radians
        radial: 0, // RING: -1..1 seat jitter. SKIRT: 0..1 across the band. CORE: 0..1 out
        late: false, // held back to push up during the hold
        rubble: false, // demoted to ankle-height wreckage
        heightJitter: 0,
        radiusJitter: 0,
        leanJitter: 0,
        fanJitter: 0, // -1..1 splay off its own radius
        yaw: 0,
        stagger: 0, // 0..1 of the per-role scatter
        eruptTime: -1, // absolute age it was triggered at, or -1
        breached: false,
        crumbled: false
      });
    }

    this._activeCount = 0;
    this._drawn = 0;
    /** Re-rolled per cast so no two crowns draw the same ring. */
    this._seed = 0;
    /** Seconds since the crown started opening. Drives the bloom, nothing else. */
    this._openTime = 0;
    /** Bearing the front arrived on — where the sweep starts. */
    this._entryAngle = 0;
    this._frostDistance = 0;

    // Scratch state handed to the two shaders each frame. One object apiece,
    // reused — syncing a standing crown allocates nothing.
    this._state = { centre: new Vector3() };
    this._fieldState = { radius: 1, quadSize: 1, freeze: 0, fade: 1, seed: 0 };
    this._veilState = { fade: 1, seed: 0 };
  }

  /** One crystal shape. Variant index only perturbs the seed. */
  _buildGeometry(variant) {
    const c = settings.glacier;
    return createCrystalGeometry({
      seed: 3.9 + variant * 17.3,
      sides: c.facets,
      taper: c.taper,
      roughness: c.roughness,
      bend: c.bend
    });
  }

  /**
   * Regenerate the crystal meshes when a *shape* control moves.
   *
   * Facet count, taper, roughness and bend cannot be expressed as a per-instance
   * transform, so they are baked into the geometry — and a six-sided crystal is
   * 108 triangles, cheap enough to simply rebuild rather than approximate in a
   * vertex shader. That is what keeps them live sliders.
   */
  _syncGeometry() {
    const c = settings.glacier;
    const key = `${Math.round(c.facets)}|${c.taper.toFixed(3)}|${c.roughness.toFixed(3)}|${c.bend.toFixed(3)}`;
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.meshes[v];
      const previous = mesh.geometry;
      const geometry = this._buildGeometry(v);
      // The per-instance attributes are state, not shape — carry them over.
      geometry.setAttribute('aSeed', this.seedAttributes[v]);
      geometry.setAttribute('aBirth', this.birthAttributes[v]);
      geometry.setAttribute('aGrow', this.growAttributes[v]);
      geometry.setAttribute('aShatter', this.shatterAttributes[v]);
      mesh.geometry = geometry;
      previous.dispose();
    }
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Cold air rolling off the ice. Non-additive: it has to *occlude*, which is
    // what gives the crown depth from the outside.
    this.mist = particles.get('glacier.mist', {
      capacity: 3600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.mist.uniforms.uDrag.value = 2.1;
    this.mist.uniforms.uEndSize.value = 3.6;
    this.mist.uniforms.uSizeIn.value = 0.1;
    this.mist.uniforms.uFadeIn.value = 0.14;
    this.mist.uniforms.uFadeOut.value = 0.28;

    // Chips torn off the shards as they punch through the floor, and again as
    // they break up.
    this.shards = particles.get('glacier.shards', {
      capacity: 3000,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.shards.uniforms.uDrag.value = 0.2;
    this.shards.uniforms.uEndSize.value = 0.8;
    this.shards.uniforms.uFadeOut.value = 0.74;

    // The glitter lifting off the field — the same read as the Frost Lance's
    // plume, kept inside the ring here.
    this.glitter = particles.get('glacier.glitter', {
      capacity: 3000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.glitter.uniforms.uDrag.value = 1.1;
    this.glitter.uniforms.uEndSize.value = 0.18;
    this.glitter.uniforms.uSizeIn.value = 0.05;
    this.glitter.uniforms.uFadeIn.value = 0.06;
    this.glitter.uniforms.uFadeOut.value = 0.35;

    // This ability's signature system: ice dust falling *through* the crown from
    // above it. Everything else in the project is thrown upward, and a slow fall
    // inside the ring is what says the air over it is freezing rather than
    // burning.
    this.snow = particles.get('glacier.snow', {
      capacity: 2600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.snow.uniforms.uDrag.value = 1.6;
    this.snow.uniforms.uEndSize.value = 0.5;
    this.snow.uniforms.uSizeIn.value = 0.08;
    this.snow.uniforms.uFadeIn.value = 0.12;
    this.snow.uniforms.uFadeOut.value = 0.5;

    this.mistEmitter = new RateEmitter();
    this.glitterEmitter = new RateEmitter();
    this.snowEmitter = new RateEmitter();
    this.rimeEmitter = new RateEmitter();
    this.vapourEmitter = new RateEmitter();
    this.ringEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._drawn;
  }

  /** The crown blooms, then stands. */
  get impactDuration() {
    return Math.max(0.2, settings.glacier.lifetime * settings.global.lifetime);
  }

  /** The collapse: a stagger, then the break-up and the sink. */
  get fadeDuration() {
    const c = settings.glacier;
    return Math.max(0.2, c.shatterDelay + c.shatterStagger + c.sinkTime);
  }

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.glacier.zoneRadius);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The centre of the crown — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Where the front leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.glacier;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /**
   * How far the sheet has spread, 0..1 of the boundary.
   *
   * A pure function of `_openTime` against the live `snapTime`, so the bloom
   * re-times itself if the slider moves mid-cast.
   */
  _openAmount() {
    const snap = Math.max(0.02, settings.glacier.snapTime);
    return Easing.outCubic(saturate(this._openTime / snap));
  }

  /** How far the thaw has eaten back into the sheet, 0..1. */
  _thawAmount() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    const c = settings.glacier;
    const hold = c.shatterDelay * 0.35;
    return saturate((this.fadeTime - hold) / Math.max(0.05, this.fadeDuration - hold));
  }

  /** Where a shard stands, at the live footprint settings. */
  _spikePosition(record, c, out) {
    const centre = this._state.centre;
    const R = this.radius;
    let r;

    if (record.role === Role.RING) {
      r = R * (c.ringSeat + record.radial * c.ringScatter);
    } else if (record.role === Role.CORE) {
      r = R * c.coreSpread * record.radial;
    } else {
      // A band around the wall, not a disc: the middle of the crown is meant to
      // stay open, so the wreckage banks up against the ring on both sides of it
      // rather than filling the footprint.
      r = R * (c.skirtSeat + Math.pow(record.radial, c.skirtBias) * c.skirtBand);
    }

    return out.set(centre.x + Math.cos(record.angle) * r, 0, centre.z + Math.sin(record.angle) * r);
  }

  /**
   * Full height of a shard, metres.
   *
   * The ring's height is modulated by two harmonics of its own bearing, seeded
   * per cast: a wall of blades all the same height reads as a fence, and the
   * uneven crest is most of what makes the silhouette look grown rather than
   * placed.
   */
  _spikeHeight(record, c, g) {
    let h;

    if (record.role === Role.RING) {
      const wave =
        Math.sin(record.angle * 3 + this._seed) * 0.62 +
        Math.sin(record.angle * 5 - this._seed * 2.1) * 0.38;
      h = c.ringHeight * (1 + c.ringWave * wave);
    } else if (record.role === Role.CORE) {
      h = c.coreHeight * lerp(1, 0.55, record.radial);
    } else {
      // Tallest where it meets the wall and tapering away on both sides, so the
      // skirt reads as ice heaved up by the ring rather than as a second one.
      h = c.skirtHeight * lerp(0.55, 1.2, 1 - Math.abs(record.radial - 0.5) * 2);
    }

    h *= 1 + record.heightJitter * c.heightJitter * g.randomness;
    if (record.rubble) h *= c.rubbleScale;

    return Math.max(0.02, h);
  }

  /** Base radius of a shard, metres. */
  _spikeRadius(record, c, g) {
    const role = record.role === Role.RING ? 1 : record.role === Role.CORE ? 1.35 : 0.85;
    const jitter = 1 + record.radiusJitter * c.radiusJitter * g.randomness;
    return Math.max(0.01, c.radius * role * jitter * (record.rubble ? 1.3 : 1));
  }

  /** How far a shard leans away from the middle, radians. */
  _spikeLean(record, c, g) {
    const base =
      record.role === Role.RING ? c.ringLean : record.role === Role.CORE ? c.coreLean : c.skirtLean;
    return base * (1 + record.leanJitter * c.leanJitter * g.randomness);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.glacier;

    this.mistEmitter.reset();
    this.glitterEmitter.reset();
    this.snowEmitter.reset();
    this.rimeEmitter.reset();
    this.vapourEmitter.reset();
    this.ringEmitter.reset();

    this._frostDistance = 0;
    this._openTime = 0;
    // The one thing a cast captures, besides the timestamps below.
    this._seed = Math.random() * 100;
    // The sweep starts on the near side: the bearing from the centre back toward
    // the caster, which is the bearing the front arrives on.
    this._entryAngle = Math.atan2(-this.direction.z, -this.direction.x);

    const wanted = Math.min(MAX_SPIKES, Math.max(1, Math.round(c.spikeCount * c.density)));
    const ringCount = Math.round(wanted * saturate(c.ringShare));
    const coreCount = Math.round(wanted * saturate(c.coreShare));
    const lateCount = Math.round(wanted * saturate(c.lateShare));

    this._activeCount = wanted;

    for (let i = 0; i < wanted; i++) {
      const record = this.records[i];

      record.eruptTime = -1;
      record.breached = false;
      record.crumbled = false;
      record.yaw = Math.random() * TAU;
      record.stagger = Math.random();
      record.heightJitter = randRange(-1, 1);
      record.radiusJitter = randRange(-1, 1);
      record.leanJitter = randRange(-1, 1);
      record.fanJitter = randRange(-1, 1);

      if (i < ringCount) {
        record.role = Role.RING;
        // Evenly stepped around the circle with a jittered stride, so the wall
        // has no gaps but never looks stamped.
        record.angle = ((i + randRange(-0.4, 0.4)) / Math.max(1, ringCount)) * TAU;
        record.radial = randRange(-1, 1);
        record.rubble = Math.random() < c.rubble * 0.35;
      } else if (i < ringCount + coreCount) {
        record.role = Role.CORE;
        record.angle = Math.random() * TAU;
        record.radial = Math.sqrt(Math.random());
        record.rubble = false;
      } else {
        record.role = Role.SKIRT;
        record.angle = Math.random() * TAU;
        // Flat across the band. The skirt is an annulus, not a disc, so the
        // sqrt() that keeps a disc evenly dense would only bias it outward.
        record.radial = Math.random();
        record.rubble = Math.random() < c.rubble;
      }

      // Only the skirt is held back. Sharing the wall out over the hold
      // would break the sweep, which is the read the whole bloom is built on.
      record.late = record.role === Role.SKIRT && i >= wanted - lateCount;
    }

    for (let i = wanted; i < MAX_SPIKES; i++) this.records[i].eruptTime = -1;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    this._drawn = 0;

    this.field.visible = false;
    this.veil.visible = false;

    this._sync(1);
    this._muzzleFx();
  }

  /**
   * Hand every shard the moment it goes up.
   *
   * Timestamps, not dimensions — the same allowance `IceAbility` takes. The
   * shape of the wave is the whole bloom: the ring sweeps around from the near
   * side, the skirt follows it outward, the spire (if any) comes up last, and
   * late bloomers are scattered across the hold.
   */
  _scheduleEruption() {
    const c = settings.glacier;
    const hold = Math.max(0.2, c.lifetime * settings.global.lifetime);

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      let delay;

      if (record.late) {
        delay = hold * (0.12 + record.stagger * saturate(c.bloomSpread));
      } else if (record.role === Role.RING) {
        // 0 on the near side, 1 at the far side — the two arms of the wave meet
        // behind the crown.
        const around = Math.abs(angleDelta(record.angle, this._entryAngle)) / Math.PI;
        delay = around * c.sweepTime + record.stagger * c.stagger;
      } else if (record.role === Role.CORE) {
        delay = c.coreDelay + record.stagger * c.stagger;
      } else {
        delay = c.skirtDelay + record.radial * c.skirtWave + record.stagger * c.stagger;
      }

      record.eruptTime = this.age + delay;
    }
  }

  /* ------------------------------------------------------------------ */
  /* The eruption                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * How far out of the ground a shard is, 0 → 1 with a springy overshoot past 1.
   * Returns a negative number while it is still buried and waiting.
   */
  _emergence(record, c) {
    if (record.eruptTime < 0) return -1;
    const elapsed = this.age - record.eruptTime;
    if (elapsed < 0) return -1;

    const riseTime = Math.max(0.02, c.riseTime);
    const rise = Easing.outQuint(saturate(elapsed / riseTime));
    if (elapsed <= riseTime) return rise;

    // The punch-through carries past full height and settles back.
    const after = elapsed - riseTime;
    const spring = Math.sin(after * 14) * Math.exp(-after / Math.max(0.05, c.settle));
    return 1 + c.riseOvershoot * spring;
  }

  /** How far the ice has crystallised up the shard's own axis, 0..1. */
  _growth(record, c) {
    if (record.eruptTime < 0) return 0;
    const elapsed = this.age - record.eruptTime;
    // Finished just before the shard tops out, so the freeze front is still
    // travelling while the body is still moving.
    return saturate(elapsed / Math.max(0.02, c.riseTime * 0.85));
  }

  /** How far a shard has broken up, 0..1. Only ever non-zero in the collapse. */
  _shatterAmount(record, c) {
    if (this.phase !== AbilityPhase.FADE) return 0;
    const delay = c.shatterDelay + record.stagger * c.shatterStagger;
    return saturate((this.fadeTime - delay) / Math.max(0.05, c.sinkTime));
  }

  /**
   * Rebuild every instance matrix and per-instance attribute from the live
   * settings.
   */
  _updateSpikes() {
    const c = settings.glacier;
    const g = settings.global;
    const birthFade = Math.max(0.02, c.birthFade);
    const used = [0, 0, 0];

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      const variant = i % VARIANTS;
      const slot = (i / VARIANTS) | 0;
      const emerge = this._emergence(record, c);

      if (emerge < 0) {
        // Still buried. Park it outside the view rather than drawing a
        // degenerate matrix at the origin.
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
        this.birthAttributes[variant].array[slot] = 0;
        this.growAttributes[variant].array[slot] = 0;
        this.shatterAttributes[variant].array[slot] = 0;
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      const height = this._spikeHeight(record, c, g);
      const radius = this._spikeRadius(record, c, g);
      const shatter = this._shatterAmount(record, c);

      /* --- chips as it breaks the surface, and again as it breaks up --- */
      if (!record.breached && emerge > 0.22) {
        record.breached = true;
        this._breachFx(record, c, g, radius);
      }
      if (!record.crumbled && shatter > 0.12) {
        record.crumbled = true;
        this._crumbleFx(record, c, g, radius, height);
      }

      /* --- lean: thrown outward, and fanned off its own radius --- */
      // The fan is what makes the wall a starburst instead of a picket line:
      // neighbouring blades are splayed to either side of the radius they stand
      // on, so they cross in front of each other as they go over.
      const bearing = record.angle + record.fanJitter * c.fan;
      _lean.set(Math.cos(bearing), 0, Math.sin(bearing));
      if (_lean.lengthSq() < 1e-6) _lean.copy(this.direction);
      _lean.normalize();

      // Rotating about (up × lean) tips the crystal's own +Y toward `lean`.
      _axis.crossVectors(_up, _lean).normalize();
      _tilt.setFromAxisAngle(_axis, this._spikeLean(record, c, g));
      _spin.setFromAxisAngle(_up, record.yaw * c.twist);
      _tilt.multiply(_spin);

      /* --- slide it up out of the floor, and drop it back in as it goes --- */
      const settled = Math.min(1, emerge);
      this._spikePosition(record, c, _dummy.position);
      _dummy.position.y = (emerge - 1) * height * 0.9;
      if (shatter > 0) {
        _dummy.position.y -= Easing.inCubic(shatter) * (height * 0.45 + radius + 0.3);
      }

      _dummy.quaternion.copy(_tilt);
      _dummy.scale.set(radius, height, radius).multiplyScalar(lerp(0.86, 1, settled));
      _dummy.updateMatrix();

      this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
      this.birthAttributes[variant].array[slot] = saturate(
        1 - (this.age - record.eruptTime) / birthFade
      );
      this.growAttributes[variant].array[slot] = this._growth(record, c);
      this.shatterAttributes[variant].array[slot] = shatter;
      used[variant] = Math.max(used[variant], slot + 1);
    }

    this._drawn = 0;
    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.birthAttributes[v].needsUpdate = true;
      this.growAttributes[v].needsUpdate = true;
      this.shatterAttributes[v].needsUpdate = true;
      this._drawn += used[v];
    }
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into the crystal
   * material, the sheet, the curtain and the four particle systems.
   *
   * @param {number} fade 1 while the crown stands, ramping to 0 as it goes
   */
  _sync(fade) {
    const c = settings.glacier;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(this._state.centre);
    this._syncGeometry();
    this.material.userData.sync();

    const centre = this._state.centre;
    const radius = this.radius;
    const open = travelling ? 0 : this._openAmount();
    const thaw = this._thawAmount();
    const freeze = open * (1 - thaw);

    /* --- the sheet --- */
    const fieldState = this._fieldState;
    fieldState.radius = radius;
    fieldState.quadSize = (radius + c.fieldBoundary + 0.8) * 2;
    fieldState.freeze = freeze;
    fieldState.fade = fade;
    fieldState.seed = this._seed;
    this.fieldMaterial.userData.sync(fieldState);

    this.field.visible = !travelling && freeze > 0.002 && fade > 0.002;
    this.field.position.set(centre.x, c.fieldHeight, centre.z);
    this.field.scale.set(fieldState.quadSize, 1, fieldState.quadSize);

    /* --- the curtain --- */
    const veilHeight = Math.max(0.05, c.veilHeight * Easing.outCubic(open));
    const veilState = this._veilState;
    veilState.fade = fade * (1 - thaw);
    veilState.seed = this._seed;
    this.veilMaterial.userData.sync(veilState);

    this.veil.visible = !travelling && c.veil > 0.001 && open > 0.02 && veilState.fade > 0.004;
    this.veil.position.set(centre.x, veilHeight * 0.5, centre.z);
    this.veil.scale.set(radius * c.veilRadius, veilHeight, radius * c.veilRadius);
    this.veil.rotation.y = this._seed + this.age * c.veilSpin * TAU;

    /* --- the four particle systems --- */
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
    this.mist.uniforms.uTurbulence.value = c.mistTurbulence * g.turbulence;

    this.shards.setGradient(
      getColor(c.colorShardA),
      getColor(c.colorShardB),
      getColor(c.colorShardC),
      getColor(c.colorShardD)
    );
    this.shards.uniforms.uGravity.value.set(0, c.shardGravity, 0);
    this.shards.uniforms.uSizeScale.value = c.shardSize * g.particleSize * 7;
    this.shards.uniforms.uLifeScale.value = g.particleLifetime;
    this.shards.uniforms.uSpeedScale.value = g.particleSpeed;
    this.shards.uniforms.uOpacity.value = g.opacity;

    this.glitter.setGradient(
      getColor(c.colorGlitterA),
      getColor(c.colorGlitterB),
      getColor(c.colorGlitterC),
      getColor(c.colorGlitterD)
    );
    this.glitter.uniforms.uGravity.value.set(0, c.glitterRise, 0);
    this.glitter.uniforms.uSizeScale.value = c.glitterSize * g.particleSize * 7;
    this.glitter.uniforms.uLifeScale.value = c.glitterLifetime * 0.5 * g.particleLifetime;
    this.glitter.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glitter.uniforms.uOpacity.value = g.opacity;
    this.glitter.uniforms.uGlow.value = c.glitterGlow * g.glow;
    this.glitter.uniforms.uTurbulence.value = c.glitterTurbulence * g.turbulence;

    this.snow.setGradient(
      getColor(c.colorSnowA),
      getColor(c.colorSnowB),
      getColor(c.colorSnowC),
      getColor(c.colorSnowD)
    );
    // Negative: this is the one system in the project that is falling.
    this.snow.uniforms.uGravity.value.set(0, c.snowFall, 0);
    this.snow.uniforms.uSizeScale.value = c.snowSize * g.particleSize * 7;
    this.snow.uniforms.uLifeScale.value = c.snowLifetime * 0.5 * g.particleLifetime;
    this.snow.uniforms.uSpeedScale.value = g.particleSpeed;
    this.snow.uniforms.uOpacity.value = g.opacity;
    this.snow.uniforms.uGlow.value = c.snowGlow * g.glow;
    this.snow.uniforms.uTurbulence.value = c.snowTurbulence * g.turbulence;
  }

  /** The puff at the caster's hand as the front leaves it. */
  _muzzleFx() {
    const c = settings.glacier;
    const g = settings.global;

    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.45,
      intensity: c.muzzleIntensity,
      opacity: 0.75,
      fresnel: 1.4,
      displace: 0.5,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _pos;
    _emit.radius = 0.18;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.6).setY(0.4).normalize();
    _emit.speed = c.shardSpeed * 0.9;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.7;
    _emit.life = c.shardLifetime * 0.8;
    _emit.lifeVariance = 0.5;
    _emit.spin = 7;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.shards.emit(Math.round(20 * g.particleCount), _emit);

    _emit.speed = c.glitterSpeed * 0.8;
    _emit.spread = 0.9;
    _emit.size = 0.09;
    _emit.life = c.glitterLifetime * 0.7;
    _emit.spin = 0;
    this.glitter.emit(Math.round(30 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /** Fog, glitter and rime laid under the front while it races out. */
  _frontFx(dt) {
    const c = settings.glacier;
    const g = settings.global;
    const time = frame.uTime.value;

    /* --- fog boiling off the freezing floor --- */
    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * 0.5) * g.particleCount);
    if (mistCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.12);
      _emit.radius = 0.5;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime * 0.8;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.5;
      _emit.tint = null;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }

    /* --- glitter thrown up off the fracture --- */
    const glitterCount = Math.round(
      this.glitterEmitter.tick(dt, c.glitterRate * 0.4) * g.particleCount
    );
    if (glitterCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.3);
      _emit.radius = 0.4;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.glitterSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.glitterLifetime * 0.8;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.glitter.emit(glitterCount, _emit);
    }

    /* --- rime laid on the floor as the front passes over it --- */
    const frostStep = 1 / Math.max(0.05, c.trailFrostRate);
    while (this.front - this._frostDistance >= frostStep) {
      this._frostDistance += frostStep;
      const s = saturate(this._frostDistance / this.length);
      this.pointAt(s, _pos);
      _pos.x += this.side.x * randRange(-0.9, 0.9);
      _pos.z += this.side.z * randRange(-0.9, 0.9);

      this.ctx.decals.spawn(DecalType.FROST, _pos, {
        radius: c.trailFrostRadius * randRange(0.55, 1.1),
        life: c.frostLife * 0.8,
        width: c.frostCrystals,
        intensity: c.frostIntensity,
        colorA: getColor(c.colorFrost),
        colorB: getColor(c.colorFrostEdge)
      });
    }
  }

  /** Chips and a puff where a shard breaks the surface. */
  _breachFx(record, c, g, radius) {
    const time = frame.uTime.value;

    this._spikePosition(record, c, _pos).setY(0.08);

    _emit.position = _pos;
    _emit.radius = radius * 0.9;
    // Chips are thrown outward, away from the middle of the crown — the same
    // direction the shard itself leans.
    _emit.direction = _dir
      .set(Math.cos(record.angle) * 0.55, 1, Math.sin(record.angle) * 0.55)
      .normalize();
    _emit.speed = c.shardSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.shardLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 7;
    _emit.tint = null;
    _emit.time = time;
    this.shards.emit(Math.round(c.breachShards * g.particleCount), _emit);

    // Only some shards puff: a few hundred steaming at once buries the crown in
    // haze and hides the silhouette that is the whole point.
    if (Math.random() < 0.35) {
      _emit.speed = c.mistSpeed * 0.8;
      _emit.spread = 1.0;
      _emit.size = 0.55;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime * 0.7;
      _emit.spin = 0.5;
      this.mist.emit(Math.round(2 * g.particleCount), _emit);
    }

    // A collar of rime around the foot of a ring blade, so the wall is seated on
    // the ground rather than stuck through it.
    if (record.role === Role.RING && Math.random() < 0.5) {
      this._spikePosition(record, c, _pos);
      this.ctx.decals.spawn(DecalType.FROST, _pos, {
        radius: radius * c.frostCollar * randRange(0.7, 1.3),
        life: c.frostLife,
        width: c.frostCrystals,
        intensity: c.frostIntensity * 0.9,
        colorA: getColor(c.colorFrost),
        colorB: getColor(c.colorFrostEdge)
      });
    }
  }

  /** The burst of plates when a shard starts to come apart. */
  _crumbleFx(record, c, g, radius, height) {
    const time = frame.uTime.value;

    this._spikePosition(record, c, _pos).setY(height * 0.45);

    _emit.position = _pos;
    _emit.radius = radius * 1.1;
    _emit.direction = _dir
      .set(Math.cos(record.angle) * 0.7, 0.7, Math.sin(record.angle) * 0.7)
      .normalize();
    _emit.speed = c.shardSpeed * 0.75;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.8;
    _emit.life = c.shardLifetime * 1.2;
    _emit.lifeVariance = 0.5;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = time;
    this.shards.emit(Math.round(c.shatterShards * g.particleCount), _emit);

    if (Math.random() < 0.5) {
      _emit.speed = c.glitterSpeed * 0.6;
      _emit.spread = 1.0;
      _emit.size = 0.07;
      _emit.life = c.glitterLifetime;
      _emit.spin = 0;
      this.glitter.emit(Math.round(6 * g.particleCount), _emit);
    }
  }

  /**
   * Everything the standing crown sheds: cold spilling off the rim, snow through
   * the middle, glitter off the sheet, rime creeping around the boundary,
   * vapour shells off the wall and pressure rings across the floor.
   *
   * @param {number} scale 0..1 — thinned out as the crown collapses
   */
  _fieldFx(dt, scale) {
    const c = settings.glacier;
    const g = settings.global;
    const time = frame.uTime.value;
    const centre = this._state.centre;
    const radius = this.radius;
    const open = this._openAmount();

    /* --- cold air pouring off the rim and out across the floor --- */
    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (mistCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.75, 1.05);
      _pos.set(centre.x + Math.cos(a) * r, randRange(0.05, 0.5), centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.18;
      // Outward and barely up: this is heavy air falling off a wall of ice, not
      // smoke rising off a fire.
      _emit.direction = _dir.set(Math.cos(a), 0.18, Math.sin(a)).normalize();
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.6;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.85;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }

    /* --- glitter lifting off the sheet --- */
    const glitterCount = Math.round(
      this.glitterEmitter.tick(dt, c.glitterRate * scale) * g.particleCount
    );
    if (glitterCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random());
      _pos.set(centre.x + Math.cos(a) * r, randRange(0.05, 0.6), centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.15;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.glitterSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.8;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.glitterLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.glitter.emit(glitterCount, _emit);
    }

    /* --- and ice dust falling back through it --- */
    const snowCount = Math.round(this.snowEmitter.tick(dt, c.snowRate * scale) * g.particleCount);
    if (snowCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * c.snowInset * Math.sqrt(Math.random());
      _pos.set(
        centre.x + Math.cos(a) * r,
        c.ringHeight * c.snowHeight * open,
        centre.z + Math.sin(a) * r
      );
      _emit.position = _pos;
      _emit.radius = radius * 0.25;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.snowSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.7;
      _emit.life = c.snowLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.snow.emit(snowCount, _emit);
    }

    /* --- rime creeping around the boundary --- */
    const rimeCount = this.rimeEmitter.tick(dt, c.rimeRate * scale);
    for (let i = 0; i < rimeCount; i++) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.7, 1.05);
      _pos.set(centre.x + Math.cos(a) * r, 0, centre.z + Math.sin(a) * r);
      this.ctx.decals.spawn(DecalType.FROST, _pos, {
        radius: c.rimeRadius * randRange(0.7, 1.3),
        life: c.frostLife,
        width: c.frostCrystals,
        intensity: c.frostIntensity,
        colorA: getColor(c.colorFrost),
        colorB: getColor(c.colorFrostEdge)
      });
    }

    /* --- vapour shells shed off the wall --- */
    // Kept low and squashed on purpose: a shell released halfway up the blades
    // hangs in the air as a glass dome, and it needs the floor under it to read
    // as cold coming off the ice rather than as a bubble parked in mid-air.
    const vapourCount = this.vapourEmitter.tick(dt, c.vapourRate * scale);
    for (let i = 0; i < vapourCount; i++) {
      const a = Math.random() * TAU;
      _pos.set(
        centre.x + Math.cos(a) * radius * randRange(0.5, 0.95),
        c.ringHeight * randRange(0.05, 0.3) * open,
        centre.z + Math.sin(a) * radius * randRange(0.5, 0.95)
      );
      this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
        radius: c.vapourSize * 0.3,
        endRadius: c.vapourSize * g.explosionIntensity,
        life: 0.75,
        intensity: c.vapourIntensity,
        opacity: 0.28,
        fresnel: 1.8,
        displace: 0.55,
        squash: 0.5,
        colorA: getColor(c.colorBurstA),
        colorB: getColor(c.colorBurstB),
        colorC: getColor(c.colorBurstC)
      });
    }

    /* --- pressure rings pushed out across the floor --- */
    const ringCount = this.ringEmitter.tick(dt, c.ringRate * scale);
    for (let i = 0; i < ringCount; i++) {
      this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
        radius: radius * 1.08,
        life: 0.8,
        width: 0.05,
        intensity: 0.55,
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
    this._updateSpikes();

    // The light rides the front, a little off the floor.
    this.position.y = 0.35;

    this._frontFx(dt);
    this.ctx.shake.rumble(settings.glacier.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.glacier;
    const g = settings.global;
    const time = frame.uTime.value;

    this._openTime = 0;
    this._scheduleEruption();
    this._centrePoint(_pos);
    _pos.y = 0.5;

    /* the shell of freezing vapour thrown off as the sheet snaps outward */
    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.9,
      intensity: c.burstIntensity,
      opacity: 0.8,
      fresnel: 1.4,
      displace: 0.6,
      squash: 0.6,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor, past the boundary */
    this._centrePoint(_pos);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.8,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* the sheet of rime the crown is seated on */
    this.ctx.decals.spawn(DecalType.FROST, _pos, {
      radius: this.radius * c.frostSpread,
      life: c.frostLife * 1.4,
      width: c.frostCrystals,
      intensity: c.frostIntensity,
      colorA: getColor(c.colorFrost),
      colorB: getColor(c.colorFrostEdge)
    });

    /* chips, fog and glitter blown out of the bloom */
    this._centrePoint(_pos).setY(0.4);
    _emit.position = _pos;
    _emit.radius = this.radius * 0.5;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.shardSpeed * 1.7;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.15;
    _emit.sizeVariance = 0.8;
    _emit.life = c.shardLifetime * 1.3;
    _emit.lifeVariance = 0.5;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = time;
    this.shards.emit(Math.round(c.burstShards * g.particleCount), _emit);

    _emit.radius = this.radius * 0.8;
    _emit.speed = c.mistSpeed * 2.2;
    _emit.spread = 1.0;
    _emit.size = 1.3;
    _emit.life = c.mistLifetime * 1.3;
    _emit.spin = 0.6;
    this.mist.emit(Math.round(c.burstMist * g.particleCount), _emit);

    _emit.radius = this.radius * 0.6;
    _emit.speed = c.glitterSpeed * 1.5;
    _emit.spread = 0.9;
    _emit.size = 0.1;
    _emit.life = c.glitterLifetime * 1.2;
    _emit.spin = 0;
    this.glitter.emit(Math.round(c.burstGlitter * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      21
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.glacier;
    this._openTime += dt;

    // `t` runs 0..1 while the crown stands, then 1..2 while it collapses. The
    // sheet and the curtain are carried out by the thaw inside `_sync`, so the
    // fade here only has to take the last of the alpha with it.
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));

    this._sync(fade);
    this._updateSpikes();

    // The light climbs into the crown and stays there.
    this._centrePoint(this.position);
    this.position.y = c.ringHeight * saturate(c.lightHeight) * this._openAmount();

    this._fieldFx(dt, fade * (t <= 1 ? 1 : 0.35));
    this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._activeCount = 0;
    this._drawn = 0;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    this.field.visible = false;
    this.veil.visible = false;
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.material.dispose();
    this.fieldGeometry.dispose();
    this.fieldMaterial.dispose();
    this.veilGeometry.dispose();
    this.veilMaterial.dispose();
    super.dispose();
  }
}
