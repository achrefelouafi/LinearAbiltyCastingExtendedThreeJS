import { AdditiveBlending, BackSide, Color, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The light trapped in the middle of the cluster — layer 5 of the breakdown.
 *
 * A glow ball is the easiest thing in this project to get wrong, because the
 * obvious implementation — an additive sphere with a fresnel rim — produces a
 * *bubble*: bright at the silhouette, hollow in the middle. A glow is the exact
 * opposite. Looking through the centre of a ball of luminous gas you traverse
 * its full diameter; at the edge you clip a sliver. So the brightness term here
 * is `pow(ndv, uCore)` — **facing** the camera, not grazing it — which is a
 * cheap stand-in for the chord length and puts the energy where the reference
 * frame has it.
 *
 * Two shells are drawn from this one factory:
 *
 *  - the **kernel**, small and tight, almost white where the venom is hottest;
 *  - the **halo**, several times wider and much softer, which is the violet
 *    bloom that separates the cluster from the floor behind it.
 *
 * Both are `BackSide`. A glow has no surface, so drawing its *far* wall is
 * strictly better: the near wall would pop through anything standing inside the
 * ball, and the far wall is naturally occluded by those same crystals, so the
 * gems read as being *inside* the light instead of behind a decal of it.
 *
 * The noise is sampled on the surface normal rather than in world space, so the
 * erosion belongs to the ball and turns with it instead of the ball sliding
 * through a fixed field.
 */
const CORE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uDisplace;
  uniform float uNoiseScale;
  uniform float uFlow;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying vec3  vNormalL;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    vNormalL = normalize(normal);

    // Billow: several octaves pushed along the normal and drifting upward, so
    // the ball boils rather than pulsing as a sphere.
    vec3 np = vNormalL * uNoiseScale + vec3(uSeed * 19.0) - vec3(0.0, uTime * uFlow, 0.0);
    float n = fbm4(np) * 0.65 + ridged(np * 1.7, 4) * 0.35;

    vec3 pos = position + normal * n * uDisplace;

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - world.xyz;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CORE_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uSeed;
  uniform float uCore;
  uniform float uBreak;
  uniform float uBreakScale;
  uniform float uBreakSpeed;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uFade;
  uniform float uSoftFade;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform vec3  uColorCore;
  uniform vec3  uColorMid;
  uniform vec3  uColorEdge;

  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying vec3  vNormalL;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    // BackSide: the interpolated normal points away from us, so the dot comes
    // back negative. Its magnitude is still the chord term we want.
    float ndv = abs(dot(normalize(vNormalW), normalize(vViewDir)));

    // Not a rim: the *centre* is where you look through the most gas.
    float density = pow(clamp(ndv, 0.0, 1.0), uCore);

    // Break it up so it is a cloud of light rather than a rendered sphere.
    vec3 bp = vNormalL * uBreakScale + vec3(uSeed * 11.0);
    bp.y -= uTime * uBreakSpeed;
    float n = fbm3(bp) * 0.5 + 0.5;
    density *= mix(1.0, n * 1.5, clamp(uBreak, 0.0, 1.0));

    // Two beats at once, so the pulse never settles into a metronome.
    float flick = 1.0 + uFlicker * (
      sin(uTime * uFlickerSpeed) * 0.6 +
      sin(uTime * uFlickerSpeed * 2.7 + uSeed * 4.0) * 0.4
    );

    // White-hot through the middle, acid green through the body, violet where
    // it thins out into the smoke.
    float t = 1.0 - clamp(density, 0.0, 1.0);
    vec3 color = mix(uColorCore, uColorMid, smoothstep(0.0, 0.45, t));
    color = mix(color, uColorEdge, smoothstep(0.4, 1.0, t));

    float alpha = clamp(density, 0.0, 1.0) * uOpacity * uFade;
    if (alpha < 0.004) discard;

    // Fade where the ball intersects the gems standing in it, or the shell's
    // silhouette cuts a hard ellipse across them.
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uIntensity * flick * uGlobalGlow;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {'kernel'|'halo'} role which shell this is; picks its settings prefix
 */
export function createVenomCoreMaterial(role = 'kernel') {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: BackSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: { value: Math.random() * 10 },
      uDisplace: { value: 0.22 },
      uNoiseScale: { value: 2.4 },
      uFlow: { value: 0.5 },
      uCore: { value: 2.2 },
      uBreak: { value: 0.5 },
      uBreakScale: { value: 3.0 },
      uBreakSpeed: { value: 0.7 },
      uIntensity: { value: 3.0 },
      uOpacity: { value: 1 },
      uFade: { value: 1 },
      uSoftFade: { value: 0.5 },
      uFlicker: { value: 0.12 },
      uFlickerSpeed: { value: 6.0 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorMid: { value: new Color(0.5, 1, 0.2) },
      uColorEdge: { value: new Color(0.5, 0.25, 0.9) }
    }),
    vertexShader: CORE_VERTEX,
    fragmentShader: CORE_FRAGMENT
  });

  const halo = role === 'halo';

  /**
   * @param {number} fade 0..1 envelope the ability drives
   */
  material.userData.sync = (fade) => {
    const c = settings.venom;
    const g = settings.global;
    const u = material.uniforms;

    u.uFade.value = fade;
    u.uDisplace.value = (halo ? c.haloBillow : c.coreBillow) * g.noiseStrength;
    u.uNoiseScale.value = (halo ? c.haloBillowScale : c.coreBillowScale) * g.noiseFrequency;
    u.uFlow.value = c.coreFlow * g.noiseSpeed;
    u.uCore.value = halo ? c.haloFalloff : c.coreFalloff;
    u.uBreak.value = (halo ? c.haloBreak : c.coreBreak) * g.shaderIntensity;
    u.uBreakScale.value = c.coreBreakScale * g.noiseFrequency;
    u.uBreakSpeed.value = c.coreBreakSpeed * g.noiseSpeed;
    u.uIntensity.value = (halo ? c.haloIntensity : c.coreIntensity) * g.glow;
    u.uOpacity.value = (halo ? c.haloOpacity : c.coreOpacity) * g.opacity;
    u.uSoftFade.value = c.coreSoftFade;
    u.uFlicker.value = halo ? c.coreFlicker * 0.4 : c.coreFlicker;
    u.uFlickerSpeed.value = c.coreFlickerSpeed * g.animationSpeed;

    u.uColorCore.value.copy(getColor(halo ? c.colorHaloCore : c.colorCore));
    u.uColorMid.value.copy(getColor(halo ? c.colorHaloMid : c.colorCoreMid));
    u.uColorEdge.value.copy(getColor(halo ? c.colorHaloEdge : c.colorCoreEdge));
  };

  return material;
}
