import { ShaderMaterial, NormalBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The floor under the Caustic Bloom: stone with acid standing in it.
 *
 * Three decisions carry it, and they are all about the difference between a
 * *pool* and a green light on the floor.
 *
 * **It is alpha blended, not additive.** The acid has to eat the floor — darken
 * the stone, sink the crazing into it, sit *wet* on top of it. Additive blending
 * can only ever add, so an additive pool is a decal that glows and the granite
 * shows straight through it. That is also why the crust is lit here: a height
 * field is differentiated in world space with screen derivatives and dotted
 * against the same key direction the lit meshes use, so the etched plates have
 * relief instead of being a pattern painted on the ground.
 *
 * **The surface is glossy.** Everything else on this stage is rough, and a
 * specular lobe — one Blinn highlight off that same fake normal, plus a broad
 * sheen — is the cheapest thing that says *liquid*. Take it out and the pool
 * immediately reads as scorched rock that happens to be green.
 *
 * **The boundary is corroded, not circular.** The outline is pushed around by a
 * low-frequency noise on the bearing and bitten into by a higher one, so the
 * pool has bays and headlands. A clean disc reads as a decal no matter what is
 * drawn inside it.
 *
 * On top of that sits the thing the reference sheet is actually about: gas
 * coming *out* of it. `surfaceBoil` gives every cell of a jittered grid its own
 * clock and draws the expanding rim of one bubble breaking the surface — so the
 * floor pops continuously, in place, without a single particle.
 *
 * Everything is drawn in **metres from the centre of the bloom**, so `zoneRadius`
 * re-scales the pool live and the crazing keeps its physical width when the
 * footprint moves.
 */

const POOL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vViewDir = cameraPosition - world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const POOL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uGrown;       // how far the corrosion has spread, metres
  uniform float uFront;       // brightness of the leading edge, 0 once it lands
  uniform float uPlates;
  uniform float uCraze;
  uniform float uWarp;
  uniform float uSeam;
  uniform float uSeamGlow;
  uniform float uCrust;
  uniform float uRelief;
  uniform float uSheen;
  uniform float uGloss;
  uniform float uEtch;
  uniform float uEtchScale;
  uniform float uPits;
  uniform float uPitScale;
  uniform float uBoilRate;
  uniform float uHeat;
  uniform float uHeatFalloff;
  uniform float uFlow;
  uniform float uCaustic;
  uniform float uCausticScale;
  uniform float uBoundary;
  uniform float uBoundaryGlow;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uRings;
  uniform float uRingSpeed;
  uniform float uBoil;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorSludge;
  uniform vec3  uColorCrust;
  uniform vec3  uColorAcid;
  uniform vec3  uColorHot;
  uniform vec3  uColorEdge;

  uniform vec3  uLightDir;
  uniform float uGlobalGlow;

  varying vec2 vUv;
  varying vec3 vViewDir;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  /**
   * Two-nearest voronoi: x = distance to the nearest cell *edge*, y = a hash of
   * the winning cell.
   *
   * The second loop is the part that matters. It walks the winner's neighbours
   * and measures the distance to each bisector, which is the standard crack-
   * network construction and the reason these seams fork and meet at proper
   * junctions instead of ending in mid-air. Thresholding a plain distance field
   * gives round blobs with gaps between them — cracked mud, not etched stone.
   */
  vec2 voronoiEtch(vec2 p) {
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

  /**
   * Gas breaking the surface.
   *
   * A jittered grid where every cell keeps its own clock and its own size, and
   * draws the expanding rim of one bubble. Because the phase is a fract() of a
   * per-cell rate, the pool boils continuously without any two cells ever being
   * in step — which is what stops it reading as a looping texture. Nine cheap
   * hashes per pixel, and it replaces a particle system.
   *
   * @returns vec2(rim brightness, the dark crater under it)
   */
  vec2 surfaceBoil(vec2 p, float scale, float rate, float seed) {
    vec2 g = p * scale;
    vec2 n = floor(g);
    vec2 f = fract(g);

    float rim = 0.0;
    float crater = 0.0;

    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        float cell = dot(n + o, vec2(41.3, 289.1)) + seed;
        float id = hash11(cell);
        vec2 jitter = hash21(cell * 1.37);

        // Every cell runs at its own rate, so the grid never pulses together.
        float phase = fract(uTime * rate * (0.45 + id * 1.1) + id * 9.0);
        float size = 0.16 + id * 0.30;
        float r = phase * size;

        float d = length(o + jitter - f);
        float w = max(0.018, size * 0.22 * (1.0 - phase * 0.6));
        // A ring that opens, thins and goes out — one bubble, start to burst.
        float ring = smoothstep(w, 0.0, abs(d - r)) * (1.0 - phase) * (1.0 - phase);
        rim = max(rim, ring);
        crater = max(crater, smoothstep(r, r * 0.2, d) * (1.0 - phase) * 0.8);
      }
    }
    return vec2(rim, crater);
  }

  void main() {
    // Metres from the centre of the bloom. Everything below is in metres, so
    // the crazing keeps its physical width when the footprint is re-scaled.
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float rad = length(p);
    vec2 dir = rad > 1e-4 ? p / rad : vec2(1.0, 0.0);

    /* ---- the corroded boundary ---- */
    // Bays and headlands: one low frequency on the bearing for the shape of the
    // outline, one higher for the bite taken out of it. A clean disc reads as a
    // decal however good the interior is.
    float bearing = fbm3(vec3(dir * 1.9, uSeed)) * 0.5 + 0.5;
    float bite = snoise01(vec3(dir * 5.4, uSeed * 3.1 + uTime * 0.05));
    float outer = uRadius * (0.90 + bearing * 0.20 + bite * 0.06) + uBoundary * 0.5;

    float aa = fwidth(rad) + 0.02;
    if (rad > outer + aa * 6.0) discard;

    /* ---- how much detail this pixel can actually resolve ---- */
    // Metres of floor one pixel covers. Near the camera that is a centimetre;
    // out at the far rim, where the floor is nearly edge-on, it is tens of
    // centimetres — and every high-frequency term below (the fine crazing, the
    // caustics, the boiling rims, the specular off a derivative normal) then
    // samples a different part of its field in each neighbouring pixel and
    // sparkles into a band of white speckle lying across the pool.
    //
    // Fading those terms out as the footprint outgrows their features is what a
    // mip chain does for a texture, and it is the only thing that keeps a
    // procedural surface honest at a grazing angle.
    float footprint = max(fwidth(p.x), fwidth(p.y));
    float detail = 1.0 - smoothstep(0.02, 0.13, footprint);

    /* ---- the etched stone ---- */
    vec2 warp = vec2(fbm3(vec3(p * 0.6, uSeed)), fbm3(vec3(p * 0.6, uSeed + 23.1))) * uWarp;
    vec2 plate = voronoiEtch((p + warp) * uPlates);
    // A second, much finer network laid over the first. Acid does not shatter
    // stone into plates the way heat does — it *crazes* it, and the crazing is
    // what carries the read at close range.
    vec2 craze = voronoiEtch((p - warp * 0.4) * uPlates * 4.3 + 31.7);

    float seamA = 1.0 - smoothstep(0.0, uSeam, plate.x);
    float seamB = 1.0 - smoothstep(0.0, uSeam * 1.6, craze.x);
    float seam = max(seamA, seamB * uCraze * detail);

    // The wide bleached lip either side of a channel — where the acid has wicked
    // into the stone. A channel is a stain first and a light second.
    float lip = max(1.0 - smoothstep(uSeam, uSeam * 3.4, plate.x),
                    (1.0 - smoothstep(uSeam, uSeam * 3.0, craze.x)) * uCraze * 0.6 * detail);

    /* ---- pits eaten clean through ---- */
    // Where a cell's own hash beats the threshold the acid has taken the whole
    // plate out, leaving a hole with a bright rim of live acid around it.
    vec2 pitCell = voronoi2(p * uPitScale + uSeed * 5.0);
    float pitMask = step(1.0 - uPits, pitCell.y);
    float pit = pitMask * smoothstep(0.42, 0.16, pitCell.x);
    float pitRim = pitMask * smoothstep(0.10, 0.0, abs(pitCell.x - 0.34));

    /* ---- relief ---- */
    float grain = fbm3(vec3(p * 3.4, uSeed * 5.0)) * 0.5 + 0.5;
    // Plates stand proud, channels and pits are sunk, grain on top. The gradient
    // is taken in *world* space — screen derivatives of p invert the pixel
    // footprint — so the lighting is right however the camera is angled.
    float height = smoothstep(0.0, uSeam * 3.0, plate.x) * 0.7 + grain * 0.3 - pit * 0.55;

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
    vec3 L = normalize(uLightDir);
    float lambert = clamp(dot(N, L), 0.0, 1.0);

    /* ---- it is wet ---- */
    // One Blinn lobe plus a broad sheen. The cheapest thing on this stage that
    // says *liquid*; without it the pool is scorched rock that happens to be
    // green.
    vec3 V = normalize(vViewDir);
    vec3 H = normalize(L + V);
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), mix(8.0, 90.0, uGloss)) * uSheen;
    // The bleached lip either side of a channel is dry stone, not liquid, and a
    // tight lobe left running across it draws one continuous jagged highlight
    // over the whole pool — which at a low camera angle reads as a bolt lying on
    // the floor rather than as a wet surface.
    spec *= (1.0 - lip * 0.65) * detail;
    float sheen = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) * uSheen * 0.35;

    /* ---- how live the acid still is ---- */
    float surge = 1.0 + uBoil;
    float radial = clamp(rad / max(uRadius, 0.05), 0.0, 1.0);
    float heat = uHeat * pow(1.0 - radial, uHeatFalloff);
    // Not static: brightness crawls along the inside of every channel.
    float pump = 0.5 + 0.5 * (snoise(vec3(p * 1.7, uTime * uFlow + uSeed * 3.0)) * 0.5 + 0.5);
    heat *= pump * surge;

    // Caustics on the standing acid, drawn where the crust is *not* — the
    // interference pattern you get off a shallow disturbed liquid.
    vec2 cp = p * uCausticScale;
    float c1 = snoise(vec3(cp, uTime * 0.7 + uSeed));
    float c2 = snoise(vec3(cp * 1.43 + 11.0, -uTime * 0.53 + uSeed));
    float caustic = pow(clamp(1.0 - abs(c1 + c2) * 0.9, 0.0, 1.0), 6.0) * uCaustic * detail;

    /* ---- gas coming off it ---- */
    vec2 boil = surfaceBoil(p, uPitScale * 0.62, uBoilRate, uSeed * 11.0) * detail;

    /* ---- the corrosion racing out to the boundary ---- */
    float open = smoothstep(uGrown + 0.25, uGrown - 0.5, rad);
    // Eaten rather than wiped in: the growing edge is chewed by its own noise,
    // so the pool spreads the way a stain does.
    float chew = snoise01(vec3(p * uEtchScale, uSeed * 7.0)) * uEtch;
    open = clamp(open - chew * smoothstep(uGrown - 1.2, uGrown + 0.1, rad), 0.0, 1.0);
    float front = smoothstep(0.6, 0.0, abs(rad - uGrown)) * uFront;

    /* ---- the furniture: boundary band, centre pool, pressure rings ---- */
    float inner = max(0.01, outer - uBoundary);
    float band = smoothstep(outer + aa, outer - aa, rad) * smoothstep(inner - aa, inner + aa, rad);
    float pool = smoothstep(uCoreSize * uRadius, 0.0, rad) * uCore;
    float ring = pow(0.5 + 0.5 * cos((radial * uRings - uTime * uRingSpeed) * TAU), 8.0);
    ring *= smoothstep(uRadius, uRadius * 0.2, rad) * 0.35;

    /* ---- put it together ---- */
    // The crust: sludge, every plate a slightly different value, bleached around
    // the channels and lit by the stage's own key direction.
    vec3 crust = mix(uColorSludge, uColorCrust, plate.y * 0.8 + grain * 0.2);
    crust *= mix(0.42, 1.3, lambert);
    crust = mix(crust, uColorCrust * 1.4, lip * 0.4);
    crust = mix(crust, uColorSludge * 0.35, boil.y * 0.7);

    float acidMask = clamp(seam * 0.95 + pit * 0.85 + pitRim + front * 0.8 + boil.x * 0.9, 0.0, 1.0);
    vec3 acid = mix(uColorAcid, uColorHot, clamp(heat * 0.5 + front + boil.x * 0.5, 0.0, 1.0));

    vec3 color = crust * (1.0 - acidMask);
    color += acid * acidMask * (heat + front * 1.5) * uSeamGlow;
    // Bounce onto the stone either side of a channel: what a metre of glowing
    // liquid actually does to the rock beside it.
    color += uColorAcid * lip * heat * 0.3;
    color += uColorHot * caustic * heat * (1.0 - acidMask) * 0.8;
    color += uColorEdge * (band * uBoundaryGlow + pool * surge + ring) * 0.9;
    // Weighted to where there is actually standing acid to reflect off.
    color += (spec + sheen) * mix(uColorAcid, uColorHot, 0.55) * (0.12 + acidMask * 0.95);

    float alpha = uCrust * (1.0 - acidMask * 0.35) + acidMask + band * 0.9 + pool * 0.5;
    alpha = clamp(alpha, 0.0, 1.0) * open * uFade * uOpacity;
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The acid pool. One quad, re-sized and re-shaded from `settings.acid` every
 * frame — an ability-owned mesh rather than a pooled decal, because a decal
 * captures its radius when it spawns and this one has to re-scale under
 * `zoneRadius` while the bloom is still standing.
 */
