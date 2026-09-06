import { ShaderMaterial, NormalBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The cosmic shockwave — layer 5: an expanding planar ring of astral energy,
 * displacing the ground and the air.
 *
 * Two materials, both drawn on the same annulus, because a shockwave is two
 * things at once and they belong to different passes:
 *
 *  - `createCosmicRingMaterial` is what you *see* — the wave packet itself,
 *    lying on the floor, a hot violet-gold band with radial filaments streaming
 *    through it;
 *  - `createShockWarpMaterial` is what it *does* — an invisible proxy on
 *    LAYER.DISTORTION that stretches the frame outward along the wavefront, so
 *    the stone and the dummies behind the ring visibly shove aside as it goes
 *    past them.
 *
 * ## Three things stop it reading as UI
 *
 * **It is not a circle.** The front is displaced by noise on its own bearing,
 * so the wave runs faster over some ground than others — the single detail that
 * separates a blast wave from a progress ring.
 *
 * **It has a lip.** The annulus is tessellated radially and the vertex stage
 * lifts the wave packet off the floor, so the crest is a low curtain of
 * displaced air rather than a decal. It catches the eye at exactly the grazing
 * angles a flat ring disappears at.
 *
 * **It is footprint-aware.** Fine detail — the filaments, the grain, the
 * leading edge — is faded out as one pixel outgrows the features it is drawing,
 * the same thing a mip chain does for a texture. Without it the far arc of any
 * ground shader in this sandbox resolves into a band of white speckle that
 * looks like a bolt of lightning lying on the floor. The band width is floored
 * at a pixel too, with the brightness scaled by how far it had to be widened,
 * so the energy is conserved rather than lost.
 */

const RING_VERTEX = /* glsl */ `
  uniform float uReach;    // radius of the outermost vertex, metres
  uniform float uFront;    // where the wavefront is, metres
  uniform float uWidth;    // depth of the wave packet, metres
  uniform float uLift;     // how far the crest stands off the floor, metres

  varying vec2  vLocal;    // metres from the centre, on the floor
  varying float vPacket;   // how far up the crest this vertex is, 0..1

  void main() {
    // RingGeometry is authored in the XY plane and the mesh is laid flat, so
    // the local frame is (x, z) once it is on the floor and local +Z is up.
    vec2 plane = position.xy * uReach;
    float r = length(plane);

    float d = r - uFront;
    float w = max(uWidth, 0.05);
    float packet = exp(-(d * d) / (w * w));

    vLocal = plane;
    vPacket = packet;

    vec3 scaled = vec3(plane, packet * uLift);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(scaled, 1.0);
  }
`;

const RING_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uFront;
  uniform float uWidth;
  uniform float uWobble;      // how far the front wanders off a circle, metres
  uniform float uWobbleScale;
  uniform float uSpokes;      // filaments streaming through the band
  uniform float uSpokeSharp;
  uniform float uSpokeDrift;  // how fast they slide round it
  uniform float uEdge;        // brightness of the hot leading line
  uniform float uTrail;       // the wash left behind the wave
  uniform float uGrain;
  uniform float uGrainScale;
  uniform float uGlow;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uSeed;
  uniform vec3  uColorHot;
  uniform vec3  uColorBody;
  uniform vec3  uColorCool;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec2  vLocal;
  varying float vPacket;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float r = length(vLocal);
    if (r < 0.001) discard;

    vec2 dir = vLocal / r;
    float ang = atan(dir.y, dir.x);

    // How much floor one pixel covers here. Everything fine is faded out as it
    // outgrows its own features, and the band is floored at it.
    float footprint = max(fwidth(vLocal.x), fwidth(vLocal.y));
    float detail = 1.0 - smoothstep(0.02, 0.16, footprint);

    // A blast wave rolls faster over some ground than others.
    float wobble = snoise(vec3(dir * uWobbleScale, uSeed)) * uWobble;
    float d = r - (uFront + wobble * detail);

    float want = max(uWidth, 0.05);
    float w = max(want, footprint * 1.5);
    float window = exp(-(d * d) / (w * w));
    // Energy kept as the band is widened for the far arc, rather than a thin
    // line quietly turning into a fat pale one.
    window *= want / w;
    if (window < 0.004) discard;

    /* ---- the filaments streaming through the packet ---- */
    // Two noises, and it takes both. The phase one slides the teeth around,
    // but a phase shift of a couple of radians is a tenth of a period when
    // there are thirty of them, so on its own it leaves the ring visibly
    // regular — a cog stamped on the floor. The gain one kills some filaments
    // outright and doubles others, which is what actually breaks the rhythm: a
    // real front is torn where the ground gave way and smooth where it did not.
    float drift = uTime * uSpokeDrift + uSeed * 4.0;
    float spokeNoise = snoise(vec3(dir * 3.4, uTime * 0.6 + uSeed)) * 1.8;
    float spokeGain = 0.2 + 1.5 * snoise01(vec3(dir * 6.5, uSeed * 3.0));
    float spokes = pow(0.5 + 0.5 * cos(ang * uSpokes + drift + spokeNoise), uSpokeSharp);
    spokes = mix(1.0, 0.25 + spokes * spokeGain * 1.6, detail);

    /* ---- the hot line at the very front ---- */
    float lead = exp(-pow((d - w * 0.4) / (w * 0.32), 2.0)) * uEdge * detail;

    /* ---- and the wash it leaves behind ---- */
    // Decaying, and it has to be: a smoothstep here saturates and then *stays*
    // saturated all the way to the middle, which covers the whole footprint in
    // a flat violet film — and from a low camera that film reads as a
    // translucent dome standing over the arena. An exponential dies behind the
    // front instead, which is what a wake does.
    float behind = d < 0.0 ? uTrail * exp(d / max(uWidth * 2.5, 0.05)) : 0.0;
    float grain = snoise01(vec3(vLocal * uGrainScale, uSeed * 7.0));
    behind *= mix(1.0, 0.4 + grain * 1.2, uGrain * detail);

    float body = window * spokes;
    float energy = body + lead + behind;
    if (energy < 0.003) discard;

    // Hot on the crest, violet through the body, indigo in the wash: a wave
    // that cools as it passes, which is the read that says it carried energy.
    vec3 color = mix(uColorCool, uColorBody, clamp(body * 1.6, 0.0, 1.0));
    // Only the leading line goes white. The crest carries a hint of it so the
    // lifted curtain reads as hotter than the wake, but push that term and the
    // whole lip blows out into a bright cog stamped on the floor.
    color = mix(color, uColorHot, clamp(lead + vPacket * 0.12, 0.0, 1.0));
    color *= uGlow * uShaderIntensity * uGlobalGlow * uFade;

    float alpha = clamp(energy * 0.9, 0.0, 1.0) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    // Premultiplied, so the ring adds light to the stone rather than painting a
    // flat wash over it — the floor's own grain has to stay visible through it.
    gl_FragColor = vec4(color * energy, alpha);
  }
