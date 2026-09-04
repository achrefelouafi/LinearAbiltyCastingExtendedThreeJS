import { AdditiveBlending, Color, DoubleSide, NormalBlending, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The five passes the serpent's body is drawn in.
 *
 * All five run the **same vertex stage over the same geometry** — the canonical
 * body from `assets/SerpentGeometry.js` — and differ only in how far they
 * inflate it and what the fragment stage makes of it. That is the whole design:
 * a holographic creature is not one surface, it is a stack of them, and the
 * read comes from the order they are stacked in.
 *
 *   WIRE — the construction mesh itself, drawn as glowing triangle edges over a
 *          nearly empty interior. Double sided and never depth-writing, so the
 *          far side of the body shows through the near side. That transparency
 *          is what says *hologram* rather than *chrome snake*, and it is why the
 *          wire is the only pass allowed to be sharp.
 *   FILL — the energy inside it: the same body, barely inflated, weighted so it
 *          is brightest where the view ray takes the longest path through the
 *          volume. A cloud in the shape of the animal.
 *   AURA — wide, faint, rim-only. Atmosphere, not a third snake. Push its gain
 *          up and it fogs the wire, which is the read.
 *   WAKE — the body again, N instances of it, each one lagged a little further
 *          back down the flight line *and a little further back in time*, so a
 *          ghost holds the pose the serpent had when it was there. Eroded by
 *          noise into vapour.
 *   WARP — a heat-haze proxy on `LAYER.DISTORTION`. Invisible to the main pass;
 *          it writes screen-space offsets so the air closes behind the thing.
 *
 * ## The body moves in the vertex stage
 *
 * The mesh is a *pose*, not an animation — there is no skeleton in the file and
 * no clip. What makes it swim is that every pass reconstructs a local frame
 * from an analytic spine: a travelling lateral wave with a slower vertical one
 * under it, amplitude growing toward the tail so the head leads and the body
 * follows. The frame is built from a finite difference of that spine, which is
 * what carries the *normals* around with the bend — deform positions alone and
 * the fresnel stays welded to the rest pose and the whole illusion dies.
 *
 * The same frame is what the shatter tears apart: each facet is rebuilt about
 * its own deformed centroid, then thrown along `aBurst` and spun, on a per-facet
 * delay. The body comes apart *as it was flying*, not as a still.
 */
export const SerpentPass = Object.freeze({
  WIRE: 0,
  FILL: 1,
  AURA: 2,
  WAKE: 3,
  WARP: 4
});

const SERPENT_UNIFORMS = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI  3.141592653589793

  uniform float uTime;
  uniform float uSeed;

  /* --- the cast's state --- */
  uniform float uForm;        // how much of the body exists, head → tail
  uniform float uShatter;     // 0..1, the body coming apart
  uniform float uFade;        // master dim
  uniform float uFormEdge;    // width of the hot edge on the materialising front
  uniform float uFormRough;   // how ragged that front is
  uniform float uFormGlow;

  /* --- the swim --- */
  uniform float uSway;
  uniform float uSwayWaves;
  uniform float uSwaySpeed;
  uniform float uSwayRoot;
  uniform float uSwayPitch;
  uniform float uSwayPitchWaves;

  /* --- per pass --- */
  uniform float uInflate;
  uniform float uGain;
  uniform float uOpacity;
  uniform float uSoftFade;

  /* --- the shatter --- */
  uniform float uShatterSpread;
  uniform float uShatterSpin;
  uniform float uShatterStagger;

  /* --- the wake --- */
  uniform float uGhostLag;
  uniform float uGhostTimeLag;
  uniform float uGhostInflate;
  uniform float uGhostFade;
  uniform float uGhostErode;
  uniform float uGhostErodeScale;

  /* --- the wireframe --- */
  uniform float uWireWidth;
  uniform float uWireFloor;
  uniform float uWireSolid;
  uniform float uWireGain;
  uniform float uWireHalo;
  uniform float uWireHaloGain;
  uniform float uFacetFill;
  uniform float uFacetRim;
  uniform float uFacetPower;
  uniform float uScanDepth;
  uniform float uScanFreq;
  uniform float uScanSpeed;
  uniform float uPulse;
  uniform float uPulseFreq;
  uniform float uPulseSpeed;
  uniform float uPulseSharp;
  uniform float uGlitch;
  uniform float uGlitchRate;
  uniform float uGlitchGain;
  uniform float uHeadHeat;
  uniform float uHeadLength;

  /* --- the energy fill --- */
  uniform float uFillCore;
  uniform float uCloudDepth;
  uniform float uCloudScale;
  uniform float uCloudFlow;

  /* --- the aura --- */
  uniform float uAuraRim;
  uniform float uAuraBreak;

  /* --- the warp --- */
  uniform float uWarpStrength;
  uniform float uWarpScale;
  uniform float uWarpSpeed;

  uniform vec3 uColorWire;
  uniform vec3 uColorHot;
  uniform vec3 uColorFacet;
  uniform vec3 uColorFillCore;
  uniform vec3 uColorFillEdge;
  uniform vec3 uColorAura;
  uniform vec3 uColorGhost;

  uniform float uShaderIntensity;
  uniform float uGlobalGlow;
`;

const SERPENT_VERTEX = /* glsl */ `
  ${SERPENT_UNIFORMS}

  attribute vec3 aBary;
  attribute vec3 aFacet;
  attribute vec3 aBurst;
  attribute float aSeed;
  #ifdef GHOSTS
    attribute float aGhost;
  #endif

  varying vec3 vBary;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vViewNormal;
  varying vec3 vView;
  varying vec3 vWorld;
  varying float vS;
  varying float vSeed;
  varying float vShatter;
  varying float vGhost;
  varying float vViewZ;

  /**
   * The spine, in canonical body space.
   *
   * s runs 0 at the nose to 1 at the tail tip. The lateral wave is the swim;
   * the vertical one is slower and out of phase with it, which is what keeps the
   * motion from reading as a flat cardboard cut-out weaving left and right.
   * Amplitude grows from uSwayRoot at the head to full at the tail, so the
   * head leads and the body is dragged after it.
   */
  vec2 spineAt(float s, float time) {
    float amp = uSway * mix(uSwayRoot, 1.0, s);
    float lateral = sin((s * uSwayWaves - time * uSwaySpeed) * TAU + uSeed * 6.1);
    float vertical = sin((s * uSwayPitchWaves - time * uSwaySpeed * 0.61) * TAU + uSeed * 2.7 + 1.31);
    return vec2(lateral * amp, vertical * amp * uSwayPitch);
  }

  /* Rodrigues: rotate v about the unit axis by angle. */
  vec3 rotateAxis(vec3 v, vec3 axis, float angle) {
    float c = cos(angle);
    return v * c + cross(axis, v) * sin(angle) + axis * dot(axis, v) * (1.0 - c);
  }

  /**
   * Place a point of the rest body on the swimming one.
   *
   * The frames come back as well because the *normal* has to travel with the
   * bend — a deformed position with an undeformed normal reads as a decal
   * sliding over a still object, and every rim term in this file would lie.
   */
  vec3 deform(vec3 rest, float time, out vec3 fwd, out vec3 right, out vec3 up) {
    float s = clamp(0.5 - rest.z, 0.0, 1.0);
    const float H = 0.014;

    vec3 c0 = vec3(spineAt(s, time), 0.5 - s);
    vec3 c1 = vec3(spineAt(s + H, time), 0.5 - s - H);

    fwd = normalize(c0 - c1);
    right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
    up = cross(fwd, right);
    return c0 + right * rest.x + up * rest.y;
  }

  void main() {
    float ghost = 0.0;
    #ifdef GHOSTS
      // Index 0 is the first copy *behind* the body, not the body itself — the
      // other passes already draw that.
      ghost = aGhost + 1.0;
    #endif
    float time = uTime - ghost * uGhostTimeLag;

    vec3 fwd, right, up;
    vec3 pos = deform(position, time, fwd, right, up);
    vec3 nrm = normalize(right * normal.x + up * normal.y + fwd * normal.z);

    pos += nrm * (uInflate + ghost * uGhostInflate);
    // Straight back down the flight line: the model matrix puts local +Z on the
    // heading, so a lag in local z *is* a lag along the path.
    pos.z -= ghost * uGhostLag;

    float shatter = 0.0;
    if (uShatter > 0.0) {
      // Every facet is rebuilt about its own centroid, carried through the same
      // deformation, so the body tears apart mid-swim.
      vec3 ffwd, fright, fup;
      vec3 centre = deform(aFacet, time, ffwd, fright, fup);
      centre.z -= ghost * uGhostLag;

      // Staggered per facet: the head lets go first and the tail hangs on, which
      // is what makes it read as a body coming apart rather than as a puff.
      float delay = aSeed * uShatterStagger;
      shatter = clamp((uShatter - delay) / max(1e-3, 1.0 - uShatterStagger), 0.0, 1.0);

      vec3 rel = pos - centre;
      float spin = shatter * uShatterSpin * (aSeed - 0.5) * TAU;
      rel = rotateAxis(rel, aBurst, spin);
      // Shards shrink as they fly: the debris thins out instead of hanging in
      // the air as a cloud of full-size triangles.
      rel *= 1.0 - shatter * 0.6;

      pos = centre + aBurst * (shatter * shatter * uShatterSpread * (0.45 + aSeed))
          + rel
          + vec3(0.0, -shatter * shatter * uShatterSpread * 0.35, 0.0);
      nrm = rotateAxis(nrm, aBurst, spin);
    }

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vec4 mv = viewMatrix * world;

    vBary = aBary;
    vLocal = position;
    vSeed = aSeed;
    vS = clamp(0.5 - position.z, 0.0, 1.0);
    vShatter = shatter;
    vGhost = ghost;
    vWorld = world.xyz;
    // The model matrix is a rigid frame with one uniform scale on it, so this is
    // the normal matrix and no inverse-transpose is needed.
    vNormal = normalize(mat3(modelMatrix) * nrm);
    vViewNormal = normalize(normalMatrix * nrm);
    vView = cameraPosition - world.xyz;
    vViewZ = mv.z;

    gl_Position = projectionMatrix * mv;
  }
`;

const SERPENT_FRAGMENT = /* glsl */ `
  ${SERPENT_UNIFORMS}

  uniform sampler2D uSceneDepth;
  uniform vec2 uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec3 vBary;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vViewNormal;
  varying vec3 vView;
  varying vec3 vWorld;
  varying float vS;
  varying float vSeed;
  varying float vShatter;
  varying float vGhost;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    /* ---- the reveal: the body exists from the nose back to uForm ---- */
    // Ragged, and welded to the body rather than to the world, so the front
    // crawls down the animal instead of the animal sliding through a curtain.
    float ragged = snoise(vec3(vLocal.xy * 11.0, vS * 6.0 + uSeed * 3.7)) * uFormRough;
    float grow = uForm - vS + ragged;
    if (grow < 0.0) discard;
    float front = 1.0 - smoothstep(0.0, max(uFormEdge, 1e-3), grow);

    vec3 normal = normalize(vNormal);
    vec3 view = normalize(vView);
    float facing = clamp(abs(dot(view, normal)), 0.0, 1.0);

    float alpha = 0.0;
    vec3 color = vec3(0.0);

    #if PASS == 4                                     /* WARP */
      // Rim-weighted, like real refraction: the offset is largest where the
      // surface turns away, and nil where we look straight through it.
      float rim = pow(1.0 - facing, 2.0);
      vec2 wobble = vec2(
        snoise(vec3(vWorld.xz * uWarpScale, uTime * uWarpSpeed)),
        snoise(vec3(vWorld.xz * uWarpScale + 31.7, uTime * uWarpSpeed + 5.1))
      );
      vec2 offset = normalize(vViewNormal.xy + wobble * 0.35 + 1e-4) * rim;
      float strength = uWarpStrength * uShaderIntensity * rim * uFade;
      if (strength < 0.002) discard;
      gl_FragColor = vec4(offset * 0.5 + 0.5, strength, rim);
      return;
    #endif

    #if PASS == 0                                     /* WIRE */
      /*
       * A constant-width wireframe: the barycentric minimum divided by its own
       * screen-space derivative is the distance to the nearest edge *in pixels*,
       * so the mesh reads at the same weight whether the serpent is at the
       * caster's feet or twenty-five metres downrange. Interpolating a width in
       * body space instead would thicken the far end into a solid.
       */
      float w = min(min(vBary.x, vBary.y), vBary.z);
      float pix = max(fwidth(w), 1e-6);
      float d = w / pix;
      float edge = 1.0 - smoothstep(uWireWidth, uWireWidth + 1.2, d);
      float halo = exp(-d / max(uWireHalo, 0.1));

      /*
       * ... and the same argument applied to the *mesh*, which is what stops the
       * head reading as a white lump. Two thirds of this animal's triangles are
       * in its jaws; once one of them is only a few pixels across, its three
       * edges overlap and the "wireframe" there fills in solid. One over fwidth is
       * the triangle's inradius in pixels, so fading the wire out below a few of
       * them is the mesh-density equivalent of a mip chain — the dense head
       * dissolves into the energy fill behind it instead of clipping to white,
       * and the sparse body keeps its lines.
       */
      float dense = smoothstep(uWireFloor, uWireFloor * 4.0, 1.0 / pix);
      // What the fade takes out comes back as an even glow over the facet, so
      // the head — and the whole animal, seen from across the arena — reads as a
      // lit body rather than dissolving. The construct is *drawn* as a mesh up
      // close and *is* a shape at distance, and nothing about it dims in
      // between.
      float solid = (1.0 - dense) * uWireSolid;

      /* holographic banding, running down the body */
      float scan = mix(1.0, 0.5 + 0.5 * sin((vS * uScanFreq - uTime * uScanSpeed) * TAU), uScanDepth);

      /* charge running head-ward along the mesh */
      float phase = fract(vS * uPulseFreq + uTime * uPulseSpeed);
      float pulse = pow(1.0 - abs(phase * 2.0 - 1.0), max(uPulseSharp, 0.05)) * uPulse;

      /* a few facets misfiring each frame — the thing is being *computed* */
      float flicker = step(1.0 - uGlitch, hash13(vec3(vSeed * 37.0, floor(uTime * uGlitchRate), 1.7)));

      /* the interior: almost nothing, plus a rim so the volume is legible */
      float rim = pow(1.0 - facing, max(uFacetPower, 0.05)) * uFacetRim;
      float body = uFacetFill + rim;

      /* heat at the nose, where it is going through the air */
      float head = (1.0 - smoothstep(0.0, max(uHeadLength, 1e-3), vS)) * uHeadHeat;

      float wire = (edge * uWireGain * dense + halo * uWireHaloGain * dense + solid * uWireGain) * scan;
      wire *= 1.0 + pulse + flicker * uGlitchGain;

      float energy = wire + body + head + front * uFormGlow;
      color = mix(uColorFacet, uColorWire, clamp(wire * 0.8, 0.0, 1.0));
      color = mix(color, uColorHot, clamp(pulse * 0.8 + head + front, 0.0, 1.0));
      color *= energy;
      alpha = clamp(energy * 0.85, 0.0, 1.0);

    #elif PASS == 1                                   /* FILL */
      /*
       * Weighted the opposite way to a rim: brightest where the view ray runs
       * *through* the body, which is a volume integral done for the price of a
       * pow. The clouds are sampled in body space so they are carried by the
       * animal rather than swum through.
       */
      float core = pow(facing, max(uFillCore, 0.05));
      float clouds = fbm3(vec3(vLocal.xy * uCloudScale, vS * uCloudScale * 0.55 - uTime * uCloudFlow + uSeed)) * 0.5 + 0.5;
      clouds = mix(1.0, clouds, uCloudDepth);

      float energy = core * clouds;
      color = mix(uColorFillEdge, uColorFillCore, clamp(core * 1.5, 0.0, 1.0));
      color = mix(color, uColorHot, front * 0.8);
      color *= energy + front * 0.6;
      alpha = clamp(energy * 0.9 + front * 0.3, 0.0, 1.0);

    #elif PASS == 2                                   /* AURA */
      float rim = pow(1.0 - facing, max(uAuraRim, 0.05));
      // Broken up, or the shell reads as a second skin sitting off the body.
      float grain = mix(1.0, snoise01(vec3(vLocal.xy * 6.0, vS * 4.0 - uTime * 0.6)), uAuraBreak);
      float energy = rim * grain;
      color = uColorAura * energy;
      alpha = clamp(energy, 0.0, 1.0);

    #elif PASS == 3                                   /* WAKE */
      // Each copy is fainter and coarser than the one in front of it. The tail
      // weighting keeps the ghosts off the nose, where they would only smear the
      // silhouette the wire pass is carrying.
      float decay = pow(uGhostFade, vGhost);
      float tail = smoothstep(0.0, 0.35, vS);
      float rim = pow(1.0 - facing, 1.7) + 0.22;
      float erode = fbm3(vec3(vWorld.xz * uGhostErodeScale, vWorld.y * uGhostErodeScale - uTime * 0.7)) * 0.5 + 0.5;
      erode = mix(1.0, erode, uGhostErode);

      float energy = rim * decay * tail * erode;
      color = mix(uColorGhost, uColorFillEdge, clamp(1.0 - decay, 0.0, 1.0)) * energy;
      alpha = clamp(energy, 0.0, 1.0);
    #endif

    /* ---- shards dim as they fly, so the debris resolves rather than piles up ---- */
    alpha *= 1.0 - vShatter * 0.55;
    color *= 1.0 - vShatter * 0.3;

    alpha *= uFade * uOpacity;
    color *= uGain * uShaderIntensity;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    // Soft shoulder, and a hard one by this project's standards. Five additive
    // passes over one body clip to a white sausage the moment two of them
    // overlap, and what is lost when they do is the *hue* — a neon construct
    // that reads white is just a bright shape. Rolling off here keeps the cyan
    // in the highlights instead of letting the tone map take it.
    color /= 1.0 + color * 0.22;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One pass of the serpent's body.
 *
 * @param {number} pass one of `SerpentPass`
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`
 */
export function createSerpentMaterial(pass) {
  const wake = pass === SerpentPass.WAKE;
  const warp = pass === SerpentPass.WARP;

  const defines = { PASS: pass };
  if (wake) defines.GHOSTS = '';

  const material = new ShaderMaterial({
    name: `CyberSerpent:${pass}`,
    defines,
    transparent: true,
    depthWrite: false,
    // The warp proxy is drawn into its own buffer with nothing else in it, so a
    // depth test there has nothing to test against.
    depthTest: !warp,
    blending: warp ? NormalBlending : AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: { value: 0 },
      uForm: { value: 1 },
      uShatter: { value: 0 },
      uFade: { value: 1 },
      uFormEdge: { value: 0.06 },
      uFormRough: { value: 0.05 },
      uFormGlow: { value: 2.2 },

      uSway: { value: 0.035 },
      uSwayWaves: { value: 1.6 },
      uSwaySpeed: { value: 1.7 },
      uSwayRoot: { value: 0.25 },
      uSwayPitch: { value: 0.5 },
      uSwayPitchWaves: { value: 1.1 },

      uInflate: { value: 0 },
      uGain: { value: 1 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.5 },

      uShatterSpread: { value: 0.5 },
      uShatterSpin: { value: 1.4 },
      uShatterStagger: { value: 0.55 },

      uGhostLag: { value: 0.12 },
      uGhostTimeLag: { value: 0.03 },
      uGhostInflate: { value: 0.004 },
      uGhostFade: { value: 0.62 },
      uGhostErode: { value: 0.8 },
      uGhostErodeScale: { value: 1.4 },

      uWireWidth: { value: 0.7 },
      uWireFloor: { value: 1.5 },
      uWireSolid: { value: 0.45 },
      uWireGain: { value: 1.5 },
      uWireHalo: { value: 3.5 },
      uWireHaloGain: { value: 0.55 },
      uFacetFill: { value: 0.045 },
      uFacetRim: { value: 0.5 },
      uFacetPower: { value: 2.6 },
      uScanDepth: { value: 0.3 },
      uScanFreq: { value: 26 },
      uScanSpeed: { value: 3 },
      uPulse: { value: 1.4 },
      uPulseFreq: { value: 2.2 },
      uPulseSpeed: { value: 1.1 },
      uPulseSharp: { value: 5 },
      uGlitch: { value: 0.02 },
      uGlitchRate: { value: 14 },
      uGlitchGain: { value: 2.5 },
      uHeadHeat: { value: 0.7 },
      uHeadLength: { value: 0.12 },

      uFillCore: { value: 2.4 },
      uCloudDepth: { value: 0.7 },
      uCloudScale: { value: 7 },
      uCloudFlow: { value: 1.6 },

      uAuraRim: { value: 3.2 },
      uAuraBreak: { value: 0.45 },

      uWarpStrength: { value: 0.7 },
      uWarpScale: { value: 1.2 },
      uWarpSpeed: { value: 1.4 },

      uColorWire: { value: new Color(0.45, 0.95, 1) },
      uColorHot: { value: new Color(1, 1, 1) },
      uColorFacet: { value: new Color(0.05, 0.35, 0.7) },
      uColorFillCore: { value: new Color(0.75, 0.95, 1) },
      uColorFillEdge: { value: new Color(0.12, 0.45, 0.95) },
      uColorAura: { value: new Color(0.1, 0.55, 1) },
      uColorGhost: { value: new Color(0.4, 0.8, 1) }
    }),
    vertexShader: SERPENT_VERTEX,
    fragmentShader: SERPENT_FRAGMENT
  });

  /**
   * Push the live settings and the cast's state into this pass.
   *
   * Called every frame, on a zero-length frame included, which is what keeps
   * every control below a live slider while the sandbox is paused.
   *
   * @param {object} state { form, shatter, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.cyber;
    const g = settings.global;
    const u = material.uniforms;

    u.uSeed.value = state.seed;
    u.uForm.value = state.form;
    u.uShatter.value = state.shatter;
    u.uFade.value = state.fade;
    u.uFormEdge.value = c.formEdge;
    u.uFormRough.value = c.formRough * g.noiseStrength;
    u.uFormGlow.value = c.formGlow;

    u.uSway.value = c.sway;
    u.uSwayWaves.value = c.swayWaves;
    u.uSwaySpeed.value = c.swaySpeed * g.animationSpeed;
    u.uSwayRoot.value = c.swayRoot;
    u.uSwayPitch.value = c.swayPitch;
    u.uSwayPitchWaves.value = c.swayPitchWaves;

    u.uShatterSpread.value = c.shatterSpread;
    u.uShatterSpin.value = c.shatterSpin;
    u.uShatterStagger.value = c.shatterStagger;

    u.uGhostLag.value = c.ghostLag;
    u.uGhostTimeLag.value = c.ghostTimeLag;
    u.uGhostInflate.value = c.ghostInflate;
    u.uGhostFade.value = c.ghostFade;
    u.uGhostErode.value = c.ghostErode * g.noiseStrength;
    u.uGhostErodeScale.value = c.ghostErodeScale * g.noiseFrequency;

    u.uWireWidth.value = c.wireWidth;
    u.uWireFloor.value = c.wireFloor;
    u.uWireSolid.value = c.wireSolid;
    u.uWireGain.value = c.wireGain;
    u.uWireHalo.value = c.wireHalo;
    u.uWireHaloGain.value = c.wireHaloGain;
    u.uFacetFill.value = c.facetFill;
    u.uFacetRim.value = c.facetRim * g.fresnel;
    u.uFacetPower.value = c.facetPower;
    u.uScanDepth.value = c.scanDepth;
    u.uScanFreq.value = c.scanFreq;
    u.uScanSpeed.value = c.scanSpeed * g.noiseSpeed;
    u.uPulse.value = c.pulse;
    u.uPulseFreq.value = c.pulseFreq;
    u.uPulseSpeed.value = c.pulseSpeed * g.noiseSpeed;
    u.uPulseSharp.value = c.pulseSharp;
    u.uGlitch.value = c.glitch * g.randomness;
    u.uGlitchRate.value = c.glitchRate;
    u.uGlitchGain.value = c.glitchGain;
    u.uHeadHeat.value = c.headHeat;
    u.uHeadLength.value = c.headLength;

    u.uFillCore.value = c.fillCore;
    u.uCloudDepth.value = c.cloudDepth * g.noiseStrength;
    u.uCloudScale.value = c.cloudScale * g.noiseFrequency;
    u.uCloudFlow.value = c.cloudFlow * g.noiseSpeed;

    u.uAuraRim.value = c.auraRim;
    u.uAuraBreak.value = c.auraBreak;

    u.uWarpStrength.value = c.warpStrength * g.distortion;
    u.uWarpScale.value = c.warpScale * g.noiseFrequency;
    u.uWarpSpeed.value = c.warpSpeed * g.noiseSpeed;

    u.uColorWire.value.copy(getColor(c.colorWire));
    u.uColorHot.value.copy(getColor(c.colorHot));
    u.uColorFacet.value.copy(getColor(c.colorFacet));
    u.uColorFillCore.value.copy(getColor(c.colorFillCore));
    u.uColorFillEdge.value.copy(getColor(c.colorFillEdge));
    u.uColorAura.value.copy(getColor(c.colorAura));
    u.uColorGhost.value.copy(getColor(c.colorGhost));

    /* ---- what this pass is, out of the five ---- */
    switch (pass) {
      case SerpentPass.WIRE:
        u.uInflate.value = 0;
        u.uGain.value = c.wireIntensity;
        u.uOpacity.value = c.wireOpacity * g.opacity;
        u.uSoftFade.value = c.softFade;
        break;
      case SerpentPass.FILL:
        u.uInflate.value = c.fillInflate;
        u.uGain.value = c.fillIntensity;
        u.uOpacity.value = c.fillOpacity * g.opacity;
        u.uSoftFade.value = c.softFade;
        break;
      case SerpentPass.AURA:
        u.uInflate.value = c.auraInflate;
        u.uGain.value = c.auraIntensity;
        u.uOpacity.value = c.auraOpacity * g.opacity;
        u.uSoftFade.value = c.softFade * 1.6;
        break;
      case SerpentPass.WAKE:
        u.uInflate.value = c.ghostInflate;
        u.uGain.value = c.ghostIntensity;
        u.uOpacity.value = c.ghostOpacity * g.opacity;
        u.uSoftFade.value = c.softFade * 2.2;
        break;
      default:
        u.uInflate.value = c.warpInflate;
        u.uGain.value = 1;
        u.uOpacity.value = 1;
        break;
    }
  };

  return material;
}
