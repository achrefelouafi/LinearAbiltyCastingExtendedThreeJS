import { ShaderMaterial, NormalBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The singularity — layers 1 and 2 of the breakdown, which are one object.
 *
 * Two materials live in this file because the black hole is the only thing in
 * the sandbox whose *look* and whose *distortion* are the same physical fact
 * seen twice: the shadow is the light that never came back, the ring around it
 * is the light that went most of the way round and did, and the warp outside it
 * is the light that was merely bent on its way past. Authoring those apart
 * guarantees they drift.
 *
 * ## Why both are camera-facing quads rather than spheres
 *
 * A Schwarzschild shadow is *circular from every direction*. It is not the
 * silhouette of a sphere — it is the set of impact parameters below which a
 * photon cannot escape, and that set is rotationally symmetric about the line
 * of sight whatever the observer does. So a billboard is not a cheap stand-in
 * here, it is the correct primitive: exactly round at every camera angle,
 * antialiased against one analytic radius instead of a tessellated limb, and
 * incapable of showing a polygonal edge at the one place in the frame the eye
 * is guaranteed to be looking.
 *
 * ## The horizon
 *
 *  - **the shadow** — pure black, alpha 1, its edge feathered by one pixel of
 *    fwidth. Premultiplied, so it *removes* the frame rather than tinting it: a
 *    near-black transparent disc is a grey disc, and grey is the one thing a
 *    black hole may never be.
 *  - **the photon ring** — a hard, thin band sitting right on the shadow's
 *    edge, where light that orbited the hole piles up. It is the brightest
 *    thing in the ability and only a few pixels wide, which is most of the
 *    reason the shot reads as photographed rather than painted.
 *  - **the beamed side** — the ring is not evenly lit. Gas coming toward the
 *    camera is boosted, gas going away is dimmed, so one arc is several times
 *    brighter than the other and the hole declares which way it is turning.
 *  - **the halo** — the lensed accretion light, drawn as filaments *wound*
 *    around the hole at a differential rate (uWind / r), so the inner strands
 *    visibly overtake the outer ones. A halo that turns rigidly is a texture on
 *    a disc; one that shears is an orbit.
 *
 * ## The lens
 *
 * The second material writes no colour at all. It sits on LAYER.DISTORTION and
 * fills the refraction buffer that postprocessing/DistortionShader.js warps the
 * finished frame by, so what it bends is *everything* — the stage, the
 * character, the nebula, the other four layers of this same ability. That is
 * the difference between a black hole with an effect painted around it and one
 * the room is visibly wrapped around.
 *
 * Deflection goes as 1/r², is held flat inside the photon ring (there is no
 * frame in there to bend) and is faded out at the quad's edge, because a
 * distortion proxy that ends abruptly prints its own outline into the shot. The
 * offset points *inward*: light bends toward mass, so the image of a source
 * appears farther out than the source is, and to draw that you sample nearer
 * the middle.
 *
 * Its one non-obvious unit: the deflection is a fraction of the hole's own
 * **apparent** radius, measured per frame in the vertex stage, not a fixed slice
 * of the screen. A constant in screen widths is two different effects at two
 * camera distances — imperceptible from across the arena, and strong enough up
 * close that the radial remap folds the image back over itself and prints a set
 * of concentric mirrored rings around the hole. That failure looks like a
 * deliberate target painted over the shot, which is why it took a capture cycle
 * to recognise as a bug at all.
 */

/* -------------------------------------------------------------------- */
/* the shared billboard                                                 */
/* -------------------------------------------------------------------- */

const BILLBOARD_VERTEX = /* glsl */ `
  uniform float uSize;      // half-width of the quad, metres
  uniform float uNudge;     // metres toward the camera — see below
  uniform float uHorizon;   // radius of the shadow, metres

  varying vec2  vLocal;     // -1..1 across the quad
  varying float vScreenR;   // that radius as a fraction of the screen's width

  void main() {
    // PlaneGeometry(1, 1) spans -0.5..0.5, so this is the unit square doubled.
    vLocal = position.xy * 2.0;

    // How big the hole actually is on screen, right now. The lens needs this
    // because its deflection has to be a fraction of the hole's *apparent*
    // size rather than a fixed slice of the frame: expressed in screen widths
    // it is invisible from across the arena and folds the image into concentric
    // mirrored rings when the camera walks up to it, which is not a subtle
    // failure — it looks like a target painted over the shot.
    vec4 centre = projectionMatrix * (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0));
    vec4 offset = projectionMatrix * (modelViewMatrix * vec4(uHorizon, 0.0, 0.0, 1.0));
    // NDC x spans two units across the frame, so the halving puts this in
    // fractions of the screen's width — the same units the post pass adds in.
    vScreenR = abs(offset.x / max(abs(offset.w), 1e-4) - centre.x / max(abs(centre.w), 1e-4)) * 0.5;

    // Camera facing: the quad's own basis is thrown away and its corners are
    // laid out in view space around the object's origin. Its local x and y are
    // therefore screen x and y, which is what lets the fragment stage read
    // vLocal as a screen direction.
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * (uSize * 2.0);
    // Pulled forward to the *near surface* of the sphere it stands for, rather
    // than left at its centre. View space looks down -Z, so this is +Z. It is
    // the more correct depth — the shadow is a silhouette, and a silhouette is
    // at the limb, not at the middle — and it is what makes a body being drawn
    // into the hole actually go *behind* it instead of z-fighting through the
    // one surface in the frame that has to stay solid black.
    mv.z += uNudge;
    gl_Position = projectionMatrix * mv;
  }
`;

/* -------------------------------------------------------------------- */
/* the horizon                                                          */
/* -------------------------------------------------------------------- */

const HORIZON_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSize;          // half-width of the quad, metres
  uniform float uHorizon;       // radius of the shadow, metres
  uniform float uRingWidth;     // thickness of the photon ring, in horizon radii
  uniform float uRingGlow;
  uniform float uBeam;          // how hard one side of the ring is beamed
  uniform float uBeamPhase;     // which side, radians
  uniform float uHalo;          // brightness of the lensed accretion light
  uniform float uHaloFalloff;
  uniform float uWind;          // differential winding of the halo filaments
  uniform float uSpin;          // revolutions/second the whole thing turns
  uniform float uFilament;      // how far the halo is torn into strands
  uniform float uFilamentScale;
  uniform float uChurn;         // the flare envelope, 0..1
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorPhoton;
  uniform vec3  uColorHalo;
  uniform vec3  uColorCool;
  uniform float uGlobalGlow;

  varying vec2 vLocal;

  ${noiseGLSL}

  #define TAU 6.28318530718

  void main() {
    float len = length(vLocal);
    if (len > 1.0) discard;

    // Everything below is measured in horizon radii, so every threshold in here
    // is a shape rather than a distance and the whole disc rescales for free.
    float scale = uSize / max(uHorizon, 1e-3);
    float r = len * scale;
    float ang = atan(vLocal.y, vLocal.x);

    // One pixel, in those same units. Every band in here is floored at it, or
    // the ring aliases into a dashed circle the moment the camera pulls back.
    float px = max(fwidth(r), 1e-4);

    /* ---- the shadow ---------------------------------------------------- */
    float shadow = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);

    /* ---- which side is coming toward us -------------------------------- */
    // Relativistic beaming, near enough: the approaching limb is brighter, the
    // receding one dimmer. The cheapest detail there is that says this is
    // turning rather than sitting there.
    float toward = cos(ang - uBeamPhase);
    float beam = 1.0 + uBeam * toward;

    /* ---- the photon ring ----------------------------------------------- */
    // Sat right on the shadow's edge and floored at a pixel. Energy is kept as
    // the band widens (the uRingWidth / width term), so pulling the camera back
    // dims the ring rather than turning it into a fat bright donut.
    float width = max(uRingWidth, px * 1.1);
    float d = (r - 1.0 - width * 0.65) / width;
    float ring = exp(-d * d * 2.2) * (uRingWidth / width);
    // A second, much fainter ring outside it: light that went round twice. It
    // is nearly subliminal, and it is what stops the first ring reading as a
    // drawn outline.
    float d2 = (r - 1.0 - width * 3.4) / (width * 1.6);
    ring += exp(-d2 * d2 * 2.0) * 0.16 * (uRingWidth / width);

    /* ---- the lensed halo ------------------------------------------------ */
    // Wound at a differential rate: the strands nearest the hole overtake the
    // ones outside them, which is what an orbit does and what a spinning
    // texture does not.
    float turn = uTime * uSpin * TAU + uWind / (0.25 + r * 0.85);
    vec2 wound = rot2(turn) * vLocal;
    float strands = ridged(vec3(wound * uFilamentScale, uTime * 0.25 + uSeed), 4);
    strands = mix(1.0, smoothstep(0.25, 0.95, strands), uFilament);

    // Falls off outward from the ring, and is cut dead inside the shadow —
    // there is nothing in there to be lit.
    float halo = exp(-(r - 1.0) * uHaloFalloff) * smoothstep(1.0 - px, 1.0 + px * 2.0, r);
    halo *= strands;

    /* ---- put it together ------------------------------------------------ */
    float flare = 1.0 + uChurn * 0.55;
    vec3 color = uColorPhoton * ring * uRingGlow * beam * flare;
    // The halo cools with distance: hot gold at the ring, violet out at the
    // reach — the palette of the reference sheet, read radially.
    vec3 haloTint = mix(uColorHalo, uColorCool, smoothstep(1.0, scale * 0.75, r));
    color += haloTint * halo * uHalo * beam * flare;
    color *= uGlobalGlow * uFade;

    // The disc is opaque; outside it the glow carries its own coverage, so it
    // adds to the frame instead of veiling it.
    float glow = ring * uRingGlow + halo * uHalo;
    float alpha = clamp(shadow + glow * 0.3 * uFade, 0.0, 1.0) * uOpacity;
    if (alpha < 0.002) discard;

    // Premultiplied: inside the shadow the colour is zero and the alpha is one,
    // so the frame behind it is replaced by *nothing*. Straight alpha would
    // leave a dark grey disc, and a grey black hole is not a black hole.
    gl_FragColor = vec4(color * (1.0 - shadow), alpha);
  }
