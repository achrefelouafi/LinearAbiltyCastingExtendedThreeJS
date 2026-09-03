import { ShaderMaterial, Color, Vector3, DoubleSide, NormalBlending } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

const GLACIER_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aBirth;
  attribute float aGrow;
  attribute float aShatter;

  varying vec3  vLocal;
  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying vec3  vView;
  varying vec3  vAxis;
  varying float vSeed;
  varying float vBirth;
  varying float vGrow;
  varying float vShatter;

  void main() {
    vLocal = position;
    vSeed = aSeed;
    vBirth = aBirth;
    vGrow = aGrow;
    vShatter = aShatter;

    vec3 objectNormal = normal;
    vec3 objectAxis = vec3(0.0, 1.0, 0.0);
    vec4 world;

    #ifdef USE_INSTANCING
      // A blade is scaled (radius, height, radius), which is anisotropic — the
      // instance matrix would tip every normal toward the long axis. Dividing by
      // the squared column lengths is the inverse-transpose three itself uses.
      mat3 im = mat3(instanceMatrix);
      vec3 invScale = vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
      objectNormal = im * (objectNormal / invScale);
      objectAxis = im * (objectAxis / invScale);
      world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    #else
      world = modelMatrix * vec4(position, 1.0);
    #endif

    vWorld = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * objectNormal);
    vAxis = normalize(mat3(modelMatrix) * objectAxis);
    vView = cameraPosition - world.xyz;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * Not ice you look *at* — ice you look *through*, lit from inside.
 *
 * The Frost Lance's crystals are quarried stone: a patched standard material,
 * milky with feather frost and rime, tinted deeper the thicker the body gets. If
 * this ability borrowed that treatment it would read as the same spell twice, so
 * the Glacial Crown's blades are shaded from scratch and from the opposite end.
 * Almost nothing is diffuse. What you see is:
 *
 *   - **a dispersive edge.** The fresnel term is evaluated *three times*, at
 *     three slightly different exponents, and the results drive red, green and
 *     blue independently — so every silhouette carries a genuine chromatic
 *     fringe, cyan on one lip and violet on the other, the way a real prism
 *     splits a highlight. `dispersion` is how far the three come apart.
 *   - **light piped up the blade.** Emission gathers on the faces the axis runs
 *     *along* rather than the ones facing you, and climbs toward the point
 *     (`tipBias`) with a slow band travelling up it (`bands`, `pulseSpeed`),
 *     ending in an incandescent tip. That is what makes a blade read as a fibre
 *     of frozen light rather than as a lump.
 *   - **striations, not frost.** Ridged noise stretched hard along the blade's
 *     own axis, so the interior shows flow lines running its length instead of
 *     the Lance's milky clouding.
 *   - **a real reflection.** One equirect sample of the stage's HDR probe off
 *     the facet, plus a tight sun lobe, so the facets actually catch the room
 *     they are standing in.
 *
 * On top of that sit the ability's two signatures, the reason this is a material
 * and not a colour swap:
 *
 *   - **the freeze front.** `aGrow` is a per-instance height, 0 at the floor and
 *     1 at the point, and everything above it is discarded against a noisy cut,
 *     so a blade *crystallises upward* out of the ground rather than sliding out
 *     of a hole. The travelling lip is lit (`frontGlow`).
 *   - **the shatter.** `aShatter` is a threshold against a per-fragment chunk id
 *     — half a voronoi cell in the blade's own space, half a hash of its flat
 *     face normal — so a dying blade loses whole plates and wedges one at a
 *     time, each break edge flaring as it goes.
 *
 * Per-instance inputs arrive as instanced attributes (`aSeed`, `aBirth`,
 * `aGrow`, `aShatter`), which is why this material is only ever used on an
 * InstancedMesh. The geometry is non-indexed with per-face normals, so the
 * facets come out crisp without a `flatShading` flag to ask for it.
 */
