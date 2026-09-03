import { ShaderMaterial, AdditiveBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/* ==================================================================== */
/* The floor the crown stands on                                         */
/* ==================================================================== */

const FIELD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The circle the indicator promised, **frozen** into the floor.
 *
 * Same signed-distance construction and the same thick boundary as the aim
 * circle and the Voltaic Snare's burnt field — that correspondence is the point:
 * what you measured out before you clicked is what is standing on the ground
 * afterwards. What it does not share is the treatment. Where the snare's field
 * is charred and veined, this one is a *sheet of ice*, and it is built from the
 * three things that actually read as frozen ground:
 *
 *   - **plates.** A voronoi field whose *seams* are bright, because rime piles
 *     up thickest where two plates meet. The cell id also breaks the tone of
 *     each plate, so the sheet has facets rather than a wash.
 *   - **fingers.** Domain-warped ridged noise weighted to the radius: frost
 *     never advances as a circle, it reaches. Sampled in the *plane* and never
 *     on `atan()`, which would hand every radius along a bearing the same value
 *     and draw dead-straight spokes out of the middle.
 *   - **a front.** `uFreeze` is how far the ice has got, 0..1 of the boundary,
 *     with the same angular fingering dragging the edge out of round. It runs
 *     forward as the crown opens and *retreats* as it collapses, so the disc
 *     freezes outward and thaws inward instead of fading in place.
 *
 * It is an ability-owned mesh rather than a pooled decal for one reason: a decal
 * captures its radius when it spawns, and this circle has to re-scale under
 * `zoneRadius` while it is still standing.
 */
const FIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;    // metres the quad covers, edge to edge
  uniform float uRadius;      // footprint radius, metres
  uniform float uBoundary;    // thickness of the band that is the edge
  uniform float uBoundaryGlow;
  uniform float uFill;
  uniform float uFalloff;
  uniform float uPlates;
  uniform float uPlateScale;
  uniform float uSeam;
  uniform float uFingers;
  uniform float uFingerScale;
  uniform float uWarp;
  uniform float uCrawl;
  uniform float uRings;
  uniform float uRingSpeed;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uFreeze;      // 0..1 — how far the sheet has spread
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorField;
  uniform vec3  uColorEdge;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    /* ---- uv → metres, measured from the centre of the footprint ---- */
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    float outer = uRadius + uBoundary * 0.4;
    float inner = max(0.01, uRadius - uBoundary * 0.6);

    float aa = fwidth(d) + 0.02;
    if (d > outer + aa * 4.0) discard;

    /* ---- how far the ice has actually got ---- */
    // The front is dragged out of round by an angular lookup — the one place an
    // angular function is the right tool, because this *is* a boundary.
    vec2  bearing = d > 1e-4 ? p / d : vec2(1.0, 0.0);
    float fingers = 0.78 + 0.3 * snoise(vec3(bearing * 3.1, uSeed * 6.0));
    float reach   = uFreeze * outer * fingers;
    float frozen  = smoothstep(reach, reach - uBoundary * 1.6, d);
    if (frozen < 0.004) discard;

    float band = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);
    float interior = smoothstep(inner + aa, inner - aa, d);
    float radial = clamp(d / inner, 0.0, 1.0);

    /* ---- the sheet: plates, and the rime piled in their seams ---- */
    vec2  cell  = voronoi2(p * uPlateScale + uSeed * 20.0);
    float seams = smoothstep(0.28, 0.02, cell.x) * uSeam;
    float plate = mix(0.55, 1.0, cell.y) * uPlates;

    /* ---- frost fingers crawling over it ---- */
    float warp = fbm3(vec3(p * 0.5, uTime * 0.12 + uSeed)) * uWarp;
    float fil  = ridged(vec3(p * uFingerScale + warp, uSeed * 11.0 + uTime * uCrawl), 4);
    float frost = smoothstep(0.66, 0.95, fil) * uFingers * (0.35 + 0.65 * radial);

    /* ---- pressure rings, travelling inward toward the spire ---- */
    float ring = 0.5 + 0.5 * cos((radial * uRings + uTime * uRingSpeed) * TAU);
    ring = pow(ring, 8.0) * interior;

    /* ---- a slow cold sweep, so a standing field is never quite still ---- */
    float ang = atan(p.y, p.x) / TAU + 0.5;
    float sweepPhase = fract(ang - uTime * uSweepSpeed);
    float sweep = pow(1.0 - sweepPhase, 6.0) * smoothstep(0.0, 0.05, sweepPhase) * uSweep * interior;

    /* ---- the pool the spire stands in ---- */
    float core = smoothstep(uCoreSize * uRadius, 0.0, d) * uCore;

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float wash  = interior * pow(radial, uFalloff) * uFill * plate;
    float body  = (wash + frost * 0.8) * breathe;
    float lines = (band * uBoundaryGlow + seams * interior * 0.9 + ring * 0.4 + sweep + core) * breathe;

    float alpha = clamp(body + lines, 0.0, 1.0) * frozen * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = uColorField * body + uColorEdge * lines;
    // The advancing lip is still freezing, so it stays lit while it travels.
    color += uColorEdge * smoothstep(uBoundary * 1.2, 0.0, abs(d - reach)) * 0.9 *
             step(0.02, uFreeze) * step(uFreeze, 0.985);

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The sheet of ice on the floor. One quad, re-sized and re-shaded from
 * `settings.glacier` every frame.
 */
