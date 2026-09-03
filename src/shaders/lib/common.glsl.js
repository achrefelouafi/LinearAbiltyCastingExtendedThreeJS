/**
 * Shared shading helpers: soft particles, fresnel, dissolve, gradients.
 *
 * Pulls in three's `<packing>` chunk itself (needed by `softFade`), so this
 * chunk must only be injected into raw ShaderMaterials — never into a built-in
 * material that already includes `<packing>`, or the depth helpers would be
 * defined twice.
 */
export const commonGLSL = /* glsl */ `
#ifndef COMMON_LIB_INCLUDED
#define COMMON_LIB_INCLUDED

#include <packing>

/**
 * Depth-based soft particle fade.
 * sceneDepth is a packed-RGBA depth prepass of the opaque scene.
 * Returns 0 where the fragment intersects geometry, 1 when well in front of it.
 */
float softFade(sampler2D sceneDepth, vec2 screenUV, float fragViewZ, float near, float far, float fadeDist) {
  float packed = unpackRGBAToDepth(texture2D(sceneDepth, screenUV));
  float sceneViewZ = perspectiveDepthToViewZ(packed, near, far);
  return clamp((fragViewZ - sceneViewZ) / max(fadeDist, 1e-4), 0.0, 1.0);
}

/** Standard Schlick-ish rim term. */
float fresnelTerm(vec3 viewDir, vec3 normal, float power, float scale) {
  return clamp(scale * pow(1.0 - abs(dot(normalize(viewDir), normalize(normal))), power), 0.0, 4.0);
}

/** Threshold dissolve with an emissive burn edge. Returns vec2(alphaMask, edge). */
vec2 dissolveMask(float noiseValue, float threshold, float edgeWidth) {
  float mask = step(threshold, noiseValue);
  float edge = smoothstep(threshold, threshold + edgeWidth, noiseValue) - mask;
  return vec2(mask, clamp(edge, 0.0, 1.0));
}

/** 4-stop gradient sampled by t in 0..1 (core → mid → edge → tail). */
vec3 gradient4(vec3 c0, vec3 c1, vec3 c2, vec3 c3, float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = mix(c0, c1, smoothstep(0.0, 0.34, t));
  vec3 b = mix(a, c2, smoothstep(0.30, 0.68, t));
  return mix(b, c3, smoothstep(0.64, 1.0, t));
}

/** Screen-space UV of the current fragment (needs the clip position). */
vec2 screenUVFromClip(vec4 clipPos) {
  return (clipPos.xy / clipPos.w) * 0.5 + 0.5;
}

/** Anti-aliased step using screen-space derivatives where available. */
float aastep(float threshold, float value) {
  float afwidth = fwidth(value) * 0.7;
  return smoothstep(threshold - afwidth, threshold + afwidth, value);
}

#endif
`;
