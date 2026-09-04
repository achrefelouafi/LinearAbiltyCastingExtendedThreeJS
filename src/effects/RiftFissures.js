import {
  BufferGeometry,
  BufferAttribute,
  Mesh,
  ShaderMaterial,
  NormalBlending,
  Color,
  DynamicDrawUsage,
  Sphere,
  Vector3,
  DoubleSide
} from 'three';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { clamp, saturate, lerp, randRange, Easing } from '../utils/math.js';

/**
 * Deep fissure scars — layer 4 of the breakdown.
 *
 * The floor splitting for metres in every direction around the impact, drawn as
 * ribbons that hug the ground: a **dark interior** with a graded depth, and a
 * **pale lip** of powdered stone thrown out along both edges.
 *
 * ## Why this is not the molten fissure system
 *
 * `effects/GroundFissures.js` already walks a crack network across the floor,
 * and the walk here is deliberately the same algorithm — an arm that veers as it
 * advances and sheds forked branches is what separates a crack from a star of
 * spokes, and that was solved once. Everything downstream of the walk is
 * different. That system is a *molten* crack: two additive passes, a white-hot
 * core, an orange underglow painting light onto the stone around it, and its
 * whole configuration comes out of `settings.meteor`. A brutalist blast emits no
 * light at all. Its cracks are visible for the opposite reason — they are the
 * only thing on the floor *darker* than the floor, and what makes them read at a
 * distance is the pale rim of dust beside the dark, not any glow inside it.
 *
 * So: one pass, normal blending, and the two colours are a near-black and a
 * bone grey. Trying to express that through the molten shader's uniforms would
 * mean an additive pass drawing darkness, which it cannot do.
 *
 * ## Unit space
 *
 * The network is baked into a disc of radius 1 and the vertex shader multiplies
 * it by `uRadius`, so the reach of the scarring is a live slider that re-scales
 * a network already on the ground rather than needing a rebuild. Width, branch
 * density and branch length are uniforms for the same reason.
 *
 * Buffers are allocated once. A spawn rewrites them; it never grows them.
 */

/** Ribbon nodes across the whole network. The generator stops when it runs out. */
const MAX_NODES = 1100;
/** Branches are generated at this count; the density slider culls them. */
const MAX_BRANCHES = 12;
const TAU = Math.PI * 2;
/** Centreline resample step, in unit space. */
const STEP = 0.04;

