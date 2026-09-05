import { Box3, Group, MathUtils, Vector3 } from 'three';

import { settings, CastShape, castShapeOf, zoneRadiusOf } from '../config/settings.js';
import { disposeObject } from '../utils/dispose.js';
import { Dummy } from './Dummy.js';

const MODEL_URL = './models/dummy.fbx';
/** Mixamo exports in centimetres. */
const FBX_SCALE = 0.01;
/** Tries at finding a spot that is not already occupied before giving up. */
const PLACEMENT_TRIES = 24;

const _box = new Box3();
const _size = new Vector3();
const _center = new Vector3();
const _spot = new Vector3();
const _point = new Vector3();
const _delta = new Vector3();

/**
 * The practice targets: a handful of rigged bodies standing around the caster,
 * there to be hit.
 *
 * They exist for one reason — to make an ability's *reach* visible. Every
 * effect in this sandbox is a shape in the air until something is standing in
 * it, and a body that folds over the impact and lands where the fire was is the
 * only honest read of how far a cast actually goes.
 *
 * ## What kills them
 *
 * Nothing was added to any ability. `applyHits` reads the two things every cast
 * already publishes — the line it is travelling down and how far along it the
 * front has got (`Ability#origin`, `#position`, `#u`) — and turns them into a
 * volume:
 *
 *  - a **line** cast sweeps a capsule from the caster to the front, so a body
 *    goes down on the frame the eruption reaches it and not before;
 *  - a **far** cast (`CastShape.ZONE`) is a disc at the target point, armed on
 *    the frame the front lands there, which is exactly when the crown erupts.
 *
 * One hit is a kill. This is a test range, not a fight: `hit.impulse`, `lift`
 * and `spin` are the whole of the damage model, and they are there to be
 * dragged around in the editor until a body flies the way the spell reads.
 *
 * @see Ragdoll for the fall, Dummy for one body.
 */
export class DummyField {
  /**
   * @param {import('../world/Environment.js').Environment} environment
   */
  constructor(environment) {
    this.environment = environment;

    this.group = new Group();
    this.group.name = 'Dummies';

    /** The rig every body is cloned from. Never added to the scene itself. */
    this.source = null;
    this.clip = null;
    this.scale = FBX_SCALE;
    this.offset = { x: 0, y: 0, z: 0 };
    this.forwardYaw = 0;

    /** One slot per standing body: the dummy, and the wait before it stands again. */
    this.slots = [];
    /** Where the ring is centred — the caster, handed over each frame. */
    this._anchor = new Vector3();
  }

  /** How many are still on their feet. */
  get aliveCount() {
    let count = 0;
    for (const slot of this.slots) if (slot.dummy.alive) count++;
    return count;
  }

  /* ------------------------------------------------------------------ */
  /* loading                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Load the rig and normalise it: one export, cloned per body.
   *
   * The measurements are taken once, here, and handed to every `Dummy` — the
   * scale that puts the export at `settings.dummies.height`, the offset that
   * drops its feet onto y = 0, and the yaw its bind pose calls forward.
   *
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async load(assets) {
    const fbx = await assets.loadFBX(MODEL_URL);
    await assets.settled();

    fbx.scale.setScalar(FBX_SCALE);
    fbx.updateMatrixWorld(true);
    _box.setFromObject(fbx);
    _box.getSize(_size);

    this.scale = FBX_SCALE * (settings.dummies.height / Math.max(0.001, _size.y));

    // Measure the normalised body, then put the source back to unit scale: the
    // clones carry the scale themselves, which is the only arrangement in which
    // a skinned clone and its bind matrices agree.
    fbx.scale.setScalar(this.scale);
    fbx.updateMatrixWorld(true);
    _box.setFromObject(fbx);
    _box.getCenter(_center);
    this.offset = { x: -_center.x, y: -_box.min.y, z: -_center.z };

    fbx.scale.setScalar(1);
    fbx.updateMatrixWorld(true);

    this.forwardYaw = measureForwardYaw(fbx);
    this.clip = (fbx.animations ?? [])[0] ?? null;
    if (!this.clip) console.warn('[DummyField] "dummy.fbx" carries no idle clip');

    this.source = fbx;
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* the ring                                                            */
  /* ------------------------------------------------------------------ */

  _make() {
    const dummy = new Dummy({
      source: this.source,
      clip: this.clip,
      scale: this.scale,
      offset: this.offset,
      forwardYaw: this.forwardYaw,
      environment: this.environment
    });
    this.group.add(dummy.root);
    return dummy;
  }

  /** Grow or shrink the ring to match `settings.dummies.count`, live. */
  _resize(count) {
    while (this.slots.length < count) {
      const dummy = this._make();
      this._stand(dummy);
      this.slots.push({ dummy, wait: 0 });
    }
    while (this.slots.length > count) {
      this.slots.pop().dummy.dispose();
    }
  }

