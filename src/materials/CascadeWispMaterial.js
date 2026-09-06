import { AdditiveBlending, Color, DoubleSide, ShaderMaterial, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The rising wisps — layer 2.
 *
 * The reference sheet's second panel is four soft strands leaving the floor and
 * losing themselves on the way up. It is the easiest panel to fake with
 * particles and the most obviously fake when you do: a column of soft sprites
 * has no *continuity*, and continuity is the whole read — a wisp is one
 * unbroken line with an S in it, and the eye follows the line.
 *
 * So each wisp is a **ribbon**, one instance, placed entirely in the vertex
 * stage:
 *
 *  - the spine is a climb around the mark's own axis with two octaves of noise
 *    wandering it. Its shape is a function of how far up it has got, so a wisp
 *    never repeats and no two of them ever agree;
 *  - near the top it is **drawn inward**, onto the axis the crown hangs on.
 *    That single term is what makes this layer read as feeding the burst rather
 *    than as smoke that happens to be in the same shot;
 *  - and it is billboarded about its own spine — the ribbon's across-axis is
 *    rebuilt per vertex from the camera, so it presents full width from every
 *    angle and never shows the paper edge a fixed strip would.
 *
 * Each one lives on its own loop: it enters below the floor, climbs, thins and
 * is gone, and the next cycle starts it again with the same dice. The layer is
 * therefore *steady state* — no emitter, no pooling, no CPU per frame — and its
 * density is one instance count.
 */

const WISP_VERTEX = /* glsl */ `
  #define WTAU 6.283185307179586
  #define WPI  3.141592653589793

  attribute float aWisp;

  uniform float uTime;
  uniform vec3  uCentre;
  uniform float uCount;
  uniform float uSeed;
  uniform float uRadius;
  uniform float uSeat;
  uniform float uSeatJitter;
  uniform float uSpread;
  uniform float uHeight;
  uniform float uHeightJitter;
  uniform float uRise;
  uniform float uLength;
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;
  uniform float uSwirl;
  uniform float uDraw;
  uniform float uDrawAt;
  uniform float uWidth;
  uniform float uWidthBias;
  uniform float uGrow;

  varying float vClimb;
  varying float vAcross;
  varying float vAlong;
  varying float vSeed;
  varying float vViewZ;

  ${noiseGLSL}

  /**
   * The spine, as a function of how far up the climb it is.
   *
   * Every argument is per-wisp dice; nothing is stored. Called three times per
   * vertex so the tangent can be taken by finite difference — a wisp that
   * billboards about a straight vertical instead of its own curve twists
   * visibly wherever the S is steepest.
   */
  vec3 wispSpine(float c, float bearing, float seat, float height, float dice) {
    float k = clamp(c, 0.0, 1.0);

    // Drawn in toward the axis over the top stretch of the climb: this is the
    // term that ties the layer to the crown.
    float pull = smoothstep(clamp(uDrawAt, 0.0, 0.98), 1.0, k);
    float radius = seat * mix(1.0, clamp(uDraw, 0.0, 1.0), pull);
    float turn = bearing + k * uSwirl;

    vec3 here = uCentre + vec3(cos(turn), 0.0, sin(turn)) * radius;
    here.y += k * height;

    // Two octaves of wander, the second at a third of the amplitude and three
    // times the rate — one sine is a wave, two are a wisp.
    float t = uTime * uWanderSpeed;
    float amp = uWander * smoothstep(0.0, 0.25, k);
    here.x += snoise(vec3(k * uWanderScale, t, dice * 11.0)) * amp;
    here.z += snoise(vec3(k * uWanderScale + 19.7, t, dice * 11.0 + 3.3)) * amp;
    here.x += snoise(vec3(k * uWanderScale * 3.0, t * 1.7, dice * 5.0)) * amp * 0.33;
    here.z += snoise(vec3(k * uWanderScale * 3.0 + 7.1, t * 1.7, dice * 5.0 + 2.1)) * amp * 0.33;

    return here;
  }

  void main() {
    float id = aWisp;
    float d0 = hash11(id * 1.37 + uSeed * 0.7);
    float d1 = hash11(id * 2.71 + uSeed * 1.9);
    float d2 = hash11(id * 3.93 + uSeed * 2.7);

    float count = max(uCount, 1.0);
    float bearing = (id + (d0 - 0.5) * uSpread) / count * WTAU + uSeed;
    float seat = uRadius * uSeat * mix(1.0 - uSeatJitter, 1.0, d1);
    float height = uHeight * mix(1.0 - uHeightJitter, 1.0 + uHeightJitter, d2) * max(uGrow, 0.0);

    // One loop per wisp, offset by its own dice so the layer never pulses. The
    // window runs from below the floor to past the top, and the ends are faded
    // in the fragment stage rather than clipped here.
    float span = 1.0 + uLength;
    float base = fract(uTime * uRise + d0) * span - uLength;
    float climb = base + position.x * uLength;

    vec3 here = wispSpine(climb, bearing, seat, height, d0);
    vec3 ahead = wispSpine(climb + 0.02, bearing, seat, height, d0);
    vec3 behind = wispSpine(climb - 0.02, bearing, seat, height, d0);
    vec3 tangent = normalize(ahead - behind + vec3(0.0, 1e-4, 0.0));

    vec3 view = normalize(cameraPosition - here);
    vec3 across = cross(tangent, view);
    float len = length(across);
    // Dead on the spine, and the ribbon has no plane to open in. Fall back to
    // anything perpendicular rather than collapsing to a line.
    across = len > 1e-4 ? across / len : normalize(cross(tangent, vec3(1.0, 0.0, 0.0)));

    // Widest low and closing as it climbs — smoke opens as it rises, but a
    // wisp is what is left of it, and what is left thins.
    float k = clamp(climb, 0.0, 1.0);
    float profile = pow(1.0 - k, max(uWidthBias, 0.05)) * sin(clamp(k, 0.0, 1.0) * WPI * 0.85 + 0.25);
    float w = uWidth * height * max(profile, 0.0);

    vec3 world = here + across * (position.y * w);

    vClimb = climb;
    vAcross = position.y;
    vAlong = position.x;
    vSeed = d0;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const WISP_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uFade;
  uniform float uPulse;
  uniform float uCharge;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uIntensity;
  uniform float uSoftEdge;
  uniform float uErode;
  uniform float uErodeScale;
  uniform float uErodeSpeed;
  uniform float uHeadFade;
  uniform float uTailFade;
  uniform float uSoftFade;
  uniform vec3  uColorRoot;
  uniform vec3  uColorBody;
  uniform vec3  uColorTip;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying float vClimb;
  varying float vAcross;
  varying float vAlong;
  varying float vSeed;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    // Outside its own climb the wisp does not exist — this is what the ends of
    // the loop look like, and it costs one smoothstep rather than a branch.
    float live = smoothstep(0.0, uTailFade, vClimb) * (1.0 - smoothstep(1.0 - uHeadFade, 1.0, vClimb));
    if (live < 0.004) discard;

    // Across the ribbon: soft on both sides, and never a hard edge — this layer
    // has no silhouette, it is the one thing in the ability that is only light.
    float across = pow(clamp(1.0 - abs(vAcross), 0.0, 1.0), max(uSoftEdge, 0.05));

    // Eaten along its length, in its own space, so the break-up travels with it
    // rather than the wisp sliding through a field.
    float erode = snoise01(vec3(vAlong * uErodeScale, vClimb * uErodeScale * 0.5 - uTime * uErodeSpeed, vSeed * 23.0));
    erode = mix(1.0, erode, clamp(uErode, 0.0, 1.0));

    float energy = across * erode * live * (1.0 + uPulse * 0.5 + uCharge * 0.6);

    vec3 color = mix(uColorRoot, uColorBody, smoothstep(0.0, 0.4, vClimb));
    color = mix(color, uColorTip, smoothstep(0.35, 1.0, vClimb));
    color *= energy * uIntensity * uFade;

    float alpha = clamp(energy, 0.0, 1.0) * uFade * uOpacity;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    color /= 1.0 + color * 0.12;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The wisps.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`
 */
export function createCascadeWispMaterial() {
  const material = new ShaderMaterial({
    name: 'CascadeWisp',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uCount: { value: 12 },
      uSeed: { value: 0 },
      uRadius: { value: 4 },
      uSeat: { value: 0.62 },
      uSeatJitter: { value: 0.45 },
      uSpread: { value: 0.8 },
      uHeight: { value: 4.2 },
      uHeightJitter: { value: 0.3 },
      uRise: { value: 0.16 },
      uLength: { value: 0.62 },
      uWander: { value: 0.55 },
      uWanderScale: { value: 1.7 },
      uWanderSpeed: { value: 0.35 },
      uSwirl: { value: 0.9 },
      uDraw: { value: 0.22 },
      uDrawAt: { value: 0.45 },
      uWidth: { value: 0.09 },
      uWidthBias: { value: 0.5 },
      uGrow: { value: 0 },

      uFade: { value: 1 },
      uPulse: { value: 0 },
      uCharge: { value: 0 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uIntensity: { value: 1.3 },
      uSoftEdge: { value: 1.5 },
      uErode: { value: 0.55 },
      uErodeScale: { value: 3.4 },
      uErodeSpeed: { value: 0.5 },
      uHeadFade: { value: 0.45 },
      uTailFade: { value: 0.12 },
      uSoftFade: { value: 0.5 },

      uColorRoot: { value: new Color() },
      uColorBody: { value: new Color() },
      uColorTip: { value: new Color() }
    }),
    vertexShader: WISP_VERTEX,
    fragmentShader: WISP_FRAGMENT
  });

  /** @param {object} state { centre, radius, count, grow, pulse, charge, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.cascade;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uRadius.value = state.radius;
    u.uCount.value = Math.max(1, state.count);
    u.uGrow.value = state.grow;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uCharge.value = state.charge;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uSeat.value = c.wispSeat;
    u.uSeatJitter.value = c.wispSeatJitter * g.randomness;
    u.uSpread.value = c.wispSpread * g.randomness;
    u.uHeight.value = c.wispHeight;
    u.uHeightJitter.value = c.wispHeightJitter * g.randomness;
    u.uRise.value = c.wispRise * g.animationSpeed;
    u.uLength.value = c.wispLength;
    u.uWander.value = c.wispWander * g.noiseStrength;
    u.uWanderScale.value = c.wispWanderScale * g.noiseFrequency;
    u.uWanderSpeed.value = c.wispWanderSpeed * g.noiseSpeed;
    u.uSwirl.value = c.wispSwirl;
    u.uDraw.value = c.wispDraw;
    u.uDrawAt.value = c.wispDrawAt;
    u.uWidth.value = c.wispWidth;
    u.uWidthBias.value = c.wispWidthBias;

    u.uIntensity.value = c.wispIntensity * g.shaderIntensity;
    u.uSoftEdge.value = c.wispSoftEdge;
    u.uErode.value = c.wispErode * g.noiseStrength;
    u.uErodeScale.value = c.wispErodeScale * g.noiseFrequency;
    u.uErodeSpeed.value = c.wispErodeSpeed * g.noiseSpeed;
    u.uHeadFade.value = c.wispHeadFade;
    u.uTailFade.value = c.wispTailFade;
    u.uSoftFade.value = c.wispSoftFade;
    u.uOpacity.value = c.wispOpacity * g.opacity;
    u.uGlow.value = c.wispGlow * g.glow;

    u.uColorRoot.value.copy(getColor(c.colorWispRoot));
    u.uColorBody.value.copy(getColor(c.colorWispBody));
    u.uColorTip.value.copy(getColor(c.colorWispTip));
  };

  return material;
}
