import { Matrix4, Quaternion, Vector3 } from 'three';
import { settings } from '../config/settings.js';

/**
 * A ragdoll, in about as few moving parts as one can be built from.
 *
 * ## The idea
 *
 * There is no physics engine in this project and this does not add one. A
 * ragdoll does not actually need rigid bodies and joint motors: what the eye
 * reads as a body falling is *bone lengths that never change* and *limbs that
 * cannot bend the wrong way*, under gravity, with the floor in the way. All
 * three of those are distance constraints, and distance constraints are the one
 * thing position-based dynamics does in four lines.
 *
 * So the skeleton is turned into a particle per joint, the bones become
 * constraints between them, and the whole thing is relaxed a few times per
 * substep (`iterations`). The solve is PBD rather than plain Verlet — predict,
 * project, then read the velocity back out of the correction — because that
 * form takes a paused clock and a `timeScale` of 0.1 without exploding, and
 * this sandbox has both.
 *
 * ## Three things make it read as a body rather than as a rope
 *
 *  - **Mass.** The pelvis and the chest are heavy, the hands and feet light
 *    (`WEIGHTS`, held as inverse mass). Constraint corrections split between
 *    two particles in that ratio, so an arm whips off a torso that barely
 *    notices — which is the whole difference between a corpse and a noodle.
 *  - **Bracing.** Bone-length constraints alone leave a chain that folds flat.
 *    A handful of extra ones across the pelvis, the chest and the spine
 *    (`BRACES`) make those parts near-rigid, so the body has a *shape* it is
 *    trying to keep while everything else flails.
 *  - **Limits.** A knee that bends both ways is the single most recognisable
 *    tell of a bad ragdoll. `LIMITS` puts a floor and a ceiling on the distance
 *    from hip to ankle (and shoulder to hand), which is a cheap stand-in for a
 *    hinge: it cannot hyperextend, and it cannot fold flat.
 *
 * ## Getting it back onto the skeleton
 *
 * Particles are points; bones need rotations. Every bone is turned to *aim* at
 * its child's particle: one `setFromUnitVectors` from where the bone currently
 * points to where the particle says it should, applied in world space and
 * converted back to a local rotation. That leaves the twist about the bone's
 * own axis untouched, which is exactly right — the twist is whatever the pose
 * had at the moment of the hit, and nothing in a fall changes it.
 *
 * The pelvis and the chest get a stronger treatment: they have two independent
 * directions available (up the spine, and across the hips or the shoulders), so
 * their full 3-DOF orientation is rebuilt from that frame instead. Without it a
 * body face-down and a body face-up are the same aim vector, and the corpse
 * lands on its side every time.
 */

/* -------------------------------------------------------------------- */
/* the rig                                                              */
/* -------------------------------------------------------------------- */

/** Joint, its parent, and the child it points at. Mixamo's 25-bone skeleton. */
const JOINTS = [
  ['Hips', null, 'Spine'],
  ['Spine', 'Hips', 'Spine1'],
  ['Spine1', 'Spine', 'Spine2'],
  ['Spine2', 'Spine1', 'Neck'],
  ['Neck', 'Spine2', 'Head'],
  ['Head', 'Neck', 'HeadTop_End'],
  ['HeadTop_End', 'Head', null],

  ['LeftShoulder', 'Spine2', 'LeftArm'],
  ['LeftArm', 'LeftShoulder', 'LeftForeArm'],
  ['LeftForeArm', 'LeftArm', 'LeftHand'],
  ['LeftHand', 'LeftForeArm', null],
  ['RightShoulder', 'Spine2', 'RightArm'],
  ['RightArm', 'RightShoulder', 'RightForeArm'],
  ['RightForeArm', 'RightArm', 'RightHand'],
  ['RightHand', 'RightForeArm', null],

  ['LeftUpLeg', 'Hips', 'LeftLeg'],
  ['LeftLeg', 'LeftUpLeg', 'LeftFoot'],
  ['LeftFoot', 'LeftLeg', 'LeftToeBase'],
  ['LeftToeBase', 'LeftFoot', 'LeftToe_End'],
  ['LeftToe_End', 'LeftToeBase', null],
  ['RightUpLeg', 'Hips', 'RightLeg'],
  ['RightLeg', 'RightUpLeg', 'RightFoot'],
  ['RightFoot', 'RightLeg', 'RightToeBase'],
  ['RightToeBase', 'RightFoot', 'RightToe_End'],
  ['RightToe_End', 'RightToeBase', null]
];