  /** Put one body somewhere in the ring that nothing else is standing in. */
  _stand(dummy) {
    const config = settings.dummies;
    const inner = Math.max(0.5, Math.min(config.minRadius, config.radius));
    const outer = Math.max(inner + 0.5, config.radius);

    for (let attempt = 0; attempt < PLACEMENT_TRIES; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      // sqrt over the radius, or every body crowds the inner edge of the ring.
      const distance = MathUtils.lerp(inner, outer, Math.sqrt(Math.random()));
      _spot.set(
        this._anchor.x + Math.sin(angle) * distance,
        0,
        this._anchor.z + Math.cos(angle) * distance
      );
      if (attempt === PLACEMENT_TRIES - 1 || this._clear(_spot, dummy, config.separation)) break;
    }

    // Facing the caster, because a target that has its back turned reads as
    // scenery — and because the fall is most legible from the front.
    const yaw = Math.atan2(this._anchor.x - _spot.x, this._anchor.z - _spot.z);
    dummy.place(_spot.x, _spot.z, yaw);
  }

  _clear(spot, self, separation) {
    const squared = separation * separation;
    for (const slot of this.slots) {
      const other = slot.dummy;
      if (other === self || other.state === 'gone') continue;
      const dx = other.position.x - spot.x;
      const dz = other.position.z - spot.z;
      if (dx * dx + dz * dz < squared) return false;
    }
    return true;
  }