`;

/**
 * The visible wave. The mesh is a unit annulus scaled entirely in the shader,
 * so `shockRadius` re-scales a wave that is already travelling.
 */
export function createCosmicRingMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    premultipliedAlpha: true,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uReach: { value: 12 },
      uFront: { value: 0 },
      uWidth: { value: 0.9 },
      uLift: { value: 0.45 },
      uWobble: { value: 0.5 },
      uWobbleScale: { value: 2.6 },
      uSpokes: { value: 26 },
      uSpokeSharp: { value: 2.4 },
      uSpokeDrift: { value: 0.8 },
      uEdge: { value: 1.3 },
      uTrail: { value: 0.22 },
      uGrain: { value: 0.6 },
      uGrainScale: { value: 1.6 },
      uGlow: { value: 2.2 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uSeed: { value: 0 },
      uColorHot: { value: new Color(1, 0.93, 0.78) },
      uColorBody: { value: new Color(0.68, 0.36, 1) },
      uColorCool: { value: new Color(0.18, 0.08, 0.4) }
    }),
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT
  });

  /**
   * @param {object} state { reach, front, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.astral;
    const g = settings.global;
    const u = material.uniforms;

    u.uReach.value = state.reach;
    u.uFront.value = state.front;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uWidth.value = c.shockWidth;
    u.uLift.value = c.shockLift;
    u.uWobble.value = c.shockWobble * g.noiseStrength;
    u.uWobbleScale.value = c.shockWobbleScale * g.noiseFrequency;
    u.uSpokes.value = Math.round(c.shockSpokes);
    u.uSpokeSharp.value = c.shockSpokeSharp;
    u.uSpokeDrift.value = c.shockSpokeDrift * g.noiseSpeed;
    u.uEdge.value = c.shockEdge;
    u.uTrail.value = c.shockTrail;
    u.uGrain.value = c.shockGrain;
    u.uGrainScale.value = c.shockGrainScale * g.noiseFrequency;
    u.uGlow.value = c.shockGlow * g.glow;
    u.uOpacity.value = c.shockOpacity * g.opacity;

    u.uColorHot.value.copy(getColor(c.colorShockHot));
    u.uColorBody.value.copy(getColor(c.colorShockBody));
    u.uColorCool.value.copy(getColor(c.colorShockCool));
  };

  return material;
}

/* -------------------------------------------------------------------- */
/* the air it shoves aside                                              */
/* -------------------------------------------------------------------- */

const WARP_VERTEX = /* glsl */ `
  uniform float uReach;

  varying vec2 vLocal;

  void main() {
    vec2 plane = position.xy * uReach;
    vLocal = plane;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(plane, 0.0, 1.0);
  }