export function createAcidPoolMaterial() {
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
      uPlates: { value: 0.9 },
      uCraze: { value: 0.55 },
      uWarp: { value: 0.45 },
      uSeam: { value: 0.07 },
      uSeamGlow: { value: 2.6 },
      uCrust: { value: 0.95 },
      uRelief: { value: 0.8 },
      uSheen: { value: 1.0 },
      uGloss: { value: 0.7 },
      uEtch: { value: 0.5 },
      uEtchScale: { value: 1.6 },
      uPits: { value: 0.3 },
      uPitScale: { value: 1.6 },
      uBoilRate: { value: 0.5 },
      uHeat: { value: 1.1 },
      uHeatFalloff: { value: 1.4 },
      uFlow: { value: 0.5 },
      uCaustic: { value: 0.8 },
      uCausticScale: { value: 2.2 },
      uBoundary: { value: 0.22 },
      uBoundaryGlow: { value: 2.2 },
      uCore: { value: 0.5 },
      uCoreSize: { value: 0.3 },
      uRings: { value: 1.3 },
      uRingSpeed: { value: 0.4 },
      uBoil: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorSludge: { value: new Color(0.04, 0.06, 0.02) },
      uColorCrust: { value: new Color(0.13, 0.16, 0.05) },
      uColorAcid: { value: new Color(0.42, 1.0, 0.09) },
      uColorHot: { value: new Color(0.86, 1.0, 0.55) },
      uColorEdge: { value: new Color(0.55, 1.0, 0.16) }
    }),
    vertexShader: POOL_VERTEX,
    fragmentShader: POOL_FRAGMENT
  });

  /**
   * @param {object} state { radius, quadSize, grown, front, spent, boil, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.acid;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uGrown.value = state.grown;
    u.uFront.value = state.front;
    u.uBoil.value = state.boil * c.boilDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uPlates.value = c.poolPlates * g.noiseFrequency;
    u.uCraze.value = c.poolCraze;
    u.uWarp.value = c.poolWarp * g.noiseStrength;
    u.uSeam.value = c.poolSeam;
    u.uSeamGlow.value = c.poolSeamGlow * g.shaderIntensity;
    u.uCrust.value = c.poolCrust;
    u.uRelief.value = c.poolRelief;
    u.uSheen.value = c.poolSheen;
    u.uGloss.value = c.poolGloss;
    u.uEtch.value = c.poolEtch;
    u.uEtchScale.value = c.poolEtchScale * g.noiseFrequency;
    u.uPits.value = c.poolPits;
    u.uPitScale.value = c.poolPitScale * g.noiseFrequency;
    u.uBoilRate.value = c.poolBoilRate * g.noiseSpeed;
    // `spent` runs 1 → (1 - poolSpend) over the bloom's life: the acid goes
    // inert long before the crust it left goes anywhere.
    u.uHeat.value = c.poolHeat * state.spent * g.shaderIntensity;
    u.uHeatFalloff.value = c.poolHeatFalloff;
    u.uFlow.value = c.poolFlow * g.noiseSpeed;
    u.uCaustic.value = c.poolCaustic * state.spent;
    u.uCausticScale.value = c.poolCausticScale * g.noiseFrequency;
    u.uBoundary.value = c.poolBoundary;
    u.uBoundaryGlow.value = c.poolBoundaryGlow;
    u.uCore.value = c.poolCore * state.spent;
    u.uCoreSize.value = c.poolCoreSize;
    u.uRings.value = c.poolRings;
    u.uRingSpeed.value = c.poolRingSpeed;
    u.uOpacity.value = c.poolOpacity * g.opacity;

    u.uColorSludge.value.copy(getColor(c.colorSludge));
    u.uColorCrust.value.copy(getColor(c.colorPlate));
    u.uColorAcid.value.copy(getColor(c.colorAcid));
    u.uColorHot.value.copy(getColor(c.colorAcidHot));
    u.uColorEdge.value.copy(getColor(c.colorPoolEdge));
  };

  return material;
}