  /** Stand every body back up, in a fresh arrangement. Bound to a key. */
  reset() {
    for (const slot of this.slots) {
      slot.wait = 0;
      this._stand(slot.dummy);
    }
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt simulation delta — corpses freeze with the sandbox
   * @param {import('three').Vector3} anchor the caster: the centre of the ring,
   *   and what a standing body turns to watch
   */
  update(dt, anchor) {
    const config = settings.dummies;
    this.group.visible = config.enabled;
    if (!config.enabled) return;
    if (!this.source) return;

    this._anchor.copy(anchor);
    this._resize(Math.max(0, Math.round(config.count)));

    for (const slot of this.slots) {
      const dummy = slot.dummy;
      dummy.update(dt, anchor);

      if (!dummy.finished) continue;
      slot.wait += dt;
      if (slot.wait < config.respawnDelay) continue;
      slot.wait = 0;
      this._stand(dummy);
    }
  }

  /* ------------------------------------------------------------------ */
  /* being hit                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Knock down everything the casts currently in flight are standing on.
   *
   * Called after the abilities have been stepped, so the volume tested is the
   * one that was just drawn. Nothing here is stateful: a body is either alive
   * and inside the shape, or it is already down and `Dummy#kill` says no.
   *
   * @param {import('../abilities/Ability.js').Ability[]} abilities the live casts
   */
  applyHits(abilities) {
    const hit = settings.dummies.hit;
    if (!settings.dummies.enabled || !hit.enabled) return;

    for (const ability of abilities) {
      if (!ability.isActive) continue;
      // A cast that aims for itself is not a volume, and guessing one for it
      // would fell the bodies it was about to pick out one at a time.
      if (ability.handlesOwnHits) continue;

      if (castShapeOf(ability.element) === CastShape.ZONE) {
        // The crown lands when the front reaches the point, not on the way.
        if (ability.u < 1) continue;
        this._hitDisc(ability, hit);
      } else {
        this._hitLine(ability, hit);
      }
    }
  }

  /**
   * A capsule from the caster to the front of the cast.
   *
   * The whole swept length rather than just the tip, so a front that crosses
   * three metres in one frame cannot step over a body — and because a kill is
   * idempotent, re-testing ground the cast already covered costs nothing.
   */
  _hitLine(ability, hit) {
    const reach = hit.radius + settings.dummies.bodyRadius;
    const squared = reach * reach;

    for (const slot of this.slots) {
      const dummy = slot.dummy;
      if (!dummy.alive) continue;

      closestOnSegment(ability.origin, ability.position, dummy.position, _point);
      const dx = dummy.position.x - _point.x;
      const dz = dummy.position.z - _point.z;
      if (dx * dx + dz * dz > squared) continue;

      // Thrown the way the cast is going. A lance that knocks a body sideways
      // reads as a bug however good the fall is.
      dummy.kill(ability.direction.x, ability.direction.z, hit);
    }
  }

  /** The far cast's footprint: a disc at the target point, bodies thrown outward. */
  _hitDisc(ability, hit) {
    ability.pointAt(1, _point);
    const radius = zoneRadiusOf(ability.element) * hit.zoneScale + settings.dummies.bodyRadius;
    const squared = radius * radius;

    for (const slot of this.slots) {
      const dummy = slot.dummy;
      if (!dummy.alive) continue;

      _delta.set(dummy.position.x - _point.x, 0, dummy.position.z - _point.z);
      if (_delta.lengthSq() > squared) continue;

      // Out of the middle of it. A body standing exactly on the point has no
      // direction to be thrown in, so it takes the cast's own.
      if (_delta.lengthSq() < 1e-6) _delta.copy(ability.direction);
      else _delta.normalize();
      dummy.kill(_delta.x, _delta.z, hit);
    }
  }

  /**
   * Every body still on its feet within `radius` of a point, nearest first.
   *
   * The counterpart to `applyHits` for the abilities that pick their own
   * targets: they get the list, they decide who and when, and they call
   * `Dummy#kill` themselves. Sorted because the natural reading of "the nearby
   * targets" is that the closest one is dealt with first, and a summon that
   * fires at them in that order looks like it is choosing rather than
   * scattering.
   *
   * `out` is written in place and returned, so a caller polling every frame
   * allocates nothing.
   *
   * @param {number} x world, flat
   * @param {number} z
   * @param {number} radius metres
   * @param {import('./Dummy.js').Dummy[]} out reused array, cleared here
   */
  findTargets(x, z, radius, out) {
    out.length = 0;
    if (!settings.dummies.enabled) return out;

    const reach = radius + settings.dummies.bodyRadius;
    const squared = reach * reach;

    for (const slot of this.slots) {
      const dummy = slot.dummy;
      if (!dummy.alive) continue;
      const dx = dummy.position.x - x;
      const dz = dummy.position.z - z;
      const distance = dx * dx + dz * dz;
      if (distance > squared) continue;
      dummy._searchDistance = distance;
      out.push(dummy);
    }

    out.sort((a, b) => a._searchDistance - b._searchDistance);
    return out;
  }

  /**
   * Every body within `radius` — standing, or already lying there.
   *
   * The counterpart to `findTargets` for a cast that takes *hold* of what it
   * finds rather than hitting it. A corpse in a whirlpool is dragged under
   * exactly like a body that was standing in it, and a tide that swallowed only
   * the living would be the one thing on this stage that reads as a rule rather
   * than as water.
   *
   * A body that is down is measured where it actually lies (`Dummy#bodyPoint`)
   * rather than at the spot it was placed, because that spot can be metres away
   * by the time anything comes looking.
   *
   * `out` is written in place and returned, so a caller polling every frame
   * allocates nothing.
   *
   * @param {number} x world, flat
   * @param {number} z
   * @param {number} radius metres
   * @param {import('./Dummy.js').Dummy[]} out reused array, cleared here
   */
  findBodies(x, z, radius, out) {
    out.length = 0;
    if (!settings.dummies.enabled) return out;

    const reach = radius + settings.dummies.bodyRadius;
    const squared = reach * reach;

    for (const slot of this.slots) {
      const dummy = slot.dummy;
      if (dummy.state === 'gone') continue;

      const at = dummy.alive ? dummy.position : (dummy.bodyPoint(_point) ?? dummy.position);
      const dx = at.x - x;
      const dz = at.z - z;
      const distance = dx * dx + dz * dz;
      if (distance > squared) continue;

      dummy._searchDistance = distance;
      out.push(dummy);
    }

    out.sort((a, b) => a._searchDistance - b._searchDistance);
    return out;
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    for (const slot of this.slots) slot.dummy.dispose();
    this.slots.length = 0;
    if (this.source) disposeObject(this.source);
    this.source = null;
    this.clip = null;
    this.group.parent?.remove(this.group);
  }
}

/**
 * The nearest point on segment `a → b` to `p`, in the XZ plane.
 *
 * Flat because everything it is asked about is: the floor is y = 0, the cast
 * line lies on it, and a body's feet are on it too.
 */
function closestOnSegment(a, b, p, out) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + abz * abz;
  const t = lengthSq < 1e-9 ? 0 : MathUtils.clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / lengthSq, 0, 1);
  return out.set(a.x + abx * t, 0, a.z + abz * t);
}

/**
 * Derive the rig's own forward from its bind pose.
 *
 * The heel → toe vector is the most reliable indicator of facing on a bind pose
 * that may not be axis aligned — the same measurement `CharacterController`
 * makes, for the same reason: `place(x, z, yaw)` means "0 faces +Z" whichever
 * way the FBX was authored.
 */
function measureForwardYaw(root) {
  root.updateMatrixWorld(true);

  let foot = null;
  let toe = null;
  root.traverse((node) => {
    if (!node.isBone) return;
    const short = node.name.split(':').pop().replace(/^mixamorig/i, '');
    if (short === 'LeftFoot' && !foot) foot = node;
    else if (short === 'LeftToeBase' && !toe) toe = node;
  });
  if (!foot || !toe) return 0;

  const heel = foot.getWorldPosition(new Vector3());
  const tip = toe.getWorldPosition(new Vector3()).sub(heel).setY(0);
  return tip.lengthSq() > 1e-6 ? Math.atan2(tip.x, tip.z) : 0;
}
