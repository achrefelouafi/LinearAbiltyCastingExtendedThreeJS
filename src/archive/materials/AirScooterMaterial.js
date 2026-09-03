import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The air scooter — a compressed ball of spinning air the avatar rides.
 *
 * The reference (windball.jpg) is a pale sphere wrapped in a handful of darker
 * arcs that all converge on two poles, with a bright rim and a bright eye where
 * the axis comes out. Translated to an additive VFX pass on a dark stage the
 * arcs become the *bright* part: the shader partitions the sphere into
 * `uBands` streamlines of constant `longitude + twist × latitude` — the family
 * of curves that spirals pole to pole — and draws one strand per lane.
 *
 * The lane coordinate is warped by an fbm field so the strands weave and break
 * up rather than reading as a wireframe globe, and the whole pattern rotates
 * about the mesh's local **Y axis**: the scooter object aligns that axis with
 * the direction of travel's side vector, so the swirl rolls the way the ball
 * rolls. Everything else (haze, rim, polar eye) is there to keep the silhouette
 * reading as a solid ball of air rather than a set of lines in space.
 */
export class AirScooterMaterial extends ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      // Both walls stack additively, which is what gives the ball its volume.
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uColorInner: { value: new Color(0.95, 0.99, 1.0) },
        uColorOuter: { value: new Color(0.36, 0.78, 0.93) },
        uOpacity: { value: 1.0 },
        uGlow: { value: 1.35 },
        uFresnel: { value: 1.5 },
        uSpin: { value: 1.6 },
        uBands: { value: 7.0 },
        uTwist: { value: 2.4 },
        uSharp: { value: 0.62 },
        uTurbulence: { value: 0.5 },
        uHaze: { value: 0.5 },
        uWobble: { value: 0.08 },
        /** 0 while the ball puffs into existence, 1 once it is settled. */
        uBirth: { value: 1.0 },
        /** 1 → 0 as it dissipates at the end of the ride. */
        uFade: { value: 1.0 }
      }),
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uWobble;
        uniform float uBirth;

        varying vec3  vPosL;
        varying vec3  vNormalW;
        varying vec3  vViewDir;
        varying float vViewZ;

        ${noiseGLSL}

        void main() {
          vPosL = normalize(position);

          // Two out-of-phase fields breathing over the surface. A ball of air
          // should never hold a clean analytic silhouette.
          float n = snoise(vPosL * 2.1 + vec3(0.0, uTime * 0.9, 0.0))
                  + 0.5 * snoise(vPosL * 4.3 - vec3(uTime * 1.5, 0.0, 0.0));
          vec3 pos = position * (1.0 + n * uWobble * 0.35 * uBirth);

          vec4 world = modelMatrix * vec4(pos, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewDir = cameraPosition - world.xyz;

          vec4 mv = viewMatrix * world;
          vViewZ = mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3  uColorInner;
        uniform vec3  uColorOuter;
        uniform float uOpacity;
        uniform float uGlow;
        uniform float uFresnel;
        uniform float uSpin;
        uniform float uBands;
        uniform float uTwist;
        uniform float uSharp;
        uniform float uTurbulence;
        uniform float uHaze;
        uniform float uBirth;
        uniform float uFade;
        uniform float uShaderIntensity;
        uniform float uGlobalGlow;
        uniform vec2  uResolution;
        uniform sampler2D uSceneDepth;
        uniform float uCameraNear;
        uniform float uCameraFar;

        varying vec3  vPosL;
        varying vec3  vNormalW;
        varying vec3  vViewDir;
        varying float vViewZ;

        ${noiseGLSL}
        ${commonGLSL}

        #define TAU 6.2831853

        void main() {
          vec3 p = normalize(vPosL);
          float lat = clamp(p.y, -1.0, 1.0);        // -1 / +1 at the spin poles
          float lon = atan(p.z, p.x);

          float fres = fresnelTerm(vViewDir, vNormalW, 2.1, 1.0) * uFresnel;

          // Streamline coordinate: constant along a curve that spirals from one
          // pole to the other. Adding time to it rolls the whole pattern.
          float phase = (lon / TAU) * uBands + uTwist * asin(lat) * uBands / TAU + uTime * uSpin * uBands;

          // Warp the lanes so the strands weave and bunch instead of sitting on
          // a regular grid.
          float warp = fbm3(p * 2.4 + vec3(0.0, uTime * 0.7, uTime * 0.25));
          phase += warp * uTurbulence;

          float d = abs(fract(phase) - 0.5) * 2.0;  // 0 on a strand, 1 between
          float w = max(mix(0.7, 0.12, clamp(uSharp, 0.0, 1.0)), fwidth(phase) * 1.6);
          float core = pow(1.0 - smoothstep(0.0, w, d), 1.7);
          float halo = (1.0 - smoothstep(0.0, min(1.0, w * 4.5), d)) * 0.32;

          // Strands dissolve and re-form as the ball turns, and no two carry the
          // same weight — a uniform set of arcs reads as a wireframe globe.
          float id = floor(phase);
          float life = fbm3(vec3(id * 3.7, lat * 2.2, uTime * 0.5));
          float alive = smoothstep(-0.35, 0.3, life) * mix(0.45, 1.0, hash11(id * 1.93));

          // The lanes converge at the poles, so fade them out there and put a
          // bright eye on the axis instead — exactly what the reference does.
          float polar = smoothstep(0.02, 0.42, 1.0 - abs(lat));
          float eye = pow(smoothstep(0.72, 1.0, abs(lat)), 1.6);

          // Milky vapour filling the gaps, so the ball reads as a body of air
          // rather than a set of lines floating in space.
          float hz = fbm3(p * 3.1 - vec3(uTime * 0.9, 0.0, 0.0));
          float haze = uHaze * (0.42 + 0.58 * smoothstep(-0.4, 0.6, hz));

          float strand = (core + halo) * alive * polar;
          float body = strand * (0.62 + fres * 0.55) + haze * (0.16 + fres * 0.42) + eye * 0.42;

          // Puff in from a bright shapeless blob, dissipate into haze.
          float alpha = body * uOpacity * mix(0.35, 1.0, uBirth) * uFade;

          vec2 screenUV = gl_FragCoord.xy / uResolution;
          alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, 0.25);
          if (alpha < 0.004) discard;

          vec3 color = mix(uColorOuter, uColorInner, clamp(core * 1.1 + eye * 0.8 + fres * 0.4, 0.0, 1.0));
          color *= uGlow * uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);

          gl_FragColor = vec4(color, alpha);
        }
      `
    });
  }

  /** Pull the live editor values across. Called once per frame while riding. */
  sync() {
    const c = settings.walk;
    const g = settings.global;
    const u = this.uniforms;

    u.uColorInner.value.copy(getColor(c.colorInner));
    u.uColorOuter.value.copy(getColor(c.colorOuter));
    u.uOpacity.value = c.opacity * g.opacity;
    u.uGlow.value = c.glow;
    u.uFresnel.value = c.fresnel * g.fresnel;
    u.uSpin.value = c.spin * g.noiseSpeed;
    u.uBands.value = c.bands;
    u.uTwist.value = c.twist;
    u.uSharp.value = c.filamentSharp;
    u.uTurbulence.value = c.turbulence * g.turbulence;
    u.uHaze.value = c.haze;
    u.uWobble.value = c.wobble;
  }
}
