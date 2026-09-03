/**
 * Applies the screen-space refraction buffer written by LAYER.DISTORTION.
 *
 * The buffer holds an offset encoded around 0.5 in RG, a strength in B and a
 * coverage mask in A, so heat haze, water refraction and airbending pressure
 * waves all warp the frame through this single pass.
 */
export const DistortionShader = {
  name: 'DistortionShader',

  uniforms: {
    tDiffuse: { value: null },
    tDistortion: { value: null },
    uScale: { value: 0.03 }
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
    uniform sampler2D tDistortion;
    uniform float uScale;
    varying vec2 vUv;

    void main() {
      vec4 d = texture2D(tDistortion, vUv);
      vec2 offset = (d.rg - 0.5) * 2.0 * d.b * d.a * uScale;
      // Clamp so a hot spot can never sample outside the frame.
      vec2 uv = clamp(vUv + offset, vec2(0.0), vec2(1.0));
      gl_FragColor = texture2D(tDiffuse, uv);
    }
  `
};
