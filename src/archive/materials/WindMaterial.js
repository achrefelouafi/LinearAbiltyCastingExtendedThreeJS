import { ShaderMaterial, AdditiveBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Airbending ribbon — a *tress of combed silk*, not a single strip.
 *
 * Reference airbending art reads as dozens of hairline vapour filaments running
 * the length of a broad sheet: long, unbroken, roughly parallel, bunching into
 * bright tresses and splaying open again, with loose flyaway hairs escaping the
 * silhouette. Drawing that with one ribbon per strand would cost hundreds of
 * quads, so instead each ribbon is a wide camera-facing sheet and the fragment
 * shader combs it laterally into hairlines.
 *
 * The critical property is anisotropy: the fields that sway, bunch and dim the
 * comb vary almost entirely *along* the ribbon and barely across it. That is
 * what keeps hairlines long and coherent — noise applied across the sheet, or
 * at high frequency along it, immediately reads as smoke mush instead of hair.
 *
 * Two combs are layered: a fine one for the hairlines and a sparser, softer one
 * for the broad silky sheets they sit on. Where hairlines pack tighter than a
 * pixel the antialias floor merges them into a solid sheet on its own, which is
 * exactly what the dense parts of the bundle should do.
 */
export class WindRibbonMaterial extends ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uColorInner: { value: new Color(0.92, 0.97, 1.0) },
        uColorOuter: { value: new Color(0.56, 0.84, 1.0) },
        uOpacity: { value: 0.45 },
        uGlow: { value: 0.8 },
        uFresnel: { value: 1.4 },
        uNoiseStrength: { value: 0.7 },
        uNoiseFrequency: { value: 2.0 },
        uSwirlSpeed: { value: 2.2 },
        uFilaments: { value: 22.0 },
        uFilamentSharp: { value: 0.9 },
        uTurbulence: { value: 1.0 },
        uHaze: { value: 0.45 },
        uTailFade: { value: 0.16 }
      }),
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSwirlSpeed;

        attribute vec3  aNormal;
        attribute float aDist;
        attribute float aSide;
        attribute float aRandom;
        /** Constant across one ribbon — decorrelates the strands of each braid. */
        attribute float aSeed;

        varying vec2  vUv;
        varying float vAlong;
        varying vec3  vNormalW;
        varying vec3  vViewDir;
        varying float vRandom;
        varying float vSeed;
        varying float vViewZ;

        void main() {
          vUv = uv;
          vAlong = aDist;
          vRandom = aRandom;
          vSeed = aSeed;

          vec4 world = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * aNormal);
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
        uniform float uNoiseStrength;
        uniform float uNoiseFrequency;
        uniform float uSwirlSpeed;
        uniform float uFilaments;
        uniform float uFilamentSharp;
        uniform float uTurbulence;
        uniform float uHaze;
        uniform float uTailFade;
        uniform float uShaderIntensity;
        uniform float uGlobalGlow;
        uniform vec2  uResolution;
        uniform sampler2D uSceneDepth;
        uniform float uCameraNear;
        uniform float uCameraFar;

        varying vec2  vUv;
        varying float vAlong;
        varying vec3  vNormalW;
        varying vec3  vViewDir;
        varying float vRandom;
        varying float vSeed;
        varying float vViewZ;

        ${noiseGLSL}
        ${commonGLSL}

        /**
         * One comb of hairlines over the lane coordinate \`u\`.
         *
         * @param u      lane coordinate (already swayed and bunched)
         * @param n      strands per unit of u
         * @param seed   decorrelates this comb from the others
         * @param sharp  0 = broad soft ribbons, 1 = hairlines
         * @param t      position along the ribbon, 0 tail .. 1 head
         * @returns x = strand core, y = the soft body around it
         */
        vec2 comb(float u, float n, float seed, float sharp, float t, float flow) {
          float cell = u * n;
          float id   = floor(cell);
          float r1   = hash11(id * 1.37 + seed);
          float r2   = hash11(id * 4.11 + seed * 3.7);

          // Irregular spacing plus a slow lengthwise wander. Real hair is never
          // evenly combed, and a strand drifts across its whole length rather
          // than jittering from sample to sample.
          float off = (r1 - 0.5) * 0.7
                    + sin(t * (1.1 + r2 * 2.2) + r1 * 6.2831 + flow * (0.15 + r2 * 0.2)) * 0.22;

          float d = abs(fract(cell - off) - 0.5) * 2.0;   // 0 on the strand, 1 at the lane edge

          // Antialias floor: widen the strand to at least a pixel.
          float w0 = mix(0.5, 0.06, clamp(sharp, 0.0, 1.0));
          float aa = fwidth(cell);
          float w  = max(w0, aa * 2.0);

          float bw   = min(1.0, w * 6.0);
          float core = pow(1.0 - smoothstep(0.0, w, d), 2.0);
          float body = (1.0 - smoothstep(0.0, bw, d)) * 0.15;

          // Widening alone is not enough. Once the pixel footprint approaches
          // the strand's own width the comb is pure aliasing — it beats against
          // the sample grid and draws a stipple of dots and dashes instead of
          // hair. Past that point fade each profile into its average over the
          // lane, which is what an infinitely-sampled comb integrates to: the
          // strands melt into a smooth sheet, exactly what the dense tresses
          // should do anyway. The threshold has to track w0, not be a constant:
          // the sharper the hairlines, the sooner they stop resolving.
          float resolve = 1.0 - smoothstep(w0 * 0.35, w0 * 1.5, aa);
          core = mix(clamp(w, 0.0, 1.0) * 0.30, core, resolve);
          body = mix(bw * 0.5 * 0.15, body, resolve);

          // Per-strand weight. The frequency along t is deliberately low: raise
          // it and the hairlines break into dashes instead of fading in and out
          // over their length.
          float amp = mix(0.22, 1.0, r2)
                    * smoothstep(-0.45, 0.35,
                        fbm3(vec3(t * 1.5 - flow * 0.25, id * 2.7 + seed, uTime * 0.12)));

          return vec2(core, body) * amp;
        }

        void main() {
          float t      = clamp(vAlong, 0.0, 1.0);
          float across = vUv.y * 2.0 - 1.0;
          float radial = abs(across);

          float fres = fresnelTerm(vViewDir, vNormalW, 2.2, 1.0) * uFresnel;

          float flow = uTime * uSwirlSpeed;
          float freq = max(uNoiseFrequency, 0.05);

          // ---- comb frame -------------------------------------------------
          // Both fields depend on t alone, so every hairline in a cross-section
          // is displaced identically and the strands stay long and parallel.
          vec3 sp = vec3(t * freq * 2.4 - flow * 0.22, vSeed * 29.0, uTime * 0.15);
          float sway  = fbm3(sp) * uTurbulence;
          // Bunching: below 1 the comb squeezes into a tight tress, above 1 it
          // opens out into a fan.
          float gather = 0.45 + 0.75 * (fbm3(sp + vec3(31.7, 8.3, 2.1)) + 0.5);

          // Hairlines never sit on an even pitch — they crowd into two or three
          // tresses that slide across the sheet. A sine remap of the lateral
          // coordinate does it: where its derivative is small the lanes pack in
          // and read as a bright tress, where it is large they fan out into
          // separate hairs. The amplitude is capped so the derivative stays
          // positive; past that the comb folds back and mirrors itself.
          float twine = fbm3(sp + vec3(5.1, 19.4, 0.0)) * 3.0 + t * 1.8 - flow * 0.2;
          float clump = across + 0.20 * sin(across * 4.2 + twine);

          float u = (clump - sway * 0.45) / max(gather, 0.2);

          float n = max(uFilaments, 1.0);
          vec2 fine   = comb(u, n, vSeed * 53.0, uFilamentSharp, t, flow);
          // The coarse comb is a third as dense and much softer — the silky
          // sheets the hairlines ride on.
          vec2 coarse = comb(u * 0.34 + 7.3, n, vSeed * 91.0 + 13.0,
                             uFilamentSharp * 0.5, t, flow * 0.75);

          float core = fine.x + coarse.x * 0.5;
          float body = fine.y + coarse.y * 0.6;

          // Density falls away well inside the geometric edge, and strands with
          // a high stray value reach further out than the rest — the loose
          // flyaway hairs that sell the silhouette. Every added term is
          // positive, so the envelope is zero by radial = 1 whatever the noise
          // does and the quad edge can never show.
          // Per-lane, so it aliases the same way the comb does — collapse it to
          // its mean once the lanes stop resolving.
          float stray = hash11(floor(u * n) * 1.91 + vSeed * 7.0);
          stray = mix(0.5, stray, 1.0 - smoothstep(0.20, 0.55, fwidth(u * n)));
          float env = smoothstep(0.92, 0.05, radial + abs(sway) * 0.08 + (1.0 - stray) * 0.42);

          // The middle of the sheet is where strands overlap along the view ray,
          // so it reads as a bright spine.
          float spine = exp(-radial * radial * 3.5);

          // Milky vapour filling the gaps. It thins out towards the head, where
          // several ribbons overlap and would otherwise stack into a solid white
          // blob under additive blending.
          float hz = fbm3(vec3(t * freq * 1.9 - flow * 0.4, across * 1.2, uTime * 0.3));
          float haze = smoothstep(1.0, 0.05, radial + hz * uNoiseStrength * 0.35)
                     * uHaze * mix(1.0, 0.4, smoothstep(0.55, 1.0, t));

          float strand = (core * (0.85 + spine * 0.5) + body) * env;

          // Feather both ends. Both have to close all the way down or the strip
          // stops on a straight bright cut; the width profile narrows them, this
          // takes them out.
          float tail = smoothstep(0.0, max(uTailFade, 0.01), t)
                     * (1.0 - 0.85 * smoothstep(0.78, 1.0, t));
          float alpha = (strand * (0.8 + fres * 0.5) + haze * (0.13 + fres * 0.2)) * uOpacity * tail;

          vec2 screenUV = gl_FragCoord.xy / uResolution;
          alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, 0.4);
          if (alpha < 0.004) discard;

          // Strand cores burn out to the inner (near-white) colour; the haze
          // stays on the outer tint so the bundle keeps its cool cast.
          vec3 color = mix(uColorOuter, uColorInner,
                           clamp(core * 1.6 + spine * 0.25 + fres * 0.3, 0.0, 1.0));
          color *= uGlow * uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);

          gl_FragColor = vec4(color, alpha);
        }
      `
    });
  }

  sync() {
    const c = settings.wind;
    const g = settings.global;
    const u = this.uniforms;

    u.uColorInner.value.copy(getColor(c.colorInner));
    u.uColorOuter.value.copy(getColor(c.colorOuter));
    u.uOpacity.value = c.ribbonOpacity * c.opacity * g.opacity * 2.0;
    u.uGlow.value = c.glow;
    u.uFresnel.value = c.fresnel * g.fresnel;
    u.uNoiseStrength.value = c.noiseStrength * g.noiseStrength;
    u.uNoiseFrequency.value = c.noiseFrequency * g.noiseFrequency;
    u.uSwirlSpeed.value = c.swirlSpeed * g.noiseSpeed;
    u.uFilaments.value = c.filamentCount;
    u.uFilamentSharp.value = c.filamentSharpness;
    u.uTurbulence.value = c.turbulence;
    u.uHaze.value = c.haze;
  }
}

/**
 * The finale tornado: one shell of a nested stack that together read as a
 * column of dust-loaded air.
 *
 * A single cone with a texture on it always reads as a cone, however good the
 * texture is, because the two things the eye actually uses to identify a
 * tornado are both properties of the *shape*, not the surface:
 *
 *   - The silhouette is concave and never straight. A real funnel is a tight
 *     neck for most of its height that blooms into the parent cloud near the
 *     top, blows out into a debris fan where it scours the ground, and carries
 *     bulges and constrictions travelling up its length. So the mesh is a plain
 *     unit tube and every bit of that profile is evaluated in the vertex
 *     shader, where it can breathe and where the silhouette stays curved
 *     instead of faceted.
 *   - It has depth. Several shells at different radii, seeds and spin rates
 *     parallax against each other as the camera moves, which no amount of
 *     detail on one surface can fake.
 *
 * The surface shading then only has to sell the motion, and the one rule that
 * matters there is anisotropy: dust in a vortex is drawn into long helical
 * streaks, so the noise runs at a far lower frequency along the column than
 * around it. Isotropic noise immediately reads as boiling smoke on a cone.
 *
 * @param index  shell index, 0 = outermost. Drives radius, spin and seed.
 */
export class TornadoMaterial extends ShaderMaterial {
  constructor(index = 0) {
    super({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uColorInner: { value: new Color(0.92, 0.97, 1.0) },
        uColorOuter: { value: new Color(0.56, 0.84, 1.0) },
        uAge: { value: 0 },
        uOpacity: { value: 0.5 },
        uSpin: { value: 4.0 },
        uNoiseStrength: { value: 0.7 },
        uGlow: { value: 1.0 },
        uFresnel: { value: 1.2 },
        uNeck: { value: 0.18 },
        uFlare: { value: 2.0 },
        uSkirt: { value: 0.4 },
        uRough: { value: 0.16 },
        uLean: { value: 0.5 },
        uSeed: { value: 0 },
        uShellScale: { value: 1 }
      }),
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uAge;
        uniform float uNeck;
        uniform float uFlare;
        uniform float uSkirt;
        uniform float uRough;
        uniform float uLean;
        uniform float uSeed;
        uniform float uShellScale;

        varying vec2  vUv;
        varying vec3  vNormalW;
        varying vec3  vViewDir;
        varying float vViewZ;

        ${noiseGLSL}

        /** How far the funnel has roped out — thin and whipping, near the end. */
        float ropeT() { return smoothstep(0.62, 1.0, uAge); }

        /**
         * Lateral drift of the column's axis at height h, in local units.
         *
         * Deliberately seed-free so every shell snakes identically and the
         * stack stays coaxial. The ground contact is pinned and the drift grows
         * with height: a tornado is anchored where it touches down and leans
         * away from there, not the other way round.
         */
        vec2 coreOffset(float h) {
          float w = pow(clamp(h, 0.0, 1.0), 1.5);
          vec2 slow = vec2(snoise(vec3(h * 1.05, uTime * 0.33, 0.0)),
                           snoise(vec3(h * 1.05, uTime * 0.29, 17.3)));
          vec2 fast = vec2(snoise(vec3(h * 3.1, uTime * 0.95, 5.7)),
                           snoise(vec3(h * 3.1, uTime * 0.88, 41.2)));
          return (slow * 0.78 + fast * 0.3) * uLean * w * (1.0 + ropeT() * 2.0);
        }

        /** The funnel's radius at height h and azimuth ang, top radius = 1. */
        float funnelRadius(float h, float ang) {
          float hc = clamp(h, 0.0, 1.0);

          // Concave core profile: a tight neck opening out into the cloud.
          float r = mix(uNeck, 1.0, pow(hc, uFlare));

          // Debris fan where the funnel drags along the ground. Kept tight —
          // a wide flare is a large, near-horizontal surface, and additive
          // shading turns that into a saucer of milk around the contact.
          r += uSkirt * exp(-hc * 18.0);

          // Bulges and constrictions riding up the column. Constant around the
          // circumference — this is the column breathing, not a lumpy tube.
          r *= 1.0 + uRough * fbm3(vec3(hc * 2.6 - uTime * 0.9, uSeed * 7.0, uTime * 0.2));

          // A little out of round, so the silhouette never reads as a lathe.
          // Sampled on the circle itself, so it wraps at the seam.
          r *= 1.0 + 0.07 * snoise(vec3(cos(ang) * 1.3, sin(ang) * 1.3,
                                        hc * 2.2 - uTime * 0.7 + uSeed));

          // Roping out: the whole column narrows as it dies.
          r *= mix(1.0, 0.34, ropeT());
          return max(r, 0.015);
        }

        vec3 funnelPoint(float h, float ang) {
          float r = funnelRadius(h, ang) * uShellScale;
          vec3 p = vec3(cos(ang) * r, h, sin(ang) * r);
          p.xz += coreOffset(h);
          return p;
        }

        void main() {
          vUv = uv;
          float ang = uv.x * 6.2831853;
          vec3 pos = funnelPoint(uv.y, ang);

          // The mesh normal is meaningless once the profile is rebuilt here,
          // and the fresnel term is what draws the silhouette, so difference
          // the surface for a real one. Both tangents are pushed through the
          // model matrix first: the funnel is scaled far more in height than in
          // radius, and a normal transformed by that scale would point wrong.
          vec3 dh = funnelPoint(uv.y + 0.02, ang) - pos;
          vec3 da = funnelPoint(uv.y, ang + 0.06) - pos;

          vec4 world = modelMatrix * vec4(pos, 1.0);
          vec3 wh = (modelMatrix * vec4(pos + dh, 1.0)).xyz - world.xyz;
          vec3 wa = (modelMatrix * vec4(pos + da, 1.0)).xyz - world.xyz;
          vNormalW = normalize(cross(wh, wa) + 1e-6);

          vViewDir = cameraPosition - world.xyz;
          vec4 mv = viewMatrix * world;
          vViewZ = mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uAge;
        uniform vec3  uColorInner;
        uniform vec3  uColorOuter;
        uniform float uOpacity;
        uniform float uSpin;
        uniform float uNoiseStrength;
        uniform float uGlow;
        uniform float uFresnel;
        uniform float uSeed;
        uniform float uGlobalGlow;
        uniform float uShaderIntensity;
        uniform vec2  uResolution;
        uniform sampler2D uSceneDepth;
        uniform float uCameraNear;
        uniform float uCameraFar;

        varying vec2  vUv;
        varying vec3  vNormalW;
        varying vec3  vViewDir;
        varying float vViewZ;

        ${noiseGLSL}
        ${commonGLSL}

        void main() {
          float h = clamp(vUv.y, 0.0, 1.0);
          float ang = vUv.x * 6.2831853;

          // Conservation of angular momentum: the tight neck whips round
          // several times faster than the wide top. Shearing the dust that way
          // is most of what separates a vortex from a spinning cylinder.
          float rate = uSpin * mix(2.2, 0.55, smoothstep(0.0, 0.9, h));
          float lift = uTime * uSpin * 0.5;

          // Two dust sheets at different depths in the wall, each sampled on a
          // circle so it wraps at the seam, each sheared into its own helix.
          // The two helix pitches are kept close. Pull them apart and the
          // streaks cross into a woven lattice instead of running together.
          float w1 = uTime * rate + h * 5.0 + uSeed;
          float w2 = uTime * rate * 0.72 + h * 6.4 + uSeed * 2.7;
          vec2 c1 = vec2(cos(ang - w1), sin(ang - w1));
          vec2 c2 = vec2(cos(ang - w2), sin(ang - w2));

          // Vertical frequency well under the angular one — that ratio is what
          // stretches the dust into streaks instead of tumbling it into blobs.
          float n1 = ridged(vec3(c1 * 2.1, h * 2.4 - lift), 4);
          float n2 = ridged(vec3(c2 * 3.9, h * 4.6 - lift * 1.5), 4);
          float dust = smoothstep(0.42, 1.0, (n1 * 0.62 + n2 * 0.38) * uNoiseStrength + 0.26);

          // Fine grit, so the streaks are granular rather than airbrushed.
          float grit = fbm3(vec3(c1 * 8.5, h * 8.0 - lift * 2.1)) * 0.5 + 0.5;
          dust *= 0.62 + 0.62 * grit;

          // Grazing rays travel much further through the shell than face-on
          // ones, which is why a funnel's edges are its brightest part.
          float fres = fresnelTerm(vViewDir, vNormalW, 2.0, 1.0) * uFresnel;

          // Dust is picked up at the ground and thins as it is carried up. The
          // fan itself is held back to a haze: the particle debris cloud is
          // what should fill the contact, not this surface.
          float load = mix(1.15, 0.45, smoothstep(0.0, 0.8, h)) * mix(0.4, 1.0, smoothstep(0.0, 0.16, h));

          // The funnel reaches down out of the air rather than popping in.
          float tip = mix(1.2, -0.25, smoothstep(0.0, 0.3, uAge));
          float descend = smoothstep(tip - 0.2, tip, h);

          // Dissolve the top; leave the ground contact solid, since that is
          // where the debris cloud is. The depth fade blends it into the floor.
          float vertical = smoothstep(1.0, 0.66, h) * smoothstep(0.0, 0.04, h) * descend;
          float death = 1.0 - smoothstep(0.72, 1.0, uAge);

          // The shell is drawn double-sided, so the far wall stacks on the near
          // one and its helix leans the opposite way on screen — at equal
          // brightness the two weave into a net. Holding the far wall well back
          // keeps it as the depth cue it should be.
          float facing = gl_FrontFacing ? 1.0 : 0.4;
          float body = vertical * load * uOpacity * death * facing;
          // The veil term keeps the gaps between streaks reading as a body of
          // air rather than holes punched through the column.
          float alpha = dust * (0.42 + fres * 0.6) * body + fres * 0.07 * body;

          vec2 screenUV = gl_FragCoord.xy / uResolution;
          alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, 0.5);
          if (alpha < 0.004) discard;

          vec3 color = mix(uColorOuter, uColorInner, clamp(dust * 0.9 + fres * 0.45, 0.0, 1.0));
          color *= uGlow * uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);

          gl_FragColor = vec4(color, alpha);
        }
      `
    });

    this.index = index;
  }

  /**
   * @param shellCount  how many shells are drawn this frame — the per-shell
   *                    opacity is divided down so the stack keeps roughly the
   *                    same total brightness whatever the count.
   */
  sync(shellCount = 1) {
    const c = settings.wind;
    const g = settings.global;
    const u = this.uniforms;
    const i = this.index;

    u.uColorInner.value.copy(getColor(c.colorInner));
    u.uColorOuter.value.copy(getColor(c.colorOuter));
    u.uOpacity.value = c.opacity * g.opacity * 0.75 * (1.5 / (0.5 + shellCount));
    u.uNoiseStrength.value = c.noiseStrength * g.noiseStrength;
    u.uGlow.value = c.glow;
    u.uFresnel.value = c.fresnel * g.fresnel;
    u.uLean.value = c.tornadoLean;
    u.uFlare.value = 2.0;

    // Inner shells sit deeper in the column: narrower, spinning faster (they
    // are closer to the axis), rougher, and with less of the ground fan, which
    // belongs to the outer wall where the debris actually is.
    u.uShellScale.value = 1 - i * 0.17;
    u.uSeed.value = i * 3.77;
    u.uSpin.value = c.rotationSpeed * g.noiseSpeed * (1 + i * 0.3);
    u.uNeck.value = c.tornadoNeck * (1 - i * 0.15);
    u.uRough.value = c.tornadoRoughness * (1 + i * 0.35);
    u.uSkirt.value = 0.3 * Math.max(0, 1 - i * 0.4);
  }
}
