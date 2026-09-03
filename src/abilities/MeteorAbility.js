import {
  InstancedMesh,
  InstancedBufferAttribute,
  Mesh,
  Object3D,
  Quaternion,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createMeteorMaterial } from '../materials/MeteorMaterial.js';
import { VolumetricFireMaterial, fireHullReach } from '../materials/VolumetricFireMaterial.js';
import { createAsteroidGeometry } from '../assets/ProceduralGeometry.js';
import { RibbonGeometry, RibbonMode } from '../effects/RibbonGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, smoothstep, Easing, randRange } from '../utils/math.js';

/** Hard ceiling on debris chunks. The editor's `chunkCount` slider clamps here. */
const MAX_CHUNKS = 28;
/** Instance 0 is the meteor; 1.. are the chunks it breaks into. */
const SLOTS = MAX_CHUNKS + 1;
/** How many points along the frame's travel the particle trail is split between. */
const TRAIL_BATCHES = 3;
/**
 * Samples along the centre line of the flame's proxy hull. The trail is
 * *derived* from the arc rather than recorded, so this is purely how finely the
 * hull is tessellated.
 */
const TRAIL_NODES = 48;
const TAU = Math.PI * 2;

/**
 * Radius profile along the stream, 0 = tail, 1 = head, in units of `trailWidth`.
 * Must stay in step with `flameProfile()` in VolumetricFireMaterial — the JS
 * side sizes the proxy hull, the shader side shapes the actual volume, and the
 * hull has to contain it.
 */
function radiusProfile(u, headSize, wakeSpread) {
  const body = (0.34 + 0.66 * Math.pow(u, 0.55)) * (1 + wakeSpread * Math.pow(1 - u, 1.8));
  return body * (1 + (headSize - 1) * smoothstep(0.62, 1, u));
}

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _back = new Vector3();
const _heading = new Vector3();
const _impact = new Vector3();
const _ahead = new Vector3();
const _behind = new Vector3();
const _axis = new Vector3();
const _dummy = new Object3D();
const _spin = new Quaternion();

/**
 * METEOR — a burning rock thrown along the aimed line, which detonates on
 * arrival.
 *
 * One beat with a real run-up: a ball of asteroid leaves the caster's hand,
 * lobs downrange on an arc, and heats up the whole way — the lava seams split
 * wider and brighter as it comes in, so the explosion is something you watched
 * arrive. It lands, bursts, and throws its own shattered chunks across the
 * floor, where they cool while the crater burns out.
 *
 * Everything is generated: the rock is procedural geometry, its shading is a
 * patched standard material (so it takes the stage's shadows and probe), the
 * fire streaming off it is a black-body volume raymarched inside a camera-facing
 * proxy hull, and the embers, sparks, smoke and grit are GPU particles. Nothing
 * is loaded from disk and nothing is a texture.
 *
 * **The rule that makes the editor work.** `IceAbility` keeps spike records
 * holding nothing but dice; the same applies here. A cast captures one seed, one
 * tumble axis and a handful of unitless rolls per chunk — an angle, an
 * elevation, a speed jitter. Not one metre, radian or second. The trajectory,
 * the rock's size, the width of its seams, how hard the debris is thrown and how
 * fast it cools are all resolved against `settings.meteor` inside the update
 * loop, on a zero-length frame included. Dragging `arc` re-lofts a meteor that
 * is already in the air, and dragging `chunkSpeed` re-throws debris that has
 * already landed.
 *
 * The chunks are ballistic rather than integrated for exactly that reason:
 * position is a closed-form function of the time since impact, so changing the
 * numbers rewrites the whole flight instead of only what happens next.
 */
