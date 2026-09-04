import { Mesh, PlaneGeometry, CylinderGeometry, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createAcidPoolMaterial } from '../materials/AcidPoolMaterial.js';
import {
  createToxicMistMaterial,
  createAcidRingMaterial,
  createAcidCollarMaterial,
  createAcidFumeMaterial
} from '../materials/ToxicMistMaterial.js';
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

/** Radial segments on the volume's proxy cylinder. */
const MIST_SEGMENTS = 48;
/**
 * A regular polygon *inscribes* its circle, so a proxy scaled to the analytic
 * radius cuts the corners off the volume it is supposed to find — and a marched
 * cloud with flats on its silhouette is the one tell you cannot explain away.
 * Scaling by the reciprocal of the inradius circumscribes it instead.
 */
const MIST_CIRCUMSCRIBE = 1 / Math.cos(Math.PI / MIST_SEGMENTS);

/** How many points one frame's motes are split between. A single origin reads as a hose. */
const MOTE_BATCHES = 4;

const _emit = {};
const _pos = new Vector3();
const _centre = new Vector3();
const _dir = new Vector3();

/**
 * The boil, 0..1 — the envelope every pass of this ability is driven off.
 *
 * Three sines at incommensurate frequencies (1, φ, 1+√2). Their sum has no
 * period: within the six seconds an aura stands, the surge never lands twice on
 * the same rhythm, which is the entire difference between something reacting and
 * something looping. That matters more here than anywhere else in the project —
 * a heartbeat is *supposed* to be regular, and a chemical reaction very much is
 * not.
 *
 * The caller raises the result to `boilSharp`, which is what turns this from a
 * throb into a boil: at a power the envelope spends most of its time near zero
 * and spikes, so the aura is mostly still and occasionally vents.
 *
 * @param {number} t phase, seconds × `boilRate`
 */
function boilEnvelope(t) {
  const a = Math.sin(t);
  const b = Math.sin(t * 1.6180339 + 1.31);
  const c = Math.sin(t * 2.4142136 + 4.07);
  return saturate(((a + b * 0.72 + c * 0.46) / 2.18) * 0.5 + 0.5);
}

/**
 * ACID — the Caustic Bloom, and the only ability in the set built around a
 * **volume** rather than around surfaces.
 *
 * A slick of corrosion runs across the floor to the aimed circle. The stone
 * inside it crazes and dissolves into a pool of live acid, a ring of light snaps
 * out along the boundary, and a column of toxic gas climbs out of the pool and
 * stands over it, boiling. It holds; then the acid goes inert, the gas sinks
 * back into the floor and what is left is a stain.
 *
 * Five passes, one per panel of the reference sheet:
 *
 *   1. **acid ground decal** — a two-nearest voronoi crazing over an alpha
 *      blended crust, with pits eaten clean through it, caustics on the standing
 *      liquid and a real specular lobe, because the one thing the pool has to
 *      say before anything else is *wet*.
 *   2. **toxic mist cylinder** — a raymarched volume with an analytic span, cut
 *      against the depth prepass so the character is genuinely *inside* it, and
 *      lit from underneath by the pool.
 *   3. **bubbling particles** — gas held in a film: a silhouette that is a ring
 *      rather than a disc, one catchlight, and a burst instead of a fade.
 *   4. **corrosive heat distortion** — a screen-space warp proxy on
 *      LAYER.DISTORTION that rolls about the column instead of shivering
 *      straight up.
 *   5. **base glowing ring** — a flat annulus for the bloom and a standing
 *      collar so the band keeps a silhouette at eye level.
 *
 * **The boil is what makes those five things one thing.** `_boil` is evaluated
 * once per frame from `boilRate` and handed to every material, the light, the
 * emitters and the camera. The pool brightens along its channels, the gas swells
 * from its feet up, the ring gains, the shimmer thickens, bubbles come faster —
 * and when a surge crosses `boilThreshold` on the way up, the aura *vents*: a
 * gout of gas, a ring across the pool and a knock on the camera. Nothing in here
 * free-runs on its own sine, and that is the difference between a stack of
 * effects and one reaction.
 *
 * **The rule that makes the editor work.** A cast captures one number — a seed —
 * and a handful of timestamps. Not one metre, radian or second is recorded: the
 * footprint, the pool, the column, the ring and the shimmer are all resolved
 * against `settings.acid` inside the update loop, which runs on a zero-length
 * frame too. Drag `zoneRadius` while an aura is standing and the whole thing —
 * crazing, boundary, ring, gas column, shimmer — re-scales around it.
 */
