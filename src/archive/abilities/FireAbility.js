import { Mesh, Vector3, Color } from 'three';
import { Ability } from './Ability.js';
import { RibbonGeometry, RibbonMode } from '../effects/RibbonGeometry.js';
import { VolumetricFireMaterial, fireHullReach } from '../materials/VolumetricFireMaterial.js';
import { DistortionMaterial } from '../materials/DistortionMaterial.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { DecalType } from '../effects/GroundDecals.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, smoothstep, randRange } from '../utils/math.js';

const _emit = {}; // scratch emission descriptor — reused, never allocated
const _pos = new Vector3();
const _dir = new Vector3();
const _inherit = new Vector3();
const _gradA = new Color();
const _gradB = new Color();
const _gradC = new Color();
const _gradD = new Color();

/**
 * Radius profile along the stream, 0 = tail, 1 = head, in units of `flameWidth`.
 * Must stay in step with `flameProfile()` in VolumetricFireMaterial — the JS
 * side sizes the proxy hull, the shader side shapes the actual volume, and the
 * hull has to contain it.
 */
function radiusProfile(u, headSize, wakeSpread) {
  const body = (0.34 + 0.66 * Math.pow(u, 0.55)) * (1 + wakeSpread * Math.pow(1 - u, 1.8));
  return body * (1 + (headSize - 1) * smoothstep(0.62, 1, u));
}

/**
 * FIRE — a volumetric fireball that flies through the air along the drawn path,
 * trailing burning gas behind it, and detonates at the end.
 *
 * Construction:
 *  - the path is lifted off the ground by `pathHeight`, so the head, the trail,
 *    the light and every particle emission point fly together
 *  - a camera-facing proxy hull along the flight path, inside which
 *    VolumetricFireMaterial raymarches the actual flame (emission + soot
 *    absorption, clipped by the scene depth)
 *  - the same hull rendered into the distortion buffer for heat haze
 *  - embers rising, sparks falling out of the underside, smoke left behind
 *  - an airborne detonation, pressure shell, scorch mark below, shake and flash
 */
export class FireAbility extends Ability {
  constructor(context) {
    super('fire', context);
  }

  /* ------------------------------------------------------------------ */

