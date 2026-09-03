import { Group, Raycaster, Plane, Vector2, Vector3, MathUtils } from 'three';
import { settings, ELEMENTS, CastShape, castShapeOf } from '../config/settings.js';
import { EventEmitter } from '../utils/EventEmitter.js';
import { AimIndicator } from '../effects/AimIndicator.js';
import { ZoneIndicator } from '../effects/ZoneIndicator.js';

const GROUND_PLANE = new Plane(new Vector3(0, 1, 0), 0);

/**
 * Targeting, in the two shapes players already know from MOBAs.
 *
 * A **line cast** arms an arrow that swings about the caster and fires along
 * its length; a **far cast** arms a circle that follows the cursor and drops
 * where it is clicked. Which one an ability uses is declared in
 * `ELEMENT_META[...].cast`, and the controller swaps indicators on selection —
 * everything else about arming, clamping, validating and firing is shared,
 * because from the targeting side the only difference is what gets drawn.
 *
 * The controller owns the aim state and both indicators; it decides nothing
 * about what the cast does. It emits one event, `cast`, with an origin, a unit
 * direction and a distance — which is exactly the signature the ability's
 * `spawn` takes. A far cast reads its target point off the far end of that
 * line, so the ability contract never had to change.
 *
 * The pointer is re-projected every frame rather than only on move, so orbiting
 * the camera with the cast armed swings the indicator under a stationary
 * cursor.
 *
 * Emits: `cast` (origin, direction, distance), `arm`, `cancel`, `reject`.
 */
export class AimController extends EventEmitter {
  constructor(camera) {
    super();
    this.camera = camera;
    this.raycaster = new Raycaster();
    this.raycaster.far = 500;

    this.indicator = new AimIndicator();
    this.zone = new ZoneIndicator();

    this.group = new Group();
    this.group.name = 'AimIndicators';
    this.group.add(this.indicator.object3D, this.zone.object3D);

    /**
     * Which ability the arrow is measuring for. `range` and `minRange` are
     * per-element, so the reach of the arrow changes with the slot the player
     * has selected.
     */
    this.element = ELEMENTS[0];

    this.armed = false;
    /** 0..1 sweep-out of the indicator. Driven by real time, never scaled. */
    this.reveal = 0;

    /** Where the cast comes from — the caster's feet. */
    this.origin = new Vector3();
    /** Unit vector on the ground plane. */
    this.direction = new Vector3(0, 0, 1);
    this.distance = 0;
    this.yaw = 0;
    /** False while the pointer is nearer than the ability's `minRange`. */
    this.valid = true;

    this._pointer = new Vector2();
    this._hasPointer = false;
    this._hit = new Vector3();
    this._flat = new Vector3();
  }

  get object3D() {
    return this.group;
  }

  /** Live settings block of the ability being aimed. */
  get config() {
    return settings[this.element] ?? settings[ELEMENTS[0]];
  }

  /** Whether the ability in the slot is aimed with the arrow or the circle. */
  get shape() {
    return castShapeOf(this.element);
  }

  /** Footprint of a far cast, metres. Zero for a line cast. */
  get zoneRadius() {
    return Math.max(0.05, this.config.zoneRadius ?? 1);
  }

  /** Point the indicator at a different ability's reach. */
  setElement(element) {
    if (!settings[element]) return;
    this.element = element;
  }

  get isArmed() {
    return this.armed;
  }

  /** Heading the caster should face, radians about +Y. */
  get facing() {
    return this.yaw;
  }

  /* ------------------------------------------------------------------ */

  /** Where the arrow starts. Called every frame with the character's position. */
  setOrigin(position) {
    this.origin.set(position.x, 0, position.z);
  }

  arm() {
    if (this.armed) return;
    this.armed = true;
    this.emit('arm');
  }

  cancel() {
    if (!this.armed) return;
    this.armed = false;
    this.emit('cancel');
  }

  toggle() {
    if (this.armed) this.cancel();
    else this.arm();
  }

  /** Latest pointer position in NDC. Kept even while disarmed. */
  point(pointer) {
    this._pointer.copy(pointer);
    this._hasPointer = true;
  }

  /**
   * Fire, if the aim is legal.
   * @returns {boolean} whether a cast was emitted
   */
  confirm() {
    if (!this.armed) return false;
    if (!this.valid) {
      this.emit('reject');
      return false;
    }
    this.armed = false;
    this.emit('cast', this.origin, this.direction, this.distance);
    return true;
  }

  /* ------------------------------------------------------------------ */

  /** Project the pointer onto the ground and resolve the aim from it. */
  _resolve() {
    const c = this.config;

    if (this._hasPointer) {
      this.raycaster.setFromCamera(this._pointer, this.camera);
      if (this.raycaster.ray.intersectPlane(GROUND_PLANE, this._hit)) {
        this._flat.copy(this._hit).sub(this.origin);
        this._flat.y = 0;
        // Behind the caster and dead on top of them are the two degenerate
        // cases; keep the last good heading rather than snapping to north.
        if (this._flat.lengthSq() > 1e-6) {
          const raw = this._flat.length();
          this.direction.copy(this._flat).multiplyScalar(1 / raw);
          this.yaw = Math.atan2(this.direction.x, this.direction.z);
          this.valid = raw >= c.minRange;
          this.distance = MathUtils.clamp(raw, Math.max(0.2, c.minRange), Math.max(0.4, c.range));
          return;
        }
      }
    }

    this.valid = false;
    this.distance = MathUtils.clamp(this.distance, Math.max(0.2, c.minRange), Math.max(0.4, c.range));
  }

  /**
   * @param {number} dt real seconds — deliberately *not* the scaled simulation
   *   delta, so the indicator keeps animating while the sandbox is paused.
   */
  update(dt) {
    this._resolve();

    const zoned = this.shape === CastShape.ZONE;
    const revealTime = Math.max(0.01, zoned ? settings.zone.reveal : settings.aim.reveal);
    const target = this.armed ? 1 : 0;
    const step = dt / revealTime;
    this.reveal = MathUtils.clamp(
      this.reveal + MathUtils.clamp(target - this.reveal, -step, step),
      0,
      1
    );

    const visible = this.reveal > 0.001;
    // Only ever one of the two is on screen, and swapping the slot mid-reveal
    // hides the other outright rather than leaving it fading in place.
    this.indicator.setVisible(visible && !zoned);
    this.zone.setVisible(visible && zoned);

    if (!visible) return;
    if (zoned) {
      this.zone.update(
        this.origin,
        this.yaw,
        this.distance,
        this.zoneRadius,
        this.config.range,
        this.reveal,
        this.valid
      );
    } else {
      this.indicator.update(this.origin, this.yaw, this.distance, this.reveal, this.valid);
    }
  }

  dispose() {
    this.indicator.dispose();
    this.zone.dispose();
    this.clear();
  }
}
