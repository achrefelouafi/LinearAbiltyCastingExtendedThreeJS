import {
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  AdditiveBlending,
  Color,
  DoubleSide,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing } from '../utils/math.js';

const ZONE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The footprint: one signed-distance ring evaluated in **metres**.
 *
 * `vUv` is remapped so `p` is the offset from the target point in world metres,
 * with `p.y` running along the aim heading — the quad carries the caster's yaw,
 * so the long reticle arm points downrange. Every control in `settings.zone` is
 * therefore a real measurement: the boundary stays 0.34 m thick whether the
 * footprint is 2 m or 8 m across, which is the entire point of drawing it.
 *
 * The band is split about the nominal radius by `uBias` rather than centred on
 * it, because the number the player is judging is *where the edge of the effect
 * is* — growing the band inward keeps its outer lip honest.
 */
const ZONE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;     // metres the quad covers, edge to edge
  uniform float uRadius;       // footprint radius, metres (already snapped)
  uniform float uBoundary;     // thickness of the band
  uniform float uBias;         // how much of that thickness sits outside uRadius
  uniform float uBoundaryGlow;
  uniform float uLiner;
  uniform float uSoftness;
  uniform float uFill;
  uniform float uFillFalloff;
  uniform float uRings;
  uniform float uRingWidth;
  uniform float uRingSpeed;
  uniform float uCrawl;
  uniform float uCrawlScale;
  uniform float uCrawlSpeed;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uTicks;
  uniform float uTickLength;
  uniform float uTickWidth;
  uniform float uTickSpin;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uCrosshair;
  uniform float uCrosshairLength;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uReveal;       // 0..1 snap-out
  uniform float uInvalid;      // 1 when the target is inside the minimum range
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    /* ---- uv → metres, measured from the target; +y is downrange ---- */
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    float outer = uRadius + uBoundary * uBias;
    float inner = max(0.01, uRadius - uBoundary * (1.0 - uBias));

    float aa = fwidth(d) + uSoftness;
    if (d > outer + aa * 3.0) discard;

    /* ---- the band that *is* the footprint ---- */
    float band = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);
    // A hard liner on the inside lip: the band alone reads soft at a distance,
    // and the inside lip is the line the player is actually measuring against.
    float liner = 1.0 - smoothstep(uLiner, uLiner + aa, abs(d - inner));

    float interior = smoothstep(inner + aa, inner - aa, d);
    float radial = clamp(d / inner, 0.0, 1.0);

    /* ---- the wash inside it ---- */
    // Weighted to the rim: a flat disc reads as a decal lying on the floor, a
    // rim-weighted one reads as a volume standing inside the boundary.
    float wash = pow(radial, uFillFalloff);
    float n = fbm3(vec3(p * uNoiseScale, uTime * 0.2)) * 0.5 + 0.5;
    wash *= mix(1.0, n, uNoise);

    // Contour rings travelling outward — the read that says "this is a field
    // with a size", not a puddle.
    float ringPhase = radial * uRings - uTime * uRingSpeed;
    float ring = smoothstep(1.0 - uRingWidth, 1.0, 0.5 + 0.5 * cos(ringPhase * TAU));

    // Filaments crawling over the interior, sampled in the *plane* and domain
    // warped. Sampling on atan() would hand every radius along a bearing the
    // same value and draw dead-straight spokes — a firework, not a field.
    float warp = fbm3(vec3(p * 0.4, uTime * 0.15 + 3.1)) * 0.6;
    float fil = ridged(vec3(p * uCrawlScale + warp, uTime * uCrawlSpeed), 4);
    float veins = smoothstep(0.68, 0.95, fil);

    wash += ring * 0.4;
    wash += veins * uCrawl * (0.3 + 0.7 * radial);

    /* ---- furniture ---- */
    float ang = atan(p.y, p.x) / TAU + 0.5;

    // Ticks stepping around the boundary. Deliberate radial marks, so this is
    // the one place an angular function is the right tool.
    float tickPhase = fract(ang * uTicks + uTime * uTickSpin * uTicks);
    float tick = 1.0 - smoothstep(uTickWidth, uTickWidth + 0.06, tickPhase);
    tick *= smoothstep(inner - uTickLength, inner, d) * smoothstep(outer, inner, d);

    // A slow sweep, trailing rather than symmetric, so it reads as rotating.
    // The second term feathers the wrap point: without it the tail meets the
    // head at full brightness and the sweep reads as a hard wedge.
    float sweepPhase = fract(ang - uTime * uSweepSpeed);
    float sweep = pow(1.0 - sweepPhase, 6.0) * smoothstep(0.0, 0.05, sweepPhase) * uSweep * interior;

    float core = smoothstep(uCoreSize, 0.0, d) * uCore;
    float coreRing = (1.0 - smoothstep(0.02, 0.045, abs(d - uCoreSize * 0.8))) * uCore * 0.8;

    // Four arms out of the core, the downrange one longer: with the quad yawed
    // onto the aim, that arm is the heading.
    float armLength = uCrosshairLength * mix(1.0, 1.8, step(0.0, p.y) * step(abs(p.x), abs(p.y)));
    float arms = max(1.0 - smoothstep(0.02, 0.05, abs(p.x)), 1.0 - smoothstep(0.02, 0.05, abs(p.y)));
    arms *= smoothstep(armLength, armLength * 0.25, d) * smoothstep(uCoreSize * 0.5, uCoreSize, d);
    arms *= uCrosshair;

    /* ---- assemble ---- */
    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float fill = interior * wash * uFill * breathe;
    float lines = (liner * 1.3 + tick + core + coreRing + arms + sweep) * breathe;
    float edge = band * uBoundaryGlow * breathe;

    float alpha = clamp(fill + lines + edge, 0.0, 1.0) * uOpacity * uReveal;
    if (alpha < 0.004) discard;

    // The band is drawn halfway between the two colours rather than in the core
    // white the rest of the furniture uses. At the glow it needs to read as the
    // thickest thing on screen it would otherwise clip flat, and the ability
    // loses the one cue that says which cast this circle belongs to.
    vec3 color = uColorEdge * fill + uColorCore * lines + mix(uColorEdge, uColorCore, 0.5) * edge;
    color = mix(color, uColorInvalid * (fill + lines + edge), uInvalid);

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The reach ring, drawn on the bolt's ribbon strip bent into a circle.
 *
 * A quad big enough to hold a 20 m range would be 40 m across and shade a
 * screenful of discarded fragments for one thin line; a strip costs the ring
 * itself and nothing else. `(t, side)` arrives as "how far around" and "which
 * lip", and comes out as a world position — same contract as every other
 * parametric mesh in the project.
 */