`;

const WARP_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uFront;
  uniform float uWidth;
  uniform float uRipples;
  uniform float uStrength;
  uniform float uChop;
  uniform float uChopScale;
  uniform float uShaderIntensity;

  varying vec2 vLocal;

  ${noiseGLSL}

  void main() {
    float r = length(vLocal);
    if (r < 0.001) discard;

    vec2 dir = vLocal / r;
    float chop = snoise(vec3(dir * uChopScale, uTime * 0.35)) * uChop;
    float d = r - (uFront + chop);

    float window = exp(-(d * d) / max(0.02, uWidth * uWidth));
    if (window < 0.004) discard;
    float bands = sin(d * uRipples - uTime * 7.0);

    // The outward direction in world space, rotated into view space and read as
    // a screen direction: this is what makes the warp stretch *away* from the
    // blast instead of shimmering in place. The z is negated because the mesh
    // is laid flat by a -90 degree turn about X, which sends local +Y to world
    // -Z — get that sign wrong and half the ring shoves the frame inward.
    vec3 outward = normalize(vec3(vLocal.x, 0.0, -vLocal.y));
    vec2 screenDir = (viewMatrix * vec4(outward, 0.0)).xy;
    float len = length(screenDir);
    screenDir = len > 1e-4 ? screenDir / len : vec2(0.0, 1.0);

    gl_FragColor = vec4(screenDir * bands * 0.5 + 0.5, uStrength * uShaderIntensity * window, window);
  }
`;

/** The wavefront's pressure, written into the refraction buffer. */
export function createShockWarpMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uReach: { value: 12 },
      uFront: { value: 0 },
      uWidth: { value: 1.1 },
      uRipples: { value: 6 },
      uStrength: { value: 1 },
      uChop: { value: 0.4 },
      uChopScale: { value: 2.6 }
    }),
    vertexShader: WARP_VERTEX,
    fragmentShader: WARP_FRAGMENT
  });

  /**
   * @param {object} state { reach, front, strength }
   */
  material.userData.sync = (state) => {
    const c = settings.astral;
    const g = settings.global;
    const u = material.uniforms;

    u.uReach.value = state.reach;
    u.uFront.value = state.front;
    u.uWidth.value = c.warpWidth;
    u.uRipples.value = c.warpRipples;
    u.uChop.value = c.warpChop * g.noiseStrength;
    u.uChopScale.value = c.warpChopScale * g.noiseFrequency;
    u.uStrength.value = state.strength * c.warpStrength * g.distortion;
  };

  return material;
}