/**
 * Inverse mass. Low = heavy: the pelvis is the anchor the rest hangs off, and
 * the extremities are the parts that get thrown around.
 */
const WEIGHTS = {
  Hips: 0.35,
  Spine: 0.45,
  Spine1: 0.5,
  Spine2: 0.5,
  Neck: 0.8,
  Head: 0.7,
  HeadTop_End: 0.9,
  LeftShoulder: 0.7,
  RightShoulder: 0.7,
  LeftUpLeg: 0.6,
  RightUpLeg: 0.6,
  LeftLeg: 0.9,
  RightLeg: 0.9
};
const DEFAULT_WEIGHT = 1.35;

/**
 * How big a joint is, as a multiplier on `settings.slice.collide.radius`.
 *
 * Only consulted for the handful of joints a *cut* body is solid with — see
 * `collideRagdolls`. A pelvis is a chunk and a wrist is not, and a torso that
 * lands on a pair of legs has to come to rest on the thighs rather than sink
 * into them until the ankles catch it.
 */
const SIZES = {
  Hips: 1.4,
  Spine: 1.4,
  Spine1: 1.4,
  Spine2: 1.4,
  Neck: 0.8,
  Head: 1.35,
  HeadTop_End: 1,
  LeftShoulder: 1,
  RightShoulder: 1,
  LeftUpLeg: 1.25,
  RightUpLeg: 1.25,
  LeftLeg: 1,
  RightLeg: 1,
  LeftFoot: 0.85,
  RightFoot: 0.85,
  LeftToeBase: 0.6,
  RightToeBase: 0.6,
  LeftToe_End: 0.55,
  RightToe_End: 0.55,
  LeftArm: 0.9,
  RightArm: 0.9,
  LeftForeArm: 0.75,
  RightForeArm: 0.75,
  LeftHand: 0.65,
  RightHand: 0.65
};
const DEFAULT_SIZE = 1;

/** Extra constraints that give the torso and the pelvis a shape to keep. */
const BRACES = [
  ['Hips', 'Spine1'],
  ['Spine', 'Spine2'],
  ['Spine1', 'Neck'],
  ['Spine2', 'Head'],
  ['LeftUpLeg', 'RightUpLeg'],
  ['LeftUpLeg', 'Spine'],
  ['RightUpLeg', 'Spine'],
  ['LeftShoulder', 'RightShoulder'],
  ['LeftShoulder', 'Spine1'],
  ['RightShoulder', 'Spine1'],
  ['LeftArm', 'RightArm'],
  ['LeftArm', 'Spine1'],
  ['RightArm', 'Spine1']
];

/**
 * Joint limits, as a distance range across two bones: [root, hinge, tip, how
 * far it may fold]. The ceiling is just short of straight, which is what stops
 * a knee snapping through backwards on the frame the foot catches the ground.
 */
const LIMITS = [
  ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 0.42],
  ['RightUpLeg', 'RightLeg', 'RightFoot', 0.42],
  ['LeftArm', 'LeftForeArm', 'LeftHand', 0.38],
  ['RightArm', 'RightForeArm', 'RightHand', 0.38],
  ['Spine', 'Spine1', 'Spine2', 0.82],
  ['Hips', 'Spine', 'Spine1', 0.85]
];
const STRAIGHT = 0.995;

/** Joints whose full orientation is rebuilt from a frame: [up child, left, right]. */
const FRAMES = {
  Hips: ['Spine', 'LeftUpLeg', 'RightUpLeg'],
  Spine2: ['Neck', 'LeftShoulder', 'RightShoulder']
};

/** Fixed simulation step. Short enough that the constraints stay stiff. */
const STEP = 1 / 120;
/** Ceiling on steps per frame, so a stalled tab does not run a minute of physics. */
const MAX_STEPS = 5;

/* -------------------------------------------------------------------- */

const _v = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _fwd = new Vector3();
const _dir = new Vector3();
const _cur = new Vector3();
const _q = new Quaternion();
const _qa = new Quaternion();
const _delta = new Quaternion();
const _basis = new Matrix4();

