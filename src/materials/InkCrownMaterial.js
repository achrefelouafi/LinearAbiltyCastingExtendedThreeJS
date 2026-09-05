import { ShaderMaterial, NormalBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The two pieces of standing water: the crown at the boundary, and the jet up
 * the middle.
 *
 * Both are **lathes whose whole shape lives in the vertex stage**. The mesh
 * handed to either one is a bare unit cylinder — radius 1, y from 0 to 1 — and
 * every metre of silhouette is built here from `settings.ink`, which is what
 * lets `zoneRadius` and `crownHeight` re-shape a crown that is already standing
 * and why neither of them ever rebuilds a buffer.
 *
 * ## The crown
 *
 * The milk-crown the reference sheet is built around: a wall of water thrown up
 * where the mass landed. Three things make it read as water rather than as a
 * cylinder with a shader on it, and all three are in the vertex stage:
 *
 *  - the rim is **scalloped into fingers**, irregularly, so the top edge is a
 *    row of tips rather than a lathe's clean circle;
 *  - the fingers **lean outward as they fall**, because a crown collapses by
 *    falling away from its own axis, not by shrinking;
 *  - the crest is **torn**: a dissolve threshold that climbs with height eats
 *    the top of the wall into spray. Without it the wall ends on a hard line,
 *    and a hard line at the top of standing water is the single most obvious
 *    tell in the whole ability.
 *
 * ## The column
 *
 * The jet: wide at the foot, pinched at the neck, swollen into a head that
 * comes apart into droplets. It is nearly black — this is ink being thrown, not
 * water — with a teal fresnel down its wall and white only where it breaks.
 *
 * Both are alpha blended and lit off one key direction plus a fresnel scale.
 * There is no environment map here on purpose: the stage is dark, and a mirror
 * finish on a black column reads as plastic.
 */

/** Shared by both lathes: the noise, and the frame a lathe vertex lives in. */
const LATHE_COMMON = /* glsl */ `
  #define TAU 6.28318530718

  /**
   * The bearing of a lathe vertex, and its height parameter.
   *
   * Taken off the ring position rather than off the UV, so the shape does not
   * depend on how three happens to seam the cylinder.
   */
  float bearingOf(vec3 p) {
    return atan(p.z, p.x);
  }

  /**
   * The jet's radius at height v.
   *
   * The two smoothsteps overlap on purpose: a profile built from hard segments
   * creases at the joins, and a crease down a column of water reads as a lathe.
   */
  float jetProfile(float v, float foot, float neck, float head) {
    float r = mix(foot, neck, smoothstep(0.0, 0.42, v));
    return mix(r, head, smoothstep(0.58, 1.0, v));
  }
`;

/* ==================================================================== */
/* The crown                                                             */
/* ==================================================================== */

const CROWN_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uRadius;
  uniform float uHeight;
  uniform float uRise;
  uniform float uFall;
  uniform float uFingers;
  uniform float uFingerDepth;
  uniform float uFlare;
  uniform float uCurl;
  uniform float uLean;
  uniform float uWobble;
  uniform float uWobbleScale;
  uniform float uSpin;
  uniform float uSwell;
  uniform float uSeed;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vUp;
  varying float vBearing;
  varying float vFinger;
  varying float vViewZ;

  ${noiseGLSL}
  ${LATHE_COMMON}

  void main() {
    float a = bearingOf(position);
    float v = uv.y;

    // The wall wanders off true. Sampled on the *bearing* rather than on world
    // position, so the wander belongs to the crown and turns with it.
    vec2 ring = vec2(cos(a), sin(a));
    float wander = snoise(vec3(ring * uWobbleScale, uSeed));

    // The scallops — and they are *ridged noise*, not a cosine.
    //
    // Two look-dev passes were spent trying to beat a sawtooth out of a
    // sinusoid by pushing its phase and its amplitude around, and neither
    // worked: a periodic function gives peaks of one width at one spacing, and
    // at 29 of them around a circle the rim reads as a saw blade whatever is
    // done to their heights. Ridged noise has crests wherever the field crosses
    // zero, so their spacing, width and height all vary on their own — which is
    // what a crown of water actually looks like. uFingers still sets roughly
    // how many: the 0.16 is 1/(2 pi), so the count means what it says.
    float n1 = snoise(vec3(ring * uFingers * 0.16, uSeed + uTime * uSpin));
    float n2 = snoise(vec3(ring * uFingers * 0.41, uSeed * 3.0 - uTime * uSpin * 0.7));
    float finger = 1.0 - abs(n1 * 0.68 + n2 * 0.32 + wander * 0.12);
    // Raised to a power, not thresholded: this wants a low continuous wall with
    // narrow spikes standing out of it, and a smoothstep would flatten every
    // peak to one height and every trough to one floor.
    finger = pow(clamp(finger, 0.0, 1.0), 2.4);

    // How tall this finger stands. The swell lifts the whole rim, so the crown
    // heaves with the same envelope that is turning the vortex under it.
    float h = uHeight * mix(1.0 - uFingerDepth, 1.0, finger) * uRise * (1.0 + uSwell * 0.18);

    // The radius, and its slope — the slope is what gives the wall its normal.
    float base = uRadius * (1.0 + uWobble * wander);
    float lean = uFlare + uLean * uFall;
    float r = base * (1.0 + lean * v) - uCurl * base * v * v;
    float dr = base * lean - 2.0 * uCurl * base * v;

    vec3 world = vec3(ring.x * r, h * v, ring.y * r);

    // Cross the two surface tangents. For a plumb wall this is the outward
    // ring normal; for a flaring one it tips down, which is what puts the key
    // light on the outside of the crown and not on its lip.
    vec3 nrm = normalize(vec3(ring.x * h, -dr, ring.y * h) + vec3(0.0, 1e-4, 0.0));

    vec4 worldPos = modelMatrix * vec4(world, 1.0);
    vec4 viewPos = viewMatrix * worldPos;

    vUv = uv;
    vUp = v;
    vBearing = a;
    vFinger = finger;
    vNormalW = normalize(mat3(modelMatrix) * nrm);
    vViewDir = cameraPosition - worldPos.xyz;
    vViewZ = -viewPos.z;

    gl_Position = projectionMatrix * viewPos;
  }
`;

const CROWN_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uTear;
  uniform float uTearScale;
  uniform float uFoam;
  uniform float uFresnel;
  uniform float uStreak;
  uniform float uStreakScale;
  uniform float uInk;
  uniform float uSwell;
  uniform float uRise;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;
  uniform float uSeed;
  uniform vec3  uColorWater;
  uniform vec3  uColorDeep;
  uniform vec3  uColorFoam;
  uniform vec3  uColorInk;
  uniform vec3  uColorRim;

  uniform vec3  uLightDir;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vUp;
  varying float vBearing;
  varying float vFinger;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    vec3 L = normalize(uLightDir);

    // Sampled on the bearing and the height, so the structure is welded to the
    // wall instead of swimming across it as the crown turns. Two octaves: the
    // coarse one decides which sheets of water are still joined, the fine one
    // shreds their edges. One octave tears the wall into smooth-edged holes,
    // which reads as a stencil.
    vec2 ring = vec2(cos(vBearing), sin(vBearing));
    float sheet = snoise01(vec3(ring * uTearScale, vUp * uTearScale * 0.6 - uTime * 0.35 + uSeed));
    sheet = sheet * 0.68
          + snoise01(vec3(ring * uTearScale * 3.1, vUp * uTearScale * 1.8 - uTime * 0.9 + uSeed)) * 0.32;

    /* ---- the crest is torn, not cut ---- */
    // The threshold climbs with height: solid through the body of the wall,
    // ragged at the tips, gone above them. This is the whole difference between
    // standing water and a cylinder.
    float tearAt = smoothstep(0.35, 1.05, vUp) * (0.55 + uTear * 0.55) - 0.05;
    float body = smoothstep(tearAt, tearAt + 0.28, sheet);
    if (body < 0.01) discard;

    // The bright rim along every torn edge.
    //
    // This is the single term that turns the wall from a cut-out into water. A
    // sheet of water is nearly invisible through its middle and *bright at its
    // boundary*, where the surface curves through the view direction — so the
    // edge of every hole the tear opens has to be lit, not just the outline of
    // the mesh. Without it the crown is a filled shape whose silhouette happens
    // to be ragged, which is exactly how it read on the first pass.
    float edge = clamp(body - smoothstep(tearAt + 0.07, tearAt + 0.36, sheet), 0.0, 1.0);

    /* ---- ink running down the inside ---- */
    // Vertical, because it is being carried down by the water, and stretched:
    // the sampling frequency around the wall is far higher than up it.
    float streak = snoise01(vec3(ring * uStreakScale, vUp * 0.7 - uTime * 0.5 + uSeed * 3.0));
    streak = pow(streak, 1.6) * uStreak;
    // Heaviest at the foot, where the ink actually is.
    streak *= 1.0 - smoothstep(0.15, 0.9, vUp);

    /* ---- the foam on the crest ---- */
    // Only the last of the wall, and broken by the same noise that is tearing
    // it. Carried further down, the whole upper half of every finger goes white
    // and the crown reads as a ring of paper triangles — which is precisely
    // what it did before this threshold was moved.
    float crest = smoothstep(0.72, 1.0, vUp) * (0.25 + vFinger * 0.75);
    float foam = crest * uFoam * smoothstep(0.35, 0.9, sheet);

    /* ---- shading ---- */
    float lambert = clamp(dot(N, L), 0.0, 1.0);
    // A scale, not a power: the rim gain is what draws the silhouette of a wall
    // this dark, and raising a power here only ever makes it thinner.
    float rim = fresnelTerm(V, N, 2.2, uFresnel);
    vec3 H = normalize(L + V);
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), 60.0) * 0.8;

    // Thin at the tips, deep at the foot — water gets its form from thickness.
    vec3 color = mix(uColorDeep, uColorWater, 0.2 + vUp * 0.6);
    color = mix(color, uColorInk, clamp(streak * uInk, 0.0, 1.0));
    color *= mix(0.5, 1.15, lambert);
    color += uColorRim * rim * 0.5;
    color = mix(color, uColorFoam, clamp(foam + edge * 0.65, 0.0, 1.0));
    color += uColorFoam * spec * (0.2 + foam);

    // Weighted onto the edges rather than onto the sheet. A wall of water is
    // nearly invisible face-on and bright where it is torn; give the body a
    // high flat alpha and it becomes a painted cylinder.
    float alpha = body * (0.14 + rim * 0.4 + foam * 0.7 + edge * 0.85) * uRise;
    // Faded into the pool at its foot. The wall is dark near the floor, so the
    // near side of the crown otherwise draws a hard black scalloped band across
    // the water in front of it — a row of teeth, which is what the second
    // look-dev pass showed. Water rises *out* of a surface; it does not sit on
    // one with an edge.
    alpha *= smoothstep(0.0, 0.16, vUp);
    alpha *= uFade * uOpacity;

    // Softened where it meets anything solid, so the wall does not slice a body
    // standing against it.
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.006) discard;

    color *= uGlow * uGlobalGlow * (1.0 + uSwell * 0.2);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

export function createInkCrownMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    // Both faces: the inside of the far wall is most of what the camera sees of
    // a crown, and it is the face the ink actually runs down.
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uRadius: { value: 5 },
      uHeight: { value: 2 },
      uRise: { value: 0 },
      uFall: { value: 0 },
      uFingers: { value: 17 },
      uFingerDepth: { value: 0.62 },
      uFlare: { value: 0.16 },
      uCurl: { value: 0.1 },
      uLean: { value: 0.34 },
      uWobble: { value: 0.06 },
      uWobbleScale: { value: 2.8 },
      uSpin: { value: 0.1 },
      uTear: { value: 0.55 },
      uTearScale: { value: 3.2 },
      uFoam: { value: 1.2 },
      uFresnel: { value: 1.35 },
      uStreak: { value: 0.7 },
      uStreakScale: { value: 5.5 },
      uInk: { value: 0.55 },
      uSwell: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uSoftFade: { value: 0.5 },
      uSeed: { value: 0 },
      uColorWater: { value: new Color(0.11, 0.37, 0.41) },
      uColorDeep: { value: new Color(0.03, 0.13, 0.16) },
      uColorFoam: { value: new Color(0.9, 0.96, 0.94) },
      uColorInk: { value: new Color(0.02, 0.03, 0.04) },
      uColorRim: { value: new Color(0.56, 0.85, 0.82) }
    }),
    vertexShader: CROWN_VERTEX,
    fragmentShader: CROWN_FRAGMENT
  });

  /** @param {object} state { radius, height, rise, fall, swell, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.ink;
    const g = settings.global;
    const u = material.uniforms;

    u.uRadius.value = state.radius;
    u.uHeight.value = state.height;
    u.uRise.value = state.rise;
    u.uFall.value = state.fall;
    u.uSwell.value = state.swell * c.swellDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uFingers.value = Math.round(c.crownFingers);
    u.uFingerDepth.value = c.crownFingerDepth;
    u.uFlare.value = c.crownFlare;
    u.uCurl.value = c.crownCurl;
    u.uLean.value = c.crownLean;
    u.uWobble.value = c.crownWobble * g.noiseStrength;
    u.uWobbleScale.value = c.crownWobbleScale * g.noiseFrequency;
    u.uSpin.value = c.crownSpin;
    u.uTear.value = c.crownTear;
    u.uTearScale.value = c.crownTearScale * g.noiseFrequency;
    u.uFoam.value = c.crownFoam;
    u.uFresnel.value = c.crownFresnel * g.fresnel;
    u.uStreak.value = c.crownStreak;
    u.uStreakScale.value = c.crownStreakScale * g.noiseFrequency;
    u.uInk.value = c.crownInk;
    u.uOpacity.value = c.crownOpacity * g.opacity;
    u.uGlow.value = c.crownGlow * g.glow;
    u.uSoftFade.value = c.crownSoftFade;

    u.uColorWater.value.copy(getColor(c.colorWater));
    u.uColorDeep.value.copy(getColor(c.colorWaterDeep));
    u.uColorFoam.value.copy(getColor(c.colorFoam));
    u.uColorInk.value.copy(getColor(c.colorInk));
    u.uColorRim.value.copy(getColor(c.colorRim));
  };

  return material;
}

/* ==================================================================== */
/* The column                                                            */
/* ==================================================================== */

const COLUMN_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uRadius;
  uniform float uHeight;
  uniform float uRise;
  uniform float uFoot;
  uniform float uNeck;
  uniform float uHead;
  uniform float uWobble;
  uniform float uWobbleScale;
  uniform float uSpin;
  uniform float uSwell;
  uniform float uSeed;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vUp;
  varying float vBearing;
  varying float vViewZ;

  ${noiseGLSL}
  ${LATHE_COMMON}

  void main() {
    float a = bearingOf(position);
    float v = uv.y;

    // The jet turns as it climbs — the same rotation the vortex under it is
    // running, which is what marries the two.
    float turn = uTime * uSpin * TAU * (0.35 + v);
    vec2 ring = vec2(cos(a + turn), sin(a + turn));

    // Wide foot, pinched neck, swollen head.
    float profile = jetProfile(v, uFoot, uNeck, uHead);
    float r = uRadius * profile * (1.0 + uSwell * 0.12);

    // Off plumb: the whole column leans and wanders, more the higher it gets.
    float t = uTime * 0.6 + uSeed;
    vec2 wander = vec2(
      snoise(vec3(v * uWobbleScale, t, uSeed)),
      snoise(vec3(v * uWobbleScale, t, uSeed + 31.7))
    ) * uWobble * uRadius * v * v;

    float y = uHeight * v * uRise;
    vec3 world = vec3(ring.x * r + wander.x, y, ring.y * r + wander.y);

    // dr/dv, for the same reason the crown needs it. Taken as a difference
    // rather than differentiated by hand: the profile is two overlapping
    // smoothsteps, and the closed form for that is longer than it is useful.
    float e = 0.02;
    float dr = uRadius
      * (jetProfile(v + e, uFoot, uNeck, uHead) - jetProfile(v - e, uFoot, uNeck, uHead))
      / (2.0 * e);
    vec3 nrm = normalize(vec3(ring.x * max(uHeight * uRise, 0.05), -dr, ring.y * max(uHeight * uRise, 0.05)));

    vec4 worldPos = modelMatrix * vec4(world, 1.0);
    vec4 viewPos = viewMatrix * worldPos;

    vUv = uv;
    vUp = v;
    vBearing = a;
    vNormalW = normalize(mat3(modelMatrix) * nrm);
    vViewDir = cameraPosition - worldPos.xyz;
    vViewZ = -viewPos.z;

    gl_Position = projectionMatrix * viewPos;
  }
`;

const COLUMN_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uTear;
  uniform float uInk;
  uniform float uFoam;
  uniform float uFresnel;
  uniform float uRise;
  uniform float uSwell;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;
  uniform float uSeed;
  uniform vec3  uColorWater;
  uniform vec3  uColorDeep;
  uniform vec3  uColorFoam;
  uniform vec3  uColorInk;
  uniform vec3  uColorRim;

  uniform vec3  uLightDir;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vUp;
  varying float vBearing;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    vec3 L = normalize(uLightDir);

    // Two octaves, and the vertical frequency is the high one. Sampled coarsely
    // up the jet, every ring of the lathe lands in the same slice of the field
    // and the column stripes into visible hoops — which is what it did on the
    // first look-dev pass, and reads as a wireframe cone.
    // Sampled as a genuine 3D field: the bearing carries the two coordinates
    // that vary *around* the jet and the height only the third. Driving the
    // height at a much higher frequency than the bearing makes every point at a
    // given altitude land in the same slice of the noise, and the column stripes
    // into pale hoops — a coil spring rather than a jet of ink.
    vec2 ring = vec2(cos(vBearing), sin(vBearing));
    float sheet = snoise01(vec3(ring * 3.2, vUp * 3.0 - uTime * 1.1 + uSeed)) * 0.62
                + snoise01(vec3(ring * 7.4, vUp * 6.2 - uTime * 2.0 + uSeed * 3.0)) * 0.38;

    // Torn over its whole length, not only at the top: the head comes apart
    // into droplets while the foot stays nearly solid, but even the foot has
    // sheets peeling off it. A jet that is a closed surface with a clean cap
    // reads as a vase — and one that is uniformly opaque reads as a hole cut in
    // the world, which is what the close look-dev pass showed.
    float tearAt = mix(0.06, 0.92, smoothstep(0.12, 1.0, vUp)) * (0.5 + uTear * 0.5) - 0.02;
    float body = smoothstep(tearAt, tearAt + 0.3, sheet);
    if (body < 0.01) discard;

    // The bright rim along every torn edge — the same term that turns the crown
    // from a cut-out into water.
    float edge = clamp(body - smoothstep(tearAt + 0.08, tearAt + 0.38, sheet), 0.0, 1.0);

    float lambert = clamp(dot(N, L), 0.0, 1.0);
    float rim = fresnelTerm(V, N, 2.0, uFresnel);
    vec3 H = normalize(L + V);
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), 48.0);

    // This is ink being thrown, so the jet is dark — but *black* is not a
    // colour a surface can be lit in. The pigment is carried by the same noise
    // that is tearing the sheets, so the wall has grain and a lit side instead
    // of being one silhouette.
    vec3 color = mix(uColorDeep, uColorInk, clamp(uInk * (0.4 + sheet * 0.75), 0.0, 1.0));
    color = mix(color, uColorWater, smoothstep(0.45, 1.0, vUp) * 0.45);
    color *= mix(0.35, 1.3, lambert);
    color += uColorRim * rim * 0.6;

    float foam = smoothstep(0.7, 1.0, vUp) * smoothstep(0.4, 0.9, sheet) * uFoam;
    color = mix(color, uColorFoam, clamp(foam * 0.7 + edge * 0.5, 0.0, 1.0));
    color += uColorFoam * spec * 0.35;

    // Denser than the crown — it is a mass of pigment rather than a sheet — but
    // still weighted onto its edges.
    float alpha = body * (0.42 + rim * 0.3 + edge * 0.7 + foam * 0.5) * uRise * uFade * uOpacity;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.006) discard;

    color *= uGlow * uGlobalGlow * (1.0 + uSwell * 0.15);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

