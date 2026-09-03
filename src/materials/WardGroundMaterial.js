import { ShaderMaterial, NormalBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The floor the Volcanic Horror Ward stands on: stone shattered into plates with
 * the melt still running between them.
 *
 * Two decisions carry the whole thing.
 *
 * **It is a real voronoi *edge* field, not a threshold on a distance.** The
 * seams are the boundaries between neighbouring cells — the second loop below
 * measures the distance to the bisector of every neighbour — which is what
 * shattered stone actually is. Thresholding `voronoi2().x` instead gives round
 * blobs with gaps between them, which reads as cracked mud.
 *
 * **It is alpha blended, not additive.** Every other ground shader in this
 * project glows onto the floor; this one has to *replace* it with black basalt,
 * and additive blending cannot darken anything. That is also why the plates are
 * lit here rather than left flat: a world-space gradient of the plate height
 * field is taken with screen derivatives and dotted against the same sun
 * direction the lit meshes use, so the crust has relief instead of being a
 * pattern painted on the floor.
 *
 * The network is drawn in **metres from the centre of the ward**, so `zoneRadius`
 * re-scales the fracture live and the seams stay the same physical width when it
 * moves — a quad-space field would stretch every crack as the footprint grew.
 */

const GROUND_VERTEX = /* glsl */ `
  varying vec2  vUv;
  varying float vViewZ;

  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const GROUND_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uGrown;      // how far the fracture has raced out, metres
  uniform float uFront;      // brightness of the leading edge, 0 once it lands
  uniform float uPlates;
  uniform float uRadial;
  uniform float uWarp;
  uniform float uSeam;
  uniform float uSeamGlow;
  uniform float uCrust;
  uniform float uRelief;
  uniform float uHeat;
  uniform float uHeatFalloff;
  uniform float uFlow;
  uniform float uEmber;
  uniform float uEmberScale;
  uniform float uBoundary;
  uniform float uBoundaryGlow;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uRings;
  uniform float uRingSpeed;
  uniform float uBeat;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorCrust;
  uniform vec3  uColorPlate;
  uniform vec3  uColorMagma;
  uniform vec3  uColorHot;
  uniform vec3  uColorEdge;

  uniform vec3  uLightDir;
  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  /**
   * Two-nearest voronoi.
   *
   * Returns x = distance to the nearest cell *edge* (0 on a seam, growing into
   * the plate) and y = a hash of the winning cell, used to give every plate its
   * own value. The second loop is the part that matters: it walks the winner's
   * neighbours and measures the distance to each bisector, which is the standard
   * construction for a crack network and the reason these seams fork and meet at
   * proper junctions instead of ending in mid-air.
   */
  vec2 voronoiCrack(vec2 p) {
    vec2 n = floor(p);
    vec2 f = fract(p);

    vec2 mg = vec2(0.0);
    vec2 mr = vec2(0.0);
    float md = 8.0;
    float id = 0.0;

    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < md) {
          md = d;
          mr = r;
          mg = g;
          id = hash11(dot(n + g, vec2(31.7, 57.1)));
        }
      }
    }

    float edge = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = mg + vec2(float(i), float(j));
        vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
        vec2 r = g + o - f;
        vec2 diff = r - mr;
        float dd = dot(diff, diff);
        if (dd > 1e-5) edge = min(edge, dot(0.5 * (mr + r), normalize(diff)));
      }
    }

    return vec2(edge, id);
  }

  void main() {
    // Metres from the centre of the ward. Everything below is in metres, so the
    // seams keep their physical width when the footprint is re-scaled.
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float rad = length(p);
    float ang = atan(p.y, p.x);

    float aa = fwidth(rad) + 0.02;
    float outer = uRadius + uBoundary * 0.5;
    if (rad > outer + aa * 6.0) discard;

    /* ---- the plates ---- */
    // Domain warped so the cells are not a jittered grid you can read.
    vec2 warp = vec2(fbm3(vec3(p * 0.55, uSeed)), fbm3(vec3(p * 0.55, uSeed + 19.7))) * uWarp;
    vec2 cellA = voronoiCrack((p + warp) * uPlates);

    // A second network in log-polar space: cells that are wedges near the middle
    // and grow outward, which is how stone fractures around an impact. Crossed
    // with the plates rather than blended, so uRadial adds shattering instead
    // of averaging two distance fields into mush.
    float spokes = max(4.0, uPlates * uRadius * 1.7);
    float rings = max(2.0, uPlates * 2.4);
    vec2 cellB = voronoiCrack(vec2(ang / TAU * spokes, log(rad + 0.6) * rings));

    float crackA = 1.0 - smoothstep(0.0, uSeam, cellA.x);
    float crackB = 1.0 - smoothstep(0.0, uSeam * 1.15, cellB.x);
    float crack = max(crackA, crackB * uRadial);

    // The much wider charred band either side of a seam. A crack is a shadow
    // first and a light second; without this the glow sits on top of the stone.
    float lip = max(1.0 - smoothstep(uSeam, uSeam * 3.2, cellA.x),
                    (1.0 - smoothstep(uSeam, uSeam * 3.2, cellB.x)) * uRadial);

    /* ---- relief ---- */
    // A height field for the crust: plates stand proud, seams are sunk, with a
    // grain over the top. Its gradient is taken in *world* space (screen
    // derivatives of p invert the pixel footprint), so the lighting is correct
    // however the camera is angled.
    float grain = fbm3(vec3(p * 3.1, uSeed * 5.0)) * 0.5 + 0.5;
    float height = smoothstep(0.0, uSeam * 3.0, cellA.x) * 0.75 + grain * 0.25;

    vec2 dpx = dFdx(p);
    vec2 dpy = dFdy(p);
    float det = dpx.x * dpy.y - dpx.y * dpy.x;
    vec2 grad = vec2(0.0);
    if (abs(det) > 1e-9) {
      float hx = dFdx(height);
      float hy = dFdy(height);
      grad = vec2(hx * dpy.y - hy * dpx.y, -hx * dpy.x + hy * dpx.x) / det;
    }
    vec3 N = normalize(vec3(-grad.x * uRelief, 1.0, -grad.y * uRelief));
    float lambert = clamp(dot(N, normalize(uLightDir)), 0.0, 1.0);

    /* ---- how hot it still is ---- */
    float beat = 1.0 + uBeat;
    float radial = clamp(rad / max(uRadius, 0.05), 0.0, 1.0);
    float heat = uHeat * pow(1.0 - radial, uHeatFalloff);
    // The melt is not static: brightness pumps along the inside of every seam.
    float pump = 0.55 + 0.45 * (snoise(vec3(p * 1.5, uTime * uFlow + uSeed * 3.0)) * 0.5 + 0.5);
    heat *= pump * beat;

    // Flecks glimmering in the seams — the ember bed, not particles.
    float fleck = pow(snoise01(vec3(p * uEmberScale, uSeed * 7.0 + uTime * 0.9)), 7.0) * uEmber;
    fleck *= lip;

    /* ---- the fracture racing out to the boundary ---- */
    float open = smoothstep(uGrown + 0.2, uGrown - 0.4, rad);
    float front = smoothstep(0.5, 0.0, abs(rad - uGrown)) * uFront;

    /* ---- the furniture: boundary band, centre pool, pressure rings ---- */
    float inner = max(0.01, uRadius - uBoundary * 0.5);
    float band = smoothstep(outer + aa, outer - aa, rad) * smoothstep(inner - aa, inner + aa, rad);
    float pool = smoothstep(uCoreSize * uRadius, 0.0, rad) * uCore;
    float ring = pow(0.5 + 0.5 * cos((radial * uRings - uTime * uRingSpeed) * TAU), 8.0);
    ring *= smoothstep(uRadius, uRadius * 0.2, rad) * 0.35;

    /* ---- put it together ---- */
    // The crust: dark basalt, every plate a slightly different value, charred
    // around the seams and lit by the stage's own key direction.
    vec3 crust = mix(uColorCrust, uColorPlate, cellA.y * 0.85 + grain * 0.15);
    crust *= mix(0.45, 1.25, lambert);
    crust = mix(crust, uColorCrust * 0.5, lip * 0.55);

    float meltMask = clamp(crack * 0.95 + fleck + front * 0.8, 0.0, 1.0);
    vec3 melt = mix(uColorMagma, uColorHot, clamp(heat * 0.55 + front, 0.0, 1.0));

    vec3 color = crust * (1.0 - meltMask);
    color += melt * meltMask * (heat + front * 1.6) * uSeamGlow;
    // Warm bounce onto the stone either side of a seam: what a metre of glowing
    // rock actually does to the basalt beside it.
    color += uColorMagma * lip * heat * 0.32;
    color += uColorEdge * (band * uBoundaryGlow + pool * beat + ring) * 0.9;

    float alpha = uCrust * (1.0 - meltMask * 0.4) + meltMask + band * 0.9 + pool * 0.5;
    alpha = clamp(alpha, 0.0, 1.0) * open * uFade * uOpacity;
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The shattered floor. One quad, re-sized and re-shaded from `settings.ward`
 * every frame — an ability-owned mesh rather than a pooled decal because a decal
 * captures its radius when it spawns, and this one has to re-scale under
 * `zoneRadius` while the ward is still standing.
 */
export function createWardGroundMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 12 },
      uRadius: { value: 5 },
      uGrown: { value: 0 },
      uFront: { value: 0 },
      uPlates: { value: 1.5 },
      uRadial: { value: 0.6 },
      uWarp: { value: 0.4 },
      uSeam: { value: 0.075 },
      uSeamGlow: { value: 3.4 },
      uCrust: { value: 0.94 },
      uRelief: { value: 0.7 },
      uHeat: { value: 1.2 },
      uHeatFalloff: { value: 1.5 },
      uFlow: { value: 0.45 },
      uEmber: { value: 0.7 },
      uEmberScale: { value: 4.5 },
      uBoundary: { value: 0.18 },
      uBoundaryGlow: { value: 2.4 },
      uCore: { value: 1.5 },
      uCoreSize: { value: 0.3 },
      uRings: { value: 1.4 },
      uRingSpeed: { value: 0.5 },
      uBeat: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorCrust: { value: new Color(0.04, 0.03, 0.03) },
      uColorPlate: { value: new Color(0.11, 0.07, 0.08) },
      uColorMagma: { value: new Color(1, 0.29, 0.07) },
      uColorHot: { value: new Color(1, 0.85, 0.63) },
      uColorEdge: { value: new Color(1, 0.16, 0.08) }
    }),
    vertexShader: GROUND_VERTEX,
    fragmentShader: GROUND_FRAGMENT
  });

  /**
   * @param {object} state { radius, quadSize, grown, front, cool, beat, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.ward;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uGrown.value = state.grown;
    u.uFront.value = state.front;
    u.uBeat.value = state.beat * c.beatDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uPlates.value = c.fieldPlates * g.noiseFrequency;
    u.uRadial.value = c.fieldRadial;
    u.uWarp.value = c.fieldWarp * g.noiseStrength;
    u.uSeam.value = c.fieldSeam;
    u.uSeamGlow.value = c.fieldSeamGlow * g.shaderIntensity;
    u.uCrust.value = c.fieldCrust;
    u.uRelief.value = c.fieldRelief;
    // `cool` runs 1 → (1 - fieldCool) over the ward's life: the melt sets long
    // before the crust goes anywhere.
    u.uHeat.value = c.fieldHeat * state.cool * g.shaderIntensity;
    u.uHeatFalloff.value = c.fieldHeatFalloff;
    u.uFlow.value = c.fieldFlow * g.noiseSpeed;
    u.uEmber.value = c.fieldEmber;
    u.uEmberScale.value = c.fieldEmberScale * g.noiseFrequency;
    u.uBoundary.value = c.fieldBoundary;
    u.uBoundaryGlow.value = c.fieldBoundaryGlow;
    u.uCore.value = c.fieldCore * state.cool;
    u.uCoreSize.value = c.fieldCoreSize;
    u.uRings.value = c.fieldRings;
    u.uRingSpeed.value = c.fieldRingSpeed;
    u.uOpacity.value = c.fieldOpacity * g.opacity;

    u.uColorCrust.value.copy(getColor(c.colorCrust));
    u.uColorPlate.value.copy(getColor(c.colorPlate));
    u.uColorMagma.value.copy(getColor(c.colorMagma));
    u.uColorHot.value.copy(getColor(c.colorMagmaHot));
    u.uColorEdge.value.copy(getColor(c.colorFieldEdge));
  };

  return material;
}
