import { ShaderMaterial, AdditiveBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The magical energy trail drawn under the cursor while a path is being cast.
 *
 * Fully procedural: flowing fbm streaks, a bright travelling core, sparks along
 * the edge and an animated dissolve that burns the ribbon away once the ability
 * launches. Additive so it reads as light and feeds the bloom pass.
 */
export class TrailMaterial extends ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uColorInner: { value: getColor(settings.trail.colorInner).clone() },
        uColorOuter: { value: getColor(settings.trail.colorOuter).clone() },
        uOpacity: { value: 1 },
        uGlow: { value: 3 },
        uFlowSpeed: { value: 1.5 },
        uNoiseStrength: { value: 0.5 },
        uNoiseFrequency: { value: 2.5 },
        uSoftness: { value: 0.6 },
        uSparkle: { value: 0.6 },
        /** 0 → fully drawn, 1 → fully burnt away. */
        uDissolve: { value: 0 },
        /** Visible fraction measured back from the head of the ribbon. */
        uVisibleLength: { value: 1 },
        /** Normalised head position for the travelling highlight. */
        uHead: { value: 1 }
      }),
      vertexShader: /* glsl */ `
        attribute float aDist;
        attribute float aSide;
        attribute float aRandom;

        varying vec2 vUv;
        varying float vDist;
        varying float vSide;
        varying float vRandom;

        void main() {
          vUv = uv;
          vDist = aDist;
          vSide = aSide;
          vRandom = aRandom;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColorInner;
        uniform vec3 uColorOuter;
        uniform float uOpacity;
        uniform float uGlow;
        uniform float uFlowSpeed;
        uniform float uNoiseStrength;
        uniform float uNoiseFrequency;
        uniform float uSoftness;
        uniform float uSparkle;
        uniform float uDissolve;
        uniform float uVisibleLength;
        uniform float uHead;
        uniform float uShaderIntensity;
        uniform float uGlobalGlow;

        varying vec2 vUv;
        varying float vDist;
        varying float vSide;
        varying float vRandom;

        ${noiseGLSL}
        ${commonGLSL}

        void main() {
          float across = vUv.y * 2.0 - 1.0;      // -1 .. 1 across the ribbon
          float radial = abs(across);
          float along = vUv.x;

          // ---- flowing procedural energy -------------------------------
          vec3 np = vec3(along * uNoiseFrequency * 5.0 - uTime * uFlowSpeed * 2.0,
                         across * 1.6,
                         uTime * uFlowSpeed * 0.4);
          float flow = fbm3(np) * 0.5 + 0.5;
          float filaments = ridged(np * 1.7, 4) * 0.5;

          // Core is bright and narrow, the halo is wide and soft.
          float core = smoothstep(0.55 + uNoiseStrength * (flow - 0.5), 0.0, radial);
          float halo = smoothstep(1.0, 0.15, radial);
          halo *= mix(1.0, flow, uNoiseStrength * 0.85);

          // Soft edge control.
          float edge = smoothstep(1.0, 1.0 - clamp(uSoftness, 0.02, 0.98), radial);

          // ---- travelling highlight + sparks ----------------------------
          float pulse = exp(-pow((along - fract(uTime * 0.35)) * 6.0, 2.0));
          float head = exp(-pow((along - uHead) * 9.0, 2.0));
          float sparks = pow(max(0.0, snoise(vec3(along * 60.0, vRandom * 12.0, uTime * 6.0))), 6.0);

          // ---- length / dissolve ---------------------------------------
          float tailCut = smoothstep(uHead - uVisibleLength, uHead - uVisibleLength + 0.12, along);
          float burn = snoise01(vec3(along * 7.0, across * 2.5, uTime * 0.6));
          vec2 dis = dissolveMask(burn, uDissolve, 0.22);

          float alpha = (core * 0.9 + halo * 0.55) * edge * tailCut * uOpacity;
          alpha += sparks * uSparkle * edge * tailCut * 0.5;
          alpha *= dis.x;
          if (alpha < 0.003) discard;

          vec3 color = mix(uColorOuter, uColorInner, clamp(core + pulse * 0.4 + head, 0.0, 1.0));
          color += filaments * uColorOuter * 0.35 * uNoiseStrength;
          color += dis.y * uColorInner * 2.5;                 // burning dissolve edge
          color += sparks * uSparkle * vec3(1.0);
          color *= uGlow * uGlobalGlow * mix(0.6, 1.0, uShaderIntensity);
          color *= 1.0 + head * 2.0;

          gl_FragColor = vec4(color, alpha);
        }
      `
    });

    this._inner = new Color();
    this._outer = new Color();
  }

  /** Pull the latest editor values. Called once per frame by the owner. */
  sync() {
    const t = settings.trail;
    const g = settings.global;
    const u = this.uniforms;

    u.uColorInner.value.copy(getColor(t.colorInner));
    u.uColorOuter.value.copy(getColor(t.colorOuter));
    u.uOpacity.value = t.opacity * g.opacity;
    u.uGlow.value = t.glow;
    u.uFlowSpeed.value = t.flowSpeed * g.noiseSpeed;
    u.uNoiseStrength.value = t.noiseStrength * g.noiseStrength;
    u.uNoiseFrequency.value = t.noiseFrequency * g.noiseFrequency;
    u.uSoftness.value = t.softness;
    u.uSparkle.value = t.sparkle;
    u.uVisibleLength.value = t.length;
  }
}
