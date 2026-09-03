/**
 * Final look pass (runs after tone mapping, in display space).
 *
 * Combines the cheap-but-high-impact grading operations into one pass so the
 * frame is only resampled once: chromatic aberration, lift/gain/contrast/
 * saturation/temperature grading, vignette, film grain and the impact flash.
 */
export const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.35 },
    uVignette: { value: 0.4 },
    uContrast: { value: 1.05 },
    uSaturation: { value: 1.1 },
    uTemperature: { value: 0.05 },
    uLift: { value: 0.0 },
    uGain: { value: 1.0 },
    uGrain: { value: 0.03 },
    uFlashColor: { value: null },
    uFlashStrength: { value: 0 }
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uTemperature;
    uniform float uLift;
    uniform float uGain;
    uniform float uGrain;
    uniform vec3  uFlashColor;
    uniform float uFlashStrength;

    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // ---- chromatic aberration (radial, strongest at the corners) ------
      vec3 color;
      if (uAberration > 0.001) {
        vec2 offset = centered * r2 * uAberration * 0.02;
        color.r = texture2D(tDiffuse, uv + offset).r;
        color.g = texture2D(tDiffuse, uv).g;
        color.b = texture2D(tDiffuse, uv - offset).b;
      } else {
        color = texture2D(tDiffuse, uv).rgb;
      }

      // ---- grading -------------------------------------------------------
      color = (color - 0.5) * uContrast + 0.5;          // contrast
      color = color * uGain + uLift;                     // lift / gain

      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);       // saturation

      // Temperature: push warm into R/B, cool the other way.
      color.r += uTemperature * 0.12;
      color.b -= uTemperature * 0.12;

      // ---- vignette ------------------------------------------------------
      // Falls off from the centre and reaches (1 - uVignette) in the corners,
      // so the control maps directly onto "how much darker the corners are".
      color *= 1.0 - uVignette * smoothstep(0.15, 0.72, r2 * 1.9);

      // ---- impact flash --------------------------------------------------
      if (uFlashStrength > 0.001) {
        color = mix(color, uFlashColor, clamp(uFlashStrength, 0.0, 1.0) * 0.75);
      }

      // ---- grain ---------------------------------------------------------
      if (uGrain > 0.0005) {
        float grain = hash12(uv * vec2(1920.0, 1080.0) + fract(uTime) * 137.0) - 0.5;
        color += grain * uGrain;
      }

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `
};