`;

/**
 * The event horizon, its photon ring and the lensed light around it.
 *
 * Every dimension is resolved from `settings.astral` each frame, so dragging
 * `coreRadius` re-scales a hole that is already standing.
 */
export function createHorizonMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    premultipliedAlpha: true,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSize: { value: 3 },
      uNudge: { value: 0 },
      uHorizon: { value: 1 },
      uRingWidth: { value: 0.05 },
      uRingGlow: { value: 6 },
      uBeam: { value: 0.6 },
      uBeamPhase: { value: 0 },
      uHalo: { value: 1.4 },
      uHaloFalloff: { value: 1.9 },
      uWind: { value: 2.6 },
      uSpin: { value: 0.35 },
      uFilament: { value: 0.72 },
      uFilamentScale: { value: 2.6 },
      uChurn: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorPhoton: { value: new Color(1, 0.9, 0.66) },
      uColorHalo: { value: new Color(0.85, 0.6, 1) },
      uColorCool: { value: new Color(0.3, 0.18, 0.6) }
    }),
    vertexShader: BILLBOARD_VERTEX,
    fragmentShader: HORIZON_FRAGMENT
  });

  /**
   * @param {object} state { size, horizon, beamPhase, churn, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.astral;
    const g = settings.global;
    const u = material.uniforms;

    u.uSize.value = state.size;
    // The silhouette of a sphere of this radius sits one radius nearer the
    // camera than its centre does.
    u.uNudge.value = state.horizon;
    u.uHorizon.value = state.horizon;
    u.uBeamPhase.value = state.beamPhase;
    u.uChurn.value = state.churn;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uRingWidth.value = c.ringWidth;
    u.uRingGlow.value = c.ringGlow * g.glow;
    u.uBeam.value = c.ringBeam;
    u.uHalo.value = c.haloGlow * g.shaderIntensity;
    u.uHaloFalloff.value = c.haloFalloff;
    u.uWind.value = c.haloWind * g.turbulence;
    u.uSpin.value = c.haloSpin * g.noiseSpeed;
    u.uFilament.value = c.haloFilament;
    u.uFilamentScale.value = c.haloFilamentScale * g.noiseFrequency;
    u.uOpacity.value = g.opacity;

    u.uColorPhoton.value.copy(getColor(c.colorPhoton));
    u.uColorHalo.value.copy(getColor(c.colorHalo));
    u.uColorCool.value.copy(getColor(c.colorHaloCool));
  };

  return material;
}

/* -------------------------------------------------------------------- */
/* the lens                                                             */
/* -------------------------------------------------------------------- */

const LENS_FRAGMENT = /* glsl */ `
  uniform float uSize;      // half-width of the quad, metres
  uniform float uHorizon;   // radius of the shadow, metres
  uniform float uBend;      // deflection at the photon ring, x the hole's own radius
  uniform float uDrag;      // how much of it is tangential — frame dragging
  uniform float uPhase;     // which way that drag is going, radians
  uniform float uStrength;
  uniform vec2  uResolution;

  varying vec2  vLocal;
  varying float vScreenR;

  void main() {
    float len = length(vLocal);
    if (len > 1.0) discard;

    float scale = uSize / max(uHorizon, 1e-3);
    float r = len * scale;

    // Newtonian light deflection, near enough for one frame: the bend goes as
    // 1/r^2 in these units, and is held at its ring value inside, because a ray
    // that gets that close does not come back and there is nothing to warp.
    // Measured against the hole's own apparent radius, so the warp is the same
    // *shape* from ten metres and from thirty — see the vertex stage.
    float bend = uBend * vScreenR / max(r * r, 1.0);
    // Off inside the shadow — the disc there is opaque black, and warping it
    // would only chew its edge.
    bend *= smoothstep(0.92, 1.25, r);
    // ... and off at the quad's border, or the proxy prints its own outline.
    float mask = 1.0 - smoothstep(0.55, 1.0, len);
    if (mask < 0.004) discard;

    vec2 dir = vLocal / max(len, 1e-4);
    // Frame dragging: space near a turning hole is wound round with it, so the
    // warp is not purely radial. Small, and the reason the distortion reads as
    // belonging to something that rotates.
    vec2 tang = vec2(-dir.y, dir.x) * uDrag * cos(uPhase);
    vec2 offset = normalize(-dir + tang);

    // The post pass adds this to a *UV*, and UV space is not square. Scaling x
    // by the inverse aspect is what makes the deflection an equal number of
    // pixels on both axes — without it the lens is an ellipse on a wide window.
    float aspect = max(uResolution.x, 1.0) / max(uResolution.y, 1.0);
    offset.x /= aspect;

    gl_FragColor = vec4(offset * 0.5 + 0.5, bend * uStrength, mask);
  }