  createShaders() {
    // Two extra points beyond the trail window pad the hull so the volume's end
    // caps are covered by geometry.
    this.ribbon = new RibbonGeometry(72, { frame: true });
    this.hullPoints = [];
    for (let i = 0; i < 70; i++) this.hullPoints.push(new Vector3());

    this.fireMaterial = new VolumetricFireMaterial();
    this.fireMesh = new Mesh(this.ribbon.geometry, this.fireMaterial);
    this.fireMesh.layers.set(LAYER.VFX);
    // Before the additive particle systems (12) so embers in front of the flame
    // are not dimmed by its absorption, after the non-additive smoke (10).
    this.fireMesh.renderOrder = 11;

    this.distortionMaterial = new DistortionMaterial({ stream: true, frequency: 2.1, speed: 1.5 });
    this.distortionMesh = new Mesh(this.ribbon.geometry, this.distortionMaterial);
    this.distortionMesh.layers.set(LAYER.DISTORTION);

    for (const mesh of [this.fireMesh, this.distortionMesh]) {
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
  }

  createParticles() {
    const particles = this.ctx.particles;

    this.embers = particles.get('fire.embers', {
      capacity: 4000,
      shape: ParticleShape.SOFT,
      additive: true,
      softFade: 0.4
    });
    this.embers.uniforms.uGravity.value.set(0, 1.4, 0); // embers are buoyant
    this.embers.uniforms.uDrag.value = 1.1;
    this.embers.uniforms.uEndSize.value = 0.05;
    this.embers.uniforms.uFadeOut.value = 0.25;

    this.sparks = particles.get('fire.sparks', {
      capacity: 2000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.sparks.uniforms.uGravity.value.set(0, -9.5, 0);
    this.sparks.uniforms.uDrag.value = 0.55;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uStretch.value = 0.12;

    this.smoke = particles.get('fire.smoke', {
      capacity: 1400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.smoke.uniforms.uGravity.value.set(0, 0.75, 0);
    this.smoke.uniforms.uDrag.value = 1.6;
    this.smoke.uniforms.uEndSize.value = 3.4;
    this.smoke.uniforms.uFadeIn.value = 0.18;
    this.smoke.uniforms.uFadeOut.value = 0.35;

    this.emberEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */

  get trailLength() {
    return settings.fire.streamLength;
  }

  get impactDuration() {
    return 0.85;
  }

  get fadeDuration() {
    return 1.0;
  }

  /**
   * Fire flies: it leaves the ground quickly, cruises at `flightHeight` and lobs
   * gently over the middle of the path.
   */
  pathHeight(u) {
    const c = settings.fire;
    return c.flightHeight * (0.45 + 0.55 * smoothstep(0, 0.22, u)) + c.flightArc * Math.sin(Math.PI * u);
  }

  onSpawn() {
    this.emberEmitter.reset();
    this.smokeEmitter.reset();
    this.sparkEmitter.reset();
    this.fireMaterial.uniforms.uHeadFade.value = 0;
    this.fireMaterial.uniforms.uSeed.value = Math.random() * 20;
    this.ribbon.clear();
  }

  /** Keep every shader/particle uniform in step with the editor. */
  _syncUniforms() {
    const c = settings.fire;
    const g = settings.global;

    this.fireMaterial.sync();

    const distortion = this.distortionMaterial.uniforms;
    distortion.uStrength.value = c.heatDistortion * g.distortion;
    distortion.uFrequency.value = 0.9 + c.noiseFrequency * 0.5;
    distortion.uSpeed.value = c.flameSpeed * 0.8;

    // Particle systems inherit the fire palette and the global multipliers.
    const core = getColor(c.colorCore);
    const mid = getColor(c.colorMid);
    const edge = getColor(c.colorEdge);
    const smoke = getColor(c.colorSmoke);

    this.embers.setGradient(core, mid, edge, smoke);
    this.embers.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 8;
    this.embers.uniforms.uLifeScale.value = g.particleLifetime;
    this.embers.uniforms.uSpeedScale.value = g.particleSpeed;
    this.embers.uniforms.uTurbulence.value = 0.55 * g.turbulence;
    this.embers.uniforms.uGlow.value = c.glow * 0.55;

    this.sparks.setGradient(core, core, mid, edge);
    this.sparks.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 5;
    this.sparks.uniforms.uLifeScale.value = g.particleLifetime;
    this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.sparks.uniforms.uGlow.value = c.glow * 0.9;

    // Smoke starts as cooling embers, is lit from below by the fire that made
    // it, and only then settles into soot. The bright middle stop is the whole
    // point: against this stage's near-black backdrop, smoke rendered in its own
    // soot colour is invisible, and the plume that should be the biggest shape
    // on screen simply never appears.
    this.smoke.setGradient(
      _gradA.copy(edge).multiplyScalar(0.14),
      _gradB.copy(smoke).multiplyScalar(5.5),
      _gradC.copy(smoke).multiplyScalar(3.0),
      _gradD.copy(smoke).multiplyScalar(1.2)
    );
    this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize;
    this.smoke.uniforms.uLifeScale.value = g.particleLifetime;
    this.smoke.uniforms.uOpacity.value = c.smokeDensity * g.opacity;
    this.smoke.uniforms.uGlow.value = 1;
    this.smoke.uniforms.uTurbulence.value = 0.5 * g.turbulence;
  }

  onTravel(dt) {
    this._syncUniforms();
    this._buildHull();
    this._emitStream(dt);
  }

  /**
   * Rebuild the camera-facing proxy hull the raymarcher renders inside.
   *
   * The hull only has to *contain* the volume: it is a billboard strip whose
   * half-width follows the same radius profile as the density field, widened by
   * the volume's upward stretch, and padded by a cap radius at both ends.
   *
   * @param {number} [widthScale] shrinks the volume while the stream dies
   */
  _buildHull(widthScale = 1) {
    const c = settings.fire;
    const count = this.trailCount;
    const points = this.trailPoints;
    if (count < 2) {
      this.ribbon.clear();
      return;
    }

    let length = 0;
    for (let i = 1; i < count; i++) length += points[i].distanceTo(points[i - 1]);
    if (length < 1e-3) {
      this.ribbon.clear();
      return;
    }

    const radius = c.flameWidth * widthScale;
    const headSize = c.headSize;
    const wakeSpread = c.wakeSpread;
    const headRadius = radius * headSize;
    // How far outside the nominal tube the shred *and* the silhouette bulge can
    // push density. Read live: both are editable while a cast is in flight.
    const reach = fireHullReach();
    const tailPad = radius * radiusProfile(0, 1, wakeSpread) * reach;
    const headPad = headRadius * reach;

    const hull = this.hullPoints;
    _dir.copy(points[0]).sub(points[1]);
    if (_dir.lengthSq() < 1e-8) _dir.copy(this.tangent).negate();
    hull[0].copy(points[0]).addScaledVector(_dir.normalize(), tailPad);

    // The wake is hot gas: the further behind the head it is, the longer it has
    // had to climb. Lifting the hull's centre line is enough — the raymarcher
    // reads its axis straight off this geometry.
    for (let i = 0; i < count; i++) {
      const age = 1 - i / (count - 1);
      hull[i + 1].copy(points[i]);
      hull[i + 1].y += c.wakeRise * Math.pow(age, 1.5);
    }
    hull[0].y += c.wakeRise;

    _dir.copy(points[count - 1]).sub(points[count - 2]);
    if (_dir.lengthSq() < 1e-8) _dir.copy(this.tangent);
    hull[count + 1].copy(points[count - 1]).addScaledVector(_dir.normalize(), headPad);

    const arcLength = tailPad + length + headPad;

    const u = this.fireMaterial.uniforms;
    u.uRadius.value = radius; // overrides sync() so the fade can shrink the volume
    u.uStreamLength.value = length;
    u.uArcLength.value = arcLength;
    u.uTailPad.value = tailPad;

    // The density field is stretched upward *and* pushed outward by the noise,
    // so the hull has to be considerably wider than the tube is round — a hull
    // that is even slightly too narrow shows up as a dead straight edge cutting
    // across the top of the flame.
    const cover = 1.08 * reach * Math.max(1, c.flameHeight);

    this.ribbon.build(hull, {
      count: count + 2,
      width: 2 * headRadius * cover,
      mode: RibbonMode.BILLBOARD,
      cameraPosition: this.ctx.camera.position,
      widthProfile: (t) =>
        radiusProfile(saturate((t * arcLength - tailPad) / length), headSize, wakeSpread) / headSize
    });
  }

  _emitStream(dt) {
    const c = settings.fire;
    const g = settings.global;
    const time = frame.uTime.value;
    const countScale = g.particleCount;
    const radius = c.flameWidth;

    _inherit.copy(this.velocity).multiplyScalar(0.22);

    /* ---- embers: off the fireball and out of the burning tail ---- */
    const emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate * c.emberCount) * countScale);
    if (emberCount > 0) {
      _emit.position = _pos.copy(this.position);
      _emit.radius = radius * c.headSize * 0.6;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.9;
      _emit.inherit = _inherit;
      _emit.anchor = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.55;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(Math.ceil(emberCount * 0.6), _emit);

      // A second, weaker emission from a random point on the tail keeps the
      // whole stream alive instead of only its head.
      if (this.trailCount > 4) {
        const index = Math.floor(randRange(0, this.trailCount - 1));
        _emit.position = _pos.copy(this.trailPoints[index]);
        _emit.radius = radius * 0.7;
        _emit.speed = c.emberSpeed * 0.55;
        _emit.inherit = null;
        this.embers.emit(Math.floor(emberCount * 0.4), _emit);
      }
    }

    /* ---- sparks: thrown forward and then dropping out of the air ---- */
    const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate) * countScale);
    if (sparkCount > 0) {
      _emit.position = _pos.copy(this.position);
      _emit.radius = radius * 0.45;
      _emit.direction = _dir.copy(this.tangent).multiplyScalar(0.6).setY(0.35);
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.9;
      _emit.inherit = _inherit;
      _emit.size = 0.16;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.75;
      _emit.lifeVariance = 0.5;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }

    /* ---- smoke: shed behind the fireball, then left to rise ---- */
    const smokeCount = Math.round(this.smokeEmitter.tick(dt, 55 * c.smokeDensity) * countScale);
    if (smokeCount > 0) {
      _emit.position = _pos
        .copy(this.position)
        .addScaledVector(this.tangent, -radius * c.headSize * 1.1);
      _pos.y += radius * 0.5;
      _emit.radius = radius * 0.8;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.65;
      _emit.inherit = _inherit;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.4;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.35;
      _emit.spin = 1.2;
      _emit.tint = null;
      _emit.time = time;
      this.smoke.emit(Math.ceil(smokeCount * 0.55), _emit);

      // The burning tail smokes too, and it is the part that has had time to
      // climb — this is what builds the plume trailing above the flight path
      // instead of a thin ribbon of puffs stuck to the head.
      if (this.trailCount > 4) {
        const index = Math.floor(randRange(0, this.trailCount - 1));
        _emit.position = _pos.copy(this.trailPoints[index]);
        _pos.y += radius * 0.8;
        _emit.radius = radius * 1.3;
        _emit.speed = c.smokeSpeed * 0.7;
        _emit.spread = 0.9;
        _emit.inherit = null;
        _emit.size = 1.15;
        this.smoke.emit(Math.floor(smokeCount * 0.45), _emit);
      }
    }
  }

  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = settings.fire;
    const g = settings.global;
    const time = frame.uTime.value;
    const scale = c.explosionSize * g.explosionIntensity;

    const core = getColor(c.colorCore);
    const mid = getColor(c.colorMid);
    const edge = getColor(c.colorEdge);

    // The detonation happens where the fireball actually is: in the air.
    _pos.copy(this.position);
    // How much of it reaches the floor at all.
    const groundFactor = saturate(1 - Math.max(0, this.position.y) / (scale * 1.2 + 1.5));

    /* fireball */
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: scale * 0.25,
      endRadius: scale,
      life: 0.85,
      intensity: c.explosionBrightness * g.glow,
      displace: 0.5,
      turbulence: c.flameTurbulence * 0.5,
      colorA: core,
      colorB: mid,
      colorC: edge
    });
    // A faster inner flash sells the detonation.
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: scale * 0.1,
      endRadius: scale * 0.55,
      life: 0.35,
      intensity: c.explosionBrightness * 2.2 * g.glow,
      displace: 0.2,
      colorA: core,
      colorB: core,
      colorC: mid
    });
    // An airborne blast needs a pressure shell instead of a ground shockwave.
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: scale * 0.3,
      endRadius: scale * 2.1,
      life: 0.45,
      intensity: 1.6 * g.glow,
      fresnel: 1.6,
      opacity: 0.7,
      displace: 0.12,
      colorA: core,
      colorB: mid,
      colorC: mid
    });

    /* ground marks — only if the blast went off low enough to reach the floor */
    if (groundFactor > 0.04) {
      this.ctx.decals.spawn(DecalType.SCORCH, this.position, {
        radius: scale * 0.85,
        life: 7,
        intensity: 0.9 * groundFactor,
        colorA: getColor(c.colorSmoke),
        colorB: mid
      });
      this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.position, {
        radius: scale * 1.6,
        life: 0.65,
        width: 0.09,
        intensity: 1.4 * groundFactor,
        colorA: mid,
        colorB: core
      });
    }

    /* debris */
    const countScale = g.particleCount;
    _emit.position = _pos;
    _emit.radius = scale * 0.25;
    _emit.direction = _dir.set(0, 0.35, 0);
    _emit.speed = 7 * scale * 0.4;
    _emit.speedVariance = 0.75;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.6;
    _emit.life = 1.5;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(Math.round(220 * countScale), _emit);

    // Sparks rain out of an airborne blast in every direction.
    _emit.direction = _dir.set(0, 0, 0);
    _emit.speed = 14 * scale * 0.4;
    _emit.size = 0.22;
    _emit.life = 1.2;
    _emit.spread = 1.0;
    this.sparks.emit(Math.round(160 * countScale), _emit);

    _emit.position = _pos;
    _emit.direction = _dir.set(0, 0.5, 0);
    _emit.speed = 3.2;
    _emit.spread = 0.9;
    _emit.size = 1.5;
    _emit.life = c.smokeLifetime * 1.6;
    _emit.spin = 1.0;
    this.smoke.emit(Math.round(70 * countScale), _emit);

    /* camera + screen */
    this.ctx.shake.add(0.42 * c.explosionShake * g.explosionIntensity, 1.9, 26);
    this.ctx.flash.trigger(mid, c.explosionFlash * g.explosionIntensity * 0.5);
    this.lightBoost = c.lightIntensity * 2.4 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.fire;
    this._syncUniforms(); // editor tweaks keep applying while the stream dies

    const fade = saturate(t);

    // Retract the burning tail toward the impact point, and let what is left of
    // the volume thin out and go cold rather than simply turning invisible.
    const remaining = c.streamLength * (1 - saturate(t * 0.85));
    if (remaining > 0.05 && this.curve) {
      this._updateTrailWindow(remaining);
      this._buildHull(1 - fade * 0.65);
    } else {
      this.ribbon.clear();
    }

    const u = this.fireMaterial.uniforms;
    u.uOpacity.value = lerp(c.opacity * settings.global.opacity, 0, fade);
    u.uHeadFade.value = fade * 0.35;
    u.uDetachment.value = lerp(c.detachment, 1.1, fade); // it breaks up as it dies
    this.distortionMaterial.uniforms.uStrength.value =
      c.heatDistortion * settings.global.distortion * (1 - fade);
  }

  onDestroy() {
    this.ribbon.clear();
  }

  dispose() {
    this.ribbon.dispose();
    this.fireMaterial.dispose();
    this.distortionMaterial.dispose();
    super.dispose();
  }
}
