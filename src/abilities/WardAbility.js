import {
  InstancedMesh,
  InstancedBufferAttribute,
  Mesh,
  PlaneGeometry,
  CylinderGeometry,
  Object3D,
  Quaternion,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import {
  WardPass,
  createWardBarrierMaterial,
  createWardRuneMaterial,
  createWardFlareMaterial,
  createWardHazeMaterial
} from '../materials/WardBarrierMaterial.js';
import { createWardGroundMaterial } from '../materials/WardGroundMaterial.js';
import { createObsidianMaterial } from '../materials/ObsidianMaterial.js';
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

/** Hard ceilings per role. The editor's sliders clamp here. */
const MAX_SLABS = 24;
const MAX_RUBBLE = 32;
const MAX_STONES = MAX_SLABS + MAX_RUBBLE;
/**
 * Distinct slab shapes. Each is its own InstancedMesh — two draw calls buys
 * silhouette variety that per-instance scaling alone cannot, because the
 * *facets* differ and not just the proportions.
 */
const VARIANTS = 2;
const SLOTS = Math.ceil(MAX_STONES / VARIANTS);

/** What a piece of obsidian is for. */
const Role = Object.freeze({
  SLAB: 0, // the ring of standing monoliths
  RUBBLE: 1 // the low wreckage banked around their feet
});

const TAU = Math.PI * 2;

/** How many points one frame's embers are split between. A single origin reads as a hose. */
const EMBER_BATCHES = 4;

const _emit = {};
const _pos = new Vector3();
const _centre = new Vector3();
const _dir = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _tilt = new Quaternion();
const _spin = new Quaternion();

/**
 * A two-lobe cardiac envelope, 0..1, one beat per unit of phase.
 *
 * The hard first thump at 0.08 is the systole; the softer second one at 0.30 is
 * the valve closing behind it. It is a Gaussian pair rather than a sine because
 * a sine spends half its time on the way up — a heart is mostly *still*, and the
 * stillness between the thumps is the entire reason this reads as a pulse and
 * not as a throbbing light.
 *
 * @param {number} phase 0..1 through one beat
 */
function heartbeat(phase) {
  const systole = Math.exp(-Math.pow((phase - 0.08) * 9.5, 2));
  const diastole = Math.exp(-Math.pow((phase - 0.3) * 12.0, 2)) * 0.55;
  return Math.min(1, systole + diastole);
}

/** Clamp a slider to its role's hard ceiling. */
function clampCount(value, max) {
  return Math.max(0, Math.min(max, Math.round(value)));
}

/** Shortest signed angle from `b` to `a`, radians, -π..π. */
function angleDelta(a, b) {
  const d = a - b;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * WARD — the Volcanic Horror Ward, and the ability that stands *around* a point
 * rather than being thrown at one.
 *
 * A surge of melt runs across the floor to the aimed circle. The stone inside it
 * shatters into plates with magma running in the seams, a ring of obsidian
 * monoliths is heaved up out of the wreckage, and a cylinder of blood closes
 * over the lot with a band of burning runes at its foot and another at its rim.
 * It stands, beating; then the membrane tears from the rim down, the slabs sink
 * back into the melt and the floor cools.
 *
 * Eight passes, one per panel of the reference sheet:
 *
 *   1. **cylindrical blood barrier** — two passes over one open tube, far wall
 *      then near wall, alpha blended so it *tints* what stands behind it.
 *   2. **magma fracture floor** — a true voronoi edge network, lit off a
 *      world-space gradient of its own height field.
 *   3. **rising obsidian embers** — GPU particles picked up off the seams.
 *   4. **gore splash** — non-additive droplets thrown off the membrane, plus the
 *      marks they leave on the floor.
 *   5. **core heat distortion** — a screen-space warp proxy on LAYER.DISTORTION.
 *   6. **rune edge glow** — two rings of procedurally cut glyphs.
 *   7. **sub-surface vein flash** — melt trapped inside the obsidian, sampled
 *      along the view ray so it sits *under* the surface.
 *   8. **lens flare shockwave** — the optical response to the core, and the ring
 *      the seal throws.
 *
 * **The heartbeat is what makes those eight things one thing.** `_beat` is
 * evaluated once per frame from `bpm` and handed to every material, the light,
 * the camera and the emitters. The membrane swells on it, the runes flare, the
 * veins light from the floor up as the wave climbs the slabs, the melt pumps,
 * the flare relights, the ward sheds a ring of embers and the floor thumps. Nothing
 * in here free-runs on its own sine, and that is the difference between a stack
 * of effects and something that is alive.
 *
 * **The rule that makes the editor work.** A cast captures one number — a seed —
 * and a handful of timestamps. Not one metre, radian or second is recorded: the
 * footprint, the wall, the monoliths, the runes and the floor are all resolved
 * against `settings.ward` inside the update loop, which runs on a zero-length
 * frame too. Drag `zoneRadius` while a ward is standing and the whole thing —
 * fracture, ring, membrane, rune spacing — re-scales around it.
 */
export class WardAbility extends Ability {
  constructor(context) {
    super('ward', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /* ---- the floor ---- */
    this.groundGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.groundMaterial = createWardGroundMaterial();
    this.ground = new Mesh(this.groundGeometry, this.groundMaterial);
    this.ground.name = 'WardGround';
    this.ground.layers.set(LAYER.VFX);
    this.ground.renderOrder = 5; // under the decals, so gore marks land on top
    this.ground.frustumCulled = false;
    this.ground.visible = false;
    this.group.add(this.ground);

    /* ---- the membrane ---- */
    // An open unit tube — radius 1, y from 0 to 1 — so placing it is a scale and
    // a move, and `uv.y` reads straight off as "how far up the wall am I".
    this.barrierGeometry = new CylinderGeometry(1, 1, 1, 96, 18, true).translate(0, 0.5, 0);
    this.barrierMaterials = [
      createWardBarrierMaterial(WardPass.INNER),
      createWardBarrierMaterial(WardPass.OUTER)
    ];
    this.barriers = [];
    for (const [index, material] of this.barrierMaterials.entries()) {
      const mesh = new Mesh(this.barrierGeometry, material);
      mesh.name = index === 0 ? 'WardBarrierInner' : 'WardBarrierOuter';
      mesh.layers.set(LAYER.VFX);
      // Far wall under everything the ward contains, near wall over all of it.
      mesh.renderOrder = index === 0 ? 8 : 13;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.barriers.push(mesh);
    }

    /* ---- the two rune bands ---- */
    // One material apiece rather than one shared: the bands run at different
    // brightnesses (`runeBase` / `runeTop`), and that is a uniform, not a mesh
    // property. Two programs of identical source cost one compile.
    this.runeGeometry = new CylinderGeometry(1, 1, 1, 160, 1, true).translate(0, 0.5, 0);
    this.runeMaterials = [createWardRuneMaterial(), createWardRuneMaterial()];
    this.runeBands = [];
    for (let i = 0; i < 2; i++) {
      const mesh = new Mesh(this.runeGeometry, this.runeMaterials[i]);
      mesh.name = i === 0 ? 'WardRunesBase' : 'WardRunesRim';
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 12;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.runeBands.push(mesh);
    }

    /* ---- the obsidian ---- */
    this.obsidianMaterial = createObsidianMaterial(environment);
    this._shapeKey = '';
    this.stoneMeshes = [];
    this.seedAttributes = [];

    for (let v = 0; v < VARIANTS; v++) {
      const geometry = this._buildStoneGeometry(v);
      const seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      for (let i = 0; i < SLOTS; i++) seeds.array[i] = Math.random() * 10;
      geometry.setAttribute('aSeed', seeds);

      const mesh = new InstancedMesh(geometry, this.obsidianMaterial, SLOTS);
      mesh.name = `WardObsidian${v}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid world geometry: it belongs in the depth prepass so the membrane,
      // the smoke and the embers all fade softly where they meet it.
      mesh.layers.set(LAYER.WORLD);
      mesh.renderOrder = 2;
      this.group.add(mesh);

      this.stoneMeshes.push(mesh);
      this.seedAttributes.push(seeds);
    }

    /* ---- the core flare ---- */
    this.flareGeometry = new PlaneGeometry(1, 1, 1, 1);
    this.flareMaterial = createWardFlareMaterial();
    this.flare = new Mesh(this.flareGeometry, this.flareMaterial);
    this.flare.name = 'WardFlare';
    this.flare.layers.set(LAYER.VFX);
    this.flare.renderOrder = 16; // over everything, as an optical artefact should be
    this.flare.frustumCulled = false;
    this.flare.visible = false;
    this.group.add(this.flare);

    /* ---- the heat coming off the floor ---- */
    this.hazeGeometry = new PlaneGeometry(1, 1, 1, 1);
    this.hazeMaterial = createWardHazeMaterial();
    this.haze = new Mesh(this.hazeGeometry, this.hazeMaterial);
    this.haze.name = 'WardHaze';
    this.haze.layers.set(LAYER.DISTORTION);
    this.haze.frustumCulled = false;
    this.haze.visible = false;
    this.group.add(this.haze);

    /**
     * Fixed-size record pool — a cast allocates nothing.
     *
     * Dice only, no dimensions: every metre in here is resolved per frame.
     */
    this.stones = [];
    for (let i = 0; i < MAX_STONES; i++) {
      this.stones.push({
        role: Role.SLAB,
        // Its place *in the ring*, not a bearing: the bearing is resolved
        // against the live count every frame, so dragging `monoliths` re-seats
        // the whole ring instead of leaving a gap where the rest would be.
        index: 0,
        spread: 0, // -0.5..0.5 of a slot, × `monolithSpread`
        radial: 0, // -1..1 seat jitter, × `monolithJitter`
        heightJitter: 0,
        widthJitter: 0,
        leanJitter: 0,
        yawJitter: 0,
        stagger: 0 // 0..1 of the per-stone scatter on the sweep
      });
    }

    this._drawn = 0;
    this._slabCount = 0;
    /** Re-rolled per cast so no two wards raise the same ring. */
    this._seed = 0;
    /** Seconds since the ward began to close. Drives the seal, nothing else. */
    this._sealTime = 0;
    /** Metres of surge travel already paid out in ground marks. */
    this._markDistance = 0;
    /** 0..1 through the current heartbeat, and the envelope it produces. */
    this._beatPhase = 0;
    this._beat = 0;
    /** Progress of the ring the seal throws, or -1 when it is idle. */
    this._shock = -1;
    /** A decaying punch on the flare, so the seal outshines the beats. */
    this._flarePunch = 0;

    // Scratch state handed to the materials each frame. One object apiece,
    // reused — syncing a standing ward allocates nothing.
    this._state = { rise: 0, dissolve: 0, beat: 0, fade: 1, seed: 0 };
    this._groundState = {
      radius: 1,
      quadSize: 1,
      grown: 0,
      front: 0,
      cool: 1,
      beat: 0,
      fade: 1,
      seed: 0
    };
    this._runeState = { radius: 1, gain: 1, beat: 0, fade: 1, seed: 0 };
    this._stoneState = { flashY: -10, fade: 1 };
    this._flareState = { size: 1, intensity: 0, shock: -1, fade: 1 };
    this._hazeState = { width: 1, height: 1, strength: 0, seed: 0 };
  }

  /** One slab shape. The variant index only perturbs the seed. */
  _buildStoneGeometry(variant) {
    const c = settings.ward;
    return createCrystalGeometry({
      seed: 7.3 + variant * 23.9,
      sides: 5,
      // Obsidian breaks into wedges, not needles: a fat taper and a lot of
      // roughness is what makes the silhouette read as fractured glass rather
      // than as a crystal — this is the same generator the ice uses, and the
      // taper is the whole difference between the two reads.
      taper: 0.44,
      roughness: 0.55,
      bend: c.monolithLean * 0.9
    });
  }

  /**
   * Regenerate the slab meshes when their *shape* changes.
   *
   * Lean is baked into the geometry as a bend, which cannot be expressed as a
   * per-instance transform — and a five-sided wedge is a hundred triangles,
   * cheap enough to simply rebuild rather than approximate. That is what keeps
   * it a live slider.
   */
  _syncStoneGeometry() {
    const key = settings.ward.monolithLean.toFixed(3);
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.stoneMeshes[v];
      const previous = mesh.geometry;
      const geometry = this._buildStoneGeometry(v);
      // The per-instance seeds are state, not shape — carry them over.
      geometry.setAttribute('aSeed', this.seedAttributes[v]);
      mesh.geometry = geometry;
      previous.dispose();
    }
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The embers: lifted off the seams and carried up the inside of the ward.
    // Positive gravity, because they are rising on their own heat.
    this.embers = particles.get('ward.embers', {
      capacity: 5000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.embers.uniforms.uDrag.value = 1.1;
    this.embers.uniforms.uEndSize.value = 0.18;
    this.embers.uniforms.uSizeIn.value = 0.04;
    this.embers.uniforms.uFadeIn.value = 0.06;
    this.embers.uniforms.uFadeOut.value = 0.42;

    // Chips of cooling obsidian. Lit and non-additive: they have to read as
    // solid, which is what stops the ward being made entirely of light.
    this.flecks = particles.get('ward.flecks', {
      capacity: 2000,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.flecks.uniforms.uDrag.value = 0.35;
    this.flecks.uniforms.uEndSize.value = 0.7;
    this.flecks.uniforms.uFadeOut.value = 0.72;

    // Gore. Non-additive on purpose — blood *occludes*, and an additive
    // droplet is a spark with a red tint on it.
    this.gore = particles.get('ward.gore', {
      capacity: 3000,
      shape: ParticleShape.SOFT,
      additive: false,
      softFade: 0.2
    });
    this.gore.uniforms.uDrag.value = 0.55;
    this.gore.uniforms.uEndSize.value = 0.55;
    this.gore.uniforms.uSizeIn.value = 0.06;
    this.gore.uniforms.uFadeIn.value = 0.04;
    this.gore.uniforms.uFadeOut.value = 0.62;

    // Smoke off the melt, so the inside of the ward has volume to stand in.
    this.smoke = particles.get('ward.smoke', {
      capacity: 2400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.9;
    this.smoke.uniforms.uEndSize.value = 3.2;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.18;
    this.smoke.uniforms.uFadeOut.value = 0.3;

    this.emberEmitter = new RateEmitter();
    this.fleckEmitter = new RateEmitter();
    this.goreEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.splatEmitter = new RateEmitter();
    this.ringEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._drawn;
  }

  /** The ward seals, then stands. */
  get impactDuration() {
    return Math.max(0.05, settings.ward.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.ward.fadeTime);
  }

  /**
   * The light does not flicker — it beats.
   *
   * `lightBeat` is how much of the light the heartbeat owns: at 0 the ward is
   * lit flat, at 1 it goes almost dark between the thumps.
   */
  lightShimmer() {
    const c = settings.ward;
    return 1 - c.lightBeat * 0.55 + c.lightBeat * this._beat * 1.35;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.ward.zoneRadius);
  }

  /** Where the surge leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.ward;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The centre of the ward — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** The surge's travelling head. Pinned to the centre once it has arrived. */
  _frontPoint(out) {
    const u = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(u, out).setY(0.12);
  }

  /**
   * How far the membrane has closed, 0..1.
   *
   * `riseCurve` above 1 makes the wall hang low and then snap up, which is what
   * gives the seal its weight: the floor and the monoliths go first and the
   * blood comes over the top of them.
   */
  _riseAmount() {
    const c = settings.ward;
    const seal = Math.max(0.01, c.sealTime);
    const t = Easing.outCubic(saturate(this._sealTime / (seal * 1.35)));
    return Math.pow(t, Math.max(0.05, c.riseCurve));
  }

  /** How far the fracture has raced out across the floor, metres. */
  _grownAmount() {
    const seal = Math.max(0.01, settings.ward.sealTime);
    // The stone goes first and fastest — it is what the wall is built on.
    return this.radius * Easing.outQuint(saturate(this._sealTime / (seal * 0.75)));
  }

  /** The height of the wall right now, metres. */
  get barrierHeight() {
    return Math.max(0.05, settings.ward.height * this._riseAmount());
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.emberEmitter.reset();
    this.fleckEmitter.reset();
    this.goreEmitter.reset();
    this.smokeEmitter.reset();
    this.splatEmitter.reset();
    this.ringEmitter.reset();

    this._markDistance = 0;
    this._sealTime = 0;
    this._beatPhase = 0;
    this._beat = 0;
    this._shock = -1;
    this._flarePunch = 0;
    this._drawn = 0;
    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this._rollStones();
    this._sync(1, 0);
    this._muzzleFx();
  }

  /**
   * Roll the ring.
   *
   * Dice only — bearings, jitters and the order they come up in. Where a slab
   * actually stands, how tall it is and how far it leans are read off the
   * sliders every frame, which is why dragging `monoliths` re-seats the ring
   * that is already standing.
   */
  _rollStones() {
    for (let i = 0; i < MAX_STONES; i++) {
      const stone = this.stones[i];
      const slab = i < MAX_SLABS;

      stone.role = slab ? Role.SLAB : Role.RUBBLE;
      stone.index = slab ? i : i - MAX_SLABS;
      // Evenly spaced, then scattered — a perfectly regular ring reads as a
      // fence, and a purely random one leaves holes you can see through.
      stone.spread = randRange(-0.5, 0.5);
      stone.radial = randRange(-1, 1);
      stone.heightJitter = randRange(-1, 1);
      stone.widthJitter = randRange(-1, 1);
      stone.leanJitter = randRange(-1, 1);
      stone.yawJitter = randRange(-0.5, 0.5);
      stone.stagger = Math.random();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame sync                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into all six materials
   * and the four particle systems.
   *
   * @param {number} fade      1 while the ward is lit, ramping to 0 as it goes
   * @param {number} collapse  0..1 through the collapse
   */
  _sync(fade, collapse) {
    const c = settings.ward;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(_pos);
    const centreX = _pos.x;
    const centreZ = _pos.z;
    const radius = this.radius;
    const rise = travelling ? 0 : this._riseAmount();
    const height = Math.max(0.05, c.height * rise);
    const beat = this._beat * saturate(fade);

    this._syncStoneGeometry();

    /* ---- the floor ---- */
    const ground = this._groundState;
    ground.radius = radius;
    ground.quadSize = (radius + c.fieldBoundary + 1.2) * 2;
    ground.grown = travelling ? 0 : this._grownAmount();
    // The leading edge of the fracture is only hot while it is still moving.
    ground.front = travelling
      ? 0
      : 1 - saturate(this._sealTime / Math.max(0.01, c.sealTime * 0.75));
    ground.cool = 1 - c.fieldCool * Easing.inQuad(saturate(collapse));
    ground.beat = beat;
    ground.fade = travelling ? 0 : fade;
    ground.seed = this._seed;
    this.groundMaterial.userData.sync(ground);

    this.ground.visible = !travelling;
    this.ground.position.set(centreX, c.fieldHeight, centreZ);
    this.ground.scale.set(ground.quadSize, 1, ground.quadSize);

    /* ---- the membrane ---- */
    const state = this._state;
    state.rise = rise;
    state.dissolve = collapse;
    state.beat = beat;
    state.fade = fade;
    state.seed = this._seed;
    for (const material of this.barrierMaterials) material.userData.sync(state);

    for (const mesh of this.barriers) {
      mesh.visible = !travelling && rise > 0.001;
      mesh.position.set(centreX, 0, centreZ);
      mesh.scale.set(radius, height, radius);
    }

    /* ---- the rune bands ---- */
    const runes = this._runeState;
    runes.radius = radius;
    runes.beat = beat;
    runes.fade = fade;
    runes.seed = this._seed;

    const throb = beat * c.throb;
    const bandHeight = Math.max(0.02, c.runeSize);
    for (const [index, mesh] of this.runeBands.entries()) {
      const top = index === 1;
      const gain = top ? c.runeTop : c.runeBase;

      // Seated on the wall itself: the bottom band on the profile where it
      // leaves the floor, the top one riding the rim as it climbs.
      const profile = 1 + throb + (top ? c.flare : 0);
      const bandRadius = radius * profile + c.runeInset;
      const y = top ? Math.max(bandHeight * 0.6, height - bandHeight) : 0.015;

      // The two bands are offset in the alphabet so the ward never shows the
      // same glyph twice on the same bearing, and the rim band goes out with
      // the wall it is riding rather than hanging in the air after it tears.
      runes.gain = gain * (top ? 1 - saturate(collapse * 1.4) : 1);
      runes.seed = this._seed + (top ? 37.7 : 0);
      this.runeMaterials[index].userData.sync(runes);

      mesh.visible =
        !travelling &&
        rise > 0.02 &&
        gain > 0.001 &&
        (top ? height > bandHeight * 1.4 : true);
      mesh.position.set(centreX, y, centreZ);
      mesh.scale.set(bandRadius, bandHeight, bandRadius);
    }

    /* ---- the obsidian ---- */
    this._syncStones(fade, collapse, travelling);

    /* ---- the core flare ---- */
    const flare = this._flareState;
    flare.size = c.flareSize * (0.55 + 0.45 * rise);
    // The seal punch on top of the beat, so the detonation outshines the pulse
    // it settles into.
    flare.intensity = (c.flareBase + this._beat * c.beatFlare + this._flarePunch) * g.explosionIntensity;
    flare.shock = this._shock;
    flare.fade = fade;
    this.flareMaterial.userData.sync(flare);

    this.flare.visible = !travelling && flare.intensity > 0.01;
    this.flare.position.set(centreX, c.flareHeight, centreZ);

    /* ---- the heat ---- */
    const haze = this._hazeState;
    haze.width = radius * 2 * c.hazeWidth;
    haze.height = Math.max(0.2, c.height * c.hazeHeight * Math.max(rise, 0.25));
    haze.strength = travelling ? 0 : fade * (0.6 + 0.4 * this._beat);
    haze.seed = this._seed;
    this.hazeMaterial.userData.sync(haze);

    this.haze.visible = !travelling;
    this.haze.position.set(centreX, haze.height * 0.5, centreZ);

    /* ---- the particle systems ---- */
    this.embers.setGradient(
      getColor(c.colorEmberA),
      getColor(c.colorEmberB),
      getColor(c.colorEmberC),
      getColor(c.colorEmberD)
    );
    this.embers.uniforms.uGravity.value.set(0, c.emberRise, 0);
    this.embers.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 7;
    this.embers.uniforms.uLifeScale.value = c.emberLifetime * 0.5 * g.particleLifetime;
    this.embers.uniforms.uSpeedScale.value = g.particleSpeed;
    this.embers.uniforms.uOpacity.value = g.opacity;
    this.embers.uniforms.uGlow.value = 1.3 * g.glow;
    this.embers.uniforms.uTurbulence.value = c.emberTurbulence * g.turbulence;

    this.flecks.setGradient(
      getColor(c.colorFleckA),
      getColor(c.colorFleckB),
      getColor(c.colorFleckC),
      getColor(c.colorFleckD)
    );
    this.flecks.uniforms.uGravity.value.set(0, c.fleckGravity, 0);
    this.flecks.uniforms.uSizeScale.value = c.fleckSize * g.particleSize * 7;
    this.flecks.uniforms.uLifeScale.value = c.fleckLifetime * 0.5 * g.particleLifetime;
    this.flecks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.flecks.uniforms.uOpacity.value = g.opacity;

    this.gore.setGradient(
      getColor(c.colorGoreA),
      getColor(c.colorGoreB),
      getColor(c.colorGoreC),
      getColor(c.colorGoreD)
    );
    this.gore.uniforms.uGravity.value.set(0, c.goreGravity, 0);
    this.gore.uniforms.uSizeScale.value = c.goreSize * g.particleSize * 7;
    this.gore.uniforms.uLifeScale.value = c.goreLifetime * 0.5 * g.particleLifetime;
    this.gore.uniforms.uSpeedScale.value = g.particleSpeed;
    this.gore.uniforms.uOpacity.value = c.goreOpacity * g.opacity;
    this.gore.uniforms.uGlow.value = 0.35 * g.glow;

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
    this.smoke.uniforms.uTurbulence.value = 0.4 * g.turbulence;
  }

  /**
   * Seat, raise and light the ring of obsidian.
   *
   * The sweep runs round the circle from wherever the surge came in, and the
   * vein flash climbs whatever is standing — both are pure functions of the
   * clock against the live sliders, so the ring re-seats itself under
   * `zoneRadius` and re-times itself under `monolithSweep` mid-cast.
   */
  _syncStones(fade, collapse, travelling) {
    const c = settings.ward;
    const g = settings.global;

    const slabCount = clampCount(c.monoliths, MAX_SLABS);
    const rubbleCount = clampCount(c.rubble, MAX_RUBBLE);
    const radius = this.radius;
    const sweep = Math.max(0.01, c.monolithSweep);

    this._centrePoint(_pos);
    const centreX = _pos.x;
    const centreZ = _pos.z;

    // The bearing the surge arrived on. The wave of stone runs round the ring
    // from the near side to the far one, which is the read that says the ward
    // *closed* rather than appeared.
    const entry = Math.atan2(-this.direction.z, -this.direction.x);

    const counts = [0, 0];
    let drawn = 0;

    for (let i = 0; i < MAX_STONES; i++) {
      const stone = this.stones[i];
      const slab = stone.role === Role.SLAB;
      const total = slab ? slabCount : rubbleCount;
      const variant = i % VARIANTS;
      const slot = counts[variant];

      const active = !travelling && stone.index < total && slot < SLOTS;
      if (!active) continue;

      // Evenly spaced around the live count, then scattered off the slot.
      const angle =
        ((stone.index + stone.spread * c.monolithSpread * g.randomness) / total) * TAU +
        (slab ? 0 : Math.PI / total);

      // The sweep: this one comes up when the wave reaches its bearing.
      const bearing = Math.abs(angleDelta(angle, entry)) / Math.PI;
      const trigger =
        (bearing * 0.75 + stone.stagger * 0.25) * sweep + (slab ? 0 : sweep * 0.35);
      const emerge = Easing.outCubic(saturate((this._sealTime - trigger) / 0.24));
      if (emerge <= 0.001) continue;

      const height = Math.max(
        0.05,
        (slab ? c.monolithHeight : c.rubbleHeight) *
          (1 + stone.heightJitter * c.monolithHeightJitter * g.randomness)
      );
      const width = Math.max(
        0.02,
        c.monolithWidth *
          (slab ? 1 : 0.72) *
          (1 + stone.widthJitter * 0.35 * g.randomness)
      );

      const ring = slab ? c.monolithRing : c.rubbleRing;
      const seat = saturate(ring + stone.radial * c.monolithJitter);
      const r = radius * seat;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      // Rises out of the floor, and sinks back into it as the ward comes apart.
      let y = (emerge - 1) * height * 0.9;
      if (collapse > 0) y -= Easing.inCubic(collapse) * (height + 0.6);

      _dummy.position.set(centreX + cosA * r, y, centreZ + sinA * r);

      // Yawed so the slab's thin axis lies along the radius — a ring of walls,
      // not a ring of posts — then leaned outward about its own tangent.
      const yaw = -angle + stone.yawJitter;
      _spin.setFromAxisAngle(_up, yaw);
      const lean = c.monolithLean * (1 + stone.leanJitter * 0.6) * (slab ? 1 : 1.8);
      _axis.set(-sinA, 0, cosA).normalize();
      _tilt.setFromAxisAngle(_axis, lean);
      _dummy.quaternion.copy(_tilt).multiply(_spin);

      _dummy.scale.set(
        width * c.monolithThin,
        height * lerp(0.88, 1, emerge),
        width
      );
      _dummy.updateMatrix();

      this.stoneMeshes[variant].setMatrixAt(slot, _dummy.matrix);
      counts[variant] = slot + 1;
      drawn++;
    }

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.stoneMeshes[v];
      mesh.count = counts[v];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = counts[v] > 0;
    }
    this._drawn = drawn;
    this._slabCount = Math.min(slabCount, MAX_SLABS);

    /* ---- the vein flash climbing them ---- */
    // One wave per beat, launched at the floor and travelling up at
    // `flashSpeed`. Parked far below when there is nothing to light.
    const state = this._stoneState;
    state.flashY = travelling ? -10 : this._beatPhase * (60 / Math.max(1, settings.ward.bpm)) * c.flashSpeed;
    state.fade = fade;
    this.obsidianMaterial.userData.sync(state);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The flash at the caster's hand as the surge leaves it. */
  _muzzleFx() {
    const c = settings.ward;
    const g = settings.global;

    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.32,
      intensity: c.muzzleIntensity,
      opacity: 0.85,
      fresnel: 1.3,
      displace: 0.6,
      colorA: getColor(c.colorBurstC),
      colorB: getColor(c.colorBurstA),
      colorC: getColor(c.colorBurstB)
    });

    _emit.position = _pos;
    _emit.radius = 0.18;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.emberSpeed * 2.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.75;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.7;
    _emit.life = c.emberLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(Math.round(30 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
  }

  /** The surge running across the floor: embers off it, marks under it. */
  _surgeFx(dt) {
    const c = settings.ward;
    const g = settings.global;
    const time = frame.uTime.value;

    const count = Math.round(this.emberEmitter.tick(dt, c.emberRate * 0.45) * g.particleCount);
    if (count > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
      _emit.speed = c.emberSpeed * 1.3;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.13;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime * 0.65;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      let remaining = count;
      const per = Math.ceil(count / Math.min(count, EMBER_BATCHES));
      while (remaining > 0) {
        this.pointAt(randRange(0.15, 1) * this.u, _pos).setY(0.1);
        _emit.position = _pos;
        _emit.radius = 0.3;
        this.embers.emit(Math.min(per, remaining), _emit);
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
      _pos.x += this.side.x * randRange(-0.5, 0.5);
      _pos.z += this.side.z * randRange(-0.5, 0.5);

      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.splatRadius * randRange(0.6, 1.1),
        life: c.splatLife * 0.6,
        intensity: c.splatIntensity * 0.8,
        colorA: getColor(c.colorSplat),
        colorB: getColor(c.colorSplatEdge),
        height: 0.028
      });
    }
  }

  /**
   * Everything the standing ward sheds.
   *
   * @param {number} scale 0..1 — thinned out as the ward comes apart
   */
  _wardFx(dt, scale) {
    const c = settings.ward;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_pos);
    const centreX = _pos.x;
    const centreZ = _pos.z;
    const radius = this.radius;
    const height = this.barrierHeight;

    /* --- embers lifted off the seams --- */
    let embers = Math.round(this.emberEmitter.tick(dt, c.emberRate * scale) * g.particleCount);
    if (embers > 0) {
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.55;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const per = Math.ceil(embers / Math.min(embers, EMBER_BATCHES));
      while (embers > 0) {
        const a = Math.random() * TAU;
        const r = radius * (1 - c.emberInset) * Math.sqrt(Math.random());
        _pos.set(centreX + Math.cos(a) * r, randRange(0.02, 0.3), centreZ + Math.sin(a) * r);
        _emit.position = _pos;
        _emit.radius = 0.22;
        this.embers.emit(Math.min(per, embers), _emit);
        embers -= per;
      }
    }

    /* --- chips off the obsidian --- */
    const flecks = Math.round(this.fleckEmitter.tick(dt, c.fleckRate * scale) * g.particleCount);
    if (flecks > 0) {
      const a = Math.random() * TAU;
      const r = radius * c.monolithRing;
      _pos.set(centreX + Math.cos(a) * r, randRange(0.2, c.monolithHeight), centreZ + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.35;
      _emit.direction = _dir.set(Math.cos(a) * 0.4, 1, Math.sin(a) * 0.4).normalize();
      _emit.speed = c.fleckSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.8;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.fleckLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.time = time;
      this.flecks.emit(flecks, _emit);
    }

    /* --- gore running down the inside of the membrane --- */
    const gore = Math.round(this.goreEmitter.tick(dt, c.goreRate * scale) * g.particleCount);
    if (gore > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.9, 1.0);
      _pos.set(centreX + Math.cos(a) * r, randRange(0.25, 1) * Math.max(height, 0.2), centreZ + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.25;
      // Thrown inward and down: the wall is shedding, not spraying.
      _emit.direction = _dir.set(-Math.cos(a) * 0.6, -0.5, -Math.sin(a) * 0.6).normalize();
      _emit.speed = c.goreSpeed * 0.45;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.6;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.75;
      _emit.life = c.goreLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.gore.emit(gore, _emit);
    }

    /* --- smoke off the melt --- */
    const smoke = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smoke > 0) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random());
      _pos.set(centreX + Math.cos(a) * r, 0.14, centreZ + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.22;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.85;
      _emit.size = 0.85;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.time = time;
      this.smoke.emit(smoke, _emit);
    }

    /* --- the marks the gore leaves on the floor --- */
    const splats = this.splatEmitter.tick(dt, c.splatRate * scale);
    for (let i = 0; i < splats; i++) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random()) * 0.95;
      _pos.set(centreX + Math.cos(a) * r, 0, centreZ + Math.sin(a) * r);
      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.splatRadius * randRange(0.55, 1.2),
        life: c.splatLife,
        intensity: c.splatIntensity,
        colorA: getColor(c.colorSplat),
        colorB: getColor(c.colorSplatEdge),
        height: 0.032
      });
    }

    /* --- dust rings pushed out across the floor --- */
    const rings = this.ringEmitter.tick(dt, c.ringRate * scale);
    for (let i = 0; i < rings; i++) {
      this._centrePoint(_pos);
      this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
        radius: radius * 1.1,
        life: 0.8,
        width: 0.06,
        intensity: 0.55,
        colorA: getColor(c.colorShockA),
        colorB: getColor(c.colorShockB)
      });
    }
  }

  /**
   * One heartbeat: what the ward does on the thump.
   *
   * Deliberately physical rather than a brightness pop — a ring of embers off
   * the floor, droplets flicked off the membrane, a ring pushed across the
   * stone and a knock on the camera. The materials handle the light; this
   * handles the *body*.
   */
  _beatFx(scale) {
    const c = settings.ward;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_pos);
    const centreX = _pos.x;
    const centreZ = _pos.z;
    const radius = this.radius;
    const height = this.barrierHeight;

    /* --- embers thrown off the whole floor --- */
    const embers = Math.round(c.beatEmbers * scale * g.particleCount);
    if (embers > 0) {
      _emit.position = _pos.set(centreX, 0.08, centreZ);
      _emit.radius = radius * 0.85;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.emberSpeed * 1.8;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.4;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.13;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime * 1.2;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(embers, _emit);
    }

    /* --- droplets flicked off the wall --- */
    const gore = Math.round(c.beatGore * scale * g.particleCount);
    if (gore > 0) {
      const a = Math.random() * TAU;
      _emit.position = _pos.set(
        centreX + Math.cos(a) * radius * 0.95,
        randRange(0.3, 0.9) * Math.max(height, 0.3),
        centreZ + Math.sin(a) * radius * 0.95
      );
      _emit.radius = 0.4;
      _emit.direction = _dir.set(-Math.cos(a), 0.35, -Math.sin(a)).normalize();
      _emit.speed = c.goreSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.8;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.8;
      _emit.life = c.goreLifetime * 1.2;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.gore.emit(gore, _emit);
    }

    /* --- the ring across the stone --- */
    if (c.beatRing > 0.001) {
      this._centrePoint(_pos);
      this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
        radius: radius * 1.15,
        life: 0.55,
        width: 0.05,
        intensity: c.beatRing * scale,
        colorA: getColor(c.colorShockA),
        colorB: getColor(c.colorShockB)
      });
    }

    this.ctx.shake.add(c.beatShake * scale * g.explosionIntensity, 3.0, 26);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.25 * scale);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // The light rides the head of the surge, just off the floor.
    this._frontPoint(this.position);
    this.position.y += 0.35;

    this._surgeFx(dt);
    this.ctx.shake.rumble(settings.ward.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.ward;
    const g = settings.global;
    const time = frame.uTime.value;

    this._sealTime = 0;
    this._shock = 0;
    this._flarePunch = 1.6;
    // The first beat lands on the seal rather than a fraction of a second
    // later — the ward's heart starts when the ward does.
    this._beatPhase = 0;
    this._beat = 1;

    const centre = this._centrePoint(_centre);

    /* the shell of scalded air the seal throws off */
    // Thin, brief and heavily fresnelled: this is pressure leaving the floor,
    // and anything solider than that parks a pale boulder inside the ward for
    // half a second — which is exactly what the first pass at it did.
    this.ctx.bursts.spawn(BurstMode.FIRE, centre, {
      radius: c.burstSize * 0.22,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.38,
      intensity: c.burstIntensity,
      opacity: 0.4,
      fresnel: 2.4,
      displace: 0.4,
      squash: 0.6, // flattened: pressure spreading over the floor
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor, past the boundary */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* the burn the ward stands on */
    this.ctx.decals.spawn(DecalType.SCORCH, centre, {
      radius: c.scorchRadius,
      life: c.scorchLife,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorMagma),
      height: 0.014
    });

    /* gore thrown out over the boundary as the floor gives way */
    _emit.position = centre;
    _emit.radius = this.radius * 0.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.goreSpeed * 2.1;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.85;
    _emit.life = c.goreLifetime * 1.5;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.gore.emit(Math.round(c.sealGore * g.particleCount), _emit);

    /* ... and everything the stone gives up with it */
    _emit.radius = this.radius * 0.7;
    _emit.speed = c.emberSpeed * 2.6;
    _emit.spread = 0.85;
    _emit.size = 0.15;
    _emit.life = c.emberLifetime * 1.3;
    this.embers.emit(Math.round(c.sealEmbers * g.particleCount), _emit);

    _emit.speed = c.fleckSpeed * 1.8;
    _emit.spread = 0.75;
    _emit.size = 0.11;
    _emit.life = c.fleckLifetime * 1.2;
    _emit.spin = 11;
    this.flecks.emit(Math.round(c.sealFlecks * g.particleCount), _emit);

    _emit.speed = c.smokeSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 1.5;
    _emit.life = c.smokeLifetime * 1.2;
    _emit.spin = 0.5;
    this.smoke.emit(Math.round(46 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.sealShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.sealFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.ward;
    this._sealTime += dt;

    // `t` runs 0..1 while the ward stands, then 1..2 while it comes apart.
    const collapse = t <= 1 ? 0 : saturate(t - 1);
    const fade = 1 - Easing.inQuad(collapse);

    /* ---- the heartbeat ---- */
    // Advanced before anything reads it, so the frame the beat lands on is the
    // frame every material, the light and the emitters see it on.
    const previous = this._beatPhase;
    this._beatPhase += (dt * Math.max(1, c.bpm)) / 60;
    if (Math.floor(this._beatPhase) > Math.floor(previous)) {
      this._beatPhase -= Math.floor(this._beatPhase);
      // The beat is skipped once the ward is genuinely dying — a corpse does
      // not pulse — but the wave still finishes climbing whatever it was on.
      if (collapse < 0.75) this._beatFx(fade);
    }
    this._beat = heartbeat(this._beatPhase % 1) * (1 - collapse * 0.65);

    // The seal's shockwave, and the punch it put on the flare, both decay on
    // their own clocks.
    if (this._shock >= 0) {
      this._shock += dt * c.shockSpeed;
      if (this._shock > 1) this._shock = -1;
    }
    this._flarePunch = Math.max(0, this._flarePunch - this._flarePunch * 3.4 * dt - 0.25 * dt);

    this._sync(fade, collapse);

    // The light sits inside the ward, part way up the wall.
    this._centrePoint(this.position);
    this.position.y = Math.max(0.3, this.barrierHeight * saturate(c.lightHeight));

    this._wardFx(dt, fade * (t <= 1 ? 1 : 0.35));
    this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._drawn = 0;
    for (const mesh of this.stoneMeshes) {
      mesh.count = 0;
      mesh.visible = false;
    }
    for (const mesh of this.barriers) mesh.visible = false;
    for (const mesh of this.runeBands) mesh.visible = false;
    this.ground.visible = false;
    this.flare.visible = false;
    this.haze.visible = false;
    for (const material of this.barrierMaterials) material.uniforms.uFade.value = 0;
    for (const material of this.runeMaterials) material.uniforms.uFade.value = 0;
    this.groundMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    this.groundGeometry.dispose();
    this.barrierGeometry.dispose();
    this.runeGeometry.dispose();
    this.flareGeometry.dispose();
    this.hazeGeometry.dispose();
    for (const mesh of this.stoneMeshes) mesh.geometry.dispose();
    for (const material of this.barrierMaterials) material.dispose();
    for (const material of this.runeMaterials) material.dispose();
    this.groundMaterial.dispose();
    this.obsidianMaterial.dispose();
    this.flareMaterial.dispose();
    this.hazeMaterial.dispose();
    super.dispose();
  }
}
