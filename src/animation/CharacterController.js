import {
  AnimationMixer,
  Box3,
  Group,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  MeshStandardMaterial,
  SRGBColorSpace,
  Vector3
} from 'three';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { disposeObject } from '../utils/dispose.js';

const CHARACTER_URL = './models/Idle.fbx';
/** This export carries no material, so the skin ships beside it as a file. */
const CHARACTER_TEXTURE_URL = './models/diffuse.png';
/** One file per entry in `CAST_ANIMATIONS`; only their clips are kept. */
const castUrl = (name) => `./models/${name}.fbx`;
/** Mixamo exports in centimetres. */
const FBX_SCALE = 0.01;
/** Rigs vary; normalise to a believable human height so the world scale holds. */
const TARGET_HEIGHT = 1.78;

/**
 * Loads the rigged FBX, normalises it for the scene and drives its animation.
 *
 * The character never leaves the spot — it breathes on a loop, turns to face
 * where you are aiming, and throws one of the cast clips when you fire. Those
 * clips ship as separate Mixamo exports of the *same* skeleton, so only their
 * `AnimationClip` is kept: the mixer binds tracks by bone name, which is all
 * that a shared rig needs for a clip authored in another file to play here.
 *
 * Which clip an ability throws is `settings[element].castAnim` — a per-ability
 * choice, editable live, which is why `playCast` takes the name each time
 * rather than caching one.
 */
export class CharacterController {
  constructor(environment) {
    this.environment = environment;
    this.root = new Group();
    this.root.name = 'Character';

    // Position and heading live on `root`; the bank (walk mode leans into its
    // turns) lives on a joint underneath it, so the two never fight over the
    // same rotation.
    this.tilt = new Group();
    this.tilt.name = 'CharacterTilt';
    this.root.add(this.tilt);

    this.mixer = null;
    /** The looping breath, always running underneath a cast. */
    this.idle = null;
    /** name → one-shot cast action. */
    this.casts = new Map();
    /** The cast currently being thrown, null while idling. */
    this._cast = null;
    this.height = 1.8;
    this.headPosition = new Vector3(0, 1.5, 0);
    /** The rig's own forward, in model space — the axis a bank rotates about. */
    this.forwardAxis = new Vector3(0, 0, 1);

    /**
     * Yaw of the rig's own forward in model space. Bind poses are not
     * necessarily axis aligned, so `setFacing` subtracts this to make "0 faces
     * +Z" true for the caller regardless of how the FBX was authored.
     */
    this._forwardYaw = 0;
    /** 0..1 lunge envelope, decays on its own after `castLunge()`. */
    this._lunge = 0;
    this._rightAxis = new Vector3(1, 0, 0);
  }

  /**
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async load(assets) {
    // The cast files are the same character again, so they cost a parse each
    // but nothing at run time — everything but the clip is thrown away below.
    const [fbx, skin, ...castFiles] = await Promise.all([
      assets.loadFBX(CHARACTER_URL),
      assets.loadTexture(CHARACTER_TEXTURE_URL),
      ...CAST_ANIMATIONS.map((name) => assets.loadFBX(castUrl(name)))
    ]);
    // The FBX resolves before its textures do; material prep inspects them.
    await assets.settled();

    fbx.scale.setScalar(FBX_SCALE);
    fbx.updateMatrixWorld(true);

    const box = new Box3().setFromObject(fbx);
    const size = new Vector3();
    const center = new Vector3();
    box.getSize(size);

    // Normalise the rig's height, then drop it onto y = 0 and centre it.
    fbx.scale.setScalar(FBX_SCALE * (TARGET_HEIGHT / Math.max(0.001, size.y)));
    fbx.updateMatrixWorld(true);
    box.setFromObject(fbx);
    box.getSize(size);
    box.getCenter(center);
    this.height = size.y;
    fbx.position.x -= center.x;
    fbx.position.z -= center.z;
    fbx.position.y -= box.min.y;

    this._prepareMaterials(fbx, skin);
    this._measureFacing(fbx);

    this.tilt.add(fbx);
    this.model = fbx;
    this.headPosition.set(0, size.y * 0.86, 0);

    this.mixer = new AnimationMixer(fbx);
    this.mixer.addEventListener('finished', this._onCastFinished);

    // The breath ships inside the character file itself.
    const idleClip = (fbx.animations ?? [])[0];
    if (!idleClip) {
      console.warn('[CharacterController] no idle clip found in the FBX');
    } else {
      this.idle = this.mixer.clipAction(idleClip);
      this.idle.setLoop(LoopRepeat, Infinity);
      this.idle.play();
    }

    const bones = new Set();
    fbx.traverse((node) => bones.add(node.name));
    CAST_ANIMATIONS.forEach((name, index) => this._registerCast(name, castFiles[index], bones));

    return this;
  }

  /**
   * Keep one cast file's clip and release the duplicate rig that came with it.
   *
   * @param {string} name                 the id used by `settings[element].castAnim`
   * @param {import('three').Group} file  the freshly loaded FBX
   * @param {Set<string>} bones           every node name in *this* rig
   */
  _registerCast(name, file, bones) {
    const clip = (file?.animations ?? [])[0];
    if (!clip) {
      console.warn(`[CharacterController] "${name}.fbx" carries no animation`);
      return;
    }

    // A clip authored against another export of this rig binds by bone name, so
    // a mismatch shows up as a track that resolves to nothing rather than as an
    // error — say so here instead of letting the cast silently do nothing.
    if (!clip.tracks.some((track) => bones.has(track.name.split('.')[0]))) {
      console.warn(`[CharacterController] "${name}.fbx" does not match this skeleton`);
      return;
    }

    clip.name = name;
    const action = this.mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    // Hold the last frame rather than snapping home; the fade back to the idle
    // is what actually ends the cast.
    action.clampWhenFinished = true;
    this.casts.set(name, action);

    disposeObject(file);
  }

