import { Mesh, Group, Vector3, Color, CylinderGeometry, BufferAttribute, MathUtils } from 'three';
import { Ability } from './Ability.js';
import { RibbonGeometry, RibbonMode } from '../effects/RibbonGeometry.js';
import { WindRibbonMaterial, TornadoMaterial } from '../materials/WindMaterial.js';
import { DistortionMaterial } from '../materials/DistortionMaterial.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { DecalType } from '../effects/GroundDecals.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing, randRange } from '../utils/math.js';

const MAX_RIBBONS = 8;
const WINDOW_POINTS = 64;
const MAX_TORNADO_SHELLS = 4;

const smoothstep01 = (e0, e1, x) => {
  const k = saturate((x - e0) / (e1 - e0));
  return k * k * (3 - 2 * k);
};
/**
 * Sheets trail off into a fine whisker, open into a broad tress through the
 * body, then gather again towards the head. Both ends have to close: a sheet
 * this wide that stops at full width shows the bare quad as a straight bright
 * edge, which is the one thing that instantly breaks the illusion.
 */
const WIDTH_PROFILE = (t) =>
  0.05 + 0.95 * Math.pow(smoothstep01(0, 0.3, t), 0.7) * (1 - 0.8 * smoothstep01(0.55, 1, t));

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _side = new Vector3();
const _up = new Vector3(0, 1, 0);
const _normal = new Vector3();
const _tangent = new Vector3();
const _leafTint = new Color();
/**
 * Leaves keep an autumn palette of their own (already linear values). The
 * gradient is a lifetime ramp — freshly caught leaves are bright, older ones
 * darken as they tumble out of the vortex.
 */
const LEAF_GRADIENT = [
  new Color(0.72, 0.34, 0.09),
  new Color(0.6, 0.25, 0.07),
  new Color(0.44, 0.19, 0.06),
  new Color(0.26, 0.11, 0.04)
];
/**
 * Per-batch hue multipliers on top of that ramp. Emission batches are only a
 * few leaves wide, so picking one per batch mixes golds, oranges and reds in
 * the air at the same time instead of ramping them all in lockstep.
 */
const LEAF_TINTS = [
  new Color(1.35, 1.05, 0.55),
  new Color(1.15, 0.78, 0.4),
  new Color(1.0, 0.55, 0.3),
  new Color(0.85, 0.42, 0.3),
  new Color(0.95, 0.9, 0.6)
];

/** One autumn hue per emission batch, with a little brightness jitter. */
function randomLeafTint() {
  const base = LEAF_TINTS[(Math.random() * LEAF_TINTS.length) | 0];
  return _leafTint.copy(base).multiplyScalar(randRange(0.75, 1.25));
}

/**
 * WIND — the fastest element: a bundle of spiral ribbons braiding around the
 * path, with leaves and dust caught in the vortex, ending in a tornado burst.
 *
 * Each ribbon is the same path window displaced onto a helix with its own phase
 * offset, so the whole braid is built from one set of curve samples.
 */
export class WindAbility extends Ability {
  constructor(context) {
    super('wind', context);
  }

  createShaders() {
    this.material = new WindRibbonMaterial();

    this.ribbons = [];
    for (let i = 0; i < MAX_RIBBONS; i++) {
      const ribbon = new RibbonGeometry(WINDOW_POINTS - 1);
      const mesh = new Mesh(ribbon.geometry, this.material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 11;
      mesh.visible = false;
      this.group.add(mesh);

      const points = [];
      for (let p = 0; p < WINDOW_POINTS; p++) points.push(new Vector3());

      // One constant seed per ribbon: the shader uses it to decorrelate the
      // filament lanes so the braids do not all draw the same strand pattern.
      const seed = i * 0.6180339887 % 1;
      const seeds = new Float32Array(WINDOW_POINTS * 2).fill(seed);
      ribbon.geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));

      this.ribbons.push({
        ribbon,
        mesh,
        points,
        seed,
        // Set in `_activeRibbons` — the spread has to cover only the sheets
        // actually in use, or a low sheet count leaves them stacked in a
        // quadrant instead of spaced around the bundle.
        phase: 0,
        // Ribbons ride the braid at different radii and wind at slightly
        // different rates, which is what makes the bundle look woven.
        radiusScale: 0.5 + 0.55 * ((i * 0.37) % 1),
        twistScale: 0.8 + 0.45 * ((i * 0.71) % 1)
      });
    }

