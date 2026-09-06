import { AdditiveBlending, Color, DoubleSide, ShaderMaterial, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The Astral Tendrils — layer 2.
 *
 * The reference sheet's second panel is a knot of long ribbons leaving the floor
 * and winding upward: warm gold ones and cold blue-white ones braided together,
 * each an unbroken line that the eye follows from one end to the other. It is
 * the easiest panel to fake with particles and the most obviously fake when you
 * do — a column of soft sprites has no *continuity*, and continuity is the whole
 * read.
 *
 * So each tendril is one **ribbon**, one instance, placed entirely in the vertex
 * stage from per-instance dice that are hashed out of the instance index. There
 * is no emitter, no pooling and no CPU work per frame: the layer's density is an
 * instance count, and its life is a phase.
 *
 * ## The three terms that make it a braid instead of a spring
 *
 *  - **differential winding.** A tendril seated near the axis laps one seated
 *    out at the boundary, exactly as an accretion disc's inner orbits lap its
 *    outer ones. Uniform winding gives a spring: every strand parallel, no
 *    strand ever crossing another, and the whole column reads as a machined
 *    part. `uShear` is what makes them braid.
 *  - **drawn in at the top.** Over the last stretch of the climb each ribbon is
 *    pulled onto the axis the pillar stands on. That single term is what makes
 *    this layer read as *feeding* the column rather than as smoke that happens
 *    to be in the same shot — and before the pillar exists it is what makes the
 *    tendrils converge on the marked point, which is what panel two is showing.
 *  - **the head.** A bright band travels up each ribbon on its own clock. A
 *    tendril lit evenly along its length is a ribbon; one with a head is
 *    *energy going somewhere*, and it is the cheapest single thing in this file.
 *
 * Billboarded about its own spine — the across-axis is rebuilt per vertex from
 * the camera — so it presents full width from every angle and never shows the
 * paper edge a fixed strip would. The spine is evaluated three times per vertex
 * so the tangent can be taken by finite difference; billboarding a helix about a
 * straight vertical instead of its own curve twists visibly wherever the winding
 * is tightest, and the winding here is very tight indeed.
 */

const TENDRIL_VERTEX = /* glsl */ `
  #define TTAU 6.283185307179586
  #define TPI  3.141592653589793

  attribute float aTendril;

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
  uniform float uWind;
  uniform float uShear;
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;
  uniform float uFlare;
  uniform float uDraw;
  uniform float uDrawAt;
  uniform float uWidth;
  uniform float uWidthBias;
  uniform float uGrow;
  uniform float uSense;

  varying float vClimb;
  varying float vAcross;
  varying float vAlong;
  varying float vSeed;
  varying float vTone;
  varying float vViewZ;

  ${noiseGLSL}

  /**
   * The spine, as a function of how far up the climb it is.
   *
   * Every argument is per-tendril dice; nothing is stored anywhere. The radius
   * is a flare rather than a constant — wide where it leaves the floor, closing
   * as it climbs and then drawn hard onto the axis at the top — because a
   * cylinder of ribbons reads as a cage and a cone of them reads as something
   * being drawn in.
   */
  vec3 tendrilSpine(float c, float bearing, float seat, float height, float turn, float dice) {
    float k = clamp(c, 0.0, 1.0);

    // The flare: the seat is widest at the floor and narrows with the climb.
    float taper = mix(1.0, uFlare, k);
    // ... and over the last stretch it is pulled onto the axis outright.
    float pull = smoothstep(clamp(uDrawAt, 0.0, 0.98), 1.0, k);
    float radius = seat * taper * mix(1.0, clamp(uDraw, 0.0, 1.0), pull);

    // Winding, wound harder the deeper in the strand is seated. Squared in k so
    // the turn accelerates with the climb rather than running at a constant
    // rate, which is what a thing being sucked upward actually does.
    float angle = bearing + turn * (k + k * k) * 0.5;

    vec3 here = uCentre + vec3(cos(angle), 0.0, sin(angle)) * radius;
    here.y += k * height;

    // Two octaves of wander, the second at a third of the amplitude and three
    // times the rate — one sine is a wave, two are a tendril.
    float t = uTime * uWanderSpeed;
    float amp = uWander * smoothstep(0.0, 0.18, k) * (0.35 + 0.65 * k);
    here.x += snoise(vec3(k * uWanderScale, t, dice * 11.0)) * amp;
    here.z += snoise(vec3(k * uWanderScale + 19.7, t, dice * 11.0 + 3.3)) * amp;
    here.x += snoise(vec3(k * uWanderScale * 3.0, t * 1.7, dice * 5.0)) * amp * 0.33;
    here.z += snoise(vec3(k * uWanderScale * 3.0 + 7.1, t * 1.7, dice * 5.0 + 2.1)) * amp * 0.33;

    return here;
  }

  void main() {
    float id = aTendril;
    float d0 = hash11(id * 1.37 + uSeed * 0.7);
    float d1 = hash11(id * 2.71 + uSeed * 1.9);
    float d2 = hash11(id * 3.93 + uSeed * 2.7);
    float d3 = hash11(id * 5.11 + uSeed * 3.3);

    float count = max(uCount, 1.0);
    float bearing = (id + (d0 - 0.5) * uSpread) / count * TTAU + uSeed;
    float seat = uRadius * uSeat * mix(1.0 - uSeatJitter, 1.0, d1);
    float height = uHeight * mix(1.0 - uHeightJitter, 1.0 + uHeightJitter, d2) * max(uGrow, 0.0);

    // Differential winding: a strand seated near the axis laps one out at the
    // boundary. This is the term that braids the layer.
    float depth = 1.0 - clamp((seat / max(uRadius * uSeat, 1e-3) - (1.0 - uSeatJitter)) /
                              max(uSeatJitter, 1e-3), 0.0, 1.0);
    float turn = TTAU * uWind * mix(1.0, 1.0 + uShear, depth);
    // Half of them wind the other way, which is the difference between a braid
    // and a bundle of parallel wires.
    turn *= mix(-1.0, 1.0, step(uSense, d3));

    // One loop per tendril, offset by its own dice so the layer never pulses.
    // The window runs from below the floor to past the top; the ends are faded
    // in the fragment stage rather than clipped here.
    float span = 1.0 + uLength;
    float base = fract(uTime * uRise + d0) * span - uLength;
    float climb = base + position.x * uLength;

    vec3 here   = tendrilSpine(climb,        bearing, seat, height, turn, d0);
    vec3 ahead  = tendrilSpine(climb + 0.015, bearing, seat, height, turn, d0);
    vec3 behind = tendrilSpine(climb - 0.015, bearing, seat, height, turn, d0);
    vec3 tangent = normalize(ahead - behind + vec3(0.0, 1e-4, 0.0));

    vec3 view = normalize(cameraPosition - here);
    vec3 across = cross(tangent, view);
    float len = length(across);
    // Dead on the spine, and the ribbon has no plane to open in. Fall back to
    // anything perpendicular rather than collapsing to a line.
    across = len > 1e-4 ? across / len : normalize(cross(tangent, vec3(1.0, 0.0, 0.0)));

    // Widest low and closing as it climbs, with a sine so both ends come to a
    // point: a ribbon with a square end reads as cut, and nothing here is cut.
    float k = clamp(climb, 0.0, 1.0);
    float profile = pow(1.0 - k, max(uWidthBias, 0.05)) * sin(k * TPI * 0.9 + 0.2);
    float w = uWidth * max(height, 0.05) * max(profile, 0.0) * mix(0.7, 1.3, d1);

    vec3 world = here + across * (position.y * w);

    vClimb = climb;
    vAcross = position.y;
    vAlong = position.x;
    vSeed = d0;
    // Two populations, dealt rather than grouped: the sheet's tendrils are gold
    // and blue-white braided together, and grouping them would put a warm half
    // and a cold half on opposite sides of the column.
    vTone = step(0.5, fract(d3 * 7.3 + d1 * 3.1));

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const TENDRIL_FRAGMENT = /* glsl */ `
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
  uniform float uHead;
  uniform float uHeadWidth;
  uniform float uHeadRate;
  uniform float uHeadFade;
  uniform float uTailFade;
  uniform float uSoftFade;
  uniform vec3  uColorRoot;
  uniform vec3  uColorWarm;
  uniform vec3  uColorCold;
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
  varying float vTone;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    // Outside its own climb the tendril does not exist — this is what the ends
    // of the loop look like, and it costs one smoothstep rather than a branch.
    float live = smoothstep(0.0, uTailFade, vClimb) * (1.0 - smoothstep(1.0 - uHeadFade, 1.0, vClimb));
    if (live < 0.004) discard;

    // Across the ribbon: soft on both sides with a hot filament down the middle,
    // which is what gives a flat strip the read of a round strand.
    float a = clamp(1.0 - abs(vAcross), 0.0, 1.0);
    float across = pow(a, max(uSoftEdge, 0.05));
    float spine = pow(a, max(uSoftEdge, 0.05) * 5.0);

    // Eaten along its length, in its own space, so the break-up travels with the
    // ribbon rather than the ribbon sliding through a field.
    float erode = snoise01(vec3(vAlong * uErodeScale, vClimb * uErodeScale * 0.5 - uTime * uErodeSpeed, vSeed * 23.0));
    erode = mix(1.0, erode, clamp(uErode, 0.0, 1.0));

    // The head: a bright band running up the strand on its own clock. Each
    // tendril gets its own phase out of its own dice, so the layer never
    // strobes as one.
    float at = fract(uTime * uHeadRate + vSeed * 13.7);
    float head = exp(-pow((vClimb - at) / max(uHeadWidth, 0.01), 2.0)) * uHead;

    float energy = across * erode * live * (1.0 + uPulse * 0.5 + uCharge * 0.8);

    vec3 tone = mix(uColorWarm, uColorCold, vTone);
    vec3 color = mix(uColorRoot, tone, smoothstep(0.0, 0.35, vClimb));
    color = mix(color, uColorTip, smoothstep(0.45, 1.0, vClimb));
    color *= energy * uIntensity * uFade;
    // The filament and the head are always the near-white the sheet runs its
    // hottest strands at, whichever population the ribbon belongs to.
    color += uColorTip * (spine * 0.7 + head * 1.6) * erode * live * uIntensity * uFade;

    float alpha = clamp(energy + head * 0.6, 0.0, 1.0) * uFade * uOpacity;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    color /= 1.0 + color * 0.12;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The tendrils.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`
 */
export function createRendTendrilMaterial() {
  const material = new ShaderMaterial({
    name: 'RendTendril',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uCount: { value: 20 },
      uSeed: { value: 0 },
      uRadius: { value: 5 },
      uSeat: { value: 0.85 },
      uSeatJitter: { value: 0.5 },
      uSpread: { value: 0.9 },
      uHeight: { value: 14 },
      uHeightJitter: { value: 0.35 },
      uRise: { value: 0.2 },
      uLength: { value: 0.75 },
      uWind: { value: 1.7 },
      uShear: { value: 0.9 },
      uWander: { value: 0.5 },
      uWanderScale: { value: 1.6 },
      uWanderSpeed: { value: 0.4 },
      uFlare: { value: 0.35 },
      uDraw: { value: 0.16 },
      uDrawAt: { value: 0.62 },
      uWidth: { value: 0.028 },
      uWidthBias: { value: 0.45 },
      uGrow: { value: 0 },
      uSense: { value: 0.35 },

      uFade: { value: 1 },
      uPulse: { value: 0 },
      uCharge: { value: 0 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uIntensity: { value: 1.5 },
      uSoftEdge: { value: 1.4 },
      uErode: { value: 0.45 },
      uErodeScale: { value: 3.2 },
      uErodeSpeed: { value: 0.6 },
      uHead: { value: 0.9 },
      uHeadWidth: { value: 0.11 },
      uHeadRate: { value: 0.55 },
      uHeadFade: { value: 0.4 },
      uTailFade: { value: 0.12 },
      uSoftFade: { value: 0.5 },

      uColorRoot: { value: new Color() },
      uColorWarm: { value: new Color() },
      uColorCold: { value: new Color() },
      uColorTip: { value: new Color() }
    }),
    vertexShader: TENDRIL_VERTEX,
    fragmentShader: TENDRIL_FRAGMENT
  });

  /** @param {object} state { centre, radius, count, height, grow, pulse, charge, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.rend;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uRadius.value = state.radius;
    u.uCount.value = Math.max(1, state.count);
    u.uHeight.value = state.height;
    u.uGrow.value = state.grow;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uCharge.value = state.charge;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uSeat.value = c.tendrilSeat;
    u.uSeatJitter.value = c.tendrilSeatJitter * g.randomness;
    u.uSpread.value = c.tendrilSpread * g.randomness;
    u.uHeightJitter.value = c.tendrilHeightJitter * g.randomness;
    u.uRise.value = c.tendrilRise * g.animationSpeed;
    u.uLength.value = c.tendrilLength;
    u.uWind.value = c.tendrilWind;
    u.uShear.value = c.tendrilShear;
    u.uWander.value = c.tendrilWander * g.noiseStrength;
    u.uWanderScale.value = c.tendrilWanderScale * g.noiseFrequency;
    u.uWanderSpeed.value = c.tendrilWanderSpeed * g.noiseSpeed;
    u.uFlare.value = c.tendrilFlare;
    u.uDraw.value = c.tendrilDraw;
    u.uDrawAt.value = c.tendrilDrawAt;
    u.uWidth.value = c.tendrilWidth;
    u.uWidthBias.value = c.tendrilWidthBias;
    u.uSense.value = c.tendrilCounter;

    u.uIntensity.value = c.tendrilIntensity * g.shaderIntensity;
    u.uSoftEdge.value = c.tendrilSoftEdge;
    u.uErode.value = c.tendrilErode * g.noiseStrength;
    u.uErodeScale.value = c.tendrilErodeScale * g.noiseFrequency;
    u.uErodeSpeed.value = c.tendrilErodeSpeed * g.noiseSpeed;
    u.uHead.value = c.tendrilHead * g.shaderIntensity;
    u.uHeadWidth.value = c.tendrilHeadWidth;
    u.uHeadRate.value = c.tendrilHeadRate * g.animationSpeed;
    u.uHeadFade.value = c.tendrilHeadFade;
    u.uTailFade.value = c.tendrilTailFade;
    u.uSoftFade.value = c.tendrilSoftFade;
    u.uOpacity.value = c.tendrilOpacity * g.opacity;
    u.uGlow.value = c.tendrilGlow * g.glow;

    u.uColorRoot.value.copy(getColor(c.colorTendrilRoot));
    u.uColorWarm.value.copy(getColor(c.colorTendrilWarm));
    u.uColorCold.value.copy(getColor(c.colorTendrilCold));
    u.uColorTip.value.copy(getColor(c.colorTendrilTip));
  };

  return material;
}
