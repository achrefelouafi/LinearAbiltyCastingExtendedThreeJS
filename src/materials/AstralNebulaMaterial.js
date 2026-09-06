import { ShaderMaterial, NormalBlending, Color, Vector3, BackSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The astral nebula — layer 3, the primary payload, and the panel of the
 * reference sheet everything else is arranged around.
 *
 * A violent eruption of galaxy-like gas around the singularity: deep cosmic
 * purples in the body, brilliant gold where it is hottest, wound into arms that
 * spiral into the hole. It is **raymarched**, and it has to be, for the same
 * four reasons the Sumi Tide's ink is:
 *
 *  1. it has no surface — there is no silhouette to give a billboard, and a
 *     stack of cards shows its own sorting the moment the camera orbits;
 *  2. it is seen *through* — the far side of the cloud shades the near side,
 *     and the hole in the middle has to eat exactly the gas behind it;
 *  3. it is clipped against the scene, so a body standing in the blast is
 *     veiled by the gas in front of it and none of the gas behind it;
 *  4. empty space is free — the profile is evaluated before any noise is, the
 *     march stops the moment the gas goes opaque, and the step count is a live
 *     slider so a laptop and a demo machine can run the same build.
 *
 * ## What makes it a galaxy rather than coloured fog
 *
 * **It is oblate.** `uFlatten` divides the sample point's height before the
 * radius is taken, so the cloud is a thick disc with polar lobes rather than a
 * ball. Everything that falls into something ends up in a plane; a spherical
 * explosion around a black hole reads as a grenade.
 *
 * **It shears.** The winding rate goes as `uWind / r`, so gas near the hole
 * laps gas further out — differential rotation is the only reason the arms in
 * here curl into the spirals the reference is full of. Turn the whole volume at
 * one rate and it is a cylinder of noise being rotated, which is exactly what
 * it looks like.
 *
 * **It has arms.** A cosine on the bearing *in the rotating frame*, raised to a
 * power, gates the density. Because the frame's rotation is itself a function
 * of radius, a straight angular ripple comes out as a logarithmic spiral for
 * free — no noise field can be talked into that shape reliably.
 *
 * **It is beamed.** The orbital direction is dotted against the view ray, so
 * the side sweeping toward the camera is brighter than the side sweeping away.
 * Two lines, and it is most of what says the thing is turning at speed.
 *
 * **Its rays are angular, not radial noise.** `uSpikes` lances hot gold out
 * along a handful of bearings, strongest in the disc plane and dying with
 * radius — the brilliant golden spears of the reference, which are ejecta seen
 * end-on rather than a lens flare.
 *
 * Emission is accumulated premultiplied, so thick gas *occludes* while thin gas
 * adds: the cloud can veil the stage and still blow out to white in its cores,
 * which a purely additive volume cannot do.
 */

const NEBULA_VERTEX = /* glsl */ `
  varying vec3 vWorld;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const NEBULA_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3  uCentre;       // world, the middle of the hole
  uniform float uRadius;       // how far the gas reaches, metres
  uniform float uHole;         // the shadow's radius, metres — what eats the gas
  uniform float uSteps;
  uniform float uDensity;
  uniform float uAbsorb;
  uniform float uEmissive;
  uniform float uScale;
  uniform float uDetail;
  uniform float uFilament;
  uniform float uThreshold;
  uniform float uCavity;       // the clear eye around the hole, x radius
  uniform float uEdge;         // where the outer wall starts to soften
  uniform float uFlatten;      // <1 squashes the cloud into a disc
  uniform float uArms;
  uniform float uArmSharp;
  uniform float uArmWeight;
  uniform float uWind;         // differential winding — the spiral
  uniform float uTwist;        // extra turn with height
  uniform float uSpin;         // revolutions/second of the whole field
  uniform float uRise;
  uniform float uSpikes;
  uniform float uSpikeSharp;
  uniform float uSpikeReach;
  uniform float uSpikeGlow;
  uniform float uHeatFalloff;
  uniform float uBeam;         // doppler beaming
  uniform float uChurn;        // the flare envelope, 0..1
  uniform float uDrain;        // 0..1, the cloud being pulled into the hole
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorEdge;
  uniform vec3  uColorBody;
  uniform vec3  uColorHot;
  uniform vec3  uColorCore;

  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying vec3 vWorld;

  ${noiseGLSL}
  ${commonGLSL}

  #define MAX_STEPS 72
  #define TAU 6.28318530718
  // The proxy is a polyhedron and the field can wander a little past uRadius, so
  // the analytic bound is generous. Cheap: empty span costs one profile test.
  #define REACH_MARGIN 1.14

  /**
   * Where this point sits in the cloud.
   *
   * rn — distance from the middle in *oblate* units, 1 at the outer wall
   * bearing — its angle in the frame the gas is turning in, which is what makes
   *   a plain angular ripple come out as a spiral
   * up — how far off the disc plane it is, 0..1
   */
  float shellProfile(vec3 q, out float rn, out float bearing, out float up) {
    float squash = max(uFlatten, 0.05);
    vec3 qf = vec3(q.x, q.y / squash, q.z);
    rn = length(qf) / max(uRadius, 1e-3);
    // The *true* distance as well, because the eye below has to be a sphere
    // even though the envelope is a disc.
    float sphereN = length(q) / max(uRadius, 1e-3);
    up = clamp(abs(q.y) / max(uRadius * squash, 1e-3), 0.0, 1.0);

    // Draining pulls the outer wall in toward the eye rather than fading the
    // cloud where it hangs: the gas goes *down the hole*, it does not evaporate.
    float outer = mix(1.0, uCavity * 1.3, uDrain);
    float wall = 1.0 - smoothstep(outer * uEdge, outer, rn);
    // The eye, and it is the one part of this shape that is a **sphere** rather
    // than a disc. Two things force that, and both of them are about the one
    // surface in the frame that has to stay solid black.
    //
    // Measured in the oblate metric, the void is squashed to uFlatten of its
    // width — so directly above and below the hole the gas comes in to within
    // half a metre of it, and every ray that grazes the top or the bottom of the
    // shadow picks some of it up. The march stops at the sphere, so that gas can
    // only ever be drawn *in front of* the shadow, and it is doppler-beamed like
    // all the rest of it, so it lights one side and leaves the other black. What
    // that draws is a bright vertical bar straight down the middle of the hole,
    // which reads as a rendering fault rather than as anything physical.
    //
    // The inner edge is also floored strictly outside the shadow whatever the
    // editor is set to, and the ramp out of it is *long*, because a short one
    // draws a hard circle around the hole and the whole thing reads as a target
    // painted on the sky.
    float holeN = uHole / max(uRadius, 1e-3);
    float inner = max(uCavity * 0.55, holeN * 1.25);
    float eye = smoothstep(inner, max(uCavity * 1.15, inner + 0.06), sphereN);

    // The shear that makes the arms spiral. Note the constant under uWind: it
    // is what stops the winding rate blowing up toward the middle. Drop it and
    // the arms wrap several times inside the inner third of the cloud, which
    // resolves on screen as *concentric rings* — a vinyl record, not a galaxy.
    float turn = uTime * uSpin * TAU + uWind / (0.45 + rn * 1.2)
               + uTwist * (q.y / max(uRadius, 1e-3));
    bearing = atan(q.z, q.x) - turn;

    return wall * eye;
  }

  /** Density, heat and orbital direction at a world point. */
  void sampleGas(vec3 p, out float d, out float heat, out vec3 orbit) {
    d = 0.0;
    heat = 0.0;
    orbit = vec3(0.0, 0.0, 1.0);

    vec3 q = p - uCentre;
    float rn, bearing, up;
    float shell = shellProfile(q, rn, bearing, up);
    if (shell <= 0.002) return;

    // How far this parcel is from the rotation axis, 0 on it.
    //
    // **Every angular term below is singular there** — the bearing, the arms,
    // the spears and the orbital direction are all built on atan(q.z, q.x),
    // which is undefined on the axis and swings through a full turn in the
    // millimetres either side of it. Left alone, all three alias into a
    // dead-straight bright column standing on the hole, which is the single
    // most artificial thing this ability can draw: it is exactly vertical, it
    // is exactly centred, and it cuts through the one surface in the frame
    // that has to stay solid black. Every one of them is faded out here
    // instead, and each fade is also simply true — a parcel on the axis is not
    // in an arm, is not on a ray, and is not going round anything.
    float axis = smoothstep(0.0, 0.22, length(q.xz) / max(uRadius, 1e-3));

    // The sampling frame turns with the gas, so the structure is carried round
    // rather than the cloud sliding through a field pinned to the world. It has
    // to be the *same* turn the arms were measured in, twist included, or the
    // clouds and the arms wind at different rates and neither reads.
    float turn = uTime * uSpin * TAU + uWind / (0.45 + rn * 1.2)
               + uTwist * (q.y / max(uRadius, 1e-3));
    vec2 xz = rot2(turn) * q.xz;

    vec3 np = vec3(xz * uScale, q.y * uScale * 1.35 - uTime * uRise + uSeed);
    float cloud = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 3; i++) {
      cloud += amp * snoise(np);
      np = np * 2.11 + vec3(17.3, 5.9, 23.7);
      amp *= 0.5;
    }
    cloud = cloud * 0.5 + 0.5;

    // Ridged detail. Gas thrown out of something is filament and void, never a
    // uniform haze, and this is the octave that carries the violence.
    float fil = 1.0 - abs(snoise(vec3(xz, q.y * 0.7) * uScale * uDetail + uSeed * 3.0));
    float n = mix(cloud, fil, uFilament);

    // The arms, gating the density. Evaluated in the rotating frame, so the
    // radial shear in that frame bends them into spirals.
    //
    // Toward the axis the gate is faded to the value it *averages*, not to 1.
    // Fading it to 1 is the obvious thing and it is wrong: the gate is at most
    // 1, so an axis exempted from it sits permanently at the arms' peak while
    // everything around it oscillates — which draws a pale column standing on
    // the hole. Fading to the mean makes the axis unremarkable, which is the
    // whole point of a fade whose only job is to remove a singularity.
    float armGate = pow(0.5 + 0.5 * cos(bearing * uArms), uArmSharp);
    float armMean = 1.0 / (1.0 + uArmSharp);
    float arms = mix(armMean, armGate, axis);
    n *= mix(1.0, arms, uArmWeight);

    // Carved rather than faded: below the threshold there is simply no gas.
    float carved = smoothstep(uThreshold, 1.0, n);

    /* ---- the golden spears ---- */
    // Measured on the *unwound* bearing, and that is the whole trick. The arms
    // above are wound by a rate that varies with radius, which is what curls
    // them into spirals; a spear that followed the same frame would curl with
    // them and stop being a spear. Turned slowly and rigidly instead, these
    // stay straight, and straight is what makes them read as ejecta seen
    // end-on rather than as more swirl.
    float raw = atan(q.z, q.x) - uTime * uSpin * TAU * 0.35 + uSeed;
    float ray = pow(abs(cos(raw * uSpikes * 0.5)), uSpikeSharp);
    ray *= 1.0 - smoothstep(uSpikeReach * 0.25, uSpikeReach, rn);
    // Strongest in the disc plane, because they are thrown along the equator.
    ray *= (1.0 - up * 0.8) * axis;

    // The spears are *gas*, not a tint on it: they thicken the cloud where they
    // run, which is what stops them reading as a lens flare pasted over it.
    d = (carved + ray * uSpikeGlow * 0.8) * shell * uDensity * (1.0 + uChurn * 0.5);

    /* ---- how hot it is ---- */
    // Radius sets the ceiling; *density* decides how much of it this parcel
    // gets. The density term is the important half: without it every wisp near
    // the middle is gold and the whole cloud comes out as one cream disc. With
    // it the gold lives in the dense cores and the thin gas stays violet, which
    // is the reference sheet's entire colour structure.
    float radial = pow(1.0 - clamp(rn, 0.0, 1.0), uHeatFalloff);
    heat = radial * (0.18 + 0.82 * clamp(carved * 1.6, 0.0, 1.0));
    heat = clamp(heat + ray * uSpikeGlow, 0.0, 2.0);

    // Which way this parcel is travelling: a circular orbit about the vertical.
    //
    // Faded out around the axis on a much wider radius than everything else,
    // and for a different reason. The others are singular *at* the axis; this
    // one **flips sign across** it, and most of the light on any ray comes from
    // the dense gas nearest the hole — so the flip happens over the angular
    // width of that small region and the beaming draws a hard vertical edge
    // splitting the blast in half rather than the soft left-bright/right-dim
    // gradient it is supposed to. Confining it to the thin outer gas, where the
    // two limbs are genuinely separated on screen, gives the read without the
    // seam.
    float beamFade = smoothstep(0.15, 0.62, length(q.xz) / max(uRadius, 1e-3));
    orbit = normalize(vec3(-q.z, 0.0, q.x) + vec3(1e-5)) * beamFade;
  }

  /**
   * The ray's entry and exit through a sphere. Returns false when it misses, and
   * is correct with the camera inside.
   */
  bool sphereSpan(vec3 ro, vec3 rd, vec3 ce, float rad, out float t0, out float t1) {
    vec3 oc = ro - ce;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - rad * rad;
    float disc = b * b - c;
    if (disc < 0.0) return false;
    float s = sqrt(disc);
    t0 = -b - s;
    t1 = -b + s;
    return t1 > 0.0;
  }

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - cameraPosition);

    float ta, tb;
    if (!sphereSpan(ro, rd, uCentre, uRadius * REACH_MARGIN, ta, tb)) discard;
    float t0 = max(ta, 0.0);
    float t1 = tb;

    /* ---- the hole eats whatever is behind it ---- */
    // Analytic rather than a depth test, because the horizon is a transparent
    // billboard with no depth of its own. Stopping the march at the shadow is
    // what makes gas pass in *front* of the hole and vanish behind it.
    float h0, h1;
    if (sphereSpan(ro, rd, uCentre, uHole, h0, h1)) {
      if (h0 <= 0.0) discard;   // the camera is inside the horizon
      t1 = min(t1, h0);
    }

    /* ---- and the opaque scene clips it like anything else ---- */
    // Third row of the view matrix is the camera's basis Z in world space; the
    // prepass stores a *view* depth, so it has to be divided by the cosine
    // between the ray and that axis to become a distance along this ray.
    vec3 camFwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float packed = unpackRGBAToDepth(texture2D(uSceneDepth, screenUV));
    float sceneViewZ = perspectiveDepthToViewZ(packed, uCameraNear, uCameraFar);
    float sceneT = (-sceneViewZ) / max(dot(rd, camFwd), 1e-4);
    t1 = min(t1, sceneT);
    if (t1 <= t0) discard;

    float steps = clamp(uSteps, 6.0, float(MAX_STEPS));
    float dt = (t1 - t0) / steps;
    // Jittered start. Without it the march bands into visible shells, and that
    // banding is the single most obvious tell that a volume is stepped.
    float jitter = hash13(vec3(gl_FragCoord.xy, uTime * 60.0));
    float t = t0 + dt * jitter;

    vec3 acc = vec3(0.0);
    float trans = 1.0;

    for (int i = 0; i < MAX_STEPS; i++) {
      if (float(i) >= steps || trans < 0.012) break;

      vec3 p = ro + rd * t;
      float d, heat;
      vec3 orbit;
      sampleGas(p, d, heat, orbit);

      if (d > 0.002) {
        // Doppler beaming: the limb sweeping toward the camera is brighter than
        // the limb sweeping away. It is the term that says *fast*.
        float beam = 1.0 + uBeam * dot(orbit, -rd);

        vec3 col = mix(uColorEdge, uColorBody, smoothstep(0.0, 0.30, heat));
        col = mix(col, uColorHot, smoothstep(0.38, 0.88, heat));
        // White is reserved for the very hottest cores. Widen this and the
        // middle of the blast blows out into a cream disc with no hue left in
        // it to correct.
        col = mix(col, uColorCore, smoothstep(1.0, 1.75, heat));

        // The floor matters as much as the peak: at a lower one the coldest gas
        // contributes almost nothing but still carries its alpha, so the outer
        // cloud stops being violet and becomes a ring of black smoke around the
        // blast — occlusion with no light in it.
        float emit = uEmissive * (0.32 + heat * heat * 2.4) * max(beam, 0.05);

        float a = 1.0 - exp(-d * uAbsorb * dt);
        acc += col * emit * a * trans;
        trans *= 1.0 - a;
      }

      t += dt;
    }

    float alpha = (1.0 - trans) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    acc *= uGlobalGlow * uFade;
    // Premultiplied: acc is already weighted by its own alpha, so thick gas
    // occludes the stage while thin gas adds to it. A purely additive volume
    // could never veil the character standing in the blast.
    gl_FragColor = vec4(acc, alpha);
  }
`;

/**
 * The nebula. Built once; every metre is resolved from `settings.astral` each
 * frame, so `nebulaRadius` re-shapes a cloud that is already erupting.
 */
export function createAstralNebulaMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // The march is clipped against the depth prepass itself, which is both more
    // accurate than the depth test and stays right with the camera inside it.
    depthTest: false,
    blending: NormalBlending,
    premultipliedAlpha: true,
    side: BackSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uRadius: { value: 7 },
      uHole: { value: 1 },
      uSteps: { value: 34 },
      uDensity: { value: 3.4 },
      uAbsorb: { value: 1.1 },
      uEmissive: { value: 1.6 },
      uScale: { value: 0.4 },
      uDetail: { value: 2.4 },
      uFilament: { value: 0.6 },
      uThreshold: { value: 0.46 },
      uCavity: { value: 0.22 },
      uEdge: { value: 0.55 },
      uFlatten: { value: 0.6 },
      uArms: { value: 3 },
      uArmSharp: { value: 1.6 },
      uArmWeight: { value: 0.7 },
      uWind: { value: 2.2 },
      uTwist: { value: 1.4 },
      uSpin: { value: 0.22 },
      uRise: { value: 0.4 },
      uSpikes: { value: 9 },
      uSpikeSharp: { value: 7 },
      uSpikeReach: { value: 0.9 },
      uSpikeGlow: { value: 0.85 },
      uHeatFalloff: { value: 2.2 },
      uBeam: { value: 0.45 },
      uChurn: { value: 0 },
      uDrain: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorEdge: { value: new Color(0.16, 0.08, 0.34) },
      uColorBody: { value: new Color(0.55, 0.26, 0.92) },
      uColorHot: { value: new Color(1, 0.68, 0.24) },
      uColorCore: { value: new Color(1, 0.96, 0.82) }
    }),
    vertexShader: NEBULA_VERTEX,
    fragmentShader: NEBULA_FRAGMENT
  });

  /**
   * @param {object} state { centre, radius, hole, cavity, churn, drain, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.astral;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uRadius.value = state.radius;
    u.uHole.value = state.hole;
    u.uCavity.value = state.cavity;
    u.uChurn.value = state.churn;
    u.uDrain.value = state.drain;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uSteps.value = Math.round(c.nebulaSteps);
    u.uDensity.value = c.nebulaDensity * g.shaderIntensity;
    u.uAbsorb.value = c.nebulaAbsorb;
    u.uEmissive.value = c.nebulaGlow * g.glow;
    u.uScale.value = c.nebulaScale * g.noiseFrequency;
    u.uDetail.value = c.nebulaDetail;
    u.uFilament.value = c.nebulaFilament;
    u.uThreshold.value = c.nebulaThreshold;
    u.uEdge.value = c.nebulaEdge;
    u.uFlatten.value = c.nebulaFlatten;
    u.uArms.value = Math.round(c.nebulaArms);
    u.uArmSharp.value = c.nebulaArmSharp;
    u.uArmWeight.value = c.nebulaArmWeight;
    u.uWind.value = c.nebulaWind * g.turbulence;
    u.uTwist.value = c.nebulaTwist * g.turbulence;
    u.uSpin.value = c.nebulaSpin * g.noiseSpeed;
    u.uRise.value = c.nebulaRise * g.noiseSpeed;
    u.uSpikes.value = Math.round(c.nebulaSpikes);
    u.uSpikeSharp.value = c.nebulaSpikeSharp;
    u.uSpikeReach.value = c.nebulaSpikeReach;
    u.uSpikeGlow.value = c.nebulaSpikeGlow;
    u.uHeatFalloff.value = c.nebulaHeatFalloff;
    u.uBeam.value = c.nebulaBeam;
    u.uOpacity.value = c.nebulaOpacity * g.opacity;

    u.uColorEdge.value.copy(getColor(c.colorNebulaEdge));
    u.uColorBody.value.copy(getColor(c.colorNebulaBody));
    u.uColorHot.value.copy(getColor(c.colorNebulaHot));
    u.uColorCore.value.copy(getColor(c.colorNebulaCore));
  };

  return material;
}