export class Ragdoll {
  /**
   * Takes the skeleton exactly as it is posed *now* — the pose the idle was on
   * when the ability landed is the ragdoll's first frame, which is what makes
   * the handover invisible.
   *
   * @param {Map<string, import('three').Bone>} bones name → bone, both raw and
   *   namespace-stripped (see `Dummy#_indexBones`)
   * @param {object} [world]
   * @param {number} [world.groundY] the floor this body lands on. The sandbox
   *   floor is dead flat at y = 0, which is what every ability assumes too.
   * @param {Set<string>|null} [world.include] the joints to simulate, if not
   *   all of them. This is how a body cut in half becomes *two* solvers: each
   *   half is handed the joints it actually owns, and a chain outside the set
   *   simply has no particle. Leave the legs in the torso's solver and they
   *   land on the floor holding an invisible pelvis a metre in the air, with
   *   the visible half of the body hanging off it.
   * @param {Set<string>|null} [world.collide] the joints that are *solid* to
   *   another body — see `collideRagdolls`. A strict subset of `include`: the
   *   joints either side of a cut are simulated by both halves and start on
   *   top of each other, so making those solid would shove the two halves
   *   across the field before the cut had finished happening.
   */
  constructor(bones, { groundY = 0, include = null, collide = null } = {}) {
    this.floor = groundY;
    this._include = include;
    this._collide = collide;
    this.asleep = false;
    this._still = 0;
    this._accumulator = 0;

    /** name → index into the particle arrays. */
    this.index = new Map();
    /** Per-joint solver state. Flat arrays: this runs every frame for every corpse. */
    this.px = [];
    this.py = [];
    this.pz = [];
    this.vx = [];
    this.vy = [];
    this.vz = [];
    this.w = [];
    this.grounded = [];
    /** Where each joint was before the step — the velocity is read back off it. */
    this.prevX = [];
    this.prevY = [];
    this.prevZ = [];

    /** Bone write-back state, parents before children. */
    this.entries = [];
    this.constraints = [];
    this.limits = [];
    /** Indices of the joints another body can land on, and their sizes. */
    this.contacts = [];
    this.contactSize = [];

    this.hips = null;
    this._hipsParentInverse = new Matrix4();
    this._hipsParentQuat = new Quaternion();

    this._build(bones);
  }

