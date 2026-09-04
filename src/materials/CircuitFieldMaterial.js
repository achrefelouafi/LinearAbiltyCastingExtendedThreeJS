import { AdditiveBlending, Color, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The rune board the serpent lays down under itself — layer 5 of the breakdown.
 *
 * One quad, lying on the floor along the cast line, with a **routed circuit** in
 * its fragment shader. Not a stamped decal and not a texture: the board is a
 * real wiring graph, generated per fragment.
 *
 * ## Why it is a graph and not a pattern
 *
 * The obvious way to draw circuitry is a Truchet tiling — pick one of four
 * pre-baked cell images per cell — and it always reads as a *tiling*, because
 * traces stop dead at cell borders where the two neighbours disagree. Here a
 * cell asks about the four **edges** it shares, and each edge's answer is hashed
 * from the edge's own coordinate, so both cells that own it get the same answer:
 *
 *   - `wired()` — is there a trace crossing this edge at all;
 *   - `gate()`  — and *where* along it, jittered but agreed on by both sides.
 *
 * Every cell then routes from its own (jittered) node out to whichever gates are
 * open. The two halves meet exactly, so traces run for metres, fork, dead-end
 * into vias and bus around pads — a connected board, from four hashes a cell.
 *
 * ## What lights it
 *
 * The board is dark until the serpent passes: `uFront` is how far down the line
 * the nose has got, and everything is scored by how long ago the front went
 * over it — a bright ignition at the front, a decay behind it, and a faint
 * pre-charge just ahead so the circuit exists before it fires. Data blips run
 * the traces, an elongated pool of light tracks the body, and the impact sends
 * a ring out that re-lights every trace it crosses.
 *
 * ## Grazing angles
 *
 * Fine bright detail on a ground plane aliases into a band of white speckle when
 * the camera drops toward eye level (one pixel then covers tens of centimetres
 * of floor). Every thin feature here is floored at the world-space pixel
 * footprint and its brightness scaled by how much it had to be widened, so the
 * energy is conserved rather than either lost or randomly resolved.
 */

const CIRCUIT_VERTEX = /* glsl */ `
  uniform float uSpan;    // metres the board covers along the cast
  uniform float uWidth;   // metres across

  varying vec2 vCast;     // (metres from the caster, metres off the axis)
  varying vec3 vWorld;

  void main() {
    vCast = vec2(uv.x * uSpan, (uv.y - 0.5) * uWidth);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const CIRCUIT_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uFront;      // metres the nose has travelled
  uniform float uImpact;     // metres to the impact point
  uniform float uSpan;
  uniform float uWidth;
  uniform float uFade;

  uniform float uCell;
  uniform float uDensity;
  uniform float uJitter;
  uniform float uTrace;
  uniform float uPad;
  uniform float uVia;

  uniform float uLead;       // metres of pre-charge ahead of the nose
  uniform float uDecay;      // 1/metres the glow dies behind it
  uniform float uBase;       // how visible an unlit trace is
  uniform float uGlow;

  uniform float uBlip;
  uniform float uBlipFreq;
  uniform float uBlipSpeed;

  uniform float uUnder;      // the pool of light under the body
  uniform float uUnderLong;
  uniform float uUnderWide;

  uniform float uBlast;      // metres — the impact ring's radius
  uniform float uBlastWidth;
  uniform float uBlastGain;

  uniform float uIntensity;
  uniform float uOpacity;
  uniform vec3  uColorTrace;
  uniform vec3  uColorLive;
  uniform vec3  uColorHot;
  uniform vec3  uColorUnder;

  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec2 vCast;
  varying vec3 vWorld;

  ${noiseGLSL}
  ${commonGLSL}

  float segmentDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
  }

  /* Is there a trace across the edge this cell shares with its d neighbour? */
  float wired(vec2 id, vec2 d, float density) {
    vec2 key = id + max(d, vec2(0.0));
    float tag = abs(d.x) > 0.5 ? 0.0 : 1.0;
    return step(1.0 - density, hash13(vec3(key, tag + uSeed)));
  }

  /** And where it crosses, in the cell's own -0.5..0.5 frame. */
  vec2 gate(vec2 id, vec2 d, float jitter) {
    vec2 key = id + max(d, vec2(0.0));
    float tag = abs(d.x) > 0.5 ? 0.0 : 1.0;
    float slide = (hash13(vec3(key + 17.3, tag + uSeed + 3.0)) - 0.5) * jitter;
    return d * 0.5 + vec2(-d.y, d.x) * slide;
  }

  void route(vec2 id, vec2 f, vec2 node, vec2 d, inout float dist, inout float links) {
    if (wired(id, d, uDensity) < 0.5) return;
    dist = min(dist, segmentDist(f, node, gate(id, d, uJitter)));
    links += 1.0;
  }

  void main() {
    vec2 p = vCast;

    /* ---- how long ago the nose went over this point ---- */
    float behind = uFront - p.x;
    // Ignition at the front, a pre-charge reaching a little way ahead of it, and
    // an exponential cool-down behind.
    float charge = smoothstep(-max(uLead, 0.01), 0.0, behind);
    float live = charge * exp(-max(behind, 0.0) * uDecay);

    /* ---- the board ---- */
    vec2 g = p / max(uCell, 0.05);
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 node = (hash21(dot(id, vec2(31.7, 57.1)) + uSeed) - 0.5) * uJitter;

    float dist = 1e9;
    float links = 0.0;
    route(id, f, node, vec2( 1.0, 0.0), dist, links);
    route(id, f, node, vec2(-1.0, 0.0), dist, links);
    route(id, f, node, vec2( 0.0, 1.0), dist, links);
    route(id, f, node, vec2( 0.0,-1.0), dist, links);

    // Distances are in cell units; the pixel footprint is in metres.
    float cell = max(uCell, 0.05);
    float footprint = max(fwidth(p.x), fwidth(p.y)) / cell;
    float detail = 1.0 - smoothstep(0.05, 0.4, footprint * cell);

    float traceW = max(uTrace / cell, footprint * 0.85);
    float trace = 1.0 - smoothstep(traceW - footprint, traceW + footprint, dist);
    // Widening to survive the footprint would otherwise *brighten* the far half
    // of the board; scale it back by however much we had to widen it.
    trace *= min(1.0, (uTrace / cell) / max(traceW, 1e-5));
    if (links < 0.5) trace = 0.0;

    /* ---- pads on the junctions, vias on the dead ends ---- */
    float nodeDist = length(f - node);
    float padR = uPad / cell;
    float pad = (1.0 - smoothstep(traceW - footprint, traceW + footprint, abs(nodeDist - padR)))
              * step(2.5, links) * detail;
    float via = (1.0 - smoothstep(uVia / cell, uVia / cell + footprint * 1.5, nodeDist))
              * step(links, 1.5) * step(0.5, links) * detail;

    /* ---- the pool of light the body drags over the floor ---- */
    vec2 q = vec2((p.x - uFront + uUnderLong * 0.45) / max(uUnderLong, 0.05),
                  p.y / max(uUnderWide, 0.05));
    float under = exp(-dot(q, q) * 2.2) * uUnder;

    float board = trace + pad * 0.9 + via * 1.2;
    // Nothing here and nothing under it: most of a 26 m board is empty floor.
    if (board < 0.002 && under < 0.002) discard;

    /* ---- blips running the traces toward the nose ---- */
    float blipPhase = fract(p.x * uBlipFreq - uTime * uBlipSpeed + hash13(vec3(id, 5.0)) * 3.0);
    float blip = pow(1.0 - abs(blipPhase * 2.0 - 1.0), 22.0) * uBlip * trace * live * detail;

    /* ---- the shock ring the impact sends back through the board ---- */
    float ringDist = abs(distance(p, vec2(uImpact, 0.0)) - uBlast);
    float ringW = max(uBlastWidth, footprint * cell * 1.5);
    float ring = (1.0 - smoothstep(0.0, ringW, ringDist)) * uBlastGain;

    /* ---- put it together ---- */
    float energy = board * (uBase + live * uGlow + ring) + blip;
    vec3 color = mix(uColorTrace, uColorLive, clamp(live + ring, 0.0, 1.0));
    color = mix(color, uColorHot, clamp(blip + ring * 0.6 + charge * (1.0 - smoothstep(0.0, 0.6, behind)), 0.0, 1.0));
    color *= energy;
    color += uColorUnder * under;

    float alpha = clamp(energy + under, 0.0, 1.0);
    // Feathered at the sides, so the board has no border.
    alpha *= 1.0 - smoothstep(0.55, 1.0, abs(p.y) / max(uWidth * 0.5, 0.01));
    alpha *= smoothstep(0.0, 0.6, p.x) * (1.0 - smoothstep(uSpan - 0.8, uSpan, p.x));
    alpha *= uFade * uOpacity;
    if (alpha < 0.004) discard;

    color *= uIntensity * uShaderIntensity * uGlobalGlow;
    color /= 1.0 + color * 0.1;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`, where state is
 *   `{ span, width, front, impact, blast, fade, seed }` — all metres but the
 *   last two.
 */
export function createCircuitFieldMaterial() {
  const material = new ShaderMaterial({
    name: 'CircuitField',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: { value: 0 },
      uFront: { value: 0 },
      uImpact: { value: 10 },
      uSpan: { value: 20 },
      uWidth: { value: 6 },
      uFade: { value: 1 },

      uCell: { value: 0.85 },
      uDensity: { value: 0.55 },
      uJitter: { value: 0.42 },
      uTrace: { value: 0.028 },
      uPad: { value: 0.13 },
      uVia: { value: 0.05 },

      uLead: { value: 1.6 },
      uDecay: { value: 0.14 },
      uBase: { value: 0.05 },
      uGlow: { value: 1.5 },

      uBlip: { value: 2.5 },
      uBlipFreq: { value: 0.5 },
      uBlipSpeed: { value: 3.5 },

      uUnder: { value: 0.5 },
      uUnderLong: { value: 3.5 },
      uUnderWide: { value: 1.1 },

      uBlast: { value: 0 },
      uBlastWidth: { value: 0.35 },
      uBlastGain: { value: 0 },

      uIntensity: { value: 2.2 },
      uOpacity: { value: 1 },
      uColorTrace: { value: new Color(0.06, 0.3, 0.5) },
      uColorLive: { value: new Color(0.3, 0.9, 1) },
      uColorHot: { value: new Color(0.9, 1, 1) },
      uColorUnder: { value: new Color(0.15, 0.55, 1) }
    }),
    vertexShader: CIRCUIT_VERTEX,
    fragmentShader: CIRCUIT_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.cyber;
    const g = settings.global;
    const u = material.uniforms;

    u.uSeed.value = state.seed;
    u.uFront.value = state.front;
    u.uImpact.value = state.impact;
    u.uSpan.value = state.span;
    u.uWidth.value = state.width;
    u.uFade.value = state.fade;
    u.uBlast.value = state.blast;
    u.uBlastGain.value = state.blastGain * c.runeBlastGain;

    u.uCell.value = c.runeCell;
    u.uDensity.value = c.runeDensity;
    u.uJitter.value = c.runeJitter;
    u.uTrace.value = c.runeTrace;
    u.uPad.value = c.runePad;
    u.uVia.value = c.runeVia;

    u.uLead.value = c.runeLead;
    u.uDecay.value = c.runeDecay;
    u.uBase.value = c.runeBase;
    u.uGlow.value = c.runeGlow;

    u.uBlip.value = c.runeBlip;
    u.uBlipFreq.value = c.runeBlipFreq;
    u.uBlipSpeed.value = c.runeBlipSpeed * g.noiseSpeed;

    u.uUnder.value = c.runeUnder;
    u.uUnderLong.value = c.runeUnderLong;
    u.uUnderWide.value = c.runeUnderWide;
    u.uBlastWidth.value = c.runeBlastWidth;

    u.uIntensity.value = c.runeIntensity;
    u.uOpacity.value = c.runeOpacity * g.opacity;

    u.uColorTrace.value.copy(getColor(c.colorRune));
    u.uColorLive.value.copy(getColor(c.colorRuneLive));
    u.uColorHot.value.copy(getColor(c.colorRuneHot));
    u.uColorUnder.value.copy(getColor(c.colorRuneUnder));
  };

  return material;
}
