import {
  Points,
  BufferGeometry,
  BufferAttribute,
  ShaderMaterial,
  AdditiveBlending,
  Vector3
} from 'three';
import { settings } from '../config/settings.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';

const COUNT = 2600;
const VOLUME = new Vector3(46, 14, 46);

/**
 * Ambient floating dust.
 *
 * A single Points draw call; the whole animation (drift, curl, twinkle,
 * wrapping inside the volume) happens in the vertex shader, so the CPU cost per
 * frame is one uniform write.
 */
export class DustMotes {
  constructor() {
    const geometry = new BufferGeometry();
    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * VOLUME.x;
      positions[i * 3 + 1] = Math.random() * VOLUME.y;
      positions[i * 3 + 2] = (Math.random() - 0.5) * VOLUME.z;
      seeds[i] = Math.random();
    }

    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    geometry.boundingSphere = null;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uAmount: { value: 1 },
        uSize: { value: 20 },
        uPixelRatio: { value: 1 },
        uVolume: { value: VOLUME.clone() }
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSize;
        uniform float uPixelRatio;
        uniform vec3 uVolume;
        attribute float aSeed;
        varying float vAlpha;
        varying float vSeed;
        ${noiseGLSL}

        void main() {
          vSeed = aSeed;
          vec3 p = position;

          // Slow buoyant drift with a curl-noise wobble.
          float t = uTime * (0.05 + aSeed * 0.06);
          p.y += mod(uTime * (0.12 + aSeed * 0.25), uVolume.y);
          p.y = mod(p.y, uVolume.y);
          p += curlNoise(p * 0.06 + vec3(0.0, t, 0.0)) * 1.35;

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float dist = -mv.z;

          // Twinkle + distance falloff.
          float twinkle = 0.55 + 0.45 * sin(uTime * (1.1 + aSeed * 2.6) + aSeed * 40.0);
          vAlpha = twinkle * smoothstep(90.0, 12.0, dist) * smoothstep(0.5, 4.0, dist);

          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uPixelRatio * (0.35 + aSeed * 0.9) / max(dist, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uAmount;
        varying float vAlpha;
        varying float vSeed;

        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float mask = smoothstep(0.5, 0.02, d);
          vec3 tint = mix(vec3(1.0, 0.93, 0.78), vec3(0.78, 0.9, 1.0), vSeed);
          float a = mask * vAlpha * uAmount * 0.3;
          if (a < 0.002) discard;
          gl_FragColor = vec4(tint, a);
        }
      `
    });

    this.points = new Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER.VFX);
    this.points.renderOrder = -1;
    this.points.name = 'DustMotes';
  }

  setPixelRatio(ratio) {
    this.material.uniforms.uPixelRatio.value = ratio;
  }

  update(elapsed, anchor) {
    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uAmount.value = settings.environment.dustAmount;
    // Keep the volume centred on the action without re-uploading positions.
    if (anchor) this.points.position.set(anchor.x, 0, anchor.z);
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
