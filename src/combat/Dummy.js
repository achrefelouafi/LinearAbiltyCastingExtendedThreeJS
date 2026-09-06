import {
  AnimationMixer,
  Color,
  DoubleSide,
  Group,
  MathUtils,
  Matrix4,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  Vector3
} from 'three';
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js';

import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';
import { Ragdoll, collideRagdolls, stripNamespace } from './Ragdoll.js';

/**
 * Which joints each half of a cut body simulates.
 *
 * Both keep `Hips` (a chain needs a root) and `Spine` (the stump either side of
 * the plane). Beyond that they are disjoint, and that is the point: leave the
 * legs in the top half's solver and they land on the ground holding an
 * invisible pelvis a metre in the air, with the visible torso hanging off it.
 */
const LOWER_JOINTS = new Set([
  'Hips',
  'Spine',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'LeftToe_End',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
  'RightToe_End'
]);

const UPPER_JOINTS = new Set([
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Neck',
  'Head',
  'HeadTop_End',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand'
]);

/**
 * Which joints each half is *solid* with — see `collideRagdolls`.
 *
 * A subset of the sets above, and the difference is the whole reason it is a
 * second pair of sets rather than a reuse of the first. `Hips` and `Spine` are
 * simulated by both halves (a chain needs a root, and the stump either side of
 * the plane has to be driven), so on the frame of the cut they sit on top of
 * each other — made solid, the two halves would shove each other across the
 * field before the beam had finished going through. So the top half's copies of
 * them are not solid, and neither is `Spine1`, which is the first joint above
 * the plane and still inside the pelvis it was cut off.
 *
 * What is left on each side is the geometry a viewer can actually see: a pelvis
 * and two legs against a ribcage, a head and two arms.
 */
const LOWER_CONTACTS = new Set([
  'Hips',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'LeftToe_End',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
  'RightToe_End'
]);

const UPPER_CONTACTS = new Set([
  'Spine2',
  'Neck',
  'Head',
  'HeadTop_End',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand'
]);

const UP = /* @__PURE__ */ new Vector3(0, 1, 0);

const _cutNormal = /* @__PURE__ */ new Vector3();
const _cutNormalBind = /* @__PURE__ */ new Vector3();
const _cutNormalWorld = /* @__PURE__ */ new Vector3();
const _cutPoint = /* @__PURE__ */ new Vector3();
const _scratch = /* @__PURE__ */ new Vector3();

/**
 * A node's transform relative to one of its ancestors.
 *
 * Walks up the chain and multiplies the local matrices — no world matrices are
 * needed, so this is valid before the body has ever been added to a scene.
 */
function matrixRelativeTo(node, ancestor, out) {
  const chain = [];
  for (let current = node; current && current !== ancestor; current = current.parent) {
    chain.push(current);
  }

  out.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    chain[i].updateMatrix();
    out.multiply(chain[i].matrix);
  }
  return out;
}

/**
 * One target dummy: a rigged body that stands there breathing until an ability
 * reaches it, then falls over as a ragdoll and burns away — in one piece, or in
 * two if whatever reached it came with an edge on it.
 *
 * ## The handover
 *
 * The animation is not faded out when it dies, it is **abandoned** mid-frame:
 * the mixer is stopped, the skeleton's world matrices are brought up to date,
 * and the solver reads that pose as its first frame. There is nothing to blend
 * because the pose is continuous by construction — which is the only way a fall
 * ever looks like it happened to the body that was standing there.
 *
 * ## Being cut in half
 *
 * A cut is one plane and one clone. The body's mesh is duplicated, each copy is
 * told which side of the plane it keeps (a `discard` in the fragment shader),
 * and each gets its own solver seeded with only the joints that half actually
 * owns. Because the material has been double-sided since birth, the far wall of
 * the shell is already being rasterised — painting *that* as meat is the whole
 * of the cross-section: no cap geometry, no re-tessellation, and it is right
 * from every angle for free.
 *
 * The plane lives in the geometry's **bind** space, which is the one space no
 * bone can move: a cut measured at the waist stays at the waist however far the
 * corpse folds. See `_measureBind` for why that is not the rig's space.
 *
 * ## Its look
 *
 * The export carries no textures at all, so the material is authored here
 * rather than imported: a cold near-black body with a fresnel rim, so the
 * silhouette reads against the stage floor from across the arena, and a noise
 * dissolve that burns the corpse away when its time is up. Every dummy owns its
 * materials — the dissolve is per-body, and half a dozen materials is nothing
 * next to being able to give each corpse its own clock.
 *
 * @see Ragdoll for the solver, and DummyField for who spawns these.
 */
