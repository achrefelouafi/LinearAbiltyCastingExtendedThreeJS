import {
  AdditiveBlending,
  Color,
  DoubleSide,
  NormalBlending,
  ShaderMaterial,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The Judgment Cascade — the column, the star at its head, the halo rings that
 * ride it, and the air it shoves aside.
 *
 * Four materials in one file because they are one object. The reference sheet's
 * hero image is a single silhouette: a colossal shaft of light standing on the
 * mark, a four-pointed star welded to its head, and two counter-tilted rings
 * turning about it. Split across four files with four palettes they drift; here
 * they read every colour and every clock out of the same settings block, and
 * `uCharge` — how far the rend has gone — is passed to all four, so the column,
 * the star and the rings brighten as one thing.
 *
 * ## Why the column is shaded on N·V and not on a fresnel
 *
 * A beam of light is a *volume*, and what the eye reads as its brightness is how
 * much of that volume the ray crossed. For a cylinder of radius R that is
 * exactly `2R·|N·V|` — longest through the middle of the silhouette, falling to
 * nothing at the edges. So the body term here is a **power of |N·V|**, and it is
 * the single decision that separates this from every "glowing tube" that reaches
 * for `1 − N·V` out of habit: a fresnel is bright at the rim and hollow in the
 * middle, which is what a soap bubble looks like, not a searchlight.
 *
 * The rim term is still here, small, on top of it — a beam does have a boundary,
 * and the caustic edge is what makes the shaft read as having a surface at all.
 *
 * ## Why the star is not a texture
 *
 * The star is the thing the whole sheet is named for and it has to hold up at
 * any size, at any exposure, with bloom on top. Authored as a polar field it is
 * three raised cosines summed into a reach — a long vertical pair, a shorter
 * horizontal pair, four short diagonals — with an exponential falloff along each
 * one. That gives concave-sided points that stay sharp when the ability is
 * scaled up, an exact hot core, and a fine spray of needles between the points
 * that a sprite would have to resolve at 4K to match.
 */

/* ==================================================================== */
/* 1 · the column                                                        */
/* ==================================================================== */

const PILLAR_VERTEX = /* glsl */ `
  #define PTAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uHeight;
  uniform float uSkirt;
  uniform float uSkirtPower;
  uniform float uTopFlare;
  uniform float uFlarePower;
  uniform float uWobble;
  uniform float uWobbleScale;
  uniform float uWobbleSpeed;
  uniform float uSpin;

  varying float vClimb;
  varying float vAround;
  varying vec3  vNormalW;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    float t = position.x;             // 0 at the floor, 1 at the top of the shaft
    float a = position.y;             // 0..1 once around

    float angle = a * PTAU + uTime * uSpin * PTAU;

    // The profile: a wide skirt where it meets the stone, closing hard into the
    // shaft, then opening slowly with height. The skirt is not decoration — it
    // is what makes the column look like it is *standing on* the mark rather
    // than passing through the floor.
    float skirt = uSkirt * pow(1.0 - t, max(uSkirtPower, 0.05));
    float shaft = mix(1.0, uTopFlare, pow(t, max(uFlarePower, 0.05)));
    float wobble = snoise(vec3(cos(angle) * uWobbleScale, sin(angle) * uWobbleScale,
                               t * uWobbleScale * 2.0 - uTime * uWobbleSpeed)) * uWobble;
    float radius = max(0.02, uRadius * (shaft + skirt + wobble));

    vec3 world = uCentre + vec3(cos(angle), 0.0, sin(angle)) * radius;
    world.y += t * uHeight;

    vClimb = t;
    vAround = a;
    vWorld = world;
    // Radial, which is the surface normal of a cylinder everywhere but the
    // skirt — and the skirt is short enough that the error never shows.
    vNormalW = vec3(cos(angle), 0.0, sin(angle));

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const PILLAR_FRAGMENT = /* glsl */ `
  #define PTAU 6.283185307179586
  #define PPI  3.141592653589793

  uniform float uTime;
  uniform float uGrown;
  uniform float uFront;
  uniform float uFade;
  uniform float uSeed;
  uniform float uCharge;
  uniform float uPulse;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uIntensity;

  uniform float uBodyPower;
  uniform float uCorePower;
  uniform float uCore;
  uniform float uRim;
  uniform float uRimPower;

  uniform float uFlutes;
  uniform float uFluteSharp;
  uniform float uFluteDepth;
  uniform float uFluteDrift;

  uniform float uStreamScale;
  uniform float uStreamSpeed;

  uniform float uHeadFade;
  uniform float uFootGlow;
  uniform float uFootReach;
  uniform float uSoftFade;

  uniform vec3  uColorCore;
  uniform vec3  uColorBody;
  uniform vec3  uColorEdge;
  uniform vec3  uColorCool;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying float vClimb;
  varying float vAround;
  varying vec3  vNormalW;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    // The beam races up out of the mark. Nothing above the front exists yet.
    float live = 1.0 - smoothstep(uGrown - 0.04, uGrown + 0.02, vClimb);
    if (live < 0.003) discard;

    vec3 V = normalize(cameraPosition - vWorld);
    float ndv = abs(dot(normalize(vNormalW), V));

    // How much beam this ray crossed. A power of |N.V|, not of 1 - |N.V|: the
    // chord through a cylinder is longest through the middle of the silhouette.
    float body = pow(ndv, max(uBodyPower, 0.02));
    // ... and the white-hot filament down the axis, which is the same term run
    // much harder.
    float core = pow(ndv, max(uCorePower, 0.02)) * uCore;
    // The caustic boundary. Small, and only here so the shaft has an edge.
    float rim = pow(1.0 - ndv, max(uRimPower, 0.05)) * uRim;

    // Flutes running up the barrel: the light is not smooth, it is combed into
    // vertical channels that drift slowly around it.
    float flute = pow(abs(sin((vAround + uTime * uFluteDrift) * PPI * max(uFlutes, 1.0))),
                      max(uFluteSharp, 0.05));
    // Streams pouring up through them, in the barrel's own cylindrical space so
    // they travel with it rather than the shaft sliding through a field.
    float stream = fbm3(vec3(vAround * uStreamScale * 6.0,
                             vClimb * uStreamScale * 3.0 - uTime * uStreamSpeed,
                             uSeed));
    stream = smoothstep(0.25, 0.85, stream);

    // Deliberately not named after the built-in sampler function: shadowing it
    // compiles as JS and dies at first draw as a reserved-word error, with the
    // material silently rendering nothing.
    float combed = mix(1.0, mix(flute, 1.0, 0.35) * (0.45 + 0.75 * stream), clamp(uFluteDepth, 0.0, 1.0));

    // Top: the beam does not end, it loses itself. Bottom: it piles up on the
    // stone, which is where the ability is actually happening.
    float top = 1.0 - smoothstep(1.0 - uHeadFade, 1.0, vClimb);
    float foot = 1.0 + uFootGlow * exp(-vClimb / max(uFootReach, 0.01));
    // The hot leading edge while it is still climbing.
    float front = exp(-pow((vClimb - uGrown) / 0.055, 2.0)) * uFront;

    float beat = 1.0 + uPulse * 0.5 + uCharge * 0.7;
    float energy = (body * combed + core) * live * top * foot * beat;

    // Cool at the extreme rim and warm through the body — the sheet's column is
    // gold in its mass with blue-white light escaping off its edges.
    vec3 color = mix(uColorBody, uColorCore, clamp(core * 1.4 + front, 0.0, 1.0));
    color = mix(color, uColorEdge, smoothstep(0.35, 1.0, vClimb) * 0.45);
    color *= energy;
    color += uColorCool * rim * live * top * beat;
    color += uColorCore * front * 2.2 * live;
    color *= uIntensity * uFade;

    float alpha = clamp(energy * 0.9 + rim * 0.5 + front, 0.0, 1.0) * uFade * uOpacity;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    color /= 1.0 + color * 0.25;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The column of judgment.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`
 */
export function createRendPillarMaterial() {
  const material = new ShaderMaterial({
    name: 'RendPillar',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uRadius: { value: 1.6 },
      uHeight: { value: 30 },
      uSkirt: { value: 1.1 },
      uSkirtPower: { value: 4.5 },
      uTopFlare: { value: 1.25 },
      uFlarePower: { value: 1.6 },
      uWobble: { value: 0.08 },
      uWobbleScale: { value: 1.1 },
      uWobbleSpeed: { value: 1.2 },
      uSpin: { value: 0.05 },

      uGrown: { value: 0 },
      uFront: { value: 0 },
      uFade: { value: 1 },
      uSeed: { value: 0 },
      uCharge: { value: 0 },
      uPulse: { value: 0 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uIntensity: { value: 2.4 },

      uBodyPower: { value: 0.85 },
      uCorePower: { value: 7.0 },
      uCore: { value: 1.5 },
      uRim: { value: 0.5 },
      uRimPower: { value: 2.2 },

      uFlutes: { value: 22 },
      uFluteSharp: { value: 0.55 },
      uFluteDepth: { value: 0.6 },
      uFluteDrift: { value: 0.035 },

      uStreamScale: { value: 1.0 },
      uStreamSpeed: { value: 1.6 },

      uHeadFade: { value: 0.42 },
      uFootGlow: { value: 1.6 },
      uFootReach: { value: 0.12 },
      uSoftFade: { value: 0.6 },

      uColorCore: { value: new Color() },
      uColorBody: { value: new Color() },
      uColorEdge: { value: new Color() },
      uColorCool: { value: new Color() }
    }),
    vertexShader: PILLAR_VERTEX,
    fragmentShader: PILLAR_FRAGMENT
  });

  /** @param {object} state { centre, radius, height, grown, front, charge, pulse, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.rend;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uRadius.value = state.radius;
    u.uHeight.value = state.height;
    u.uGrown.value = state.grown;
    u.uFront.value = state.front;
    u.uCharge.value = state.charge;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uSkirt.value = c.pillarSkirt;
    u.uSkirtPower.value = c.pillarSkirtPower;
    u.uTopFlare.value = c.pillarTopFlare;
    u.uFlarePower.value = c.pillarFlarePower;
    u.uWobble.value = c.pillarWobble * g.noiseStrength;
    u.uWobbleScale.value = c.pillarWobbleScale * g.noiseFrequency;
    u.uWobbleSpeed.value = c.pillarWobbleSpeed * g.noiseSpeed;
    u.uSpin.value = c.pillarSpin * g.animationSpeed;

    u.uBodyPower.value = c.pillarBodyPower;
    u.uCorePower.value = c.pillarCorePower;
    u.uCore.value = c.pillarCore;
    u.uRim.value = c.pillarRim * g.fresnel;
    u.uRimPower.value = c.pillarRimPower;

    u.uFlutes.value = Math.max(1, Math.round(c.pillarFlutes));
    u.uFluteSharp.value = c.pillarFluteSharp;
    u.uFluteDepth.value = c.pillarFluteDepth;
    u.uFluteDrift.value = c.pillarFluteDrift * g.animationSpeed;
    u.uStreamScale.value = c.pillarStreamScale * g.noiseFrequency;
    u.uStreamSpeed.value = c.pillarStreamSpeed * g.noiseSpeed;

    u.uHeadFade.value = c.pillarHeadFade;
    u.uFootGlow.value = c.pillarFootGlow;
    u.uFootReach.value = c.pillarFootReach;
    u.uSoftFade.value = c.pillarSoftFade;
    u.uIntensity.value = c.pillarIntensity * g.shaderIntensity;
    u.uOpacity.value = c.pillarOpacity * g.opacity;
    u.uGlow.value = c.pillarGlow * g.glow;

    u.uColorCore.value.copy(getColor(c.colorPillarCore));
    u.uColorBody.value.copy(getColor(c.colorPillarBody));
    u.uColorEdge.value.copy(getColor(c.colorPillarEdge));
    u.uColorCool.value.copy(getColor(c.colorPillarCool));
  };

  return material;
}

/* ==================================================================== */
/* 2 · the star at its head                                              */
/* ==================================================================== */

const STAR_VERTEX = /* glsl */ `
  uniform vec3  uCentre;
  uniform float uSize;

  varying vec2 vLocal;

  void main() {
    // Billboarded off the camera basis in world space — viewMatrix's rows are
    // the camera axes, and its columns are what GLSL indexes, hence the
    // transposed reads. Kept upright in screen space on purpose: the sheet's
    // star has a long vertical axis and a shorter horizontal one, and a star
    // that rolls with the camera loses that read immediately.
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    vLocal = position.xy * 2.0;
    vec3 world = uCentre + (right * position.x + up * position.y) * uSize * 2.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  #define STAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uFade;
  uniform float uCharge;
  uniform float uPulse;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uIntensity;

  uniform float uVertical;
  uniform float uVerticalSharp;
  uniform float uHorizontal;
  uniform float uHorizontalSharp;
  uniform float uDiagonal;
  uniform float uDiagonalSharp;
  uniform float uReach;
  uniform float uFalloff;
  uniform float uHalo;
  uniform float uCore;
  uniform float uCoreGain;

  uniform float uNeedles;
  uniform float uNeedleCount;
  uniform float uNeedleSharp;
  uniform float uNeedleReach;
  uniform float uNeedleSpin;

  uniform float uRing;
  uniform float uRingSeat;
  uniform float uRingWidth;

  uniform float uFlicker;
  uniform float uFlickerRate;

  uniform vec3  uColorCore;
  uniform vec3  uColorBody;
  uniform vec3  uColorEdge;
  uniform vec3  uColorCool;

  uniform float uGlobalGlow;

  varying vec2 vLocal;

  ${noiseGLSL}

  void main() {
    vec2 p = vLocal;
    float d = length(p);
    if (d > 1.35) discard;

    float inv = 1.0 / max(d, 1e-4);
    float c = p.x * inv;
    float s = p.y * inv;

    /* ---- the reach along each family of points ---- */
    // Three raised cosines summed. Each one is concave sided by construction,
    // which is what the sheet's star is and what a polygonal star is not.
    float reach = uVertical   * pow(abs(s), max(uVerticalSharp, 0.05))
                + uHorizontal * pow(abs(c), max(uHorizontalSharp, 0.05))
                + uDiagonal   * pow(abs(2.0 * s * c), max(uDiagonalSharp, 0.05));

    // The fine spray between them: many short needles, eaten by noise so they
    // are not a comb, and turning slowly against the star itself.
    float ang = atan(p.y, p.x) + uTime * uNeedleSpin * STAU;
    float needle = pow(abs(sin(ang * max(uNeedleCount, 1.0) * 0.5)), max(uNeedleSharp, 0.05));
    needle *= 0.35 + 0.65 * snoise01(vec3(cos(ang) * 3.0, sin(ang) * 3.0, uSeed + uTime * 0.25));
    reach += needle * uNeedles * uNeedleReach;

    float flicker = 1.0 + uFlicker * (snoise(vec3(uSeed, uTime * uFlickerRate, 0.0)));
    float beat = (1.0 + uPulse * 0.6 + uCharge * 0.9) * flicker;

    /* ---- the points themselves ---- */
    // A hard boundary with a soft interior, not a bare exponential. This is the
    // whole difference between a star and a sunburst: exp(-d/reach) never
    // reaches zero, so the concave sides between the points never resolve into a
    // silhouette and every bearing ends up carrying some light. Clamping to a
    // real edge at the reach and shading the inside with a power gives the
    // sheet's four points their shape back.
    // The beat is deliberately *not* in here. It belongs on the brightness, and
    // a star whose reach breathes is a star that grows past the quad it is drawn
    // on: the points get squared off against the plane's edge, and the bloom
    // that never falls to zero paints the whole quad as a visible grey box.
    float span = max(reach * uReach, 1e-4);
    float rays = pow(clamp(1.0 - d / span, 0.0, 1.0), max(uFalloff, 0.05));
    /* ---- the soft bloom the points sit in ---- */
    float halo = exp(-d / max(span * 0.35, 1e-4)) * uHalo;
    // ... and an unconditional window, so nothing at all survives to the edge of
    // the plane whatever the settings are dragged to.
    float window = 1.0 - smoothstep(0.85, 1.2, d);
    /* ---- and the hot round core they leave ---- */
    float core = exp(-(d * d) / max(uCore * uCore, 1e-6)) * uCoreGain;

    /* ---- the thin circle struck through it ---- */
    float f = d - uRingSeat;
    float g = max(fwidth(f), 1e-7);
    float ring = (1.0 - smoothstep(0.0, max(uRingWidth, g), abs(f))) * uRing;

    float energy = (rays + halo + core + ring) * beat * window;
    if (energy < 0.004) discard;

    // Warm through the body, near-white in the core, and a cold fringe out at
    // the extreme tips — the one place the sheet's gold turns blue.
    vec3 color = mix(uColorBody, uColorCore, clamp(core + rays * 0.35, 0.0, 1.0));
    color = mix(color, uColorEdge, smoothstep(0.12, 0.5, d));
    color = mix(color, uColorCool, smoothstep(0.45, 0.95, d) * 0.7);
    color *= energy * uIntensity * uFade;

    float alpha = clamp(energy, 0.0, 1.0) * uFade * uOpacity;
    color *= uGlow * uGlobalGlow;
    color /= 1.0 + color * 0.22;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The four-pointed star welded to the column's head.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`
 */
export function createRendStarMaterial() {
  const material = new ShaderMaterial({
    name: 'RendStar',
    transparent: true,
    depthWrite: false,
    // Off on purpose: the star is the brightest thing in the ability and it sits
    // inside the column's own volume. Tested against the shaft it would be
    // punched through by whichever wall happened to be nearer the camera.
    depthTest: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uSize: { value: 4 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uCharge: { value: 0 },
      uPulse: { value: 0 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uIntensity: { value: 2.2 },

      uVertical: { value: 1.0 },
      uVerticalSharp: { value: 5.5 },
      uHorizontal: { value: 0.62 },
      uHorizontalSharp: { value: 6.5 },
      uDiagonal: { value: 0.2 },
      uDiagonalSharp: { value: 7.0 },
      uReach: { value: 0.95 },
      uFalloff: { value: 2.0 },
      uHalo: { value: 0.5 },
      uCore: { value: 0.075 },
      uCoreGain: { value: 1.6 },

      uNeedles: { value: 0.28 },
      uNeedleCount: { value: 34 },
      uNeedleSharp: { value: 9 },
      uNeedleReach: { value: 0.35 },
      uNeedleSpin: { value: 0.015 },

      uRing: { value: 0.55 },
      uRingSeat: { value: 0.36 },
      uRingWidth: { value: 0.012 },

      uFlicker: { value: 0.12 },
      uFlickerRate: { value: 2.6 },

      uColorCore: { value: new Color() },
      uColorBody: { value: new Color() },
      uColorEdge: { value: new Color() },
      uColorCool: { value: new Color() }
    }),
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT
  });

  /** @param {object} state { centre, size, charge, pulse, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.rend;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uSize.value = state.size;
    u.uCharge.value = state.charge;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uVertical.value = c.starVertical;
    u.uVerticalSharp.value = c.starVerticalSharp;
    u.uHorizontal.value = c.starHorizontal;
    u.uHorizontalSharp.value = c.starHorizontalSharp;
    u.uDiagonal.value = c.starDiagonal;
    u.uDiagonalSharp.value = c.starDiagonalSharp;
    u.uReach.value = c.starReach;
    u.uFalloff.value = c.starFalloff;
    u.uHalo.value = c.starHalo;
    u.uCore.value = c.starCore;
    u.uCoreGain.value = c.starCoreGain;

    u.uNeedles.value = c.starNeedles * g.shaderIntensity;
    u.uNeedleCount.value = Math.max(1, Math.round(c.starNeedleCount));
    u.uNeedleSharp.value = c.starNeedleSharp;
    u.uNeedleReach.value = c.starNeedleReach;
    u.uNeedleSpin.value = c.starNeedleSpin * g.animationSpeed;

    u.uRing.value = c.starRing * g.shaderIntensity;
    u.uRingSeat.value = c.starRingSeat;
    u.uRingWidth.value = c.starRingWidth;

    u.uFlicker.value = c.starFlicker * g.randomness;
    u.uFlickerRate.value = c.starFlickerRate;

    u.uIntensity.value = c.starIntensity * g.shaderIntensity;
    u.uOpacity.value = c.starOpacity * g.opacity;
    u.uGlow.value = c.starGlow * g.glow;

    u.uColorCore.value.copy(getColor(c.colorStarCore));
    u.uColorBody.value.copy(getColor(c.colorStarBody));
    u.uColorEdge.value.copy(getColor(c.colorStarEdge));
    u.uColorCool.value.copy(getColor(c.colorStarCool));
  };

  return material;
}

/* ==================================================================== */
/* 3 · the halo rings                                                    */
/* ==================================================================== */

const HALO_VERTEX = /* glsl */ `
  uniform float uOuter;

  varying vec2  vLocal;
  varying float vViewZ;

  void main() {
    // The annulus arrives as a unit ring; the ability tilts and turns the mesh,
    // so everything below works in the ring's own plane and never has to know
    // which way it is leaning.
    vLocal = position.xy * uOuter;
    vec4 mv = modelViewMatrix * vec4(position.xy * uOuter, 0.0, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const HALO_FRAGMENT = /* glsl */ `
  #define HTAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uFade;
  uniform float uCharge;
  uniform float uPulse;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uIntensity;

  uniform float uSeat;
  uniform float uBand;
  uniform float uRails;
  uniform float uRailWidth;

  uniform float uDashes;
  uniform float uDashCount;
  uniform float uDashDuty;
  uniform float uDashDrift;

  uniform float uGlyphs;
  uniform float uGlyphCount;
  uniform float uGlyphSize;

  uniform float uSweep;
  uniform float uSweepSharp;
  uniform float uSweepRate;

  uniform float uGrain;
  uniform float uGrainScale;
  uniform float uOpen;

  uniform vec3  uColorCore;
  uniform vec3  uColorBody;
  uniform vec3  uColorCool;

  uniform float uGlobalGlow;

  varying vec2  vLocal;
  varying float vViewZ;

  ${noiseGLSL}

  /** Any field, stroked as a line of constant apparent width. See RendSigilMaterial. */
  float lineAA(float f, float w) {
    float g = max(fwidth(f), 1e-7);
    float px = abs(f) / g;
    float want = w / g;
    float ww = max(want, 1.0);
    return (1.0 - smoothstep(0.0, ww, px)) * (want / ww);
  }

  void main() {
    float r = length(vLocal);
    float a = atan(vLocal.y, vLocal.x);

    // Across the band: a soft profile with a hot line down its middle.
    float d = r - uSeat;
    float across = 1.0 - smoothstep(0.0, max(uBand, 1e-4), abs(d));
    if (across < 0.003) discard;
    float body = pow(across, 1.6);

    // The two rails that fence it. These are what makes a ring read as machined
    // rather than as a smear of light at this radius.
    float rails = (lineAA(abs(d) - uBand * 0.86, uRailWidth)) * uRails;

    // Dashes cut around it, drifting slowly.
    float turn = a / HTAU + uTime * uDashDrift;
    float cell = fract(turn * max(floor(uDashCount), 1.0));
    float dash = smoothstep(0.0, 0.08, cell) * (1.0 - smoothstep(clamp(uDashDuty, 0.02, 0.98), clamp(uDashDuty, 0.02, 0.98) + 0.08, cell));
    float dashed = mix(1.0, dash, clamp(uDashes, 0.0, 1.0));

    // Glyph beads seated on the band at a lower count — the sheet's rings carry
    // a handful of bright nodes, not an even necklace.
    float gcell = fract(turn * max(floor(uGlyphCount), 1.0) * 0.5);
    float bead = 1.0 - smoothstep(0.0, max(uGlyphSize, 1e-3), min(gcell, 1.0 - gcell));
    bead *= (1.0 - smoothstep(0.0, uBand * 0.9, abs(d))) * uGlyphs;

    // The lit limb. One side of the ring is brighter than the other and that
    // side travels, which is what says the thing is turning at speed.
    float sweep = pow(max(0.0, cos(a - uTime * uSweepRate * HTAU)), max(uSweepSharp, 0.05)) * uSweep;

    float grain = 1.0 + (snoise01(vec3(cos(a) * uGrainScale, sin(a) * uGrainScale, uTime * 0.3 + uSeed)) - 0.5) * uGrain;

    // The ring writes itself on from one bearing outward, so it snaps into
    // existence as an arc rather than appearing whole.
    float written = smoothstep(0.0, 0.14, uOpen - fract((a + 3.14159265) / HTAU));
    written = max(written, step(0.999, uOpen));

    float beat = 1.0 + uPulse * 0.5 + uCharge * 0.8;
    float energy = (body * dashed * (1.0 + sweep) + rails + bead * 1.5) * grain * written * beat;
    if (energy < 0.004) discard;

    vec3 color = mix(uColorBody, uColorCore, clamp(rails + bead + sweep * 0.4, 0.0, 1.0));
    color = mix(color, uColorCool, smoothstep(0.6, 1.0, 1.0 - across) * 0.5);
    color *= energy * uIntensity * uFade;

    float alpha = clamp(energy, 0.0, 1.0) * uFade * uOpacity;
    color *= uGlow * uGlobalGlow;
    color /= 1.0 + color * 0.2;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One of the halo rings turning about the column's head.
 *
 * The mesh is a unit annulus the ability tilts, spins and scales; every length
 * below is in the ring's own plane, so a ring leaning forty degrees is shaded
 * exactly like one lying flat.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`
 */
export function createRendHaloMaterial() {
  const material = new ShaderMaterial({
    name: 'RendHalo',
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uOuter: { value: 5 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uCharge: { value: 0 },
      uPulse: { value: 0 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uIntensity: { value: 2.0 },

      uSeat: { value: 4.2 },
      uBand: { value: 0.34 },
      uRails: { value: 1.2 },
      uRailWidth: { value: 0.03 },

      uDashes: { value: 0.45 },
      uDashCount: { value: 40 },
      uDashDuty: { value: 0.62 },
      uDashDrift: { value: 0.03 },

      uGlyphs: { value: 0.9 },
      uGlyphCount: { value: 8 },
      uGlyphSize: { value: 0.03 },

      uSweep: { value: 1.1 },
      uSweepSharp: { value: 2.4 },
      uSweepRate: { value: 0.22 },

      uGrain: { value: 0.35 },
      uGrainScale: { value: 3.0 },
      uOpen: { value: 1 },

      uColorCore: { value: new Color() },
      uColorBody: { value: new Color() },
      uColorCool: { value: new Color() }
    }),
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT
  });

  /** @param {object} state { outer, seat, band, open, charge, pulse, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.rend;
    const g = settings.global;
    const u = material.uniforms;

    u.uOuter.value = state.outer;
    u.uSeat.value = state.seat;
    u.uBand.value = state.band;
    u.uOpen.value = state.open;
    u.uCharge.value = state.charge;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uRails.value = c.haloRails * g.shaderIntensity;
    u.uRailWidth.value = c.haloRailWidth;
    u.uDashes.value = c.haloDashes;
    u.uDashCount.value = Math.max(1, Math.round(c.haloDashCount));
    u.uDashDuty.value = c.haloDashDuty;
    u.uDashDrift.value = c.haloDashDrift * g.animationSpeed;
    u.uGlyphs.value = c.haloGlyphs * g.shaderIntensity;
    u.uGlyphCount.value = Math.max(1, Math.round(c.haloGlyphCount));
    u.uGlyphSize.value = c.haloGlyphSize;
    u.uSweep.value = c.haloSweep;
    u.uSweepSharp.value = c.haloSweepSharp;
    u.uSweepRate.value = c.haloSweepRate * g.animationSpeed;
    u.uGrain.value = c.haloGrain * g.noiseStrength;
    u.uGrainScale.value = c.haloGrainScale * g.noiseFrequency;

    u.uIntensity.value = c.haloIntensity * g.shaderIntensity;
    u.uOpacity.value = c.haloOpacity * g.opacity;
    u.uGlow.value = c.haloGlow * g.glow;

    u.uColorCore.value.copy(getColor(c.colorHaloCore));
    u.uColorBody.value.copy(getColor(c.colorHaloBody));
    u.uColorCool.value.copy(getColor(c.colorHaloCool));
  };

  return material;
}

/* ==================================================================== */
/* 4 · the air the column shoves aside                                   */
/* ==================================================================== */

const WARP_VERTEX = /* glsl */ `
  #define WTAU 6.283185307179586

  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uHeight;

  varying float vClimb;
  varying vec3  vNormalW;
  varying vec3  vWorld;

  void main() {
    float t = position.x;
    float a = position.y;
    float angle = a * WTAU;

    vec3 world = uCentre + vec3(cos(angle), 0.0, sin(angle)) * uRadius;
    world.y += t * uHeight;

    vClimb = t;
    vWorld = world;
    vNormalW = vec3(cos(angle), 0.0, sin(angle));

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const WARP_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uGrown;
  uniform float uRipples;
  uniform float uSpeed;
  uniform float uChop;
  uniform float uChopScale;
  uniform float uShaderIntensity;

  varying float vClimb;
  varying vec3  vNormalW;
  varying vec3  vWorld;

  ${noiseGLSL}

  void main() {
    float live = 1.0 - smoothstep(uGrown - 0.05, uGrown + 0.02, vClimb);
    // Strongest at the foot, where the column is actually pushing on the air,
    // and gone long before the top — a shaft that bends the frame evenly over
    // thirty metres reads as a lens, not as heat.
    float window = live * pow(1.0 - vClimb, 1.7);
    if (window < 0.004) discard;

    vec3 V = normalize(cameraPosition - vWorld);
    float ndv = abs(dot(normalize(vNormalW), V));
    // Only the limb displaces: through the middle of the shaft the offset is
    // toward the camera, which is not a screen direction at all.
    //
    // The second factor is what keeps this from being visible as geometry. A
    // bare (1 - N.V) peaks at *exactly* the silhouette, which is also where the
    // proxy's own hard edge is — so the frame gets its largest displacement
    // along a line where it also stops being displaced at all, and the shaft
    // prints two grey slabs with chromatic fringes down their edges. Rolling the
    // strength off to nothing at the boundary puts the peak just inside it.
    float limb = pow(1.0 - ndv, 1.6) * smoothstep(0.0, 0.25, ndv);

    float chop = snoise(vec3(vNormalW.xz * uChopScale, vClimb * 3.0 - uTime * 0.6)) * uChop;
    float bands = sin(vClimb * uRipples * 6.28318 - uTime * uSpeed + chop);

    vec2 screenDir = (viewMatrix * vec4(vNormalW, 0.0)).xy;
    float len = length(screenDir);
    screenDir = len > 1e-4 ? screenDir / len : vec2(0.0, 1.0);

    float mask = window * limb;
    gl_FragColor = vec4(screenDir * bands * 0.5 + 0.5, uStrength * uShaderIntensity * mask, mask);
  }
`;

/**
 * The refraction proxy around the column.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`
 */
export function createRendWarpMaterial() {
  const material = new ShaderMaterial({
    name: 'RendWarp',
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uRadius: { value: 2.2 },
      uHeight: { value: 30 },
      uGrown: { value: 0 },
      uStrength: { value: 1 },
      uRipples: { value: 3.5 },
      uSpeed: { value: 5.0 },
      uChop: { value: 0.5 },
      uChopScale: { value: 2.2 }
    }),
    vertexShader: WARP_VERTEX,
    fragmentShader: WARP_FRAGMENT
  });

  /** @param {object} state { centre, radius, height, grown, strength } */
  material.userData.sync = (state) => {
    const c = settings.rend;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uRadius.value = state.radius;
    u.uHeight.value = state.height;
    u.uGrown.value = state.grown;
    u.uRipples.value = c.warpRipples;
    u.uSpeed.value = c.warpSpeed;
    u.uChop.value = c.warpChop * g.noiseStrength;
    u.uChopScale.value = c.warpChopScale * g.noiseFrequency;
    u.uStrength.value = state.strength * c.warpStrength * g.distortion;
  };

  return material;
}