  /**
   * Convert imported materials to PBR and hook them into the shadow system.
   *
   * @param {import('three').Object3D} root
   * @param {import('three').Texture} skin the character's colour map
   */
  _prepareMaterials(root, skin) {
    const converted = new Map();

    // TextureLoader assumes linear data; this one is authored colour.
    skin.colorSpace = SRGBColorSpace;

    root.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);
      node.layers.enable(LAYER.CONTACT); // captured by the contact shadow pass

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const result = source.map((material) => {
        if (!material) return material;
        if (converted.has(material)) return converted.get(material);

        // FBX gives us Phong/Lambert; move to Standard so IBL and CSM apply.
        // This export ships no texture of its own, so the skin loaded alongside
        // it is the colour map — but a file that *does* carry one embedded still
        // wins, since that map is authored against its own UVs. Exporters
        // disagree on which slot the normal map lands in, so both are passed
        // through and the empty one costs nothing.
        //
        // The tint is dropped with the map: an untextured FBX defaults to a flat
        // grey that would otherwise darken every texel of the skin.
        const standard = new MeshStandardMaterial({
          name: material.name,
          color: material.map ? (material.color ?? 0xffffff) : 0xffffff,
          map: material.map ?? skin,
          normalMap: material.normalMap ?? null,
          bumpMap: material.normalMap ? null : (material.bumpMap ?? null),
          roughness: 0.85,
          metalness: 0,
          transparent: material.transparent ?? false,
          opacity: material.opacity ?? 1,
          side: material.side
        });

        // Worth the samples: the character is the one thing on screen the camera
        // gets close to, and its texels sit at a grazing angle across the torso.
        for (const map of [standard.map, standard.normalMap, standard.bumpMap]) {
          if (map) map.anisotropy = 4;
        }

        this.environment.registerShadowCaster(standard);
        material.dispose(); // textures are shared with the new material, not owned
        converted.set(material, standard);
        return standard;
      });