`;

/**
 * The gravitational lens: an invisible proxy that bends the finished frame.
 *
 * `uBend` is in units of the post stack's own `distortion` scale, so what
 * reaches the screen is `bend x settings.post.distortion` screen widths — which
 * is why it can be a two-digit number without anything tearing.
 */
export function createLensMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSize: { value: 6 },
      uNudge: { value: 0 },
      uHorizon: { value: 1 },
      uBend: { value: 5 },
      uDrag: { value: 0.35 },
      uPhase: { value: 0 },
      uStrength: { value: 1 }
    }),
    vertexShader: BILLBOARD_VERTEX,
    fragmentShader: LENS_FRAGMENT
  });

  /**
   * @param {object} state { size, horizon, phase, strength }
   */
  material.userData.sync = (state) => {
    const c = settings.astral;
    const g = settings.global;
    const u = material.uniforms;

    u.uSize.value = state.size;
    // The lens is depth-tested out of the pipeline entirely, so it stays on the
    // centre; nudging it would only shift where the deflection is measured from.
    u.uNudge.value = 0;
    u.uHorizon.value = state.horizon;
    u.uPhase.value = state.phase;
    // `lensBend` is authored as a fraction of the hole's own apparent radius,
    // which is the only unit that means the same thing at every camera
    // distance. The post pass will multiply the buffer by `post.distortion`
    // before it touches the frame, so that factor is divided back out here —
    // otherwise the master distortion slider would silently rescale the lens
    // along with the heat haze, and the two are not the same kind of thing.
    u.uBend.value = (c.lensBend / Math.max(settings.post.distortion, 1e-4)) * g.distortion;
    u.uDrag.value = c.lensDrag;
    u.uStrength.value = state.strength;
  };

  return material;
}
