import { AdditiveBlending, Color, DoubleSide, ShaderMaterial, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The ribbons the serpent drags behind it — layer 3 of the breakdown.
 *
 * A whole nest of them is **one draw call**: the geometry is the bolt's
 * instanced strip (`createBoltRibbonGeometry`), and each instance winds its own
 * helix about the flight line from nothing but its instance index. The CPU
 * hands over four vectors a frame — where the nose is, and the frame it is
 * flying in — and never touches a vertex.
 *
 * Three things stop this reading as a machined screw thread, which is what a
 * plain helix looks like:
 *
 *  - the **radius profile** opens just behind the head and closes to a point at
 *    the far end, so a ribbon is a teardrop wrapped around the path rather than
 *    a cylinder;
 *  - each strand carries its own **phase, pitch and radius**, rolled off its
 *    index, so the strands cross each other instead of nesting;
 *  - a low-frequency **wander** pushes the whole helix off axis, which is the
 *    difference between a light ribbon and a spring.
 *
 * The strip is billboarded: the ribbon's own normal is useless here (it has no
 * volume and no lighting), and a fixed one would make a strand vanish edge-on
 * every half turn — which, on a helix, is twice a revolution.
 */

const TRAIL_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI  3.141592653589793

  attribute float aStrand;

  uniform float uTime;
  uniform vec3  uHead;      // the nose, in world space
  uniform vec3  uDir;       // unit heading
  uniform vec3  uSide;
  uniform vec3  uUp;
  uniform float uSeed;
  uniform float uStrands;
  uniform float uSpan;      // metres of path the ribbons reach back over
  uniform float uTurns;
  uniform float uSpin;
  uniform float uRadius;
  uniform float uSwell;
  uniform float uWidth;
  uniform float uWidthTip;
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;
  uniform float uFade;

  varying float vT;
  varying float vV;
  varying float vStrand;
  varying float vViewZ;

  ${noiseGLSL}

  /* Where strand 'phase' sits at t — 0 at the nose, 1 at the far tail. */
  vec3 pathAt(float t, float phase, float radius, float pitch) {
    vec3 axis = uHead - uDir * (t * uSpan);

    // Opens behind the head, closes to a point at the end. uSwell slides the
    // fattest part of the ribbon up and down the path.
    float profile = sin(pow(clamp(t, 0.0, 1.0), max(uSwell, 0.05)) * PI);
    float r = radius * profile;

    float angle = phase + t * pitch * TAU - uTime * uSpin * TAU;
    axis += (uSide * cos(angle) + uUp * sin(angle)) * r;

    // ... and a slow push off the axis, so the helix breathes.
    float w = uWander * profile;
    axis += uSide * snoise(vec3(t * uWanderScale, uTime * uWanderSpeed, phase)) * w;
    axis += uUp * snoise(vec3(t * uWanderScale + 19.7, uTime * uWanderSpeed, phase + 4.3)) * w;
    return axis;
  }

  void main() {
    float strand = aStrand;
    float roll = hash11(strand * 7.13 + uSeed);
    float roll2 = hash11(strand * 3.71 + uSeed + 11.3);

    // Evenly spaced around the axis, then jittered — evenly spaced alone makes
    // the strands read as one rotating cage.
    float phase = (strand / max(uStrands, 1.0)) * TAU + roll * 1.7 + uSeed;
    float radius = uRadius * (0.7 + roll * 0.65);
    float pitch = uTurns * (0.75 + roll2 * 0.6) * (roll2 > 0.5 ? 1.0 : -1.0);

    float t = clamp(position.x, 0.0, 1.0);
    const float H = 0.012;
    vec3 p0 = pathAt(t, phase, radius, pitch);
    vec3 p1 = pathAt(min(t + H, 1.0), phase, radius, pitch);
    vec3 tangent = normalize(p1 - p0 + 1e-6);

    vec3 toEye = normalize(cameraPosition - p0);
    vec3 side = cross(tangent, toEye);
    if (dot(side, side) < 1e-8) side = uSide;
    side = normalize(side);

    // Tapered at both ends: a ribbon that stops dead reads as a cut strip.
    float taper = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.72, 1.0, t));
    float halfWidth = uWidth * mix(1.0, uWidthTip, t) * taper * uFade * (0.7 + roll * 0.6);

    vec3 world = p0 + side * (position.y * halfWidth);

    vT = t;
    vV = position.y;
    vStrand = strand;
    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const TRAIL_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uSharp;
  uniform float uCore;
  uniform float uPulse;
  uniform float uPulseFreq;
  uniform float uPulseSpeed;
  uniform float uFlicker;
  uniform float uFlickerScale;
  uniform float uFlickerSpeed;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorBody;
  uniform vec3  uColorTail;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying float vT;
  varying float vV;
  varying float vStrand;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    /* across the ribbon: a soft body with a hard thread down the middle */
    float across = 1.0 - abs(vV);
    float body = pow(clamp(across, 0.0, 1.0), max(uSharp, 0.05));
    float core = pow(clamp(across, 0.0, 1.0), max(uCore, 1.0));

    /* charge running up the ribbon toward the head */
    float phase = fract(vT * uPulseFreq + uTime * uPulseSpeed + vStrand * 0.37);
    float pulse = pow(1.0 - abs(phase * 2.0 - 1.0), 6.0) * uPulse;

    /* the strand is data, not a wire — let it stutter */
    float flicker = snoise01(vec3(vT * uFlickerScale, uTime * uFlickerSpeed, vStrand * 5.1 + uSeed));
    flicker = mix(1.0, flicker, uFlicker);

    float energy = (body * (1.0 + pulse) + core * 1.6) * flicker;
    // The far end goes to nothing: the ribbon dissolves into the wake instead of
    // ending on a line.
    energy *= 1.0 - smoothstep(0.55, 1.0, vT);

    vec3 color = mix(uColorBody, uColorTail, smoothstep(0.15, 0.8, vT));
    color = mix(color, uColorCore, clamp(core + pulse * 0.7, 0.0, 1.0));
    color *= energy * uIntensity * uShaderIntensity;

    float alpha = clamp(energy, 0.0, 1.0) * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    // Rolled off hard, for the same reason the body is: a ribbon that clips is a
    // white noodle, and the one thing these have to stay is *neon*.
    color /= 1.0 + color * 0.18;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`, where state is
 *   `{ head, dir, side, up, span, strands, fade, seed }`
 */
export function createNeonTrailMaterial() {
  const material = new ShaderMaterial({
    name: 'NeonTrail',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uHead: { value: new Vector3() },
      uDir: { value: new Vector3(0, 0, 1) },
      uSide: { value: new Vector3(1, 0, 0) },
      uUp: { value: new Vector3(0, 1, 0) },
      uSeed: { value: 0 },
      uStrands: { value: 5 },
      uSpan: { value: 6 },
      uTurns: { value: 1.6 },
      uSpin: { value: 0.4 },
      uRadius: { value: 0.75 },
      uSwell: { value: 0.55 },
      uWidth: { value: 0.09 },
      uWidthTip: { value: 0.35 },
      uWander: { value: 0.18 },
      uWanderScale: { value: 2.2 },
      uWanderSpeed: { value: 0.9 },
      uFade: { value: 1 },

      uSharp: { value: 2.4 },
      uCore: { value: 14 },
      uPulse: { value: 1.2 },
      uPulseFreq: { value: 2.4 },
      uPulseSpeed: { value: 1.4 },
      uFlicker: { value: 0.35 },
      uFlickerScale: { value: 7 },
      uFlickerSpeed: { value: 2.4 },
      uIntensity: { value: 3.4 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.4 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorBody: { value: new Color(0.45, 0.95, 1) },
      uColorTail: { value: new Color(0.1, 0.4, 1) }
    }),
    vertexShader: TRAIL_VERTEX,
    fragmentShader: TRAIL_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.cyber;
    const g = settings.global;
    const u = material.uniforms;

    u.uHead.value.copy(state.head);
    u.uDir.value.copy(state.dir);
    u.uSide.value.copy(state.side);
    u.uUp.value.copy(state.up);
    u.uSeed.value = state.seed;
    u.uStrands.value = state.strands;
    u.uSpan.value = state.span;
    u.uFade.value = state.fade;

    u.uTurns.value = c.trailTurns;
    u.uSpin.value = c.trailSpin * g.animationSpeed;
    u.uRadius.value = c.trailRadius;
    u.uSwell.value = c.trailSwell;
    u.uWidth.value = c.trailWidth;
    u.uWidthTip.value = c.trailWidthTip;
    u.uWander.value = c.trailWander * g.noiseStrength;
    u.uWanderScale.value = c.trailWanderScale * g.noiseFrequency;
    u.uWanderSpeed.value = c.trailWanderSpeed * g.noiseSpeed;

    u.uSharp.value = c.trailSharp;
    u.uCore.value = c.trailCore;
    u.uPulse.value = c.trailPulse;
    u.uPulseFreq.value = c.trailPulseFreq;
    u.uPulseSpeed.value = c.trailPulseSpeed * g.noiseSpeed;
    u.uFlicker.value = c.trailFlicker * g.randomness;
    u.uFlickerScale.value = c.trailFlickerScale * g.noiseFrequency;
    u.uFlickerSpeed.value = c.trailFlickerSpeed * g.noiseSpeed;
    u.uIntensity.value = c.trailIntensity;
    u.uOpacity.value = c.trailOpacity * g.opacity;
    u.uSoftFade.value = c.trailSoftFade;

    u.uColorCore.value.copy(getColor(c.colorTrailCore));
    u.uColorBody.value.copy(getColor(c.colorTrail));
    u.uColorTail.value.copy(getColor(c.colorTrailTail));
  };

  return material;
}