  get valid() {
    return this.entries.length > 0 && this.hips !== null;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  _build(bones) {
    const world = new Map();

    for (const [name, parentName, aimName] of JOINTS) {
      const bone = bones.get(name);
      if (!bone) continue; // a rig without this joint simply has no particle here
      if (this._include && !this._include.has(name)) continue; // the other half owns it

      const position = bone.getWorldPosition(new Vector3());
      const index = this.px.length;

      this.index.set(name, index);
      this.px.push(position.x);
      this.py.push(position.y);
      this.pz.push(position.z);
      this.vx.push(0);
      this.vy.push(0);
      this.vz.push(0);
      this.w.push(WEIGHTS[name] ?? DEFAULT_WEIGHT);
      this.grounded.push(false);
      this.prevX.push(position.x);
      this.prevY.push(position.y);
      this.prevZ.push(position.z);
      world.set(name, position);

      this.entries.push({
        name,
        bone,
        index,
        parentName,
        aimName,
        /** The bone's world rotation at the moment of the hit — the reference pose. */
        rest: bone.getWorldQuaternion(new Quaternion()),
        /** Where the aim child sits, in this bone's own frame. Constant. */
        aimLocal: new Vector3(),
        /** This bone's world rotation as of the last solve. */
        worldQuat: new Quaternion(),
        /** Particle the bone aims at, once the second pass has matched it up. */
        aimIndex: undefined,
        /** Resolved in the second pass below. */
        parent: null,
        staticParentQuat: null,
        frame: null
      });
    }

    if (!this.entries.length) return;

    const byName = new Map(this.entries.map((entry) => [entry.name, entry]));
    this.hips = byName.get('Hips') ?? this.entries[0];

    // Whatever the hips hang off does not move again, so its transform is taken
    // once here and every later frame is expressed against it.
    const hipsParent = this.hips.bone.parent;
    if (hipsParent) {
      hipsParent.updateWorldMatrix(true, false);
      this._hipsParentInverse.copy(hipsParent.matrixWorld).invert();
      hipsParent.getWorldQuaternion(this._hipsParentQuat);
    }

    for (const entry of this.entries) {
      entry.worldQuat.copy(entry.rest);

      // The aim direction is measured in world and pulled back into the bone's
      // frame, rather than read off the child's local translation — that way an
      // export with an extra node between two joints still resolves.
      const aim = entry.aimName ? world.get(entry.aimName) : null;
      if (aim) {
        _v.copy(aim).sub(world.get(entry.name));
        if (_v.lengthSq() > 1e-10) {
          entry.aimLocal.copy(_v).applyQuaternion(_qa.copy(entry.rest).invert()).normalize();
          entry.aimIndex = this.index.get(entry.aimName);
        } else {
          entry.aimIndex = undefined;
        }
      }

      // Where this bone's local rotation is measured from. A parent outside the
      // table (or missing) is frozen at its pose on impact, which is correct:
      // only simulated joints move.
      const parentEntry = entry.bone.parent
        ? byName.get(stripNamespace(entry.bone.parent.name))
        : null;
      if (parentEntry && parentEntry !== entry) {
        entry.parent = parentEntry;
      } else {
        entry.staticParentQuat = entry.bone.parent
          ? entry.bone.parent.getWorldQuaternion(new Quaternion())
          : new Quaternion();
      }

      // The pelvis and the chest carry a frame rather than an aim.
      const frame = FRAMES[entry.name];
      if (frame && frame.every((name) => this.index.has(name))) {
        entry.frame = {
          up: this.index.get(frame[0]),
          left: this.index.get(frame[1]),
          right: this.index.get(frame[2]),
          restInverse: new Quaternion()
        };
        // A rig whose hips and legs are stacked in a line has no second axis to
        // build a frame from; it falls back to the plain aim like everything else.
        if (this._buildFrame(_q, entry, entry.frame)) entry.frame.restInverse.copy(_q).invert();
        else entry.frame = null;
      }
    }

    /* ---- constraints ---- */
    for (const entry of this.entries) {
      if (!entry.parentName) continue;
      const parent = this.index.get(entry.parentName);
      if (parent === undefined) continue;
      this._addConstraint(parent, entry.index, false);
    }
    for (const [a, b] of BRACES) {
      const ia = this.index.get(a);
      const ib = this.index.get(b);
      if (ia !== undefined && ib !== undefined) this._addConstraint(ia, ib, true);
    }

    for (const [root, hinge, tip, fold] of LIMITS) {
      const ia = this.index.get(root);
      const im = this.index.get(hinge);
      const ib = this.index.get(tip);
      if (ia === undefined || im === undefined || ib === undefined) continue;
      const span = this._distance(ia, im) + this._distance(im, ib);
      this.limits.push({ a: ia, b: ib, min: span * fold, max: span * STRAIGHT });
    }

    /* ---- the handful of spheres another body can land on ---- */
    if (this._collide) {
      for (const [name, index] of this.index) {
        if (!this._collide.has(name)) continue;
        this.contacts.push(index);
        this.contactSize.push(SIZES[name] ?? DEFAULT_SIZE);
      }
    }

    /* ---- how tall it was, for weighting the blow it is about to take ---- */
    let min = Infinity;
    let max = -Infinity;
    for (const y of this.py) {
      if (y < min) min = y;
      if (y > max) max = y;
    }
    this.height = Math.max(0.5, max - min);
  }

  /** @param {boolean} brace true for the shape-keeping extras, which pull softer. */
  _addConstraint(a, b, brace) {
    this.constraints.push({ a, b, rest: this._distance(a, b), brace });
  }

  _distance(a, b) {
    return Math.hypot(this.px[a] - this.px[b], this.py[a] - this.py[b], this.pz[a] - this.pz[b]);
  }

  /**
   * An orthonormal frame from two of the body's own directions.
   *
   * Up the spine is the reliable one; the hips (or shoulders) supply the second
   * axis, and the third is their cross product. Gram-Schmidt rather than a
   * straight `makeBasis`, because the two inputs are never quite square to each
   * other on a body mid-fall.
   *
   * @returns {boolean} false if the two axes have collapsed onto each other, in
   *   which case there is no frame to be had and the caller keeps what it has.
   */
  _buildFrame(out, entry, frame) {
    _up.set(
      this.px[frame.up] - this.px[entry.index],
      this.py[frame.up] - this.py[entry.index],
      this.pz[frame.up] - this.pz[entry.index]
    );
    _right.set(
      this.px[frame.right] - this.px[frame.left],
      this.py[frame.right] - this.py[frame.left],
      this.pz[frame.right] - this.pz[frame.left]
    );

    if (_up.lengthSq() < 1e-10 || _right.lengthSq() < 1e-10) return false;
    _up.normalize();
    _fwd.crossVectors(_right, _up);
    if (_fwd.lengthSq() < 1e-10) return false;
    _fwd.normalize();
    _right.crossVectors(_up, _fwd).normalize();

    _basis.makeBasis(_right, _up, _fwd);
    out.setFromRotationMatrix(_basis);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* the blow                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Throw the body.
   *
   * The impulse is scaled by how far above the hips each joint sits, so the
   * shoulders leave faster than the feet and the body rotates around the
   * impact. That single line is what turns "the corpse slid backwards" into
   * "the corpse folded over the blast" — there is no torque in this solver, and
   * this is how you get one anyway.
   *
   * @param {number} x horizontal direction of the blow, unit
   * @param {number} z
   * @param {{impulse: number, lift: number, spin: number}} config
   */
  strike(x, z, config) {
    const hipsY = this.py[this.hips.index];
    const span = this.height;

    for (let i = 0; i < this.px.length; i++) {
      const above = (this.py[i] - hipsY) / span;
      const k = Math.max(0.15, 1 + config.spin * above);
      // A little scatter, or every joint leaves on exactly the same vector and
      // the body reads as one rigid plank for the first few frames.
      const jitter = 0.85 + Math.random() * 0.3;

      this.vx[i] = x * config.impulse * k * jitter;
      this.vz[i] = z * config.impulse * k * jitter;
      this.vy[i] = config.lift * (0.55 + Math.max(0, above)) * jitter;
    }

    this.asleep = false;
    this._still = 0;
  }

  /** Add a velocity to every joint, evenly — a shove that does not turn the body. */
  shove(x, y, z) {
    for (let i = 0; i < this.px.length; i++) {
      this.vx[i] += x;
      this.vy[i] += y;
      this.vz[i] += z;
    }
    this.asleep = false;
    this._still = 0;
  }

  /**
   * Write the current particle cloud back onto the skeleton.
   *
   * `update` already does this at the end of a step. This is for the one case
   * that happens *after* it: two halves of a cut body are solved
   * independently and only then pushed out of each other
   * (`collideRagdolls`), so whoever owns both has to ask for the pose again.
   */
  repose() {
    if (this.valid) this._pose();
  }

  /**
   * Move the whole body without giving it any velocity for having moved.
   *
   * Both halves of a cut body start on exactly the same particles, and two
   * bodies occupying one space push apart over several frames of solving
   * rather than parting on the frame the edge went through. This opens the gap
   * by hand, on that one frame, and lets the impulses do the rest.
   */
  displace(x, y, z) {
    for (let i = 0; i < this.px.length; i++) {
      this.px[i] += x;
      this.py[i] += y;
      this.pz[i] += z;
      this.prevX[i] += x;
      this.prevY[i] += y;
      this.prevZ[i] += z;
    }
    this.asleep = false;
    this._still = 0;
  }

  /**
   * Where the body actually is right now — the hips, in world space.
   *
   * `Dummy#position` is the root the body was *placed* at, and the solver never
   * touches it: a corpse thrown four metres by a blast still reports the spot it
   * was standing on. Anything that has to keep acting on a body while it falls —
   * a current dragging it, a surface it is sinking through — has to ask the
   * particles, and this is that question.
   *
   * @param {import('three').Vector3} out written in place, so polling every
   *   frame allocates nothing
   * @returns {import('three').Vector3|null} null if there is no body to find
   */
  centre(out) {
    if (!this.valid) return null;
    const i = this.hips.index;
    return out.set(this.px[i], this.py[i], this.pz[i]);
  }

  /**
   * How fast the body is travelling — the hips, metres per second.
   *
   * The companion to `centre`, and it exists for one reason: anything that
   * wants to *carry* a body rather than hit it has to know how fast it is
   * already going. Pushing a fixed acceleration in every frame instead is
   * unstable here, because this solver consumes a bounded number of substeps
   * per frame — on a slow frame the velocity keeps accumulating while the
   * positions cannot follow, and the body eventually leaves the map.
   *
   * @param {import('three').Vector3} out written in place
   * @returns {import('three').Vector3|null}
   */
  velocity(out) {
    if (!this.valid) return null;
    const i = this.hips.index;
    return out.set(this.vx[i], this.vy[i], this.vz[i]);
  }

  /* ------------------------------------------------------------------ */
  /* simulation                                                          */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (!this.valid || this.asleep || dt <= 0) return;

    const config = settings.dummies.ragdoll;

    this._accumulator += dt;
    let steps = 0;
    while (this._accumulator >= STEP && steps < MAX_STEPS) {
      this._accumulator -= STEP;
      steps++;
      this._step(STEP, config);
    }
    if (steps === 0) return;

    // Cheap enough to run every frame, and the body settling into the floor
    // over the last few centimetres is worth seeing.
    if (this._sleepy(dt, config)) return;
    this._pose();
  }

  _step(h, config) {
    const count = this.px.length;
    const gravity = config.gravity;
    // Air, as a fraction of the velocity lost per second — expressed that way so
    // the number means the same thing whatever the step is.
    const drag = Math.pow(Math.max(0, 1 - config.damping), h);
    const radius = config.radius;
    const iterations = Math.max(1, Math.round(config.iterations));

    // Predict.
    for (let i = 0; i < count; i++) {
      this.vy[i] += gravity * h;
      this.vx[i] *= drag;
      this.vy[i] *= drag;
      this.vz[i] *= drag;

      this.prevX[i] = this.px[i];
      this.prevY[i] = this.py[i];
      this.prevZ[i] = this.pz[i];

      this.px[i] += this.vx[i] * h;
      this.py[i] += this.vy[i] * h;
      this.pz[i] += this.vz[i] * h;
      this.grounded[i] = false;
    }

    // Project. Bones first, then the braces they hang off, then the limits —
    // and the floor last in every pass, so nothing ends the iteration inside it.
    for (let iteration = 0; iteration < iterations; iteration++) {
      this._solveConstraints(config);
      this._solveLimits();
      this._solveGround(radius);
    }

    // Read the velocity back out of where the solver actually put everything.
    // This is what makes the constraints *lose* energy instead of storing it,
    // and it is the whole reason a body this stiff does not vibrate.
    const inverse = 1 / h;
    for (let i = 0; i < count; i++) {
      this.vx[i] = (this.px[i] - this.prevX[i]) * inverse;
      this.vy[i] = (this.py[i] - this.prevY[i]) * inverse;
      this.vz[i] = (this.pz[i] - this.prevZ[i]) * inverse;

      if (!this.grounded[i]) continue;
      // On the floor: scrub the slide off, and let the limb slap rather than
      // stop dead.
      const friction = Math.max(0, 1 - config.friction);
      this.vx[i] *= friction;
      this.vz[i] *= friction;
      if (this.vy[i] < 0) this.vy[i] = -this.vy[i] * config.bounce;
    }
  }

  _solveConstraints(config) {
    for (const constraint of this.constraints) {
      const { a, b, rest } = constraint;
      // Bones are inextensible; the braces are a preference the fall may bend.
      const stiffness = constraint.brace ? config.brace : 1;

      let dx = this.px[b] - this.px[a];
      let dy = this.py[b] - this.py[a];
      let dz = this.pz[b] - this.pz[a];
      const length = Math.hypot(dx, dy, dz);
      if (length < 1e-6) continue;

      const wa = this.w[a];
      const wb = this.w[b];
      const total = wa + wb;
      if (total < 1e-6) continue;

      const correction = ((length - rest) / length) * stiffness;
      dx *= correction;
      dy *= correction;
      dz *= correction;

      const ka = wa / total;
      const kb = wb / total;
      this.px[a] += dx * ka;
      this.py[a] += dy * ka;
      this.pz[a] += dz * ka;
      this.px[b] -= dx * kb;
      this.py[b] -= dy * kb;
      this.pz[b] -= dz * kb;
    }
  }

  /** The hinge stand-in: neither folded flat nor snapped through backwards. */
  _solveLimits() {
    for (const { a, b, min, max } of this.limits) {
      let dx = this.px[b] - this.px[a];
      let dy = this.py[b] - this.py[a];
      let dz = this.pz[b] - this.pz[a];
      const length = Math.hypot(dx, dy, dz);
      if (length < 1e-6) continue;

      const target = length < min ? min : length > max ? max : 0;
      if (target === 0) continue;

      const wa = this.w[a];
      const wb = this.w[b];
      const total = wa + wb;
      if (total < 1e-6) continue;

      const correction = (length - target) / length;
      dx *= correction;
      dy *= correction;
      dz *= correction;

      const ka = wa / total;
      const kb = wb / total;
      this.px[a] += dx * ka;
      this.py[a] += dy * ka;
      this.pz[a] += dz * ka;
      this.px[b] -= dx * kb;
      this.py[b] -= dy * kb;
      this.pz[b] -= dz * kb;
    }
  }

  _solveGround(radius) {
    const floor = this.floor + radius;
    for (let i = 0; i < this.px.length; i++) {
      if (this.py[i] >= floor) continue;
      this.py[i] = floor;
      this.grounded[i] = true;
    }
  }

  /**
   * Whether the body has finished falling.
   *
   * A settled corpse is still a few hundred constraint solves a frame, and
   * there can be half a dozen of them on the floor at once. Once nothing is
   * moving faster than a few centimetres a second for a third of a second, the
   * whole thing stops — permanently, because nothing is going to disturb it.
   */
  _sleepy(dt, config) {
    let fastest = 0;
    for (let i = 0; i < this.vx.length; i++) {
      const speed = Math.abs(this.vx[i]) + Math.abs(this.vy[i]) + Math.abs(this.vz[i]);
      if (speed > fastest) fastest = speed;
    }

    if (fastest > config.sleep) {
      this._still = 0;
      return false;
    }

    this._still += dt;
    if (this._still < 0.35) return false;

    this._pose(); // one last write, so it sleeps in the pose it settled into
    this.asleep = true;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* back onto the skeleton                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Turn the cloud of points back into a pose.
   *
   * Parents before children, because each bone's local rotation is measured
   * against the world rotation its parent has just been given.
   */
  _pose() {
    const hips = this.hips;

    // The one bone that is placed rather than aimed. Everything else inherits
    // its position from the chain above it.
    _v.set(this.px[hips.index], this.py[hips.index], this.pz[hips.index]);
    hips.bone.position.copy(_v.applyMatrix4(this._hipsParentInverse));

    for (const entry of this.entries) {
      const parentQuat = entry.parent
        ? entry.parent.worldQuat
        : (entry.staticParentQuat ?? this._hipsParentQuat);

      // Where the bone points right now, from the rotation it is carrying.
      _q.copy(parentQuat).multiply(entry.bone.quaternion);

      if (entry.frame) {
        // Pelvis and chest: rebuild the whole orientation from the body's own
        // two axes, then carry the pose it was struck in through it.
        if (this._buildFrame(_qa, entry, entry.frame)) {
          _q.copy(_qa).multiply(entry.frame.restInverse).multiply(entry.rest);
        }
      } else if (entry.aimIndex !== undefined) {
        _dir.set(
          this.px[entry.aimIndex] - this.px[entry.index],
          this.py[entry.aimIndex] - this.py[entry.index],
          this.pz[entry.aimIndex] - this.pz[entry.index]
        );
        if (_dir.lengthSq() > 1e-10) {
          _dir.normalize();
          _cur.copy(entry.aimLocal).applyQuaternion(_q).normalize();
          _delta.setFromUnitVectors(_cur, _dir);
          _q.premultiply(_delta);
        }
      }

      entry.worldQuat.copy(_q);
      entry.bone.quaternion.copy(_qa.copy(parentQuat).invert().multiply(_q));
    }
  }
}

/** `mixamorig:LeftArm` and `mixamorigLeftArm` are both `LeftArm`. */
export function stripNamespace(name) {
  return String(name).split(':').pop().replace(/^mixamorig/i, '');
}

/* -------------------------------------------------------------------- */
/* two bodies at once                                                    */
/* -------------------------------------------------------------------- */

/**
 * Make the two halves of a cut body solid to each other.
 *
 * Each half is its own solver and neither knows the other exists, so without
 * this the torso falls *through* the legs it was cut off and the whole thing
 * reads as two sprites rather than as one body coming apart. A dozen spheres
 * against a dozen, once a frame, for the second or two a corpse is still
 * moving.
 *
 * Positions first: the overlap is opened along the line between the pair, split
 * by inverse mass so a head bounces off a thigh instead of shoving it aside,
 * and clamped per frame (`maxPush`) so a pair that starts badly overlapped
 * separates over several frames rather than being fired apart on one. Then the
 * velocities: the approaching part of the relative velocity is reversed
 * (`bounce`) and the sliding part is scrubbed (`friction`), which is what turns
 * a pass-through into a landing.
 *
 * A body that has gone to sleep is treated as furniture — infinite mass, never
 * woken — so a torso coming to rest on a settled pair of legs settles too,
 * rather than the two of them nudging each other awake for ever.
 *
 * @param {Ragdoll|null} a
 * @param {Ragdoll|null} b
 * @returns {boolean} whether anything actually touched, so the caller can skip
 *   re-posing two skeletons on the frames nothing did
 */
export function collideRagdolls(a, b) {
  if (!a?.valid || !b?.valid) return false;
  if (!a.contacts.length || !b.contacts.length) return false;
  // Both settled: nothing is moving, so nothing can newly overlap, and pushing
  // on a resting pair is how a corpse ends up twitching for ever.
  if (a.asleep && b.asleep) return false;

  const config = settings.slice.collide;
  if (!config.enabled) return false;
  const base = Math.max(0, config.radius);
  if (base <= 0) return false;

  const maxPush = Math.max(0, config.maxPush);
  const bounce = Math.max(0, config.bounce);
  const friction = Math.min(1, Math.max(0, config.friction));
  let touched = false;

  for (let ai = 0; ai < a.contacts.length; ai++) {
    const i = a.contacts[ai];
    const wa = a.asleep ? 0 : a.w[i];
    const ra = base * a.contactSize[ai];

    for (let bi = 0; bi < b.contacts.length; bi++) {
      const j = b.contacts[bi];
      const wb = b.asleep ? 0 : b.w[j];
      const total = wa + wb;
      if (total < 1e-6) continue; // two sleepers, or two anchors: nothing to move

      const reach = ra + base * b.contactSize[bi];
      let nx = b.px[j] - a.px[i];
      let ny = b.py[j] - a.py[i];
      let nz = b.pz[j] - a.pz[i];
      const squared = nx * nx + ny * ny + nz * nz;
      if (squared >= reach * reach) continue;

      const distance = Math.sqrt(squared);
      if (distance < 1e-6) {
        // Dead centre, which is where the joints either side of the cut start.
        // Up is the axis the halves were parted along, so it is the one to pick
        // when the geometry has no opinion.
        nx = 0;
        ny = 1;
        nz = 0;
      } else {
        const inverse = 1 / distance;
        nx *= inverse;
        ny *= inverse;
        nz *= inverse;
      }

      touched = true;

      /* ---- position: open the overlap, but never all at once ---- */
      const push = Math.min(reach - distance, maxPush);
      const ka = (wa / total) * push;
      const kb = (wb / total) * push;
      a.px[i] -= nx * ka;
      a.py[i] -= ny * ka;
      a.pz[i] -= nz * ka;
      b.px[j] += nx * kb;
      b.py[j] += ny * kb;
      b.pz[j] += nz * kb;

      /* ---- velocity: land on it rather than sink into it ---- */
      let rvx = b.vx[j] - a.vx[i];
      let rvy = b.vy[j] - a.vy[i];
      let rvz = b.vz[j] - a.vz[i];
      const normal = rvx * nx + rvy * ny + rvz * nz;
      if (normal >= 0) continue;

      const impulse = (-(1 + bounce) * normal) / total;
      a.vx[i] -= nx * impulse * wa;
      a.vy[i] -= ny * impulse * wa;
      a.vz[i] -= nz * impulse * wa;
      b.vx[j] += nx * impulse * wb;
      b.vy[j] += ny * impulse * wb;
      b.vz[j] += nz * impulse * wb;

      // Whatever of the closing speed was sideways: scrubbed, so a torso
      // dropped on a hip stays on it instead of skating off.
      rvx -= nx * normal;
      rvy -= ny * normal;
      rvz -= nz * normal;
      const slide = friction / total;
      a.vx[i] += rvx * slide * wa;
      a.vy[i] += rvy * slide * wa;
      a.vz[i] += rvz * slide * wa;
      b.vx[j] -= rvx * slide * wb;
      b.vy[j] -= rvy * slide * wb;
      b.vz[j] -= rvz * slide * wb;
    }
  }

  return touched;
}
