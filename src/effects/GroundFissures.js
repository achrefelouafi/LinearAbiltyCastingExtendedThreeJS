import {
  BufferGeometry,
  BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  InstancedMesh,
  Object3D,
  Group,
  ShaderMaterial,
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  Sphere,
  Vector3,
  DoubleSide
} from 'three';
import { createAsteroidGeometry } from '../assets/ProceduralGeometry.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { clamp, saturate, lerp, randRange, Easing } from '../utils/math.js';

/**
 * Molten fissures — the ground tearing open under an impact.
 *
 * A network of cracks races outward from the point of impact: several main arms
 * that meander rather than run straight, each shedding lightning-style side
 * branches, drawn as ribbons that hug the floor. Every ribbon is rendered twice —
 * a narrow white-hot **core** and a wide additive **underglow** that paints
 * radiant orange onto the stone around it — and lumps of basalt are heaved up
 * along the lips so the crack has physical relief instead of being a glowing
 * decal.
 *
 * Ported from the molten-fissures paint mode in the geometry-painter sandbox and
 * re-aimed at a crater: there the crack followed a stroke over a mesh surface,
 * here it radiates across the floor plane, which makes the frame maths trivial
 * (the normal is always +Y) and lets the whole network live in **unit space**.
 *
 * That last part is the important one. The paths are baked into a disc of radius
 * 1 and the vertex shader multiplies them by `uRadius`, so the reach of the
 * crater is a live slider that re-scales a network already on the ground rather
 * than needing a rebuild. Width, branch density, branch length, heat and pulse
 * are uniforms for the same reason.
 *
 * Buffers are allocated once. A spawn rewrites them; it never grows them.
 */

/** Ribbon nodes across the whole network. The generator stops when it runs out. */
const MAX_NODES = 900;
/** Basalt chunks heaved up along the lips. */
const MAX_LIPS = 44;
/** Branches are generated at this count; the density slider culls them. */
const MAX_BRANCHES = 8;
const TAU = Math.PI * 2;
/** Centreline resample step, in unit space. */
const STEP = 0.045;

const _dummy = new Object3D();