export class Dummy {
  /**
   * @param {object} options
   * @param {import('three').Object3D} options.source the loaded rig, at unit scale
   * @param {import('three').AnimationClip|null} options.clip its idle
   * @param {number} options.scale metres per unit of the export
   * @param {{x: number, y: number, z: number}} options.offset normalisation onto y = 0
   * @param {number} options.forwardYaw yaw of the rig's forward in model space
   * @param {import('../world/Environment.js').Environment} options.environment
   */
  constructor({ source, clip, scale, offset, forwardYaw, environment }) {
    this.environment = environment;
    this.forwardYaw = forwardYaw;
    /** Heading in radians about world +Y, on the same convention as the player. */
    this.facing = 0;
    /** 'alive' → 'dead' → 'burning' → 'gone'. */
    this.state = 'alive';
    /** Seconds in the current state. */
    this.timer = 0;
    /** 0 while the body is whole, 1 once it has burned away. */
    this.dissolve = 0;
    /**
     * How much of the body something *else* has taken — see `consume`.
     *
     * Kept apart from `dissolve` because the two run on different clocks and
     * the loudest one wins: a corpse the void has eaten a third of still burns
     * away on its own schedule if whatever was eating it lets go.
     */
    this._consumed = 0;
    /** True once the body has been parted, which is what makes it two of them. */
    this.sliced = false;
    /** True once it has gone under a surface — see `sink`. Latches the shadow off. */
    this._sunk = false;
    /** Where the last cut opened, in world space. Read by whatever made it. */
    this.cutPoint = new Vector3();

    this.root = new Group();
    this.root.name = 'Dummy';

    /** Metres per unit of the export — the dissolve's noise is sized off it. */
    this._scale = scale;
    /** How tall it stands, metres. What the hit test measures against. */
    this.height = settings.dummies.height;
    /** That height in the *export's* units — the cut is a fraction of it. */
    this._localHeight = Math.max(1e-3, this.height / scale);
    /**
     * The feet's centre in the model's own space.
     *
     * `DummyField` hands over the offset that drops that point onto the root's
     * origin, so it is that offset undone — and it is what the cut plane is
     * measured from, since a bind-space plane has to be placed in bind space.
     */
    this._base = new Vector3(-offset.x / scale, -offset.y / scale, -offset.z / scale);

    /* ---- the space the vertices are actually in — see `_measureBind` ---- */
    /** The mesh's own transform: vertex space → the model's space. */
    this._bindMatrix = new Matrix4();
    /** The rig's up, in vertex space. */
    this._bindUp = new Vector3(0, 1, 0);
    /** Where the feet are along that axis, and how far the head is from them. */
    this._bindBase = 0;
    this._bindHeight = 1;

    const model = cloneRigged(source);
    model.scale.setScalar(scale);
    model.position.set(offset.x, offset.y, offset.z);
    this.root.add(model);

    // Before the first part, because every part's uniforms are sized off it.
    this._measureBind(model);

    /**
     * The body, as one or two pieces of it.
     *
     * One while it is whole; two once it has been cut, each with its own copy
     * of the mesh, its own materials, its own bones and its own fall.
     */
    this.parts = [this._makePart(model)];

    this.mixer = new AnimationMixer(this.model);
    this.action = clip ? this.mixer.clipAction(clip) : null;
    if (this.action) {
      // Its own phase and its own pace. Half a dozen bodies breathing in unison
      // is the single most artificial thing a crowd can do, and it costs two
      // lines to never do it.
      this.action.play();
      this.action.time = Math.random() * this.action.getClip().duration;
      this.action.setEffectiveTimeScale(0.92 + Math.random() * 0.16);
    }
  }

  /** The piece the animation is played on — the whole body, or its legs. */
  get model() {
    return this.parts[0].model;
  }

  /** name → bone for that piece, raw *and* namespace-stripped. */
  get bones() {
    return this.parts[0].bones;
  }

  get alive() {
    return this.state === 'alive';
  }

  /** True once it has finished burning and the slot can be reused. */
  get finished() {
    return this.state === 'gone';
  }

  get position() {
    return this.root.position;
  }