export function createFrostFieldMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 12 },
      uRadius: { value: 4.6 },
      uBoundary: { value: 0.4 },
      uBoundaryGlow: { value: 2.4 },
      uFill: { value: 0.26 },
      uFalloff: { value: 1.4 },
      uPlates: { value: 1 },
      uPlateScale: { value: 2.2 },
      uSeam: { value: 0.8 },
      uFingers: { value: 0.9 },
      uFingerScale: { value: 1.6 },
      uWarp: { value: 0.5 },
      uCrawl: { value: 0.12 },
      uRings: { value: 2.6 },
      uRingSpeed: { value: -0.5 },
      uSweep: { value: 0.4 },
      uSweepSpeed: { value: 0.12 },
      uCore: { value: 1 },
      uCoreSize: { value: 0.2 },
      uPulse: { value: 0.18 },
      uPulseSpeed: { value: 1.6 },
      uFreeze: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorField: { value: new Color(0.66, 0.9, 1) },
      uColorEdge: { value: new Color(1, 1, 1) }
    }),
    vertexShader: FIELD_VERTEX,
    fragmentShader: FIELD_FRAGMENT
  });

  /**
   * @param {object} state { radius, quadSize, freeze, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.glacier;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uFreeze.value = state.freeze;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uBoundary.value = c.fieldBoundary;
    u.uBoundaryGlow.value = c.fieldBoundaryGlow;
    u.uFill.value = c.fieldFill;
    u.uFalloff.value = c.fieldFalloff;
    u.uPlates.value = c.fieldPlates;
    u.uPlateScale.value = c.fieldPlateScale * g.noiseFrequency;
    u.uSeam.value = c.fieldSeam * g.shaderIntensity;
    u.uFingers.value = c.fieldFingers * g.shaderIntensity;
    u.uFingerScale.value = c.fieldFingerScale * g.noiseFrequency;
    u.uWarp.value = c.fieldWarp * g.noiseStrength;
    u.uCrawl.value = c.fieldCrawl * g.noiseSpeed;
    u.uRings.value = c.fieldRings;
    u.uRingSpeed.value = c.fieldRingSpeed;
    u.uSweep.value = c.fieldSweep;
    u.uSweepSpeed.value = c.fieldSweepSpeed;
    u.uCore.value = c.fieldCore;
    u.uCoreSize.value = c.fieldCoreSize;
    u.uPulse.value = c.fieldPulse;
    u.uPulseSpeed.value = c.fieldPulseSpeed;
    u.uOpacity.value = c.fieldOpacity * g.opacity;
    u.uColorField.value.copy(getColor(c.colorField));
    u.uColorEdge.value.copy(getColor(c.colorFieldEdge));
  };

  return material;
}

/* ==================================================================== */
/* The curtain of cold air standing on the ring                          */
/* ==================================================================== */