export function createInkColumnMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uRadius: { value: 5 },
      uHeight: { value: 3.6 },
      uRise: { value: 0 },
      uFoot: { value: 0.42 },
      uNeck: { value: 0.15 },
      uHead: { value: 0.3 },
      uWobble: { value: 0.14 },
      uWobbleScale: { value: 2.2 },
      uSpin: { value: 0.35 },
      uTear: { value: 0.62 },
      uInk: { value: 0.9 },
      uFoam: { value: 0.85 },
      uFresnel: { value: 1.5 },
      uSwell: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uSoftFade: { value: 0.5 },
      uSeed: { value: 0 },
      uColorWater: { value: new Color(0.11, 0.37, 0.41) },
      uColorDeep: { value: new Color(0.03, 0.13, 0.16) },
      uColorFoam: { value: new Color(0.9, 0.96, 0.94) },
      uColorInk: { value: new Color(0.02, 0.03, 0.04) },
      uColorRim: { value: new Color(0.56, 0.85, 0.82) }
    }),
    vertexShader: COLUMN_VERTEX,
    fragmentShader: COLUMN_FRAGMENT
  });

  /** @param {object} state { radius, height, rise, swell, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.ink;
    const g = settings.global;
    const u = material.uniforms;

    u.uRadius.value = state.radius;
    u.uHeight.value = state.height;
    u.uRise.value = state.rise;
    u.uSwell.value = state.swell * c.swellDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uFoot.value = c.columnFoot;
    u.uNeck.value = c.columnNeck;
    u.uHead.value = c.columnHead;
    u.uWobble.value = c.columnWobble * g.noiseStrength;
    u.uWobbleScale.value = c.columnWobbleScale * g.noiseFrequency;
    u.uSpin.value = c.columnSpin;
    u.uTear.value = c.columnTear;
    u.uInk.value = c.columnInk;
    u.uFoam.value = c.columnFoam;
    u.uFresnel.value = c.columnFresnel * g.fresnel;
    u.uOpacity.value = c.columnOpacity * g.opacity;
    u.uGlow.value = c.crownGlow * g.glow;
    u.uSoftFade.value = c.crownSoftFade;

    u.uColorWater.value.copy(getColor(c.colorWater));
    u.uColorDeep.value.copy(getColor(c.colorWaterDeep));
    u.uColorFoam.value.copy(getColor(c.colorFoam));
    u.uColorInk.value.copy(getColor(c.colorInk));
    u.uColorRim.value.copy(getColor(c.colorRim));
  };

  return material;
}