const REACH_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uSpin;

  varying float vAngle;
  varying float vSide;

  void main() {
    float t = position.x;
    float side = position.y;
    vAngle = t;
    vSide = side;

    float a = (t + uTime * uSpin) * TAU;
    vec3 dir = vec3(sin(a), 0.0, cos(a));
    vec3 world = uCentre + dir * (uRadius + side * uWidth);

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const REACH_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uDashes;
  uniform float uDashGap;
  uniform float uSpin;
  uniform float uLead;        // bearing of the cursor, as a 0..1 fraction
  uniform float uLeadStrength;
  uniform float uIntensity;
  uniform float uReveal;
  uniform float uInvalid;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying float vAngle;
  varying float vSide;

  void main() {
    float profile = 1.0 - clamp(abs(vSide), 0.0, 1.0);
    profile = pow(profile, 1.6);

    // The dash pattern is welded to the strip's own parameter, and the vertex
    // shader is what rotates the strip — so the dashes creep with the ring
    // rather than sitting still in the world while it turns under them.
    float dash = 1.0;
    if (uDashes > 0.5) {
      float phase = fract(vAngle * uDashes);
      dash = 1.0 - smoothstep(1.0 - uDashGap, 1.0 - uDashGap + 0.12, phase);
    }

    // The lead marker is pinned to a *world* bearing, so it has to undo the
    // spin the vertex shader applied. Shortest way round, 0..0.5.
    float world = fract(vAngle + uTime * uSpin);
    float delta = abs(fract(world - uLead + 0.5) - 0.5);
    float lead = smoothstep(0.12, 0.0, delta) * uLeadStrength;

    float alpha = profile * (dash * uIntensity + lead) * uReveal * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = mix(uColorEdge, uColorCore, clamp(lead + profile * 0.4, 0.0, 1.0));
    color = mix(color, uColorInvalid, uInvalid);

    gl_FragColor = vec4(color * uGlobalGlow, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * The ground circle drawn while a **far cast** is armed.
 *
 * Two parametric meshes and no textures: the footprint at the cursor, and the
 * reach ring at the caster's feet. Both are rebuilt from the live
 * `settings.zone` block every frame, so dragging any slider reshapes the circle
 * under the cursor immediately — and dragging the ability's own `zoneRadius`
 * resizes the promise the indicator is making.
 *
 * The footprint snaps out past its radius and settles back when the cast is
 * armed. That overshoot is the whole personality of the indicator: a circle
 * that grows linearly reads as a UI element, one that slams out reads as
 * something the caster did.
 */
export class ZoneIndicator {
  constructor() {
    this.group = new Group();
    this.group.name = 'ZoneIndicator';
    this.group.matrixAutoUpdate = false;

    /* ---- the footprint ---- */
    // Unit square in the ground plane, centred: local +Z is the aim heading, so
    // placing it is a yaw and a scale.
    this.discGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.discMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uQuadSize: { value: 12 },
        uRadius: { value: 4.4 },
        uBoundary: { value: 0.34 },
        uBias: { value: 0.35 },
        uBoundaryGlow: { value: 2.4 },
        uLiner: { value: 0.05 },
        uSoftness: { value: 0.05 },
        uFill: { value: 0.18 },
        uFillFalloff: { value: 1.5 },
        uRings: { value: 2 },
        uRingWidth: { value: 0.05 },
        uRingSpeed: { value: 0.35 },
        uCrawl: { value: 0.6 },
        uCrawlScale: { value: 1.3 },
        uCrawlSpeed: { value: 0.45 },
        uNoise: { value: 0.4 },
        uNoiseScale: { value: 1.2 },
        uTicks: { value: 24 },
        uTickLength: { value: 0.42 },
        uTickWidth: { value: 0.2 },
        uTickSpin: { value: 0.06 },
        uSweep: { value: 0.55 },
        uSweepSpeed: { value: 0.4 },
        uCore: { value: 0.85 },
        uCoreSize: { value: 0.4 },
        uCrosshair: { value: 0.5 },
        uCrosshairLength: { value: 1.1 },
        uPulse: { value: 0.22 },
        uPulseSpeed: { value: 2 },
        uReveal: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(0.92, 0.97, 1) },
        uColorEdge: { value: new Color(0.49, 0.42, 1) },
        uColorInvalid: { value: new Color(1, 0.41, 0.36) }
      }),
      vertexShader: ZONE_VERTEX,
      fragmentShader: ZONE_FRAGMENT
    });

    this.disc = new Mesh(this.discGeometry, this.discMaterial);
    this.disc.name = 'ZoneFootprint';
    this.disc.layers.set(LAYER.VFX);
    this.disc.renderOrder = 5; // under the VFX, over the floor
    this.disc.frustumCulled = false;

    /* ---- the reach ring ---- */
    this.reachGeometry = createBoltRibbonGeometry(settings.zone.reachSegments + 1, 1);
    this.reachMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uCentre: { value: new Vector3() },
        uRadius: { value: 20 },
        uWidth: { value: 0.05 },
        uSpin: { value: 0.03 },
        uDashes: { value: 64 },
        uDashGap: { value: 0.42 },
        uLead: { value: 0 },
        uLeadStrength: { value: 0.9 },
        uIntensity: { value: 0.7 },
        uReveal: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(0.92, 0.97, 1) },
        uColorEdge: { value: new Color(0.49, 0.42, 1) },
        uColorInvalid: { value: new Color(1, 0.41, 0.36) }
      }),
      vertexShader: REACH_VERTEX,
      fragmentShader: REACH_FRAGMENT
    });

    this.reach = new Mesh(this.reachGeometry, this.reachMaterial);
    this.reach.name = 'ZoneReachRing';
    this.reach.layers.set(LAYER.VFX);
    this.reach.renderOrder = 5;
    this.reach.frustumCulled = false;

    this.group.add(this.disc, this.reach);
    this.group.visible = false;
  }

  get object3D() {
    return this.group;
  }

  /**
   * Place and re-shape the circle.
   *
   * @param {THREE.Vector3} origin  the caster's feet
   * @param {number} yaw            heading of the aim, radians about +Y
   * @param {number} distance       how far out the target point is, metres
   * @param {number} radius         the ability's footprint, metres
   * @param {number} range          the ability's maximum reach, metres
   * @param {number} reveal         0..1 snap-out
   * @param {boolean} valid         false tints the circle to `colorInvalid`
   */
  update(origin, yaw, distance, radius, range, reveal, valid) {
    const z = settings.zone;
    const opacity = z.opacity * settings.global.opacity;
    const invalid = valid ? 0 : 1;

    /* ---- the snap-out ---- */
    // Two curves multiplied: a grow that settles at 1, and a bump that peaks
    // late and dies at exactly 1 so the circle overshoots its own radius on the
    // way out and pulls back onto it. A linear grow reads as a UI element.
    const t = saturate(reveal);
    const bump = Math.sin(Math.PI * Math.pow(t, 1.7));
    const snapped = radius * Easing.outCubic(t) * (1 + (z.snap - 1) * bump);

    /* ---- the footprint ---- */
    const quadSize = (radius * Math.max(1, z.snap) + z.boundary + 0.6) * 2;
    const u = this.discMaterial.uniforms;

    u.uQuadSize.value = quadSize;
    u.uRadius.value = Math.max(0.05, snapped);
    u.uBoundary.value = z.boundary;
    u.uBias.value = z.boundaryBias;
    u.uBoundaryGlow.value = z.boundaryGlow;
    u.uLiner.value = z.liner;
    u.uSoftness.value = z.softness;
    u.uFill.value = z.fill;
    u.uFillFalloff.value = z.fillFalloff;
    u.uRings.value = z.rings;
    u.uRingWidth.value = z.ringWidth;
    u.uRingSpeed.value = z.ringSpeed;
    u.uCrawl.value = z.crawl;
    u.uCrawlScale.value = z.crawlScale;
    u.uCrawlSpeed.value = z.crawlSpeed;
    u.uNoise.value = z.noise;
    u.uNoiseScale.value = z.noiseScale;
    u.uTicks.value = Math.max(0, Math.round(z.ticks));
    u.uTickLength.value = z.tickLength;
    u.uTickWidth.value = z.tickWidth;
    u.uTickSpin.value = z.tickSpin;
    u.uSweep.value = z.sweep;
    u.uSweepSpeed.value = z.sweepSpeed;
    u.uCore.value = z.core;
    u.uCoreSize.value = z.coreSize;
    u.uCrosshair.value = z.crosshair;
    u.uCrosshairLength.value = z.crosshairLength;
    u.uPulse.value = z.pulse;
    u.uPulseSpeed.value = z.pulseSpeed;
    u.uReveal.value = t;
    u.uInvalid.value = invalid;
    u.uOpacity.value = opacity;
    u.uColorCore.value.copy(getColor(z.colorCore));
    u.uColorEdge.value.copy(getColor(z.colorEdge));
    u.uColorInvalid.value.copy(getColor(z.colorInvalid));

    this.disc.position.set(
      origin.x + Math.sin(yaw) * distance,
      z.height,
      origin.z + Math.cos(yaw) * distance
    );
    this.disc.rotation.set(0, yaw, 0);
    this.disc.scale.set(quadSize, 1, quadSize);

    /* ---- the reach ring ---- */
    const r = this.reachMaterial.uniforms;
    r.uCentre.value.set(origin.x, z.height, origin.z);
    r.uRadius.value = Math.max(0.2, range);
    r.uWidth.value = z.reachWidth;
    r.uSpin.value = z.reachSpin;
    r.uDashes.value = Math.max(0, Math.round(z.reachDashes));
    r.uDashGap.value = z.reachDashGap;
    // The strip's `t` runs from +Z anticlockwise, which is how the vertex
    // shader lays it out — so the cursor's bearing is just its yaw over a turn.
    r.uLead.value = ((yaw / (Math.PI * 2)) % 1 + 1) % 1;
    r.uLeadStrength.value = z.reachLead;
    r.uIntensity.value = z.reach;
    r.uReveal.value = t;
    r.uInvalid.value = invalid;
    r.uOpacity.value = opacity;
    r.uColorCore.value.copy(getColor(z.colorCore));
    r.uColorEdge.value.copy(getColor(z.colorEdge));
    r.uColorInvalid.value.copy(getColor(z.colorInvalid));

    this.reach.visible = z.reach > 0.001;
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  dispose() {
    this.discGeometry.dispose();
    this.discMaterial.dispose();
    this.reachGeometry.dispose();
    this.reachMaterial.dispose();
  }
}