const SCAR_VERTEX = /* glsl */ `
  uniform float uRadius;
  uniform float uWidth;
  uniform float uBranchFrac;
  uniform float uLenFrac;

  attribute vec3  aSide;
  attribute float aAcross;
  attribute float aDist;
  attribute float aJit;
  attribute float aWalk;
  attribute float aMaxWalk;
  attribute float aRank;

  varying float vAcross;
  varying float vDist;
  varying float vTaper;
  varying float vSel;
  varying float vJit;
  varying vec3  vWorld;

  void main() {
    // A branch survives while its rank sits under the density fraction; the
    // main arms are rank 0, so they can never be culled.
    float sel = step(aRank, uBranchFrac);
    // ... and is pinched to a point wherever the length slider currently ends.
    float taper = pow(clamp(1.0 - aWalk / (aMaxWalk * uLenFrac + 1e-4), 0.0, 1.0), 0.7);

    vAcross = aAcross;
    vDist = aDist;
    vTaper = taper;
    vSel = sel;
    vJit = aJit;

    // The network is baked in a unit disc; the reach is a live slider. The lip
    // is drawn by the same ribbon as the crack, so the quad is widened well
    // past the opening itself and the fragment stage decides where the dark
    // stops and the dust starts.
    vec3 centre = vec3(position.x * uRadius, position.y, position.z * uRadius);
    vec3 pos = centre + aSide * (uWidth * 0.5 * aAcross * aJit * taper * sel);

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SCAR_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uGrown;
  uniform float uOpen;      // how far across the ribbon the crack itself reaches
  uniform float uLip;       // strength of the dust rim
  uniform float uDepth;     // how black the bottom of the crack goes
  uniform float uFade;
  uniform float uBreak;     // how hard the noise eats into both edges
  uniform float uBreakScale;
  uniform vec3  uColorCrack;
  uniform vec3  uColorLip;

  varying float vAcross;
  varying float vDist;
  varying float vTaper;
  varying float vSel;
  varying float vJit;
  varying vec3  vWorld;

  ${noiseGLSL}

  void main() {
    // The crack is only open behind the racing front.
    float openness = smoothstep(0.0, 0.06, uGrown - vDist);
    if (openness <= 0.001 || vSel < 0.5) discard;

    // At a grazing angle one pixel covers tens of centimetres of floor, and
    // every fine term resolves to a random value in its neighbour — which
    // aliases into a band of speckle lying across the far half of the scar.
    // Fade the fine detail as the pixel outgrows it: the mip chain a texture
    // would have had. See AcidPoolMaterial for the same treatment.
    float footprint = max(fwidth(vWorld.x), fwidth(vWorld.z));
    float detail = 1.0 - smoothstep(0.02, 0.13, footprint);

    float a = abs(vAcross);

    // A real crack does not have parallel sides. The opening wanders along its
    // own length, and the wander is what stops the ribbon reading as a stroke.
    float wobble = snoise(vec3(vWorld.xz * uBreakScale, 3.1)) * 0.5 + 0.5;
    float open = uOpen * mix(0.55, 1.25, wobble) * vTaper;

    // 1 inside the opening, 0 outside it.
    float inside = 1.0 - smoothstep(open * 0.72, open, a);
    // The dust thrown out along both edges, brightest right beside the opening.
    float lip = (1.0 - smoothstep(open, open + (1.0 - open) * 0.85, a)) * (1.0 - inside);

    // Darkest in the middle of the opening, where the sky reaches least.
    float bottom = 1.0 - smoothstep(0.0, open * 0.9, a);
    vec3 color = mix(uColorLip, uColorCrack, inside);
    color *= mix(1.0, 1.0 - uDepth, bottom * bottom);

    float alpha = inside + lip * uLip * (0.35 + 0.65 * detail);
    // Break both edges up so neither is a clean line.
    float bite = snoise(vec3(vWorld.xz * uBreakScale * 3.0, 7.7)) * 0.5 + 0.5;
    alpha *= 1.0 - uBreak * detail * bite * smoothstep(open * 0.5, 1.0, a);

    alpha *= openness * uFade * vJit;
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * One cast's worth of scarring. Owned by the ability, like `RiftCrater`.
 */
export class RiftFissures {
  constructor() {
    const vertices = MAX_NODES * 2;
    this.positions = new Float32Array(vertices * 3);
    this.sides = new Float32Array(vertices * 3);
    this.across = new Float32Array(vertices);
    this.dists = new Float32Array(vertices);
    this.jitters = new Float32Array(vertices);
    this.walks = new Float32Array(vertices);
    this.maxWalks = new Float32Array(vertices);
    this.ranks = new Float32Array(vertices);
    // Two triangles per node pair; the draw range is what actually limits it.
    this.indices = new Uint32Array(MAX_NODES * 6);

    for (let i = 0; i < vertices; i++) this.across[i] = i % 2 === 0 ? -1 : 1;

    this.geometry = new BufferGeometry();
    const attribute = (array, size) => new BufferAttribute(array, size).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', attribute(this.positions, 3));
    this.geometry.setAttribute('aSide', attribute(this.sides, 3));
    this.geometry.setAttribute('aAcross', attribute(this.across, 1));
    this.geometry.setAttribute('aDist', attribute(this.dists, 1));
    this.geometry.setAttribute('aJit', attribute(this.jitters, 1));
    this.geometry.setAttribute('aWalk', attribute(this.walks, 1));
    this.geometry.setAttribute('aMaxWalk', attribute(this.maxWalks, 1));
    this.geometry.setAttribute('aRank', attribute(this.ranks, 1));
    this.geometry.setIndex(new BufferAttribute(this.indices, 1));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new Sphere(new Vector3(), 1e4);

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uRadius: { value: 5 },
        uWidth: { value: 0.5 },
        uBranchFrac: { value: 0.8 },
        uLenFrac: { value: 0.85 },
        uGrown: { value: 0 },
        uOpen: { value: 0.34 },
        uLip: { value: 0.7 },
        uDepth: { value: 0.8 },
        uFade: { value: 1 },
        uBreak: { value: 0.45 },
        uBreakScale: { value: 1.6 },
        uColorCrack: { value: new Color(0.06, 0.055, 0.05) },
        uColorLip: { value: new Color(0.66, 0.63, 0.58) }
      }),
      vertexShader: SCAR_VERTEX,
      fragmentShader: SCAR_FRAGMENT
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;

    this.age = 0;
    this.life = 1;
    this.radius = 5;
    this.active = false;
    /** Where the front currently is, 0..1 — the ability puffs dust out of it. */
    this.grown = 0;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Generate a fresh crack network in unit space and upload it.
   *
   * The walk is deliberately *not* radial: an arm veers as it advances and its
   * branches veer harder, which is the whole difference between a crack and the
   * star of spokes you get from drawing lines out of a centre.
   *
   * @param {number} arms   main cracks radiating from the impact
   * @param {number} wander how hard an arm veers, radians per unit walked
   * @param {THREE.Vector3} bias direction the blast came from, flat and unit
   */
  _generate(arms, wander, bias) {
    let node = 0;
    let quad = 0;

    const pushNode = (x, z, sx, sz, dist, jitter, walk, maxWalk, rank) => {
      if (node >= MAX_NODES) return false;
      const v = node * 2;
      for (let k = 0; k < 2; k++) {
        const i = v + k;
        this.positions[i * 3 + 0] = x;
        this.positions[i * 3 + 1] = 0;
        this.positions[i * 3 + 2] = z;
        this.sides[i * 3 + 0] = sx;
        this.sides[i * 3 + 1] = 0;
        this.sides[i * 3 + 2] = sz;
        this.dists[i] = dist;
        this.jitters[i] = jitter;
        this.walks[i] = walk;
        this.maxWalks[i] = maxWalk;
        this.ranks[i] = rank;
      }
      node++;
      return true;
    };

    /**
     * Walk one crack across the floor.
     * @returns {Array} the nodes it laid down, for branches to hang off
     */
    const walk = (startX, startZ, heading, length, rank, originDist, widthScale) => {
      const laid = [];
      let x = startX;
      let z = startZ;
      let angle = heading;
      let jitter = 1;
      const curvature = randRange(-wander, wander);
      const first = node;

      for (let travelled = 0; travelled <= length; travelled += STEP) {
        // Smoothed random walk → organic width variation baked per node.
        jitter = clamp(jitter + randRange(-0.16, 0.16), 0.55, 1.4);
        const dist = saturate(originDist + travelled);
        // A crack terminates in a needle, not a rounded cap.
        const tip = Math.pow(saturate((length - travelled) / 0.3), 0.6);
        const width = jitter * widthScale * (rank > 0 ? 0.6 : tip);

        // The lateral is perpendicular to the heading, in the floor plane.
        if (
          !pushNode(
            x,
            z,
            Math.cos(angle + Math.PI / 2),
            Math.sin(angle + Math.PI / 2),
            dist,
            width,
            rank > 0 ? travelled : 0,
            rank > 0 ? length : 1,
            rank
          )
        ) {
          break;
        }
        laid.push({ x, z, angle, dist });

        x += Math.cos(angle) * STEP;
        z += Math.sin(angle) * STEP;
        // Veer, plus a little high-frequency stagger so the line is never smooth.
        angle += curvature * STEP + randRange(-0.4, 0.4) * STEP;
        // ... but pull it back toward its launch bearing, or a steady veer curls
        // an arm into a circle instead of driving it away from the impact.
        angle = lerp(angle, heading, 0.06);
      }

      // Stitch this run into the index buffer. Separate runs are never joined.
      for (let i = first; i < node - 1; i++) {
        const a = i * 2;
        this.indices[quad * 6 + 0] = a;
        this.indices[quad * 6 + 1] = a + 1;
        this.indices[quad * 6 + 2] = a + 2;
        this.indices[quad * 6 + 3] = a + 1;
        this.indices[quad * 6 + 4] = a + 3;
        this.indices[quad * 6 + 5] = a + 2;
        quad++;
      }
      return laid;
    };

    // The cast arrived along a line, and the ground remembers it: the arms are
    // spread about the incoming bearing rather than evenly about the circle, so
    // the scarring reads as having been *driven* through the floor.
    const along = Math.atan2(bias.z, bias.x);
    const spin = Math.random() * TAU;
    const mains = [];
    for (let i = 0; i < arms; i++) {
      const even = spin + (i / arms) * TAU + randRange(-0.5, 0.5);
      // Half the arms follow the shot, half fan out; blended per arm.
      const pull = i % 2 === 0 ? 0.45 : 0.12;
      const heading = lerp(even, along + (i % 4 < 2 ? 0.55 : -0.55), pull);
      const length = randRange(0.55, 1.0);
      // Start just outside the crater mouth rather than at a single point.
      const r0 = randRange(0.06, 0.18);
      mains.push(walk(Math.cos(heading) * r0, Math.sin(heading) * r0, heading, length, 0, r0, 1));
    }

    /* --- branches, hung off the arms --- */
    for (let b = 0; b < MAX_BRANCHES; b++) {
      const arm = mains[Math.floor(Math.random() * mains.length)];
      if (!arm || arm.length < 4) continue;
      const at = arm[Math.floor(randRange(1, arm.length - 1))];
      const side = Math.random() < 0.5 ? 1 : -1;
      // 32°–72° off the parent, like a lightning fork.
      const heading = at.angle + side * randRange(0.55, 1.25);
      walk(at.x, at.z, heading, randRange(0.16, 0.44), (b + 1) / MAX_BRANCHES, at.dist, 0.75);
    }

    this.geometry.setDrawRange(0, quad * 6);
    for (const name of [
      'position',
      'aSide',
      'aAcross',
      'aDist',
      'aJit',
      'aWalk',
      'aMaxWalk',
      'aRank'
    ]) {
      this.geometry.attributes[name].needsUpdate = true;
    }
    this.geometry.index.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Tear the floor open around a point.
   *
   * @param {THREE.Vector3} position where the blast landed
   * @param {THREE.Vector3} direction the cast came in on, flat and unit
   * @param {number} radius how far the scarring reaches, metres
   */
  spawn(position, direction, radius) {
    const c = settings.quake;
    this.age = 0;
    this.grown = 0;
    this.life = Math.max(0.2, c.fissureLife);
    this.radius = Math.max(0.3, radius);
    this.active = true;

    this.mesh.position.set(position.x, 0.016, position.z);
    this._generate(Math.max(2, Math.round(c.fissureArms)), c.fissureWander, direction);
    this.mesh.visible = true;
    this.sync();
  }

  /** Push the live settings in. */
  sync() {
    const c = settings.quake;
    const g = settings.global;
    const u = this.material.uniforms;
    const t = saturate(this.age / this.life);

    u.uRadius.value = this.radius;
    u.uWidth.value = c.fissureWidth;
    u.uBranchFrac.value = saturate(c.fissureBranches);
    u.uLenFrac.value = saturate(c.fissureBranchLength);
    u.uGrown.value = this.grown;
    u.uOpen.value = saturate(c.fissureOpen);
    u.uLip.value = c.fissureLip;
    u.uDepth.value = saturate(c.fissureDepth);
    u.uBreak.value = saturate(c.fissureBreak);
    u.uBreakScale.value = c.fissureBreakScale * g.noiseFrequency;
    // Scars outlive everything else in the cast — the ground stays broken long
    // after the dust has gone — so the fade is held flat and then dropped.
    u.uFade.value = 1 - Easing.inQuad(saturate((t - 0.72) / 0.28));
    u.uColorCrack.value.copy(getColor(c.colorFissure));
    u.uColorLip.value.copy(getColor(c.colorFissureLip));
  }

  /** @returns {boolean} still alive */
  update(dt) {
    if (!this.active) return false;
    const c = settings.quake;
    this.age += dt;

    // The front races out from the impact at a fixed metres-per-second.
    this.grown = saturate((this.age * c.fissureGrowth) / this.radius);
    this.sync();

    if (this.age >= this.life) {
      this.hide();
      return false;
    }
    return true;
  }

  hide() {
    this.active = false;
    this.mesh.visible = false;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