export class MeteorAbility extends Ability {
  constructor(context) {
    super('meteor', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createMeteorMaterial(this.ctx.environment);

    /** Signature of the geometry controls, so a rebuild only happens on a change. */
    this._shapeKey = '';
    this.geometry = this._buildGeometry();

    this.seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
    this.heats = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
    for (let i = 0; i < SLOTS; i++) this.seeds.array[i] = Math.random() * 10;
    this.geometry.setAttribute('aSeed', this.seeds);
    this.geometry.setAttribute('aHeat', this.heats);

    // One instanced mesh for the meteor *and* its debris: same rock, same
    // shading, one draw call, and the chunks differ only by `aSeed`, which
    // offsets the crack field so no two are split the same way.
    this.rock = new InstancedMesh(this.geometry, this.material, SLOTS);
    this.rock.castShadow = true;
    this.rock.receiveShadow = true;
    this.rock.frustumCulled = false;
    this.rock.count = 0;
    // Solid world geometry: it belongs in the depth prepass so the smoke and the
    // embers fade softly where they intersect it.
    this.rock.layers.set(LAYER.WORLD);
    this.rock.renderOrder = 2;
    this.group.add(this.rock);

    /*
     * The fire trail: a burning volume along the section of arc behind the rock.
     *
     * The mesh below is *not* the flame. It is only a camera-facing proxy hull
     * around the flight path; `VolumetricFireMaterial` reconstructs the arc's
     * local frame per fragment off the ribbon's `aCenter` / `aTangent`, fires a
     * ray from the camera and integrates emission and soot absorption through
     * the field described in that file. The hull's one job is to *contain* the
     * volume — see `_updateTrail` for the padding that guarantees it.
     *
     * The centre line is *derived* from `_arcPoint`, not recorded, so the trail
     * is a live function of the trajectory settings: dragging `arc` re-lofts the
     * fire that is already in the air along with the rock making it.
     *
     * Two points beyond the sampled window pad the hull so the volume's end caps
     * are covered by geometry, hence the `+ 2` on the segment budget.
     */
    this.ribbon = new RibbonGeometry(TRAIL_NODES + 2, { frame: true });
    this.trailPoints = [];
    for (let i = 0; i <= TRAIL_NODES; i++) this.trailPoints.push(new Vector3());
    this.hullPoints = [];
    for (let i = 0; i <= TRAIL_NODES + 2; i++) this.hullPoints.push(new Vector3());
    this.trailCount = 0;

    this.trailMaterial = new VolumetricFireMaterial();
    this.trailMesh = new Mesh(this.ribbon.geometry, this.trailMaterial);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.matrixAutoUpdate = false;
    this.trailMesh.layers.set(LAYER.VFX);
    // After the non-additive smoke (10) so the plume can occlude it, before the
    // additive particles (12) so embers in front are not dimmed by its
    // absorption.
    this.trailMesh.renderOrder = 11;
    this.group.add(this.trailMesh);

    /**
     * Fixed-size record pool — an impact allocates nothing.
     *
     * See the class comment: dice only, no dimensions.
     */
    this.chunks = [];
    for (let i = 0; i < MAX_CHUNKS; i++) {
      this.chunks.push({
        angle: 0, // bearing of the ejecta, radians
        elevation: 0, // 0..1 of the loft cone
        speed: 0, // 0..1 speed jitter
        size: 0, // 0..1 size jitter
        spin: 0, // -1..1 tumble rate
        spinAxis: new Vector3(0, 1, 0)
      });
    }

    this._chunkCount = 0;
    this._used = 0;
    this._seed = 0;
    this._tumbleAxis = new Vector3(0, 1, 0);
    /** How far along the line the trail was last paid out from. */
    this._lastU = 0;
  }

  /** The rock. Rebuilt when a *shape* control moves — see `_syncGeometry`. */
  _buildGeometry() {
    const c = settings.meteor;
    return createAsteroidGeometry({
      seed: 11.7,
      detail: c.facets,
      lumpiness: c.lumpiness,
      noiseScale: c.lumpScale,
      roughness: c.surfaceRoughness,
      cuts: c.cuts,
      cutDepth: c.cutDepth,
      craters: c.craters,
      craterDepth: c.craterDepth,
      craterSize: c.craterSize
    });
  }

  /**
   * Regenerate the rock when a *shape* control moves.
   *
   * Lumps, fracture cuts and craters displace real vertices, so they cannot be
   * faked in the vertex shader — the silhouette, the flat facets and the shadow
   * all have to see them. A subdivision-3 asteroid is 1280 triangles, cheap
   * enough to simply rebuild, which is what keeps those nine controls live.
   */
  _syncGeometry() {
    const c = settings.meteor;
    const key = [
      Math.round(c.facets),
      c.lumpiness.toFixed(3),
      c.lumpScale.toFixed(3),
      c.surfaceRoughness.toFixed(3),
      Math.round(c.cuts),
      c.cutDepth.toFixed(3),
      Math.round(c.craters),
      c.craterDepth.toFixed(3),
      c.craterSize.toFixed(3)
    ].join('|');
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    const previous = this.geometry;
    this.geometry = this._buildGeometry();
    // The per-instance attributes are state, not shape — carry them over.
    this.geometry.setAttribute('aSeed', this.seeds);
    this.geometry.setAttribute('aHeat', this.heats);
    this.rock.geometry = this.geometry;
    previous.dispose();
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Embers streaming off the rock. Buoyant, so the trail rises and hangs.
    this.embers = particles.get('meteor.embers', {
      capacity: 4000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.embers.uniforms.uDrag.value = 1.2;
    this.embers.uniforms.uEndSize.value = 0.06;
    this.embers.uniforms.uSizeIn.value = 0.05;
    this.embers.uniforms.uFadeIn.value = 0.05;
    this.embers.uniforms.uFadeOut.value = 0.3;

    // Sparks: velocity-stretched streaks under gravity.
    this.sparks = particles.get('meteor.sparks', {
      capacity: 3000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 0.7;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeOut.value = 0.5;

    // The smoke column. Non-additive: it has to *occlude*, which is what gives
    // the trail and the crater depth.
    this.smoke = particles.get('meteor.smoke', {
      capacity: 2600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.smoke.uniforms.uDrag.value = 1.7;
    this.smoke.uniforms.uEndSize.value = 3.6;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.18;
    this.smoke.uniforms.uFadeOut.value = 0.32;

    // Grit blown off the floor. Lit, so it reads as rock rather than as light.
    this.debris = particles.get('meteor.debris', {
      capacity: 1800,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.debris.uniforms.uDrag.value = 0.25;
    this.debris.uniforms.uEndSize.value = 0.85;
    this.debris.uniforms.uFadeOut.value = 0.72;

    this.emberEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._used;
  }

  /** The crater burns for `lifetime`, then everything withdraws over `fadeTime`. */
  get impactDuration() {
    return Math.max(0.2, settings.meteor.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.meteor.fadeTime);
  }

  /** Fire gutters where ice glints — a fast, uneven guttering. */
  lightShimmer() {
    const c = settings.meteor;
    const rate = Math.max(0.1, c.lightFlickerSpeed);
    const wobble = Math.sin(this.age * rate) * Math.sin(this.age * rate * 0.37 + 1.7);
    return 1 - saturate(c.lightFlicker) * (0.5 + 0.5 * wobble);
  }

  /* ------------------------------------------------------------------ */
  /* The trajectory — every metre resolved from live settings             */
  /* ------------------------------------------------------------------ */

  /**
   * Where the meteor leaves the caster, in world space.
   *
   * The base class puts `origin` on the floor because that is what the aim
   * indicator targets; a rock is thrown from a hand, so the offsets are applied
   * here rather than baked into the cast.
   */
  _launchPoint(out) {
    const c = settings.meteor;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** A point on the flight path, `s` from 0 (the hand) to 1 (the target). */
  _arcPoint(s, out) {
    const c = settings.meteor;
    const t = saturate(s);
    out
      .copy(this.origin)
      .addScaledVector(this.direction, lerp(c.handForward, this.length, t))
      .addScaledVector(this.side, c.handSide * (1 - t));
    out.y =
      lerp(c.handHeight, c.endHeight, t) +
      c.arc * Math.pow(Math.sin(t * Math.PI), Math.max(0.05, c.arcCurve));
    return out;
  }

  /**
   * Unit direction of travel at `s`.
   *
   * Differentiated numerically off `_arcPoint` rather than derived by hand: the
   * arc is a live slider, and a hand-written derivative is one more thing that
   * silently stops matching it.
   */
  _headingAt(s, out) {
    const eps = 0.01;
    this._arcPoint(s + eps, _ahead);
    this._arcPoint(s - eps, _behind);
    out.subVectors(_ahead, _behind);
    if (out.lengthSq() < 1e-8) return out.copy(this.direction);
    return out.normalize();
  }

  /** Radius of the meteor, metres. */
  _radius() {
    return Math.max(0.02, settings.meteor.radius);
  }

  /** How hot the rock is, 0 at the hand → 1 at the target. */
  _charge() {
    const c = settings.meteor;
    if (this.phase !== AbilityPhase.TRAVEL) return 1;
    return Math.pow(saturate(this.u), Math.max(0.05, c.chargeCurve));
  }

  /* ------------------------------------------------------------------ */
  /* The debris                                                          */
  /* ------------------------------------------------------------------ */

  _chunkRadius(record, c) {
    return Math.max(0.01, this._radius() * c.chunkScale * lerp(0.45, 1.15, record.size));
  }

  /** Unit direction a chunk is thrown in — a loft cone, biased downrange. */
  _chunkDirection(record, c, out) {
    const elevation = lerp(0.12, 1.4, record.elevation) * Math.max(0, c.chunkLoft);
    const flat = Math.cos(elevation);
    out.set(0, Math.sin(elevation), 0);
    out.addScaledVector(this.side, Math.cos(record.angle) * flat);
    out.addScaledVector(this.direction, Math.sin(record.angle) * flat + c.chunkForward);
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
    return out.normalize();
  }

  /**
   * Where a chunk is `elapsed` seconds after the impact.
   *
   * Closed-form ballistics rather than an integration: the whole flight is a
   * function of the live settings, so dragging `chunkSpeed` re-throws debris
   * that has already landed instead of only changing what it does next. The
   * landing time is solved for so a chunk settles on the floor rather than
   * sinking through it.
   *
   * @returns {number} the chunk's own clock, frozen at the moment it lands
   */
  _chunkFlight(record, c, elapsed, out) {
    const speed = c.chunkSpeed * lerp(0.45, 1.35, record.speed) * settings.global.particleSpeed;
    const gravity = Math.min(-0.01, c.chunkGravity);
    const rest = this._chunkRadius(record, c) * 0.8;

    this._chunkDirection(record, c, _dir);
    this._arcPoint(1, _impact);

    const vy = _dir.y * speed;
    const y0 = _impact.y;
    // 0.5·g·t² + vy·t + (y0 − rest) = 0, positive root.
    const discriminant = Math.max(0, vy * vy - 2 * gravity * (y0 - rest));
    const landing = (vy + Math.sqrt(discriminant)) / -gravity;
    const t = Math.min(elapsed, landing);

    out.copy(_impact).addScaledVector(_dir, speed * t);
    out.y = Math.max(rest, y0 + vy * t + 0.5 * gravity * t * t);
    return t;
  }

  /** Seconds since the meteor landed. */
  get _sinceImpact() {
    if (this.phase === AbilityPhase.FADE) return this.impactDuration + this.fadeTime;
    return this.phase === AbilityPhase.IMPACT ? this.impactTime : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.emberEmitter.reset();
    this.sparkEmitter.reset();
    this.smokeEmitter.reset();
    this._lastU = 0;
    this._chunkCount = 0;
    this._used = 1;

    // The only things a cast captures: a seed, a tumble axis and the chunk dice.
    this._seed = Math.random() * 100;
    this.trailMaterial.uniforms.uSeed.value = this._seed * 0.2;
    this.trailMaterial.uniforms.uHeadFade.value = 0;

    const phi = Math.acos(randRange(-1, 1));
    const theta = Math.random() * TAU;
    const sinPhi = Math.sin(phi);
    this._tumbleAxis.set(sinPhi * Math.cos(theta), Math.cos(phi), sinPhi * Math.sin(theta));

    for (const record of this.chunks) {
      record.angle = Math.random() * TAU;
      record.elevation = Math.random();
      record.speed = Math.random();
      record.size = Math.random();
      record.spin = randRange(-1, 1);
      const p = Math.acos(randRange(-1, 1));
      const a = Math.random() * TAU;
      const s = Math.sin(p);
      record.spinAxis.set(s * Math.cos(a), Math.cos(p), s * Math.sin(a));
    }

    this.rock.count = 1;

    this._syncUniforms(0);
    this._updateRock(0);
    this._updateTrail(0);
    this._launchFx();
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame state                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into every material and particle system.
   * @param {number} burn 0 while the rock is flying, → 1 as the trail dies
   */
  _syncUniforms(burn) {
    const c = settings.meteor;
    const g = settings.global;

    this._syncGeometry();

    const s = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    this._headingAt(s, _heading);
    this.material.userData.sync(this._charge(), _heading);

    // The volume is no longer being fed once the rock is gone: it thins out,
    // goes cold and tears apart rather than simply turning invisible. `sync()`
    // has just written the editor's values, so these override on top of it.
    this.trailMaterial.sync();
    const u = this.trailMaterial.uniforms;
    u.uOpacity.value = lerp(c.trailOpacity * g.opacity, 0, burn);
    u.uHeadFade.value = burn * 0.35;
    u.uDetachment.value = lerp(c.trailDetachment, 1.1, burn);

    /* --- the four particle systems --- */
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
    this.embers.uniforms.uGlow.value = c.emberGlow * g.glow;
    this.embers.uniforms.uTurbulence.value = c.emberTurbulence * g.turbulence;

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
    this.sparks.uniforms.uGlow.value = c.emberGlow * 0.8 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;

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
    this.smoke.uniforms.uTurbulence.value = 0.45 * g.turbulence;

    this.debris.setGradient(
      getColor(c.colorDebrisA),
      getColor(c.colorDebrisB),
      getColor(c.colorDebrisC),
      getColor(c.colorDebrisD)
    );
    this.debris.uniforms.uGravity.value.set(0, c.debrisGravity, 0);
    this.debris.uniforms.uSizeScale.value = c.debrisSize * g.particleSize * 7;
    this.debris.uniforms.uLifeScale.value = g.particleLifetime;
    this.debris.uniforms.uSpeedScale.value = g.particleSpeed;
    this.debris.uniforms.uOpacity.value = g.opacity;
  }

  /**
   * Rebuild every instance matrix from the live settings.
   * @param {number} retract 0..1 — the debris withdrawing into the floor
   */
  _updateRock(retract) {
    const c = settings.meteor;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    /* --- instance 0: the meteor itself --- */
    if (travelling) {
      this._arcPoint(this.u, _dummy.position);
      _axis.copy(this._tumbleAxis);
      _spin.setFromAxisAngle(_axis, this.age * c.spin);
      _dummy.quaternion.copy(_spin);
      _dummy.scale.setScalar(this._radius());
      this.heats.array[0] = 1;
    } else {
      // It shattered. Park it rather than drawing a degenerate matrix.
      _dummy.position.set(0, -999, 0);
      _dummy.quaternion.identity();
      _dummy.scale.setScalar(0.0001);
      this.heats.array[0] = 0;
    }
    _dummy.updateMatrix();
    this.rock.setMatrixAt(0, _dummy.matrix);

    /* --- the chunks --- */
    const since = this._sinceImpact;
    const cool = Math.max(0.05, c.chunkCool);

    for (let i = 0; i < this._chunkCount; i++) {
      const record = this.chunks[i];
      const radius = this._chunkRadius(record, c);
      const flight = this._chunkFlight(record, c, since, _pos);

      if (retract > 0) _pos.y -= Easing.inCubic(retract) * (radius * 2 + 0.5);

      _dummy.position.copy(_pos);
      _axis.copy(record.spinAxis);
      _spin.setFromAxisAngle(_axis, record.spin * c.chunkSpin * flight);
      _dummy.quaternion.copy(_spin);
      _dummy.scale.setScalar(radius);
      _dummy.updateMatrix();

      this.rock.setMatrixAt(1 + i, _dummy.matrix);
      this.heats.array[1 + i] = saturate(1 - since / cool);
    }

    this._used = travelling ? 1 : 1 + this._chunkCount;
    this.rock.count = this._used;
    this.rock.instanceMatrix.needsUpdate = true;
    this.heats.needsUpdate = true;
  }

  /**
   * Rebuild the camera-facing proxy hull the raymarcher renders inside.
   *
   * Its centre line is sampled straight off `_arcPoint` rather than recorded
   * from past frames, so the trail is a pure function of the trajectory settings
   * — which is what lets `arc`, `endHeight` and `trailSpan` reshape fire that is
   * already in the air, with the clock paused.
   *
   * The hull only has to *contain* the volume: it is a billboard strip whose
   * half-width follows the same radius profile as the density field, widened by
   * the volume's upward stretch and by how far the shred can push density
   * outward, and padded by a cap radius at both ends. A hull that is even
   * slightly too narrow shows up as a dead straight edge cutting across the
   * flame, which is the one way this technique fails visibly.
   *
   * @param {number} burn 0 while the rock is flying, 0 → 1 as the trail dies
   */
  _updateTrail(burn) {
    const c = settings.meteor;
    const head = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    const span = Math.max(0.05, c.trailSpan) / Math.max(0.1, this.length);
    // Once the rock is gone the tail eats its way up to the head.
    const tail = saturate(head - span * (1 - burn));

    const visible = (head - tail) * this.length > 0.06;
    this.trailMesh.visible = visible;
    if (!visible) {
      this.ribbon.clear();
      this.trailCount = 0;
      return;
    }

    const count = TRAIL_NODES + 1;
    for (let i = 0; i < count; i++) {
      this._arcPoint(lerp(tail, head, i / (count - 1)), this.trailPoints[i]);
    }
    this.trailCount = count;

    let length = 0;
    for (let i = 1; i < count; i++) length += this.trailPoints[i].distanceTo(this.trailPoints[i - 1]);
    if (length < 1e-3) {
      this.trailMesh.visible = false;
      this.ribbon.clear();
      this.trailCount = 0;
      return;
    }

    // The volume thins out as it dies rather than only fading.
    const radius = Math.max(0.01, c.trailWidth) * (1 - burn * 0.65);
    const headSize = c.trailHeadSize;
    const wakeSpread = c.trailWakeSpread;
    const headRadius = radius * headSize;
    // How far outside the nominal tube the shred *and* the silhouette bulge can
    // push density. Read live: both are editable while a cast is in flight.
    const reach = fireHullReach();
    const tailPad = radius * radiusProfile(0, 1, wakeSpread) * reach;
    const headPad = headRadius * reach;

    const hull = this.hullPoints;
    // Cap padding along the arc's own heading at each end.
    this._headingAt(tail, _heading);
    hull[0].copy(this.trailPoints[0]).addScaledVector(_heading, -tailPad);

    // The wake is hot gas: the further behind the rock it is, the longer it has
    // had to climb. Lifting the hull's centre line is enough — the raymarcher
    // reads its axis straight off this geometry.
    for (let i = 0; i < count; i++) {
      const age = 1 - i / (count - 1);
      hull[i + 1].copy(this.trailPoints[i]);
      hull[i + 1].y += c.trailRise * Math.pow(age, 1.5);
    }
    hull[0].y += c.trailRise;

    this._headingAt(head, _heading);
    hull[count + 1].copy(this.trailPoints[count - 1]).addScaledVector(_heading, headPad);

    const arcLength = tailPad + length + headPad;

    const u = this.trailMaterial.uniforms;
    u.uRadius.value = radius; // overrides sync() so the burn-out can shrink it
    u.uStreamLength.value = length;
    u.uArcLength.value = arcLength;
    u.uTailPad.value = tailPad;

    // The density field is stretched upward *and* pushed outward by the noise,
    // so the hull has to be considerably wider than the tube is round.
    const cover = 1.08 * reach * Math.max(1, c.trailPlume);

    this.ribbon.build(hull, {
      count: count + 2,
      width: 2 * headRadius * cover,
      mode: RibbonMode.BILLBOARD,
      cameraPosition: this.ctx.camera.position,
      widthProfile: (t) =>
        radiusProfile(saturate((t * arcLength - tailPad) / length), headSize, wakeSpread) / headSize
    });
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The flash at the caster's hand as the rock leaves it. */
  _launchFx() {
    const c = settings.meteor;
    const g = settings.global;

    this._launchPoint(_pos);

    // Off by default: an expanding shell this close to the camera-facing side of
    // the body reads as a ball stuck to the caster rather than as a flare, and
    // the sparks below plus the screen flash already sell the release. Dial
    // `muzzleSize` up if you want it back.
    if (c.muzzleSize > 0) {
      this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
        radius: c.muzzleSize * 0.25,
        endRadius: c.muzzleSize * g.explosionIntensity,
        life: 0.4,
        intensity: c.muzzleIntensity,
        opacity: 0.85,
        fresnel: 1.2,
        displace: 0.45,
        colorA: getColor(c.colorHot),
        colorB: getColor(c.colorFlameMid),
        colorC: getColor(c.colorFlameEdge)
      });
    }

    _emit.position = _pos;
    _emit.radius = 0.22;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.7).normalize();
    _emit.speed = c.sparkSpeed * 0.9;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime * 0.8;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(30 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
  }

  /**
   * Embers, sparks and smoke shed along the section of arc covered this frame.
   *
   * Spread over several points between the last frame's position and this one:
   * a meteor moving at 20 m/s covers a metre between frames, and firing every
   * particle from the head leaves the trail visibly beaded.
   */
  _trailFx(dt) {
    const c = settings.meteor;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this._radius();

    // The trail is pushed off the *back* of the rock, and the rock is gone.
    this._headingAt(this.u, _heading);
    _back.copy(_heading).multiplyScalar(-1);

    let emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate) * g.particleCount);
    if (emberCount > 0) {
      _emit.direction = _dir.copy(_back).setY(_back.y + 0.35).normalize();
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.13;
      _emit.sizeVariance = 0.6;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const batches = Math.min(emberCount, TRAIL_BATCHES);
      const per = Math.ceil(emberCount / batches);
      while (emberCount > 0) {
        this._arcPoint(lerp(this._lastU, this.u, Math.random()), _pos);
        _emit.position = _pos;
        _emit.radius = radius * 0.9;
        this.embers.emit(Math.min(per, emberCount), _emit);
        emberCount -= per;
      }
    }

    const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate) * g.particleCount);
    if (sparkCount > 0) {
      this._arcPoint(lerp(this._lastU, this.u, Math.random()), _pos);
      _emit.position = _pos;
      _emit.radius = radius * 0.7;
      _emit.direction = _dir.copy(_back).setY(_back.y + 0.2).normalize();
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.95;
      _emit.size = 0.15;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate) * g.particleCount);
    if (smokeCount > 0) {
      this._arcPoint(lerp(this._lastU, this.u, Math.random()), _pos);
      _emit.position = _pos;
      _emit.radius = radius * 1.1;
      _emit.direction = _dir.copy(_back);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.75;
      _emit.size = 0.85;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.5;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /** The crater keeps burning after the rock is gone. */
  _craterFx(dt, scale) {
    const c = settings.meteor;
    const g = settings.global;
    const time = frame.uTime.value;

    this._arcPoint(1, _impact);

    const emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate * 0.5 * scale) * g.particleCount);
    if (emberCount > 0) {
      _emit.position = _pos.copy(_impact).setY(0.25);
      _emit.radius = c.scorchRadius * 0.9;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.emberSpeed * 0.8;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.6;
      _emit.life = c.emberLifetime * 1.2;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(emberCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * 0.8 * scale) * g.particleCount);
    if (smokeCount > 0) {
      _emit.position = _pos.copy(_impact).setY(0.2);
      _emit.radius = c.scorchRadius * 1.1;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed * 1.2;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.85;
      _emit.size = 1.3;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime * 1.4;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.6;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._syncUniforms(0);

    // The light rides the meteor, not the floor under it. `advance()` has
    // already put `position` on the ground line, so lift it onto the arc.
    this._arcPoint(this.u, this.position);

    this._updateRock(0);
    this._updateTrail(0);
    this._trailFx(dt);
    this._lastU = this.u;

    this.ctx.shake.rumble(settings.meteor.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.meteor;
    const g = settings.global;
    const time = frame.uTime.value;
    const scale = c.burstSize * g.explosionIntensity;

    this._chunkCount = Math.min(MAX_CHUNKS, Math.max(0, Math.round(c.chunkCount)));

    const hot = getColor(c.colorHot);
    const mid = getColor(c.colorFlameMid);
    const edge = getColor(c.colorFlameEdge);

    this._arcPoint(1, _impact);
    _pos.copy(_impact).setY(_impact.y + scale * 0.28);

    /* the fireball, and a faster inner flash that sells the detonation */
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: scale * 0.22,
      endRadius: scale,
      life: 0.9,
      intensity: c.burstIntensity,
      opacity: 0.95,
      fresnel: 1.1,
      displace: 0.55,
      turbulence: c.burstTurbulence * 0.6,
      colorA: hot,
      colorB: mid,
      colorC: edge
    });
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: scale * 0.1,
      endRadius: scale * 0.55,
      life: 0.35,
      intensity: c.burstIntensity * 2.2,
      opacity: 1.0,
      displace: 0.2,
      colorA: hot,
      colorB: hot,
      colorC: mid
    });

    /* the ring that snaps outward across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _impact, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.65,
      width: 0.07,
      intensity: 1.2,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /*
     * The crater: real molten cracks torn through the floor. Not a decal — a
     * grown network of ribbons with basalt heaved up along its lips. See
     * `effects/GroundFissures.js`.
     */
    this.ctx.fissures.spawn(_impact, {
      radius: c.fissureRadius * g.explosionIntensity,
      life: c.fissureLife
    });

    /* a burnt patch under the lot */
    this.ctx.decals.spawn(DecalType.SCORCH, _impact, {
      radius: c.scorchRadius * g.explosionIntensity,
      life: c.scorchLife,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorCrack),
      height: 0.015
    });

    /* everything thrown out of it */
    _emit.position = _pos;
    _emit.radius = scale * 0.22;
    _emit.direction = _dir.set(0, 0.6, 0);
    _emit.speed = c.emberSpeed * 2.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.7;
    _emit.life = c.emberLifetime * 1.5;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(Math.round(c.burstEmbers * g.particleCount), _emit);

    _emit.speed = c.sparkSpeed * 2.4;
    _emit.size = 0.22;
    _emit.life = c.sparkLifetime * 1.6;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.position = _pos.copy(_impact).setY(0.25);
    _emit.radius = c.scorchRadius * 0.7;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.debrisSpeed;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.85;
    _emit.size = 0.15;
    _emit.life = c.debrisLifetime;
    _emit.spin = 9;
    this.debris.emit(Math.round(c.burstDebris * g.particleCount), _emit);

    _emit.speed = c.smokeSpeed * 2.6;
    _emit.spread = 1.0;
    _emit.size = 1.7;
    _emit.sizeVariance = 0.5;
    _emit.life = c.smokeLifetime * 1.6;
    _emit.spin = 0.6;
    this.smoke.emit(Math.round(c.burstSmoke * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 2.4 * g.explosionIntensity;

    this._updateRock(0);
    this._updateTrail(0);
  }

  onFade(dt, t) {
    const c = settings.meteor;

    // The trail is no longer being fed, so it burns back from the head.
    const burn = saturate(this._sinceImpact / Math.max(0.05, c.trailBurnout));
    this._syncUniforms(burn);

    // The light drops onto the crater and stays there.
    this._arcPoint(1, this.position);

    let retract = 0;
    if (this.phase === AbilityPhase.FADE) {
      retract = saturate((this.fadeTime - c.chunkLinger) / Math.max(0.05, c.chunkSink));
    }

    this._updateRock(retract);
    this._updateTrail(burn);

    // The crater burns while the debris lies there, and stops as it withdraws.
    // `t` runs 0..1 through the burn, then 1..2 while everything is cleared.
    if (retract < 0.6) this._craterFx(dt, t <= 1 ? 1 - t * 0.5 : 0.25);
  }

  onDestroy() {
    this._chunkCount = 0;
    this._used = 0;
    this.trailCount = 0;
    this.rock.count = 0;
    this.ribbon.clear();
    this.trailMesh.visible = false;
  }

  dispose() {
    this.geometry.dispose();
    this.ribbon.dispose();
    this.rock.dispose();
    this.material.dispose();
    this.trailMaterial.dispose();
    super.dispose();
  }
}
