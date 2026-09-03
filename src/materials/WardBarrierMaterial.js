import { ShaderMaterial, NormalBlending, AdditiveBlending, Color, BackSide, FrontSide, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The four *lit* surfaces of the Volcanic Horror Ward: the blood membrane, the
 * rune bands burning at its foot and its rim, the flare standing in its middle
 * and the heat coming off the floor.
 *
 * All four take the same `state` object from `WardAbility` and all four read the
 * same heartbeat out of it, which is the entire trick behind the ability: the
 * membrane swells, the runes flare, the flare relights and the light throbs on
 * one envelope, so seven separate systems read as one thing that is alive.
 *
 * The floor is in `WardGroundMaterial.js` and the obsidian in
 * `ObsidianMaterial.js` — they are solid surfaces with their own concerns.
 */

/**
 * Which wall of the cylinder a barrier material draws.
 *
 * A single-sided shell has no inside, and a membrane you can see the far wall of
 * is the whole difference between a cylinder of glass and a *volume* of blood.
 * So the same open cylinder is drawn twice: back faces first (the far wall, seen
 * through everything in front of it), front faces after.
 */
export const WardPass = Object.freeze({
  INNER: 0, // back faces — the far wall
  OUTER: 1 // front faces — the near wall, drawn over it
});

const TAU = Math.PI * 2;

/* ==================================================================== */
/* The membrane                                                          */
/* ==================================================================== */

/**
 * A cylinder in *parameter* space: `uv.x` runs once around the ward and `uv.y`
 * from the floor to the rim, with the geometry supplied as a unit tube (radius
 * 1, y from 0 to 1) so placing it is a scale and a move.
 *
 * The silhouette is built here rather than in the fragment stage because a
 * membrane under pressure is not a lathe: it barrels out at the waist, opens a
 * little at the rim, breathes on the heartbeat and carries metre-scale lobes
 * that make it bulge and pinch around the ring. Do all that in the fragment
 * shader and it stays a perfect cylinder with a pattern painted on.
 */
const BARRIER_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uBulge;
  uniform float uFlare;
  uniform float uThrob;     // beat × throb — the wall swelling on a beat
  uniform float uWobble;
  uniform float uSwirl;
  uniform float uSpin;
  uniform float uSeed;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  ${noiseGLSL}

  #define PI 3.14159265359

  void main() {
    vUv = uv;
    float up = clamp(uv.y, 0.0, 1.0);

    // The tube is unit radius, so its own xz *is* the outward direction.
    vec2 dir = normalize(position.xz + vec2(1e-5));

    // Barrel at the waist, open at the rim, swell on the beat.
    float profile = 1.0 + uBulge * sin(up * PI) + uFlare * up * up + uThrob;

    // Metre-scale lobes so the ring bulges and pinches instead of being turned
    // on a lathe. Weighted to the top: the membrane is pinned where it meets
    // the floor and loose where it is not.
    float lobe = snoise(vec3(dir * 1.7, uTime * 0.25 + uSeed));
    profile += lobe * uWobble * (0.3 + 0.7 * up);

    // Shear with height + a slow overall turn. Applied after the noise is
    // sampled so the lobes stay welded to the wall rather than swimming.
    float turn = uSwirl * up + uTime * uSpin * ${TAU.toFixed(6)};
    vec2 turned = rot2(turn) * dir;

    vec3 pos = vec3(turned.x * profile, position.y, turned.y * profile);

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;
    // Uniform in x/z, so the surface normal of an upright tube is simply its
    // outward direction taken through the model matrix.
    vNormalW = normalize(mat3(modelMatrix) * vec3(turned.x, 0.0, turned.y));
    vViewDir = cameraPosition - world.xyz;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Blood held in a standing field.
 *
 * Five things stack, and each one is doing a job the others cannot:
 *
 *  - **the runs.** Ridged noise squashed hard on Y and scrolled *down*, sampled
 *    in world space so it does not swim when the ward is re-scaled. This is what
 *    says liquid rather than glass.
 *  - **the cells.** A voronoi membrane, sampled triplanar-style off two
 *    projections and blended by the normal, because the obvious `uv.x` lookup
 *    puts a visible seam down the back of the ward.
 *  - **the rim bands.** A hot line where the wall meets the floor and another at
 *    the rim. The reference sheet's barrier is legible almost entirely because
 *    of these two hoops.
 *  - **fresnel.** Grazing angles carry the silhouette; without it the wall
 *    disappears wherever it faces you.
 *  - **the beat.** Everything above is gained by the heartbeat, so the wall
 *    pumps instead of shimmering.
 *
 * Alpha blended rather than additive on purpose: the membrane has to *tint* the
 * monoliths standing behind it, and additive can only ever add.
 */
const BARRIER_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uDensity;
  uniform float uFresnel;
  uniform float uFresnelGain;
  uniform float uRimTop;
  uniform float uRimBase;
  uniform float uRimGlow;
  uniform float uFlowScale;
  uniform float uFlowStretch;
  uniform float uFlowSpeed;
  uniform float uFlowSharp;
  uniform float uFlowGain;
  uniform float uWarp;
  uniform float uCells;
  uniform float uCellScale;
  uniform float uBands;
  uniform float uBandSpeed;
  uniform float uBandWidth;
  uniform float uCrest;
  uniform float uRise;
  uniform float uDissolve;
  uniform float uDissolveEdge;
  uniform float uBeat;
  uniform float uSoftFade;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorMembrane;
  uniform vec3  uColorFlow;
  uniform vec3  uColorRim;
  uniform vec3  uColorDeep;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    float up = clamp(vUv.y, 0.0, 1.0);
    vec3  N = normalize(vNormalW);
    float ndv = clamp(abs(dot(N, normalize(vViewDir))), 0.0, 1.0);
    float fres = pow(1.0 - ndv, uFresnel) * uFresnelGain;

    /* ---- blood running down the wall ---- */
    vec3 sp = vec3(vWorld.xz * uFlowScale,
                   vWorld.y * uFlowScale * uFlowStretch + uTime * uFlowSpeed + uSeed * 5.0);
    float warp = fbm3(sp * 0.55) * uWarp;
    float fil = ridged(sp + warp, 4);
    float flow = smoothstep(mix(0.48, 0.86, uFlowSharp), 1.0, fil) * uFlowGain;

    /* ---- the membrane's cells ---- */
    // Two projections blended by the normal: an angular lookup would put a seam
    // down the back of the ward, and this is a closed surface.
    float cx = voronoi2(vec2(vWorld.z, vWorld.y) * uCellScale + uSeed).x;
    float cz = voronoi2(vec2(vWorld.x, vWorld.y) * uCellScale + uSeed * 3.1).x;
    vec3 nAbs = abs(N);
    float blend = nAbs.x / (nAbs.x + nAbs.z + 1e-4);
    float cellDist = mix(cz, cx, blend);
    float cells = (1.0 - smoothstep(0.0, 0.16, cellDist)) * uCells;

    /* ---- pressure rings climbing the wall ---- */
    float band = 0.5 + 0.5 * cos((up * uBands - uTime * uBandSpeed) * TAU);
    band = pow(band, mix(16.0, 2.0, clamp(uBandWidth, 0.0, 1.0)));

    /* ---- the two hot hoops ---- */
    float rimTop = smoothstep(1.0 - uRimTop, 1.0, up);
    float rimBase = smoothstep(uRimBase, 0.0, up);
    float edge = smoothstep(1.0 - uRimTop * 0.22, 1.0, up);
    float rims = (rimTop * rimTop + rimBase * rimBase + edge * 1.4) * uRimGlow;

    // While the ward is still closing, the leading edge of the wall runs hot.
    rims += rimTop * uCrest * (1.0 - uRise);

    /* ---- the beat ---- */
    float beat = 1.0 + uBeat;

    /* ---- coming apart ---- */
    // Burns from the rim down, eaten into by the same noise that drives the
    // runs, so the wall tears rather than dimming.
    float grain = fbm3(vec3(vWorld.xz * 1.1, vWorld.y * 0.7 + uSeed * 3.0)) * 0.5 + 0.5;
    float keep = clamp(1.0 - (up * 0.72 + grain * 0.42) / 1.14, 0.0, 1.0);
    vec2 dis = dissolveMask(keep, uDissolve, uDissolveEdge);

    /* ---- put it together ---- */
    float membrane = uDensity * (0.42 + flow * 0.85 + cells * 0.7 + band * 0.35) * beat;
    float light = (fres + rims * 0.55) * beat;

    float alpha = (membrane + light * 0.55) * uFade * uOpacity * dis.x;
    // Pinched off right at the floor so the wall does not end on a hard line.
    alpha *= smoothstep(0.0, 0.035, up);
    if (alpha < 0.004) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    vec3 color = mix(uColorMembrane, uColorFlow, clamp(flow * 1.3 + cells * 0.5, 0.0, 1.0));
    #if WARD_PASS == 0
      // The far wall is seen *through* the near one and through whatever is
      // standing between them, so it is pushed deep and dark: it reads as the
      // inside of the volume rather than as a second, brighter shell.
      color = mix(uColorDeep, color, 0.55);
    #endif
    color = mix(color, uColorRim, clamp(rims * 0.5 + fres * 0.45, 0.0, 1.0));
    color += uColorRim * dis.y * 3.0;
    color *= uGlow * uGlobalGlow * beat;

    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * One wall of the membrane.
 *
 * @param {number} pass WardPass.INNER (back faces) or WardPass.OUTER (front)
 */
export function createWardBarrierMaterial(pass = WardPass.OUTER) {
  const inner = pass === WardPass.INNER;

  const material = new ShaderMaterial({
    defines: { WARD_PASS: pass },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: inner ? BackSide : FrontSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uBulge: { value: 0.13 },
      uFlare: { value: 0.05 },
      uThrob: { value: 0 },
      uWobble: { value: 0.05 },
      uSwirl: { value: 0.5 },
      uSpin: { value: 0.05 },
      uDensity: { value: 0.3 },
      uFresnel: { value: 1.7 },
      uFresnelGain: { value: 1.55 },
      uRimTop: { value: 0.075 },
      uRimBase: { value: 0.055 },
      uRimGlow: { value: 2.9 },
      uFlowScale: { value: 1.15 },
      uFlowStretch: { value: 0.34 },
      uFlowSpeed: { value: 0.5 },
      uFlowSharp: { value: 0.55 },
      uFlowGain: { value: 1.35 },
      uWarp: { value: 0.45 },
      uCells: { value: 0.5 },
      uCellScale: { value: 1.6 },
      uBands: { value: 2.6 },
      uBandSpeed: { value: 0.4 },
      uBandWidth: { value: 0.14 },
      uCrest: { value: 2.1 },
      uRise: { value: 1 },
      uDissolve: { value: 0 },
      uDissolveEdge: { value: 0.2 },
      uBeat: { value: 0 },
      uSoftFade: { value: 0.55 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 1.45 },
      uColorMembrane: { value: new Color(0.55, 0.06, 0.09) },
      uColorFlow: { value: new Color(1, 0.17, 0.1) },
      uColorRim: { value: new Color(1, 0.73, 0.57) },
      uColorDeep: { value: new Color(0.2, 0.02, 0.04) }
    }),
    vertexShader: BARRIER_VERTEX,
    fragmentShader: BARRIER_FRAGMENT
  });

  /**
   * @param {object} state { rise, dissolve, beat, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.ward;
    const g = settings.global;
    const u = material.uniforms;

    u.uRise.value = state.rise;
    u.uDissolve.value = state.dissolve;
    u.uBeat.value = state.beat * c.beatDepth;
    u.uThrob.value = state.beat * c.throb;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uBulge.value = c.bulge;
    u.uFlare.value = c.flare;
    u.uWobble.value = c.bulge * 0.4 * g.noiseStrength;
    u.uSwirl.value = c.swirl;
    u.uSpin.value = c.spin;

    u.uDensity.value = (inner ? c.innerDensity : c.density) * (inner ? c.innerGain : 1);
    u.uFresnel.value = c.fresnel;
    // The far wall barely rims: a bright fresnel on both shells doubles every
    // silhouette edge and the ward reads as two cylinders, not one volume.
    u.uFresnelGain.value = c.fresnelGain * (inner ? 0.35 : 1) * g.fresnel;
    u.uRimTop.value = c.rimTop;
    u.uRimBase.value = c.rimBase;
    u.uRimGlow.value = c.rimGlow * (inner ? 0.6 : 1);

    u.uFlowScale.value = c.flowScale * g.noiseFrequency;
    u.uFlowStretch.value = c.flowStretch;
    u.uFlowSpeed.value = c.flowSpeed * g.noiseSpeed;
    u.uFlowSharp.value = c.flowSharp;
    u.uFlowGain.value = c.flowGain * g.shaderIntensity;
    u.uWarp.value = c.warp * g.noiseStrength;
    u.uCells.value = c.cells;
    u.uCellScale.value = c.cellScale * g.noiseFrequency;
    u.uBands.value = c.bands;
    u.uBandSpeed.value = c.bandSpeed * g.noiseSpeed;
    u.uBandWidth.value = c.bandWidth;
    u.uCrest.value = c.crest;
    u.uDissolveEdge.value = c.dissolveEdge;
    u.uSoftFade.value = c.softFade;
    u.uOpacity.value = c.opacity * g.opacity;
    u.uGlow.value = c.barrierGlow * g.glow;

    u.uColorMembrane.value.copy(getColor(c.colorMembrane));
    u.uColorFlow.value.copy(getColor(c.colorFlow));
    u.uColorRim.value.copy(getColor(c.colorRim));
    u.uColorDeep.value.copy(getColor(c.colorDeep));
  };

  return material;
}

/* ==================================================================== */
/* The rune bands                                                        */
/* ==================================================================== */

const RUNE_VERTEX = /* glsl */ `
  varying vec2  vUv;
  varying float vViewZ;

  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * A ring of glyphs, generated rather than drawn.
 *
 * Every cell around the band hashes its own subset out of a fixed alphabet of
 * nine strokes — two verticals a side, three horizontals, two diagonals — which
 * is enough of a grammar that the ring carries a genuinely non-repeating script:
 * no two glyphs on the ward are the same, changing `runes` re-cuts every one of
 * them, and there is not a texture anywhere in it.
 *
 * On top of the glyphs: a read head sweeping around the ring, a per-glyph
 * stutter so individual marks blink, and a soft halo under every stroke, because
 * with this project's bloom threshold a hairline stroke would otherwise have no
 * bleed at all.
 */
const RUNE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uCount;
  uniform float uAspect;
  uniform float uWeight;
  uniform float uStrokes;
  uniform float uSpin;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uSweepWidth;
  uniform float uFlicker;
  uniform float uHalo;
  uniform float uGlow;
  uniform float uBeat;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorRune;
  uniform vec3  uColorCore;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vUv;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  /** Distance from p to the segment ab. */
  float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    return length(pa - ba * h);
  }

  // A stroke is kept when its own hash falls under the density. The pair of
  // glyph index and stroke index is what makes the alphabet deterministic.
  #define STROKE(i, ax, ay, bx, by) \
    if (hash11(id * 13.7 + float(i) * 3.17 + uSeed * 1.7) < uStrokes) \
      d = min(d, segDist(q, vec2(ax, ay), vec2(bx, by)));

  void main() {
    float around = fract(vUv.x + uTime * uSpin);
    float across = clamp(vUv.y, 0.0, 1.0);

    float cell = around * uCount;
    float id = floor(cell);
    // Cell space, corrected so a glyph is not stretched when the ring is wide
    // and the band is shallow.
    vec2 q = vec2((fract(cell) - 0.5) * uAspect, across - 0.5);

    float d = 8.0;
    STROKE(0, -0.17,  0.30, -0.17,  0.00)
    STROKE(1, -0.17,  0.00, -0.17, -0.30)
    STROKE(2,  0.17,  0.30,  0.17,  0.00)
    STROKE(3,  0.17,  0.00,  0.17, -0.30)
    STROKE(4, -0.17,  0.30,  0.17,  0.30)
    STROKE(5, -0.17,  0.00,  0.17,  0.00)
    STROKE(6, -0.17, -0.30,  0.17, -0.30)
    STROKE(7, -0.17,  0.30,  0.17, -0.30)
    STROKE(8, -0.17, -0.30,  0.17,  0.30)
    // Every glyph keeps one stroke whatever the dice say, so the ring never
    // develops gaps that read as a broken band.
    float pick = floor(hash11(id * 7.91 + uSeed) * 3.0);
    if (pick < 1.0)      d = min(d, segDist(q, vec2(-0.17, 0.30), vec2(-0.17, -0.30)));
    else if (pick < 2.0) d = min(d, segDist(q, vec2( 0.17, 0.30), vec2( 0.17, -0.30)));
    else                 d = min(d, segDist(q, vec2(-0.17, 0.00), vec2( 0.17,  0.00)));

    float core = 1.0 - smoothstep(uWeight * 0.45, uWeight, d);
    float body = 1.0 - smoothstep(uWeight, uWeight * 2.1, d);
    float halo = (1.0 - smoothstep(uWeight, uWeight + 0.16, d)) * uHalo;

    /* ---- the read head running round the ring ---- */
    float head = fract(uTime * uSweepSpeed);
    float delta = abs(fract(around - head + 0.5) - 0.5);
    float sweep = smoothstep(uSweepWidth, 0.0, delta) * uSweep;

    /* ---- per-glyph stutter ---- */
    float step6 = floor(uTime * 6.0);
    float flick = 1.0 - uFlicker * hash11(id * 5.3 + step6 * 1.9 + uSeed);

    // The faint bar the glyphs sit on, so the band is a *band* between marks.
    float bar = (1.0 - smoothstep(0.34, 0.5, abs(q.y))) * 0.07;

    float beat = 1.0 + uBeat;
    float mask = (body + halo * 0.6 + bar) * flick * (1.0 + sweep) * beat;
    float alpha = clamp(mask, 0.0, 1.0) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, 0.35);
    if (alpha < 0.004) discard;

    vec3 color = uColorRune * (body + halo * 0.5 + bar) + uColorCore * core * (1.4 + sweep * 2.0);
    color *= uGlow * uGlobalGlow * flick * beat;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One band of runes. Two of these are built per ward — one seated at the foot of
 * the membrane, one at its rim — sharing this material, because the only thing
 * that differs between them is where the mesh is put and how bright it is.
 */
export function createWardRuneMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCount: { value: 30 },
      uAspect: { value: 1 },
      uWeight: { value: 0.055 },
      uStrokes: { value: 0.55 },
      uSpin: { value: 0.03 },
      uSweep: { value: 0.7 },
      uSweepSpeed: { value: 0.2 },
      uSweepWidth: { value: 0.09 },
      uFlicker: { value: 0.3 },
      uHalo: { value: 0.6 },
      uGlow: { value: 3.0 },
      uBeat: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorRune: { value: new Color(1, 0.23, 0.09) },
      uColorCore: { value: new Color(1, 0.86, 0.68) }
    }),
    vertexShader: RUNE_VERTEX,
    fragmentShader: RUNE_FRAGMENT
  });

  /**
   * @param {object} state { radius, gain, beat, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.ward;
    const g = settings.global;
    const u = material.uniforms;
    const gain = state.gain ?? 1;

    const count = Math.max(1, Math.round(c.runes));
    u.uCount.value = count;
    // One cell is (circumference / count) wide and `runeSize` tall. Feeding that
    // ratio in is what keeps a glyph square when either slider moves.
    u.uAspect.value = Math.max(0.05, (TAU * state.radius) / count / Math.max(0.02, c.runeSize));
    u.uWeight.value = c.runeWeight;
    u.uStrokes.value = c.runeStrokes;
    u.uSpin.value = c.runeSpin;
    u.uSweep.value = c.runeSweep;
    u.uSweepSpeed.value = c.runeSweepSpeed;
    u.uSweepWidth.value = c.runeSweepWidth;
    u.uFlicker.value = c.runeFlicker * g.randomness;
    u.uHalo.value = c.runeHalo;
    u.uGlow.value = c.runeGlow * gain * g.glow;
    u.uBeat.value = state.beat * c.beatDepth;
    u.uSeed.value = state.seed;
    u.uFade.value = state.fade;
    u.uOpacity.value = gain * g.opacity;
    u.uColorRune.value.copy(getColor(c.colorRune));
    u.uColorCore.value.copy(getColor(c.colorRuneCore));
  };

  return material;
}

/* ==================================================================== */
/* The core flare                                                        */
/* ==================================================================== */

/**
 * A camera-facing quad, built in the vertex stage so the flare never turns with
 * the ward and never foreshortens: the model matrix supplies the position and
 * the offset is applied in *view* space.
 */
const FLARE_VERTEX = /* glsl */ `
  uniform float uSize;

  varying vec2  vP;
  varying float vViewZ;

  void main() {
    vP = position.xy * 2.0;

    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uSize;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The optical half of the effect: what a camera does when something this bright
 * is standing in the middle of the ward.
 *
 * Core, anamorphic streak, starburst, two ghosts and the shockwave the seal
 * throws — every one of them an analytic falloff rather than a sprite, so the
 * flare is resolution independent and the sliders reshape it live.
 */
const FLARE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uCore;
  uniform float uStreak;
  uniform float uStreakWidth;
  uniform float uSpikes;
  uniform float uSpikeGain;
  uniform float uSpikeSharp;
  uniform float uGhosts;
  uniform float uSpin;
  uniform float uShock;       // 0..1 — the ring's progress, <0 while it is idle
  uniform float uShockWidth;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorStreak;
  uniform vec3  uColorGhost;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vP;
  varying float vViewZ;

  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    vec2 p = vP;
    float r = length(p);

    /* ---- the source ---- */
    float core = 1.0 / (1.0 + r * r * 42.0);
    core = core * core * uCore;

    /* ---- the anamorphic streak ---- */
    float streak = exp(-abs(p.x) / max(uStreak * 0.35, 1e-3))
                 * exp(-abs(p.y) / max(uStreakWidth, 1e-3));

    /* ---- the starburst ---- */
    float ang = atan(p.y, p.x) + uTime * uSpin * TAU;
    float spikes = pow(abs(cos(ang * uSpikes * 0.5)), uSpikeSharp) * exp(-r * 2.6) * uSpikeGain;

    /* ---- ghosts along the axis ---- */
    float g1 = exp(-pow((r - 0.42) * 9.0, 2.0));
    float g2 = exp(-pow((r - 0.68) * 14.0, 2.0)) * 0.6;
    float ghosts = (g1 + g2) * uGhosts;

    /* ---- the ring the seal throws ---- */
    float shock = 0.0;
    if (uShock >= 0.0) {
      float radius = pow(clamp(uShock, 0.0, 1.0), 0.55);
      shock = smoothstep(uShockWidth, 0.0, abs(r - radius)) * (1.0 - clamp(uShock, 0.0, 1.0));
    }

    float mask = core + streak * 0.9 + spikes + ghosts * 0.5 + shock * 1.2;
    float alpha = clamp(mask, 0.0, 1.0) * uOpacity;
    if (alpha < 0.003) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    // A generous fade distance: a lens flare should die *near* the geometry it
    // is standing behind, not clip against it.
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, 1.1);
    if (alpha < 0.003) discard;

    vec3 color = uColorCore * (core + shock * 0.8)
               + uColorStreak * (streak + spikes * 0.85)
               + uColorGhost * ghosts;
    color *= uIntensity * uGlobalGlow;

    gl_FragColor = vec4(color, alpha);
  }