  /* ------------------------------------------------------------------ */
  /* the space a cut lives in                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Where this export's *vertices* live, which is not where its skeleton does.
   *
   * The cut is resolved against `position` — the attribute, untouched by a
   * single bone — and that attribute is in the mesh's own object space, not the
   * rig's. On a Mixamo export the two can be three axes and a factor of a
   * hundred apart: the mesh may carry its own conversion on its transform, so
   * the vertex a metre up the body reads `z = 1.0` while everything measured
   * off the rig reads `y = 100`.
   *
   * A plane built in the rig's numbers therefore misses the mesh entirely — it
   * lands far outside it, one half keeps every vertex and the other keeps none,
   * and a body that was cut falls over looking exactly like one that was not.
   *
   * So the mesh's transform is measured once, here, and every plane is pushed
   * through it (`_toBindPlane`) before a shader sees it.
   */
  _measureBind(model) {
    let mesh = null;
    model.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;
      node.updateMatrix();
      if (!mesh) mesh = node;
      // One plane is shared by every material on a half, so a second mesh in a
      // different space would be cut somewhere else entirely.
      else if (!mesh.matrix.equals(node.matrix)) {
        console.warn(
          '[Dummy] this export has meshes in different object spaces — the cut follows the first'
        );
      }
    });
    if (mesh) matrixRelativeTo(mesh, model, this._bindMatrix);

    // The rig's up and the body's extent along it, in the space the vertices
    // are in. Two planes rather than an axis and a number: the same conversion
    // that places the cut places these, so the three cannot drift apart.
    const feet = this._toBindPlane(UP, this._base.y, this._bindUp);
    const head = this._toBindPlane(UP, this._base.y + this._localHeight, _scratch);
    this._bindBase = feet;
    this._bindHeight = Math.max(1e-4, head - feet);
  }

  /**
   * A plane in the model's space → the same plane in the mesh's vertex space.
   *
   * Planes do not transform like points. Push a normal through a matrix that
   * scales or rotates and it stops being perpendicular to its own plane; the
   * *transpose* is what carries it, and that falls straight out of the algebra
   * — `dot(n, M·v) = d` is `dot(Mᵀ·n, v) = d`, once the translation has been
   * taken off the offset. Normalising afterwards is what keeps
   * `dot(position, normal) - offset` a distance, which is the unit the cut's
   * hot edge is measured in.
   *
   * @param {Vector3} normal unit, in the model's space
   * @param {number} offset `dot(normal, point)` for any point on the plane
   * @param {Vector3} out the plane's normal in vertex space, written here
   * @returns {number} the offset that goes with it
   */
  _toBindPlane(normal, offset, out) {
    const e = this._bindMatrix.elements;
    out.set(
      e[0] * normal.x + e[1] * normal.y + e[2] * normal.z,
      e[4] * normal.x + e[5] * normal.y + e[6] * normal.z,
      e[8] * normal.x + e[9] * normal.y + e[10] * normal.z
    );
    const shifted = offset - (e[12] * normal.x + e[13] * normal.y + e[14] * normal.z);

    const length = out.length();
    // A degenerate mesh transform: nothing sensible to convert into, so the
    // plane is handed back as it came and the cut is at least not nonsense.
    if (length < 1e-9) {
      out.copy(normal);
      return offset;
    }
    out.multiplyScalar(1 / length);
    return shifted / length;
  }

  /* ------------------------------------------------------------------ */
  /* the look                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * One piece of body: its own materials, its own uniforms, its own bones.
   *
   * Everything a half needs to be shaded and simulated on its own is built
   * here, so cutting the body in two is `_makePart(clone)` and a plane.
   */
  _makePart(model) {
    const part = {
      model,
      bones: new Map(),
      materials: [],
      uniforms: this._makeUniforms(),
      ragdoll: null,
      /** The joint nearest the cut — where this half was parted. */
      cutBone: null
    };

    this._dress(part);

    model.traverse((node) => {
      if (!node.isBone) return;
      part.bones.set(node.name, node);
      const short = stripNamespace(node.name);
      if (short && !part.bones.has(short)) part.bones.set(short, node);
    });

    return part;
  }

  /** The dissolve, the rim and the cut, shared by every material on one piece. */
  _makeUniforms() {
    const cut = settings.slice;
    return {
      uDissolve: { value: 0 },
      uDetail: { value: 9 * this._scale },
      uEdgeWidth: { value: 0.12 },
      uEdgeColor: { value: new Color() },
      uEdgeEmissive: { value: 6 },
      uRimColor: { value: new Color() },
      uRimPower: { value: 2.6 },
      uRimEmissive: { value: 1.5 },

      /** 0 while the body is whole; ±1 for the side of the plane it keeps. */
      uCutSide: { value: 0 },
      /** The plane, in the geometry's *bind* space — see `_cut`. */
      uCutNormal: { value: new Vector3(0, 1, 0) },
      uCutOffset: { value: 0 },
      uInteriorColor: { value: getColor(cut.interiorColor).clone() },
      uInteriorEmissive: { value: cut.interiorEmissive },
      uCutEdgeColor: { value: getColor(cut.edgeColor).clone() },
      uCutEdgeEmissive: { value: cut.edgeEmissive },
      uCutEdgeWidth: { value: cut.edgeWidth * this._bindHeight }
    };
  }

  /**
   * Replace whatever the FBX brought with an authored PBR material, and inject
   * the rim, the dissolve and the cut into it.
   *
   * The dissolve is a plain noise threshold with a `discard`: opaque the whole
   * way, so nothing has to sort, and the burn edge is emissive rather than
   * transparent. The noise is evaluated on the *posed* vertex, which is what
   * keeps the burn stuck to a corpse that is still settling; the cut is
   * evaluated on the *bind* vertex, which is what keeps the plane at the waist
   * while the corpse folds over it.
   *
   * Double-sided from birth, and deliberately: the back faces are what fill the
   * hollow a cut opens, and a body that only became double-sided at the moment
   * it was cut would recompile its shader on the frame of the blow — which is
   * the one frame in the whole sandbox that cannot afford it.
   */
  _dress(part) {
    const converted = new Map();

    part.model.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      // A ragdoll leaves the bounds the mesh was authored with far behind.
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);
      // The cut is a `discard`, and the depth pass would otherwise go on
      // casting a whole body's shadow off half of one.
      node.customDepthMaterial = this._makeDepthMaterial(part);

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const result = source.map((material) => {
        if (converted.has(material)) return converted.get(material);

        const standard = new MeshStandardMaterial({
          name: 'Dummy',
          color: 0xffffff,
          roughness: 0.78,
          metalness: 0.15,
          side: DoubleSide
        });
        this.environment.registerShadowCasterWithPatch(standard, (shader) => {
          Object.assign(shader.uniforms, part.uniforms);

          shader.vertexShader = shader.vertexShader
            .replace(
              '#include <common>',
              '#include <common>\nvarying vec3 vBodyPos;\nvarying vec3 vBindPos;'
            )
            // The posed vertex is taken at the projection, which is the one
            // point in the chain that is always past the skinning: the noise
            // then rides the pose rather than the bind, and a corpse does not
            // burn in a pattern that slides over it while it settles. The bind
            // vertex is the attribute itself, before a bone has touched it.
            .replace(
              '#include <project_vertex>',
              'vBodyPos = transformed;\nvBindPos = position;\n#include <project_vertex>'
            );

          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              `#include <common>
               varying vec3 vBodyPos;
               varying vec3 vBindPos;
               uniform float uDissolve;
               uniform float uDetail;
               uniform float uEdgeWidth;
               uniform vec3 uEdgeColor;
               uniform float uEdgeEmissive;
               uniform vec3 uRimColor;
               uniform float uRimPower;
               uniform float uRimEmissive;
               uniform float uCutSide;
               uniform vec3 uCutNormal;
               uniform float uCutOffset;
               uniform vec3 uInteriorColor;
               uniform float uInteriorEmissive;
               uniform vec3 uCutEdgeColor;
               uniform float uCutEdgeEmissive;
               uniform float uCutEdgeWidth;
               ${noiseGLSL}`
            )
            // Both discards as early as the chunk list allows: half of a cut
            // body is not there at all, and there is no sense shading it.
            .replace(
              '#include <clipping_planes_fragment>',
              `#include <clipping_planes_fragment>
               // Signed so that positive is the side this copy was told to
               // keep, whichever side of the plane that is. Declared here and
               // read again further down: both blocks land inside main().
               float cutSide = uCutSide == 0.0
                 ? 1.0
                 : (dot(vBindPos, uCutNormal) - uCutOffset) * uCutSide;
               if (cutSide < 0.0) discard;

               float burn = clamp(fbm3(vBodyPos * uDetail) * 0.5 + 0.5, 0.0, 1.0);
               if (burn < uDissolve) discard;`
            )
            .replace(
              '#include <emissivemap_fragment>',
              `#include <emissivemap_fragment>
               {
                 // The body is a shell, so what a cut exposes is the *inside*
                 // of the far wall — exactly the back faces the material is
                 // double-sided for. Painting them as meat is the whole of the
                 // cross-section: no cap geometry, no re-tessellation, and it
                 // is right from every angle for free.
                 if (uCutSide != 0.0 && !gl_FrontFacing) {
                   diffuseColor.rgb = uInteriorColor;
                   totalEmissiveRadiance += uInteriorColor * uInteriorEmissive;
                 }

                 // And the line the edge left along the surface it went through.
                 if (uCutSide != 0.0) {
                   float lip = 1.0 - smoothstep(0.0, max(uCutEdgeWidth, 1e-4), cutSide);
                   totalEmissiveRadiance += uCutEdgeColor * lip * uCutEdgeEmissive;
                 }

                 // The rim draws the silhouette, and the inside of a body has
                 // none — running it on the back faces would put a bright edge
                 // around the meat.
                 if (gl_FrontFacing) {
                   float rim = pow(
                     1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0),
                     uRimPower
                   );
                   totalEmissiveRadiance += uRimColor * rim * uRimEmissive;
                 }

                 // And the band of embers just ahead of the burn line.
                 float edge = 1.0 - smoothstep(0.0, max(1e-4, uEdgeWidth), burn - uDissolve);
                 totalEmissiveRadiance +=
                   uEdgeColor * edge * uEdgeEmissive * step(1e-4, uDissolve);
               }`
            );
        });

        material?.dispose();
        converted.set(material, standard);
        part.materials.push(standard);
        return standard;
      });

      node.material = Array.isArray(node.material) ? result : result[0];
    });
  }

  /**
   * The same cut, for the shadow map.
   *
   * Only the plane: the burn-away is not here because a body that has started
   * dissolving is taken out of the depth pass entirely (`_castShadows`), and a
   * noise tap per shadow texel to say the same thing twice is not worth its
   * compile.
   */
  _makeDepthMaterial(part) {
    const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

    this.environment.registerShadowCasterWithPatch(material, (shader) => {
      Object.assign(shader.uniforms, part.uniforms);
      shader.vertexShader = `varying vec3 vBindPos;\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvBindPos = position;'
      );
      shader.fragmentShader =
        `uniform float uCutSide;\nuniform vec3 uCutNormal;\nuniform float uCutOffset;\nvarying vec3 vBindPos;\n${shader.fragmentShader}`.replace(
          '#include <alphatest_fragment>',
          `#include <alphatest_fragment>
           if (uCutSide != 0.0 && (dot(vBindPos, uCutNormal) - uCutOffset) * uCutSide < 0.0) discard;`
        );
    });

    return material;
  }

  /** Pull the live editor values through. Colours are cached by `getColor`. */
  _syncMaterials() {
    const look = settings.dummies.look;
    const cut = settings.slice;

    for (const part of this.parts) {
      for (const material of part.materials) {
        material.color.copy(getColor(look.color));
        material.roughness = look.roughness;
        material.metalness = look.metalness;
      }

      const u = part.uniforms;
      u.uRimColor.value.copy(getColor(look.rimColor));
      u.uRimPower.value = look.rimPower;
      u.uRimEmissive.value = look.rimEmissive;
      u.uEdgeColor.value.copy(getColor(look.edgeColor));
      u.uEdgeEmissive.value = look.edgeEmissive;
      u.uEdgeWidth.value = look.edgeWidth;
      u.uDetail.value = look.dissolveDetail * this._scale;
      u.uDissolve.value = this.dissolve;

      // The cut's own look, so the meat and the hot line stay editable while a
      // corpse is lying there in two pieces. The plane itself is *not* re-read:
      // it was resolved from the blow, and nothing may move it afterwards.
      u.uInteriorColor.value.copy(getColor(cut.interiorColor));
      u.uInteriorEmissive.value = cut.interiorEmissive;
      u.uCutEdgeColor.value.copy(getColor(cut.edgeColor));
      u.uCutEdgeEmissive.value = cut.edgeEmissive;
    }
  }

  /** Whichever pieces of the body there are, in or out of the depth pass. */
  _castShadows(on) {
    for (const part of this.parts) {
      part.model.traverse((node) => {
        if (node.isMesh || node.isSkinnedMesh) node.castShadow = on;
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* life                                                                */
  /* ------------------------------------------------------------------ */

  /** Stand it up at a world XZ, facing `yaw`, whole again. */
  place(x, z, yaw) {
    // Whatever the last cut left behind. The clone was this body's own, so it
    // goes with it rather than being carried into the next life.
    while (this.parts.length > 1) this._disposePart(this.parts.pop());

    this.sliced = false;
    this._sunk = false;
    const part = this.parts[0];
    part.ragdoll = null;
    part.cutBone = null;
    part.uniforms.uCutSide.value = 0;
    this._castShadows(true);

    this.root.position.set(x, 0, z);
    this.facing = yaw;
    this.root.rotation.y = yaw - this.forwardYaw;
    this.root.visible = true;

    this.state = 'alive';
    this.timer = 0;
    this.dissolve = 0;
    this._consumed = 0;

    // Back to the clip, from wherever the last fall left the skeleton.
    if (this.action) {
      this.action.reset();
      this.action.play();
      this.action.time = Math.random() * this.action.getClip().duration;
    }
    return this;
  }

  /**
   * Knock it down, and throw the body along `(x, z)`.
   *
   * @param {number} x unit direction of the blow, flat
   * @param {number} z
   * @param {{impulse: number, lift: number, spin: number}} force
   * @param {boolean} [slice] whether the blow came down with an edge on it
   * @returns {boolean} false if it was already down
   */
  kill(x, z, force, slice = false) {
    if (!this.alive) return false;

    this.state = 'dead';
    this.timer = 0;

    // Nothing fades: the pose the clip is on *is* the ragdoll's first frame, so
    // the skeleton is brought fully up to date — ancestors included — before it
    // is read. The solver works in world space and every rest length it
    // measures comes off these matrices.
    this.mixer.stopAllAction();
    this.root.updateWorldMatrix(true, true);

    if (slice && settings.slice.enabled && this._cut(x, z)) {
      const cut = settings.slice;
      this._fall(this.parts[0], x, z, force, cut.lower, LOWER_JOINTS, LOWER_CONTACTS);
      this._fall(this.parts[1], x, z, force, cut.upper, UPPER_JOINTS, UPPER_CONTACTS);
      // The two halves start on the same particles, so the top is lifted clear
      // by hand on this one frame; the impulses part them from here.
      this.parts[1].ragdoll?.displace(
        _cutNormalWorld.x * cut.separation,
        _cutNormalWorld.y * cut.separation,
        _cutNormalWorld.z * cut.separation
      );
      // And driven apart along the blow: the top the way the beam went, the
      // legs the other way. Without it both halves leave on the same vector and
      // land in one heap, which reads as a body that fell over rather than one
      // that came apart.
      const split = Math.max(0, cut.split);
      if (split > 0) {
        this.parts[1].ragdoll?.shove(x * split, 0, z * split);
        this.parts[0].ragdoll?.shove(-x * split, 0, -z * split);
      }
      return true;
    }

    this._fall(this.parts[0], x, z, force, null, null, null);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* being taken hold of                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Where the body is while it falls — the hips, in world space.
   *
   * Not `position`, which is the spot it was placed at and which the solver
   * never moves. Null while it is still standing, because a body on its feet
   * has no solver to ask.
   *
   * @param {import('three').Vector3} out written in place
   * @returns {import('three').Vector3|null}
   */
  bodyPoint(out) {
    return this.parts[0].ragdoll?.centre(out) ?? null;
  }

  /**
   * How fast it is travelling, metres per second. Null while it is standing.
   *
   * @param {import('three').Vector3} out written in place
   * @returns {import('three').Vector3|null}
   */
  bodyVelocity(out) {
    return this.parts[0].ragdoll?.velocity(out) ?? null;
  }

  /**
   * Hand every joint of every piece to a velocity field — a current, not a blow.
   *
   * `kill` throws a body once, with a torque, and that is the whole damage
   * model for everything that simply *reaches*. This is for the one thing that
   * keeps acting on a body after it is down: a metre of moving water does not
   * hit a corpse, it carries it, so it arrives every frame as a velocity the
   * body is dragged toward rather than as an impulse on one.
   *
   * The field is sampled at each joint rather than once for the body, because
   * the water that swallows things is *turning*: it reaches the near shoulder
   * faster than the far one, and that difference is the only thing that makes a
   * corpse spin instead of slide. See `Ragdoll#steer`.
   *
   * Water also holds a body *up*, and that half cannot be done with a velocity:
   * gravity is integrated per solver substep while this arrives per frame, so a
   * current strong enough to float a corpse at sixty frames a second launches it
   * at six. `buoyancy` takes the weight off where the weight is applied, which
   * means the same thing at every frame rate. It stays where it is put, so
   * whatever set it has to give it back — `release` does.
   *
   * @param {(x: number, y: number, z: number, out: Vector3) => void} field
   *   writes the velocity of the water at a world-space point
   * @param {number} grab 0..1, how much of the gap it closes this frame
   * @param {number} [grabY] the same for the vertical
   * @param {number} [buoyancy] 0..1, how much of the body's weight the water
   *   is carrying
   */
  carry(field, grab, grabY, buoyancy = 0) {
    for (const part of this.parts) {
      if (!part.ragdoll) continue;
      part.ragdoll.buoyancy = buoyancy;
      part.ragdoll.steer(field, grab, grabY);
    }
  }

  /**
   * Take the floor out from under this body.
   *
   * The solver clamps every joint to a ground plane, which is the stage floor
   * for everything else standing on it. A whirlpool needs the one thing it has
   * no concept of — water the body can go *through* — and dropping that plane by
   * `depth` is the whole of it: gravity does the rest, the opaque floor hides
   * whatever has gone under it, and the shadow is dropped on the way past so a
   * body beneath the surface is not still printing one on top of it.
   *
   * Idempotent, and safe to call every frame: it is only ever lowering a number
   * the solver reads.
   *
   * @param {number} depth metres below the stage floor the body may fall to
   */
  sink(depth) {
    const floor = -Math.max(0, depth);
    for (const part of this.parts) {
      // Monotonic: the floor only ever goes *down*. Assigning it outright would
      // let a caller that reduces its depth — a whirlpool losing its grip, or
      // one taking hold of a body it had already let go of — shove a submerged
      // corpse back up through the surface that swallowed it.
      if (part.ragdoll) part.ragdoll.floor = Math.min(part.ragdoll.floor, floor);
    }
    if (this._sunk) return;
    const hips = this.bodyPoint(_scratch);
    if (!hips || hips.y > -0.25) return;
    this._sunk = true;
    this._castShadows(false);
  }

  /**
   * Give the floor back, wherever the body has got to.
   *
   * Called when whatever had hold of it lets go. A body still above the surface
   * is handed the stage floor again and lands on it; one already under is left
   * with the floor it has, because raising the plane under a submerged corpse
   * would shove it back up through the water that just swallowed it.
   */
  release() {
    // The weight comes back first, and unconditionally: a body left floating
    // because whatever was holding it up stopped asking is a body that never
    // lands, wherever it happens to be when the grip is dropped.
    for (const part of this.parts) {
      if (part.ragdoll) part.ragdoll.buoyancy = 0;
    }
    const hips = this.bodyPoint(_scratch);
    if (hips && hips.y < 0) return;
    for (const part of this.parts) {
      if (part.ragdoll) part.ragdoll.floor = 0;
    }
  }

  /**
   * Take the body away on somebody else's clock.
   *
   * `sink` is how a whirlpool disposes of a corpse: the floor opens and the
   * stage's own opaque geometry does the hiding. Nothing hides a body being
   * drawn into something three metres off the ground, so the Astral Void Blast
   * needs the other end of the same idea — the burn that already exists for a
   * corpse whose time is up, driven by *distance from the horizon* rather than
   * by a timer.
   *
   * Two rules make it safe to call every frame from a pull that is fighting
   * gravity for the body:
   *
   *  - **Monotonic.** It only ever raises the amount taken. A body that slips
   *    back out of the throat for a frame must not visibly heal, and a caller
   *    whose grip weakens must not be able to reassemble a corpse.
   *  - **It does not stop the natural burn.** `dissolve` is the louder of the
   *    two clocks, so a body eaten halfway and then let go finishes burning on
   *    its own schedule instead of lying around half gone.
   *
   * A body still on its feet is not consumed: it has to be knocked down first,
   * because a standing target has no solver and nothing to be dragged by.
   *
   * @param {number} amount 0..1, how much of the body has been taken
   * @returns {number} how much is gone, after the monotonic clamp
   */
  consume(amount) {
    if (this.state === 'alive' || this.state === 'gone') return this._consumed;

    const want = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    if (want <= this._consumed) return this._consumed;
    this._consumed = want;

    if (this.state === 'dead') {
      // Skip the wait: this corpse is not lying there cooling, it is being
      // eaten. The depth pass has no idea the body is going away, so it would
      // go on casting a whole shadow off half of one — which is exactly why the
      // natural burn drops the shadow at this same transition.
      this.state = 'burning';
      this.timer = 0;
      this._castShadows(false);
    }

    this.dissolve = Math.max(this.dissolve, this._consumed);
    return this._consumed;
  }

  /**
   * Build one piece's ragdoll and hand it the blow.
   *
   * @param {object} part
   * @param {{impulse: number, lift: number, spin: number}} force the blow's own
   * @param {{impulse: number, lift: number, spin: number}|null} weights what
   *   this half takes of it — null for a body that is still in one piece
   * @param {Set<string>|null} joints which of them this half simulates
   * @param {Set<string>|null} contacts which of *those* the other half can land
   *   on — null for a body that is still in one piece
   */
  _fall(part, x, z, force, weights, joints, contacts) {
    const ragdoll = new Ragdoll(part.bones, { include: joints, collide: contacts });
    if (!ragdoll.valid) {
      console.warn('[Dummy] no ragdoll could be built from this rig — the body will not fall');
      return;
    }

    part.ragdoll = ragdoll;
    ragdoll.strike(
      x,
      z,
      weights
        ? {
            impulse: force.impulse * weights.impulse,
            lift: force.lift * weights.lift,
            spin: force.spin * weights.spin
          }
        : force
    );
  }

  /**
   * Part the body along a plane, and stand a second copy of it up to hold the
   * other side.
   *
   * The plane is resolved in the *model's* space first, because that is the
   * space the blow arrives in and the space `height` and `tilt` are meant in:
   * `height` up the export from the feet, tipped `tilt` degrees away along the
   * blow so the cut reads as a stroke rather than as a bandsaw. The blow is in
   * world space and the root only ever turns about Y, so undoing that one yaw
   * is the whole of that conversion.
   *
   * It is then pushed into the mesh's vertex space (`_toBindPlane`), which is
   * where a shader can test it — and, critically, a space no bone can move.
   *
   * @returns {boolean} false if there was nothing to duplicate
   */
  _cut(x, z) {
    const cut = settings.slice;
    const yaw = this.root.rotation.y;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    // World → the model's frame: R(-yaw) on a horizontal vector.
    const dirX = x * cos - z * sin;
    const dirZ = x * sin + z * cos;

    // Up, tipped away along the blow. `tilt` is the only thing keeping the two
    // halves from meeting again in a perfectly flat plane as they settle.
    const tilt = MathUtils.degToRad(cut.tilt);
    _cutNormal.set(-dirX * Math.sin(tilt), Math.cos(tilt), -dirZ * Math.sin(tilt)).normalize();

    _cutPoint.copy(this._base);
    _cutPoint.y += MathUtils.clamp(cut.height, 0.05, 0.95) * this._localHeight;
    // The model's plane, and then the only one a shader can use.
    const bindOffset = this._toBindPlane(_cutNormal, _cutNormal.dot(_cutPoint), _cutNormalBind);

    const upper = cloneRigged(this.parts[0].model);
    this.root.add(upper);
    this.parts.push(this._makePart(upper));
    // The clone has to be in the world before the solver reads a bone off it.
    this.root.updateWorldMatrix(true, true);

    for (const [index, part] of this.parts.entries()) {
      const u = part.uniforms;
      // −1 keeps what is under the plane, +1 what is over it.
      u.uCutSide.value = index === 0 ? -1 : 1;
      u.uCutNormal.value.copy(_cutNormalBind);
      u.uCutOffset.value = bindOffset;
      u.uCutEdgeWidth.value = Math.max(1e-4, cut.edgeWidth * this._bindHeight);
      part.cutBone = part.bones.get('Spine') ?? part.bones.get('Hips') ?? null;
    }

    this.sliced = true;

    /* ---- what the rest of the frame gets to see of it ---- */
    // Where the cut is, in the world. Taken off the joint nearest the plane
    // rather than by pushing the plane's own point through the model's matrix:
    // a bone's world position is unambiguous, and the geometry's space is only
    // the model's space as long as nobody exports a mesh with a transform on it.
    const waist = this.parts[0].cutBone;
    if (waist) waist.getWorldPosition(this.cutPoint);
    else this.cutPoint.copy(this.root.position).setY(cut.height * this.height);
    // The plane's normal in world space — the direction the top half is lifted
    // clear along on the frame it parts (see `kill`).
    _cutNormalWorld.copy(_cutNormal).applyAxisAngle(UP, yaw);

    return true;
  }

  /**
   * @param {number} dt simulation delta — the corpse freezes with the sandbox
   * @param {import('three').Vector3|null} watch where to look, while it still can
   */
  update(dt, watch = null) {
    if (this.state === 'gone') return;
    this._syncMaterials();

    const config = settings.dummies;

    if (this.state === 'alive') {
      if (config.watch && watch) this._turnToward(watch, dt);
      this.mixer.timeScale = settings.global.animationSpeed;
      this.mixer.update(dt);
      return;
    }

    // Down: the solver owns the bones, and the clock only decides when the body
    // stops being scenery. Two solvers, if it came apart.
    for (const part of this.parts) part.ragdoll?.update(dt);
    // And two solvers that know nothing of each other, so the torso would fall
    // straight through the legs it was cut off. This is the only thing that
    // puts the halves in each other's way, and it runs here rather than inside
    // either solver because this is the one object that owns both of them.
    if (this.sliced && collideRagdolls(this.parts[0].ragdoll, this.parts[1]?.ragdoll)) {
      // Only what moved: a half that is asleep was treated as furniture by the
      // pass above and is already posed where it settled.
      for (const part of this.parts) {
        if (!part.ragdoll?.asleep) part.ragdoll?.repose();
      }
    }

    this.timer += dt;

    if (this.state === 'dead') {
      if (this.timer < config.corpseTime) return;
      this.state = 'burning';
      this.timer = 0;
      // The depth pass has no idea the body is being burned away, so it would
      // go on casting a whole shadow off a corpse that is half gone. (The *cut*
      // it does know about — see `_makeDepthMaterial`.)
      this._castShadows(false);
      return;
    }

    // Past 1 rather than at it: the threshold is a strict `<`, so the last
    // few texels of the body need the burn to go over the top to clear.
    // Whichever clock is further along wins — see `consume`, which is the other
    // one and which can be well ahead of this by the time it starts.
    this.dissolve = Math.max(this._consumed, this.timer / Math.max(0.05, config.dissolveTime));
    // A body eaten outright is gone on that frame rather than lingering as a
    // fully-discarded shell until the natural burn catches up with it.
    if (this.dissolve < 1.05 && this._consumed < 1) return;

    this.state = 'gone';
    this.root.visible = false;
  }

  /** Face the caster, slowly enough that it reads as a turn rather than a snap. */
  _turnToward(target, dt) {
    if (dt <= 0) return;
    const yaw = Math.atan2(target.x - this.root.position.x, target.z - this.root.position.z);
    const delta = MathUtils.euclideanModulo(yaw - this.facing + Math.PI, Math.PI * 2) - Math.PI;
    const rate = MathUtils.clamp(settings.dummies.turnRate, 1e-6, 1);
    this.facing += delta * (1 - Math.pow(rate, dt));
    this.root.rotation.y = this.facing - this.forwardYaw;
  }

  /**
   * Release one piece of body.
   *
   * The geometry is the source rig's and is shared with every other dummy; the
   * materials, the skeletons and the depth overrides are this piece's own, so
   * they are the parts that must go.
   */
  _disposePart(part) {
    part.model.traverse((node) => {
      if (node.isSkinnedMesh) node.skeleton?.dispose();
      node.customDepthMaterial?.dispose();
      node.customDepthMaterial = undefined;
    });
    for (const material of part.materials) material.dispose();
    part.materials.length = 0;
    part.bones.clear();
    part.ragdoll = null;
    part.model.parent?.remove(part.model);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.action = null;
    for (const part of this.parts) this._disposePart(part);
    this.parts.length = 0;
    this.root.parent?.remove(this.root);
  }
}
