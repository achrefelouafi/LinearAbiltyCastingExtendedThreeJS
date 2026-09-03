import {
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  AdditiveBlending,
  Color,
  DoubleSide
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

const AIM_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The whole indicator is one signed-distance field evaluated in metres.
 *
 * `vUv` is remapped so that `p.y` is the distance from the caster along the aim
 * line and `p.x` is the lateral offset, both in world metres. Every control in
 * `settings.aim` is therefore a real measurement rather than a UV fraction,
 * which is what lets the shaft width and the head stay the same physical size
 * whether the cast is 3 m or 15 m long.
 */
const AIM_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadLength;   // length the quad covers, metres
  uniform float uQuadWidth;    // width the quad covers, metres
  uniform float uQuadBack;     // how far behind the caster the quad starts
  uniform float uLength;       // the cast distance itself, metres
  uniform float uStart;        // gap between the caster and the tail
  uniform float uShaftWidth;
  uniform float uHeadLength;
  uniform float uHeadWidth;
  uniform float uRound;
  uniform float uEdge;
  uniform float uEdgeGlow;
  uniform float uSoftness;
  uniform float uFill;
  uniform float uFillFalloff;
  uniform float uStripes;
  uniform float uStripeSharp;
  uniform float uStripeDepth;
  uniform float uScrollSpeed;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;
  uniform float uCrystals;
  uniform float uCrystalScale;
  uniform float uBaseRing;
  uniform float uBaseRingWidth;
  uniform float uTipGlyph;
  uniform float uTipGlyphSize;
  uniform float uTipSpin;
  uniform float uRangeArc;
  uniform float uReveal;       // 0..1 sweep-out when the cast is armed
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

  float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }

  /* iq's exact triangle SDF — needed because the head is a wide, shallow wedge
     where a cheap half-plane intersection leaves visible corner artefacts. */
  float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
    vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
    vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;

    vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);

    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                     vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
  }

  void main() {
    /* ---- uv → metres, measured from the caster ---- */
    vec2 p = vec2((vUv.x - 0.5) * uQuadWidth,
                  (1.0 - vUv.y) * uQuadLength - uQuadBack);

    float length_ = max(uLength, uStart + 0.05);
    float headLen = min(uHeadLength, length_ - uStart);
    float headBase = length_ - headLen;

    /* ---- silhouette ---- */
    float shaft = sdBox(p - vec2(0.0, (uStart + headBase) * 0.5),
                        vec2(uShaftWidth, max(0.001, (headBase - uStart) * 0.5)));
    float head = sdTriangle(p,
                            vec2(-uHeadWidth, headBase),
                            vec2( uHeadWidth, headBase),
                            vec2( 0.0,        length_));
    float d = min(shaft, head) - uRound;

    float aa = fwidth(d) + uSoftness;
    float body = 1.0 - smoothstep(-aa, aa, d);
    float outline = 1.0 - smoothstep(uEdge, uEdge + aa, abs(d));

    /* ---- interior wash ---- */
    // Brighter toward the rim: a flat fill reads as a decal, a rim-weighted one
    // reads as a volume of light lying on the floor.
    float depth = clamp(-d / max(uShaftWidth, 0.05), 0.0, 1.0);
    float interior = pow(1.0 - depth, uFillFalloff);

    // Chevrons running toward the tip. Skewing the phase by |x| turns the flat
    // bands into arrowheads that all point the same way the cast does.
    float phase = (p.y - abs(p.x) * 0.55 - uTime * uScrollSpeed) * uStripes;
    float band = 0.5 + 0.5 * cos(phase * TAU);
    band = pow(band, mix(1.0, 9.0, uStripeSharp));

    float frost = fbm3(vec3(p * uNoiseScale, uTime * uNoiseSpeed)) * 0.5 + 0.5;
    vec2 cell = voronoi2(p * uCrystalScale + 13.7);
    float plates = smoothstep(0.32, 0.0, cell.x);

    float wash = interior;
    wash *= mix(1.0, band, uStripeDepth);
    wash *= mix(1.0, frost, uNoise);
    wash += plates * uCrystals * 0.35 * interior;
    wash *= 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);

    /* ---- furniture ---- */
    float radius = length(p);
    float ring = smoothstep(uBaseRingWidth, 0.0, abs(radius - uBaseRing));

    // A cap arc at maximum reach, clipped to the width of the head so it reads
    // as a range marker instead of a full circle.
    float arc = smoothstep(0.05, 0.0, abs(radius - length_)) *
                smoothstep(uHeadWidth * 2.2, uHeadWidth * 1.1, abs(p.x)) * uRangeArc;

    // A six-fold frost rosette pinned to the impact point.
    vec2 q = p - vec2(0.0, length_);
    float qr = length(q);
    float qa = atan(q.y, q.x) + uTime * uTipSpin * TAU;
    float spokes = smoothstep(0.86, 1.0, abs(cos(qa * 3.0))) *
                   smoothstep(uTipGlyphSize, 0.0, qr);
    float glyphRing = smoothstep(0.045, 0.0, abs(qr - uTipGlyphSize * 0.5));
    float glyph = max(spokes, glyphRing) * uTipGlyph;

    /* ---- the sweep-out when the cast is armed ---- */
    float front = uReveal * (length_ + uTipGlyphSize);
    float sweep = smoothstep(front + 0.25, front - 0.15, p.y);
    float sweepEdge = smoothstep(0.35, 0.0, abs(p.y - front)) * step(uReveal, 0.999);

    /* ---- assemble ---- */
    float fill = body * wash * uFill;
    float lines = outline * uEdgeGlow + ring + arc + glyph;

    float alpha = clamp(fill + lines + sweepEdge * 0.6, 0.0, 1.0) * sweep * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = uColorEdge * fill + uColorCore * (lines + sweepEdge);
    color = mix(color, uColorInvalid * (fill + lines + sweepEdge), uInvalid);

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The ground arrow drawn while a cast is armed.
 *
 * One quad, one shader, no textures. The quad is re-sized and re-oriented every
 * frame from the live `settings.aim` block and the current aim, so dragging any
 * slider in the editor reshapes the arrow under the cursor immediately.
 */
