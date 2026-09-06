import {
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  Object3D,
  Quaternion,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createVenomCrystalMaterial } from '../materials/VenomCrystalMaterial.js';
import { createVenomCoreMaterial } from '../materials/VenomCoreMaterial.js';
import { createCrystalGeometry } from '../assets/ProceduralGeometry.js';
import { ShatterPlate } from '../effects/ShatterPlate.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, smoothstep, Easing, randRange } from '../utils/math.js';

/** Hard ceiling on gems per cast. The editor's count sliders clamp to this. */
const MAX_GEMS = 336;
/**
 * Distinct crystal silhouettes. Each is its own InstancedMesh — four draw calls
 * buys variety that per-instance scaling cannot, because the *facets* differ,
 * not just the proportions.
 */
const VARIANTS = 4;
const SLOTS = Math.ceil(MAX_GEMS / VARIANTS);
const TAU = Math.PI * 2;

/**
 * What a gem in the terminal cluster is.
 *
 * The reference frame is not a uniform pincushion — it is three populations
 * doing three jobs, and reading it as one is what makes a procedural starburst
 * look like a sea urchin.
 */
const Tier = Object.freeze({
  /** The long blades that spear out of the middle and define the silhouette. */
  SPEAR: 0,
  /** The body of the cluster. */
  BLADE: 1,
  /** The chunky skirt around the base that stops it floating. */
  SHARD: 2
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

/**
 * VENOM — Crystallized Venom Surge.
 *
 * A line cast built to the five-panel breakdown in the reference sheet, and
 * organised so that each panel is one thing you can turn off in the editor and
 * judge on its own:
 *
 *   1. **CRYSTALS** — amethyst with venom sealed inside it, erupting out of the
 *      floor behind a fracture front and opening into a starburst at the end.
 *   2. **GAS** — heavy green vapour that rolls off the bases rather than rising,
 *      and goes dusty violet as it dies.
 *   3. **DROPLETS** — beads of venom flung out of the break and arcing back
 *      down, plus a slow drip off the gem tips while the field stands.
 *   4. **CRACKS** — the floor cut into slabs and heaved, with light coming up
 *      out of the seams.
 *   5. **GLOW** — the kernel of light the whole cluster is built around, which
 *      also lights the gems: layer 1 reads `uCore` from this layer, so the two
 *      are one object rather than a glow parked inside a pile of crystals.
 *
 * ## The rule that makes the editor work
 *
 * A gem record stores only what the dice decided — a fraction along the line, a
 * signed lateral fraction, a bearing, a handful of unitless jitters. Not one
 * metre, radian or second is captured at spawn time; all of them are resolved
 * against `settings.venom` inside the update loop. Dragging `burstHeight`
 * therefore re-grows a cluster that is already standing, and does it with the
 * clock paused, which is when a silhouette is actually worth tuning.
 *
 * The only values a record *does* capture are timestamps — the moment its own
 * eruption or its own shatter was triggered. Those are events, not dimensions.
 */
export class VenomSurgeAbility extends Ability {
  constructor(context) {
    super('venom', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /* ---- layer 1: the gems ---- */
    this.material = createVenomCrystalMaterial(environment);

    /** Signature of the geometry controls, so a rebuild only happens on a change. */
    this._shapeKey = '';

    this.meshes = [];
    this.birthAttributes = [];

    for (let v = 0; v < VARIANTS; v++) {
      const geometry = this._buildGeometry(v);

      const seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const births = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const flows = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      for (let i = 0; i < SLOTS; i++) {
        seeds.array[i] = Math.random() * 10;
        // The phase of the venom drifting inside this gem. It is not reset per
        // cast: it is a property of the stone, not of the event.
        flows.array[i] = Math.random();
      }
      geometry.setAttribute('aSeed', seeds);
      geometry.setAttribute('aBirth', births);
      geometry.setAttribute('aFlow', flows);

      const mesh = new InstancedMesh(geometry, this.material, SLOTS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid world geometry: it belongs in the depth prepass so the gas and the
      // glow core fade softly where they intersect it.
      mesh.layers.set(LAYER.WORLD);
      mesh.renderOrder = 2;
      this.group.add(mesh);

      this.meshes.push(mesh);
      this.birthAttributes.push(births);
    }

    /* ---- layer 4: the broken floor ---- */
    this.plate = new ShatterPlate(environment);
    this.group.add(this.plate.mesh);

    /* ---- layer 5: the core ---- */
    // One low-poly sphere for both shells; they differ only in scale and in
    // which half of the settings block they read.
    this.coreGeometry = new IcosahedronGeometry(1, 4);
    this.kernelMaterial = createVenomCoreMaterial('kernel');
    this.haloMaterial = createVenomCoreMaterial('halo');

    this.kernel = new Mesh(this.coreGeometry, this.kernelMaterial);
    this.halo = new Mesh(this.coreGeometry, this.haloMaterial);
    for (const mesh of [this.halo, this.kernel]) {
      mesh.layers.set(LAYER.VFX);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
    }
    // The halo is the wider, softer one and has to be behind the kernel.
    this.halo.renderOrder = 12;
    this.kernel.renderOrder = 13;

    /** Where the light is standing. Gems read it, so it is state, not a local. */
    this.corePoint = new Vector3();
    this._coreFade = 0;

    /**
     * Fixed-size record pool — a cast allocates nothing.
     * See the class comment: dice only, no dimensions.
     */
    this.records = [];
    for (let i = 0; i < MAX_GEMS; i++) {
      this.records.push({
        burst: false, // held back for the starburst at the far end
        tier: Tier.BLADE,
        along: 0, // 0..1 down the cast line
        lateral: 0, // -1..1 across the band, before clumping
        scatter: 0, // -1..1 extra lateral jitter
        angle: 0, // starburst bearing, radians
        radial: 0, // starburst distance from the centre, 0..1
        heightJitter: 0,
        radiusJitter: 0,
        leanJitter: 0,
        yaw: 0,
        stagger: 0, // 0..1 of `riseStagger`
        eruptTime: -1, // absolute age it was triggered at, or -1
        breached: false, // has it thrown its chips yet
        shattered: false // has it thrown its dying spray yet
      });
    }

    this._activeCount = 0;
    this._burstStart = MAX_GEMS;
  }

  /** One crystal shape. The variant index only perturbs the seed. */
  _buildGeometry(variant) {
    const c = settings.venom;
    return createCrystalGeometry({
      seed: 4.1 + variant * 17.3,
      sides: c.facets,
      taper: c.taper,
      roughness: c.gemRough,
      bend: c.bend
    });
  }

  /**
   * Regenerate the gem meshes when a *shape* control moves.
   *
   * Facet count, taper, roughness and bend cannot be expressed as a per-instance
   * transform, so they are baked into the geometry — and a seven-sided crystal
   * is a couple of hundred triangles, cheap enough to rebuild outright rather
   * than approximate in a vertex shader. That is what keeps them live sliders.
   */
  _syncGeometry() {
    const c = settings.venom;
    const key = `${Math.round(c.facets)}|${c.taper.toFixed(3)}|${c.gemRough.toFixed(3)}|${c.bend.toFixed(3)}`;
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.meshes[v];
      const previous = mesh.geometry;
      const geometry = this._buildGeometry(v);
      // The per-instance attributes are state, not shape — carry them over.
      for (const name of ['aSeed', 'aBirth', 'aFlow']) {
        geometry.setAttribute(name, previous.getAttribute(name));
      }
      mesh.geometry = geometry;
      previous.dispose();
    }
  }

  createParticles() {
    const particles = this.ctx.particles;

    /* ---- layer 2: the gas ---- */
    // Non-additive, because the reference cloud *occludes* the crystals behind
    // it. An additive version of this is a green haze and the cluster loses all
    // of its depth.
    this.gas = particles.get('venom.gas', {
      capacity: 4200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.3
    });
    this.gas.uniforms.uDrag.value = 2.1;
    this.gas.uniforms.uEndSize.value = 3.8;
    this.gas.uniforms.uSizeIn.value = 0.09;
    this.gas.uniforms.uFadeIn.value = 0.12;
    this.gas.uniforms.uFadeOut.value = 0.28;

    /* ---- layer 3: the droplets ---- */
    this.drops = particles.get('venom.drops', {
      capacity: 2600,
      shape: ParticleShape.DROPLET,
      additive: false,
      lit: true,
      softFade: 0.2
    });
    this.drops.uniforms.uDrag.value = 0.12;
    this.drops.uniforms.uEndSize.value = 0.9;
    this.drops.uniforms.uFadeIn.value = 0.02;
    this.drops.uniforms.uFadeOut.value = 0.82;

    // The airborne glitter that sells the gems as faceted. Additive, tiny.
    this.motes = particles.get('venom.motes', {
      capacity: 3000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.2;
    this.motes.uniforms.uEndSize.value = 0.15;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.05;
    this.motes.uniforms.uFadeOut.value = 0.34;

    this.gasEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.dripEmitter = new RateEmitter();
    this.crackEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._activeCount;
  }

  /** The cluster stands for its lifetime, then the fade takes it apart. */
  get impactDuration() {
    return Math.max(0.2, settings.venom.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    const c = settings.venom;
    return Math.max(0.2, c.shatterDelay + c.sinkTime);
  }

  /** Venom light is a chemical glow: it wavers, it does not glint. */
  lightShimmer() {
    const c = settings.venom;
    return 1 - c.lightWaver * (0.5 - 0.5 * Math.sin(this.age * 5.1) * Math.sin(this.age * 1.9));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.venom;

    this.gasEmitter.reset();
    this.moteEmitter.reset();
    this.dripEmitter.reset();
    this.crackEmitter.reset();
    this._crackDistance = 0;
    this._coreFade = 0;

    this.plate.hide();
    this.kernel.visible = false;
    this.halo.visible = false;

    // Until the cluster exists, the *front* is the light the gems are lit by.
    this.corePoint.copy(this.origin).setY(0.4);

    const wanted = Math.min(MAX_GEMS, Math.max(1, Math.round(c.gemCount * c.density)));
    const burstCount = Math.round(wanted * saturate(c.burstShare));
    this._activeCount = wanted;
    this._burstStart = wanted - burstCount;

    for (let i = 0; i < wanted; i++) {
      const record = this.records[i];
      const burst = i >= this._burstStart;

      record.burst = burst;
      record.eruptTime = -1;
      record.breached = false;
      record.shattered = false;
      record.yaw = Math.random() * TAU;
      record.stagger = Math.random();
      record.heightJitter = randRange(-1, 1);
      record.radiusJitter = randRange(-1, 1);
      record.leanJitter = randRange(-1, 1);
      record.scatter = randRange(-1, 1);

      if (burst) {
        record.angle = Math.random() * TAU;
        record.along = 1;

        // Three populations, three jobs. `radial` is rolled per tier rather
        // than shared, because where a gem stands and what kind of gem it is
        // are the same decision — a spear at the rim is a fallen tree, and a
        // shard in the middle is invisible.
        const roll = Math.random();
        if (roll < c.spearShare) {
          record.tier = Tier.SPEAR;
          record.radial = randRange(0.04, 0.42);
        } else if (roll < c.spearShare + c.shardShare) {
          record.tier = Tier.SHARD;
          record.radial = lerp(0.45, 1.0, Math.sqrt(Math.random()));
        } else {
          record.tier = Tier.BLADE;
          // sqrt keeps the body evenly dense rather than piled in the middle.
          record.radial = Math.sqrt(Math.random()) * 0.88;
        }
      } else {
        record.tier = Math.random() < c.rubble ? Tier.SHARD : Tier.BLADE;
        // `frontBias` < 1 crowds the spine toward the impact point.
        record.along = Math.pow((i + Math.random()) / Math.max(1, this._burstStart), c.frontBias);
        record.lateral = randRange(-1, 1);
      }
    }

    for (let i = wanted; i < MAX_GEMS; i++) this.records[i].eruptTime = -1;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;

    /* the cast itself — a puff of venom off the caster's hand */
    const g = settings.global;
    this.pointAt(0, _pos).setY(1.1);
    this.ctx.decals.spawn(DecalType.CRACK, this.origin, {
      radius: c.widthNear * 2.2,
      life: c.crackLife * 0.6,
      width: 0.35,
      intensity: 0.5,
      colorA: getColor(c.colorCrackA),
      colorB: getColor(c.colorCrackB)
    });

    _emit.position = _pos;
    _emit.radius = 0.3;
    _emit.direction = _dir.copy(this.direction).setY(0.55).normalize();
    _emit.speed = c.gasSpeed * 1.4;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.7;
    _emit.sizeVariance = 0.5;
    _emit.life = c.gasLifetime * 0.6;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.5;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.gas.emit(Math.round(26 * g.particleCount), _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Resolving a gem — every metre, radian and second comes from here     */
  /* ------------------------------------------------------------------ */

  /** Half-width of the spine at `s` along the line, metres. */
  _halfWidth(s, c) {
    return lerp(c.widthNear, c.width, Math.pow(saturate(s), c.widthCurve));
  }

  /** Signed lateral offset of a spine gem, as a fraction of the half-width. */
  _lateralNorm(record, c) {
    const raw = record.lateral;
    // >1 pulls the spine in toward the centre line, which is what makes it read
    // as a seam splitting open rather than as a scattered field.
    const clumped = Math.sign(raw) * Math.pow(Math.abs(raw), c.clumping);
    return clumped + record.scatter * c.scatter;
  }

  /** Where a gem currently stands, at the live footprint settings. */
  _gemPosition(record, c, out) {
    if (record.burst) {
      const reach = c.burstRadius * record.radial;
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

  /** Full height of a gem, metres. */
  _gemHeight(record, c, g) {
    let h;

    if (record.burst) {
      // Domed: tallest at the middle, falling away to the skirt.
      h = c.burstHeight * lerp(1, 1 - saturate(c.crown), Math.pow(record.radial, 1.3));
      if (record.tier === Tier.SPEAR) h *= c.spearScale;
      else if (record.tier === Tier.SHARD) h *= c.shardScale;
    } else {
      h = lerp(c.heightNear, c.height, Math.pow(saturate(record.along), c.heightCurve));
      // The swell as the seam approaches the impact point.
      h *= 1 + (c.peak - 1) * smoothstep(1 - c.peakWidth, 1, record.along);
      // The flanks are shorter than the spine, so the band has a ridge line.
      h *= lerp(1, 1 - saturate(c.crown), Math.pow(saturate(Math.abs(this._lateralNorm(record, c))), 1.4));
      if (record.tier === Tier.SHARD) h *= c.shardScale;
    }

    h *= 1 + record.heightJitter * c.heightJitter * g.randomness;
    return Math.max(0.02, h);
  }

  /** Base radius of a gem, metres. */
  _gemRadius(record, c, g) {
    // Slenderness is the difference between amethyst and a rock: a spear that
    // is as thick as it is tall reads as a boulder however it is shaded.
    let r = c.radius;
    if (record.burst) {
      r *= lerp(1.15, 0.7, record.radial);
      if (record.tier === Tier.SPEAR) r *= c.spearSlim;
      else if (record.tier === Tier.SHARD) r *= 1.5;
    } else {
      r *= lerp(0.7, 1.1, Math.pow(saturate(record.along), 0.6));
      if (record.tier === Tier.SHARD) r *= 1.45;
    }
    return Math.max(0.01, r * (1 + record.radiusJitter * c.radiusJitter * g.randomness));
  }

  /**
   * The direction this gem leans, written into `_lean`.
   *
   * The starburst is the whole reason this is not just the ice field with a new
   * palette: a cluster leans *away from its own centre*, hardest at the rim, so
   * the silhouette opens like a hand. The spine leans away from the caster and
   * outward across the band, which keeps the two halves of the cast reading as
   * one gesture.
   */
  _gemLean(record, c) {
    if (record.burst) {
      _lean.set(Math.cos(record.angle), 0, Math.sin(record.angle));
      // A spear that leans as hard as the skirt does lies down flat.
      const outward = record.tier === Tier.SPEAR ? record.radial * 0.55 : record.radial;
      return c.burstLean * Math.pow(outward, c.burstLeanCurve);
    }

    const outward = this._lateralNorm(record, c);
    _lean.copy(this.direction).multiplyScalar(0.7).addScaledVector(this.side, outward * 0.9);
    if (_lean.lengthSq() < 1e-6) _lean.copy(this.direction);
    _lean.normalize();
    return c.lean * (0.3 + 0.7 * record.along);
  }

  /* ------------------------------------------------------------------ */
  /* The eruption                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Trigger every gem the fracture front has now reached.
   * `limit` is how far down the line the front has got, 0..1.
   */
  _triggerUpTo(limit, includeBurst) {
    const c = settings.venom;
    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      if (record.eruptTime >= 0) continue;
      if (record.burst && !includeBurst) continue;
      if (!record.burst && record.along > limit) continue;

      let delay = record.stagger * c.riseStagger;
      // The starburst opens from the inside out, so the middle is already up
      // and lit by the time the skirt arrives.
      if (record.burst) delay += record.radial * c.burstStagger;
      record.eruptTime = this.age + delay;
    }
  }

  /**
   * How far out of the ground a gem is, 0 → 1 by way of a single overshoot
   * past 1. Negative while it is still buried and waiting.
   */
  _emergence(record, c) {
    if (record.eruptTime < 0) return -1;
    const elapsed = this.age - record.eruptTime;
    if (elapsed < 0) return -1;

    const riseTime = Math.max(0.02, c.riseTime);
    // The punch throws the crystal clear of its seat, so the rise carries all
    // the way to the top of the overshoot rather than stopping at full height.
    const peak = 1 + c.riseOvershoot;
    if (elapsed <= riseTime) return Easing.outQuint(elapsed / riseTime) * peak;

    // Then it drops back onto the seat and stays there. Crystal does not
    // rebound: it lands once and the floor keeps it. Anything that oscillates
    // here — which is what a damped sine does — reads as rubber, and a field of
    // them oscillating together reads as jelly. inQuad because that is the
    // shape of a fall: slow off the top, hard at the bottom.
    const drop = saturate((elapsed - riseTime) / Math.max(0.05, c.settle));
    return peak - c.riseOvershoot * Easing.inQuad(drop);
  }

  /**
   * Rebuild every instance matrix from the live settings.
   * @param {number} retract 0..1 — the whole field withdrawing into the floor.
   */
  _updateGems(dt, retract) {
    const c = settings.venom;
    const g = settings.global;
    const birthFade = Math.max(0.02, c.birthFade);
    const used = [0, 0, 0, 0];

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      const variant = i % VARIANTS;
      const slot = (i / VARIANTS) | 0;
      const emerge = this._emergence(record, c);

      if (emerge < 0) {
        // Still buried. Park it out of view rather than drawing a degenerate
        // matrix at the origin.
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
        this.birthAttributes[variant].array[slot] = 0;
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      const height = this._gemHeight(record, c, g);
      const radius = this._gemRadius(record, c, g);

      /* --- lean. Resolved before the breach spray, which aims along it --- */
      const leanAngle =
        this._gemLean(record, c) * (1 + record.leanJitter * c.leanJitter * g.randomness);

      /* --- the spray thrown as it breaks the surface --- */
      if (!record.breached && emerge > 0.22) {
        record.breached = true;
        this._breachFx(record, c, g, radius);
      }

      // Rotating about (up × lean) tips the crystal's own +Y toward `lean`.
      _axis.crossVectors(_up, _lean);
      if (_axis.lengthSq() < 1e-8) _axis.set(1, 0, 0);
      _axis.normalize();
      _tilt.setFromAxisAngle(_axis, leanAngle);
      _spin.setFromAxisAngle(_up, record.yaw * c.twist);
      _tilt.multiply(_spin);

      /* --- slide it up out of the floor --- */
      const settled = Math.min(1, emerge);
      this._gemPosition(record, c, _dummy.position);
      _dummy.position.y = (emerge - 1) * height * 0.85;

      if (retract > 0) {
        const sink = Easing.inCubic(retract);
        _dummy.position.y -= sink * (height + radius + 0.5);
      }

      _dummy.quaternion.copy(_tilt);
      _dummy.scale.set(radius, height, radius).multiplyScalar(lerp(0.84, 1, settled));
      _dummy.updateMatrix();

      this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
      this.birthAttributes[variant].array[slot] = saturate(
        1 - (this.age - record.eruptTime) / birthFade
      );
      used[variant] = Math.max(used[variant], slot + 1);
    }

    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.birthAttributes[v].needsUpdate = true;
    }
  }

  /** Where the tip of a gem currently is, for drips and the dying spray. */
  _gemTip(record, c, g, out) {
    const height = this._gemHeight(record, c, g);
    this._gemPosition(record, c, out);
    const leanAngle = this._gemLean(record, c);
    // Good enough for spawning a particle: the tip is `height` up the leaned
    // axis, and nobody can tell the difference between this and the real
    // quaternion at the scale a droplet occupies.
    out.y += Math.cos(leanAngle) * height;
    out.addScaledVector(_lean, Math.sin(leanAngle) * height);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  _syncUniforms() {
    const c = settings.venom;
    const g = settings.global;

    this._syncGeometry();

    // Layer 1 has to know where layer 5 is standing.
    const u = this.material.userData.uniforms;
    u.uCore.value.copy(this.corePoint);
    this.material.userData.sync();
    // ...and how bright it currently is, which `sync` cannot know.
    u.uCoreGlow.value = c.coreBleed * lerp(0.35, 1, saturate(this._coreFade)) * g.glow;
    u.uCoreRadius.value = c.coreBleedRadius;

    this.gas.setGradient(
      getColor(c.colorGasA),
      getColor(c.colorGasB),
      getColor(c.colorGasC),
      getColor(c.colorGasD)
    );
    this.gas.uniforms.uGravity.value.set(0, c.gasRise, 0);
    this.gas.uniforms.uSizeScale.value = c.gasSize * g.particleSize;
    this.gas.uniforms.uLifeScale.value = c.gasLifetime * 0.5 * g.particleLifetime;
    this.gas.uniforms.uSpeedScale.value = c.gasSpeed * g.particleSpeed;
    this.gas.uniforms.uOpacity.value = c.gasOpacity * g.opacity;
    this.gas.uniforms.uTurbulence.value = c.gasTurbulence * g.turbulence;
    this.gas.uniforms.uEndSize.value = c.gasSpread;

    this.drops.setGradient(
      getColor(c.colorDropA),
      getColor(c.colorDropB),
      getColor(c.colorDropC),
      getColor(c.colorDropD)
    );
    this.drops.uniforms.uGravity.value.set(0, c.dropGravity, 0);
    this.drops.uniforms.uSizeScale.value = c.dropSize * g.particleSize * 7;
    this.drops.uniforms.uLifeScale.value = g.particleLifetime;
    this.drops.uniforms.uSpeedScale.value = g.particleSpeed;
    this.drops.uniforms.uOpacity.value = g.opacity;
    this.drops.uniforms.uGlow.value = c.dropGlow * g.glow;

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
  }

  /**
   * Position and drive the two glow shells.
   *
   * `fade` is deliberately *not* clamped to 1: the arrival punch drives it well
   * past one for a fraction of a second, and that overshoot is the flare. Only
   * the geometry reads a saturated copy, because a shell scaled past its own
   * size just looks like a different, bigger shell.
   */
  _updateCore(fade) {
    const c = settings.venom;
    this._coreFade = Math.max(0, fade);

    if (this._coreFade <= 0.001) {
      this.kernel.visible = false;
      this.halo.visible = false;
      return;
    }

    this.kernel.visible = true;
    this.halo.visible = true;

    // Inflates as it flares, so the light *arrives* rather than switching on.
    const swell = lerp(c.coreSwell, 1, Easing.outQuint(saturate(this._coreFade)));
    this.kernel.position.copy(this.corePoint);
    this.halo.position.copy(this.corePoint);
    this.kernel.scale.setScalar(c.coreSize * swell);
    this.halo.scale.setScalar(c.coreSize * c.haloScale * swell);

    this.kernelMaterial.userData.sync(this._coreFade);
    this.haloMaterial.userData.sync(this._coreFade);
  }

  /** Droplets, gas and motes where a gem breaks the surface. */
  _breachFx(record, c, g, radius) {
    const time = frame.uTime.value;

    this._gemPosition(record, c, _pos).setY(0.06);

    _emit.position = _pos;
    _emit.radius = radius * 0.9;
    _emit.direction = _dir.copy(_lean).multiplyScalar(0.45).setY(1).normalize();
    _emit.speed = c.dropSpeed;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.07;
    _emit.sizeVariance = 0.8;
    _emit.life = c.dropLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.drops.emit(Math.round(c.breachDrops * g.particleCount), _emit);

    // Only some gems puff. A few hundred smoking at once buries the field in
    // haze and hides the silhouette that is the whole point.
    if (Math.random() < c.breachGasChance) {
      _emit.speed = c.gasSpeed * 0.8;
      _emit.spread = 1.0;
      _emit.size = 0.55;
      _emit.sizeVariance = 0.5;
      _emit.life = c.gasLifetime * 0.7;
      _emit.spin = 0.4;
      this.gas.emit(Math.round(3 * g.particleCount), _emit);
    }
  }

  /** Gas, motes and ground cracks shed continuously along the travelling front. */
  _frontFx(dt) {
    const c = settings.venom;
    const g = settings.global;
    const time = frame.uTime.value;
    const halfWidth = this._halfWidth(this.u, c);

    const gasCount = Math.round(this.gasEmitter.tick(dt, c.gasRate) * g.particleCount);
    if (gasCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.16);
      _emit.radius = halfWidth * 0.95;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.gasSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.85;
      _emit.sizeVariance = 0.5;
      _emit.life = c.gasLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.gas.emit(gasCount, _emit);
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate) * g.particleCount);
    if (moteCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.45);
      _emit.radius = halfWidth;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    /* cracks laid on the floor as the seam passes over it */
    const step = 1 / Math.max(0.05, c.crackRate);
    while (this.front - this._crackDistance >= step) {
      this._crackDistance += step;
      const s = saturate(this._crackDistance / this.length);
      const width = this._halfWidth(s, c);
      this.pointAt(s, _pos);
      _pos.x += this.side.x * randRange(-0.6, 0.6) * width;
      _pos.z += this.side.z * randRange(-0.6, 0.6) * width;

      this.ctx.decals.spawn(DecalType.CRACK, _pos, {
        radius: width * c.crackSpread * randRange(0.6, 1.2),
        life: c.crackLife,
        width: c.crackWidth,
        intensity: c.crackIntensity,
        colorA: getColor(c.colorCrackA),
        colorB: getColor(c.colorCrackB)
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.venom;

    // While the seam is running, the front *is* the light: it lights the gems
    // it has just made, and hands the job over to the cluster on impact.
    this.corePoint.copy(this.position).setY(c.coreHeight * 0.35);

    this._syncUniforms();
    this._triggerUpTo(this.u, false);
    this._updateGems(dt, 0);
    this._frontFx(dt);
    this._updateCore(0);

    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.venom;
    const g = settings.global;
    const time = frame.uTime.value;

    // Everything still buried goes up now, including the starburst.
    this._triggerUpTo(1, true);

    this.pointAt(1, _pos);
    this.corePoint.copy(_pos).setY(c.coreHeight);

    /* --- layer 4: the floor lets go --- */
    this.plate.spawn(_pos, c.plateRadius * g.explosionIntensity);

    // Cracks running on past the lip of the plate, so the break does not stop
    // at a clean circle. Small ones: the CRACK decal draws a radial branch
    // pattern, and at plate scale that is a flat green flower lying on the
    // floor rather than a crack running out of a crater.
    for (let i = 0; i < 4; i++) {
      const angle = Math.random() * TAU;
      const reach = c.plateRadius * randRange(0.8, 1.25);
      _tip.copy(_pos);
      _tip.x += Math.cos(angle) * reach;
      _tip.z += Math.sin(angle) * reach;
      this.ctx.decals.spawn(DecalType.CRACK, _tip, {
        radius: c.plateRadius * randRange(0.22, 0.4),
        life: c.crackLife * 1.2,
        width: c.crackWidth,
        intensity: c.crackIntensity * 0.9,
        colorA: getColor(c.colorCrackA),
        colorB: getColor(c.colorCrackB)
      });
    }

    /* --- the pressure shell the surge pushes ahead of itself --- */
    // Two decisions here, both learned the hard way, and both about the same
    // failure: any shell drawn at this scale reads as a *bubble* over the
    // cluster unless you stop it being one.
    //
    // STORM rather than EARTH — the dust ball draws its whole volume, and a
    // green one is a low-poly dome that swallows the gems for a third of a
    // second. STORM keeps the shell empty: filaments skating over a fresnel rim.
    //
    // And squashed almost flat, so what expands is a *disc* of vapour hugging
    // the floor rather than a hemisphere standing up in front of the crystals.
    // That is also what the gas actually does — it is heavier than air.
    _tip.copy(_pos).setY(0.3);
    this.ctx.bursts.spawn(BurstMode.STORM, _tip, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.7,
      intensity: c.burstIntensity,
      opacity: 0.42,
      displace: 0.5,
      squash: 0.22,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* --- the ring that snaps outward across the floor --- */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.06,
      intensity: 0.95,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* --- layers 2 and 3 thrown out of the break --- */
    _emit.position = _tip.copy(_pos).setY(0.35);
    _emit.radius = c.burstRadius * 0.7;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dropSpeed * 2.1;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.9;
    _emit.life = c.dropLifetime * 1.5;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.drops.emit(Math.round(c.burstDrops * g.particleCount), _emit);

    _emit.speed = c.gasSpeed * 2.2;
    _emit.spread = 1.0;
    _emit.size = 1.5;
    _emit.sizeVariance = 0.5;
    _emit.life = c.gasLifetime * 1.6;
    _emit.spin = 0.5;
    this.gas.emit(Math.round(c.burstGas * g.particleCount), _emit);

    _emit.speed = c.moteSpeed * 1.7;
    _emit.spread = 0.85;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.6;
    _emit.life = c.moteLifetime * 1.3;
    _emit.spin = 0;
    this.motes.emit(Math.round(c.burstMotes * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.venom;
    const g = settings.global;

    this.pointAt(1, _pos);
    this.corePoint.copy(_pos).setY(c.coreHeight);

    /* --- how far through the withdrawal are we --- */
    let retract = 0;
    let coreFade = 1;

    if (this.phase === AbilityPhase.FADE) {
      retract = saturate((this.fadeTime - c.shatterDelay) / Math.max(0.05, c.sinkTime));
      coreFade = 1 - Easing.inQuad(saturate(this.fadeTime / this.fadeDuration));
    } else {
      // The flare on arrival: a hard overshoot that damps out over `coreFlare`.
      const flare = saturate(this.impactTime / Math.max(0.02, c.coreFlare));
      coreFade =
        Easing.outQuint(saturate(this.impactTime / 0.12)) *
        (1 + c.coreFlarePunch * (1 - flare) * (1 - flare));
      // The cluster dims a little as it stands, so the frame has somewhere to go.
      coreFade *= lerp(1, c.coreHold, Easing.inQuad(t));
    }

    // The core first, then the gems: layer 1 reads how bright layer 5 is, and a
    // frame of lag on the arrival flare is a frame of gems lit by nothing.
    this._updateCore(coreFade);
    this._syncUniforms();
    this._updateGems(dt, retract);

    /* --- layer 4 keeps breaking, then goes back down --- */
    this.plate.update(dt, retract, 1 - saturate((retract - 0.3) / 0.7));

    /* --- the gems coming apart --- */
    if (this.phase === AbilityPhase.FADE) this._shatterFx(c, g);

    /* --- what the standing cluster keeps doing --- */
    if (retract < 0.55) {
      this._standingFx(dt, c, g, 1 - retract / 0.55);
    }
  }

  /**
   * Each gem throws one spray as it goes, staggered by the same dice that
   * staggered its rise — so the cluster comes apart in the order it grew.
   */
  _shatterFx(c, g) {
    const time = frame.uTime.value;

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      if (record.shattered || record.eruptTime < 0) continue;
      if (this.fadeTime < c.shatterDelay * (0.35 + 0.65 * record.stagger)) continue;
      record.shattered = true;

      this._gemTip(record, c, g, _pos);
      if (_pos.y < 0.05) continue;

      _emit.position = _pos;
      _emit.radius = 0.1;
      _emit.direction = _dir.copy(_lean).setY(0.75).normalize();
      _emit.speed = c.dropSpeed * 0.8;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.8;
      _emit.life = c.dropLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.drops.emit(Math.round(c.shatterDrops * g.particleCount), _emit);

      _emit.speed = c.moteSpeed * 0.9;
      _emit.size = 0.07;
      _emit.life = c.moteLifetime * 0.8;
      this.motes.emit(Math.round(c.shatterMotes * g.particleCount), _emit);
    }
  }

  /** Gas rolling off the bases, motes rising, venom dripping off the tips. */
  _standingFx(dt, c, g, strength) {
    const time = frame.uTime.value;

    const gasCount = Math.round(
      this.gasEmitter.tick(dt, c.gasRate * c.standingGas * strength) * g.particleCount
    );
    if (gasCount > 0) {
      this.pointAt(1, _pos).setY(0.12);
      _emit.position = _pos;
      _emit.radius = c.burstRadius * 1.1;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.gasSpeed * 0.5;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 1.1;
      _emit.sizeVariance = 0.5;
      _emit.life = c.gasLifetime * 1.2;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.gas.emit(gasCount, _emit);
    }

    const moteCount = Math.round(
      this.moteEmitter.tick(dt, c.moteRate * 0.35 * strength) * g.particleCount
    );
    if (moteCount > 0) {
      this.pointAt(randRange(0.3, 1), _pos).setY(0.4);
      _emit.position = _pos;
      _emit.radius = c.burstRadius * 0.9;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed * 0.6;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    /* venom running off the tips — one bead at a time, off a real gem */
    const drips = Math.round(this.dripEmitter.tick(dt, c.dripRate * strength) * g.particleCount);
    for (let n = 0; n < drips; n++) {
      const record = this.records[(Math.random() * this._activeCount) | 0];
      if (!record || record.eruptTime < 0) continue;
      this._gemTip(record, c, g, _pos);
      if (_pos.y < 0.25) continue;

      _emit.position = _pos;
      _emit.radius = 0.04;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = 0.25;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.12;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.075;
      _emit.sizeVariance = 0.45;
      _emit.life = c.dropLifetime * 1.2;
      _emit.lifeVariance = 0.35;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.drops.emit(1, _emit);
    }
  }

  onDestroy() {
    this._activeCount = 0;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    this.plate.hide();
    this.kernel.visible = false;
    this.halo.visible = false;
    this._coreFade = 0;
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.material.dispose();
    this.plate.dispose();
    this.coreGeometry.dispose();
    this.kernelMaterial.dispose();
    this.haloMaterial.dispose();
    super.dispose();
  }
}