      node.material = Array.isArray(node.material) ? result : result[0];
    });
  }

  /**
   * Derive the rig's own forward from the bind pose.
   *
   * The heel → toe vector is the most reliable indicator of facing on a bind
   * pose that may not be axis aligned, and everything that turns the body reads
   * the yaw it produces.
   */
  _measureFacing(root) {
    root.updateMatrixWorld(true);

    let foot = null;
    let toe = null;
    root.traverse((node) => {
      if (!node.isBone) return;
      // Exporters disagree on the namespace: "mixamorig:LeftFoot", "mixamorigLeftFoot".
      const short = node.name.split(':').pop().replace(/^mixamorig/i, '');
      if (short === 'LeftFoot' && !foot) foot = node;
      else if (short === 'LeftToeBase' && !toe) toe = node;
    });

    if (foot && toe) {
      const heel = foot.getWorldPosition(new Vector3());
      const tip = toe.getWorldPosition(new Vector3()).sub(heel).setY(0);
      if (tip.lengthSq() > 1e-6) this.forwardAxis.copy(tip).normalize();
    }

    this._forwardYaw = Math.atan2(this.forwardAxis.x, this.forwardAxis.z);
    this._rightAxis.set(0, 1, 0).cross(this.forwardAxis).normalize();
  }

  /* ------------------------------------------------------------------ */
  /* cast clips                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Throw one cast clip over the idle, once.
   *
   * @param {string} [name] an id from `CAST_ANIMATIONS`; falls back to the first
   *   one so an ability configured with a clip that failed to load still moves.
   */
  playCast(name) {
    const next = this.casts.get(name) ?? this.casts.get(CAST_ANIMATIONS[0]);
    if (!next || !this.idle) return;

    const previous = this._cast;
    this._cast = next;

    next.reset();
    next.setEffectiveTimeScale(1);
    next.play();

    // Fade from whatever is actually on screen — the idle on a first cast, the
    // clip still finishing on a re-cast — so the body never drops to the bind
    // pose for a frame in between two throws. Re-throwing the *same* clip only
    // restarts it: `reset()` has already left it at full weight.
    const from = previous ?? this.idle;
    if (from !== next) next.crossFadeFrom(from, settings.character.castBlendIn, false);
  }

  /** True while a cast clip is playing. */
  get isCasting() {
    return this._cast !== null;
  }

  _onCastFinished = (event) => {
    // Anything else finishing is an older clip that a re-cast already faded out.
    if (event.action !== this._cast) return;
    this._cast = null;

    // The fade in disabled the idle once its weight hit zero; wake it back up
    // before asking it to come in again.
    this.idle.enabled = true;
    this.idle.setEffectiveTimeScale(1);
    this.idle.crossFadeFrom(event.action, settings.character.castBlendOut, false);
  };

  /* ------------------------------------------------------------------ */
  /* placement — driven by walk mode, inert otherwise                    */
  /* ------------------------------------------------------------------ */

  /** Heading, radians about world +Y. 0 faces +Z, whichever way the rig binds. */
  setFacing(yaw) {
    this.root.rotation.y = yaw - this._forwardYaw;
  }

  get facing() {
    return this.root.rotation.y + this._forwardYaw;
  }

  /**
   * Turn toward `yaw` over time rather than snapping.
   * @param {number} rate fraction of the angle gap left after one second
   */
  turnToward(yaw, rate, dt) {
    const current = this.facing;
    // Shortest way round, so aiming across the -Z seam does not spin the body.
    const delta = MathUtils.euclideanModulo(yaw - current + Math.PI, Math.PI * 2) - Math.PI;
    this.setFacing(current + delta * (1 - Math.pow(MathUtils.clamp(rate, 1e-6, 1), dt)));
  }

  /**
   * Punch the body forward, then let it settle.
   *
   * An accent laid over the cast clip rather than a substitute for it: a pitch
   * about the body's own right axis plus a shove back along its forward axis,
   * both riding on one decaying envelope. Applied to `tilt` rather than `root`
   * so it composes with the heading instead of fighting it, and turned off by
   * dropping `castLean` and `castRecoil` to zero when the clip says it all.
   */
  castLunge() {
    this._lunge = 1;
  }

  _applyLunge(dt) {
    const c = settings.character;
    if (this._lunge > 0) {
      this._lunge = Math.max(0, this._lunge - c.castSettle * dt);
    }
    // A short overshoot at the front of the envelope reads as a snap rather than
    // a slow bow.
    const envelope = this._lunge * this._lunge * (1 + 0.35 * Math.sin(this._lunge * Math.PI));
    this.tilt.quaternion.setFromAxisAngle(this._rightAxis, envelope * c.castLean);
    this.tilt.position.copy(this.forwardAxis).multiplyScalar(-envelope * c.castRecoil);
  }

  /** Put the character back on the floor, upright and facing where it was. */
  resetPlacement() {
    this.root.position.y = 0;
    this._lunge = 0;
    this.tilt.quaternion.identity();
    this.tilt.position.set(0, 0, 0);
  }

  update(dt) {
    // Driven by the *simulation* delta, and re-applied every frame even at
    // dt = 0: pausing mid-cast holds the lunge, and `castLean` stays a live
    // slider against that frozen pose.
    this._applyLunge(dt);

    if (!this.mixer) return;

    this.mixer.timeScale = settings.global.animationSpeed;
    this.mixer.update(dt);
  }

  get position() {
    return this.root.position;
  }

  dispose() {
    this.mixer?.removeEventListener('finished', this._onCastFinished);
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.idle = null;
    this.casts.clear();
    this._cast = null;
    disposeObject(this.root);
  }
}