export class AcidAbility extends Ability {
  constructor(context) {
    super('acid', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the pool ---- */
    this.poolGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.poolMaterial = createAcidPoolMaterial();
    this.pool = new Mesh(this.poolGeometry, this.poolMaterial);
    this.pool.name = 'AcidPool';
    this.pool.layers.set(LAYER.VFX);
    this.pool.renderOrder = 5; // under the stains, so the marks land on top
    this.pool.frustumCulled = false;
    this.pool.visible = false;
    this.group.add(this.pool);

    /* ---- the volume ---- */
    // A *closed* unit cylinder — radius 1, y from 0 to 1 — drawn back faces
    // only. It is a scissor and nothing else: it exists to rasterise the pixels
    // the volume could cover, and the caps are there so looking straight down
    // the column still fills the middle of the screen. Every metre of the actual
    // cloud is solved analytically in the fragment stage.
    this.mistGeometry = new CylinderGeometry(1, 1, 1, MIST_SEGMENTS, 1, false).translate(0, 0.5, 0);
    this.mistMaterial = createToxicMistMaterial();
    this.mist = new Mesh(this.mistGeometry, this.mistMaterial);
    this.mist.name = 'AcidMist';
    this.mist.layers.set(LAYER.VFX);
    this.mist.renderOrder = 9;
    this.mist.frustumCulled = false;
    this.mist.visible = false;
    this.group.add(this.mist);

    /* ---- the ring on the floor ---- */
    this.ringGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.ringMaterial = createAcidRingMaterial();
    this.ring = new Mesh(this.ringGeometry, this.ringMaterial);
    this.ring.name = 'AcidRing';
    this.ring.layers.set(LAYER.VFX);
    this.ring.renderOrder = 14; // over the gas: it is the brightest thing here
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.group.add(this.ring);

    /* ---- and the band standing on it ---- */
    this.collarGeometry = new CylinderGeometry(1, 1, 1, 96, 1, true).translate(0, 0.5, 0);
    this.collarMaterial = createAcidCollarMaterial();
    this.collar = new Mesh(this.collarGeometry, this.collarMaterial);
    this.collar.name = 'AcidCollar';
    this.collar.layers.set(LAYER.VFX);
    this.collar.renderOrder = 14;
    this.collar.frustumCulled = false;
    this.collar.visible = false;
    this.group.add(this.collar);

    /* ---- the shimmer coming off it ---- */
    this.fumeGeometry = new PlaneGeometry(1, 1, 1, 1);
    this.fumeMaterial = createAcidFumeMaterial();
    this.fume = new Mesh(this.fumeGeometry, this.fumeMaterial);
    this.fume.name = 'AcidFume';
    this.fume.layers.set(LAYER.DISTORTION);
    this.fume.frustumCulled = false;
    this.fume.visible = false;
    this.group.add(this.fume);

    /** Re-rolled per cast so no two blooms craze the same way. */
    this._seed = 0;
    /** Seconds since the pool began to open. Drives the bloom, nothing else. */
    this._bloomTime = 0;
    /** Metres of corrosion travel already paid out in ground marks. */
    this._markDistance = 0;
    /** Phase through the boil, and the envelope it produces. */
    this._boilPhase = 0;
    this._boilRaw = 0;
    this._boil = 0;

    // Scratch state handed to the materials each frame. One object apiece,
    // reused — syncing a standing aura allocates nothing.
    this._poolState = {
      radius: 1,
      quadSize: 1,
      grown: 0,
      front: 0,
      spent: 1,
      boil: 0,
      fade: 1,
      seed: 0
    };
    this._mistState = {
      centre: new Vector3(),
      radius: 1,
      height: 1,
      boil: 0,
      dissolve: 0,
      fade: 1,
      seed: 0
    };
    this._ringState = { radius: 1, quadSize: 1, gain: 1, boil: 0, fade: 1, seed: 0 };
    this._collarState = { gain: 1, boil: 0, fade: 1, seed: 0 };
    this._fumeState = { width: 1, height: 1, strength: 0, boil: 0, seed: 0 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The bubbles. Non-additive on purpose — a bubble is a *film*, it occludes
    // and it has a specular catchlight, and an additive one is a spark with a
    // green tint on it. This is the system the BUBBLE shape was added for.
    this.bubbles = particles.get('acid.bubbles', {
      capacity: 1600,
      shape: ParticleShape.BUBBLE,
      additive: false,
      curl: true,
      softFade: 0.3
    });
    this.bubbles.uniforms.uDrag.value = 1.4;
    this.bubbles.uniforms.uSizeIn.value = 0.05;
    this.bubbles.uniforms.uFadeIn.value = 0.06;
    // Nothing here fades: the shape bursts on its own in the last of its life,
    // so the alpha has to still be up when it does.
    this.bubbles.uniforms.uFadeOut.value = 0.94;

    // Sparks of live acid picked up off the channels. Additive and rising.
    this.motes = particles.get('acid.motes', {
      capacity: 4000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.motes.uniforms.uDrag.value = 1.2;
    this.motes.uniforms.uEndSize.value = 0.2;
    this.motes.uniforms.uSizeIn.value = 0.04;
    this.motes.uniforms.uFadeIn.value = 0.06;
    this.motes.uniforms.uFadeOut.value = 0.4;

    // The low spill. Its real job is to break the volume's boundary: a
    // raymarched cylinder has a mathematically exact edge, and a little fog
    // wandering across it is what stops that edge being a visible wall.
    this.fog = particles.get('acid.fog', {
      capacity: 2200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.fog.uniforms.uDrag.value = 1.8;
    this.fog.uniforms.uEndSize.value = 3.0;
    this.fog.uniforms.uSizeIn.value = 0.14;
    this.fog.uniforms.uFadeIn.value = 0.2;
    this.fog.uniforms.uFadeOut.value = 0.3;

    // Thrown liquid. Non-additive so it reads wet, and heavy so it lands.
    this.splash = particles.get('acid.splash', {
      capacity: 2000,
      shape: ParticleShape.SOFT,
      additive: false,
      softFade: 0.2
    });
    this.splash.uniforms.uDrag.value = 0.5;
    this.splash.uniforms.uEndSize.value = 0.5;
    this.splash.uniforms.uSizeIn.value = 0.05;
    this.splash.uniforms.uFadeIn.value = 0.04;
    this.splash.uniforms.uFadeOut.value = 0.6;

    this.bubbleEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.fogEmitter = new RateEmitter();
    this.splashEmitter = new RateEmitter();
    this.stainEmitter = new RateEmitter();
    this.ringEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** The pool opens, then the aura stands. */
  get impactDuration() {
    return Math.max(0.05, settings.acid.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.acid.fadeTime);
  }

  /**
   * The light does not flicker — it boils.
   *
   * `lightBoil` is how much of the light the surge owns: at 0 the aura is lit
   * flat, at 1 it goes nearly dark between vents.
   */
  lightShimmer() {
    const c = settings.acid;
    return 1 - c.lightBoil * 0.5 + c.lightBoil * this._boil * 1.4;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.acid.zoneRadius);
  }

  /** Where the corrosion leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.acid;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The centre of the aura — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** The corrosion's travelling head. Pinned to the centre once it has arrived. */
  _frontPoint(out) {
    const u = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(u, out).setY(0.1);
  }

  /** How far the corrosion has eaten out across the floor, metres. */
  _grownAmount() {
    const bloom = Math.max(0.01, settings.acid.bloomTime);
    // The floor goes first and fastest — the gas is what comes off it.
    return this.radius * Easing.outQuint(saturate(this._bloomTime / (bloom * 0.8)));
  }

  /**
   * How far the column has climbed, 0..1.
   *
   * `riseCurve` above 1 makes the gas hang at the floor and then climb, which is
   * what gives the bloom its order: the pool opens, the ring snaps out, and the
   * mist comes up out of both of them rather than with them.
   */
  _riseAmount() {
    const c = settings.acid;
    const bloom = Math.max(0.01, c.bloomTime);
    const t = Easing.outCubic(saturate(this._bloomTime / (bloom * 1.6)));
    return Math.pow(t, Math.max(0.05, c.riseCurve));
  }

  /** The height of the gas column right now, metres. */
  get mistHeight() {
    return Math.max(0.05, settings.acid.mistHeight * this._riseAmount());
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.bubbleEmitter.reset();
    this.moteEmitter.reset();
    this.fogEmitter.reset();
    this.splashEmitter.reset();
    this.stainEmitter.reset();
    this.ringEmitter.reset();

    this._markDistance = 0;
    this._bloomTime = 0;
    // Started somewhere arbitrary in the envelope, so two auras standing at once
    // are never in step — which is the whole point of an irregular pulse.
    this._boilPhase = Math.random() * 40;
    this._boilRaw = 0;
    this._boil = 0;
    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this._sync(1, 0);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame sync                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into all five materials
   * and the four particle systems.
   *
   * @param {number} fade      1 while the aura is live, ramping to 0 as it goes
   * @param {number} collapse  0..1 through the collapse
   */
  _sync(fade, collapse) {
    const c = settings.acid;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(_pos);
    const centreX = _pos.x;
    const centreZ = _pos.z;
    const radius = this.radius;
    const rise = travelling ? 0 : this._riseAmount();
    const boil = this._boil * saturate(fade);

    /* ---- the pool ---- */
    const pool = this._poolState;
    pool.radius = radius;
    pool.quadSize = (radius + c.poolBoundary + 1.4) * 2;
    pool.grown = travelling ? 0 : this._grownAmount();
    // The leading edge of the corrosion is only live while it is still moving.
    pool.front = travelling
      ? 0
      : 1 - saturate(this._bloomTime / Math.max(0.01, c.bloomTime * 0.8));
    pool.spent = 1 - c.poolSpend * Easing.inQuad(saturate(collapse));
    pool.boil = boil;
    pool.fade = travelling ? 0 : fade;
    pool.seed = this._seed;
    this.poolMaterial.userData.sync(pool);

    this.pool.visible = !travelling;
    this.pool.position.set(centreX, c.poolHeight, centreZ);
    this.pool.scale.set(pool.quadSize, 1, pool.quadSize);

    /* ---- the volume ---- */
    const mist = this._mistState;
    mist.centre.set(centreX, 0, centreZ);
    mist.radius = radius;
    mist.height = Math.max(0.05, c.mistHeight * rise);
    mist.boil = boil;
    mist.dissolve = Easing.inQuad(saturate(collapse));
    mist.fade = fade;
    mist.seed = this._seed;
    this.mistMaterial.userData.sync(mist);

    // The proxy has to contain every metre the analytic shape can reach, or the
    // cloud would be clipped by the box that is only supposed to find it.
    const span =
      radius * (1 + Math.max(0, c.mistFlare) + Math.max(0, c.mistSkirt)) * MIST_CIRCUMSCRIBE;
    this.mist.visible = !travelling && rise > 0.001;
    this.mist.position.set(centreX, 0, centreZ);
    this.mist.scale.set(span, mist.height, span);

    /* ---- the ring, and the band standing on it ---- */
    const ringRadius = radius + c.ringInset;
    // Snaps out ahead of the gas: the ring is the boundary being drawn, and it
    // has to be readable before the cloud arrives to sit inside it.
    const ringGain = travelling
      ? 0
      : Easing.outCubic(saturate(this._bloomTime / Math.max(0.01, c.bloomTime * 0.5)));

    const ring = this._ringState;
    ring.radius = ringRadius;
    ring.quadSize = (ringRadius + c.ringHaloWidth * 3 + 1.0) * 2;
    ring.gain = ringGain;
    ring.boil = boil;
    ring.fade = fade;
    ring.seed = this._seed;
    this.ringMaterial.userData.sync(ring);

    this.ring.visible = !travelling && ringGain > 0.001;
    this.ring.position.set(centreX, c.ringHeight, centreZ);
    this.ring.scale.set(ring.quadSize, 1, ring.quadSize);

    const collar = this._collarState;
    collar.gain = ringGain;
    collar.boil = boil;
    collar.fade = fade;
    collar.seed = this._seed;
    this.collarMaterial.userData.sync(collar);

    const collarHeight = Math.max(0.02, c.collarHeight * ringGain);
    this.collar.visible = this.ring.visible && c.collarGain > 0.001;
    this.collar.position.set(centreX, c.ringHeight, centreZ);
    this.collar.scale.set(ringRadius, collarHeight, ringRadius);

    /* ---- the shimmer ---- */
    const fume = this._fumeState;
    fume.width = radius * 2 * c.fumeWidth;
    fume.height = Math.max(0.2, c.mistHeight * c.fumeHeight * Math.max(rise, 0.25));
    fume.strength = travelling ? 0 : fade;
    fume.boil = boil;
    fume.seed = this._seed;
    this.fumeMaterial.userData.sync(fume);

    this.fume.visible = !travelling;
    this.fume.position.set(centreX, fume.height * 0.5, centreZ);

    /* ---- the particle systems ---- */
    this.bubbles.setGradient(
      getColor(c.colorBubbleA),
      getColor(c.colorBubbleB),
      getColor(c.colorBubbleC),
      getColor(c.colorBubbleD)
    );
    this.bubbles.uniforms.uGravity.value.set(0, c.bubbleRise, 0);
    this.bubbles.uniforms.uSizeScale.value = c.bubbleSize * g.particleSize * 7;
    this.bubbles.uniforms.uLifeScale.value = c.bubbleLifetime * 0.5 * g.particleLifetime;
    this.bubbles.uniforms.uSpeedScale.value = g.particleSpeed;
    this.bubbles.uniforms.uOpacity.value = c.bubbleOpacity * g.opacity;
    // A bubble does not shrink — the gas inside it expands as it rises, and
    // then the film cannot hold it.
    this.bubbles.uniforms.uEndSize.value = c.bubbleGrow;
    this.bubbles.uniforms.uGlow.value = 1.0 * g.glow;
    this.bubbles.uniforms.uTurbulence.value = c.bubbleTurbulence * g.turbulence;

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
    this.motes.uniforms.uGlow.value = 1.4 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.fog.setGradient(
      getColor(c.colorFogA),
      getColor(c.colorFogB),
      getColor(c.colorFogC),
      getColor(c.colorFogD)
    );
    this.fog.uniforms.uGravity.value.set(0, c.fogRise, 0);
    this.fog.uniforms.uSizeScale.value = c.fogSize * g.particleSize;
    this.fog.uniforms.uLifeScale.value = c.fogLifetime * 0.5 * g.particleLifetime;
    this.fog.uniforms.uSpeedScale.value = c.fogSpeed * g.particleSpeed;
    this.fog.uniforms.uOpacity.value = c.fogOpacity * g.opacity;
    this.fog.uniforms.uTurbulence.value = 0.45 * g.turbulence;

    this.splash.setGradient(
      getColor(c.colorSplashA),
      getColor(c.colorSplashB),
      getColor(c.colorSplashC),
      getColor(c.colorSplashD)
    );
    this.splash.uniforms.uGravity.value.set(0, c.splashGravity, 0);
    this.splash.uniforms.uSizeScale.value = c.splashSize * g.particleSize * 7;
    this.splash.uniforms.uLifeScale.value = c.splashLifetime * 0.5 * g.particleLifetime;
    this.splash.uniforms.uSpeedScale.value = g.particleSpeed;
    this.splash.uniforms.uOpacity.value = c.splashOpacity * g.opacity;
    this.splash.uniforms.uGlow.value = 0.5 * g.glow;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The flash at the caster's hand as the corrosion leaves it. */
  _muzzleFx() {
    const c = settings.acid;
    const g = settings.global;

    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.WATER, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.3,
      intensity: c.muzzleIntensity,
      opacity: 0.8,
      fresnel: 1.5,
      displace: 0.55,
      colorA: getColor(c.colorBurstC),
      colorB: getColor(c.colorBurstA),
      colorC: getColor(c.colorBurstB)
    });

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.moteSpeed * 2.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(26 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /** The corrosion running across the floor: sparks off it, marks under it. */
  _creepFx(dt) {
    const c = settings.acid;
    const g = settings.global;
    const time = frame.uTime.value;

    const count = Math.round(this.moteEmitter.tick(dt, c.moteRate * 0.4) * g.particleCount);
    if (count > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.3).setY(1).normalize();
      _emit.speed = c.moteSpeed * 1.2;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime * 0.6;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      let remaining = count;
      const per = Math.ceil(count / Math.min(count, MOTE_BATCHES));
      while (remaining > 0) {
        this.pointAt(randRange(0.15, 1) * this.u, _pos).setY(0.08);
        _emit.position = _pos;
        _emit.radius = 0.28;
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
      _pos.x += this.side.x * randRange(-0.5, 0.5);
      _pos.z += this.side.z * randRange(-0.5, 0.5);

      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.stainRadius * randRange(0.6, 1.1),
        life: c.stainLife * 0.6,
        intensity: c.stainIntensity * 0.8,
        colorA: getColor(c.colorStain),
        colorB: getColor(c.colorStainEdge),
        height: 0.026
      });
    }
  }

  /**
   * Everything the standing aura sheds.
   *
   * @param {number} scale 0..1 — thinned out as the acid goes inert
   */
  _auraFx(dt, scale) {
    const c = settings.acid;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_pos);
    const centreX = _pos.x;
    const centreZ = _pos.z;
    const radius = this.radius;
    // The boil is felt in the *rate*, not only in the brightness: the pool
    // visibly gives up more gas on a surge.
    const surge = 1 + this._boil * c.boilDepth;

    /* --- bubbles off the pool --- */
    const bubbles = Math.round(
      this.bubbleEmitter.tick(dt, c.bubbleRate * scale * surge) * g.particleCount
    );
    if (bubbles > 0) {
      const a = Math.random() * TAU;
      // sqrt over the radius, or every bubble crowds the middle.
      const r = radius * (1 - c.bubbleInset) * Math.sqrt(Math.random());
      _pos.set(centreX + Math.cos(a) * r, randRange(0.02, 0.2), centreZ + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.3;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.bubbleSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.35;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.65;
      _emit.life = c.bubbleLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.bubbles.emit(bubbles, _emit);
    }

    /* --- sparks lifted off the channels --- */
    let motes = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale * surge) * g.particleCount);
    if (motes > 0) {
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.55;
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
        const a = Math.random() * TAU;
        const r = radius * Math.sqrt(Math.random());
        _pos.set(centreX + Math.cos(a) * r, randRange(0.02, 0.28), centreZ + Math.sin(a) * r);
        _emit.position = _pos;
        _emit.radius = 0.2;
        this.motes.emit(Math.min(per, motes), _emit);
        motes -= per;
      }
    }

    /* --- the low spill over the boundary --- */
    const fog = Math.round(this.fogEmitter.tick(dt, c.fogRate * scale) * g.particleCount);
    if (fog > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.55, 1.05);
      _pos.set(centreX + Math.cos(a) * r, 0.12, centreZ + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.18;
      // Outward and barely up: this is heavy gas running off the edge of the
      // pool, and it is the thing that hides the volume's exact boundary.
      _emit.direction = _dir.set(Math.cos(a) * c.fogSpread, 0.35, Math.sin(a) * c.fogSpread).normalize();
      _emit.speed = c.fogSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.8;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.fogLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.time = time;
      this.fog.emit(fog, _emit);
    }

    /* --- droplets flicked off the surface --- */
    const splash = Math.round(
      this.splashEmitter.tick(dt, c.splashRate * scale * surge) * g.particleCount
    );
    if (splash > 0) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random()) * 0.9;
      _pos.set(centreX + Math.cos(a) * r, 0.1, centreZ + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.2;
      _emit.direction = _dir.set(Math.cos(a) * 0.35, 1, Math.sin(a) * 0.35).normalize();
      _emit.speed = c.splashSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.55;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.75;
      _emit.life = c.splashLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.splash.emit(splash, _emit);
    }

    /* --- the marks the splatter leaves --- */
    const stains = this.stainEmitter.tick(dt, c.stainRate * scale);
    for (let i = 0; i < stains; i++) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random()) * 1.05;
      _pos.set(centreX + Math.cos(a) * r, 0, centreZ + Math.sin(a) * r);
      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.stainRadius * randRange(0.55, 1.2),
        life: c.stainLife,
        intensity: c.stainIntensity,
        colorA: getColor(c.colorStain),
        colorB: getColor(c.colorStainEdge),
        height: 0.03
      });
    }

    /* --- vapour rings pushed out across the floor --- */
    const rings = this.ringEmitter.tick(dt, c.ringRate * scale);
    for (let i = 0; i < rings; i++) {
      this._centrePoint(_pos);
      this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
        radius: radius * 1.15,
        life: 0.9,
        width: 0.065,
        intensity: 0.45,
        colorA: getColor(c.colorShockA),
        colorB: getColor(c.colorShockB)
      });
    }
  }

  /**
   * A vent: what the aura does when a surge crosses the threshold.
   *
   * Deliberately physical rather than a brightness pop — the materials already
   * gain on `_boil`, so this is the *body* of the surge: gas actually leaving
   * the pool, a ring pushed out across it, and a knock on the camera.
   */
  _goutFx(scale) {
    const c = settings.acid;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_pos);
    const centreX = _pos.x;
    const centreZ = _pos.z;
    const radius = this.radius;

    /* --- a gout of bubbles off the whole pool --- */
    const bubbles = Math.round(c.goutBubbles * scale * g.particleCount);
    if (bubbles > 0) {
      _emit.position = _pos.set(centreX, 0.08, centreZ);
      _emit.radius = radius * 0.8;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.bubbleSpeed * c.goutLift;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.3;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.16;
      _emit.sizeVariance = 0.7;
      _emit.life = c.bubbleLifetime * 1.15;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.bubbles.emit(bubbles, _emit);
    }

    /* --- and the sparks that come up with it --- */
    const motes = Math.round(c.goutMotes * scale * g.particleCount);
    if (motes > 0) {
      _emit.position = _pos.set(centreX, 0.06, centreZ);
      _emit.radius = radius * 0.85;
      _emit.speed = c.moteSpeed * c.goutLift;
      _emit.spread = 0.45;
      _emit.size = 0.12;
      _emit.life = c.moteLifetime * 1.2;
      this.motes.emit(motes, _emit);
    }

    /* --- the ring across the pool --- */
    if (c.goutRing > 0.001) {
      this._centrePoint(_pos);
      this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
        radius: radius * 1.2,
        life: 0.6,
        width: 0.06,
        intensity: c.goutRing * scale,
        colorA: getColor(c.colorShockA),
        colorB: getColor(c.colorShockB)
      });
    }

    this.ctx.shake.add(c.goutShake * scale * g.explosionIntensity, 3.2, 24);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.2 * scale);
  }

  /**
   * Step the boil, and vent if this frame is the one that crossed.
   *
   * Advanced before anything reads it, so the frame a surge lands on is the
   * frame every material, the light and the emitters see it on.
   */
  _advanceBoil(dt, fade, collapse) {
    const c = settings.acid;

    this._boilPhase += dt * Math.max(0, c.boilRate);
    const shaped = Math.pow(boilEnvelope(this._boilPhase), Math.max(0.05, c.boilSharp));

    // Crossing on the way *up* only: a vent is the moment pressure gives, not
    // every frame it happens to be high.
    if (
      this._boilRaw < c.boilThreshold &&
      shaped >= c.boilThreshold &&
      collapse < 0.8 &&
      dt > 0
    ) {
      this._goutFx(fade);
    }

    this._boilRaw = shaped;
    // A pool going inert stops surging, but does not stop *being* modulated —
    // it just does it more and more weakly.
    this._boil = shaped * (1 - collapse * 0.7);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // The light rides the head of the corrosion, just off the floor.
    this._frontPoint(this.position);
    this.position.y += 0.3;

    this._creepFx(dt);
    this.ctx.shake.rumble(settings.acid.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.acid;
    const g = settings.global;
    const time = frame.uTime.value;

    this._bloomTime = 0;

    const centre = this._centrePoint(_centre);

    /* the shell of vapour the pool throws as it opens */
    // Thin, brief and heavily fresnelled: this is gas leaving the floor, and
    // anything solider parks a pale dome in the middle of the aura for half a
    // second — which is exactly what a fireball-style burst does here.
    this.ctx.bursts.spawn(BurstMode.WATER, centre, {
      radius: c.burstSize * 0.22,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.4,
      intensity: c.burstIntensity,
      opacity: 0.35,
      fresnel: 2.6,
      displace: 0.45,
      squash: 0.55, // flattened: pressure spreading over the floor
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor, past the boundary */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.75,
      width: 0.055,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* the burn the aura stands on, and leaves behind */
    this.ctx.decals.spawn(DecalType.SCORCH, centre, {
      radius: c.etchRadius,
      life: c.etchLife,
      intensity: c.etchIntensity,
      colorA: getColor(c.colorEtch),
      // Not the live acid: the decal runs its embers at 2.5x this colour for
      // their first breath, and a hot stop there throws a green bolt across the
      // pool the mark is supposed to be sitting under.
      colorB: getColor(c.colorStain),
      height: 0.013
    });

    /* everything the floor gives up as it dissolves */
    _emit.position = centre;
    _emit.radius = this.radius * 0.55;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 2.4;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.85;
    _emit.life = c.moteLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.motes.emit(Math.round(c.bloomMotes * g.particleCount), _emit);

    _emit.radius = this.radius * 0.7;
    _emit.speed = c.bubbleSpeed * 2.2;
    _emit.spread = 0.5;
    _emit.size = 0.18;
    _emit.life = c.bubbleLifetime * 1.2;
    this.bubbles.emit(Math.round(c.bloomBubbles * g.particleCount), _emit);

    _emit.radius = this.radius * 0.5;
    _emit.speed = c.splashSpeed * 1.8;
    _emit.spread = 0.85;
    _emit.size = 0.12;
    _emit.life = c.splashLifetime * 1.3;
    this.splash.emit(Math.round(c.bloomSplash * g.particleCount), _emit);

    _emit.radius = this.radius * 0.65;
    _emit.speed = c.fogSpeed * 3.0;
    _emit.spread = 1.0;
    _emit.size = 1.4;
    _emit.life = c.fogLifetime * 1.15;
    _emit.spin = 0.4;
    this.fog.emit(Math.round(52 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.bloomShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.bloomFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.3 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.acid;
    this._bloomTime += dt;

    // `t` runs 0..1 while the aura stands, then 1..2 while it goes inert.
    const collapse = t <= 1 ? 0 : saturate(t - 1);
    const fade = 1 - Easing.inQuad(collapse);

    this._advanceBoil(dt, fade, collapse);
    this._sync(fade, collapse);

    // The light sits inside the column, low — where the pool is.
    this._centrePoint(this.position);
    this.position.y = Math.max(0.25, this.mistHeight * saturate(c.lightHeight));

    this._auraFx(dt, fade * (t <= 1 ? 1 : 0.3));
    this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this.pool.visible = false;
    this.mist.visible = false;
    this.ring.visible = false;
    this.collar.visible = false;
    this.fume.visible = false;
    this.poolMaterial.uniforms.uFade.value = 0;
    this.mistMaterial.uniforms.uFade.value = 0;
    this.ringMaterial.uniforms.uFade.value = 0;
    this.collarMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    this.poolGeometry.dispose();
    this.mistGeometry.dispose();
    this.ringGeometry.dispose();
    this.collarGeometry.dispose();
    this.fumeGeometry.dispose();
    this.poolMaterial.dispose();
    this.mistMaterial.dispose();
    this.ringMaterial.dispose();
    this.collarMaterial.dispose();
    this.fumeMaterial.dispose();
    super.dispose();
  }
}
