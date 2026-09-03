import { ShaderMaterial, NormalBlending, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';

/**
 * Writes screen-space refraction offsets instead of colour.
 *
 * Meshes using this material live on LAYER.DISTORTION and are rendered into a
 * dedicated half-resolution buffer *before* the scene is composited. The
 * DistortionPass then warps the rendered image by whatever this wrote:
 *
 *   R,G  → offset, encoded around 0.5
 *   B    → per-fragment strength
 *   A    → coverage (drives blending between overlapping distorters)
 *
 * The same material powers fire's heat shimmer, water's refraction and the
 * air-bending pressure waves — only the uniforms differ.
 */
export class DistortionMaterial extends ShaderMaterial {
  constructor({ upright = false, stream = false, frequency = 2.2, speed = 1.4, strength = 1 } = {}) {
    super({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uStrength: { value: strength },
        uFrequency: { value: frequency },
        uSpeed: { value: speed },
        uHeight: { value: 1 },
        uFalloff: { value: 1 },
        uSeed: { value: Math.random() * 10 },
        uRise: { value: 1 } // heat rises: scroll the noise upward
      }),
      defines: {
        ...(upright ? { UPRIGHT: '' } : {}),
        ...(stream ? { STREAM: '' } : {})
      },
      vertexShader: /* glsl */ `
        uniform float uHeight;
        varying vec2 vUv;
        varying vec3 vWorld;

        void main() {
          vUv = uv;
          vec3 pos = position;
          #ifdef UPRIGHT
            pos.y += uv.y * (uHeight - 1.0);
          #endif
          vec4 world = modelMatrix * vec4(pos, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uStrength;
        uniform float uFrequency;
        uniform float uSpeed;
        uniform float uFalloff;
        uniform float uSeed;
        uniform float uRise;
        uniform float uShaderIntensity;

        varying vec2 vUv;
        varying vec3 vWorld;

        ${noiseGLSL}

        void main() {
          vec3 np = vec3(vWorld.xz * uFrequency, vWorld.y * uFrequency * 0.6 - uTime * uSpeed * uRise + uSeed);
          float nx = snoise(np);
          float ny = snoise(np + vec3(19.3, 7.7, 31.1));

          // Fade at the silhouette so the warp never shows a hard border.
          vec2 c = (vUv - 0.5) * 2.0;
          float mask = 1.0 - smoothstep(0.35, 1.0, length(vec2(c.x, c.y * uFalloff)));
          #ifdef UPRIGHT
            mask = (1.0 - smoothstep(0.25, 1.0, vUv.y)) * smoothstep(0.0, 0.12, vUv.x);
          #endif
          #ifdef STREAM
            // Long camera-facing strip: feather across it, fade out at the tail
            // only — the head keeps its full shimmer.
            mask = (1.0 - smoothstep(0.35, 1.0, abs(c.y))) * smoothstep(0.0, 0.18, vUv.x);
          #endif

          float strength = uStrength * uShaderIntensity * mask;
          if (strength < 0.002) discard;

          gl_FragColor = vec4(vec2(nx, ny) * 0.5 + 0.5, strength, mask);
        }
      `
    });
  }
}