const GLACIER_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uEnvMap;
  uniform vec3  uSunDir;

  uniform vec3  uColorGlass;
  uniform vec3  uColorEdge;
  uniform vec3  uColorPrismA;
  uniform vec3  uColorPrismB;
  uniform vec3  uColorCore;
  uniform vec3  uColorTip;

  uniform float uBody;
  uniform float uEdgePower;
  uniform float uEdgeGain;
  uniform float uDispersion;
  uniform float uPipe;
  uniform float uTipBias;
  uniform float uBands;
  uniform float uPulseSpeed;
  uniform float uTipStart;
  uniform float uTipGlow;
  uniform float uStria;
  uniform float uStriaScale;
  uniform float uEnvIntensity;
  uniform float uSpecular;
  uniform float uBirthGlow;

  uniform float uFrontRough;
  uniform float uFrontWidth;
  uniform float uFrontGlow;
  uniform float uShatterScale;
  uniform float uShatterEdge;
  uniform float uShatterGlow;

  uniform float uGlow;
  uniform float uOpacity;
  uniform float uGlobalGlow;

  varying vec3  vLocal;
  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying vec3  vView;
  varying vec3  vAxis;
  varying float vSeed;
  varying float vBirth;
  varying float vGrow;
  varying float vShatter;

  ${noiseGLSL}

  #define TAU 6.28318530718

  vec2 equirectUv(vec3 dir) {
    return vec2(atan(dir.z, dir.x) * 0.15915494 + 0.5,
                asin(clamp(dir.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vView);
    // Double-sided: the far wall of a blade is half of what you see through the
    // near one, and its normal has to be flipped or it shades inside out.
    if (dot(N, V) < 0.0) N = -N;

    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float h = clamp(vLocal.y, 0.0, 1.0);

    /* ---- the freeze front: everything above it does not exist yet ---- */
    // The roughness is added back on before the noise is taken off again, so a
    // fully grown blade (aGrow = 1) can never cut into itself.
    float ragged = snoise01(vLocal * 5.0 + vSeed * 7.0) * uFrontRough;
    float front  = vGrow * (1.0 + uFrontRough) - ragged;
    if (h > front) discard;
    float freezing = smoothstep(front - uFrontWidth, front, h) *
                     (1.0 - smoothstep(0.985, 1.0, vGrow));

    /* ---- the shatter: plates and wedges leaving one at a time ---- */
    // Two structures averaged. The voronoi half breaks the body into chunks that
    // ignore the geometry; the facet half takes whole flat faces away, which is
    // what actually happens to a crystal.
    float breaking = 0.0;
    if (vShatter > 0.001) {
      vec2 cell = voronoi2(vLocal.xz * uShatterScale + vLocal.y * 4.0 + vSeed * 13.0);
      float facet = hash13(floor(N * 6.0) + vSeed * 3.0);
      float chunk = 0.55 * cell.y + 0.45 * facet;
      if (chunk < vShatter) discard;
      breaking = smoothstep(vShatter + uShatterEdge, vShatter, chunk);
    }

    /* ---- the dispersive edge ---- */
    vec3 fres = pow(
      vec3(1.0 - ndv),
      vec3(uEdgePower * (1.0 - uDispersion * 0.4), uEdgePower, uEdgePower * (1.0 + uDispersion * 0.55))
    );
    // Each facet takes its own place in the split, so neighbouring faces on one
    // blade do not all fringe the same colour.
    vec3 prism = mix(uColorPrismA, uColorPrismB, hash13(floor(N * 7.0) + vSeed * 5.0));

    /* ---- light piped up the blade to the point ---- */
    float along = 1.0 - abs(dot(N, vAxis)); // the long faces, not the caps
    float pipe = along * pow(h, uTipBias);
    float band = 0.5 + 0.5 * sin((h * uBands - uTime * uPulseSpeed) * TAU + vSeed * 5.0);
    pipe *= mix(0.6, 1.0, band * band);
    float tip = smoothstep(uTipStart, 1.0, h);

    /* ---- flow lines running its length ---- */
    float stria = ridged(vec3(vLocal.xz * uStriaScale, vLocal.y * uStriaScale * 0.3 + vSeed * 9.0), 4);
    stria = smoothstep(0.7, 0.97, stria) * along;

    /* ---- the room it is standing in ---- */
    vec3 refl = reflect(-V, N);
    vec3 env = texture2D(uEnvMap, equirectUv(refl)).rgb * uEnvIntensity;
    float sun = pow(max(dot(refl, -uSunDir), 0.0), 90.0) * uSpecular;

    vec3 color = uColorGlass * uBody * (0.25 + 0.75 * ndv);
    color += prism * fres * uEdgeGain;
    color += uColorEdge * fres.g * fres.g * uEdgeGain * 0.5;
    color += uColorCore * pipe * uPipe;
    color += uColorEdge * stria * uStria;
    color += uColorTip * tip * uTipGlow;
    color += env * (0.35 + 0.65 * fres.g) + uColorEdge * sun;
    color += uColorEdge * freezing * uFrontGlow;
    color += uColorCore * breaking * uShatterGlow;
    color += uColorCore * vBirth * uBirthGlow;
    color *= uGlow;

    // Soft ceiling. Every term peaks at a grazing angle and they stack; a
    // Reinhard rolloff leaves anything under ~1 alone and asymptotes at 1/0.16 ≈
    // 6, so the sliders keep biting at the top of their range without flattening
    // the blade into a white cutout.
    color /= 1.0 + color * 0.16;

    // Glass: thin and clear through the body, solid at the silhouette, the tip
    // and any edge that is currently freezing or breaking.
    float alpha = uBody * 0.4 + fres.g * 1.25 + pipe * 0.45 + stria * 0.3 +
                  tip * 0.55 + freezing + breaking;
    alpha = clamp(alpha, 0.0, 1.0) * uOpacity;
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The blades of a Glacial Crown. One material for every shard in the cast; the
 * per-shard state rides in on instanced attributes.
 */
export function createGlacierMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    // Kept on: the crown is a wall you look into, and depth writes are what stop
    // it sorting through itself and let the mist and snow fade against it.
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: frame.uTime,
      uEnvMap: frame.uEnvMap,
      uGlobalGlow: frame.uGlobalGlow,
      uSunDir: { value: new Vector3(0, -1, 0) },

      uColorGlass: { value: new Color() },
      uColorEdge: { value: new Color() },
      uColorPrismA: { value: new Color() },
      uColorPrismB: { value: new Color() },
      uColorCore: { value: new Color() },
      uColorTip: { value: new Color() },

      uBody: { value: 0.55 },
      uEdgePower: { value: 2.2 },
      uEdgeGain: { value: 1.6 },
      uDispersion: { value: 0.6 },
      uPipe: { value: 1.5 },
      uTipBias: { value: 1.6 },
      uBands: { value: 1.4 },
      uPulseSpeed: { value: 0.6 },
      uTipStart: { value: 0.62 },
      uTipGlow: { value: 1.4 },
      uStria: { value: 0.7 },
      uStriaScale: { value: 6.0 },
      uEnvIntensity: { value: 0.6 },
      uSpecular: { value: 2.0 },
      uBirthGlow: { value: 2.2 },

      uFrontRough: { value: 0.35 },
      uFrontWidth: { value: 0.12 },
      uFrontGlow: { value: 2.6 },
      uShatterScale: { value: 7.0 },
      uShatterEdge: { value: 0.08 },
      uShatterGlow: { value: 3.0 },

      uGlow: { value: 1.0 },
      uOpacity: { value: 1.0 }
    },
    vertexShader: GLACIER_VERTEX,
    fragmentShader: GLACIER_FRAGMENT
  });

  const u = material.uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.glacier;
    const g = settings.global;
    const env = settings.environment;

    u.uColorGlass.value.copy(getColor(c.colorGlass));
    u.uColorEdge.value.copy(getColor(c.colorEdge));
    u.uColorPrismA.value.copy(getColor(c.colorPrismA));
    u.uColorPrismB.value.copy(getColor(c.colorPrismB));
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorTip.value.copy(getColor(c.colorTip));

    u.uBody.value = c.body;
    u.uEdgePower.value = c.edgePower;
    u.uEdgeGain.value = c.edgeGain * g.fresnel;
    u.uDispersion.value = c.dispersion;
    u.uPipe.value = c.pipe * g.shaderIntensity;
    u.uTipBias.value = c.tipBias;
    u.uBands.value = c.bands;
    u.uPulseSpeed.value = c.pulseSpeed * g.noiseSpeed;
    u.uTipStart.value = c.tipStart;
    u.uTipGlow.value = c.tipGlow;
    u.uStria.value = c.stria * g.shaderIntensity;
    u.uStriaScale.value = c.striaScale * g.noiseFrequency;
    u.uEnvIntensity.value = c.envIntensity;
    u.uSpecular.value = c.specular;
    u.uBirthGlow.value = c.birthGlow;

    u.uFrontRough.value = c.frontRough * g.noiseStrength;
    u.uFrontWidth.value = c.frontWidth;
    u.uFrontGlow.value = c.frontGlow;
    u.uShatterScale.value = c.shatterScale * g.noiseFrequency;
    u.uShatterEdge.value = c.shatterEdge;
    u.uShatterGlow.value = c.shatterGlow;

    u.uGlow.value = c.glow * g.glow;
    u.uOpacity.value = c.opacity * g.opacity;

    // The sun the stage is actually lit by, so the glint sits where the rest of
    // the scene's highlights do.
    const cosE = Math.cos(env.sunElevation);
    u.uSunDir.value
      .set(-Math.cos(env.sunAzimuth) * cosE, -Math.sin(env.sunElevation), -Math.sin(env.sunAzimuth) * cosE)
      .normalize();
  };

  material.userData.sync();
  return material;
}