const FISSURE_VERTEX = /* glsl */ `
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

  void main() {
    // A branch survives while its rank sits under the density fraction; the main
    // arms are rank 0, so they can never be culled.
    float sel = step(aRank, uBranchFrac);
    // ... and is pinched to a point wherever the length slider currently ends.
    float taper = pow(clamp(1.0 - aWalk / (aMaxWalk * uLenFrac + 1e-4), 0.0, 1.0), 0.7);

    vAcross = aAcross;
    vDist = aDist;
    vTaper = taper;
    vSel = sel;

    // The network is baked in a unit disc; the reach is a live slider.
    vec3 centre = vec3(position.x * uRadius, position.y, position.z * uRadius);
    vec3 pos = centre + aSide * (uWidth * 0.5 * aAcross * aJit * taper * sel);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FISSURE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uGrown;
  uniform float uHeat;
  uniform float uPulse;
  uniform float uFade;
  uniform float uGlobalGlow;
  uniform vec3  uColorSeam;
  uniform vec3  uColorRed;
  uniform vec3  uColorOrange;
  uniform vec3  uColorWhite;

  varying float vAcross;
  varying float vDist;
  varying float vTaper;
  varying float vSel;

  void main() {
    // The crack is only open behind the racing front.
    float openness = smoothstep(0.0, 0.08, uGrown - vDist);
    if (openness <= 0.001 || vSel < 0.5) discard;

    #if FISSURE_PASS == 0                       /* CORE */
      float centre = 1.0 - smoothstep(0.12, 1.0, abs(vAcross));
      float pulse = sin(vDist * 22.0 - uTime * uPulse * 2.6) * 0.28 + 0.72;
      float flicker = sin(uTime * 9.0 + vDist * 120.0) * 0.08 + 0.94;
      // A white flash rides the propagating crack front.
      float flash = (1.0 - smoothstep(0.0, 0.14, abs(uGrown - vDist))) * 1.6;

      float heat = centre * pulse * flicker * uHeat * (vTaper * 0.35 + 0.65) + flash;

      vec3 color = mix(uColorSeam, uColorRed, smoothstep(0.0, 0.55, heat));
      color = mix(color, uColorOrange, smoothstep(0.55, 1.15, heat));
      color = mix(color, uColorWhite, smoothstep(1.15, 2.1, heat));

      float edge = 1.0 - smoothstep(0.82, 1.0, abs(vAcross));
      float alpha = openness * edge * uFade;

    #else                                       /* UNDERGLOW */
      float falloff = pow(max(1.0 - abs(vAcross), 0.0), 1.6);
      float pulse = sin(vDist * 22.0 - uTime * uPulse * 2.6) * 0.22 + 0.78;
      float strength = falloff * pulse * uHeat * (vTaper * 0.5 + 0.5) * 0.34;
      vec3 color = uColorOrange * strength;
      float alpha = openness * uFade * clamp(strength * 2.2, 0.0, 1.0);
    #endif

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/** Which of the two passes over the same ribbon geometry a material draws. */
const FissurePass = Object.freeze({ CORE: 0, GLOW: 1 });

/* ---------------------------------------------------------------------- */
/* One crater's worth of cracks                                            */
/* ---------------------------------------------------------------------- */

class Fissure {
  constructor() {
    this.group = new Group();
    this.group.name = 'Fissure';

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
    this.indices = new Uint16Array(MAX_NODES * 6);

    for (let i = 0; i < vertices; i++) this.across[i] = i % 2 === 0 ? -1 : 1;

    this.geometry = new BufferGeometry();
    const attribute = (array, size) =>
      new BufferAttribute(array, size).setUsage(DynamicDrawUsage);
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

    this.materials = [];
    this.meshes = [];
    // Underglow first so the core adds on top of it.
    for (const pass of [FissurePass.GLOW, FissurePass.CORE]) {
      const material = new ShaderMaterial({
        defines: { FISSURE_PASS: pass },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        side: DoubleSide,
        toneMapped: false,
        uniforms: sharedUniforms({
          uRadius: { value: 3 },
          uWidth: { value: 0.12 },
          uBranchFrac: { value: 0.7 },
          uLenFrac: { value: 0.8 },
          uGrown: { value: 0 },
          uHeat: { value: 1.4 },
          uPulse: { value: 1 },
          uFade: { value: 1 },
          uColorSeam: { value: new Color(0.02, 0.004, 0.002) },
          uColorRed: { value: new Color(1.1, 0.1, 0.01) },
          uColorOrange: { value: new Color(2.6, 0.85, 0.1) },
          uColorWhite: { value: new Color(4.6, 3.6, 2.4) }
        }),
        vertexShader: FISSURE_VERTEX,
        fragmentShader: FISSURE_FRAGMENT
      });

      const mesh = new Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = pass === FissurePass.GLOW ? 7 : 9;
      this.group.add(mesh);
      this.materials.push(material);
      this.meshes.push(mesh);
    }

    /**
     * Basalt heaved up along the lips.
     *
     * Records hold dice only — a unit-space anchor, which lip it sits on, and a
     * few jitters. Their metres come from the settings every frame, so the
     * crater's reach and the chunk size stay live sliders.
     */
    // Few cuts: at this subdivision a heavily sliced rock flattens into a pebble,
    // and these want to read as blocks of crust shouldered out of the ground.
    this.lipGeometry = createAsteroidGeometry({
      seed: 4.2,
      detail: 1,
      lumpiness: 0.34,
      cuts: 3,
      cutDepth: 0.16,
      craters: 2
    });
    this.lipMaterial = new MeshStandardMaterial({
      color: 0x565056,
      roughness: 0.95,
      metalness: 0.02,
      flatShading: true
    });
    this.lips = new InstancedMesh(this.lipGeometry, this.lipMaterial, MAX_LIPS);
    this.lips.castShadow = true;
    this.lips.receiveShadow = true;
    this.lips.frustumCulled = false;
    this.lips.count = 0;
    this.lips.layers.set(LAYER.WORLD);
    this.group.add(this.lips);

    this.lipRecords = [];
    for (let i = 0; i < MAX_LIPS; i++) {
      this.lipRecords.push({
        x: 0, // unit-space anchor
        z: 0,
        sideX: 0, // unit lateral, signed: which lip
        sideZ: 0,
        yaw: 0,
        dist: 0, // where along the crack it sits, 0..1
        size: 0, // 0..1 jitter
        flat: 0, // 0..1 squash
        offset: 0, // 0..1 how far outside the crack edge
        rank: 0 // culled with its branch
      });
    }

    this.age = 0;
    this.life = 1;
    this.radius = 3;
    this.nodeCount = 0;
    this.lipCount = 0;
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
   */
  _generate(arms, wander) {
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
        jitter = clamp(jitter + randRange(-0.18, 0.18), 0.6, 1.45);
        const dist = saturate(originDist + travelled);
        // A crack terminates in a needle, not a rounded cap.
        const tip = Math.pow(saturate((length - travelled) / 0.22), 0.65);
        const width = jitter * widthScale * (rank > 0 ? 0.62 : tip);

        // The lateral is perpendicular to the heading, in the floor plane.
        if (!pushNode(x, z, Math.cos(angle + Math.PI / 2), Math.sin(angle + Math.PI / 2),
                      dist, width, rank > 0 ? travelled : 0, rank > 0 ? length : 1, rank)) break;
        laid.push({ x, z, angle, dist });

        x += Math.cos(angle) * STEP;
        z += Math.sin(angle) * STEP;
        // Veer, plus a little high-frequency stagger so the line is never smooth.
        angle += curvature * STEP + randRange(-0.35, 0.35) * STEP;
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

    const spin = Math.random() * TAU;
    const mains = [];
    for (let i = 0; i < arms; i++) {
      // Uneven spacing: equal angles read as a star however much they meander.
      const heading = spin + (i / arms) * TAU + randRange(-0.45, 0.45);
      const length = randRange(0.6, 1.0);
      // Start just outside the crater mouth rather than at a single point.
      const r0 = randRange(0.04, 0.12);
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
      walk(at.x, at.z, heading, randRange(0.18, 0.42), (b + 1) / MAX_BRANCHES, at.dist, 0.8);
    }

    this.nodeCount = node;
    this.geometry.setDrawRange(0, quad * 6);
    for (const name of ['position', 'aSide', 'aAcross', 'aDist', 'aJit', 'aWalk', 'aMaxWalk', 'aRank']) {
      this.geometry.attributes[name].needsUpdate = true;
    }
    this.geometry.index.needsUpdate = true;

    /* --- basalt along the lips --- */
    let lip = 0;
    for (const arm of mains) {
      for (let i = 2; i < arm.length && lip < MAX_LIPS; i += 3) {
        const point = arm[i];
        const record = this.lipRecords[lip++];
        record.x = point.x;
        record.z = point.z;
        record.sideX = Math.cos(point.angle + Math.PI / 2) * (i % 6 === 2 ? 1 : -1);
        record.sideZ = Math.sin(point.angle + Math.PI / 2) * (i % 6 === 2 ? 1 : -1);
        record.yaw = point.angle + randRange(-0.5, 0.5);
        record.dist = point.dist;
        record.size = Math.random();
        record.flat = Math.random();
        record.offset = Math.random();
        record.rank = 0;
      }
    }
    this.lipCount = lip;
  }

  /** Pose the lip chunks from the live settings. */
  _poseLips(grown, sink) {
    const c = settings.meteor;
    let used = 0;

    for (let i = 0; i < this.lipCount; i++) {
      const record = this.lipRecords[i];
      // Chunks are heaved up as the crack front passes them.
      const emerge = saturate((grown - record.dist) / 0.18);
      const size = c.fissureRockSize * lerp(0.55, 1.35, record.size);

      if (emerge <= 0) {
        _dummy.position.set(0, -999, 0);
        _dummy.scale.setScalar(0.0001);
        _dummy.quaternion.identity();
      } else {
        const out = c.fissureWidth * 0.55 + record.offset * c.fissureWidth * 0.6 + size * 0.15;
        _dummy.position.set(
          record.x * this.radius + record.sideX * out,
          // Sunk well in, so only the top ridge breaks through: broken crust,
          // not pebbles scattered on a floor.
          -size * lerp(0.3, 0.6, record.flat) - sink * (size * 2 + 0.4),
          record.z * this.radius + record.sideZ * out
        );
        _dummy.rotation.set(0, record.yaw, 0);
        const grow = Easing.outBack(emerge);
        _dummy.scale.set(size * grow, size * lerp(0.45, 0.85, record.flat) * grow, size * 0.8 * grow);
      }

      _dummy.updateMatrix();
      this.lips.setMatrixAt(i, _dummy.matrix);
      used = i + 1;
    }

    this.lips.count = used;
    this.lips.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */

  spawn(position, options) {
    const c = settings.meteor;
    this.age = 0;
    this.life = Math.max(0.2, options.life ?? c.fissureLife);
    this.radius = options.radius ?? c.fissureRadius;

    this.group.position.set(position.x, options.height ?? 0.02, position.z);
    this.group.rotation.y = Math.random() * TAU;

    this._generate(Math.max(2, Math.round(c.fissureArms)), c.fissureWander);
    this._poseLips(0, 0);
    this.sync(0);
  }

  /** Push the live settings into both passes. */
  sync(grown) {
    const c = settings.meteor;
    const g = settings.global;
    const t = saturate(this.age / this.life);

    // The melt cools long before the crack closes, then the whole thing fades.
    const heat = c.fissureHeat * (1 - Easing.inQuad(saturate((t - 0.25) / 0.75))) * g.shaderIntensity;
    const fade = 1 - Easing.inQuad(saturate((t - 0.7) / 0.3));

    for (const material of this.materials) {
      const u = material.uniforms;
      u.uRadius.value = this.radius;
      u.uWidth.value =
        material.defines.FISSURE_PASS === FissurePass.CORE
          ? c.fissureWidth
          : c.fissureWidth * 3.4 + 0.16;
      u.uBranchFrac.value = saturate(c.fissureBranches);
      u.uLenFrac.value = saturate(c.fissureBranchLength);
      u.uGrown.value = grown;
      u.uHeat.value = heat;
      u.uPulse.value = c.fissurePulse;
      u.uFade.value = fade;
      u.uColorSeam.value.copy(getColor(c.colorScorch));
      u.uColorRed.value.copy(getColor(c.colorFlameEdge));
      u.uColorOrange.value.copy(getColor(c.colorCrack));
      u.uColorWhite.value.copy(getColor(c.colorHot));
    }

    // Charred, not grey: these sit *in* the melt, and a mid-grey chunk lit by the
    // fire light reads as a pale pebble scattered on the floor.
    this.lipMaterial.color.copy(getColor(c.colorChar));
  }

  update(dt) {
    const c = settings.meteor;
    this.age += dt;
    const t = saturate(this.age / this.life);

    // The front races out from the impact, then the lips sink back as it dies.
    const grown = saturate((this.age * c.fissureGrowth) / Math.max(0.05, this.radius));
    const sink = Easing.inCubic(saturate((t - 0.82) / 0.18));

    this.sync(grown);
    this._poseLips(grown, sink);

    return t < 1;
  }

  dispose() {
    this.geometry.dispose();
    this.lipGeometry.dispose();
    this.lipMaterial.dispose();
    this.lips.dispose();
    for (const material of this.materials) material.dispose();
  }
}

/* ---------------------------------------------------------------------- */

/**
 * Pooled crack networks. One instance is reused per impact, so casting twenty
 * meteors builds at most a handful of ribbon buffers.
 */
export class FissureSystem {
  constructor(scene) {
    this.group = new Group();
    this.group.name = 'Fissures';
    scene.add(this.group);

    this.active = [];
    this.pool = new ObjectPool(
      () => new Fissure(),
      (fissure) => {
        fissure.group.visible = false;
        this.group.remove(fissure.group);
      }
    );
  }

  /**
   * Tear the ground open.
   * @param {THREE.Vector3} position where it was hit
   * @param {object} [options] { radius, life, height }
   */
  spawn(position, options = {}) {
    const fissure = this.pool.acquire();
    fissure.spawn(position, options);
    fissure.group.visible = true;
    this.group.add(fissure.group);
    this.active.push(fissure);
    return fissure;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (!this.active[i].update(dt)) {
        this.pool.release(this.active.splice(i, 1)[0]);
      }
    }
  }

  clear() {
    for (const fissure of this.active) this.pool.release(fissure);
    this.active.length = 0;
  }

  dispose() {
    this.clear();
    this.pool.dispose((fissure) => fissure.dispose());
    this.group.parent?.remove(this.group);
  }
}