/**
 * A cylinder in *parameter* space: `uv.x` runs once around the boundary and
 * `uv.y` from the floor to the top of the curtain, and the vertex stage flares
 * it outward with height and pushes the silhouette off round with the same noise
 * the fragment stage erodes it with. Without that displacement the veil is a
 * cylinder no matter how hard the fragment shader is worked, and it reads as a
 * fog machine rather than as air falling off a wall of ice.
 */
const VEIL_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uFlare;
  uniform float uBillow;
  uniform float uScale;
  uniform float uFlow;
  uniform float uSeed;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    vUv = uv;

    vec3 pos = position;
    vec2 outward = normalize(pos.xz + vec2(1e-5));

    // Cold air spills *outward* as it falls off the rim, so the curtain leans
    // out with height rather than standing straight up.
    pos.xz *= 1.0 + uFlare * pow(clamp(uv.y, 0.0, 1.0), 1.6);

    // Metre-scale lobes, so the silhouette bulges and pinches around the ring.
    float lobe = snoise(vec3(outward * uScale * 1.4, uTime * uFlow * 0.35 + uSeed));
    pos.xz += outward * lobe * uBillow * (0.25 + 0.75 * uv.y);

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The veil itself: ridged noise stretched hard vertically and scrolled *down*,
 * thresholded harder the higher it goes, so the curtain tears into separate
 * falls of vapour toward the top instead of ending on a line. Soft-faded against
 * the depth prepass, which is what lets it stand between the shards without
 * cutting into them.
 */
const VEIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uScale;
  uniform float uStretch;
  uniform float uFlow;
  uniform float uErode;
  uniform float uFalloff;
  uniform float uSoftFade;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorVeil;
  uniform vec3  uColorCrest;
  uniform float uGlobalGlow;

  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float up = clamp(vUv.y, 0.0, 1.0);

    // Sampled in world space so the curtain does not swim when the ring is
    // re-scaled, and squashed on Y so the structures are falls rather than
    // clouds.
    vec3 sp = vec3(vWorld.xz * uScale, vWorld.y * uScale * uStretch + uTime * uFlow + uSeed * 7.0);
    float fil = ridged(sp, 4);

    // Erode harder with height: the top of the curtain is mostly gaps.
    float threshold = mix(0.52, 0.95, up * uErode);
    float veil = smoothstep(threshold, threshold + 0.22, fil);

    // Weighted to the floor, and pinched off right at it so the curtain does not
    // end in a hard line where it meets the ground.
    float profile = pow(1.0 - up, uFalloff) * smoothstep(0.0, 0.08, up);

    float alpha = veil * profile * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    vec3 color = mix(uColorVeil, uColorCrest, clamp(veil * 1.3 * (1.0 - up), 0.0, 1.0));
    gl_FragColor = vec4(color * uGlobalGlow, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * The standing curtain of freezing vapour. One open cylinder seated on the
 * boundary, re-sized and re-shaded from `settings.glacier` every frame.
 */
export function createFrostVeilMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uFlare: { value: 0.35 },
      uBillow: { value: 0.22 },
      uScale: { value: 1.4 },
      uStretch: { value: 0.55 },
      uFlow: { value: 0.35 },
      uErode: { value: 0.55 },
      uFalloff: { value: 1.8 },
      uSoftFade: { value: 0.8 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 0.55 },
      uColorVeil: { value: new Color(0.55, 0.82, 1) },
      uColorCrest: { value: new Color(1, 1, 1) }
    }),
    vertexShader: VEIL_VERTEX,
    fragmentShader: VEIL_FRAGMENT
  });

  /**
   * @param {object} state { fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.glacier;
    const g = settings.global;
    const u = material.uniforms;

    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uFlare.value = c.veilFlare;
    u.uBillow.value = c.veilBillow * g.noiseStrength;
    u.uScale.value = c.veilScale * g.noiseFrequency;
    u.uStretch.value = c.veilStretch;
    u.uFlow.value = c.veilFlow * g.noiseSpeed;
    u.uErode.value = c.veilErode;
    u.uFalloff.value = c.veilFalloff;
    u.uSoftFade.value = c.veilSoftFade;
    u.uOpacity.value = c.veil * g.opacity;
    u.uColorVeil.value.copy(getColor(c.colorVeil));
    u.uColorCrest.value.copy(getColor(c.colorVeilCrest));
  };

  return material;
}
