import {
  ShaderMaterial,
  CustomBlending,
  AddEquation,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Color,
  DoubleSide
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * How far past the nominal tube radius the fringe shred can push density,
 * before the low-frequency bulge is taken into account. Matches the
 * `smoothstep(REACH_LO, REACH_HI, q)` cutoff in the fragment shader.
 */
export const FIRE_SHRED_REACH = 1.55;

/**
 * Total outward reach of the volume in units of the nominal tube radius.
 *
 * The proxy hull has to *contain* the density field: anything the field can
 * reach and the hull cannot is sliced off along a dead straight edge. The bulge
 * scales the local radius directly, so it multiplies the shred reach.
 */
export function fireHullReach() {
  // The 1.3 is margin, not slop. The hull is a flat strip and the volume it has
  // to contain is a stretched capsule, so matching the two exactly leaves the
  // cap's silhouette sitting on the hull's terminal edge — and a volume that
  // ends one pixel outside its proxy is sliced off along a dead straight line,
  // which is the single most obvious way this technique fails.
  return FIRE_SHRED_REACH * (1 + settings.fire.bulge) * 1.3;
}

/**
 * Radius of the flame at `u` along the stream, in units of `uRadius`.
 *
 * Two competing terms: the burn grows toward the head, while the spent gas
 * behind it has had time to expand — which is what gives the wake its billowing,
 * roughly cylindrical silhouette instead of tapering to a needle.
 *
 * Shared verbatim by the vertex shader (hull sizing), the fragment shader (the
 * density field) and `FireAbility.radiusProfile` (the proxy geometry). All four
 * have to agree or the hull clips the volume.
 */
const PROFILE_GLSL = /* glsl */ `
  uniform float uWakeSpread;
  float flameProfile(float u) {
    return (0.34 + 0.66 * pow(u, 0.55)) * (1.0 + uWakeSpread * pow(1.0 - u, 1.8));
  }
`;

/**
 * Firebending, raymarched as a black-body volume.
 *
 * The mesh this material is applied to is *not* the flame — it is only a
 * camera-facing proxy hull around the flight path (see RibbonGeometry's `frame`
 * option). Every fragment reconstructs the curve's local frame from
 * `aCenter` / `aTangent`, fires a ray from the camera through itself and
 * integrates emission and absorption through the field described below.
 *
 * The field is built in four layers, coarsest first, because that is the order
 * in which the eye reads a real fireball:
 *
 *  1. *silhouette* — a capsule around the flight path, teardrop in cross
 *     section (buoyancy stretches it upward), whose local radius is modulated
 *     by one very low frequency noise octave. That last part is not decoration:
 *     a fireball's outline is dominated by lobes metres across, and multi-octave
 *     turbulence at flame-detail frequency can only nibble at the edge of a
 *     capsule — the result still reads as a shaded tube.
 *  2. *vortex roll-up* — hot gas sheds ring vortices that travel back down the
 *     wake and grow as they age. Rotating the noise domain in the (streamwise,
 *     vertical) plane by a travelling wave folds the field over on itself, which
 *     is what produces the curling, mushrooming billows. Plain fbm, however many
 *     octaves, makes clouds; it never makes curls.
 *  3. *turbulence* — 5 progressively domain-warped octaves, rotated between
 *     octaves to kill lattice alignment, each drifting upward faster than the
 *     last so fine detail outruns the coarse shapes it rides on and tears into
 *     upward-licking tongues.
 *  4. *shred* — the erosion is weak on the axis and violent at the fringe, so
 *     the flame keeps a solid burning heart while its edge dissolves into the
 *     strands and detached wisps a real flame has.
 *
 * Shading is temperature-driven rather than gradient-driven:
 *
 *   temperature  carried by the capsule falloff — geometry — and only *nudged*
 *                by the two coarsest noise octaves, so a tongue stays hot along
 *                its own spine without the noise drawing itself. It flattens out
 *                with age, because spent gas has mixed and no longer has a hot
 *                axis and a cool skin.
 *   emission     Planckian black-body colour at that temperature, radiated as
 *                (T/Tcore)^3. Fire is not a palette, it is a temperature: the
 *                red fringe → orange body → white core continuum, and the vast
 *                brightness range across it, both fall out of the physics.
 *   scattering   cool gas near the burning core is bathed in its light. Without
 *                this the sooty fringe goes flat black instead of glowing.
 *   absorption   soot extinction. Cold smoke occludes hard, but even the hottest
 *                gas keeps a floor of it (`uCoreClarity`): without that floor the
 *                march integrates the entire depth of the fireball into one
 *                clipped white blob instead of showing its near face.
 *
 * A warning that cost a lot of renders to learn, since it governs three separate
 * decisions in here (the coarse-only heat field, the modest `uHeatFollow`, the
 * age flattening): radiated power goes as a high power of temperature, so
 * whatever drives the temperature has its contrast multiplied several-fold on
 * screen. Point that amplifier at a turbulent field and it lands on the field's
 * level sets, which are nested closed loops, and the flame renders as polished
 * agate — dense contour lines wrapping every blob. No amount of colour tuning
 * fixes it; the fix is always to make the temperature blunter.
 *
 * That last point is why the blend mode is premultiplied "over" rather than the
 * additive blending the rest of the VFX use: a real flame both emits and blocks.
 * The march is clipped by the opaque depth prepass, so the volume is occluded by
 * the ground and the character and fades softly where it touches them.
 */
export class VolumetricFireMaterial extends ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      // Per-sample scene-depth clipping inside the march does the occlusion job
      // properly; testing the flat proxy hull's own depth would slice the volume.
      depthTest: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        /* shape */
        uRadius: { value: 0.95 },
        uHeadSize: { value: 2.1 },
        uPlume: { value: 1.8 },
        uWakeSpread: { value: 1.1 },
        uStreamLength: { value: 6.0 },
        uArcLength: { value: 7.0 },
        uTailPad: { value: 0.3 },
        uDetachment: { value: 0.5 },
        uSoftness: { value: 0.45 },
        uShred: { value: 1.35 },
        uBulge: { value: 0.28 },
        uBulgeScale: { value: 0.5 },
        /* motion */
        uFlow: { value: 2.4 },
        uBuoyancy: { value: 2.6 },
        uSwirl: { value: 0.45 },
        uSwirlSpeed: { value: 0.9 },
        uVortex: { value: 1.15 },
        uRingFreq: { value: 0.55 },
        uRingSpeed: { value: 1.6 },
        uNoiseFrequency: { value: 3.2 },
        uNoiseStrength: { value: 0.9 },
        uWarp: { value: 0.2 },
        uTongue: { value: 0.5 },
        uStreamStretch: { value: 0.3 },
        uWisp: { value: 0.0 },
        uFlicker: { value: 0.45 },
        uLick: { value: 3.2 },
        uOctaves: { value: 5 },
        /* temperature & radiance */
        uTempCore: { value: 3500 },
        uTempEdge: { value: 1550 },
        uEmissionCurve: { value: 2.6 },
        uHeatFocus: { value: 1.0 },
        uHeatFalloff: { value: 1.15 },
        uHeatFollow: { value: 0.2 },
        uTailHeat: { value: 0.5 },
        uPalette: { value: 0.0 },
        uScatter: { value: 0.9 },
        uScatterFalloff: { value: 2.2 },
        /* rendering */
        uDensity: { value: 1.35 },
        uSoot: { value: 1.5 },
        uCoreClarity: { value: 0.62 },
        uEmission: { value: 6.5 },
        uOpacity: { value: 1 },
        uSteps: { value: 44 },
        uSeed: { value: Math.random() * 20 },
        uHeadFade: { value: 0 },
        uTailFade: { value: 0.1 },
        uColorCore: { value: new Color(1, 0.96, 0.82) },
        uColorMid: { value: new Color(1, 0.69, 0.18) },
        uColorEdge: { value: new Color(1, 0.24, 0.06) },
        uColorSmoke: { value: new Color(0.14, 0.1, 0.09) }
      }),
      vertexShader: /* glsl */ `
        uniform float uArcLength;
        uniform float uTailPad;
        uniform float uStreamLength;
        uniform float uRadius;
        uniform float uHeadSize;

        attribute float aDist;
        attribute float aRandom;
        attribute vec3  aCenter;
        attribute vec3  aTangent;

        varying vec3  vCenter;
        varying vec3  vTangent;
        varying float vS;
        varying float vRadius;
        varying vec3  vWorld;
        varying float vRandom;

        ${PROFILE_GLSL}

        void main() {
          vCenter = aCenter;
          vTangent = normalize(aTangent);
          // Metres from the tail of the *stream* (the hull is padded at both
          // ends so its end caps are covered).
          vS = aDist * uArcLength - uTailPad;
          vRandom = aRandom;

          // Local tube radius, so the fragment can size its march window to the
          // flame in front of it instead of to the fattest part of the stream —
          // the thin tail gets fine steps rather than mostly empty ones.
          float u = clamp(vS / max(uStreamLength, 0.01), 0.0, 1.0);
          vRadius = uRadius * flameProfile(u)
                  * (1.0 + (uHeadSize - 1.0) * smoothstep(0.62, 1.0, u));

          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uRadius;
        uniform float uHeadSize;
        uniform float uPlume;
        uniform float uStreamLength;
        uniform float uDetachment;
        uniform float uSoftness;
        uniform float uShred;
        uniform float uBulge;
        uniform float uBulgeScale;
        uniform float uFlow;
        uniform float uBuoyancy;
        uniform float uSwirl;
        uniform float uSwirlSpeed;
        uniform float uVortex;
        uniform float uRingFreq;
        uniform float uRingSpeed;
        uniform float uNoiseFrequency;
        uniform float uNoiseStrength;
        uniform float uWarp;
        uniform float uTongue;
        uniform float uStreamStretch;
        uniform float uWisp;
        uniform float uFlicker;
        uniform float uLick;
        uniform float uOctaves;
        uniform float uTempCore;
        uniform float uTempEdge;
        uniform float uEmissionCurve;
        uniform float uHeatFocus;
        uniform float uHeatFalloff;
        uniform float uHeatFollow;
        uniform float uTailHeat;
        uniform float uPalette;
        uniform float uScatter;
        uniform float uScatterFalloff;
        uniform float uDensity;
        uniform float uSoot;
        uniform float uCoreClarity;
        uniform float uEmission;
        uniform float uOpacity;
        uniform float uSteps;
        uniform float uSeed;
        uniform float uHeadFade;
        uniform float uTailFade;
        uniform vec3  uColorCore;
        uniform vec3  uColorMid;
        uniform vec3  uColorEdge;
        uniform vec3  uColorSmoke;
        uniform float uShaderIntensity;
        uniform float uGlobalGlow;
        uniform vec2  uResolution;
        uniform sampler2D uSceneDepth;
        uniform float uCameraNear;
        uniform float uCameraFar;

        varying vec3  vCenter;
        varying vec3  vTangent;
        varying float vS;
        varying float vRadius;
        varying vec3  vWorld;
        varying float vRandom;

        ${noiseGLSL}
        ${commonGLSL}
        ${PROFILE_GLSL}

        /* Where the fringe shred starts and stops. REACH_HI bounds how far
           outside the nominal tube the noise can push density, and therefore how
           wide the proxy hull has to be — it is mirrored by FIRE_SHRED_REACH on
           the JS side. */
        const float REACH_LO = 1.15;
        const float REACH_HI = 1.55;

        /* A volume march needs a *cheap* field: this is trilinear value noise on
           a hashed lattice, roughly a third of the cost of the simplex noise the
           surface shaders use, and indistinguishable once five octaves of it are
           being advected, warped and rolled. */
        float vnoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);

          float a = hash13(i);
          float b = hash13(i + vec3(1.0, 0.0, 0.0));
          float c = hash13(i + vec3(0.0, 1.0, 0.0));
          float d = hash13(i + vec3(1.0, 1.0, 0.0));
          float e = hash13(i + vec3(0.0, 0.0, 1.0));
          float g = hash13(i + vec3(1.0, 0.0, 1.0));
          float h = hash13(i + vec3(0.0, 1.0, 1.0));
          float k = hash13(i + vec3(1.0, 1.0, 1.0));

          return mix(
            mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
            mix(mix(e, g, f.x), mix(h, k, f.x), f.y),
            f.z
          );
        }

        /* Unit-determinant rotation applied between octaves. Value noise is
           built on an axis-aligned lattice, so stacking octaves along the same
           axes lines their features up into a visible grid; rotating the domain
           between them scatters that structure. */
        const mat3 OCTAVE_ROT = mat3(
           0.00,  0.80,  0.60,
          -0.80,  0.36, -0.48,
          -0.60, -0.48,  0.64
        );

        /**
         * Turbulent flame field, normalised to 0..1.
         *
         * Three things separate this from a plain fbm, and two of them are free —
         * they reuse octave values that have already been paid for:
         *
         *  - *progressive domain warping*: each octave is displaced by the one
         *    before it, which folds the field over itself. Straight fbm gives
         *    round, cloud-like blobs; warped fbm gives the curling, billowing
         *    sheets fire actually makes.
         *  - *buoyant shear*: every octave also drifts upward faster than the
         *    last, so fine detail outruns the coarse shapes it sits on and the
         *    structures tear into upward-licking tongues.
         *  - *inter-octave rotation*: see OCTAVE_ROT.
         *
         * @param ridge out — sharp ridged filaments from the two finest octaves,
         *              0..1, used to shred the fringe into strands.
         * @param coarse out — the field truncated to its two largest scales,
         *              0..1. Temperature is read off *this* rather than off the
         *              full field; see the note where it is used.
         */
        float flameFbm(vec3 p, float rise, out float ridge, out float coarse) {
          float v = 0.0;
          float a = 0.5;
          float norm = 0.0;
          float scale = 1.0;
          ridge = 0.0;
          coarse = 0.5;

          for (int i = 0; i < 5; i++) {
            if (float(i) >= uOctaves) break;

            float n = vnoise(p);
            v += a * n;
            norm += a;
            if (i == 1) coarse = v / norm;
            // Ridges come from the finest octaves alone. Averaging the coarse
            // octaves in as well produces broad, smooth ridges that trace the
            // iso-lines of the field, and those read as contour lines drawn on
            // the flame rather than as strands in it.
            if (i >= 3) ridge = max(ridge, 1.0 - abs(n * 2.0 - 1.0));

            p = OCTAVE_ROT * p * 2.17 + (n - 0.5) * uWarp * vec3(1.7, 0.9, 1.3);
            scale *= 2.17;
            p.y -= rise * scale * (1.0 + 0.6 * float(i));
            a *= 0.55;
          }

          return v / max(norm, 1e-4);
        }

        /**
         * Planckian radiator, converted to the linear working space.
         *
         * Fire is not a palette, it is a temperature. The reason a real flame
         * runs deep red at its fringe, orange through its body and white in its
         * core is that those are the colours a grey body emits between roughly
         * 1200 K and 3300 K — and the reason the core blows out while the fringe
         * stays dim is that the power emitted scales as T^4. Both fall out of the
         * physics here instead of having to be dialled in by hand, which is why
         * the result holds together at any exposure.
         *
         * Fit: Tanner Helland's piecewise approximation, valid 1000-40000 K.
         */
        vec3 blackbody(float kelvin) {
          float t = clamp(kelvin, 1000.0, 12000.0) * 0.01;
          vec3 c;
          if (t <= 66.0) {
            c.r = 1.0;
            c.g = 0.3900816 * log(t) - 0.6318414;
            c.b = t <= 19.0 ? 0.0 : 0.5432068 * log(t - 10.0) - 1.1962540;
          } else {
            c.r = 1.2929362 * pow(t - 60.0, -0.1332047);
            c.g = 1.1298909 * pow(t - 60.0, -0.0755148);
            c.b = 1.0;
          }
          c = clamp(c, 0.0, 1.0);
          return c * c * (0.6 + 0.4 * c); // cheap, accurate-enough sRGB -> linear
        }

        /**
         * Density of the flame at a world point.
         *
         * @param heat out — normalised temperature, 0 at the perturbed surface,
         *             1 in the burning core.
         * @param bath out — how strongly this point is lit by the flame around
         *             it, for the single-scatter term.
         */
        float flameSample(vec3 p, out float heat, out float bath) {
          heat = 0.0;
          bath = 0.0;

          vec3 rel = p - vCenter;
          float ax = dot(rel, vTangent);
          vec3 perp = rel - vTangent * ax;

          float s = vS + ax;                                  // metres from the tail
          float u = clamp(s / max(uStreamLength, 0.01), 0.0, 1.0);
          float age = 1.0 - u;

          // Billowing wake behind a fireball at the nose.
          float radius = uRadius * flameProfile(u)
                       * (1.0 + (uHeadSize - 1.0) * smoothstep(0.62, 1.0, u));

          // A local frame whose "up" is world up (projected off the tangent), so
          // buoyancy, the teardrop stretch and the vertical elongation of the
          // noise all pull in the direction gravity actually cares about.
          vec3 upAxis = vec3(0.0, 1.0, 0.0) - vTangent * vTangent.y;
          float upLen = length(upAxis);
          upAxis = upLen > 1e-3 ? upAxis / upLen : vec3(1.0, 0.0, 0.0);
          vec3 sideAxis = cross(vTangent, upAxis);

          float py = dot(perp, upAxis);
          float px = dot(perp, sideAxis);

          // Buoyant stretch: mostly upward, so the cross-section is a teardrop
          // rather than a symmetric tube. The underside gets a quarter of it —
          // enough that the flame drapes instead of ending on a flat horizontal
          // cut, which is what an unstretched underside reads as.
          float plume = max(uPlume, 0.05);
          float shapedY = py > 0.0 ? py / plume : py / (1.0 + (plume - 1.0) * 0.25);
          float rad = length(vec2(px, shapedY));

          // Fold the axial overshoot past either end into the radius: a capsule,
          // so the stream ends in round caps instead of being sliced flat.
          float over = s - clamp(s, 0.0, uStreamLength);
          rad = sqrt(rad * rad + over * over);

          // Conservative reject *before* paying for any noise: even with the
          // bulge pushed fully outward the field cannot reach past this. Most
          // samples along most rays land here, so this test is what pays for the
          // headroom the hull needs.
          float qNominal = rad / max(radius, 1e-3);
          if (qNominal > REACH_HI * (1.0 + uBulge)) return 0.0;

          float sFlow = s - uTime * uFlow;                    // streams backwards

          // ---- 1. silhouette: metre-scale lobes -------------------------
          // One octave, wavelength of order the flame's own width. A fireball's
          // outline is dominated by lobes this size; turbulence at flame-detail
          // frequency can only nibble the edge of a capsule and the result still
          // reads as a shaded tube.
          float lobe = vnoise(vec3(px, py * 0.8, sFlow * 0.7) * uBulgeScale
                              + vec3(uSeed, uTime * 0.25, 0.0)) * 2.0 - 1.0;
          radius *= 1.0 + uBulge * lobe;

          float q = rad / max(radius, 1e-3);
          float edge = 1.0 - q;
          if (edge < -1.2) return 0.0;

          // ---- 2. vortex roll-up ----------------------------------------
          // Noise domain attached to the stream (a local frame around the axis)
          // so the fire is carried along instead of swimming through the world.
          vec2 rp = rot2(s * uSwirl * 0.3 + uTime * uSwirlSpeed + uSeed) * vec2(px, py);

          // Hot gas sheds ring vortices that travel back down the wake and grow
          // as they age. Rotating the domain in the (streamwise, vertical) plane
          // by that travelling wave folds the field over on itself — this is what
          // produces curling, mushrooming billows. Plain fbm, at any octave
          // count, makes clouds; it never makes curls. The rotation is strongest
          // on the axis and dies off outside the tube, so the fringe is sheared
          // past the core rather than rotating rigidly with it.
          float phase = s * uRingFreq - uTime * uRingSpeed + uSeed;
          float roll = uVortex * sin(phase * 6.2831853)
                     * smoothstep(0.0, 0.32, age) * exp(-q * q * 0.7);
          vec2 rolled = rot2(roll) * vec2(sFlow * uStreamStretch, rp.y * uTongue);

          // ---- 3. turbulence --------------------------------------------
          // Anisotropic on purpose: a lower frequency vertically and along the
          // flow draws every structure out into a tall, streamwise tongue.
          vec3 np = vec3(rp.x, rolled.y, rolled.x) * uNoiseFrequency;
          np.y -= uTime * uBuoyancy;                          // hot gas climbs

          // Radial shear. Gas at the fringe is unconfined and has been climbing
          // and falling behind for longer than gas on the axis, so the domain is
          // dragged upward and backward in proportion to how far out it sits.
          // This is what turns rounded blobs into the tongues that lick up off a
          // flame's edge: without a shear the structures are the same shape
          // everywhere and only their size changes.
          np.y -= uLick * q * q;
          np.z += uLick * 0.45 * q * q;

          float ridge, coarse;
          float n = flameFbm(np, uTime * uBuoyancy * 0.06, ridge, coarse) * 2.0 - 1.0;
          coarse = coarse * 2.0 - 1.0;

          // Filaments belong to the fringe. In the body they only mottle a core
          // that should read as one continuous sheet of burning gas.
          //
          // Note the sign: the ridge peaks *on* an iso-line of the noise, so
          // adding it thickens the iso-lines and the flame ends up drawn in
          // bright closed loops, like a contour map. Subtracting it instead
          // deepens the gaps between lobes, which is what actually separates the
          // fringe into strands.
          float fringe = smoothstep(0.3, 1.05, q);
          float turbulent = n * 0.75 + (0.5 - ridge) * uWisp * fringe;

          // ---- 4. shred --------------------------------------------------
          // The heart of the flame is barely touched by the noise while the
          // fringe is torn apart by it. That contrast — solid burning core, an
          // edge dissolving into wisps — is most of what reads as "fire".
          //
          // The falloff past REACH_LO is not cosmetic: it is what bounds how far
          // outside the nominal tube the noise can push density. Without it the
          // volume reaches well past the proxy hull and the flame is sliced off
          // along a visibly straight edge.
          // The coherent burning core belongs to the head. By the far end of the
          // wake the gas has been churning for the whole flight and there is no
          // quiet axis left, so the erosion floor climbs with age.
          float shred = mix(mix(0.26, 1.0, age), 1.8 * uShred, smoothstep(0.06, 1.05, q))
                      * (1.0 - smoothstep(REACH_LO, REACH_HI, q));
          // Turbulence is *fully developed* in the wake and still growing at the
          // head: the gas at the far end has had the whole flight to break up.
          // Without this the tail is the smoothest part of the volume, and a
          // smooth field marched with a hard density threshold renders its own
          // iso-surfaces as concentric shells — the flame ends up wearing
          // contour rings exactly where it should look most chaotic.
          float erosion = uNoiseStrength * shred * (1.0 + 1.3 * age);
          float field = edge + turbulent * erosion;
          field -= uDetachment * age * 0.55;                  // the tail tears into puffs

          // Temperature gets its own, deliberately blunter field, and the reason
          // is the single least obvious thing in this shader.
          //
          // Radiated power goes as a high power of temperature, so whatever
          // drives the temperature gets its contrast multiplied several-fold on
          // screen. Drive it from the full density field and that amplification
          // lands on the level sets of turbulent noise — which are nested closed
          // loops — and the flame comes out looking like polished agate: dense
          // parallel contour lines wrapping every blob. It is unmistakable once
          // seen and impossible to tune away from the colour end.
          //
          // So the contrast is carried by the capsule falloff, i.e. geometry: hot on the
          // axis, cooling outward, no level sets of its own. The noise only
          // *displaces* that profile — enough that a tongue stays hot along its
          // spine, not enough to draw itself. And it is the two coarsest octaves
          // that do the displacing, since a reaction zone is thick compared with
          // the smallest turbulent scales.
          // Deliberately not the age-amplified erosion the density uses: letting
          // the wake's extra churn into the temperature brings the agate straight
          // back, and only in the tail, which is the last place it is wanted.
          float heatField = edge + coarse * uHeatFollow * uNoiseStrength * shred
                          - uDetachment * age * 0.55;

          float d = smoothstep(0.0, clamp(uSoftness, 0.05, 1.0), field);
          if (d <= 0.0) return 0.0;

          d *= smoothstep(0.0, max(uTailFade, 0.01), u);
          d *= 1.0 - smoothstep(1.0 - uHeadFade, 1.0, u) * step(0.001, uHeadFade);

          // ---- temperature ------------------------------------------------
          // Follows the *perturbed* shape rather than the distance to the axis, so
          // a tongue the large eddies pushed outward stays hot along its own spine
          // and cools toward its own tip — the difference between filaments that
          // are burning and filaments that have been painted orange onto a
          // cylinder. Reading it off the density instead would clamp to 1 across
          // the whole core and flatten the flame into a single white blob.
          float interior = clamp(heatField * uHeatFocus, 0.0, 1.0);
          // Spent gas has mixed. It no longer has a hot axis and a cool skin —
          // it is all roughly one temperature, simply dimming. Flattening the
          // radial profile with age is also what keeps the thin tail from
          // rendering as a stack of nested rings: that is where the radial
          // gradient is steepest, so that is where equal steps of temperature
          // are packed closest together and the high radiance exponent turns
          // them into visible bands.
          interior = mix(interior, 0.55, age * age * 0.65);
          // ...and behind the head it has also had time to radiate away.
          float cool = mix(uTailHeat, 1.0, pow(u, 0.55));
          heat = clamp(pow(interior, max(uHeatFalloff, 0.05)) * cool, 0.0, 1.0);

          // Cool gas close to the burning core is bathed in its light.
          bath = exp(-max(q - 0.5, 0.0) * uScatterFalloff) * (1.0 - heat);

          return d * uDensity;
        }

        void main() {
          vec3 ro = cameraPosition;
          vec3 rd = normalize(vWorld - ro);

          // The hull is a camera-facing strip through the axis, so every pixel
          // gets exactly one fragment and that fragment has to march the whole
          // volume along its ray. Bounding it with a sphere is what the obvious
          // implementation does, and it is ruinous here: the flame is stretched
          // two-and-a-half times taller than it is wide, so a sphere big enough
          // to hold it is two-and-a-half times too long in the direction almost
          // every ray actually travels — the fixed step budget gets spread over
          // a slab that is mostly empty and the volume samples at a fraction of
          // the resolution it should.
          //
          // Bounding with the *ellipsoid* the volume actually occupies instead
          // costs one extra dot product and buys back that factor directly as
          // step density. Solve it as a unit sphere in the squashed frame.
          float reach = REACH_HI * (1.0 + uBulge);
          vec3 up = vec3(0.0, 1.0, 0.0) - vTangent * vTangent.y;
          float upLen = length(up);
          up = upLen > 1e-3 ? up / upLen : vec3(1.0, 0.0, 0.0);
          vec3 side = cross(vTangent, up);

          float rPerp = max(vRadius * reach, uRadius * 0.2);
          float rUp   = rPerp * max(uPlume, 1.0);
          float rDown = rPerp * (1.0 + (max(uPlume, 1.0) - 1.0) * 0.25);
          // The plume only stretches upward, so the bound is an ellipsoid lifted
          // off the axis rather than centred on it.
          float rVert = (rUp + rDown) * 0.5;
          vec3 origin = vCenter + up * (rUp - rDown) * 0.5;
          // Looking down the barrel of the stream, a ray stays inside the volume
          // for its whole length; broadside, it is through in one diameter.
          float axial = abs(dot(rd, vTangent));
          float rLong = mix(rPerp, max(uStreamLength * 0.6, rPerp), axial * axial);

          vec3 o = ro - origin;
          vec3 eo = vec3(dot(o, side) / rPerp, dot(o, up) / rVert, dot(o, vTangent) / rLong);
          vec3 ed = vec3(dot(rd, side) / rPerp, dot(rd, up) / rVert, dot(rd, vTangent) / rLong);
          float ea = dot(ed, ed);
          float eb = dot(eo, ed);
          float ec = dot(eo, eo) - 1.0;
          float disc = eb * eb - ea * ec;
          if (disc <= 0.0) discard;
          float esq = sqrt(disc);
          float maxRadius = rPerp;
          float t0 = max((-eb - esq) / ea, 0.02);
          float t1 = (-eb + esq) / ea;

          // Clip the march on the opaque scene: correct occlusion by the ground
          // and the character, for free.
          float dzdt = (viewMatrix * vec4(rd, 0.0)).z;
          float packed = unpackRGBAToDepth(texture2D(uSceneDepth, gl_FragCoord.xy / uResolution));
          float sceneViewZ = perspectiveDepthToViewZ(packed, uCameraNear, uCameraFar);
          float tScene = dzdt < -1e-5 ? sceneViewZ / dzdt : 1e6;
          t1 = min(t1, tScene);
          if (t1 <= t0) discard;

          float steps = clamp(uSteps, 6.0, 72.0);
          float baseStep = (t1 - t0) / steps;
          // Dither the entry point: a fixed start turns the slices into visible
          // onion rings, a per-pixel offset turns them into grain the bloom eats.
          float t = t0 + baseStep * hash13(vec3(gl_FragCoord.xy, fract(uTime) * 64.0));

          // One flicker value for the whole ray — the flame brightens and dims
          // as a body, not per sample. Two rates: a slow roll from the bulk of
          // the gas, a fast tremor from the burn itself.
          // Amplitude deliberately modest and clamped. This multiplies the whole
          // ray, so a swing wide enough to look dramatic on paper reads on screen
          // as the fireball guttering out for a frame at a time.
          float flickN = vnoise(vec3(uTime * 5.3, uSeed, 0.0)) * 0.7
                       + vnoise(vec3(uTime * 13.1, uSeed * 2.0, 5.0)) * 0.3;
          float flick = clamp(1.0 + uFlicker * 0.6 * (flickN * 2.0 - 1.0), 0.4, 1.7);

          vec3 acc = vec3(0.0);
          float transmittance = 1.0;
          // The hull has to be wide enough for the noise to push the volume out
          // to its full reach, which leaves most rays crossing a lot of empty
          // space. Coasting through it at a coarser stride — and dropping back
          // to the fine one the moment anything is hit — buys back the cost of
          // that headroom without thinning the samples where they matter.
          float stride = 1.0;

          for (int i = 0; i < 72; i++) {
            if (t >= t1 || transmittance < 0.012) break;

            float heat, bath;
            float d = flameSample(ro + rd * t, heat, bath);
            float stepSize = baseStep * stride;

            if (d > 0.002) {
              stride = 1.0;
              stepSize = baseStep;
              // Soften the contact with whatever the march ran into.
              d *= clamp((tScene - t) / max(maxRadius * 0.6, 1e-3), 0.0, 1.0);

              float kelvin = mix(uTempEdge, uTempCore, heat);
              // The palette blend keeps the editor's four colour stops meaningful
              // without letting them fight the physics: at 0 the flame is a pure
              // radiator, at 1 it is the hand-authored ramp.
              vec3 artistic = gradient4(uColorCore, uColorMid, uColorEdge, uColorSmoke,
                                        pow(1.0 - heat, 0.85));
              vec3 tint = mix(blackbody(kelvin), artistic, clamp(uPalette, 0.0, 1.0));

              // Stefan-Boltzmann. This single exponent is what gives the volume
              // its enormous internal dynamic range: a white-hot core forty times
              // brighter than the red gas two centimetres outside it.
              float power = pow(kelvin / max(uTempCore, 1.0), uEmissionCurve);
              vec3 emission = tint * power;

              // Single scatter: the sooty gas wrapped around the burn does not
              // radiate on its own, it reflects. Without this term the fringe
              // and the smoky underside collapse to flat black and the flame
              // loses the halo that sits between it and the smoke.
              emission += mix(uColorEdge, uColorMid, bath) * uScatter * bath * bath * 0.06;

              acc += emission * uEmission * flick * d * transmittance * stepSize;

              // Soot extinction: the cool fringe blocks the background hard, and
              // even the hot gas keeps enough of it to occlude its own far side,
              // which is what leaves visible structure in the fireball instead
              // of one integrated white disc.
              // Squared, so only the genuinely white-hot gas turns clear. Fading
              // the soot away linearly with temperature thins the merely warm
              // gas on the near face too, and that gas is exactly what draws the
              // dark filaments across a real fireball's bright interior.
              transmittance *= exp(-d * uSoot * mix(1.0, uCoreClarity, heat * heat) * stepSize);
            } else {
              stride = min(stride * 1.6, 2.2);
            }

            t += stepSize;
          }

          float alpha = clamp((1.0 - transmittance) * uOpacity, 0.0, 1.0);
          vec3 color = acc * uOpacity * uGlobalGlow * mix(0.65, 1.0, uShaderIntensity);
          if (alpha < 0.002 && max(color.r, max(color.g, color.b)) < 0.002) discard;

          gl_FragColor = vec4(color, alpha);
        }
      `
    });
  }

  /** Pull live editor values (called once per frame by the ability). */
  sync() {
    const c = settings.fire;
    const g = settings.global;
    const u = this.uniforms;

    u.uRadius.value = c.flameWidth;
    u.uHeadSize.value = c.headSize;
    u.uPlume.value = c.flameHeight;
    u.uWakeSpread.value = c.wakeSpread;
    u.uDetachment.value = c.detachment;
    u.uSoftness.value = c.softness;
    u.uShred.value = c.shred;
    u.uBulge.value = c.bulge;
    u.uBulgeScale.value = c.bulgeScale;

    u.uFlow.value = c.flameSpeed * g.noiseSpeed;
    u.uBuoyancy.value = c.buoyancy * g.noiseSpeed;
    u.uSwirl.value = c.flameCurl * g.turbulence;
    u.uSwirlSpeed.value = c.flameSpeed * 0.35 * g.noiseSpeed;
    u.uVortex.value = c.vortex * g.turbulence;
    u.uRingFreq.value = c.ringFrequency;
    u.uRingSpeed.value = c.ringSpeed * g.noiseSpeed;
    u.uNoiseFrequency.value = c.noiseFrequency * g.noiseFrequency;
    u.uNoiseStrength.value =
      0.28 * c.flameTurbulence * c.noiseStrength * g.turbulence * g.noiseStrength;
    u.uWarp.value = c.flameWarp * g.turbulence;
    u.uTongue.value = c.tongueStretch;
    u.uStreamStretch.value = c.streamStretch;
    u.uWisp.value = c.wisps;
    u.uFlicker.value = c.flicker;
    u.uLick.value = c.lick;
    u.uOctaves.value = c.detailOctaves;

    u.uTempCore.value = c.tempCore;
    u.uTempEdge.value = c.tempEdge;
    u.uEmissionCurve.value = c.emissionCurve;
    u.uHeatFocus.value = c.heatFocus;
    u.uHeatFalloff.value = c.heatFalloff;
    u.uHeatFollow.value = c.heatFollow;
    u.uTailHeat.value = c.tailHeat;
    u.uPalette.value = c.paletteBlend;
    u.uScatter.value = c.scatter;
    u.uScatterFalloff.value = c.scatterFalloff;

    u.uDensity.value = c.volumeDensity;
    u.uSoot.value = c.soot;
    u.uCoreClarity.value = c.coreClarity;
    u.uEmission.value = c.glow * 2.4;
    u.uOpacity.value = c.opacity * g.opacity;
    u.uSteps.value = c.volumeSteps;

    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorMid.value.copy(getColor(c.colorMid));
    u.uColorEdge.value.copy(getColor(c.colorEdge));
    u.uColorSmoke.value.copy(getColor(c.colorSmoke));
  }
}
