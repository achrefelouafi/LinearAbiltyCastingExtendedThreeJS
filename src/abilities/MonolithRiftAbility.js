import { InstancedBufferAttribute, InstancedMesh, Object3D, Quaternion, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import {
  createMonolithMaterial,
  createDebrisMaterial
} from '../materials/MonolithStoneMaterial.js';
import {
  createMonolithGeometry,
  createDebrisGeometry,
  monolithVariantOptions
} from '../assets/MonolithGeometry.js';
import { RiftCrater } from '../effects/RiftCrater.js';
import { RiftFissures } from '../effects/RiftFissures.js';
import { KineticWarp } from '../effects/KineticWarp.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, smoothstep, Easing, randRange } from '../utils/math.js';

/** Hard ceiling on standing stones per cast. The editor's count sliders clamp to this. */
const MAX_STONES = 280;
/**
 * Distinct slab silhouettes — see `monolithVariantOptions`. Each is its own
 * InstancedMesh, which is five draw calls for the one kind of variety a
 * per-instance matrix cannot buy: the *proportions of the footprint* differ, so
 * the cluster contains walls and blades and blocks rather than one shape at
 * five sizes.
 */
const VARIANTS = 5;
/**
 * Instance capacity *per silhouette*, not per cast divided by five.
 *
 * Which mesh a stone draws from is chosen by its tier — the hero slabs want the
 * flat walls, the skirt wants the blocks — so it is not a function of the record
 * index, and a whole cast is free to land on one silhouette. Striding the slots
 * would then write several records into the same slot of the same mesh and only
 * the last of them would appear. Each mesh therefore carries room for the whole
 * cast, and a spawn hands out slots with a counter. It costs five matrix buffers
 * of 280 entries — under a hundred kilobytes, once, for the lifetime of the app.
 */
const SLOTS = MAX_STONES;

/** Airborne chunks per cast, and how many distinct lumps they are drawn from. */
const MAX_SHRAPNEL = 96;
const DEBRIS_VARIANTS = 3;
const DEBRIS_SLOTS = Math.ceil(MAX_SHRAPNEL / DEBRIS_VARIANTS);

const TAU = Math.PI * 2;

/**
 * What a stone in the terminal cluster is.
 *
 * Three populations doing three jobs. Reading the reference as one uniform
 * pincushion of rocks is exactly what makes a procedural blast look like a
 * gravel pile: the silhouette is carried by a handful of enormous slabs, the
 * body by mid-sized ones, and the base by rubble whose only job is to stop the
 * big ones looking like they were pushed into the floor.
 */
const Tier = Object.freeze({
  /** The huge slabs that define the silhouette. */
  MONOLITH: 0,
  /** The body of the cluster. */
  SLAB: 1,
  /** The chunky skirt of blocks around the base. */
  BLOCK: 2
});

const _emit = {};
const _pos = new Vector3();
const _tip = new Vector3();
const _dir = new Vector3();
const _lean = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _spin = new Quaternion();
const _tilt = new Quaternion();
const _turn = new Quaternion();

/**
 * QUAKE — the Brutalist Earth Blast.
 *
 * A line cast built to the five-panel breakdown in the reference sheet, and
 * organised so each panel is one thing you can turn off in the editor and judge
 * on its own:
 *
 *   1. **MONOLITHS** — slabs of the floor sheared upward behind a fracture front
 *      and thrown into a standing cluster at the end. Real `MeshStandardMaterial`
 *      stone with a triplanar projection of a photographic scan: sun, shadows,
 *      IBL, occlusion. Nothing about them is emissive, which is the whole point
 *      — this is the one ability in the sandbox that is supposed to look like
 *      geology rather than like magic.
 *   2. **DUST** — the cement shockwave. A torus of heavy, lit, non-additive
 *      smoke that *rolls outward along the ground* at its own metres-per-second,
 *      plus the plume that climbs behind it.
 *   3. **SHRAPNEL** — real instanced rock, launched ballistically, tumbling,
 *      bouncing off the floor and coming to rest on it. Not billboards.
 *   4. **SCARS** — the floor cracked open: a heaved Voronoi crater at the
 *      impact and a network of dark fissures racing out from it.
 *   5. **KINETIC AIR** — a screen-space pressure ring expanding across the
 *      floor and a column of churning air over the blast, both written into the
 *      refraction buffer rather than drawn.
 *
 * ## The rule that makes the editor work
 *
 * A stone record stores only what the dice decided — a fraction along the line,
 * a signed lateral fraction, a bearing, a handful of unitless jitters. Not one
 * metre, radian or second is captured at spawn time; all of them are resolved
 * against `settings.quake` inside the update loop. Dragging `blastHeight`
 * therefore re-grows a cluster that is already standing, and does it with the
 * clock paused, which is when a silhouette is actually worth tuning.
 *
 * The exceptions are both genuine: **timestamps** (the moment a stone's own
 * eruption was triggered — an event, not a dimension) and the **shrapnel**,
 * which is an integrated ballistic simulation and therefore has to carry its own
 * position and velocity. Everything about how a chunk is *launched* still comes
 * from the settings at the moment it is thrown.
 */
export class MonolithRiftAbility extends Ability {
  constructor(context) {
    super('quake', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /* ---- layer 1: the monoliths ---- */
    this.material = createMonolithMaterial(environment);

    /** Signature of the geometry controls, so a rebuild only happens on a change. */
    this._shapeKey = '';

    this.meshes = [];
    this.seedAttributes = [];

    for (let v = 0; v < VARIANTS; v++) {
      const geometry = this._buildGeometry(v);

      const seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      for (let i = 0; i < SLOTS; i++) seeds.array[i] = Math.random() * 40;
      geometry.setAttribute('aSeed', seeds);

      const mesh = new InstancedMesh(geometry, this.material, SLOTS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid world geometry: it belongs in the depth prepass so the dust fades
      // softly where it intersects a slab instead of cutting a hard line on it.
      mesh.layers.set(LAYER.WORLD);
      this.group.add(mesh);

      this.meshes.push(mesh);
      this.seedAttributes.push(seeds);
    }

    /* ---- layer 3: the shrapnel ---- */
    this.debrisMaterial = createDebrisMaterial(environment);
    this.debrisMeshes = [];

    for (let v = 0; v < DEBRIS_VARIANTS; v++) {
      const geometry = createDebrisGeometry(2.3 + v * 5.9);
      const seeds = new InstancedBufferAttribute(new Float32Array(DEBRIS_SLOTS), 1);
      for (let i = 0; i < DEBRIS_SLOTS; i++) seeds.array[i] = Math.random() * 40;
      geometry.setAttribute('aSeed', seeds);

      const mesh = new InstancedMesh(geometry, this.debrisMaterial, DEBRIS_SLOTS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.layers.set(LAYER.WORLD);
      this.group.add(mesh);
      this.debrisMeshes.push(mesh);
    }

    /* ---- layer 4: the broken floor ---- */
    this.crater = new RiftCrater(environment);
    this.group.add(this.crater.mesh);

    this.fissures = new RiftFissures();
    this.group.add(this.fissures.mesh);

    /* ---- layer 5: the air ---- */
    this.warp = new KineticWarp();
    this.group.add(this.warp.group);

    /**
     * Fixed-size record pools — a cast allocates nothing.
     * See the class comment: dice only, no dimensions.
     */
    this.records = [];
    for (let i = 0; i < MAX_STONES; i++) {
      this.records.push({
        blast: false, // held back for the cluster at the far end
        tier: Tier.SLAB,
        along: 0, // 0..1 down the cast line
        lateral: 0, // -1..1 across the band, before clumping
        scatter: 0, // -1..1 extra lateral jitter
        angle: 0, // cluster bearing, radians
        radial: 0, // cluster distance from the centre, 0..1
        heightJitter: 0,
        radiusJitter: 0,
        leanJitter: 0, // how far past the nominal cant this one goes
        bearingJitter: 0, // and which way it tips, off the outward bearing
        yaw: 0,
        variant: 0, // which silhouette it draws
        slot: 0, // its instance index within that silhouette's mesh
        stagger: 0, // 0..1 of `riseStagger`
        eruptTime: -1, // absolute age it was triggered at, or -1
        breached: false // has it thrown its dust yet
      });
    }

    /**
     * The shrapnel. Position and velocity are integrated, so unlike every other
     * record in this file these carry metres — a ballistic arc cannot be
     * re-derived from dice after the fact. What they do *not* carry is anything
     * the editor owns: gravity, bounce, friction and size are all read from the
     * settings on the frame they are used.
     */
    this.chunks = [];
    for (let i = 0; i < MAX_SHRAPNEL; i++) {
      this.chunks.push({
        live: false,
        resting: false,
        age: 0,
        position: new Vector3(),
        velocity: new Vector3(),
        orientation: new Quaternion(),
        spinAxis: new Vector3(0, 1, 0),
        spinRate: 0,
        size: 1
      });
    }

    this._activeCount = 0;
    this._blastStart = MAX_STONES;
    this._liveChunks = 0;
    this._dustCoat = 0;
  }

  /** One slab silhouette. */
  _buildGeometry(variant) {
    return createMonolithGeometry(monolithVariantOptions(variant, settings.quake));
  }

  /**
   * Regenerate the slab meshes when a *shape* control moves.
   *
   * Footprint count, taper, flatten, chip, shear and bevel cannot be expressed
   * as a per-instance transform, so they are baked into the geometry — and a
   * slab is under a hundred triangles, cheap enough to rebuild outright rather
   * than approximate in a vertex shader. That is what keeps them live sliders.
   */
  _syncGeometry() {
    const c = settings.quake;
    const key = `${Math.round(c.sides)}|${c.taper.toFixed(3)}|${c.flatten.toFixed(3)}|${c.chip.toFixed(3)}|${c.shear.toFixed(3)}|${c.bevel.toFixed(3)}|${c.stoneBend.toFixed(3)}`;
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.meshes[v];
      const previous = mesh.geometry;
      const geometry = this._buildGeometry(v);
      // The per-instance seed is state, not shape — carry it over.
      geometry.setAttribute('aSeed', previous.getAttribute('aSeed'));
      mesh.geometry = geometry;
      previous.dispose();
    }
  }

  createParticles() {
    const particles = this.ctx.particles;

    /* ---- layer 2: the cement dust ---- */
    // Non-additive and *lit*: this cloud has to occlude the slabs behind it and
    // take the key light on one side. An additive version of it is a pale haze
    // the monoliths shine through, and the blast loses all of its depth — dust
    // is the only thing in the reference that is genuinely opaque.
    this.dust = particles.get('quake.dust', {
      capacity: 5200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      lit: true,
      softFade: 1.6
    });
    this.dust.uniforms.uDrag.value = 1.6;
    this.dust.uniforms.uSizeIn.value = 0.06;
    this.dust.uniforms.uFadeIn.value = 0.07;
    this.dust.uniforms.uFadeOut.value = 0.42;

    /* ---- layer 3: the fine stuff the big chunks leave behind ---- */
    this.grit = particles.get('quake.grit', {
      capacity: 3000,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.2
    });
    this.grit.uniforms.uDrag.value = 0.06;
    this.grit.uniforms.uEndSize.value = 0.85;
    this.grit.uniforms.uFadeIn.value = 0.02;
    this.grit.uniforms.uFadeOut.value = 0.86;

    // The fine powder still hanging in the air once the cloud has rolled past.
    // Additive and dim: this is sunlight caught in suspended dust, not a glow.
    this.motes = particles.get('quake.motes', {
      capacity: 2600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.5;
    this.motes.uniforms.uSizeIn.value = 0.1;
    this.motes.uniforms.uFadeIn.value = 0.14;
    this.motes.uniforms.uFadeOut.value = 0.4;

    this.dustEmitter = new RateEmitter();
    // The rolling ring gets its own accumulator: it runs on the same frames the
    // settling drift does, and two different rates sharing one accumulator each
    // eat the other's fractional remainder.
    this.ringEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.trickleEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._activeCount + this._liveChunks;
  }

  /** The cluster stands for its lifetime, then the fade takes it back down. */
  get impactDuration() {
    return Math.max(0.2, settings.quake.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    const c = settings.quake;
    return Math.max(0.2, c.sinkDelay + c.sinkTime);
  }

  /**
   * Dust does not glint and it does not gutter. The bounce light off a blast
   * *settles*: bright while the cloud is dense and dropping steadily after.
   */
  lightShimmer() {
    const c = settings.quake;
    return 1 - c.lightSettle * saturate(this.age * 0.35) + 0.03 * Math.sin(this.age * 2.7);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.quake;
    const g = settings.global;

    this.dustEmitter.reset();
    this.ringEmitter.reset();
    this.gritEmitter.reset();
    this.moteEmitter.reset();
    this.trickleEmitter.reset();
    this._scarDistance = 0;
    this._dustCoat = 0;
    this._liveChunks = 0;

    this.crater.hide();
    this.fissures.hide();
    this.warp.hide();
    for (const chunk of this.chunks) chunk.live = false;

    const wanted = Math.min(MAX_STONES, Math.max(1, Math.round(c.stoneCount * c.density)));
    const blastCount = Math.round(wanted * saturate(c.blastShare));
    this._activeCount = wanted;
    this._blastStart = wanted - blastCount;

    for (let i = 0; i < wanted; i++) {
      const record = this.records[i];
      const blast = i >= this._blastStart;

      record.blast = blast;
      record.eruptTime = -1;
      record.slot = 0;
      record.breached = false;
      record.yaw = Math.random() * TAU;
      record.stagger = Math.random();
      record.heightJitter = randRange(-1, 1);
      record.radiusJitter = randRange(-1, 1);
      record.leanJitter = randRange(-1, 1);
      record.bearingJitter = randRange(-1, 1);
      record.scatter = randRange(-1, 1);

      if (blast) {
        record.angle = Math.random() * TAU;
        record.along = 1;

        // Three populations, three jobs. `radial` is rolled per tier rather
        // than shared, because where a stone stands and what kind of stone it
        // is are the same decision — a monolith out at the rim is a fallen
        // tree, and a block in the middle is invisible.
        const roll = Math.random();
        if (roll < c.monolithShare) {
          record.tier = Tier.MONOLITH;
          record.radial = randRange(0.05, 0.5);
          // The flattest silhouettes: the hero slabs have to read as walls.
          record.variant = Math.random() < 0.7 ? 0 : 1;
        } else if (roll < c.monolithShare + c.blockShare) {
          record.tier = Tier.BLOCK;
          record.radial = lerp(0.5, 1.15, Math.sqrt(Math.random()));
          record.variant = 3 + ((Math.random() * 2) | 0);
        } else {
          record.tier = Tier.SLAB;
          // sqrt keeps the body evenly dense rather than piled in the middle.
          record.radial = Math.sqrt(Math.random()) * 0.95;
          record.variant = 1 + ((Math.random() * 3) | 0);
        }
      } else {
        record.tier = Math.random() < c.rubble ? Tier.BLOCK : Tier.SLAB;
        record.variant =
          record.tier === Tier.BLOCK ? 3 + ((Math.random() * 2) | 0) : (Math.random() * 3) | 0;
        // `frontBias` < 1 crowds the rift toward the impact point.
        record.along = Math.pow((i + Math.random()) / Math.max(1, this._blastStart), c.frontBias);
        record.lateral = randRange(-1, 1);
      }
    }

    // Hand out an instance slot per silhouette. See the note on SLOTS: the
    // variant is a tier decision, so this cannot be a stride off the index.
    const filled = [0, 0, 0, 0, 0];
    for (let i = 0; i < wanted; i++) {
      const record = this.records[i];
      const v = record.variant % VARIANTS;
      record.slot = filled[v]++;
    }

    for (let i = wanted; i < MAX_STONES; i++) this.records[i].eruptTime = -1;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    for (let v = 0; v < DEBRIS_VARIANTS; v++) this.debrisMeshes[v].count = 0;

    /* the cast itself — the floor giving way under the caster */
    this.ctx.decals.spawn(DecalType.DUSTRING, this.origin, {
      radius: c.widthNear * 3.0,
      life: c.scarLife * 0.4,
      width: 0.4,
      intensity: 0.5,
      colorA: getColor(c.colorDustCoat),
      colorB: getColor(c.colorScarA)
    });

    this.pointAt(0, _pos).setY(0.2);
    _emit.position = _pos;
    _emit.radius = 0.45;
    _emit.direction = _dir.copy(this.direction).setY(0.4).normalize();
    _emit.speed = c.dustSpeed * 1.3;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.8;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime * 0.55;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.4;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(Math.round(22 * g.particleCount), _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Resolving a stone — every metre, radian and second comes from here   */
  /* ------------------------------------------------------------------ */

  /** Half-width of the rift at `s` along the line, metres. */
  _halfWidth(s, c) {
    return lerp(c.widthNear, c.width, Math.pow(saturate(s), c.widthCurve));
  }

  /** Signed lateral offset of a rift stone, as a fraction of the half-width. */
  _lateralNorm(record, c) {
    const raw = record.lateral;
    // >1 pulls the rift in toward the centre line, which is what makes it read
    // as a seam splitting open rather than as a scattered field.
    const clumped = Math.sign(raw) * Math.pow(Math.abs(raw), c.clumping);
    return clumped + record.scatter * c.scatter;
  }

  /** Where a stone currently stands, at the live footprint settings. */
  _stonePosition(record, c, out) {
    if (record.blast) {
      const reach = c.blastRadius * record.radial;
      this.pointAt(1, out);
      out.x += Math.cos(record.angle) * reach;
      out.z += Math.sin(record.angle) * reach;
      return out;
    }

    this.pointAt(record.along, out);
    return out.addScaledVector(
      this.side,
      this._lateralNorm(record, c) * this._halfWidth(record.along, c)
    );
  }

  /** Full height of a stone, metres. */
  _stoneHeight(record, c, g) {
    let h;

    if (record.blast) {
      // Domed: tallest at the middle, falling away to the skirt.
      h = c.blastHeight * lerp(1, 1 - saturate(c.crown), Math.pow(record.radial, 1.25));
      if (record.tier === Tier.MONOLITH) h *= c.monolithScale;
      else if (record.tier === Tier.BLOCK) h *= c.blockScale;
    } else {
      h = lerp(c.heightNear, c.height, Math.pow(saturate(record.along), c.heightCurve));
      // The swell as the rift approaches the impact point.
      h *= 1 + (c.peak - 1) * smoothstep(1 - c.peakWidth, 1, record.along);
      // The flanks are shorter than the spine, so the band has a ridge line.
      h *= lerp(
        1,
        1 - saturate(c.crown),
        Math.pow(saturate(Math.abs(this._lateralNorm(record, c))), 1.4)
      );
      if (record.tier === Tier.BLOCK) h *= c.blockScale;
    }

    h *= 1 + record.heightJitter * c.heightJitter * g.randomness;
    return Math.max(0.02, h);
  }

  /** Footprint radius of a stone, metres. */
  _stoneRadius(record, c, g) {
    // Mass is the difference between concrete and quartz: a slab that is as
    // slender as an ice spike reads as a shard however it is textured, and the
    // reference's hero pieces are as wide as a door.
    let r = c.radius;
    if (record.blast) {
      r *= lerp(1.2, 0.72, record.radial);
      if (record.tier === Tier.MONOLITH) r *= c.monolithGirth;
      else if (record.tier === Tier.BLOCK) r *= 1.55;
    } else {
      r *= lerp(0.7, 1.15, Math.pow(saturate(record.along), 0.6));
      if (record.tier === Tier.BLOCK) r *= 1.5;
    }
    return Math.max(0.01, r * (1 + record.radiusJitter * c.radiusJitter * g.randomness));
  }

  /**
   * The direction this stone leans, written into `_lean`.
   *
   * The cluster is *not* a starburst. A crystal field opens like a hand, every
   * spike aimed away from the middle; ground that has been driven upward tips
   * whichever way its own fracture let it, with only a bias outward. So the
   * bearing is the outward direction rotated by the stone's own dice — that
   * scatter is most of what separates this silhouette from the Venom Surge's,
   * and turning `blastLeanScatter` to zero turns it straight back into one.
   */
  _stoneLean(record, c) {
    if (record.blast) {
      const bearing = record.angle + record.bearingJitter * c.blastLeanScatter;
      _lean.set(Math.cos(bearing), 0, Math.sin(bearing));
      // A monolith that cants as hard as the skirt does lies down flat, and the
      // one thing these have to do is stand.
      const outward = record.tier === Tier.MONOLITH ? record.radial * 0.5 : record.radial;
      return c.blastLean * Math.pow(saturate(outward), c.blastLeanCurve);
    }

    const outward = this._lateralNorm(record, c);
    // Along the rift the stones shear *backward*, away from the travelling
    // front — the floor is being levered up from underneath and behind.
    _lean.copy(this.direction).multiplyScalar(-0.55).addScaledVector(this.side, outward * 1.0);
    if (_lean.lengthSq() < 1e-6) _lean.copy(this.side);
    _lean.normalize();
    return c.lean * (0.35 + 0.65 * record.along);
  }

  /* ------------------------------------------------------------------ */
  /* The eruption                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Trigger every stone the fracture front has now reached.
   * `limit` is how far down the line the front has got, 0..1.
   */
  _triggerUpTo(limit, includeBlast) {
    const c = settings.quake;
    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      if (record.eruptTime >= 0) continue;
      if (record.blast && !includeBlast) continue;
      if (!record.blast && record.along > limit) continue;

      let delay = record.stagger * c.riseStagger;
      // The cluster opens from the inside out, so the hero slabs are already up
      // and throwing shadows by the time the skirt arrives.
      if (record.blast) delay += record.radial * c.blastStagger;
      record.eruptTime = this.age + delay;
    }
  }

  /**
   * How far out of the ground a stone is, 0 → 1 with a heavy overshoot past 1.
   * Negative while it is still buried and waiting.
   */
  _emergence(record, c) {
    if (record.eruptTime < 0) return -1;
    const elapsed = this.age - record.eruptTime;
    if (elapsed < 0) return -1;

    const riseTime = Math.max(0.02, c.riseTime);
    const rise = Easing.outQuint(saturate(elapsed / riseTime));
    if (elapsed <= riseTime) return rise;

    // The punch-through carries past full height and settles back. On stone
    // this wants to be slower and heavier than it is on crystal: a slab has
    // mass, and the thing that reads as mass is a long, low settle.
    const after = elapsed - riseTime;
    const spring = Math.sin(after * 11) * Math.exp(-after / Math.max(0.05, c.settle));
    return 1 + c.riseOvershoot * spring;
  }

  /**
   * Rebuild every instance matrix from the live settings.
   * @param {number} retract 0..1 — the whole field withdrawing into the floor.
   */
  _updateStones(dt, retract) {
    const c = settings.quake;
    const g = settings.global;
    const used = [0, 0, 0, 0, 0];

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      const variant = record.variant % VARIANTS;
      const slot = record.slot;
      const emerge = this._emergence(record, c);

      if (emerge < 0) {
        // Still buried. Park it out of view rather than drawing a degenerate
        // matrix at the origin.
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      const height = this._stoneHeight(record, c, g);
      const radius = this._stoneRadius(record, c, g);

      /* --- lean. Resolved before the breach dust, which aims along it --- */
      const leanAngle =
        this._stoneLean(record, c) * (1 + record.leanJitter * c.leanJitter * g.randomness);

      /* --- the dust thrown as it breaks the surface --- */
      if (!record.breached && emerge > 0.16) {
        record.breached = true;
        this._breachFx(record, c, g, radius, height);
      }

      // Rotating about (up × lean) tips the slab's own +Y toward `lean`.
      _axis.crossVectors(_up, _lean);
      if (_axis.lengthSq() < 1e-8) _axis.set(1, 0, 0);
      _axis.normalize();
      _tilt.setFromAxisAngle(_axis, leanAngle);
      _spin.setFromAxisAngle(_up, record.yaw * c.twist);
      _tilt.multiply(_spin);

      /* --- slide it up out of the floor --- */
      const settled = Math.min(1, emerge);
      this._stonePosition(record, c, _dummy.position);
      // 0.92 rather than 1: a slab keeps its root in the ground, and a stone
      // whose base clears the floor reads as an object dropped on it.
      _dummy.position.y = (emerge - 1) * height * 0.92;

      if (retract > 0) {
        const sink = Easing.inCubic(retract);
        _dummy.position.y -= sink * (height + radius + 0.6);
      }

      _dummy.quaternion.copy(_tilt);
      _dummy.scale.set(radius, height, radius).multiplyScalar(lerp(0.9, 1, settled));
      _dummy.updateMatrix();

      this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
      used[variant] = Math.max(used[variant], slot + 1);
    }

    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Layer 3 — the shrapnel                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Throw `count` chunks out of a point.
   *
   * Launched into a shallow cone rather than a sphere: the reference's debris is
   * a *fan* thrown up and out by a floor that failed downward-to-upward, and a
   * spherical spray reads as a grenade instead.
   */
  _launchShrapnel(count, origin, spreadRadius, speedScale) {
    const c = settings.quake;
    const g = settings.global;
    let thrown = 0;

    for (let i = 0; i < this.chunks.length && thrown < count; i++) {
      const chunk = this.chunks[i];
      if (chunk.live && !chunk.resting) continue;

      const bearing = Math.random() * TAU;
      const reach = spreadRadius * Math.sqrt(Math.random());
      chunk.position.set(
        origin.x + Math.cos(bearing) * reach,
        origin.y + randRange(0.1, 0.6),
        origin.z + Math.sin(bearing) * reach
      );

      // Outward and up, with the outward share rolled per chunk: a few go
      // nearly straight up and rain back down through the plume, which is what
      // keeps the fan from looking like it was fired from a single nozzle.
      const lift = lerp(c.shrapnelLift, 1.6, Math.random() * Math.random());
      const speed = c.shrapnelSpeed * speedScale * randRange(0.55, 1.35) * g.particleSpeed;
      chunk.velocity
        .set(Math.cos(bearing), 0, Math.sin(bearing))
        .multiplyScalar(randRange(0.35, 1.0) * c.shrapnelSpread)
        .setY(lift)
        .normalize()
        .multiplyScalar(speed);

      chunk.orientation.setFromAxisAngle(
        _axis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize(),
        Math.random() * TAU
      );
      chunk.spinAxis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize();
      chunk.spinRate = randRange(-1, 1) * c.shrapnelSpin;
      chunk.size = randRange(1 - c.shrapnelSizeJitter, 1 + c.shrapnelSizeJitter);
      chunk.age = 0;
      chunk.live = true;
      chunk.resting = false;
      thrown++;
    }
  }

  /**
   * Integrate the chunks and write their matrices.
   *
   * Semi-implicit Euler with a floor collision — restitution on the normal,
   * friction on the tangent, and a rest test that parks a chunk once it has
   * stopped moving so a hundred settled rocks cost nothing but their draw. They
   * are left lying where they land: the ground *keeps* the debris, which is
   * half of why the aftermath reads.
   */
  _updateShrapnel(dt, retract) {
    const c = settings.quake;
    const g = settings.global;
    const gravity = c.shrapnelGravity;
    const used = [0, 0, 0];
    let live = 0;

    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const variant = i % DEBRIS_VARIANTS;
      const slot = (i / DEBRIS_VARIANTS) | 0;

      if (!chunk.live) {
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.debrisMeshes[variant].setMatrixAt(slot, _dummy.matrix);
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      chunk.age += dt;
      live++;
      const radius = c.shrapnelSize * chunk.size * g.particleSize;

      if (!chunk.resting && dt > 0) {
        chunk.velocity.y += gravity * dt;
        chunk.position.addScaledVector(chunk.velocity, dt);

        if (chunk.position.y <= radius * 0.55) {
          chunk.position.y = radius * 0.55;
          if (chunk.velocity.y < 0) {
            const impact = -chunk.velocity.y;
            chunk.velocity.y = impact * c.shrapnelBounce;
            chunk.velocity.x *= c.shrapnelFriction;
            chunk.velocity.z *= c.shrapnelFriction;
            chunk.spinRate *= 0.55;
            // A chunk that hits hard kicks up its own puff of dust.
            if (impact > c.shrapnelPuffSpeed) this._impactPuff(chunk, c, g, impact);
            // Below a threshold it has stopped bouncing and is just jittering
            // against the floor, which looks worse than lying still.
            if (chunk.velocity.lengthSq() < 0.55) {
              chunk.resting = true;
              chunk.velocity.set(0, 0, 0);
              chunk.spinRate = 0;
            }
          }
        }

        if (chunk.spinRate !== 0) {
          _turn.setFromAxisAngle(chunk.spinAxis, chunk.spinRate * dt);
          chunk.orientation.premultiply(_turn);
        }
      }

      _dummy.position.copy(chunk.position);
      if (retract > 0) _dummy.position.y -= Easing.inCubic(retract) * (radius * 3 + 0.5);
      _dummy.quaternion.copy(chunk.orientation);
      _dummy.scale.setScalar(radius);
      _dummy.updateMatrix();
      this.debrisMeshes[variant].setMatrixAt(slot, _dummy.matrix);
      used[variant] = Math.max(used[variant], slot + 1);
    }

    this._liveChunks = live;
    for (let v = 0; v < DEBRIS_VARIANTS; v++) {
      this.debrisMeshes[v].count = used[v];
      this.debrisMeshes[v].instanceMatrix.needsUpdate = true;
    }
  }

  /** The puff a chunk kicks up where it lands. */
  _impactPuff(chunk, c, g, impact) {
    _emit.position = _pos.copy(chunk.position).setY(0.05);
    _emit.radius = 0.1;
    _emit.direction = _dir.set(randRange(-0.5, 0.5), 1, randRange(-0.5, 0.5)).normalize();
    _emit.speed = 0.5 + impact * 0.08;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.32;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime * 0.35;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.5;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(Math.round(2 * g.particleCount), _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  _syncUniforms() {
    const c = settings.quake;
    const g = settings.global;

    this._syncGeometry();
    this.material.userData.sync(this._dustCoat);
    this.debrisMaterial.userData.sync();

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    // Cement dust is *heavy*. A positive rise turns it into smoke, and smoke is
    // the single most common way a rock effect goes wrong.
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = c.dustSpeed * g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;
    this.dust.uniforms.uEndSize.value = c.dustSpread;
    this.dust.uniforms.uDrag.value = c.dustDrag;

    this.grit.setGradient(
      getColor(c.colorGritA),
      getColor(c.colorGritB),
      getColor(c.colorGritC),
      getColor(c.colorGritD)
    );
    this.grit.uniforms.uGravity.value.set(0, c.gritGravity, 0);
    this.grit.uniforms.uSizeScale.value = c.gritSize * g.particleSize * 7;
    this.grit.uniforms.uLifeScale.value = g.particleLifetime;
    this.grit.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grit.uniforms.uOpacity.value = g.opacity;
    this.grit.uniforms.uGlow.value = 1;

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteFall, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = c.moteOpacity * g.opacity;
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
  }

  /** Dust and grit where a stone breaks the surface. */
  _breachFx(record, c, g, radius, height) {
    const time = frame.uTime.value;
    this._stonePosition(record, c, _pos).setY(0.05);

    // A slab shoulders the floor aside: the dust goes *outward* off its base,
    // not up off its top. Aiming this upward is what makes an eruption look
    // like a smoke machine standing behind the rock.
    _emit.position = _pos;
    _emit.radius = radius * 1.15;
    _emit.direction = _dir.copy(_lean).setY(0.32).normalize();
    _emit.speed = c.dustSpeed * lerp(0.7, 1.5, saturate(height / Math.max(0.1, c.blastHeight)));
    _emit.speedVariance = 0.75;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.5 + radius * 1.6;
    _emit.sizeVariance = 0.55;
    _emit.life = c.dustLifetime * 0.8;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.45;
    _emit.tint = null;
    _emit.time = time;
    this.dust.emit(Math.round(c.breachDust * g.particleCount), _emit);

    _emit.direction = _dir.copy(_lean).multiplyScalar(0.5).setY(1).normalize();
    _emit.speed = c.gritSpeed;
    _emit.spread = 0.8;
    _emit.size = 0.06;
    _emit.sizeVariance = 0.8;
    _emit.life = c.gritLifetime;
    _emit.spin = 0;
    this.grit.emit(Math.round(c.breachGrit * g.particleCount), _emit);

    // Only the big ones get a ring on the floor. Two hundred of them is a grey
    // smear, and the mark is supposed to say "this one was heavy".
    if (radius > c.radius * 0.85 && Math.random() < 0.4) {
      this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
        radius: radius * 4.5,
        life: c.scarLife * 0.5,
        width: 0.5,
        intensity: 0.45,
        colorA: getColor(c.colorDustCoat),
        colorB: getColor(c.colorScarA)
      });
    }
  }

  /** Dust, grit and ground marks shed continuously along the travelling front. */
  _frontFx(dt) {
    const c = settings.quake;
    const g = settings.global;
    const time = frame.uTime.value;
    const halfWidth = this._halfWidth(this.u, c);

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate) * g.particleCount);
    if (dustCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.12);
      _emit.radius = halfWidth;
      // Leaning back down the line: the cloud is left *behind* the front, which
      // is what makes the front look fast.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.5).setY(1).normalize();
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate) * g.particleCount);
    if (gritCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.25);
      _emit.radius = halfWidth * 0.8;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.75;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }

    /* the marks left on the floor as the rift passes over it */
    const step = 1 / Math.max(0.05, c.scarRate);
    while (this.front - this._scarDistance >= step) {
      this._scarDistance += step;
      const s = saturate(this._scarDistance / this.length);
      const width = this._halfWidth(s, c);
      this.pointAt(s, _pos);
      _pos.x += this.side.x * randRange(-0.7, 0.7) * width;
      _pos.z += this.side.z * randRange(-0.7, 0.7) * width;

      // DUSTRING rather than CRACK. The CRACK decal draws *radial* fractures
      // with a hot glow, which is right for molten earth and wrong here twice
      // over: seen from above its spokes read as a starburst stamped on the
      // floor, and it runs its second colour stop at 1.8x while the mark is
      // fresh, so even a muted palette threw bright stars down the rift. The
      // cracks in this ability are real geometry — `RiftFissures` — so what is
      // left for the line to lay down is dirt, and DUSTRING is dirt.
      this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
        radius: width * c.scarSpread * randRange(0.6, 1.2),
        life: c.scarLife,
        width: c.scarWidth,
        intensity: c.scarIntensity,
        colorA: getColor(c.colorScarA),
        colorB: getColor(c.colorScarB)
      });
    }
  }

  /**
   * The cement dust shockwave — layer 2's headline.
   *
   * Emitted as a *ring* of jets rather than one omnidirectional puff: the
   * emission radius grows at its own metres-per-second and every jet fires
   * outward along its own bearing, so the cloud genuinely rolls away from the
   * impact and stays hollow in the middle. That hollow is the whole read. A
   * sphere of smoke expanding from a point is a fireball; a torus rolling
   * outward with the plume climbing behind it is a demolition.
   *
   * @param {number} t 0..1 through the roll
   */
  _rollFx(dt, t) {
    const c = settings.quake;
    const g = settings.global;
    const time = frame.uTime.value;

    const jets = Math.max(1, Math.round(c.ringJets));
    const perJet = Math.round((this.ringEmitter.tick(dt, c.ringRate) * g.particleCount) / jets);
    if (perJet <= 0) return;

    // Fast out, easing off — the wave loses to drag exactly as it spreads.
    const radius = c.ringRadius * g.explosionIntensity * Easing.outCubic(t);
    // Thinning as it goes: the wall of dust is tallest where it was born.
    const rise = lerp(1.0, 0.35, t);
    this.pointAt(1, _tip);

    for (let j = 0; j < jets; j++) {
      const bearing = (j / jets) * TAU + Math.random() * (TAU / jets);
      const cos = Math.cos(bearing);
      const sin = Math.sin(bearing);
      // Radius wobble, so the wavefront is not a drawn circle.
      const reach = radius * randRange(0.82, 1.12);

      _pos.set(_tip.x + cos * reach, randRange(0.05, 0.5) * rise, _tip.z + sin * reach);
      _emit.position = _pos;
      _emit.radius = c.ringThickness;
      // Outward and only slightly up — this is the part that has to hug the
      // floor. `ringLift` above about 0.5 and the torus becomes a mushroom.
      _emit.direction = _dir.set(cos, c.ringLift, sin).normalize();
      _emit.speed = c.ringSpeed * lerp(1, 0.35, t);
      _emit.speedVariance = 0.55;
      _emit.spread = 0.42;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.ringSize * lerp(0.75, 1.5, t);
      _emit.sizeVariance = 0.45;
      _emit.life = c.dustLifetime * 1.25;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(perJet, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.quake;

    this._syncUniforms();
    this._triggerUpTo(this.u, false);
    this._updateStones(dt, 0);
    this._updateShrapnel(dt, 0);
    this._frontFx(dt);

    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.quake;
    const g = settings.global;
    const time = frame.uTime.value;

    // Everything still buried goes up now, including the cluster.
    this._triggerUpTo(1, true);

    this.pointAt(1, _pos);

    /* --- layer 4: the floor lets go --- */
    this.crater.spawn(_pos, c.craterRadius * g.explosionIntensity);
    this.fissures.spawn(_pos, this.direction, c.fissureRadius * g.explosionIntensity);

    /* --- layer 5: the air --- */
    this.warp.spawn(_pos);

    /* --- layer 3: the fan of rock --- */
    this._launchShrapnel(Math.round(c.shrapnelCount), _pos, c.blastRadius * 0.45, 1);

    _emit.position = _tip.copy(_pos).setY(0.4);
    _emit.radius = c.blastRadius * 0.6;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gritSpeed * 2.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.9;
    _emit.life = c.gritLifetime * 1.6;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.grit.emit(Math.round(c.blastGrit * g.particleCount), _emit);

    /* --- layer 2: the plume that climbs behind the ring --- */
    _emit.position = _tip.copy(_pos).setY(0.5);
    _emit.radius = c.blastRadius * 0.75;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.plumeSpeed;
    _emit.speedVariance = 0.65;
    _emit.spread = 0.62;
    _emit.size = c.ringSize * 1.5;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime * 1.7;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.5;
    this.dust.emit(Math.round(c.plumeDust * g.particleCount), _emit);

    // The powder that will still be hanging there once the cloud has gone.
    _emit.position = _tip.copy(_pos).setY(1.0);
    _emit.radius = c.blastRadius * 1.3;
    _emit.speed = c.plumeSpeed * 0.5;
    _emit.spread = 0.95;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime;
    _emit.spin = 0;
    this.motes.emit(Math.round(c.blastMotes * g.particleCount), _emit);

    /**
     * No `BurstSphere` here, deliberately.
     *
     * Every other impact in the sandbox opens with one, and an EARTH shell is
     * nominally exactly this: a dense ball of dust. Cast, it turned out to be a
     * five metre faceted dome of milk parked over the blast — it is a *volume*,
     * it is drawn over everything inside it, and what was inside it was the
     * entire shot. The particle cloud below does the same job honestly: it is
     * made of thousands of lit puffs that the slabs can stand in front of.
     */

    /* --- the marks on the floor --- */
    // Muted on purpose. At full strength this is a six-metre pale disc painted
    // flat on the floor, and it reads as a light being shone down rather than
    // as dust lying on stone — it was washing out the crater and the scars
    // underneath it. The powder that should be visible here is the particles'
    // job; this only has to dirty the ground they settle on.
    this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
      radius: c.ringRadius * g.explosionIntensity * 0.8,
      life: c.scarLife * 0.8,
      width: 0.55,
      intensity: 0.32,
      colorA: getColor(c.colorScarA),
      colorB: getColor(c.colorDustCoat)
    });
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.55,
      width: 0.05,
      intensity: 0.5,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      15
    );
    // Barely a flash: there is nothing burning here. What little there is comes
    // from the frame being punched, not from light being made.
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.quake;
    const g = settings.global;

    /* --- how far through the withdrawal are we --- */
    let retract = 0;

    if (this.phase === AbilityPhase.FADE) {
      retract = saturate((this.fadeTime - c.sinkDelay) / Math.max(0.05, c.sinkTime));
    }

    // The cloud coming back down onto everything it was thrown off. Held at
    // zero for a beat first, because stone that is pale the instant it appears
    // never reads as having *just* broken.
    const sinceImpact = this.impactTime + (this.phase === AbilityPhase.FADE ? this.fadeTime : 0);
    this._dustCoat = saturate((sinceImpact - c.coatDelay) / Math.max(0.05, c.coatTime));

    this._syncUniforms();
    this._updateStones(dt, retract);
    this._updateShrapnel(dt, retract);

    /* --- layer 4 keeps breaking, then goes back down --- */
    // The crater is entirely up-facing, so the coating that barely touches a
    // vertical slab covers all of it — at the slabs' strength it goes bone
    // white and stops reading as the floor. It gets its own share.
    this.crater.update(dt, retract, this._dustCoat * c.plateCoat);
    this.fissures.update(dt);

    /* --- layer 5 --- */
    this.warp.update(dt);

    /* --- layer 2: the ring rolls, then the air settles --- */
    const roll = saturate(this.impactTime / Math.max(0.05, c.ringTime));
    if (this.phase === AbilityPhase.IMPACT && roll < 1) this._rollFx(dt, roll);

    if (retract < 0.6) this._settleFx(dt, c, g, 1 - retract / 0.6, t);
  }

  /**
   * What the standing field keeps doing: dust drifting off the cluster, powder
   * hanging in the light, and grit trickling down the faces of the slabs. The
   * trickle is the detail that makes the aftermath look alive rather than
   * paused — stone that has just been broken does not stop shedding.
   */
  _settleFx(dt, c, g, strength, t) {
    const time = frame.uTime.value;

    const dustCount = Math.round(
      this.dustEmitter.tick(dt, c.dustRate * c.settleDust * strength) * g.particleCount
    );
    if (dustCount > 0) {
      this.pointAt(1, _pos).setY(0.1);
      _emit.position = _pos;
      _emit.radius = c.blastRadius * 1.25;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed * 0.35;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.ringSize * 1.1;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime * 1.3;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const moteCount = Math.round(
      this.moteEmitter.tick(dt, c.moteRate * strength) * g.particleCount
    );
    if (moteCount > 0) {
      this.pointAt(randRange(0.35, 1), _pos).setY(1.1);
      _emit.position = _pos;
      _emit.radius = c.blastRadius;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 0.35;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    /* grit running off the faces — one trickle at a time, off a real slab */
    const trickles = Math.round(
      this.trickleEmitter.tick(dt, c.trickleRate * strength) * g.particleCount
    );
    for (let n = 0; n < trickles; n++) {
      const record = this.records[(Math.random() * this._activeCount) | 0];
      if (!record || record.eruptTime < 0) continue;
      this._stoneTip(record, c, g, _pos);
      if (_pos.y < 0.4) continue;

      _emit.position = _pos;
      _emit.radius = this._stoneRadius(record, c, g) * 0.8;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = 0.4;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.1;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.5;
      _emit.life = c.gritLifetime * 0.8;
      _emit.lifeVariance = 0.35;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.grit.emit(1, _emit);

      // ...and the puff of powder it takes with it, once in a while.
      if (Math.random() < 0.35 * (1 - t * 0.5)) {
        _emit.direction = _dir.set(randRange(-0.4, 0.4), -0.6, randRange(-0.4, 0.4)).normalize();
        _emit.speed = 0.3;
        _emit.size = 0.35;
        _emit.life = c.dustLifetime * 0.5;
        _emit.spin = 0.3;
        this.dust.emit(1, _emit);
      }
    }
  }

  /** Where the break face of a stone currently is, for the trickle. */
  _stoneTip(record, c, g, out) {
    const height = this._stoneHeight(record, c, g);
    this._stonePosition(record, c, out);
    const leanAngle = this._stoneLean(record, c);
    // Good enough for spawning a particle: the top is `height` up the leaned
    // axis, and nothing at the scale of a grain of grit can tell the difference
    // between this and the real quaternion.
    out.y += Math.cos(leanAngle) * height;
    out.addScaledVector(_lean, Math.sin(leanAngle) * height);
    return out;
  }

  onDestroy() {
    this._activeCount = 0;
    this._liveChunks = 0;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    for (let v = 0; v < DEBRIS_VARIANTS; v++) this.debrisMeshes[v].count = 0;
    for (const chunk of this.chunks) chunk.live = false;
    this.crater.hide();
    this.fissures.hide();
    this.warp.hide();
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const mesh of this.debrisMeshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.material.dispose();
    this.debrisMaterial.dispose();
    this.crater.dispose();
    this.fissures.dispose();
    this.warp.dispose();
    super.dispose();
  }
}