    // One distortion proxy, reusing the first ribbon's geometry. It is a long
    // camera-facing strip, so it needs the stream mask — the default radial one
    // carves a hard-edged lens out of the middle of the ribbon.
    this.distortionMaterial = new DistortionMaterial({ frequency: 3.0, speed: 2.2, stream: true });
    this.distortionMesh = new Mesh(this.ribbons[0].ribbon.geometry, this.distortionMaterial);
    this.distortionMesh.layers.set(LAYER.DISTORTION);
    this.distortionMesh.frustumCulled = false;
    this.distortionMesh.matrixAutoUpdate = false;
    this.group.add(this.distortionMesh);

    /* ---- tornado ---- */
    // A plain unit tube. The funnel's profile — neck, flare, ground fan, lean
    // and the bulges riding up it — is all built in the vertex shader, so the
    // geometry only has to supply a grid dense enough to carry it without
    // faceting the silhouette.
    this.tornadoGeometry = new CylinderGeometry(1, 1, 1, 72, 56, true);
    this.tornadoGeometry.translate(0, 0.5, 0); // base at the origin

    // Nested shells sharing one axis. One shell can only ever be a texture on a
    // surface; several at different radii and spin rates parallax against each
    // other as the camera moves, which is what gives the column volume.
    this.tornado = new Group();
    this.tornado.layers.set(LAYER.VFX);
    this.tornado.visible = false;
    this.group.add(this.tornado);

    this.tornadoShells = [];
    for (let i = 0; i < MAX_TORNADO_SHELLS; i++) {
      const material = new TornadoMaterial(i);
      const mesh = new Mesh(this.tornadoGeometry, material);
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 13;
      mesh.frustumCulled = false;
      this.tornado.add(mesh);
      this.tornadoShells.push({ mesh, material });
    }