export class AimIndicator {
  constructor() {
    // Unit space: x ∈ [-0.5, 0.5], z ∈ [0, 1], facing up. Local +Z is the aim
    // direction, so orienting the arrow is a single yaw.
    this.geometry = new PlaneGeometry(1, 1, 1, 1)
      .rotateX(-Math.PI / 2)
      .translate(0, 0, 0.5);

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uQuadLength: { value: 10 },
        uQuadWidth: { value: 6 },
        uQuadBack: { value: 1 },
        uLength: { value: 8 },
        uStart: { value: 0.9 },
        uShaftWidth: { value: 0.42 },
        uHeadLength: { value: 2.6 },
        uHeadWidth: { value: 1.35 },
        uRound: { value: 0.12 },
        uEdge: { value: 0.09 },
        uEdgeGlow: { value: 2.6 },
        uSoftness: { value: 0.06 },
        uFill: { value: 0.3 },
        uFillFalloff: { value: 1.1 },
        uStripes: { value: 0.55 },
        uStripeSharp: { value: 0.62 },
        uStripeDepth: { value: 0.55 },
        uScrollSpeed: { value: 2.4 },
        uPulse: { value: 0.28 },
        uPulseSpeed: { value: 2.2 },
        uNoise: { value: 0.45 },
        uNoiseScale: { value: 1.6 },
        uNoiseSpeed: { value: 0.35 },
        uCrystals: { value: 0.55 },
        uCrystalScale: { value: 2.4 },
        uBaseRing: { value: 0.62 },
        uBaseRingWidth: { value: 0.06 },
        uTipGlyph: { value: 0.9 },
        uTipGlyphSize: { value: 1.15 },
        uTipSpin: { value: 0.45 },
        uRangeArc: { value: 0.55 },
        uReveal: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(0.92, 0.98, 1) },
        uColorEdge: { value: new Color(0.24, 0.7, 1) },
        uColorInvalid: { value: new Color(1, 0.41, 0.36) }
      }),
      vertexShader: AIM_VERTEX,
      fragmentShader: AIM_FRAGMENT
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'AimIndicator';
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = 5; // under the VFX, over the floor
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  get object3D() {
    return this.mesh;
  }

  /**
   * Place and re-shape the arrow.
   *
   * @param {THREE.Vector3} origin  the caster's feet
   * @param {number} yaw            heading of the aim line, radians about +Y
   * @param {number} distance       cast distance, metres
   * @param {number} reveal         0..1 sweep-out
   * @param {boolean} valid         false tints the arrow to `colorInvalid`
   */
  update(origin, yaw, distance, reveal, valid) {
    const a = settings.aim;
    const u = this.material.uniforms;

    // The quad has to hold the widest thing the shader draws, plus the ring that
    // sits *behind* the caster and the rosette that sits *past* the tip.
    const back = Math.max(a.baseRing, 0.2) + 0.4;
    const forward = distance + Math.max(a.tipGlyphSize, 0.3) + 0.5;
    const halfWidth =
      Math.max(a.headWidth, a.shaftWidth, a.baseRing, a.tipGlyphSize) + a.edge + a.round + 0.5;

    const quadLength = back + forward;
    const quadWidth = halfWidth * 2;

    u.uQuadLength.value = quadLength;
    u.uQuadWidth.value = quadWidth;
    u.uQuadBack.value = back;
    u.uLength.value = distance;
    u.uStart.value = a.startOffset;
    u.uShaftWidth.value = a.shaftWidth;
    u.uHeadLength.value = a.headLength;
    u.uHeadWidth.value = a.headWidth;
    u.uRound.value = a.round;
    u.uEdge.value = a.edge;
    u.uEdgeGlow.value = a.edgeGlow;
    u.uSoftness.value = a.softness;
    u.uFill.value = a.fill;
    u.uFillFalloff.value = a.fillFalloff;
    u.uStripes.value = a.stripes;
    u.uStripeSharp.value = a.stripeSharp;
    u.uStripeDepth.value = a.stripeDepth;
    u.uScrollSpeed.value = a.scrollSpeed;
    u.uPulse.value = a.pulse;
    u.uPulseSpeed.value = a.pulseSpeed;
    u.uNoise.value = a.noise;
    u.uNoiseScale.value = a.noiseScale;
    u.uNoiseSpeed.value = a.noiseSpeed;
    u.uCrystals.value = a.crystals;
    u.uCrystalScale.value = a.crystalScale;
    u.uBaseRing.value = a.baseRing;
    u.uBaseRingWidth.value = a.baseRingWidth;
    u.uTipGlyph.value = a.tipGlyph;
    u.uTipGlyphSize.value = a.tipGlyphSize;
    u.uTipSpin.value = a.tipSpin;
    u.uRangeArc.value = a.rangeArc;
    u.uReveal.value = reveal;
    u.uInvalid.value = valid ? 0 : 1;
    u.uOpacity.value = a.opacity * settings.global.opacity;
    u.uColorCore.value.copy(getColor(a.colorCore));
    u.uColorEdge.value.copy(getColor(a.colorEdge));
    u.uColorInvalid.value.copy(getColor(a.colorInvalid));

    // Slide the quad back so the base ring is not clipped by its own near edge.
    this.mesh.position.set(
      origin.x - Math.sin(yaw) * back,
      a.height,
      origin.z - Math.cos(yaw) * back
    );
    this.mesh.rotation.set(0, yaw, 0);
    this.mesh.scale.set(quadWidth, 1, quadLength);
  }

  setVisible(visible) {
    this.mesh.visible = visible;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
