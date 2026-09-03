import { AnimationMixer, Color, Group, MathUtils, MeshStandardMaterial } from 'three';
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js';

import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';
import { Ragdoll, stripNamespace } from './Ragdoll.js';

/**
 * One target dummy: a rigged body that stands there breathing until an ability
 * reaches it, then falls over as a ragdoll and burns away.
 *
 * ## The handover
 *
 * The animation is not faded out when it dies, it is **abandoned** mid-frame:
 * the mixer is stopped, the skeleton's world matrices are brought up to date,
 * and the solver reads that pose as its first frame. There is nothing to blend
 * because the pose is continuous by construction — which is the only way a fall
 * ever looks like it happened to the body that was standing there.
 *
 * ## Its look
 *
 * The export carries no textures at all, so the material is authored here
 * rather than imported: a cold near-black body with a fresnel rim, so the
 * silhouette reads against the stage floor from across the arena, and a
 * noise dissolve that burns the corpse away when its time is up. Every dummy
 * owns its materials — the dissolve is per-body, and half a dozen materials is
 * nothing next to being able to give each corpse its own clock.
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

    this.root = new Group();
    this.root.name = 'Dummy';

    /** Metres per unit of the export — the dissolve's noise is sized off it. */
    this._scale = scale;
    /** How tall it stands, metres. What the hit test measures against. */
    this.height = settings.dummies.height;

    this.model = cloneRigged(source);
    this.model.scale.setScalar(scale);
    this.model.position.set(offset.x, offset.y, offset.z);
    this.root.add(this.model);

    /** name → bone, raw *and* namespace-stripped, which is what the solver asks for. */
    this.bones = new Map();
    this.model.traverse((node) => {
      if (!node.isBone) return;
      this.bones.set(node.name, node);
      const short = stripNamespace(node.name);
      if (short && !this.bones.has(short)) this.bones.set(short, node);
    });

    this.uniforms = {
      uDissolve: { value: 0 },
      uDetail: { value: 9 * scale },
      uEdgeWidth: { value: 0.12 },
      uEdgeColor: { value: new Color() },
      uEdgeEmissive: { value: 6 },
      uRimColor: { value: new Color() },
      uRimPower: { value: 2.6 },
      uRimEmissive: { value: 1.5 }
    };
    this.materials = [];
    this._dressMaterials();
    this._syncMaterials();

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

    /** The solver, once something has knocked this body over. */
    this.ragdoll = null;
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
  /* the look                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Replace whatever the FBX brought with an authored PBR material, and inject
   * the rim and the dissolve into it.
   *
   * The dissolve is a plain noise threshold with a `discard`: opaque the whole
   * way, so nothing has to sort, and the burn edge is emissive rather than
   * transparent. The noise is evaluated on the *posed* vertex, which is what
   * keeps the burn stuck to a corpse that is still settling.
   */
  _dressMaterials() {
    const converted = new Map();

    this.model.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      // A ragdoll leaves the bounds the mesh was authored with far behind.
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const result = source.map((material) => {
        if (converted.has(material)) return converted.get(material);

        const standard = new MeshStandardMaterial({
          name: 'Dummy',
          color: 0xffffff,
          roughness: 0.78,
          metalness: 0.15
        });
        this.environment.registerShadowCasterWithPatch(standard, (shader) => {
          Object.assign(shader.uniforms, this.uniforms);

          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vBodyPos;')
            // Taken at the projection, which is the one point in the chain that
            // is always past the skinning: the noise then rides the pose rather
            // than the bind, and a corpse does not burn in a pattern that
            // slides over it while it settles.
            .replace(
              '#include <project_vertex>',
              'vBodyPos = transformed;\n#include <project_vertex>'
            );

          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              `#include <common>
               varying vec3 vBodyPos;
               uniform float uDissolve;
               uniform float uDetail;
               uniform float uEdgeWidth;
               uniform vec3 uEdgeColor;
               uniform float uEdgeEmissive;
               uniform vec3 uRimColor;
               uniform float uRimPower;
               uniform float uRimEmissive;
               ${noiseGLSL}`
            )
            .replace(
              '#include <clipping_planes_fragment>',
              `#include <clipping_planes_fragment>
               float burn = clamp(fbm3(vBodyPos * uDetail) * 0.5 + 0.5, 0.0, 1.0);
               if (burn < uDissolve) discard;`
            )
            .replace(
              '#include <emissivemap_fragment>',
              `#include <emissivemap_fragment>
               {
                 // The rim that draws the silhouette against the floor.
                 float rim = pow(
                   1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0),
                   uRimPower
                 );
                 totalEmissiveRadiance += uRimColor * rim * uRimEmissive;

                 // And the band of embers just ahead of the burn line.
                 float edge = 1.0 - smoothstep(0.0, max(1e-4, uEdgeWidth), burn - uDissolve);
                 totalEmissiveRadiance +=
                   uEdgeColor * edge * uEdgeEmissive * step(1e-4, uDissolve);
               }`
            );
        });

        material?.dispose();
        converted.set(material, standard);
        this.materials.push(standard);
        return standard;
      });

      node.material = Array.isArray(node.material) ? result : result[0];
    });
  }

  /** Pull the live editor values through. Colours are cached by `getColor`. */
  _syncMaterials() {
    const look = settings.dummies.look;

    for (const material of this.materials) {
      material.color.copy(getColor(look.color));
      material.roughness = look.roughness;
      material.metalness = look.metalness;
    }

    this.uniforms.uRimColor.value.copy(getColor(look.rimColor));
    this.uniforms.uRimPower.value = look.rimPower;
    this.uniforms.uRimEmissive.value = look.rimEmissive;
    this.uniforms.uEdgeColor.value.copy(getColor(look.edgeColor));
    this.uniforms.uEdgeEmissive.value = look.edgeEmissive;
    this.uniforms.uEdgeWidth.value = look.edgeWidth;
    this.uniforms.uDetail.value = look.dissolveDetail * this._scale;
    this.uniforms.uDissolve.value = this.dissolve;
  }

  /* ------------------------------------------------------------------ */
  /* life                                                                */
  /* ------------------------------------------------------------------ */

  /** Stand it up at a world XZ, facing `yaw`, whole again. */
  place(x, z, yaw) {
    this.root.position.set(x, 0, z);
    this.facing = yaw;
    this.root.rotation.y = yaw - this.forwardYaw;
    this.root.visible = true;

    this.state = 'alive';
    this.timer = 0;
    this.dissolve = 0;
    this.ragdoll = null;

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
   * @returns {boolean} false if it was already down
   */
  kill(x, z, force) {
    if (!this.alive) return false;

    this.state = 'dead';
    this.timer = 0;

    // Nothing fades: the pose the clip is on *is* the ragdoll's first frame, so
    // the skeleton is brought fully up to date — ancestors included — before it
    // is read. The solver works in world space and every rest length it
    // measures comes off these matrices.
    this.mixer.stopAllAction();
    this.root.updateWorldMatrix(true, true);

    const ragdoll = new Ragdoll(this.bones);
    if (!ragdoll.valid) {
      console.warn('[Dummy] no ragdoll could be built from this rig — the body will not fall');
      return true;
    }

    this.ragdoll = ragdoll;
    ragdoll.strike(x, z, force);
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
    // stops being scenery.
    this.ragdoll?.update(dt);
    this.timer += dt;

    if (this.state === 'dead') {
      if (this.timer < config.corpseTime) return;
      this.state = 'burning';
      this.timer = 0;
      return;
    }

    // Past 1 rather than at it: the threshold is a strict `<`, so the last
    // few texels of the body need the burn to go over the top to clear.
    this.dissolve = this.timer / Math.max(0.05, config.dissolveTime);
    if (this.dissolve < 1.05) return;

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

  dispose() {
    this.mixer.stopAllAction();
    this.action = null;
    this.ragdoll = null;
    this.bones.clear();
    // The geometry is the source rig's and is shared with every other dummy;
    // the materials are this body's own, so they are the part that must go.
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.root.parent?.remove(this.root);
  }
}