    this._tornadoAge = -1;
  }

  createParticles() {
    const particles = this.ctx.particles;

    this.leaves = particles.get('wind.leaves', {
      capacity: 1200,
      shape: ParticleShape.LEAF,
      additive: false,
      swirl: true, // orbit a travelling anchor — the vortex core
      lit: true,
      softFade: 0.3
    });
    this.leaves.uniforms.uGravity.value.set(0, -1.6, 0);
    this.leaves.uniforms.uDrag.value = 0.6;
    this.leaves.uniforms.uEndSize.value = 1.0;
    this.leaves.uniforms.uFadeOut.value = 0.7;
    this.leaves.uniforms.uSwirlExpand.value = 0.9;

    this.dust = particles.get('wind.dust', {
      capacity: 2600,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      softFade: 0.5
    });
    this.dust.uniforms.uGravity.value.set(0, -0.4, 0);
    this.dust.uniforms.uDrag.value = 0.9;
    this.dust.uniforms.uEndSize.value = 0.5;
    this.dust.uniforms.uSwirlExpand.value = 1.4;

    this.leafEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
  }

  get trailLength() {
    return settings.wind.ribbonLength;
  }

  get impactDuration() {
    return Math.max(0.7, settings.wind.tornadoDuration);
  }

  get fadeDuration() {
    return 1.4;
  }

  /** Air surges — fast, with gusty variation. */
  speedProfile(u) {
    return 1.0 + 0.25 * Math.sin(u * 14.0);
  }

  onSpawn() {
    this.leafEmitter.reset();
    this.dustEmitter.reset();
    this._tornadoAge = -1;
    this.tornado.visible = false;
    for (const entry of this.ribbons) {
      entry.mesh.visible = false;
      entry.ribbon.clear();
    }
  }

  _syncUniforms() {
    const c = settings.wind;
    const g = settings.global;

    this.material.sync();

    const shells = MathUtils.clamp(Math.round(c.tornadoShells), 1, MAX_TORNADO_SHELLS);
    for (let i = 0; i < MAX_TORNADO_SHELLS; i++) {
      const shell = this.tornadoShells[i];
      shell.mesh.visible = i < shells;
      if (i < shells) shell.material.sync(shells);
    }

    const d = this.distortionMaterial.uniforms;
    d.uStrength.value = c.distortion * g.distortion * 0.7;
    d.uFrequency.value = 1.6 + c.noiseFrequency * 0.6;
    d.uSpeed.value = c.swirlSpeed * 1.2;

    const inner = getColor(c.colorInner);
    const outer = getColor(c.colorOuter);

    this.dust.setGradient(inner, outer, outer, inner);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize * 3.5;
    this.dust.uniforms.uLifeScale.value = g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustAmount * 0.35 * g.opacity;
    this.dust.uniforms.uGlow.value = c.glow * 0.8;
    this.dust.uniforms.uSwirl.value = c.rotationSpeed * c.vortexStrength;

    this.leaves.setGradient(...LEAF_GRADIENT);
    this.leaves.uniforms.uSizeScale.value = c.leafSize * g.particleSize * 7;
    this.leaves.uniforms.uLifeScale.value = g.particleLifetime;
    this.leaves.uniforms.uSpeedScale.value = g.particleSpeed;
    this.leaves.uniforms.uOpacity.value = g.opacity;
    this.leaves.uniforms.uSwirl.value = c.rotationSpeed * c.vortexStrength;
  }

  /**
   * Displace the path window onto one sheet's centre line.
   *
   * The bundle is carried by the sheets' *width*, not by winding them tightly
   * around the path — a fast helix reads as a spring, and once each strip is a
   * comb of hairlines a tight coil just shreds them. So the centre lines only
   * drift apart lazily (a little under one turn over the whole ribbon) and get
   * a long, slow off-axis wander on top, which is what makes the tress look
   * like it is folding through the air rather than orbiting a pole.
   */
  _buildRibbonPoints(entry, count) {
    const c = settings.wind;
    const time = frame.uTime.value;
    const turb = c.turbulence * c.spiralRadius * 0.9;

    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const point = this.trailPoints[i];

      const next = this.trailPoints[Math.min(count - 1, i + 1)];
      const prev = this.trailPoints[Math.max(0, i - 1)];
      _tangent.copy(next).sub(prev);
      if (_tangent.lengthSq() < 1e-8) _tangent.set(0, 0, 1);
      _tangent.normalize();
      _side.crossVectors(_tangent, _up).normalize();
      _normal.crossVectors(_tangent, _side).normalize();

      // Lazy helix: phase advances along the ribbon and drifts over time.
      const phase =
        entry.phase + t * c.vortexStrength * 1.5 * entry.twistScale + time * c.rotationSpeed * 0.22;

      // Flare wave: the bundle pinches and blooms as it travels down the path.
      const flare = 0.7 + 0.5 * Math.sin(t * 2.4 - time * 1.1 + entry.phase);
      const radius = c.spiralRadius * entry.radiusScale * flare * (0.3 + 0.7 * Math.pow(t, 0.6));

      // Low-frequency wander. Long wavelengths only: anything short enough to
      // bend a sheet within its own width kinks the hairlines it carries.
      const seed = entry.seed * 31.0;
      const wobbleS =
        Math.sin(t * 2.7 + time * 0.8 + seed) * 0.7 + Math.sin(t * 5.9 - time * 1.3 + seed * 2.3) * 0.28;
      const wobbleN =
        Math.cos(t * 2.2 - time * 0.9 + seed * 1.7) * 0.7 + Math.cos(t * 5.1 + time * 1.1 + seed) * 0.28;

      entry.points[i]
        .copy(point)
        .setY(point.y + 0.9 + Math.sin(phase * 0.5) * 0.12 + wobbleN * turb * 0.35)
        .addScaledVector(_side, Math.cos(phase) * radius + wobbleS * turb)
        .addScaledVector(_normal, Math.sin(phase) * radius + wobbleN * turb);
    }
  }

  /** Sheets in use this frame, with their helix phases spread across the bundle. */
  _activeRibbons() {
    const count = MathUtils.clamp(Math.round(settings.wind.ribbonCount), 1, MAX_RIBBONS);
    for (let i = 0; i < MAX_RIBBONS; i++) {
      this.ribbons[i].phase = (i / count) * Math.PI * 2;
    }
    return count;
  }

  /**
   * Rebuild one sheet's geometry from its centre line.
   *
   * The sheet is camera-facing, then rolled around its own tangent as it
   * advances. Foreshortening does the rest: where the roll turns the strip
   * edge-on the tress pinches to a bright seam and opens out again past it,
   * which is what reads as a ribbon of hair folding over itself. Keep the roll
   * under a half turn — a full one puts a zero-width seam in view.
   */
  _buildSheet(entry, count, widthScale) {
    const c = settings.wind;
    this._buildRibbonPoints(entry, count);
    entry.ribbon.build(entry.points, {
      count,
      width: c.ribbonWidth * entry.twistScale * widthScale,
      mode: RibbonMode.BILLBOARD,
      cameraPosition: this.ctx.camera.position,
      widthProfile: WIDTH_PROFILE,
      twist: c.sheetTwist * entry.twistScale,
      twistPhase: entry.phase
    });
  }

  onTravel(dt) {
    this._syncUniforms();

    const count = Math.min(this.trailCount, WINDOW_POINTS);
    const ribbonCount = this._activeRibbons();

    for (let i = 0; i < MAX_RIBBONS; i++) {
      const entry = this.ribbons[i];
      const active = i < ribbonCount && count >= 2;
      entry.mesh.visible = active;
      if (!active) continue;

      this._buildSheet(entry, count, 1);
    }

    this.distortionMesh.visible = count >= 2;
    this._emitDebris(dt);
  }

  _emitDebris(dt) {
    const c = settings.wind;
    const g = settings.global;
    const time = frame.uTime.value;

    const head = _pos.copy(this.position).setY(this.position.y + 0.9);
    _dir.copy(this.tangent);

    /* Leaves are emitted on a ring around the head and given the head's
       velocity as their swirl anchor drift, so they orbit the moving vortex. */
    const leafCount = Math.round(this.leafEmitter.tick(dt, c.leafCount) * g.particleCount);
    if (leafCount > 0) {
      _emit.position = head;
      _emit.radius = c.spiralRadius * 1.3;
      _emit.direction = _dir;
      _emit.speed = this.velocity.length() * 0.55;
      _emit.speedVariance = 0.3;
      _emit.spread = 0.25;
      _emit.inherit = null;
      _emit.anchor = head; // swirl centre
      _emit.size = 0.16;
      _emit.sizeVariance = 0.5;
      _emit.life = c.leafLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = c.leafSpin;
      _emit.tint = randomLeafTint();
      _emit.time = time;
      this.leaves.emit(leafCount, _emit);
    }

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * c.dustAmount) * g.particleCount);
    if (dustCount > 0) {
      _emit.position = head;
      _emit.radius = c.spiralRadius * 1.1;
      _emit.direction = _dir;
      _emit.speed = this.velocity.length() * 0.4;
      _emit.speedVariance = 0.4;
      _emit.spread = 0.35;
      _emit.anchor = head;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.6;
      _emit.life = 0.9;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null; // dust stays colourless — the leaf tint must not leak in
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = settings.wind;
    const g = settings.global;
    const time = frame.uTime.value;

    const inner = getColor(c.colorInner);
    const outer = getColor(c.colorOuter);

    /* tornado */
    this._tornadoAge = 0;
    this.tornado.visible = true;
    this.tornado.position.copy(this.position);
    this.tornado.rotation.y = Math.random() * Math.PI * 2;
    // Height is full from the first frame: the shader drops the funnel down out
    // of the air, so scaling it up vertically as well would double the motion.
    this.tornado.scale.set(c.tornadoRadius * 0.55, c.tornadoHeight, c.tornadoRadius * 0.55);
    for (const shell of this.tornadoShells) shell.material.uniforms.uAge.value = 0;

    /* pressure burst */
    _pos.copy(this.position).setY(this.position.y + 1.0);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: 0.4,
      endRadius: c.tornadoRadius * 2.4 * c.burstIntensity * g.explosionIntensity,
      life: 0.7,
      intensity: c.burstIntensity * g.glow,
      fresnel: c.fresnel * g.fresnel,
      displace: 0.25,
      colorA: outer,
      colorB: inner,
      colorC: inner
    });

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.position, {
      radius: c.tornadoRadius * 2.6 * g.explosionIntensity,
      life: 0.7,
      width: 0.06,
      intensity: 1.0,
      colorA: outer,
      colorB: inner
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, this.position, {
      radius: c.tornadoRadius * 2.0,
      life: 1.4,
      // DUSTRING is a filled disc, so at any real strength it paints a flat
      // milky saucer around the contact. It is only wanted here as a faint
      // ground haze — the particle skirt is what carries the debris cloud.
      intensity: Math.min(1, c.dustAmount) * 0.3,
      colorA: inner,
      colorB: outer
    });

    /* everything gets thrown outward and up */
    _emit.position = _pos;
    _emit.radius = c.tornadoRadius * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 7.5 * c.burstIntensity;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = _pos;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.6;
    _emit.life = c.leafLifetime * 1.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = c.leafSpin * 1.5;
    _emit.tint = randomLeafTint();
    _emit.time = time;
    this.leaves.emit(Math.round(140 * g.particleCount), _emit);

    _emit.size = 0.14;
    _emit.speed = 9.0;
    _emit.life = 1.2;
    _emit.spin = 0;
    _emit.tint = null;
    this.dust.emit(Math.round(220 * g.particleCount), _emit);

    this.ctx.shake.add(0.3 * c.explosionShake * g.explosionIntensity, 2.0, 24);
    this.ctx.flash.trigger(inner, c.explosionFlash * g.explosionIntensity * 0.3);
    this.lightBoost = c.lightIntensity * 1.6 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.wind;
    this._syncUniforms();
    const fade = saturate(t);

    /* retract the braid into the vortex */
    const remaining = c.ribbonLength * (1 - saturate(t * 0.8));
    const count = Math.min(this.trailCount, WINDOW_POINTS);
    if (remaining > 0.1 && this.curve) {
      this._updateTrailWindow(remaining);
      const ribbonCount = this._activeRibbons();
      for (let i = 0; i < MAX_RIBBONS; i++) {
        const entry = this.ribbons[i];
        const active = i < ribbonCount && count >= 2;
        entry.mesh.visible = active;
        if (!active) continue;
        this._buildSheet(entry, count, 1 - fade * 0.6);
      }
    } else {
      for (const entry of this.ribbons) entry.mesh.visible = false;
      this.distortionMesh.visible = false;
    }

    this.material.uniforms.uOpacity.value *= 1 - fade * 0.9;

    /* tornado growth, spin-up and dissipation */
    if (this._tornadoAge >= 0) {
      this._tornadoAge += dt;
      const life = Math.max(0.2, c.tornadoDuration);
      const p = saturate(this._tornadoAge / life);

      for (const shell of this.tornadoShells) shell.material.uniforms.uAge.value = p;

      // Only the radius spins up — the descent down the column is the shader's.
      const grow = 0.55 + 0.45 * Easing.outCubic(saturate(this._tornadoAge / 0.4));
      this.tornado.scale.set(c.tornadoRadius * grow, c.tornadoHeight, c.tornadoRadius * grow);
      this.tornado.rotation.y += dt * c.rotationSpeed * 0.6;
      this.tornado.visible = p < 1;

      // Debris cloud at the ground contact. The funnel's shader flares into a
      // fan down there, and a clean edge where that fan meets the floor is the
      // one place the illusion falls apart — so bury the seam in dust that
      // boils outward faster than it rises.
      if (p < 0.9) {
        const skirt = Math.round(
          this.dustEmitter.tick(dt, c.dustRate * c.dustAmount * 0.8) * settings.global.particleCount
        );
        for (let i = 0; i < skirt; i++) {
          const angle = Math.random() * Math.PI * 2;
          const ring = c.tornadoRadius * grow * randRange(0.45, 1.0);
          _pos.set(
            this.position.x + Math.cos(angle) * ring,
            this.position.y + randRange(0.02, 0.5),
            this.position.z + Math.sin(angle) * ring
          );
          _emit.position = _pos;
          _emit.radius = 0.25;
          // Mostly outward, barely rising: a ground fan, not a plume.
          _emit.direction = _dir.set(Math.cos(angle) * 1.2, 0.28, Math.sin(angle) * 1.2).normalize();
          _emit.speed = randRange(1.6, 3.4);
          _emit.speedVariance = 0.5;
          _emit.spread = 0.5;
          _emit.anchor = this.position;
          _emit.size = randRange(0.14, 0.26);
          _emit.sizeVariance = 0.5;
          _emit.life = 1.1;
          _emit.lifeVariance = 0.5;
          _emit.spin = 0;
          _emit.tint = null;
          _emit.inherit = null;
          _emit.time = frame.uTime.value;
          this.dust.emit(1, _emit);
        }
      }

      // The tornado keeps flinging debris while it lives.
      if (p < 0.85 && Math.random() < 0.6) {
        const angle = Math.random() * Math.PI * 2;
        _pos.set(
          this.position.x + Math.cos(angle) * c.tornadoRadius * 0.9,
          randRange(0.1, c.tornadoHeight * 0.4),
          this.position.z + Math.sin(angle) * c.tornadoRadius * 0.9
        );
        _emit.position = _pos;
        _emit.radius = 0.3;
        _emit.direction = _dir.set(-Math.sin(angle), 0.9, Math.cos(angle));
        _emit.speed = 4.5;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.3;
        _emit.anchor = this.position;
        _emit.size = 0.15;
        _emit.sizeVariance = 0.5;
        _emit.life = 1.1;
        _emit.lifeVariance = 0.4;
        _emit.spin = c.leafSpin;
        _emit.tint = randomLeafTint();
        _emit.inherit = null;
        _emit.time = frame.uTime.value;
        this.leaves.emit(3, _emit);
        _emit.tint = null;
        this.dust.emit(5, _emit);
      }
    }
  }

  onDestroy() {
    this.tornado.visible = false;
    this.distortionMesh.visible = false;
    for (const entry of this.ribbons) {
      entry.mesh.visible = false;
      entry.ribbon.clear();
    }
  }

  dispose() {
    for (const entry of this.ribbons) entry.ribbon.dispose();
    this.material.dispose();
    for (const shell of this.tornadoShells) shell.material.dispose();
    this.tornadoGeometry.dispose();
    this.distortionMaterial.dispose();
    super.dispose();
  }
}