`;

export function createWardFlareMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSize: { value: 3.6 },
      uCore: { value: 1.7 },
      uStreak: { value: 1.6 },
      uStreakWidth: { value: 0.045 },
      uSpikes: { value: 6 },
      uSpikeGain: { value: 0.85 },
      uSpikeSharp: { value: 22 },
      uGhosts: { value: 0.4 },
      uSpin: { value: 0.035 },
      uShock: { value: -1 },
      uShockWidth: { value: 0.055 },
      uIntensity: { value: 1 },
      uOpacity: { value: 1 },
      uColorCore: { value: new Color(1, 0.95, 0.86) },
      uColorStreak: { value: new Color(1, 0.36, 0.13) },
      uColorGhost: { value: new Color(0.56, 0.06, 0.07) }
    }),
    vertexShader: FLARE_VERTEX,
    fragmentShader: FLARE_FRAGMENT
  });

  /**
   * @param {object} state { size, intensity, shock, fade }
   */
  material.userData.sync = (state) => {
    const c = settings.ward;
    const g = settings.global;
    const u = material.uniforms;

    u.uSize.value = state.size;
    u.uIntensity.value = state.intensity * g.glow;
    u.uShock.value = state.shock;
    u.uOpacity.value = state.fade * c.flareOpacity * g.opacity;

    u.uCore.value = c.flareCore;
    u.uStreak.value = c.flareStreak;
    u.uStreakWidth.value = c.flareStreakWidth;
    u.uSpikes.value = Math.max(2, Math.round(c.flareSpikes));
    u.uSpikeGain.value = c.flareSpikeGain;
    u.uSpikeSharp.value = c.flareSpikeSharp;
    u.uGhosts.value = c.flareGhosts;
    u.uSpin.value = c.flareSpin;
    u.uShockWidth.value = c.shockWidth;
    u.uColorCore.value.copy(getColor(c.colorFlareCore));
    u.uColorStreak.value.copy(getColor(c.colorFlareStreak));
    u.uColorGhost.value.copy(getColor(c.colorFlareGhost));
  };

  return material;
}

/* ==================================================================== */
/* Heat coming off the floor                                             */
/* ==================================================================== */

/**
 * Writes screen-space refraction offsets instead of colour — the mesh lives on
 * `LAYER.DISTORTION`, is invisible to the main pass, and the composite warps the
 * frame by whatever this leaves in the buffer:
 *
 *   R,G → offset encoded around 0.5   B → strength   A → coverage
 *
 * Camera-facing like the flare, because a flat proxy edge-on writes nothing and
 * the shimmer would vanish as the camera orbits.
 */
const HAZE_VERTEX = /* glsl */ `
  uniform float uWidth;
  uniform float uHeight;

  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    vUv = uv;

    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * vec2(uWidth, uHeight);
    // World position for the noise, so the shimmer is welded to the floor and
    // does not slide when the camera moves.
    vWorld = (modelMatrix * vec4(position.x * uWidth, position.y * uHeight, 0.0, 1.0)).xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const HAZE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uFalloff;
  uniform float uSeed;
  uniform float uShaderIntensity;

  varying vec2 vUv;
  varying vec3 vWorld;

  ${noiseGLSL}

  void main() {
    // Heat rises: the field scrolls up, and is stretched vertically so the
    // structures are columns rather than blobs.
    vec3 np = vec3(vWorld.xz * uScale, vWorld.y * uScale * 0.45 - uTime * uSpeed + uSeed);
    float nx = snoise(np);
    float ny = snoise(np + vec3(19.3, 7.7, 31.1));

    vec2 c = (vUv - 0.5) * 2.0;
    // Strongest just off the floor and thinning with height, feathered at both
    // sides so the warp never shows a border.
    float mask = (1.0 - smoothstep(0.25, 1.0, abs(c.x)))
               * (1.0 - smoothstep(0.0, 1.0, pow(clamp(vUv.y, 0.0, 1.0), 1.0 / max(uFalloff, 0.05))));
    mask *= smoothstep(0.0, 0.08, vUv.y);

    float strength = uStrength * uShaderIntensity * mask;
    if (strength < 0.002) discard;

    gl_FragColor = vec4(vec2(nx, ny) * 0.5 + 0.5, strength, mask);
  }
`;

export function createWardHazeMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uWidth: { value: 8 },
      uHeight: { value: 5 },
      uStrength: { value: 1 },
      uScale: { value: 2.2 },
      uSpeed: { value: 1.4 },
      uFalloff: { value: 1.3 },
      uSeed: { value: 0 }
    }),
    vertexShader: HAZE_VERTEX,
    fragmentShader: HAZE_FRAGMENT
  });

  /**
   * @param {object} state { width, height, strength, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.ward;
    const g = settings.global;
    const u = material.uniforms;

    u.uWidth.value = state.width;
    u.uHeight.value = state.height;
    u.uStrength.value = state.strength * c.hazeStrength * g.distortion;
    u.uScale.value = c.hazeScale * g.noiseFrequency;
    u.uSpeed.value = c.hazeSpeed * g.noiseSpeed;
    u.uFalloff.value = c.hazeFalloff;
    u.uSeed.value = state.seed;
  };

  return material;
}
