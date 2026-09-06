/**
 * settings.js — the single source of truth for every tweakable value in the sandbox.
 *
 * Nothing in the renderer owns state that lives here: shaders, particle systems,
 * lights and post processing all *read* these objects every frame. That is what
 * makes the real-time editor work without rebuilding anything — mutating a field
 * is immediately visible on screen, including on a ward that is already
 * standing, and including while the clock is paused (`P`), which is when the
 * shapes are actually worth tuning.
 *
 * The one rule that keeps that promise: a system may only ever *sample* these
 * values. It must never copy one into a record at spawn time and read it back
 * later — see `WardAbility`, whose monolith records hold nothing but unitless
 * dice rolls, and resolve every metre, radian and second against this file each
 * frame.
 *
 * Conventions
 *  - Colours are stored as `#rrggbb` strings so lil-gui can bind them directly.
 *    Use `utils/color.js#getColor()` to read them as a cached THREE.Color.
 *  - `global` holds multipliers that scale everything at once (1 = neutral).
 *  - The per-ability blocks (`ward`, `acid`, `growth`, `cyber`, …) hold absolute values.
 *
 * Every ability block is keyed by its id in `ELEMENTS`, and the shared systems
 * that need to know about "the ability the player is currently holding" — the
 * aim controller, the cooldown, the HUD — look it up as `settings[element]`.
 * The four fields they rely on being present are `range`, `minRange`, `speed`
 * and `cooldown`; everything else in a block is that ability's own business.
 * A **far cast** (`CastShape.ZONE`, declared in `ELEMENT_META`) adds a fifth:
 * `zoneRadius`, the footprint the circle indicator measures out.
 */

/**
 * The cast animations shipped alongside the rig, in `public/models/<id>.fbx`.
 *
 * Every ability block carries a `castAnim` naming one of these, so each spell
 * can throw the body differently; `CharacterController` loads all of them once
 * at boot and keeps only their clips, and the editor turns this array straight
 * into the per-ability dropdown.
 */
export const CAST_ANIMATIONS = ['cast1', 'cast2', 'cast3'];

export const settings = {
  /* ------------------------------------------------------------------ */
  /* Global multipliers                                                  */
  /* ------------------------------------------------------------------ */
  global: {
    timeScale: 1.0, // slow-mo / fast forward for the whole simulation
    speed: 1.0, // eruption travel speed multiplier
    lifetime: 1.0, // ability lifetime multiplier
    glow: 1.0, // emissive multiplier fed into bloom
    shaderIntensity: 1.0, // master strength of every procedural shader effect
    noiseStrength: 1.0,
    noiseFrequency: 1.0,
    noiseSpeed: 1.0,
    turbulence: 1.0,
    randomness: 1.0, // per-instance / per-particle jitter multiplier
    particleCount: 1.0,
    particleLifetime: 1.0,
    particleSpeed: 1.0,
    particleSize: 1.0,
    emissionRate: 1.0,
    lightIntensity: 1.0,
    lightRadius: 1.0,
    distortion: 1.0,
    fresnel: 1.0,
    opacity: 1.0,
    animationSpeed: 1.0, // character animation playback rate
    cameraShake: 1.0,
    explosionIntensity: 1.0
  },

  /* ------------------------------------------------------------------ */
  /* The aim indicator — the ground arrow drawn while the cast is armed  */
  /* ------------------------------------------------------------------ */
  /**
   * A League-style skillshot indicator: one ground quad with a signed-distance
   * arrow in its fragment shader, so every dimension below is in *metres* and
   * nothing is a texture. The quad is rebuilt from these numbers each frame,
   * which is why dragging `range` while aiming stretches the arrow live.
   */
  aim: {
    /* --- silhouette (metres) --- */
    shaftWidth: 0.42, // half-width of the shaft
    headLength: 2.6, // length of the arrowhead
    headWidth: 1.35, // half-width at the base of the head
    round: 0.12, // corner rounding of the whole silhouette
    startOffset: 0.9, // gap between the caster and the tail of the arrow

    /* --- rendering --- */
    edge: 0.09, // outline thickness, metres
    edgeGlow: 2.6, // how hard the outline blooms
    softness: 0.06, // feather on the outer edge
    fill: 0.3, // opacity of the interior wash
    fillFalloff: 1.1, // how fast the wash fades from the axis to the edge
    opacity: 1.0,

    /* --- energy running up the shaft --- */
    stripes: 0.55, // chevrons per metre
    stripeSharp: 0.62, // 0 = soft gradient, 1 = hard bars
    stripeDepth: 0.55, // how much they modulate the fill
    scrollSpeed: 2.4, // metres/second they travel toward the tip
    pulse: 0.28, // brightness breathing
    pulseSpeed: 2.2,

    /* --- frost break-up --- */
    noise: 0.45, // how much noise eats into the fill
    noiseScale: 1.6, // features per metre
    noiseSpeed: 0.35,
    crystals: 0.55, // voronoi frost plates over the interior
    crystalScale: 2.4,

    /* --- furniture --- */
    baseRing: 0.62, // radius of the ring at the caster's feet, metres
    baseRingWidth: 0.06,
    tipGlyph: 0.9, // strength of the crystal rosette at the impact point
    tipGlyphSize: 1.15, // radius of that rosette, metres
    tipSpin: 0.45, // revolutions/second
    rangeArc: 0.55, // brightness of the max-range cap
    reveal: 0.055, // seconds for the arrow to sweep out when armed

    /* --- colour --- */
    colorCore: '#ecfbff',
    colorEdge: '#3fb4ff',
    colorInvalid: '#ff6a5c', // shown when the target is inside `minRange`

    height: 0.035 // hover distance above the floor, metres
  },

  /* ------------------------------------------------------------------ */
  /* The far-cast indicator — the circle drawn at the target point       */
  /* ------------------------------------------------------------------ */
  /**
   * The other half of the targeting vocabulary. Where `aim` draws an arrow
   * along a line, this draws the **footprint**: a disc dropped at the cursor
   * with a deliberately thick boundary, because the one thing a ground-targeted
   * AoE has to answer before you click is *how much space is this going to
   * take*. The band is the answer, and the ability's own field is built to land
   * exactly on it.
   *
   * Two meshes, both parametric:
   *  - the **footprint**, a quad whose fragment shader is a signed-distance
   *    ring evaluated in metres from the target;
   *  - the **reach ring**, a ribbon strip bent into a circle at the caster's
   *    feet at `range` — a far cast needs to show where its arm ends.
   *
   * Shared by every far cast, so a new one inherits the whole indicator and
   * only brings its own `zoneRadius`.
   */
  zone: {
    /* --- the boundary (metres) --- */
    boundary: 0.34, // thickness of the band that *is* the footprint edge
    // Held under 2: the band is already the widest mark on the circle, and
    // pushing the gain past this clips it to flat white and throws away the
    // hue that says which ability you are holding.
    boundaryGlow: 1.8, // how hard it blooms
    boundaryBias: 0.35, // <0.5 grows the band inward, >0.5 outward
    liner: 0.05, // thin bright liner riding the inside of the band
    softness: 0.05, // feather on both lips

    /* --- the interior --- */
    fill: 0.22, // opacity of the wash inside the circle
    fillFalloff: 1.5, // >1 keeps the middle clear and crowds it to the rim
    rings: 2.0, // concentric contour rings across the radius
    ringWidth: 0.05,
    ringSpeed: 0.35, // how fast they travel outward, radii/second
    crawl: 0.75, // filaments crawling over the interior
    crawlScale: 1.3, // filaments per metre
    crawlSpeed: 0.45,
    noise: 0.4, // break-up eating into the wash
    noiseScale: 1.2,

    /* --- furniture --- */
    ticks: 24, // marks stepping around the boundary
    tickLength: 0.42, // how far they reach in, metres
    tickWidth: 0.2, // duty cycle, 0..1
    tickSpin: 0.06, // revolutions/second
    sweep: 0.55, // radar sweep brightness
    sweepSpeed: 0.4, // revolutions/second
    core: 0.85, // the mark at the exact target point
    coreSize: 0.4, // its radius, metres
    crosshair: 0.5, // four arms pointing out of the core
    crosshairLength: 1.1,
    pulse: 0.22, // brightness breathing
    pulseSpeed: 2.0,

    /* --- the reach ring at the caster --- */
    reach: 0.7, // brightness of the max-range circle, 0 hides it
    reachWidth: 0.05, // its half-width, metres
    reachDashes: 64, // dashes around it (0 = solid)
    reachDashGap: 0.42, // fraction of each dash that is gap
    reachSpin: 0.03, // revolutions/second the dashes creep
    reachLead: 0.9, // how much brighter the arc nearest the cursor is
    reachSegments: 192, // tessellation of that circle

    /* --- rendering --- */
    opacity: 1.0,
    reveal: 0.07, // seconds the circle takes to snap out when armed
    snap: 1.18, // how far past its radius it overshoots on the way out
    height: 0.035, // hover distance above the floor, metres

    /* --- colour --- */
    colorCore: '#eaf7ff',
    colorEdge: '#7c6bff',
    colorInvalid: '#ff6a5c' // shown when the target is inside `minRange`
  },

  /* ------------------------------------------------------------------ */
  /* Character                                                           */
  /* ------------------------------------------------------------------ */
  character: {
    /* --- blending the cast clip over the idle --- */
    // The idle loops forever; a cast clip is a one-shot laid over the top of it,
    // so these are the two edges of that overlap. In fast, out soft: the throw
    // has to land on the frame you clicked, the recovery does not.
    castBlendIn: 0.12, // seconds to cross-fade from the idle into the cast
    castBlendOut: 0.3, // seconds to fall back to the idle once it finishes

    /* --- how the body sells the cast --- */
    turnToAim: true, // face the arrow while aiming
    turnRate: 0.0002, // fraction of the heading gap left after 1s (lower = snappier)
    castLean: 0.34, // radians the torso pitches forward on release
    castRecoil: 0.16, // metres the body is shoved back
    castSettle: 2.6 // seconds⁻¹ the lunge decays at
  },

  /* ------------------------------------------------------------------ */
  /* Target dummies — what the abilities are aimed at                    */
  /* ------------------------------------------------------------------ */
  /**
   * The practice targets: rigged bodies standing in a ring, one-shot by any
   * cast that reaches them, thrown by a ragdoll rather than an animation.
   *
   * See `combat/DummyField.js` for how a hit is derived (no ability knows these
   * exist — the volume is read off the cast line every frame) and
   * `combat/Ragdoll.js` for the fall itself.
   */
  dummies: {
    enabled: true,
    /** How many are standing at any moment. */
    count: 6,
    /** Metres from the caster they stand inside, and no nearer than. */
    radius: 13.0,
    minRadius: 5.0,
    /** Metres between two of them, so they never share a patch of floor. */
    separation: 2.4,
    /** Normalised height, metres — the same treatment the player's rig gets.
     *  Read once, when the model is loaded. */
    height: 1.78,
    /** The cylinder a cast has to touch to count as a hit, metres. */
    bodyRadius: 0.42,

    /** Whether they turn to watch the caster, and how fast (lower = snappier). */
    watch: true,
    turnRate: 0.02,

    /** Seconds a corpse lies there, then the seconds it takes to burn away. */
    corpseTime: 4.5,
    dissolveTime: 1.3,
    /** Seconds before a burnt-away body stands back up somewhere else. */
    respawnDelay: 2.0,

    /**
     * What lands the hit.
     *
     * A line cast sweeps a capsule of `radius` from the caster to its front; a
     * far cast is a disc of `zoneRadius × zoneScale` at the target point, armed
     * the frame the front gets there. One touch is a kill — these are targets,
     * not enemies, and the numbers below are about how the body *flies*.
     */
    hit: {
      enabled: true,
      radius: 1.5, // half-width of a line cast's kill capsule, metres
      zoneScale: 1.0, // the far cast's own footprint, × its circle
      impulse: 6.0, // metres/second the body leaves at, along the blow
      lift: 3.4, // metres/second it is thrown upward
      spin: 1.4 // extra impulse per body-height above the hips — the torque
    },

    /**
     * The look. The export carries no textures at all, so this is authored
     * rather than imported: a cold near-black body with a bright rim, which is
     * the one combination that stays legible at fifteen metres against a floor
     * this dark, and the ember burn that takes the corpse away.
     */
    look: {
      color: '#1b2029',
      roughness: 0.78,
      metalness: 0.15,
      /** The rim that draws the silhouette. */
      rimColor: '#6fd2ff',
      rimPower: 2.6,
      rimEmissive: 1.5,
      /** The burn edge as they dissolve, and how wide that band is. */
      edgeColor: '#8fe6ff',
      edgeEmissive: 6.0,
      edgeWidth: 0.12,
      /** Features per metre in the dissolve noise. */
      dissolveDetail: 9.0
    },

    /**
     * The ragdoll — see `combat/Ragdoll.js` for what these actually drive.
     *
     * It is a particle per joint, the bone lengths as distance constraints and
     * a few braces across the pelvis and chest, solved by relaxation. `gravity`
     * is deliberately heavier than earth: a body that falls at 9.8 on a screen
     * this size reads as slow motion, and every game does the same thing.
     */
    ragdoll: {
      gravity: -19.0,
      /** Fraction of the velocity the air takes per second. */
      damping: 0.06,
      /** Relaxation passes per substep. More = stiffer. */
      iterations: 7,
      /** How hard the braces pull compared to the bones themselves. */
      brace: 0.45,
      /** Metres a joint stands off the floor, and how it lands on it. */
      radius: 0.075,
      friction: 0.75,
      bounce: 0.06,
      /** Below this much movement per second, the body is asleep and free. */
      sleep: 0.03
    }
  },

  /* ------------------------------------------------------------------ */
  /* The cut                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * What happens to a body when the blow that felled it came with an edge on
   * it — see `combat/Dummy.js#_cut` and `combat/Ragdoll.js#collideRagdolls`.
   *
   * Nothing in the sandbox slices by default: a cast has to *ask* for it, and
   * exactly one does (the Chrono-Summon's lance). Everything here is about the
   * two halves — where the plane sits, how hard they are driven apart, what
   * each of them does with the blow, and how they behave once they are lying on
   * each other.
   */
  slice: {
    enabled: true,
    /**
     * Where the plane sits, as a fraction of the body's own height.
     *
     * 0.60 is the waist on this export — between the hip joint and the base of
     * the spine. Below it and the plane goes through the pelvis, which leaves
     * the top half with a slab of hip hanging off it; much above and the legs
     * walk away with the ribcage.
     */
    height: 0.6,
    /** Degrees it is tilted off horizontal, tipping away along the blow. */
    tilt: 16,
    /** Metres the upper half is lifted clear on the frame the body parts. */
    separation: 0.09,
    /**
     * m/s the halves are driven *apart* along the blow, on top of whatever each
     * already took of it.
     *
     * The top half gets it the way the lance went and the legs get it the other
     * way, so the two travel in opposite directions instead of following each
     * other into the same heap — the difference between reading the cut and
     * reading a body that fell over in two bits. Added evenly rather than
     * weighted up the body (`Ragdoll#shove`), so neither half is spun by it:
     * the fold is the blow's doing, this only separates them.
     */
    split: 1.8,
    /**
     * What each half does with the blow, as multipliers on `impulse` / `lift` /
     * `spin`. The top of a body cut in half leaves with most of what the lance
     * had; the bottom is a pair of legs that fold.
     *
     * Well under 1 rather than over it, which reads backwards until you see
     * why: `spin` is applied per *body height*, and half a body is half as
     * tall, so the same number throws its head twice as hard.
     */
    upper: { impulse: 0.78, lift: 0.72, spin: 0.55 },
    lower: { impulse: 0.22, lift: 0.1, spin: 0.2 },

    /**
     * The two halves as solid things — see `collideRagdolls`.
     *
     * `radius` is the base; every joint scales it by its own size (a pelvis is
     * a chunk, a wrist is not). `maxPush` is what keeps it from exploding: it
     * caps how far one frame may separate a pair, so an overlap that starts
     * deep opens over several frames instead of firing the halves apart.
     */
    collide: {
      enabled: true,
      /** Metres, before each joint's own size multiplier. */
      radius: 0.09,
      /** How much of the closing speed comes back, and how much slide is lost. */
      bounce: 0.2,
      friction: 0.45,
      /** Metres a single frame may push one pair apart. */
      maxPush: 0.05
    },

    /** What the cut opens, and how much it glows in its own right. */
    interiorColor: '#2a1a14',
    interiorEmissive: 0.35,
    /** The hot line the edge leaves, and how wide that band is (× height). */
    edgeColor: '#b9ff72',
    edgeEmissive: 4.0,
    edgeWidth: 0.014
  },

  /* ================================================================== */
  /* WARD — ability one, and the one that stands *around* a point       */
  /* ================================================================== */
  /**
   * VOLCANIC HORROR WARD. A surge of melt runs to the aimed circle, the stone
   * inside it shatters into plates with magma in the seams, a ring of obsidian
   * monoliths is heaved up out of the wreckage, and a cylinder of blood closes
   * over the lot with a band of burning runes at its foot and another at its rim.
   *
   * The **heartbeat** is the idea the whole ability is built on. One two-lobe
   * cardiac envelope is evaluated per frame in `WardAbility` (`bpm`, `beatDepth`)
   * and handed to *everything*: the membrane swells and brightens on it, the
   * runes flare, the veins under the obsidian light from the floor up as the
   * wave climbs, the melt in the seams pumps, the core flare relights, the
   * dynamic light throbs and a ring of embers is thrown off the stone. Nothing
   * in here free-runs on its own sine — that is the difference between a stack
   * of effects and one thing that is alive.
   *
   * The eight passes of the reference sheet map onto the groups below one for
   * one:
   *
   *   1. cylindrical blood barrier  → `The barrier`     (WardBarrierMaterial)
   *   2. magma fracture decal       → `The floor`       (WardGroundMaterial)
   *   3. rising obsidian embers     → `Embers & ash`
   *   4. gore splash particles      → `Gore`
   *   5. core heat distortion       → `Heat haze`       (LAYER.DISTORTION)
   *   6. rune edge glow             → `The rune bands`
   *   7. sub-surface vein flash     → `The obsidian`    (ObsidianMaterial)
   *   8. lens flare shockwave       → `The core flare`
   *
   * The first **far cast**, so `zoneRadius` is the one number that really
   * matters: it is where the membrane stands, where the rune bands run, where
   * the floor stops shattering and where the monoliths are seated.
   *
   * As everywhere else in this file, a cast captures a seed and a handful of
   * timestamps and nothing else. Every metre, radian and second below is
   * re-resolved each frame, including on a zero-length one — which is why the
   * ward reshapes under these sliders with the clock stopped.
   */
  ward: {
    /* --- the cast --- */
    range: 20.0, // maximum cast distance, metres
    minRange: 0.0, // warding your own feet is the point of a ward
    zoneRadius: 5.0, // the footprint — what the circle indicator measures out
    speed: 74.0, // how fast the surge runs to the point, metres/second
    sealTime: 0.34, // seconds the ward takes to close once the surge lands
    lifetime: 5.2, // seconds it stands
    fadeTime: 1.3, // seconds it takes to come apart
    cooldown: 2.4,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the heartbeat everything is driven off --- */
    bpm: 58, // beats per minute
    beatDepth: 0.8, // how hard the beat modulates the ward, 0 = flatline
    beatEmbers: 46, // embers thrown off the floor on a beat
    beatGore: 5, // droplets flicked off the membrane on a beat
    beatShake: 0.05, // the knock on the camera
    beatRing: 0.55, // brightness of the ring pushed across the stone
    beatFlare: 0.42, // how much of the core flare a beat relights

    /* --- where the surge leaves the caster --- */
    handHeight: 1.2, // metres above the floor
    handForward: 0.6, // metres in front of the caster
    handSide: -0.16, // metres to the side (+ follows `Ability#side`)

    /* --- the barrier: a cylinder of blood standing on the boundary --- */
    /**
     * Drawn twice over one open tube — far wall first, near wall over it —
     * because a single-sided shell has no inside and reads as a decal wrapped
     * round the scene. Both passes are alpha blended rather than additive on
     * purpose: the membrane has to *tint* the monoliths standing behind it, and
     * additive can only ever add.
     */
    height: 4.4, // how high the wall stands, metres
    riseCurve: 1.3, // >1 makes it hang low then snap up
    bulge: 0.08, // barrel: how far the waist swells past the rim
    flare: 0.05, // how far the rim opens past the footprint
    throb: 0.045, // radius the wall gains on a beat, × radius
    // Held low on purpose. The ward has to be a *window* onto the stone and the
    // monoliths inside it: push these up and both walls stack into an opaque
    // shell, and everything the ability is actually about disappears behind it.
    density: 0.15, // opacity of the membrane itself
    innerDensity: 0.2, // ... of the far wall, seen through the near one
    innerGain: 0.55, // and how bright that far wall runs
    fresnel: 1.7, // how hard the rim term falls off
    fresnelGain: 1.15, // and how bright it runs
    rimTop: 0.05, // the hot hoop at the rim, fraction of the height
    rimBase: 0.045, // ... and the one where it meets the floor
    rimGlow: 1.6,
    flowScale: 1.15, // runs of blood per metre
    flowStretch: 0.34, // <1 stretches them vertically into runs
    flowSpeed: 0.5, // how fast they travel down the wall
    flowSharp: 0.55, // 0 = a wash, 1 = hard threads
    flowGain: 0.8,
    warp: 0.45, // domain warp — what stops the runs reading as stripes
    cells: 0.35, // membrane cells over the surface
    cellScale: 1.6, // cells per metre
    bands: 2.6, // pressure rings climbing the wall
    bandSpeed: 0.4,
    bandWidth: 0.14,
    swirl: 0.5, // how much the wall shears as it climbs
    spin: 0.05, // revolutions/second the whole wall turns
    crest: 2.1, // brightness of the leading edge while it closes
    dissolveEdge: 0.2, // width of the burn as it tears
    softFade: 0.55, // metres of soft fade where it meets geometry
    barrierGlow: 1.1,
    opacity: 1.0,
    colorMembrane: '#8d0f18', // the body of the wall
    colorFlow: '#e0241c', // the blood running down it
    colorRim: '#ff9a6a', // the hoops at the floor and the rim
    colorDeep: '#26030a', // the far wall, seen through the near one

    /* --- the rune bands --- */
    /**
     * Two rings of glyphs, one at the foot of the membrane and one at its rim.
     * The glyphs are *generated*: every cell hashes its own subset out of a
     * fixed alphabet of nine strokes, so the ring carries genuinely
     * non-repeating script rather than a tiled texture — and moving `runes`
     * re-cuts every one of them.
     */
    runes: 42, // glyphs around the ring
    runeSize: 0.38, // height of a band, metres
    runeInset: 0.03, // how far outside the membrane it sits, metres
    runeWeight: 0.048, // stroke thickness, cell space
    runeStrokes: 0.55, // how many of the candidate strokes a glyph keeps
    runeSpin: 0.03, // revolutions/second the ring turns
    runeSweep: 0.7, // brightness of the read head running round it
    runeSweepSpeed: 0.2, // revolutions/second
    runeSweepWidth: 0.09, // how much of the ring it covers
    runeFlicker: 0.3, // per-glyph brightness stutter
    runeHalo: 0.6, // soft bleed under every stroke
    runeGlow: 2.4,
    runeBase: 1.0, // brightness of the band at the floor
    runeTop: 0.85, // ... and of the one at the rim
    colorRune: '#ff3a16',
    colorRuneCore: '#ffdcae',

    /* --- the obsidian monoliths --- */
    monoliths: 6, // slabs standing inside the ring
    // Seated out toward the wall rather than around the middle: the centre of
    // the ward belongs to the flare, and slabs stacked in it read as a bonfire.
    monolithRing: 0.62, // where they are seated, × footprint
    monolithJitter: 0.16, // radial scatter, × footprint
    // Kept to roughly two fifths of the wall: any taller and the ring reads as
    // a fire burning inside the ward rather than as rock standing in it.
    monolithHeight: 1.9, // metres
    monolithHeightJitter: 0.5,
    monolithWidth: 1.3, // footprint of one, metres
    monolithThin: 0.55, // how much flatter than wide — these are slabs
    monolithLean: 0.14, // radians they lean outward
    monolithSweep: 0.36, // seconds the ring takes to come up
    monolithSpread: 1.0, // how far bearings scatter off even spacing
    rubble: 9, // low shards banked around their feet
    rubbleHeight: 0.5,
    rubbleRing: 0.74, // where they lie, × footprint

    /* --- what the obsidian is made of --- */
    /**
     * Volcanic glass with the melt still trapped in it. The veins are sampled at
     * an offset *along the view ray* (`veinDepth`), which is what puts them
     * under the surface rather than on it: they slide as the camera moves, the
     * way something seen through glass does.
     */
    // Few and wide beats many and thin: at these scales a fine vein network
    // aliases into a speckle and the slab reads as coral rather than as glass
    // with something burning inside it.
    veinScale: 1.4, // vein features per unit
    veinWidth: 0.06, // how wide a vein burns
    veinBranches: 0.35, // how finely they fork
    veinDepth: 0.28, // parallax depth — the sub-surface read
    // The glass has to stay *dark*: the veins are what is inside a rock, and a
    // rock that out-glows the melt on the floor stops being one.
    veinGlow: 0.35,
    veinFlow: 0.8, // how much the melt crawls inside a vein
    veinFlowSpeed: 0.9,
    veinFlash: 0.7, // extra gain as a heartbeat climbs the slab
    flashSpeed: 3.4, // metres/second that wave travels
    flashWidth: 1.0, // metres
    glassRough: 0.42, // obsidian is glass, but a mirror facet catches the sky
    facetTint: 0.42, // per-facet value break-up
    cavity: 0.4, // cheap curvature occlusion
    rimLight: 0.3, // sheath of heat around the silhouette
    // Held low: the stage's probe is a bright sky, and a polished facet pointing
    // the right way picks up enough of it to go cream — on a night set, that
    // single blown face is all you see of the slab.
    envIntensity: 0.55,
    obsidianGlow: 1.0,
    colorObsidian: '#1c1416',
    colorObsidianChar: '#070406',
    colorVein: '#ff2f10',
    colorVeinCore: '#ffdca6',

    /* --- the floor: plates, and the melt between them --- */
    /**
     * A true two-nearest voronoi, so the seams are the *edges between cells*
     * rather than a threshold on a distance field — that is the difference
     * between shattered stone and cracked mud. Alpha blended, because the crust
     * has to darken the floor it is lying on.
     */
    // Big plates, thin seams. Cells much under a metre turn the floor into a
    // uniform glowing web at any sane camera distance, and the read you want is
    // *slabs of stone with light between them*.
    fieldPlates: 0.75, // plates per metre
    fieldRadial: 0.45, // how much the shattering radiates from the middle
    fieldWarp: 0.4, // domain warp on the cell centres
    fieldSeam: 0.075, // width of a seam, cell space
    fieldSeamGlow: 2.2,
    fieldCrust: 0.94, // how opaque the black crust is
    fieldRelief: 0.7, // fake lighting across the plates
    fieldHeat: 0.85, // master heat in the seams
    fieldHeatFalloff: 1.5, // how fast the melt cools toward the boundary
    fieldCool: 0.6, // how much it sets over the ward's life
    fieldFlow: 0.45, // how fast the melt crawls along a seam
    fieldEmber: 0.7, // flecks glimmering in the seams
    fieldEmberScale: 4.5,
    fieldBoundary: 0.18, // the burnt band on the footprint, metres
    fieldBoundaryGlow: 1.8,
    fieldCore: 0.4, // the pool the flare stands in
    fieldCoreSize: 0.26, // its radius, × footprint
    fieldRings: 1.4, // pressure rings running out of the middle
    fieldRingSpeed: 0.5,
    fieldOpacity: 1.0,
    fieldHeight: 0.024, // hover distance above the floor, metres
    colorCrust: '#0b0708',
    colorPlate: '#1d1214',
    colorMagma: '#ff4a12',
    colorMagmaHot: '#ffd8a0',
    colorFieldEdge: '#ff2a14',

    /* --- the core flare --- */
    flareSize: 5.0, // metres across
    flareHeight: 1.15, // how far off the floor it sits, metres
    flareBase: 0.8, // what it burns at between beats
    flareCore: 2.4, // brightness of the middle
    flareStreak: 2.2, // length of the anamorphic streak, × size
    flareStreakWidth: 0.045,
    flareSpikes: 6, // points on the starburst
    flareSpikeGain: 1.2,
    flareSpikeSharp: 14.0,
    flareGhosts: 0.4, // chromatic rings off the axis
    flareSpin: 0.035, // revolutions/second the burst turns
    shockWidth: 0.055, // thickness of the ring it throws
    shockSpeed: 2.6, // how fast that ring races out, × size
    flareOpacity: 1.0,
    colorFlareCore: '#fff3dc',
    colorFlareStreak: '#ff5c20',
    colorFlareGhost: '#8f0f12',

    /* --- heat haze over the core --- */
    hazeStrength: 0.7,
    hazeScale: 2.2, // features per metre
    hazeSpeed: 1.4, // how fast it rises
    hazeHeight: 1.15, // × the barrier height
    hazeWidth: 0.9, // × the footprint
    hazeFalloff: 1.3, // how fast it thins with height

    /* --- embers, ash, gore and smoke --- */
    /**
     * Four systems, and the split matters: the embers are additive and rise, the
     * flecks are lit chips of cooling obsidian that rise and fall back, the gore
     * is non-additive so it reads wet and actually occludes, and the smoke is
     * there to give the inside of the ward volume to stand in.
     */
    emberRate: 300, // embers/second off the seams
    emberSize: 0.1,
    emberSpeed: 2.4,
    emberLifetime: 1.9,
    emberRise: 3.4, // upward acceleration, m/s²
    emberTurbulence: 1.1,
    emberInset: 0.06, // how far inside the boundary they are picked up
    colorEmberA: '#ffe6bd',
    colorEmberB: '#ff6a1e',
    colorEmberC: '#c31408',
    colorEmberD: '#2c0503',
    fleckRate: 34, // chips of obsidian/second
    fleckSize: 0.075,
    fleckSpeed: 4.2,
    fleckLifetime: 1.6,
    fleckGravity: -6.5,
    colorFleckA: '#3b2224',
    colorFleckB: '#241618',
    colorFleckC: '#150d0f',
    colorFleckD: '#0d080a',
    goreRate: 30, // droplets/second thrown off the membrane
    goreSize: 0.11,
    goreSpeed: 5.0,
    goreLifetime: 1.1,
    goreGravity: -19.0,
    goreOpacity: 0.95,
    colorGoreA: '#c11a1e',
    colorGoreB: '#7d0d13',
    colorGoreC: '#48060b',
    colorGoreD: '#210306',
    smokeRate: 62,
    smokeSize: 1.15,
    smokeSpeed: 1.1,
    smokeLifetime: 2.6,
    smokeOpacity: 0.075,
    smokeRise: 0.7,
    colorSmokeA: '#4a2a26',
    colorSmokeB: '#33201f',
    colorSmokeC: '#241718',
    colorSmokeD: '#150e10',

    /* --- what else the ground does --- */
    scorchRadius: 2.2, // the burn the ward stands on, metres
    scorchLife: 9.0,
    scorchIntensity: 0.6,
    splatRate: 3.5, // gore marks laid inside the ring, per second
    splatRadius: 0.7, // radius of one, metres
    splatLife: 5.0,
    splatIntensity: 0.85,
    trailRate: 1.2, // marks laid per metre while the surge runs out
    shockRadius: 8.5, // the ring thrown when the ward seals, metres
    ringRate: 0.9, // dust rings pushed out while it stands, per second
    colorScorch: '#0a0505',
    colorSplat: '#5c0a10',
    colorSplatEdge: '#c0201c',
    colorShockA: '#ff3a14',
    colorShockB: '#ffd8a0',

    /* --- dynamic light --- */
    lightIntensity: 22,
    lightRadius: 22,
    lightHeight: 0.3, // how far up the wall the light sits, 0..1
    lightColor: '#ff4a1c',
    lightBeat: 0.6, // how much of the light the heartbeat owns

    /* --- the throw, the seal and the hold --- */
    muzzleSize: 0.55, // the flash at the hand as the surge leaves it
    muzzleIntensity: 1.8,
    castFlash: 0.1, // screen flash on release
    colorCastFlash: '#ff6a3a',
    burstSize: 2.4, // the shell thrown off when the ward seals, metres
    burstIntensity: 1.2,
    sealEmbers: 260, // extra embers at the seal
    sealGore: 160, // ... droplets
    sealFlecks: 90, // ... and chips
    sealShake: 0.95,
    shakeDuration: 0.7,
    sealFlash: 0.3,
    holdShake: 0.05, // continuous rumble while the ward stands
    rumble: 0.03, // rumble while the surge runs out
    colorBurstA: '#ff5a1e',
    colorBurstB: '#ff8a4a',
    colorBurstC: '#ffd9a0',
    colorFlash: '#ff4a20' // the full-screen flash when it seals
  },

  /* ------------------------------------------------------------------ */
  /* Caustic Bloom — the poison acid aura                                */
  /* ------------------------------------------------------------------ */
  /**
   * Five passes, one per panel of the reference sheet: the acid pool on the
   * floor, the raymarched mist standing in it, the bubbles coming off it, the
   * corrosive shimmer over it and the ring it all stands on.
   *
   * **The boil is what makes those five things one thing.** `boilRate` drives a
   * single irregular envelope that every pass, the light, the emitters and the
   * camera read once per frame — see `AcidAbility#_advanceBoil`. Set
   * `boilDepth` to 0 and the whole aura goes flat and inert, every pass at once.
   */
  acid: {
    /* --- the cast --- */
    range: 20.0, // maximum cast distance, metres
    minRange: 0.0, // it is an aura: dropping it on your own feet is the point
    zoneRadius: 4.4, // the footprint — what the circle indicator measures out
    speed: 68.0, // how fast the corrosion runs to the point, metres/second
    bloomTime: 0.42, // seconds the pool takes to open once the corrosion lands
    lifetime: 5.6, // seconds it stands
    fadeTime: 1.5, // seconds it takes to go inert
    cooldown: 2.2,
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the boil: the irregular pulse every pass is driven off --- */
    /**
     * Not a heartbeat. A chemical reaction has no metronome — it surges when
     * enough gas has built up under the crust and subsides when it vents — so
     * this envelope is a sum of three incommensurate sines, which never repeats
     * inside a cast and never lands on the beat you are expecting. `boilSharp`
     * is what keeps it from reading as a slow throb: raised to a power the
     * envelope spends most of its time low and spikes, the way a boil does.
     */
    boilRate: 2.0, // how fast the envelope runs
    boilSharp: 2.6, // >1 spikes it: mostly still, with surges
    boilDepth: 0.9, // how hard it modulates everything, 0 = inert
    boilThreshold: 0.55, // the level a surge has to cross to vent a gout
    goutBubbles: 22, // bubbles thrown up when it vents
    goutMotes: 90, // ... and motes
    goutRing: 0.3, // brightness of the ring it pushes across the pool
    goutShake: 0.035, // the knock on the camera
    goutLift: 1.7, // extra upward speed on the gout

    /* --- where the corrosion leaves the caster --- */
    handHeight: 1.15, // metres above the floor
    handForward: 0.6, // metres in front of the caster
    handSide: -0.16, // metres to the side (+ follows `Ability#side`)

    /* --- the pool --- */
    /**
     * Alpha blended, because the acid has to *eat* the floor — an additive pool
     * is a decal that glows with the granite showing straight through it. The
     * plates are lit off a world-space gradient of their own height field, and
     * the surface carries a real specular lobe: everything else on this stage is
     * rough, and the gloss is what says *liquid*.
     */
    // Big plates with a fine crazing over them. Cells much under a metre turn
    // the floor into a uniform glowing web at any sane camera distance, and the
    // read you want is *stone with channels of acid in it*.
    poolPlates: 0.62, // plates per metre
    poolCraze: 0.55, // the finer network laid over them
    poolWarp: 0.45, // domain warp on the cell centres
    poolSeam: 0.05, // width of a channel, cell space
    poolSeamGlow: 1.15,
    poolCrust: 0.95, // how opaque the sludge crust is
    poolRelief: 0.8, // fake lighting across the plates
    poolSheen: 0.32, // the specular lobe — what says "wet"
    poolGloss: 0.42, // 0 = broad and dull, 1 = a tight highlight
    poolEtch: 0.35, // how much the growing edge is chewed by its own noise
    poolEtchScale: 1.6,
    poolPits: 0.12, // fraction of plates eaten clean through
    poolPitScale: 1.6, // pits per metre
    poolBoilRate: 0.5, // surface bubbles bursting, per second per cell
    poolHeat: 0.55, // master brightness of the live acid
    poolHeatFalloff: 1.4, // how fast it goes inert toward the boundary
    poolSpend: 0.6, // how much it spends over the bloom's life
    poolFlow: 0.5, // how fast brightness crawls along a channel
    poolCaustic: 0.25, // interference on the standing acid
    poolCausticScale: 2.2,
    poolBoundary: 0.16, // the bleached band on the footprint, metres
    poolBoundaryGlow: 0.4,
    poolCore: 0.12, // the brighter pool in the middle
    poolCoreSize: 0.4, // its radius, × footprint
    poolRings: 1.3, // pressure rings running out of the middle
    poolRingSpeed: 0.4,
    poolOpacity: 1.0,
    poolHeight: 0.022, // hover distance above the floor, metres
    colorSludge: '#0a1104',
    colorPlate: '#24310c',
    colorAcid: '#8fff1e',
    colorAcidHot: '#dcff9a',
    colorPoolEdge: '#b6ff2e',

    /* --- the mist: a raymarched volume --- */
    /**
     * The one pass here that cannot be faked with billboards. `mistSteps` is the
     * whole performance dial — it is a live slider precisely so a demo machine
     * and a laptop can run the same build. Everything else shapes the cloud:
     * `mistThreshold` carves empty space out of the noise (raise it for torn
     * wisps, drop it for a solid fog), `mistTwist` is the vortex it climbs on,
     * and `mistGroundGlow` is the pool lighting it from below — which is the
     * single term that stops it being green fog.
     */
    mistHeight: 5.2, // how high the column stands, metres
    riseCurve: 1.25, // >1 makes it hang low then climb
    mistSteps: 26, // samples per pixel through the volume
    mistDensity: 2.9, // master density
    mistAbsorb: 1.45, // how fast it goes opaque along the ray
    mistScale: 0.5, // noise features per metre
    mistDetail: 1.9, // frequency of the filament layer
    mistFilament: 0.5, // how much of it is filaments rather than billows
    mistThreshold: 0.52, // below this there is simply no gas
    mistRise: 0.5, // how fast the field climbs
    mistStretch: 0.32, // <1 elongates the gas vertically — a plume, not fog
    mistTwist: 1.2, // radians the column turns over its height
    mistSpin: 0.02, // revolutions/second the whole cloud turns
    mistEdge: 0.45, // where the wall starts to soften, × radius
    mistFlare: 0.4, // how far the chimney opens with height
    mistFalloff: 1.5, // how fast it thins toward the crown
    mistSkirt: 0.22, // how far it spills past the boundary at the floor
    mistLobe: 0.32, // how far the wall wanders — what stops it being a can
    mistTear: 0.24, // how much harder the crown is carved than the body
    mistGroundGlow: 1.15, // the pool lighting it from underneath
    mistGroundFalloff: 0.85, // how fast that light dies with height
    mistShadow: 2.2, // self-shadowing against the sun
    mistShadowStep: 0.9, // metres to the shadow tap
    mistAmbient: 0.05,
    mistSaturate: 2.2, // how much thick gas deepens in colour
    mistOpacity: 1.0,
    mistGlow: 0.85,
    colorMistDeep: '#0a1e05', // thick gas, in the middle of the cloud
    colorMistBody: '#4f8f1c',
    colorMistEdge: '#b7f25a', // thin gas, at its edges
    colorMistLight: '#93a862', // the sun coming through it

    /* --- the ring at its foot --- */
    /**
     * Two meshes: a flat annulus on the floor for the bloom, and a short
     * standing collar so the band still has a silhouette when the camera drops
     * to eye level — which is the angle the game is actually played at.
     */
    ringInset: 0.0, // how far outside the footprint it sits, metres
    ringHeight: 0.03, // hover distance above the floor, metres
    ringWidth: 0.085, // half-width of the blown-out core, metres
    ringCore: 1.5, // brightness of that core
    ringHalo: 0.4, // the broad glow either side of it
    ringHaloWidth: 0.4, // metres
    ringSpill: 0.1, // the wash spilling inward across the pool
    ringWobble: 0.008, // how far the radius wanders — a perfect circle reads as UI
    ringWobbleScale: 2.6,
    ringChevrons: 34, // energy marks around the band
    ringChevronDepth: 0.32,
    ringScroll: 0.05, // revolutions/second they travel
    ringSweep: 1.1, // brightness of the read head running round it
    ringSweepSpeed: 0.2, // revolutions/second
    ringSweepWidth: 0.12,
    ringTicks: 6, // heavier marks on the compass points
    ringOpacity: 1.0,
    ringGlow: 0.95,
    collarHeight: 0.55, // how far the standing band rises, metres
    collarGain: 0.5,
    collarFalloff: 2.3, // how fast it dies toward its top
    collarFresnel: 1.6, // grazing-angle boost — a sheet of light seen edge-on
    collarStreaks: 16, // vertical filaments licking off the band
    collarStreakDepth: 0.35,
    collarStreakSpeed: 1.1,
    collarSoftFade: 0.4, // metres of soft fade where it meets geometry
    collarOpacity: 1.0,
    colorRing: '#9dff2b',
    colorRingCore: '#f4ffd6',

    /* --- the corrosive shimmer --- */
    fumeStrength: 0.75,
    fumeScale: 1.9, // features per metre
    fumeSpeed: 1.1, // how fast it rises
    fumeSwirl: 0.35, // how much it rolls about the column with height
    fumeHeight: 1.05, // × the mist height
    fumeWidth: 0.95, // × the footprint
    fumeFalloff: 1.3, // how fast it thins with height

    /* --- bubbles, motes, fog and splatter --- */
    /**
     * Four systems, and the split matters: the bubbles are non-additive films
     * with a catchlight and a burst so they read as gas held in a skin, the
     * motes are additive sparks of live acid, the fog is the low spill that
     * stops the volume's boundary being a visible wall, and the splatter is
     * thrown liquid that actually lands and stains.
     */
    bubbleRate: 44, // bubbles/second off the pool
    bubbleSize: 0.16,
    bubbleSpeed: 1.05,
    bubbleLifetime: 1.6,
    bubbleRise: 0.45, // upward acceleration, m/s²
    bubbleTurbulence: 0.5,
    bubbleInset: 0.05, // how far inside the boundary they are picked up
    bubbleGrow: 1.45, // how much bigger they get before they burst
    bubbleOpacity: 0.85,
    colorBubbleA: '#e8ffbe',
    colorBubbleB: '#a6ff3c',
    colorBubbleC: '#3d8a10',
    colorBubbleD: '#1c3a06',
    moteRate: 110, // sparks/second off the channels
    moteSize: 0.05,
    moteSpeed: 2.0,
    moteLifetime: 1.4,
    moteRise: 1.5,
    moteTurbulence: 1.2,
    colorMoteA: '#f2ffd2',
    colorMoteB: '#b6ff3a',
    colorMoteC: '#57c414',
    colorMoteD: '#16300a',
    fogRate: 46,
    fogSize: 1.05,
    fogSpeed: 0.9,
    fogLifetime: 2.9,
    fogOpacity: 0.06,
    fogRise: 0.35,
    fogSpread: 0.55, // how hard it is pushed outward across the floor
    colorFogA: '#63823a',
    colorFogB: '#455e22',
    colorFogC: '#2c3e14',
    colorFogD: '#16210a',
    splashRate: 16, // droplets/second thrown off the boil
    splashSize: 0.085,
    splashSpeed: 4.4,
    splashLifetime: 1.2,
    splashGravity: -17.0,
    splashOpacity: 0.95,
    colorSplashA: '#c8ff62',
    colorSplashB: '#78d418',
    colorSplashC: '#3d7f0c',
    colorSplashD: '#16300a',

    /* --- what else the ground does --- */
    etchRadius: 1.5, // the burn the bloom stands on, metres
    etchLife: 9.0,
    etchIntensity: 0.1,
    stainRate: 1.4, // acid marks laid inside the ring, per second
    stainRadius: 0.6, // radius of one, metres
    stainLife: 5.0,
    stainIntensity: 0.22,
    trailRate: 0.9, // marks laid per metre while the corrosion runs out
    shockRadius: 7.5, // the ring thrown when the pool opens, metres
    ringRate: 0.28, // vapour rings pushed out while it stands, per second
    colorEtch: '#141c09',
    colorStain: '#2f4a08',
    colorStainEdge: '#5c8f14',
    colorShockA: '#8fff1e',
    colorShockB: '#b6f05a',

    /* --- what it does to a body --- */
    /**
     * The one far cast on this stage that does not *hit* anything.
     *
     * Every other zone fells what is standing in it outward on the frame the
     * front lands, and that is exactly wrong here: there is no blast in acid.
     * There is only time. A body caught in the bloom stops holding itself up —
     * `impulse`, `lift` and `spin` are zero, so `Ragdoll#strike` writes every
     * joint's velocity as nothing and the body goes limp in the pose it was
     * standing in — and then the pool takes it apart where gravity dropped it.
     * See `AcidAbility#_melt`.
     *
     * The three blow numbers are here so the editor can still throw bodies
     * about, not because anything about this ability wants them.
     */
    melt: {
      enabled: true,
      reach: 1.05, // how far it eats, × the footprint: the fumes spill a little
      impulse: 0.0, // the blow, and it is nothing on purpose
      lift: 0.0,
      spin: 0.0,
      // Long enough that the body has *landed*, and then lain there going
      // green, before the first of it goes. A ragdoll takes the better part of
      // a second to fall, and a corpse that starts dissolving on the way down
      // has been deleted rather than eaten.
      onset: 1.6, // seconds in the acid before the flesh starts to go
      // Comfortably faster than `dummies.dissolveTime`, and that is not a
      // taste call. `Dummy#update` runs the natural burn as a *floor* under
      // whatever is eating the body, so an acid slower than that floor is an
      // acid nobody can see working: the corpse would go on its own clock and
      // the surges below would land on nothing.
      rate: 1.8, // fraction of a body taken per second, between surges
      boil: 0.55, // how much of that rate the surge owns — it eats in bursts
      stain: 1.6, // how fast the green takes a whole body over, per second
      /**
       * What the acid turns a body into, and what its dissolve burns along.
       *
       * Lerped over `settings.dummies.look` by how far the stain has got, so a
       * body is already green while it is still whole and stays green while
       * whatever is left of it burns away — see `Dummy#corrode`.
       */
      look: {
        // Dark, and that is not a mood call. The body ends up lying in a pool
        // of glowing acid, and a corpse the same green as what it is lying in
        // is a corpse nobody can see dissolving. The green that reads is the
        // rim and the burn line; the flesh under them has to stay the dark
        // thing they are drawn against.
        color: '#1b2708', // the flesh, eaten
        rimColor: '#9be62a', // the silhouette, while it still has one
        rimEmissive: 1.8,
        edgeColor: '#d8ff7a', // the line the burn runs along
        edgeEmissive: 3.8,
        // Much narrower than the body's own ember burn, and that is the whole
        // difference between a corpse dissolving and a corpse glowing. This one
        // is lying in a pool that is already near-white in places: at the stock
        // width, a third of the surviving surface is inside the band at once
        // and the body blooms into one lump of light with an arm out of it. A
        // thin line has somewhere dark to be read against.
        edgeWidth: 0.045
      }
    },

    /* --- dynamic light --- */
    lightIntensity: 18,
    lightRadius: 20,
    lightHeight: 0.22, // how far up the column the light sits, 0..1
    lightColor: '#7bf01c',
    lightBoil: 0.55, // how much of the light the boil owns

    /* --- the throw, the bloom and the hold --- */
    muzzleSize: 0.5, // the flash at the hand as the corrosion leaves it
    muzzleIntensity: 1.5,
    castFlash: 0.08, // screen flash on release
    colorCastFlash: '#a8ff3a',
    burstSize: 2.2, // the shell of vapour thrown as the pool opens, metres
    burstIntensity: 1.0,
    bloomBubbles: 60, // extra bubbles as it opens
    bloomMotes: 260, // ... motes
    bloomSplash: 180, // ... and droplets
    bloomShake: 0.7,
    shakeDuration: 0.7,
    bloomFlash: 0.22,
    holdShake: 0.035, // continuous rumble while it stands
    rumble: 0.025, // rumble while the corrosion runs out
    colorBurstA: '#7ee01a',
    colorBurstB: '#b6ff3a',
    colorBurstC: '#e9ffb4',
    colorFlash: '#8fff28' // the full-screen flash when the pool opens
  },

  /* ================================================================== */
  /* GROWTH — the Arborist's Growth Chrono-Summon                        */
  /* ================================================================== */
  /**
   * A summon rather than a strike, and the only ability in the set that
   * *chooses* what it hits.
   *
   * A seed of green light runs across the floor to the aimed circle. A nature
   * sigil opens there and races out to the boundary; a nest of woody tendrils
   * tears up out of it, climbing and curling, unfurling foliage as the growth
   * front passes; and an arcane bloom rises out of the middle of them and opens,
   * whorl by whorl, over a core that is visibly winding up. Then it fires: a
   * lance of green light to the nearest body still standing, one at a time,
   * and what it goes through comes apart at the waist.
   *
   * Five layers, one per panel of the reference sheet:
   *
   *   1. **the nature sigil** — SDF rails, a generated rune band, an inscribed
   *      star and a wandering vine filigree, all in metres from the centre so
   *      the mark re-scales rather than stretching.
   *      (`materials/NatureSigilMaterial.js`)
   *   2. **the wild-growth tendrils** — instanced tubes placed entirely in a
   *      vertex shader from an analytic path, lit and shadow casting.
   *      (`materials/GrowthVineMaterial.js`)
   *   3. **the foliage** — instanced leaves clipped to those same stems by the
   *      same path function, so they can never come loose from the wood.
   *   4. **the arcane bloom** — three whorls of petals on an arc, opening by
   *      animating one angle, over an additive core and its halo.
   *      (`materials/ArcaneBloomMaterial.js`)
   *   5. **motes, pollen and mist** — GPU particles, plus the leaves that drift
   *      off the nest as it withers.
   *
   * And the lance, which is layer six in everything but the reference sheet:
   * `materials/GrowthLanceMaterial.js`, one instance per shot, and the cut
   * itself in `settings.slice`.
   *
   * **The rule that keeps the editor honest.** A cast captures a seed and a
   * handful of timestamps. Not one metre, radian or second is recorded: the
   * footprint, the nest, the bloom, the lances and the light are all resolved
   * against this block inside the update loop, which runs on a zero-length
   * frame too. Drag `footprint radius` while a summon is standing and the
   * sigil, the tendrils, the foliage and the bloom all re-seat around it.
   */
  growth: {
    /* --- the cast --- */
    range: 22.0, // maximum cast distance, metres
    minRange: 0.0, // it can be planted at the caster's own feet
    zoneRadius: 4.2, // the footprint — what the circle indicator measures out
    speed: 62.0, // how fast the seed runs to the point, metres/second
    cooldown: 3.2,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws
    lifetime: 7.4, // seconds the summon stands, once it has bloomed
    fadeTime: 2.2, // seconds it takes to wither

    /* --- the order things happen in, seconds from the seed landing --- */
    /**
     * The summon is a *sequence*, and this is it. Nothing here overlaps by
     * accident: the sigil has to be readable before the wood tears through it,
     * the nest has to have a shape before the bloom rises out of it, and the
     * bloom has to be open before the core is allowed to fire.
     */
    sigilTime: 0.42, // the mark races out to the boundary
    vineDelay: 0.18, // ... and the tendrils are already coming up behind it
    vineTime: 1.15, // how long the nest takes to reach full height
    vineStagger: 0.38, // how much of that one stem may lag the first by
    bloomDelay: 0.85, // when the bud starts to lift out of the nest
    bloomTime: 1.05, // how long the whorls take to open
    fireDelay: 0.35, // seconds after the bloom is open before the first lance

    /* --- where the seed leaves the caster --- */
    handHeight: 1.25, // metres above the floor
    handForward: 0.62, // metres in front of the caster
    handSide: -0.14, // metres to the side (+ follows `Ability#side`)

    /* --- the pulse everything glowing rides --- */
    /**
     * Not a heartbeat and not a boil: a **breath**. Two sines a fifth apart, so
     * the envelope drifts in and out of phase with itself over about twenty
     * seconds and the summon never lands twice on the same rhythm inside one
     * cast. The sigil brightens on it, the core charges on it, the light swells
     * on it and the motes come faster on it — one number, five passes.
     */
    pulseRate: 1.15, // radians/second through the envelope
    pulseDepth: 0.55, // how hard it modulates, 0 = flatline

    /* ------------------------------------------------------------------ */
    /* Layer 1 — the nature sigil                                          */
    /* ------------------------------------------------------------------ */
    sigilRailWidth: 0.032, // stroke thickness, metres
    sigilRailOuter: 1.0, // the boundary rail, × footprint
    sigilRailInner: 0.84,
    sigilRailHub: 0.2,
    sigilRailGlow: 1.7,
    sigilSpin: 0.014, // revolutions/second the ring turns

    sigilRunes: 46, // glyphs around the band
    sigilRuneBand: 0.32, // height of the band, metres
    sigilRuneSeat: 0.92, // where it sits, × footprint
    sigilRuneWeight: 0.05, // stroke thickness, cell space
    sigilRuneStrokes: 0.52, // how many candidate strokes a glyph keeps
    sigilRuneSweep: 1.5, // brightness of the read head running round it
    sigilRuneSweepSpeed: 0.13, // revolutions/second
    sigilRuneSweepWidth: 0.09, // how much of the ring it covers
    sigilRuneFlicker: 0.22, // per-glyph brightness stutter
    sigilRuneGlow: 2.3,

    sigilTicks: 0.75, // brightness of the graduations on the outer rail
    sigilTickCount: 72,
    sigilTickWidth: 0.32,
    sigilTickLength: 0.055, // × footprint

    sigilStar: 1.0, // the inscribed triangle and its inverse
    sigilStarRadius: 0.66, // × footprint
    sigilStarWidth: 0.028, // metres
    sigilStarSpin: -0.009, // counter to the ring

    sigilFiligree: 0.95, // the vine arcs woven between the rails
    sigilFiligreeSeat: 0.52, // × footprint
    sigilFiligreeAmp: 0.075, // how far they wander, × footprint
    sigilFiligreeLobes: 6, // lobes around the circle
    sigilFiligreeWidth: 0.02, // metres
    sigilFiligreeSpin: 0.018,

    sigilPool: 0.3, // the wash of light inside the circle
    sigilPoolFalloff: 2.2,
    sigilGrain: 0.45, // break-up over that wash
    sigilGrainScale: 2.6,
    sigilOpacity: 1.0,
    sigilGlow: 1.15,
    sigilHeight: 0.028, // hover distance above the floor, metres

    /* ------------------------------------------------------------------ */
    /* Layer 2 — the wild-growth tendrils                                  */
    /* ------------------------------------------------------------------ */
    vines: 15, // tendrils in the nest (capacity is 18)
    vineSeat: 0.74, // where a foot is planted, × footprint
    vineSpread: 0.75, // how far bearings scatter off even spacing
    vineHeight: 3.2, // how tall a full-grown tendril stands, metres
    vineHeightJitter: 0.6,
    /**
     * The rise curve. Under 1 the stem leaves the floor fast and levels off —
     * which is what a climbing plant does, and what stops the nest reading as a
     * cone with its point in the air.
     */
    vineRise: 0.74,
    vineBelly: 0.36, // how far it bows outward at the waist, × its foot radius
    vineLean: 0.55, // tip radius, × foot radius — how hard it closes over
    vineTwist: 0.12, // turns taken climbing
    vineCurlAt: 0.78, // where the tip starts to spiral, 0..1
    vineCurlTurns: 0.45, // and how far round it goes
    vineCurlPinch: 0.42, // how tight that spiral draws in
    vineCurlLift: 0.1, // and how much it climbs while it does
    vineWander: 0.75, // baked-in low-frequency wander, metres
    vineWanderScale: 2.2,
    vineSway: 0.085, // live sway at the tip, metres
    vineSwaySpeed: 0.75,
    vineThick: 0.085, // half-width at the foot, metres
    vineTaper: 0.24, // ... as a fraction of that, at the tip
    vineKnots: 0.32, // how lumpy the stem is
    vineKnotScale: 9.0,

    /* --- what the wood is made of --- */
    barkScale: 5.5, // grain features per metre
    barkContrast: 1.6,
    barkFibre: 0.55, // fibres running the length of the stem
    barkFibreBands: 3.0,
    barkFibreScale: 26.0,
    barkRoughness: 0.92,
    barkEnv: 0.12, // how much of the probe the wood picks up

    seamWidth: 0.05, // how wide the bioluminescent seams burn
    seamBands: 2.4, // seams around the stem
    seamScale: 5.0, // ... and along it
    seamFlow: 0.35, // how fast the field crawls through them
    seamGlow: 0.45,
    sapPulse: 1.4, // a bright band of sap climbing the stem
    sapSpeed: 0.34,
    sapWidth: 0.12,
    frontGlow: 5.0, // the bud at the growing tip
    frontWidth: 0.09,
    vineRim: 0.22, // sheath of light around the silhouette
    vineRimPower: 2.6,
    vineGlow: 1.0,

    witherRise: 0.58, // how much the wither follows height vs pure noise
    witherScale: 3.2,
    witherEdge: 0.1, // width of the burn line as it eats back
    witherEdgeGlow: 2.4,

    /* ------------------------------------------------------------------ */
    /* Layer 3 — the foliage                                               */
    /* ------------------------------------------------------------------ */
    leaves: 150, // leaves across the whole nest (capacity is 320)
    leafStart: 0.15, // nothing grows out of the first stretch of a stem
    leafEnd: 0.97,
    leafSize: 0.32, // stalk to tip, metres
    leafSizeJitter: 0.6,
    leafAspect: 0.42, // half-width, × length
    leafBias: 0.72, // where the blade is widest, <1 pushes it toward the tip
    leafPoint: 0.78, // how sharply it comes to a point
    leafPitch: 0.55, // radians the stalk is swung toward the stem's tip
    leafPitchJitter: 0.95,
    leafDroop: 0.35, // how far the blade sags along its own length
    leafCup: 0.22, // how far it channels across
    leafOpen: 0.12, // how long a leaf takes to unfurl behind the front
    leafFlutter: 0.09, // radians it stirs
    leafFlutterSpeed: 1.7,

    leafVeins: 7, // laterals along the blade
    leafVeinWidth: 0.09,
    leafVeinSkew: 0.55, // how far they tip toward the tip
    leafRibWidth: 0.055, // the midrib
    leafVeinGlow: 0.6,
    leafTranslucency: 0.85, // light coming *through* the blade
    leafSheen: 0.14, // specular off the cuticle
    leafMottle: 0.3,
    leafRoughness: 0.6,
    leafEnv: 0.18,
    leafGlow: 1.0,

    /* ------------------------------------------------------------------ */
    /* Layer 4 — the arcane bloom                                          */
    /* ------------------------------------------------------------------ */
    bloomHeight: 3.2, // where the flower hangs, metres above the floor
    bloomRise: 0.9, // how far it climbs while it opens, metres
    bloomScale: 2.1, // master size of the flower
    bloomSpin: 0.006, // revolutions/second the whorls turn, alternating
    bloomBob: 0.055, // metres it breathes up and down
    bloomBobSpeed: 0.6,

    /**
     * Which way the flower is looking.
     *
     * A bloom whose whorls are dealt around the world's up axis lies open at
     * the sky, and from the camera you are looking at the back of it. `stand`
     * tips that axis over onto the heading of whatever the summon is about to
     * shoot: at 1 the flower is upright and facing the body, at 0 it lies flat
     * as before, and anything between is a dial. `aimPitch` is how much of the
     * *height* difference to a body it will tip onto — 0 keeps it dead upright
     * however low the target is, 1 points it straight down the lance.
     */
    bloomStand: 1.0, // 0 flat, 1 standing and facing the mark
    bloomAimPitch: 0.45, // how far it tips onto a target's height
    bloomTurnRate: 7.0, // radians/second it swings onto a new one

    whorlOuter: 11, // petals in each whorl (capacity is 30 across all three)
    whorlMid: 9,
    whorlInner: 7,
    petalLengthOuter: 1.0, // × bloom scale
    petalLengthMid: 0.72,
    petalLengthInner: 0.44,
    /**
     * Radians off the bloom's own axis, once open.
     *
     * The read of a flower is entirely in this stack: the outer whorl lying
     * almost flat, the middle one half raised, the inner one still cupped
     * around the core. Flatten them all to the same angle and it is a rosette.
     *
     * **`pitch + curve` is where the blade's tip ends up, and π/2 is a wall.**
     * Under it the whorl stays on the core's side and bends the way the inner
     * ones do; over it the blade crosses behind the core and arches away, so
     * the flower grows a back — a shell of big leaves bending against the gold
     * cup instead of with it, and from the front you are looking at their
     * undersides. The outer whorl used to sit at 1.84 rad (105°) and that back
     * was the whole problem: every whorl now lands short of 1.5.
     */
    petalPitchOuter: 0.9,
    petalPitchMid: 0.72,
    petalPitchInner: 0.52,
    petalCurveOuter: 0.55, // extra radians the blade keeps turning as it runs out
    petalCurveMid: 0.52,
    petalCurveInner: 0.32,
    petalWidthOuter: 0.46, // half-width, × length
    petalWidthMid: 0.48,
    petalWidthInner: 0.52,
    petalLiftOuter: -0.05, // where the whorl is seated up the stack, × scale
    petalLiftMid: 0.03,
    petalLiftInner: 0.09,
    petalRoll: 0.31, // radians each whorl is rotated off the last
    petalPitchClosed: 0.16, // the bud: everything nearly vertical
    petalBudLength: 0.45, // ... and shorter
    petalOpenStagger: 0.22, // how far behind the outer whorl the next one opens
    petalWidthBias: 0.6, // where the blade is widest
    petalWidthPoint: 0.62, // how sharply it points
    petalCup: 0.22, // how far it channels
    petalTwist: 0.22, // radians it twists about its own spine, at the tip
    petalJitter: 0.1, // angular scatter off even spacing

    petalMargin: 0.17, // the pale edge, as a fraction of the half-width
    petalMarginGlow: 0.1,
    petalVeins: 6,
    petalVeinWidth: 0.1,
    petalVeinSkew: 0.7,
    petalRibWidth: 0.07,
    petalVeinGlow: 0.18,
    petalTipGlow: 0.25, // the tips light as the core charges
    petalChargeGain: 2.2,
    petalTranslucency: 0.45, // light coming through the blade
    petalRim: 0.12,
    petalRimPower: 2.4,
    petalShimmer: 0.25, // the chrono band crossing the whole bloom
    petalShimmerScale: 1.6,
    petalShimmerSpeed: 0.7,
    petalRoughness: 0.6,
    petalEnv: 0.08,
    petalGlow: 0.85,

    /* --- the core --- */
    coreSize: 0.26, // radius, metres, × bloom scale
    /**
     * How far up the flower's axis the charge sits, × bloom scale.
     *
     * Every whorl bends onto the lily's side, which leaves the petal bases as
     * the one part of the bloom with nothing in front of them — a charge left
     * down there is buried under the cup from the front and blazes out of the
     * back unobstructed, which is the wrong way round. Seated up the axis it
     * sits in the throat of the inner whorl instead: the light comes out
     * through the gold, and the back is a lit shell rather than the lamp.
     *
     * The inner whorl's mouth is at about 0.4, and the shipped value sits just
     * past it: the charge rests *in* the mouth, where it reads as the flower's
     * lamp from the front and leaves nothing at all showing behind. Pull it
     * under 0.3 and it sinks into the throat — warmer, softer, and the back
     * starts to glow again. It rides how far open the bloom is, so a closed
     * bud keeps its charge down at the bases.
     */
    coreSeat: 0.5,
    coreIntensity: 0.7,
    coreChargeGain: 2.6, // how much brighter it runs as a lance winds up
    coreFill: 1.7, // how hard it is weighted toward the axis
    coreRim: 0.9,
    coreRimPower: 2.2,
    coreBoil: 0.15, // how far its silhouette churns
    coreBoilScale: 2.6,
    coreFilament: 1.0, // threads turning inside it
    coreFilamentScale: 4.5,
    coreFilamentSpeed: 0.5,
    coreBudDim: 0.3, // how far it is turned down while the bud is closed
    coreSoftFade: 0.4, // metres of soft fade where it meets the petals

    /* --- the halo and the chrono rings --- */
    haloSize: 2.2, // radius, metres, × bloom scale
    haloGlow: 0.5,
    haloFalloff: 2.6,
    haloRays: 0.28, // spokes combed out of the bloom
    haloRayCount: 14,
    haloRaySharp: 6,
    haloRaySpin: 0.02,
    haloRingInner: 0.52, // the two dials, × halo radius
    haloRingOuter: 0.78,
    haloRingWidth: 0.012,
    haloRingSpin: -0.05,
    haloTicks: 0.85, // graduations on the outer dial
    haloTickCount: 48,
    haloTickWidth: 0.45,

    /* ------------------------------------------------------------------ */
    /* Layer 5 — motes, pollen and mist                                    */
    /* ------------------------------------------------------------------ */
    moteRate: 90, // spirit motes lifted off the nest, per second
    moteSize: 0.055,
    moteLifetime: 2.6,
    moteSpeed: 0.85,
    moteRise: 0.55, // gravity, so they climb
    moteTurbulence: 0.7,
    colorMoteA: '#ffffff',
    colorMoteB: '#b6ffb0',
    colorMoteC: '#3ddc7f',
    colorMoteD: '#0b3a22',

    pollenRate: 34, // heavier flecks that hang in the air
    pollenSize: 0.09,
    pollenLifetime: 4.2,
    pollenSpeed: 0.35,
    pollenRise: 0.05,
    colorPollenA: '#fff6c8',
    colorPollenB: '#e8ff9a',
    colorPollenC: '#9ad86a',
    colorPollenD: '#2a4a20',

    mistRate: 5, // the low bank the nest stands in
    mistSize: 0.9,
    mistLifetime: 3.6,
    mistSpeed: 0.5,
    mistRise: 0.18,
    mistSpread: 0.55, // how far it runs out past the boundary
    mistOpacity: 0.14,
    colorMistA: '#cfeede',
    colorMistB: '#8fc9a6',
    colorMistC: '#4a7d61',
    colorMistD: '#16281f',

    driftRate: 7, // leaves shed off the nest, per second
    driftSize: 0.16,
    driftLifetime: 4.0,
    driftSpeed: 0.7,
    driftGravity: -1.1,
    driftSpin: 3.2,
    colorDriftA: '#d8ff9e',
    colorDriftB: '#7fd85e',
    colorDriftC: '#3c8a44',
    colorDriftD: '#1a3320',

    /* --- one-shot bursts --- */
    seedMotes: 30, // thrown from the caster's hand as the seed leaves
    creepRate: 26, // motes off the seed while it runs across the floor
    trailRate: 2.6, // ground marks per metre of that run
    rootMotes: 120, // ... and the gout as it lands
    rootLeaves: 26,
    rootMist: 16,
    bloomMotes: 180, // what the flower throws as it opens
    bloomPollen: 90,
    bloomLeaves: 34,
    witherLeaves: 90, // leaves torn off as the nest goes

    /* --- the marks it leaves on the floor --- */
    stainRadius: 0.85,
    stainLife: 5.0,
    stainIntensity: 0.5,
    colorStain: '#20301f',
    colorStainEdge: '#5f8a3a',

    /* ------------------------------------------------------------------ */
    /* The lance                                                           */
    /* ------------------------------------------------------------------ */
    /**
     * What the bloom does once it is open.
     *
     * It picks the nearest body still standing inside `laserRange` of itself,
     * winds up for `laserWarmup` (which is what the core's charge and the petal
     * tips are showing you), then fires. One at a time by default: a summon
     * that cuts down four bodies on the same frame is a screen-clear, and a
     * summon that works its way round the ring is a *thing standing there
     * deciding*. Raise `laserVolley` if you want the screen-clear.
     */
    laserEnabled: true,
    laserRange: 11.0, // metres from the bloom
    laserInterval: 0.62, // seconds between shots
    laserWarmup: 0.26, // seconds the core charges before one leaves
    laserVolley: 1, // targets taken per shot
    laserLife: 0.42, // seconds a lance is on screen
    laserWidth: 1.0, // master on its thickness
    laserAim: 0.62, // where up the body it lands, 0 feet 1 head
    laserShake: 0.16, // the knock on the camera
    laserFlash: 0.16, // and the flash
    /**
     * How the two halves leave. Lower than the field's own numbers on purpose:
     * this is a cut, not a blast, and a body that is *thrown* by being cut in
     * half reads as an explosion going off inside it.
     */
    laserHit: { impulse: 3.4, lift: 2.6, spin: 1.6 },
    cutLeaves: 40, // what comes out of the wound
    cutMotes: 90,
    cutSpeed: 4.5,
    cutBurst: 0.65, // metres the pressure shell over the wound opens to

    lanceRadius: 0.085, // half-width at the far end, metres
    lanceMuzzleRadius: 0.16, // ... and where it leaves the bloom
    lanceRadiusCurve: 0.6,
    lanceFlare: 0.7, // how much it opens where it lands
    lanceFlareWidth: 0.14,
    lanceThrob: 0.16, // pressure waves along it
    lanceThrobBands: 5,
    lanceThrobSpeed: 2.2,
    lanceWander: 0.05, // metres the axis drifts
    lanceWanderScale: 4,
    lanceWanderSpeed: 1.6,
    lanceStrike: 0.12, // fraction of its life spent arriving
    lanceHold: 0.42, // ... and how long before it starts to go
    lanceCoreFill: 2.4, // how hard the white is weighted to the axis
    lanceEdgePower: 2.6,
    lanceSheath: 0.75,
    lanceCoils: 2, // helices wound around it
    lanceCoilTurns: 7,
    lanceCoilSpeed: 1.1,
    lanceCoilWidth: 0.34,
    lanceCoilGain: 0.9,
    lanceMotes: 1.1, // flecks carried along inside it
    lanceMoteScale: 14,
    lanceMoteSpeed: 3.2,
    lanceHeadGlow: 2.4,
    lanceHeadWidth: 0.06,
    lanceIntensity: 2.5,
    lanceOpacity: 1.0,
    lanceSoftFade: 0.35,

    /* ------------------------------------------------------------------ */
    /* Impact, camera and light                                            */
    /* ------------------------------------------------------------------ */
    muzzleSize: 0.55, // the flash at the caster's hand
    muzzleIntensity: 1.4,
    castFlash: 0.1,
    rootBurst: 2.4, // the shell the sigil throws as it opens
    rootIntensity: 1.5,
    bloomFlash: 0.22,
    rootShake: 0.3,
    shakeDuration: 0.5,
    bloomShake: 0.18,
    holdShake: 0.035, // the standing rumble
    rumble: 0.03, // ... and the one while the seed is running

    lightIntensity: 12,
    lightRadius: 12,
    lightHeight: 0.45, // where the light sits, 0 the floor 1 the bloom
    lightPulse: 0.45, // how much of it the breath owns

    /* --- the palette --- */
    colorSigil: '#5fe08a',
    colorSigilCore: '#e6fff0',
    colorRune: '#8affb0',
    colorSigilPool: '#2f8f5a',
    colorFront: '#d8ffb0',

    colorBark: '#33291d',
    colorBarkLight: '#6b5940',
    colorSeam: '#57e08c',
    colorSeamCore: '#bfffd8',
    colorWither: '#ff9a3c', // the ember the burn line leaves behind it

    colorLeaf: '#4e9c46',
    colorLeafTip: '#a8e86a',
    colorLeafDeep: '#1d4426',
    colorLeafVein: '#9dffb4',

    colorPetalOuter: '#12543f',
    colorPetalMid: '#1f7a5c',
    colorPetalInner: '#e8c05a',
    colorPetalBase: '#0d2c22',
    colorPetalMargin: '#bfe89a',
    colorPetalVein: '#4fd89a',

    colorCore: '#ffffff',
    colorCoreMid: '#7cffd4',
    colorCoreEdge: '#0e7a56',
    colorHalo: '#5fe0b0',
    colorHaloRing: '#c9ffe4',

    colorLanceCore: '#ffffff',
    colorLanceInner: '#a8ffb0',
    colorLanceOuter: '#2fbf6a',
    colorLanceCoil: '#dbff7a',

    colorBurstA: '#e8ffd8',
    colorBurstB: '#5fd88a',
    colorBurstC: '#1d5c3a',
    colorCastFlash: '#a8ffc8',
    colorFlash: '#d8ffd0',
    lightColor: '#6effa8'
  },

  /* ------------------------------------------------------------------ */
  /* CYBER SERPENT — a holographic construct thrown down the line        */
  /* ------------------------------------------------------------------ */
  /**
   * The one ability built on a loaded mesh (`public/models/snake.glb`), and the
   * only one whose asset contributes nothing but a silhouette: the file's
   * material and texture are dropped at load time and every pixel is written by
   * `materials/CyberSerpentMaterial.js`.
   *
   * Five layers, and the block below is grouped in the order they are drawn:
   *
   *   1. the construct        → `The wireframe`   (WIRE pass)
   *   2. the energy inside it → `The energy fill` (FILL + AURA passes)
   *   3. the ribbons          → `The ribbons`     (one instanced draw)
   *   4. the wake             → `The wake`        (lagged copies + vapour)
   *   5. the rune board       → `The rune board`  (a routed circuit on the floor)
   *
   * Two conventions worth knowing before dragging anything:
   *
   *  - anything named for the **body** is in *canonical* units, where 1 is the
   *    whole length of the serpent. `sway`, `fillInflate`, `ghostLag` and
   *    `shatterSpread` all scale with `bodyLength` for free, which is why
   *    lengthening the animal does not also have to re-tune its swim.
   *  - anything named for the **board** or the **ribbons** is in metres, because
   *    those are laid out against the cast, not against the animal.
   */
  cyber: {
    /* --- the cast --- */
    range: 26.0, // maximum cast distance, metres
    minRange: 3.5, // closer than this and the cast is refused
    speed: 22.0, // how fast the construct flies, metres/second
    shatterTime: 0.75, // seconds it takes to come apart on impact
    fadeTime: 0.85, // seconds the debris takes to go out
    cooldown: 1.5,
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the flight --- */
    bodyLength: 5.0, // nose to tail tip, metres
    launchHeight: 1.35, // where it leaves the caster's hand, metres
    flightHeight: 1.85, // its cruise height
    riseDistance: 4.0, // metres it takes to settle onto that height
    bob: 0.12, // how far it rides up and down, metres
    bobSpeed: 0.9, // times/second
    formTime: 0.22, // seconds the body takes to assemble behind the nose

    /* --- the swim --- */
    // A lateral wave with a slower vertical one under it. The amplitude grows
    // from `swayRoot` at the nose to full at the tail, which is what makes the
    // head lead and the body follow instead of the whole animal sliding.
    sway: 0.14, // × bodyLength, the tail's throw
    swayWaves: 1.6, // wavelengths along the body
    swaySpeed: 1.6, // strokes/second
    swayRoot: 0.22, // how much of that amplitude the nose gets
    swayPitch: 0.45, // the vertical wave, × the lateral one
    swayPitchWaves: 0.9,
    bank: 0.35, // radians it leans into each stroke

    /* --- layer 1: the wireframe --- */
    // Screen-space width, so the mesh reads at the same weight at the caster's
    // feet and twenty-five metres downrange.
    wireWidth: 0.75, // pixels
    // Below this many pixels of triangle inradius the mesh stops drawing its own
    // wireframe: the serpent's jaws carry two thirds of its triangles, and left
    // alone they fill in solid white. See the WIRE branch of the fragment stage.
    wireFloor: 3.2,
    // ... and what that fade takes out comes back as an even glow over the
    // facet, so the animal is a mesh up close and a shape at distance without
    // dimming in between.
    wireSolid: 0.3,
    wireGain: 1.1,
    wireHalo: 3.0, // pixels of soft bleed either side of an edge
    wireHaloGain: 0.25,
    facetFill: 0.02, // how solid the interior is — keep it near nothing
    facetRim: 0.8, // the silhouette term that makes the volume legible
    facetPower: 3.2,
    scanDepth: 0.38, // holographic banding running down the body
    scanFreq: 34.0, // bands over the length
    scanSpeed: 2.6,
    pulse: 1.0, // charge running head-ward along the mesh
    pulseFreq: 2.6,
    pulseSpeed: 1.2,
    pulseSharp: 6.0,
    glitch: 0.025, // fraction of facets misfiring at any moment
    glitchRate: 16.0, // times/second the dice are re-rolled
    glitchGain: 2.0,
    headHeat: 0.6, // white at the nose, where it meets the air
    headLength: 0.14, // how far back that reaches, fraction of the body
    formEdge: 0.07, // width of the hot edge on the assembling front
    formRough: 0.06, // how ragged that front is
    formGlow: 1.6,
    wireIntensity: 0.95,
    wireOpacity: 0.9,
    softFade: 0.35, // metres of soft fade where the body meets geometry
    colorWire: '#35d5ff',
    colorHot: '#ffffff',
    colorFacet: '#0b3f7a',

    /* --- layer 2: the energy inside it --- */
    fillInflate: 0.006, // × bodyLength, off the surface
    fillCore: 4.0, // how hard it weights toward the thick part of the volume
    cloudDepth: 0.75, // how much the cloud noise modulates it
    cloudScale: 6.5,
    cloudFlow: 1.5, // how fast it streams tailward
    fillIntensity: 0.75,
    fillOpacity: 0.34,
    colorFillCore: '#7fd4ff',
    colorFillEdge: '#1050e0',
    // The outer shell: wide, faint, rim only. Push it up and it fogs the wire,
    // which is the read the whole ability rests on.
    auraInflate: 0.03,
    auraRim: 3.6,
    auraBreak: 0.45, // noise break-up, or it reads as a second skin
    auraIntensity: 0.65,
    auraOpacity: 0.24,
    colorAura: '#1a7bff',

    /* --- layer 3: the ribbons --- */
    trails: 5, // strands (capped at 8)
    trailLength: 9.0, // metres of path they reach back over
    trailTurns: 1.8, // turns each makes over that span
    trailSpin: 0.35, // turns/second they roll on top of that
    trailRadius: 0.85, // how far off the axis they ride, metres
    trailSwell: 0.5, // where along the span they are fattest
    trailWidth: 0.06, // half-width at the head, metres
    trailWidthTip: 0.5, // that width at the tail, as a multiple
    trailSharp: 2.8, // falloff across the ribbon
    trailCore: 20.0, // the hard thread down the middle of it
    trailPulse: 1.3, // charge running up it
    trailPulseFreq: 2.2,
    trailPulseSpeed: 1.3,
    trailFlicker: 0.3, // it is data, not a wire — let it stutter
    trailFlickerScale: 6.0,
    trailFlickerSpeed: 2.2,
    trailWander: 0.22, // metres the helix drifts off axis
    trailWanderScale: 2.0,
    trailWanderSpeed: 0.8,
    trailIntensity: 1.35,
    trailOpacity: 0.68,
    trailSoftFade: 0.4,
    colorTrailCore: '#ffffff',
    colorTrail: '#4fe0ff',
    colorTrailTail: '#0f47d8',

    /* --- layer 4: the wake --- */
    // Copies of the body, each one further back down the line *and* further
    // back in time, so a ghost holds the pose the serpent had when it was there.
    ghosts: 5, // copies (capped at 8)
    ghostLag: 0.16, // × bodyLength between them
    ghostTimeLag: 0.035, // seconds between them
    ghostInflate: 0.012, // × bodyLength each one swells
    ghostFade: 0.6, // how much dimmer each is than the one in front
    ghostErode: 0.85, // how hard the noise eats them into vapour
    ghostErodeScale: 1.3,
    ghostIntensity: 0.85,
    ghostOpacity: 0.36,
    colorGhost: '#3fb8ff',

    /* --- layer 5: the rune board --- */
    // A routed circuit, not a pattern: cells agree with their neighbours about
    // the edges they share, so traces run for metres, fork, and dead-end in
    // vias. See `materials/CircuitFieldMaterial.js`.
    runeWidth: 2.6, // half-width of the board, metres
    runeOverrun: 2.0, // metres it runs past the impact point
    runeHeight: 0.02, // hover above the floor, metres
    runeCell: 0.8, // routing grid, metres
    runeDensity: 0.68, // fraction of cell edges carrying a trace
    runeJitter: 0.32, // how far nodes and gates wander off the grid
    runeTrace: 0.02, // trace width, metres
    runePad: 0.13, // pad radius on a junction, metres
    runeVia: 0.05, // via radius on a dead end, metres
    runeLead: 1.8, // metres of pre-charge ahead of the nose
    runeDecay: 0.16, // 1/metres the glow dies behind it
    runeBase: 0.06, // how visible an unlit trace is
    runeGlow: 1.2,
    runeBlip: 2.0, // data running the traces toward the nose
    runeBlipFreq: 0.45, // blips per metre
    runeBlipSpeed: 3.2,
    runeUnder: 0.35, // the pool of light the body drags over the floor
    runeUnderLong: 3.6, // metres it trails behind
    runeUnderWide: 1.2,
    runeBlastSpeed: 14.0, // metres/second the impact ring crosses the board
    runeBlastLife: 0.9, // seconds it lasts
    runeBlastWidth: 0.4, // metres
    runeBlastGain: 2.2,
    runeIntensity: 1.4,
    runeOpacity: 0.8,
    colorRune: '#0d3f66',
    colorRuneLive: '#5fe6ff',
    colorRuneHot: '#e8feff',
    colorRuneUnder: '#1f6ad4',

    /* --- the air it pushes (LAYER.DISTORTION) --- */
    warpInflate: 0.05,
    warpStrength: 0.9,
    warpScale: 1.1,
    warpSpeed: 1.3,

    /* --- data motes --- */
    moteRate: 90.0,
    moteSize: 0.05,
    moteLifetime: 0.8,
    moteSpeed: 1.1,
    moteRise: 0.4,
    moteDrift: 0.9, // how hard they are left behind rather than carried
    moteTurbulence: 0.6,
    moteGlow: 1.4,
    colorMoteA: '#ffffff',
    colorMoteB: '#8ef2ff',
    colorMoteC: '#2a86ff',
    colorMoteD: '#06214d',

    /* --- sparks --- */
    sparkRate: 55.0,
    sparkSize: 0.07,
    sparkLifetime: 0.55,
    sparkSpeed: 4.5,
    sparkGravity: -3.0,
    sparkStretch: 0.35,
    sparkGlow: 1.6,
    groundSparkRate: 3.0, // bursts per metre of travel
    groundSparks: 5.0, // sparks in each
    colorSparkA: '#ffffff',
    colorSparkB: '#b6f6ff',
    colorSparkC: '#3aa0ff',
    colorSparkD: '#08265c',

    /* --- the vapour left in the corridor --- */
    wakeRate: 40.0,
    wakeSize: 0.38,
    wakeLifetime: 1.2,
    wakeSpeed: 1.0,
    wakeRise: 0.35,
    wakeOpacity: 0.12,
    wakeTurbulence: 0.6,
    colorWakeA: '#9fd6ff',
    colorWakeB: '#5f9fdd',
    colorWakeC: '#2a4f80',
    colorWakeD: '#101c30',

    /* --- the strike --- */
    shatterSpread: 0.4, // × bodyLength the fragments are thrown
    shatterSpin: 1.6, // turns each one takes on the way out
    shatterStagger: 0.5, // how much later the last facet lets go than the first
    burstSize: 1.35,
    burstIntensity: 1.0,
    burstSparks: 110.0,
    burstMotes: 90.0,
    shockRadius: 4.2,
    arcRadius: 3.4,
    arcIntensity: 1.1,
    arcLife: 1.1,
    impactFlash: 0.35,
    impactShake: 0.32,
    shakeDuration: 0.45,
    rumble: 0.03,
    burnShake: 0.05,
    castBurst: 0.85,
    castBurstGlow: 1.4,
    castSparks: 45.0,
    castFlash: 0.18,
    colorBurstA: '#e8feff',
    colorBurstB: '#5fd6ff',
    colorBurstC: '#0f45c8',
    colorShockA: '#cdf6ff',
    colorShockB: '#1e63ff',
    colorArcA: '#0d2b52',
    colorArcB: '#4fd8ff',
    colorCastFlash: '#9fe6ff',
    colorFlash: '#7fd9ff',

    /* --- the light it carries --- */
    lightColor: '#4fd0ff',
    lightIntensity: 42.0,
    lightRadius: 12.0,
    lightPulse: 0.3, // it is computed, not burning — the light steps
    lightPulseSpeed: 12.0 // steps/second
  },

  /* ================================================================== */
  /* VENOM — Crystallized Venom Surge                                    */
  /* ================================================================== */
  /**
   * A seam of amethyst tearing along the aimed line and opening into a
   * starburst at the far end. Reference for the look: the five-panel VFX
   * breakdown sheet — crystals, gas, droplets, cracks, glow — and this block is
   * grouped in exactly those five sections so that a panel of the sheet and a
   * folder of the editor are the same thing.
   *
   * Two units are in play, and mixing them up is the only way to get lost here:
   *
   *  - anything about the **cast** is in metres, because it is laid out against
   *    the aim indicator — `width`, `height`, `burstRadius`, `plateRadius`;
   *  - anything about the **plate** is a fraction of its own radius, because the
   *    Voronoi is cut in unit space and scaled — `slabGap`, `slabHeave`,
   *    `slabDepth`. That is what lets a two-metre crater and an eight-metre one
   *    break the same way instead of one of them looking like gravel.
   *
   * The palette is the load-bearing decision and it is worth stating plainly:
   * the stone is **purple** and the light inside it is **green**. Every colour
   * below is chosen against that split, and swapping the two — a green gem with
   * a violet glow — reads as a lamp behind glass instead of poison sealed in a
   * crystal.
   */
  venom: {
    /* --- the cast itself --- */
    range: 16.0, // maximum cast distance, metres
    minRange: 2.5, // closer than this and the cast is refused
    speed: 23.0, // how fast the seam travels, metres/second
    lifetime: 3.9, // seconds the cluster stands before it comes apart
    cooldown: 0.5, // seconds before the ability can be armed again
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* ================================================================ */
    /* 1 · CRYSTALS                                                      */
    /* ================================================================ */

    /* --- the seam running out from the caster --- */
    widthNear: 0.42, // half-width of the band at the caster, metres
    width: 1.9, // half-width at the far end, metres
    widthCurve: 0.8, // <1 flares early, >1 stays narrow then opens out
    gemCount: 210, // instances spent on one cast (capped at 336)
    density: 1.0, // multiplier on that count
    burstShare: 0.42, // fraction of them held back for the starburst
    clumping: 1.5, // >1 pulls the seam toward the centre line
    scatter: 0.5, // extra lateral jitter, fraction of the local half-width
    frontBias: 0.82, // <1 crowds the seam toward the impact point
    heightNear: 0.45, // gem height at the caster, metres
    height: 2.4, // gem height just short of the impact, metres
    heightCurve: 1.6, // how late the ramp climbs
    peak: 1.35, // extra height multiplier as it reaches the impact
    peakWidth: 0.3, // how much of the line that swell covers, 0..1
    rubble: 0.38, // fraction of the seam demoted to ankle-height shards
    lean: 0.38, // radians the seam leans away from the caster

    /* --- the starburst at the far end --- */
    burstRadius: 2.3, // how wide the cluster stands, metres
    burstHeight: 2.5, // height of a gem at the centre of it, metres
    crown: 0.62, // how much shorter the skirt is than the middle, 0..1
    burstLean: 1.05, // radians a rim gem leans outward
    burstLeanCurve: 0.8, // <1 leans the inner gems out early too
    spearShare: 0.16, // fraction that are long blades defining the silhouette
    spearScale: 1.3, // how much taller than a body gem those are
    spearSlim: 0.78, // and how much thinner — slenderness is what says amethyst
    shardShare: 0.3, // fraction that are the chunky skirt around the base
    shardScale: 0.34,
    burstStagger: 0.16, // seconds the rim lags the middle, × its radius

    /* --- an individual gem --- */
    radius: 0.42, // base radius, metres
    radiusJitter: 0.85,
    heightJitter: 0.62,
    leanJitter: 0.85,
    taper: 0.18, // tip radius as a fraction of the base — low is sharp
    facets: 6, // sides of the prism (5–8 read best)
    gemRough: 0.16, // how far the facets are pushed off a clean prism
    bend: 0.3, // sideways curve from base to tip
    twist: 1.0, // random yaw, 0..1 of a full turn

    /* --- the eruption --- */
    riseTime: 0.16, // seconds from buried to the top of the punch
    riseOvershoot: 0.16, // how far past full height the punch carries — this is
    // the literal peak, and past ~0.2 the crystal's root clears the floor on show
    riseStagger: 0.08, // seconds of random delay between neighbours
    settle: 0.26, // seconds it takes to drop back onto its seat. One fall, no
    // rebound — a field of gems oscillating in step reads as jelly, not stone.
    shatterDelay: 0.55, // seconds after `lifetime` before they let go
    sinkTime: 1.0, // seconds to withdraw into the floor

    /* --- the amethyst itself --- */
    colorDeep: '#3c1a6e', // what thick stone accumulates toward
    colorGem: '#7b3fd4', // body
    colorGemRim: '#c9a3ff', // fresnel edge
    colorGemTip: '#ded2f8', // the milky, frosted last third
    colorVenom: '#9dff3a', // the fluid sealed inside it
    gemOpacity: 0.97,
    gemRoughness: 0.12,
    depthTint: 1.1, // how fast the deep tint builds with thickness
    fresnel: 2.0,
    fresnelPower: 2.5,
    dispersion: 0.6, // how far the rim splits into colour
    facetSharp: 0.72, // crispness of the internal facet shading
    cleave: 0.35, // internal fracture planes
    cleaveScale: 5.0, // planes per metre
    venomGlow: 1.15, // how hot the trapped fluid burns
    venomScale: 3.8, // features per metre
    venomFlow: 0.5, // how fast it drifts up the crystal
    venomBase: 0.25, // how much survives at the tip — venom has weight
    venomSharp: 5.5, // 1 = a wash, high = distinct threads
    tipFrost: 0.5, // the milky band near the point
    tipStart: 0.55, // where up the crystal it begins, 0..1
    // Named `glint*` rather than `mote*` on purpose: these are the pinpoint
    // highlights on the crystal *surface*; the `mote*` family further down
    // drives the airborne glitter particles. Two different effects.
    glint: 0.6,
    glintScale: 30.0,
    glintSpeed: 0.6,
    gemGlow: 0.68, // overall emissive gain
    edgeGlow: 0.5, // brightness of the silhouette rim
    birthGlow: 0.9, // extra glow on a gem that has just erupted
    birthFade: 0.22, // seconds that birth flash lasts
    envIntensity: 1.0, // how much of the HDR probe the facets catch

    /* ================================================================ */
    /* 2 · GAS                                                           */
    /* ================================================================ */
    /**
     * Sampled over the particle's own lifetime: `A` the instant it is born, `D`
     * as it dies. Spelled out rather than derived from the crystal palette so
     * the cloud can be pushed green or grey without touching the stone — and it
     * wants to be *both*, acid at the source and dusty violet by the time it has
     * drifted, which is the whole reason there are four stops.
     */
    gasRate: 240, // particles/second along the front
    gasSize: 1.15,
    gasSpread: 3.2, // how much bigger a puff gets over its life
    gasSpeed: 1.1,
    gasLifetime: 2.4,
    gasOpacity: 0.08,
    gasRise: 0.22, // metres/second — heavy, so it rolls rather than lifts
    gasTurbulence: 0.5,
    standingGas: 0.4, // × `gasRate` once the cluster is up
    breachGasChance: 0.3, // odds a single gem puffs as it breaks through
    burstGas: 150, // extra puffs thrown at the impact
    colorGasA: '#a8c47a', // acid, at the source
    colorGasB: '#879a80',
    colorGasC: '#7b7590', // going dusty as it drifts
    colorGasD: '#1e1729',

    /* ================================================================ */
    /* 3 · DROPLETS                                                      */
    /* ================================================================ */
    dropSize: 0.075,
    dropSpeed: 6.2,
    dropLifetime: 1.7,
    dropGravity: -13.5, // they arc, which is the only thing that says liquid
    dropGlow: 1.15,
    breachDrops: 3, // flicked by each gem as it breaks the surface
    burstDrops: 130, // the fountain at the impact
    shatterDrops: 4, // thrown by each gem as it goes
    dripRate: 7, // beads/second running off the tips while it stands
    colorDropA: '#ecffb0',
    colorDropB: '#a4ff2e',
    colorDropC: '#5fb81a',
    colorDropD: '#1d3a0c',

    /* --- the airborne glitter that sells the facets --- */
    moteRate: 120,
    moteSize: 0.05,
    moteSpeed: 3.0,
    moteLifetime: 2.4,
    moteRise: 1.4, // upward drift, metres/second
    moteTurbulence: 0.6,
    moteGlow: 1.2,
    burstMotes: 170,
    shatterMotes: 3,
    colorMoteA: '#f4ffd9',
    colorMoteB: '#a8ff3c',
    colorMoteC: '#c39bff',
    colorMoteD: '#2a1046',

    /* ================================================================ */
    /* 4 · CRACKS                                                        */
    /* ================================================================ */
    /**
     * `slab*` values are fractions of the plate's own radius — see the note at
     * the top of this block. `slabCount`, `slabDepth`, `slabBias` and
     * `slabRagged` re-cut the Voronoi when they move; everything else is a
     * uniform and reshapes a plate that is already lying on the floor.
     */
    plateRadius: 3.4, // how far the break reaches, metres
    slabCount: 74, // pieces the plate is cut into
    slabDepth: 0.085, // slab thickness, × the radius
    slabBias: 0.44, // <0.5 makes the middle pieces finer
    slabRagged: 0.3, // how far the outline bites in, so it is not a disc
    slabGap: 0.055, // how far each piece shrinks from its neighbours
    slabHeave: 0.075, // how far the middle is pushed up, × the radius
    slabTilt: 0.42, // radians a piece cants over
    slabGrowth: 9.0, // how fast the fracture races outward, metres/second
    seamGlow: 0.85, // light coming up out of the break
    seamReach: 0.045, // how far it spills over the lip onto the top face
    stoneGrain: 0.7,
    stoneGrainScale: 7.0, // grain features per metre
    stoneSpeck: 0.3,
    stoneLip: 0.45, // how much lighter a fresh broken face is
    colorStone: '#8d8a86',
    colorStoneDark: '#3a3733',
    colorSeam: '#7ad42a', // the light in the crack
    colorStain: '#54761f', // venom that has run down into it

    /* --- the marks laid along the line as the seam passes --- */
    crackRate: 1.8, // marks per metre of front travel
    crackSpread: 0.85, // mark radius, × the local half-width
    crackLife: 4.0, // seconds a mark lingers
    crackWidth: 0.42, // how wide the branches are drawn
    crackIntensity: 0.3,
    colorCrackA: '#2b2620', // the burnt stone
    // Deliberately muted: the CRACK decal runs this stop at 1.8× while the glow
    // is fresh, and a hot value here throws a bright green mark across the floor
    // that reads as a sticker rather than as light in a crack.
    colorCrackB: '#27470f',

    /* ================================================================ */
    /* 5 · GLOW                                                          */
    /* ================================================================ */
    /**
     * Two shells: a tight, near-white `core*` kernel and a wide, soft `halo*`
     * that is the violet bloom separating the cluster from the floor behind it.
     * Both are drawn back-face-first so the gems standing in the light occlude
     * it and read as being *inside* it.
     */
    coreHeight: 1.15, // how far off the floor the light sits, metres
    coreSize: 0.8, // kernel radius, metres
    coreSwell: 0.35, // how small it starts, × its size
    coreFalloff: 2.4, // >1 concentrates it in the middle
    coreIntensity: 2.4,
    coreOpacity: 0.62,
    coreBillow: 0.2, // surface displacement
    coreBillowScale: 2.6,
    coreBreak: 0.45, // how much noise eats into it
    coreBreakScale: 3.0,
    coreBreakSpeed: 0.75,
    coreFlow: 0.55, // how fast the billowing drifts
    coreFlicker: 0.14,
    coreFlickerSpeed: 6.5,
    coreSoftFade: 0.55, // metres over which it fades against the gems
    coreFlare: 0.45, // seconds the arrival overshoot takes to damp out
    coreFlarePunch: 0.35, // how far past full brightness it goes
    coreHold: 0.72, // what it settles back to while the cluster stands
    coreBleed: 0.4, // how hard it lights the gems around it
    coreBleedRadius: 3.0, // metres that light carries
    colorCore: '#f6ffe8',
    colorCoreMid: '#a6ff32',
    colorCoreEdge: '#5fd11a',

    haloScale: 2.4, // × the kernel radius
    haloFalloff: 1.5,
    haloIntensity: 0.32,
    haloOpacity: 0.28,
    haloBillow: 0.16,
    haloBillowScale: 1.8,
    haloBreak: 0.55,
    colorHaloCore: '#c8ff7a',
    colorHaloMid: '#7fdc4a',
    colorHaloEdge: '#7b3fd4', // the violet the cloud is read against

    /* --- dynamic light --- */
    lightIntensity: 14,
    lightRadius: 15,
    lightWaver: 0.16, // chemical glow wavers; it does not glint
    lightColor: '#9bff45',

    /* --- the impact at the far end --- */
    burstSize: 3.8, // the shell of gas pushed ahead of the surge
    burstIntensity: 0.9,
    shockRadius: 4.2,
    impactShake: 0.72,
    impactFlash: 0.11,
    shakeDuration: 0.95,
    rumble: 0.055, // continuous shake while the seam runs
    colorBurstA: '#4e6b33',
    colorBurstB: '#8fd44a',
    colorBurstC: '#d8ffa0',
    colorShockA: '#9dff3a',
    colorShockB: '#d8ffb0',
    colorFlash: '#d6ffa8' // the full-screen flash on impact
  },

  /* ------------------------------------------------------------------ */
  /* QUAKE — the Brutalist Earth Blast                                   */
  /* ------------------------------------------------------------------ */
  /**
   * The one ability in the sandbox with nothing emissive in it.
   *
   * Everything standing is a real `MeshStandardMaterial` wearing a triplanar
   * projection of a photographic rock scan, lit by the stage's own sun and
   * casting its own shadows, and the whole read is carried by silhouette, dust
   * density and the fact that the floor visibly failed. There is therefore no
   * `colorGlow`, no `seamGlow` and no core: if the lighting is wrong here the
   * fix is in `environment`, not in a brightness slider.
   *
   * The five blocks below are the five panels of the reference breakdown, in
   * order, and each one can be taken to zero on its own to judge the others:
   * `density` empties the stone, `dustOpacity` clears the air, `shrapnelCount`
   * stops the debris, `fissureLip` flattens the scars, `warpStrength` and
   * `warpColumn` switch off the refraction.
   */
  quake: {
    /* --- the cast itself --- */
    range: 17.0, // maximum cast distance, metres
    minRange: 3.0, // closer than this and the cast is refused
    speed: 26.0, // how fast the rupture front travels, metres/second
    lifetime: 5.0, // seconds the cluster stands before it goes back down
    cooldown: 0.8, // seconds before the ability can be armed again
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* ================================================================ */
    /* 1 · MONOLITHIC RUPTURE SPIKES                                     */
    /* ================================================================ */

    /* --- the rift running out from the caster --- */
    widthNear: 0.5, // half-width of the band at the caster, metres
    width: 1.5, // half-width at the far end, metres
    widthCurve: 0.85, // <1 flares early, >1 stays narrow then opens out
    stoneCount: 96, // instances spent on one cast (capped at 280)
    density: 1.0, // multiplier on that count
    blastShare: 0.44, // fraction of them held back for the terminal cluster
    clumping: 1.4, // >1 pulls the rift toward the centre line
    scatter: 0.55, // extra lateral jitter, fraction of the local half-width
    frontBias: 0.85, // <1 crowds the rift toward the impact point
    heightNear: 0.45, // stone height at the caster, metres
    height: 1.6, // stone height just short of the impact, metres
    heightCurve: 1.5, // how late the ramp climbs
    peak: 1.5, // extra height multiplier as it reaches the impact
    peakWidth: 0.28, // how much of the line that swell covers, 0..1
    rubble: 0.45, // fraction of the rift demoted to ankle-height blocks
    lean: 0.42, // radians the rift shears back away from the front

    /* --- the cluster at the far end --- */
    blastRadius: 3.8, // how wide the cluster stands, metres
    blastHeight: 3.0, // height of a body slab at its centre, metres
    crown: 0.5, // how much shorter the skirt is than the middle, 0..1
    blastLean: 0.42, // radians a rim stone cants over
    blastLeanCurve: 0.9, // <1 cants the inner stones early too
    // The control that keeps this from being a starburst. At 0 every stone tips
    // straight away from the centre and the cluster opens like a hand — which
    // is a crystal field. Ground that was driven upward tips whichever way its
    // own fracture allowed, so the bearing is scattered off outward by this
    // many radians and only the *bias* survives.
    blastLeanScatter: 1.15,
    blastStagger: 0.13, // seconds the rim lags the middle, × its radius
    monolithShare: 0.15, // fraction that are the hero slabs
    monolithScale: 1.8, // how much taller than a body slab those are
    monolithGirth: 2.2, // and how much wider — mass is what says concrete
    blockShare: 0.42, // fraction that are the chunky skirt around the base
    blockScale: 0.4,

    /* --- an individual stone --- */
    radius: 0.8, // footprint radius, metres
    radiusJitter: 0.55,
    heightJitter: 0.55,
    leanJitter: 0.85,
    twist: 1.0, // random yaw, 0..1 of a full turn
    // The seven below re-cut the slab geometry when they move; everything else
    // in this block is a transform or a uniform and reshapes stone that is
    // already standing. See `assets/MonolithGeometry.js`.
    sides: 6, // vertices in the footprint (4-7 read best)
    taper: 0.92, // top width as a fraction of the base
    flatten: 0.68, // squash on one axis — low is a wall, 1 is a column
    chip: 0.17, // how far the footprint wanders off a clean prism
    shear: 0.2, // tilt of the top break plane — this is what says *snapped*
    bevel: 0.13, // chamfer at the break edge, which catches the key light
    stoneBend: 0.1, // lateral drift of the axis from base to top

    /* --- the eruption --- */
    riseTime: 0.17, // seconds from buried to the top of the punch
    riseOvershoot: 0.15, // how far past full height the punch carries — this is
    // the literal peak, and past ~0.25 the slab's root clears the floor on show
    riseStagger: 0.09, // seconds of random delay between neighbours
    settle: 0.3, // seconds it takes to fall back onto its seat. One drop, no
    // rebound — long enough to read as weight, short enough not to float.
    sinkDelay: 0.8, // seconds after `lifetime` before it withdraws
    sinkTime: 1.6, // seconds to go back into the floor

    /* --- the stone surface (see materials/MonolithStoneMaterial.js) --- */
    texScale: 2.6, // metres one tile of the scan covers
    texAmount: 1.0, // 0 falls back to procedural shading entirely
    normalScale: 1.2,
    stoneRough: 1.0, // gain on the sampled roughness
    stoneRoughFloor: 0.34, // ...and the minimum it may reach. Stone is not wet.
    stoneAO: 1.0, // how much of the sampled occlusion is applied
    envIntensity: 1.0, // how much of the HDR probe the stone catches
    breakPale: 0.5, // how much paler an unweathered fracture face is
    grime: 0.55, // vertical streaking on the faces that *were* exposed
    damp: 0.6, // how dark the root is — it came from under the floor
    dampHeight: 0.24, // how far up the stone that reaches, 0..1
    // The cloud coming back down onto everything it was thrown off. Held at
    // zero for `coatDelay` first: stone that is pale the instant it appears
    // never reads as having *just* broken.
    dustCoat: 0.5, // how far the coating goes at full settle
    dustCoatSharp: 1.5, // >1 confines it to genuinely up-facing surfaces
    dustCoatScale: 1.2, // patchiness, features per metre
    coatDelay: 0.35, // seconds after the impact before it starts
    coatTime: 2.2, // seconds it takes to build
    // The scan is a natural rock and reads faintly olive; brutalist concrete is
    // neutral. `stoneDesat` pulls the albedo toward its own luminance and
    // `stoneGrade` tints what is left, luminance-preserving, so neither one
    // darkens the stone. Both at 0 gives the raw scan.
    stoneDesat: 0.35,
    stoneGrade: 0.4,
    colorStoneGrade: '#c7c4be',
    colorStone: '#9a948a', // the procedural fallback's light value
    colorStoneDeep: '#3d3a35', // ...and its dark one
    colorDustCoat: '#cfc6b3',
    colorDamp: '#241f1b',

    /* ================================================================ */
    /* 2 · CEMENT DUST SHOCKWAVE                                         */
    /* ================================================================ */
    /**
     * Sampled over the particle's own lifetime: `A` the instant it is born, `D`
     * as it dies. Non-additive and lit, so the cloud genuinely occludes the
     * slabs and takes the key light on one side — an additive version of this
     * is a pale haze the monoliths shine through, and the blast loses all of
     * its depth.
     */
    dustRate: 260, // particles/second along the front
    dustSize: 1.2,
    dustSpread: 2.4, // how much bigger a puff gets over its life
    dustSpeed: 1.6,
    dustLifetime: 3.4,
    dustOpacity: 0.045,
    dustRise: -0.12, // NEGATIVE. Cement dust is heavy: it hangs, then falls.
    dustTurbulence: 0.85,
    dustDrag: 1.6,
    breachDust: 3, // thrown by each stone as it breaks the surface
    settleDust: 0.4, // × `dustRate` once the cluster is standing
    plumeDust: 60, // the column that climbs behind the ring
    plumeSpeed: 4.5,
    colorDustA: '#a79d8b', // freshly pulverised, catching the sky
    colorDustB: '#7d7469',
    colorDustC: '#5c564d',
    colorDustD: '#2a2823',

    /* --- the ring that rolls out along the ground --- */
    /**
     * Emitted as a ring of jets whose radius grows at its own metres-per-second,
     * each firing outward along its own bearing, so the cloud stays *hollow* in
     * the middle. That hollow is the entire read: a sphere of smoke expanding
     * from a point is a fireball, a torus rolling outward with the plume
     * climbing behind it is a demolition.
     */
    ringRate: 300, // particles/second across the whole ring
    ringJets: 20, // emission points around it
    ringRadius: 8.0, // how far the wavefront reaches, metres
    ringSpeed: 7.0, // outward speed of the dust itself, metres/second
    ringLift: 0.22, // upward share of that. Past ~0.5 it becomes a mushroom.
    ringSize: 1.5,
    ringThickness: 0.6, // depth of the emitting band, metres
    ringTime: 0.9, // seconds the roll lasts

    /* ================================================================ */
    /* 3 · GEOMETRIC SHRAPNEL                                            */
    /* ================================================================ */
    /**
     * Real instanced rock on a ballistic arc, not billboards: it tumbles, it
     * bounces off the floor, it loses energy to friction and it is *left lying
     * there*. The ground keeping the debris is half of why the aftermath reads.
     */
    shrapnelCount: 70, // chunks thrown by the blast (capped at 96)
    shrapnelSize: 0.28, // radius of one chunk, metres
    shrapnelSizeJitter: 0.55,
    shrapnelSpeed: 12.0, // launch speed, metres/second
    shrapnelSpread: 1.0, // outward share of the launch cone
    shrapnelLift: 0.75, // upward share of it
    shrapnelGravity: -19.0,
    shrapnelSpin: 9.0, // radians/second of tumble
    shrapnelBounce: 0.32, // restitution off the floor
    shrapnelFriction: 0.55, // how much lateral speed a bounce keeps
    shrapnelPuffSpeed: 3.5, // impact speed above which a landing kicks up dust
    shrapnelDarken: 0.35, // seen against the cloud, debris is near silhouette
    shrapnelTexScale: 0.35, // × `texScale` — a chunk needs the grain read finer

    /* --- the fine stuff the big chunks leave behind --- */
    gritRate: 90, // chips/second along the front
    gritSize: 0.05,
    gritSpeed: 5.5,
    gritGravity: -22.0, // they arc hard, which is the only thing that says mass
    gritLifetime: 1.5,
    breachGrit: 4, // flicked by each stone as it breaks the surface
    blastGrit: 140, // thrown at the impact
    trickleRate: 12, // chips/second running off the faces while it stands
    colorGritA: '#9c9384',
    colorGritB: '#6e685c',
    colorGritC: '#403c34',
    colorGritD: '#22201c',

    /* --- the powder still hanging once the cloud has rolled past --- */
    moteRate: 45,
    moteSize: 0.1,
    moteLifetime: 4.5,
    moteFall: -0.18, // metres/second — it settles, it does not rise
    moteTurbulence: 0.5,
    moteGlow: 0.3, // this is sunlight caught in dust, not a glow. Keep it low.
    moteOpacity: 0.07,
    blastMotes: 70,
    colorMoteA: '#efe6d2',
    colorMoteB: '#c8bda6',
    colorMoteC: '#8d8574',
    colorMoteD: '#2c2a25',

    /* ================================================================ */
    /* 4 · DEEP FISSURE SCARS                                            */
    /* ================================================================ */
    /**
     * `plate*` values are fractions of the crater's own radius. `plateCells`,
     * `plateDepth`, `plateBias` and `plateRagged` re-cut the Voronoi when they
     * move; everything else is a uniform and reshapes a crater already lying on
     * the floor.
     */
    craterRadius: 4.2, // how far the broken plate reaches, metres
    plateCells: 64, // pieces it is cut into
    plateDepth: 0.09, // slab thickness, × the radius
    plateBias: 0.42, // <0.5 makes the middle pieces finer
    plateRagged: 0.26, // how far the outline bites in, so it is not a disc
    plateGap: 0.05, // how far each piece shrinks from its neighbours
    plateHeave: 0.085, // how far the middle is pushed up, × the radius
    plateTilt: 0.5, // radians a piece cants over
    plateGrowth: 11.0, // how fast the fracture races outward, metres/second
    plateWallDark: 0.85, // how black the bottom of an exposed wall goes
    plateSeamDust: 0.2, // powder drifted along the seams
    plateCoat: 0.5, // its share of the settled dust — see the note in the ability

    /* --- the cracks racing out past the crater --- */
    fissureRadius: 8.5, // how far the scarring reaches, metres
    fissureLife: 9.0, // seconds it lingers — the ground stays broken
    fissureArms: 7, // main cracks radiating from the impact
    fissureWander: 1.1, // how hard an arm veers, radians per unit walked
    fissureWidth: 0.5, // width of the ribbon the crack is drawn on, metres
    fissureBranches: 0.8, // fraction of the generated forks kept
    fissureBranchLength: 0.85,
    fissureOpen: 0.55, // how much of that ribbon is the opening itself, 0..1
    fissureLip: 0.22, // strength of the pale dust rim beside it
    fissureDepth: 0.85, // how black the middle of the opening goes
    fissureBreak: 0.45, // how hard noise eats into both edges
    fissureBreakScale: 1.8,
    fissureGrowth: 18.0, // how fast the cracks race out, metres/second
    colorFissure: '#141210', // the dark in the crack
    colorFissureLip: '#6f695d', // powdered stone along its edges

    /* --- the marks laid along the line as the rift passes --- */
    scarRate: 1.4, // marks per metre of front travel
    scarSpread: 1.6, // mark radius, × the local half-width
    scarLife: 8.0, // seconds a mark lingers
    scarWidth: 0.45, // how wide the branches are drawn
    scarIntensity: 0.22,
    colorScarA: '#231f1a', // the broken stone
    // Deliberately muted: the CRACK decal runs this stop at 1.8x while the mark
    // is fresh, and a hot value here throws a bright smear across the floor that
    // reads as a sticker rather than as a crack.
    colorScarB: '#3e3931',

    /* ================================================================ */
    /* 5 · KINETIC AIR DISTORTION                                        */
    /* ================================================================ */
    /**
     * Written into the refraction buffer rather than drawn — see
     * `effects/KineticWarp.js`. The ring's offset is genuinely radial, so the
     * frame is stretched away from the epicentre along the wavefront instead of
     * just shivering. Both of these ride `post.distortion`, so that master gain
     * is the first thing to check if nothing appears to be happening.
     */
    warpLife: 1.1, // seconds the whole effect lasts
    warpRadius: 9.0, // how far the pressure ring travels, metres
    warpThickness: 0.8, // depth of the wave packet, metres
    warpRipples: 6.5, // bands inside it
    warpChop: 0.4, // how far the wavefront is broken off a circle, metres
    warpChopScale: 2.6,
    warpStrength: 0.45,
    warpColumn: 0.3, // the churning air standing over the blast
    warpColumnWidth: 5.0,
    warpColumnHeight: 4.0,
    warpScale: 1.5, // features per metre in that churn
    warpSpeed: 2.6, // how fast it climbs

    /* ================================================================ */
    /* The impact, the camera and the light                              */
    /* ================================================================ */
    shockRadius: 6.5,
    impactShake: 0.95,
    shakeDuration: 1.5,
    // Barely a flash: nothing here is burning. What little there is reads as
    // the frame being punched, not as light being made.
    impactFlash: 0.045,
    rumble: 0.075, // continuous shake while the rift runs
    colorShockA: '#d8cfbd',
    colorShockB: '#8d8578',
    colorFlash: '#e8e0d0',

    /* --- dynamic light --- */
    // A warm bounce off the dust rather than a source: without it the cluster
    // is lit by the stage alone and the near faces go to silhouette. Keep it
    // dim — the moment this reads as a *glow* the ability stops being geology.
    lightIntensity: 9,
    lightRadius: 16,
    lightSettle: 0.5, // how far it falls as the cloud thins
    lightColor: '#c9b596'
  },

  /* ------------------------------------------------------------------ */
  /* Ink — the Sumi Tide                                                 */
  /* ------------------------------------------------------------------ */
  /**
   * A brush-painted flood: white paper soaks into the stone, black ink bleeds
   * across it, a wall of water stands up around the boundary, and everything
   * inside the circle is wound into a vortex and pulled under.
   *
   * The block is ordered the way the effect is built, one group per pass —
   * paper, ink, water, throat, brush ripples, splatter, the crown, the column,
   * the suspended ink, the refraction, the particles, and the grip that takes
   * hold of the bodies. Every one of them is resolved per frame, so dragging
   * `zoneRadius` re-floods a tide that is already standing.
   */
  ink: {
    /* --- the cast --- */
    range: 22.0, // maximum cast distance, metres
    minRange: 0.0, // it is a zone: dropping it on your own feet is allowed
    zoneRadius: 5.0, // the footprint — what the circle indicator measures out
    speed: 74.0, // how fast the stroke runs to the point, metres/second
    floodTime: 0.55, // seconds the water takes to fill the circle
    drainTime: 1.15, // seconds after the flood before the throat opens
    lifetime: 5.4, // seconds it stands
    fadeTime: 2.0, // seconds the water takes to drain back
    cooldown: 2.8,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the swell: the irregular pulse every pass is driven off --- */
    /**
     * Water does not spike the way a chemical reaction does — it *heaves*. So
     * unlike the Caustic Bloom's boil this envelope is deliberately smooth: two
     * incommensurate sines, barely sharpened, which gives a long swell with no
     * period inside a cast. Crossing `tideThreshold` on the way up launches a
     * ripple, so the rings on the surface are not free-running — they are the
     * visible half of the same envelope that is turning the vortex.
     */
    swellRate: 1.15, // how fast the envelope runs
    swellSharp: 1.35, // >1 leans it toward the troughs
    swellDepth: 0.75, // how hard it modulates everything, 0 = flat
    tideThreshold: 0.62, // the level a swell has to cross to launch a ripple
    tideRipple: 0.9, // brightness of the ring it throws
    tideSpray: 34, // droplets thrown off the crown when it heaves
    tideShake: 0.022, // the knock on the camera

    /* --- where the stroke leaves the caster --- */
    handHeight: 1.12, // metres above the floor
    handForward: 0.62, // metres in front of the caster
    handSide: -0.14, // metres to the side (+ follows `Ability#side`)
    trailInk: 46, // ink flecks per metre of the stroke
    trailSpray: 18, // and the spray coming off it

    /* --- the paper wash --- */
    /**
     * The sheet the whole thing is painted on, and the one pass that has to
     * land *before* anything else can read as ink: black on granite is a scorch
     * mark, black on paper is a brush stroke, and the difference between those
     * two readings is this wash and nothing else.
     *
     * Its edge is deckled rather than circular and it is eaten by the paper's
     * own tooth, so the sheet looks torn and laid down rather than projected.
     */
    washRadius: 1.24, // how far past the footprint the paper reaches, × radius
    washOpacity: 0.7,
    washBleed: 0.34, // metres the edge feathers over
    washDeckle: 0.42, // how far the outline wanders — a torn edge
    washDeckleScale: 2.6,
    washTooth: 0.42, // the paper grain eating into the wash
    washToothScale: 5.5, // tooth features per metre
    washFibre: 0.3, // long fibres pressed into the sheet
    washFibreScale: 1.8,
    washDry: 0.55, // how much of it survives once the water has gone

    /* --- the ink --- */
    /**
     * Watercolour, not paint. Three things carry it and they are all physical:
     * the boundary grows *dendritic* fingers where pigment wicks along the wet
     * fibres; the drying rim is **darker** than the middle, because pigment is
     * carried outward and stranded there; and the pigment **granulates**,
     * settling into the tooth of the paper as a fine mottle. Take those three
     * out and what is left is a black disc with a soft edge.
     */
    inkRadius: 1.0, // × footprint
    inkOpacity: 1.0,
    inkFeather: 0.42, // metres the edge feathers over
    inkTendril: 0.55, // how far the wicking fingers reach
    inkTendrilScale: 1.9, // fingers per radian of bearing
    inkEdge: 0.85, // the dark rim stranded at the drying edge
    inkEdgeWidth: 0.5, // metres it is wide
    granulation: 0.7, // pigment settling into the tooth
    granulationScale: 6.5, // per metre
    // Pigment sits under the skin of the water, where the vortex is tighter, so
    // the veil is wound harder than the waves above it. At 1 the two turn
    // together and the pool flattens back into one rotating plate.
    inkSwirl: 1.6, // × the surface's winding
    inkVeil: 1.15, // ink suspended in the water, drawn as spiral filaments
    inkVeilScale: 0.55, // features per metre
    inkVeilSharp: 3.0, // >1 tears the veil into separate strands

    /* --- the water standing in it --- */
    waterOpacity: 0.86,
    waterDepth: 0.9, // how fast it darkens toward the middle
    ripple: 0.03, // amplitude of the surface waves, metres
    rippleScale: 1.15, // waves per metre
    rippleSpeed: 0.9,
    chop: 0.28, // the fine chop laid over them
    chopScale: 3.2,
    sheen: 0.3, // the specular lobe — what says *water* before anything else
    gloss: 0.7, // 0 = broad and dull, 1 = a tight highlight
    caustic: 0.22, // interference on the surface
    causticScale: 2.4,
    causticSpeed: 0.55,
    rimFoam: 0.55, // foam gathered against the boundary
    rimFoamWidth: 0.4, // metres

    /* --- the throat --- */
    /**
     * The hole the vortex opens in the middle, and the only pass here that is
     * about the *mechanic* rather than the look: it opens on the same clock the
     * grip starts pulling on, so the thing the bodies are being dragged into is
     * visibly there before they reach it.
     */
    throatSize: 0.3, // × footprint
    throatDepth: 0.9, // how black it goes
    throatLip: 0.28, // the sheared bright lip around it, metres
    throatSpin: 1.5, // revolutions/second the whole vortex turns

    /* --- the brush ripples --- */
    /**
     * Sumi-e rings, not water rings: a stroke has a loaded start, a dry-brush
     * middle where the bristles skip off the tooth of the paper, and a tapered
     * lift at the end. `ringBristle` is the whole difference — a ring with no
     * skips in it is a circle, and a circle reads as UI.
     */
    rings: 6, // how many are in flight at once
    ringSpeed: 0.42, // radii per second
    ringWidth: 0.17, // metres, at birth
    ringTaper: 0.55, // how much thinner it gets as it travels
    ringInk: 1.0, // how black the stroke is
    ringFoam: 0.55, // the white lifted along its leading edge
    ringBristle: 0.7, // dry-brush skips
    ringBristleScale: 9.0, // skips per radian
    ringWobble: 0.09, // how far the radius wanders, × radius
    ringWobbleScale: 2.4,
    ringReach: 1.7, // how far out they run, × footprint

    /* --- the splatter --- */
    /**
     * Flecks thrown clear of the stroke and dried on the paper. Each is drawn
     * out along its own bearing with a tail and a satellite, which is what a
     * drop of ink off a moving brush actually leaves — a round dot reads as a
     * particle that stopped.
     */
    splatter: 0.4, // fraction of cells that carry a fleck
    splatterScale: 0.95, // cells per metre
    splatterSize: 0.5, // × cell
    splatterTail: 2.2, // how far a fleck is drawn out along its bearing
    splatterSpread: 1.1, // how far past the wash they are thrown, × radius

    /* --- rendering the floor --- */
    poolHeight: 0.024, // hover distance above the floor, metres
    poolOpacity: 1.0,
    colorPaper: '#ded8c9', // the sheet
    colorPaperShade: '#8f8a7c', // its tooth, in shadow
    colorInk: '#05070b', // the pigment
    colorInkWash: '#101f26', // ink thinned into the water
    colorWater: '#134b55',
    colorWaterDeep: '#04141b',
    colorFoam: '#e6f4f1',
    colorRim: '#8fd8d0',

    /* --- the crown --- */
    /**
     * The wall of water standing at the boundary — the milk-crown the reference
     * sheet is built around. A lathe whose vertex stage is the whole shape: the
     * rim is scalloped into fingers, the fingers lean out as they fall, and the
     * crest is *torn* by a threshold that climbs, so the top breaks into spray
     * instead of ending on a clean line.
     */
    crownHeight: 1.85, // metres at its tallest
    crownRise: 0.28, // seconds to stand up
    crownFall: 2.2, // seconds to fall back
    crownFingers: 26, // scallops around the rim
    crownFingerDepth: 0.62, // how deep they cut
    crownFlare: 0.1, // how far the wall leans out over its height
    crownCurl: 0.1, // how far the crest curls back in
    crownLean: 0.16, // extra lean once it starts to fall
    crownWobble: 0.06, // how far the radius wanders, × radius
    crownWobbleScale: 2.8,
    crownSpin: 0.1, // revolutions/second the scallops travel
    crownTear: 0.8, // how hard the crest is torn into spray
    crownTearScale: 4.6,
    crownFoam: 0.85, // the white on the crest
    crownFresnel: 1.7, // the rim light down the wall — this is a *scale*
    crownStreak: 0.7, // ink running down the inside face
    crownStreakScale: 5.5,
    crownInk: 0.7, // how much of the wall is stained
    crownOpacity: 1.0,
    crownGlow: 1.0,
    crownSoftFade: 0.5, // metres it softens against the scene

    /* --- the column --- */
    /**
     * The jet up the middle: wide at the foot, pinched at the neck, swollen
     * into a head that comes apart into droplets. It stands on impact, holds
     * while the throat opens under it, then falls back into it — which is the
     * beat that turns a splash into a drain.
     */
    columnHeight: 3.6, // metres
    columnRise: 0.22, // seconds to full height
    columnHold: 0.55, // seconds it stands before it collapses
    columnFall: 1.3, // seconds to fall back
    columnFoot: 0.42, // radius at the floor, × footprint
    columnNeck: 0.15, // at the pinch
    columnHead: 0.3, // at the crown of the jet
    columnWobble: 0.14, // how far it wanders off plumb
    columnWobbleScale: 2.2,
    columnSpin: 0.35, // revolutions/second it turns on the way up
    columnTear: 0.55, // how hard the head is torn into droplets
    columnInk: 1.0, // how black the jet is — this is ink, not water
    columnFoam: 0.5,
    columnFresnel: 0.9,
    columnOpacity: 0.95,

    /* --- the suspended ink --- */
    /**
     * A raymarched volume, and the one pass here that cannot be faked with
     * billboards: ink hanging in the water column, wound around the vortex,
     * *absorbing* the frame rather than adding to it. `wispSteps` is the whole
     * performance dial, and is a live slider for exactly that reason.
     */
    wispHeight: 3.2, // how far up the ink hangs, metres
    wispSteps: 24, // samples per pixel through the volume
    wispDensity: 3.4,
    wispAbsorb: 1.75, // how fast it goes opaque along the ray
    wispScale: 0.62, // features per metre
    wispDetail: 2.2, // frequency of the filament layer
    wispFilament: 0.62, // how much of it is strands rather than clouds
    wispThreshold: 0.48, // below this there is simply no ink
    wispRise: 0.35, // how fast the field climbs
    wispStretch: 0.55, // <1 elongates it vertically
    wispTwist: 2.4, // radians the column turns over its height
    wispSpin: 0.14, // revolutions/second the whole volume turns
    wispWind: 1.6, // extra turn near the axis — a vortex, not a spin
    wispFunnel: 0.55, // how far the middle is hollowed out
    wispEdge: 0.5, // where the wall starts to soften, × radius
    wispFlare: 0.3, // how far it opens with height
    wispSkirt: 0.12, // how far it spills past the boundary at the floor
    wispFalloff: 1.35, // how fast it thins toward the top
    wispLobe: 0.3, // how far the wall wanders
    wispTear: 0.3, // how much harder the top is carved
    wispLight: 0.85, // the sun coming down through the water
    wispShadow: 2.6, // self-shadowing
    wispShadowStep: 0.8, // metres to the shadow tap
    wispAmbient: 0.08,
    wispSaturate: 2.4, // how much thick ink deepens
    wispOpacity: 1.0,
    /**
     * How far the ink stands back from a body the tide is holding.
     *
     * The volume is clipped against the depth prepass, so it never draws over
     * anything *behind* it — but a body wound into the middle has metres of
     * pigment between it and the camera, all of it legitimately in front, and
     * that is what used to swallow the spiral whole. This opens the near half
     * of the rays that pass through a held body and lets the ink close again
     * behind it, so the corpse is seen *through* a parting rather than in a
     * tube cut out of the volume. At 0 the ink ignores them, which is the old
     * behaviour; much past 0.9 and the parting starts to read as a hole.
     */
    wispClear: 0.85,
    wispClearSize: 1.15, // metres of ink one body moves
    wispClearFade: 1.1, // metres it closes over, behind the body
    colorWispDeep: '#04070a', // thick ink, in the middle of a strand
    colorWispBody: '#12363d',
    colorWispEdge: '#4e8f92', // thin ink, at its edges
    colorWispLight: '#bfe6e0', // daylight through the water

    /* --- the surface refraction --- */
    /**
     * The water bends the frame. The proxy is the *floor*, not a camera-facing
     * card: the offsets are read off the same ripple field the surface is shaded
     * with, so what the warp does and what the water looks like cannot drift
     * apart.
     */
    warpStrength: 1.15,
    warpRipple: 0.85, // how much of it comes from the visible rings
    warpScale: 1.6, // chop features per metre
    warpSpeed: 0.7,

    /* --- particles --- */
    dropletRate: 90, // droplets thrown off the crown, per second
    dropletSpeed: 3.6,
    dropletLifetime: 1.15,
    dropletSize: 0.075,
    colorDropletA: '#e8f6f3',
    colorDropletB: '#8ecfc9',
    colorDropletC: '#1d4d55',
    colorDropletD: '#0a1f26',

    sprayRate: 60, // fine atomised spray off the crest
    spraySpeed: 2.2,
    sprayLifetime: 0.9,
    spraySize: 0.11,
    colorSprayA: '#ffffff',
    colorSprayB: '#cfeae6',
    colorSprayC: '#6ba9a6',
    colorSprayD: '#28494f',

    fleckRate: 44, // flecks of pigment thrown clear
    fleckSpeed: 2.9,
    fleckLifetime: 1.5,
    fleckSize: 0.09,
    colorFleckA: '#26383d',
    colorFleckB: '#0d171c',
    colorFleckC: '#05080b',
    colorFleckD: '#04060a',

    hazeRate: 22, // the low haze hugging the surface
    hazeSpeed: 0.7,
    hazeLifetime: 2.4,
    hazeSize: 1.05,
    colorHazeA: '#9fc4c2',
    colorHazeB: '#5c8d8f',
    colorHazeC: '#22454c',
    colorHazeD: '#0b1b21',

    /* --- the grip: what the tide does to a body --- */
    /**
     * The one ability on this stage that does not simply *hit* what is standing
     * in it. Everything caught in the circle — on its feet or already down — is
     * taken hold of, wound around the throat and pulled under, and these are the
     * numbers that decide how that reads. See `SumiTideAbility#_drag`.
     */
    grip: {
      // Speeds the water travels at, not forces it applies: the body is
      // steered toward this velocity rather than pushed with an acceleration,
      // which is the only formulation that stays stable when the frame is long
      // and the solver's substeps are not. See `SumiTideAbility#_drag`.
      //
      // `swirl` against `flow` is the whole shape of the swallow, and `swirl`
      // has to be much the larger of the two. The inward pull only has to get a
      // body to the middle; the tangential current is what makes the trip worth
      // watching, and the trip has to happen out on the open water — the middle
      // of this thing is a jet, a volume of ink and a throat, so a body that
      // crosses the circle in a second arrives at the one place nobody can see
      // it and disappears. Wind `flow` up past `swirl` and what is left is a
      // plughole.
      flow: 1.7, // metres/second inward, at the boundary — a real drift speed
      swirl: 6.4, // metres/second tangential, at the edge of the throat — the peak
      tumble: 0.7, // revolutions/second a body turns about its *own* axis
      windUp: 0.55, // seconds the current takes to get its hands on a body
      // How hard the water holds a body to its wind-in schedule, per second —
      // the one number that decides whether the spiral *arrives*. A current
      // alone does not: steering toward a velocity slips against the `v² / r`
      // an orbit costs, and a body left to `flow` and `swirl` parks on the ring
      // where the two cancel and turns there until the tide drains. This closes
      // that loop, so `spiral` below means what it says. Under about 2 the
      // outward drift starts winning again near the axis; much over 6 and the
      // body is dragged in on a straight line rather than wound.
      winch: 4.0,
      // The water has to lift a body off the stone before it can turn it: the
      // solver scrubs the slide off any joint touching the floor, so a corpse
      // lying on it cannot be spun at all. `wade` is how far the floor drops to
      // let that happen and `float` is where the buoyancy then holds the body,
      // which is the surface — this is a body floating in a whirlpool, not one
      // hovering over one.
      wade: 0.45, // metres the floor drops as the water takes hold
      // High enough that the body breaks the surface it is turning on. The
      // circle is a bowl with a metre of standing water around its rim and a
      // jet up its middle: a corpse held *at* the surface is a corpse behind
      // all of that, and the turn nobody can see may as well not happen.
      float: 0.8, // metres above the floor the water carries the body at, at the rim
      // ... and how much higher than that it rides at the axis.
      //
      // The lip of a vortex's throat is a raised ridge of water turning fast,
      // so a body wound into the middle comes *up* — and it has to, because
      // the middle is the one place where the jet, the crown's near wall and
      // the near half of the ink funnel are all between it and the camera.
      // This ran the other way for a while (the body was let down forty per
      // cent as it arrived) and the end of the spiral, which is the whole
      // point of the ability, was the part nobody could see.
      crest: 0.55, // × `float`, at the axis
      buoy: 3.4, // how hard it is held there, per second
      rise: 1.6, // ... and the fastest it may be moved to get there, m/s
      // Seconds the water takes to walk a body from wherever it caught it to
      // the axis, and now the actual schedule rather than a patience clock —
      // `winch` above is what holds the body to it. Long enough that the trip
      // is the ability and short enough that it finishes inside `lifetime`
      // with room for the descent: windUp + spiral + depth/sink has to fit.
      spiral: 2.2,
      sink: 2.4, // metres/second down, once the throat has it
      grab: 3.4, // how fast a body matches the water, per second
      // Every body gets its moment on the surface, wherever it was caught. One
      // standing on the point the tide lands has no spiral to make, and without
      // this it would be swallowed on arrival — the turn is the ability.
      hold: 1.1, // seconds a body turns on the surface before it may go under
      depth: 3.2, // metres it is allowed to fall below the floor
      // The blow, and it is deliberately **nothing**. This is the one ability
      // on the stage that does not hit what is standing in it: the water takes
      // hold. `kill` here exists to hand the body to the solver — to make it a
      // ragdoll — and the current above is what then turns it and walks it to
      // the axis. Any impulse at all fights that. A body thrown up and inward
      // on the frame the tide lands has been *kicked* into the circle, spends
      // the first half second on a ballistic arc no current is steering, and
      // arrives somewhere the spiral schedule did not put it — which reads as
      // a knockback with a whirlpool painted over it rather than as a body
      // swallowed by one. Left at zero the body simply goes limp where it
      // stood, and the flood catches it half way down.
      lift: 0.0, // metres/second the blow throws it up as it is taken
      impulse: 0.0, // ... and inward
      spin: 0.0, // extra impulse per body-height above the hips — the torque
      splashDroplets: 40, // thrown when a body breaks the surface
      splashSpray: 30,
      splashFoam: 0.85, // brightness of the ring it leaves
      splashShake: 0.05
    },

    /* --- the impact --- */
    burstSize: 2.6, // the dome of spray thrown as the water lands
    burstIntensity: 0.85,
    shockRadius: 7.5, // the ring that snaps out past the boundary
    stainRadius: 4.6, // the mark left on the floor
    stainLife: 7.0,
    stainIntensity: 0.7,
    floodShake: 0.55,
    shakeDuration: 0.5,
    floodFlash: 0.05, // kept low: this ability is *dark*, it does not flare
    rumble: 0.06, // continuous shake while the stroke runs
    holdShake: 0.05, // ... and while the vortex turns
    colorShockA: '#dff2ef',
    colorShockB: '#3d777c',
    colorStain: '#0a1418',
    colorFlash: '#cfe8e6',
    colorBurstA: '#eaf7f4',
    colorBurstB: '#4f9298',
    colorBurstC: '#0b2026',

    /* --- dynamic light --- */
    /**
     * Cold, low and dim. The tide is the darkest thing in the set and the light
     * is here to *shape* the crown, not to make the pool glow — push it and the
     * black ink turns into teal plastic.
     */
    lightIntensity: 7.5,
    lightRadius: 15,
    lightHeight: 0.35, // × the crown's height
    lightSwell: 0.55, // how much of the light the swell owns
    lightColor: '#7fd6cf'
  },

  /* ------------------------------------------------------------------ */
  /* Astral Void Blast — the black hole                                  */
  /* ------------------------------------------------------------------ */
  /**
   * A singularity thrown to the aimed circle, which inflates, collapses, and
   * takes the room with it. Five passes, one per panel of the reference sheet,
   * and every one of them is measured against the two numbers at the top:
   * `coreRadius` (the shadow) and `zoneRadius` (the footprint). Almost nothing
   * below is an absolute metre — the ring is in horizon radii, the gas cavity
   * is in horizon radii, the shard field is in footprints — so dragging either
   * of those re-scales the whole ability, mid-cast, in proportion.
   *
   * @see abilities/AstralVoidAbility.js
   */
  astral: {
    /* --- the cast --- */
    range: 24.0, // maximum cast distance, metres
    minRange: 0.0, // it is a zone: dropping it on your own feet is allowed
    zoneRadius: 5.5, // the footprint — what the circle indicator measures out
    speed: 68.0, // how fast the seed travels to the point, metres/second
    lifetime: 4.6, // seconds the hole stands and feeds
    fadeTime: 2.0, // seconds it takes to close on itself
    cooldown: 4.0,
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the seed leaves the caster --- */
    handHeight: 1.15, // metres above the floor
    handForward: 0.68, // metres in front of the caster
    handSide: -0.12, // metres to the side (+ follows `Ability#side`)
    trailStars: 40, // stars per metre of the throw

    /* --- layer 1: the singularity core --- */
    /**
     * The shadow, and the two beats that open the ability: it arrives
     * over-inflated (`coreBloom`) and then **snaps shut** (`corePinch`), and it
     * is the snap that fires the blast rather than the landing. A hole that is
     * simply *there* on the frame it arrives has nothing to collapse.
     */
    coreRadius: 1.05, // the settled shadow, metres
    coreHeight: 3.4, // how far off the floor it hangs — a body has to be *lifted* in
    seedSize: 0.16, // × coreRadius, while it is still travelling
    coreSwell: 0.34, // seconds it takes to inflate
    coreBloom: 2.1, // × coreRadius at the top of that inflation
    corePinch: 0.16, // seconds the collapse takes
    burstTime: 0.5, // seconds the nebula takes to reach full size

    /* --- the photon ring and the lensed halo --- */
    /**
     * The ring is only a few pixels wide and it is the brightest thing in the
     * ability: it is where light that orbited the hole piles up, and it is most
     * of the reason the shot reads as photographed. `ringBeam` is the
     * asymmetry — the limb sweeping toward the camera is brighter than the one
     * sweeping away, which is what says the thing is turning at speed.
     */
    haloReach: 7.5, // how far the halo is drawn, × the horizon
    ringWidth: 0.042, // thickness of the photon ring, in horizon radii
    ringGlow: 9,
    ringBeam: 0.75, // how hard one side is beamed, 0 = evenly lit
    ringSpin: 0.22, // revolutions/second the beamed side travels
    haloGlow: 1.15,
    haloFalloff: 2.4, // how fast the halo dies outward
    haloWind: 2.4, // differential winding — inner strands lap outer ones
    haloSpin: 0.3, // revolutions/second the whole halo turns
    haloFilament: 0.7, // how far it is torn into strands
    haloFilamentScale: 2.2,
    colorPhoton: '#ffe9b8', // the ring
    colorHalo: '#c98cff', // lensed light near it
    colorHaloCool: '#3a1c72', // ... and out at the reach

    /* --- layer 2: the lens --- */
    /**
     * A real screen-space warp on LAYER.DISTORTION, so what it bends is the
     * whole finished frame — the stage, the character, and this ability's own
     * other four layers.
     *
     * `lensBend` is a fraction of the hole's **apparent** radius, measured per
     * frame — not a slice of the screen. Authored in screen widths it would be
     * two different effects at two camera distances: invisible from across the
     * arena, and strong enough up close that the radial remap folds the image
     * back over itself and prints concentric mirrored rings around the hole.
     */
    lensReach: 16.0, // how far the warp is drawn, × the horizon
    lensBend: 0.45, // deflection at the photon ring, × the hole's own radius
    lensDrag: 0.3, // how much of it is tangential — frame dragging

    /* --- layer 3: the astral nebula --- */
    /**
     * The payload. A raymarched, oblate, differentially sheared cloud: deep
     * cosmic purple in the body, gold in the throat, wound into arms that
     * spiral in. `nebulaSteps` is the whole performance dial and is a live
     * slider for exactly that reason.
     *
     * The three that carry the look, in order: `nebulaWind` (the shear that
     * makes the arms spiral at all), `nebulaFlatten` (a disc rather than a
     * ball — everything that falls into something ends up in a plane), and
     * `nebulaSpikes` (the golden spears, which are angular rather than noise,
     * so they read as rays instead of blobs).
     */
    nebulaRadius: 8.5, // how far the gas reaches, metres
    nebulaCavity: 2.5, // the clear eye around the shadow, × the horizon
    nebulaSteps: 34, // samples per pixel through the cloud
    nebulaDensity: 2.4,
    nebulaAbsorb: 0.5, // how fast it goes opaque along the ray
    nebulaGlow: 1.15,
    nebulaScale: 0.34, // features per metre
    nebulaDetail: 2.3, // frequency of the filament layer
    nebulaFilament: 0.62, // how much of it is strands rather than clouds
    nebulaThreshold: 0.5, // below this there is simply no gas
    nebulaEdge: 0.7, // where the outer wall starts to soften, × the reach
    nebulaFlatten: 0.6, // <1 squashes the cloud into a disc
    nebulaArms: 3, // spiral arms
    nebulaArmSharp: 1.5, // how tightly they are cut
    nebulaArmWeight: 0.68, // how much of the density they own
    nebulaWind: 2.4, // differential winding — the spiral itself
    nebulaTwist: 1.6, // extra turn with height
    nebulaSpin: 0.2, // revolutions/second the whole field turns
    nebulaRise: 0.35, // how fast the field climbs
    nebulaSpikes: 9, // the golden spears
    nebulaSpikeSharp: 9, // how narrow they are
    nebulaSpikeReach: 0.95, // how far out they carry, × the reach
    nebulaSpikeGlow: 0.7,
    nebulaHeatFalloff: 2.1, // how fast gold cools to violet outward
    nebulaBeam: 0.3, // doppler beaming
    nebulaOpacity: 1.0,
    colorNebulaEdge: '#2e1558', // thin gas, out at the reach
    colorNebulaBody: '#8b46f0',
    colorNebulaHot: '#ffb03a',
    colorNebulaCore: '#fff3d0', // the throat

    /* --- layer 4: the void-shards --- */
    /**
     * Crystalline debris thrown clear and immediately caught. The orbit is
     * closed-form so the editor can re-throw a field that is already falling:
     * the radius decays as a two-thirds power, which makes the winding
     * integrate to a logarithm, so a shard turns faster and faster the further
     * in it gets and its last half-metre is a blur.
     */
    shardSize: 0.5, // metres, at full size
    shardSpread: 1.35, // how far they are thrown, × the footprint
    shardStagger: 2.2, // seconds the arrivals are spread over
    shardLife: 2.6, // seconds one shard takes to fall in
    shardOrbit: 0.55, // how hard the infall winds
    shardLoft: 0.55, // how far out of the disc plane they are thrown
    shardTumble: 1.6, // revolutions/second they turn on their own axes
    shardCrush: 0.86, // fraction of the fall before the hole crushes them
    shardFresnel: 1.1, // the violet rim that draws the silhouette
    shardFresnelPower: 2.3,
    shardVein: 1.6, // gold in the flaws, lit by how deep in the well it is
    shardVeinScale: 6.0,
    shardVeinSharp: 3.0,
    shardGlint: 1.0, // pinpoint sparkle on the facets
    shardGlintScale: 24,
    shardHeatGlow: 5.0, // the white-out just before it goes over
    shardCoreBleed: 1.5, // how much light the hole throws on them
    shardCoreRadius: 6.5, // ... and how far that carries, metres
    shardRoughness: 0.32,
    shardMetalness: 0.25,
    shardEnvIntensity: 0.7,
    colorShardBody: '#0a0714',
    colorShardFacet: '#221838',
    colorShardRim: '#b98cff',
    colorShardVein: '#ffb54a',
    colorShardHot: '#fff0cf',

    /* --- layer 5: the cosmic shockwave --- */
    /**
     * An expanding planar ring on the floor, with a lifted crest of displaced
     * air and a refraction proxy shoving the frame outward behind it. The front
     * is integrated at `shockSpeed`, so dragging the speed re-paces a wave that
     * is already travelling.
     */
    shockRadius: 17, // how far it runs, metres
    shockSpeed: 11, // metres/second
    shockHeight: 0.03, // hover distance above the floor, metres
    shockWidth: 0.95, // depth of the wave packet, metres
    shockLift: 0.5, // how far the crest stands off the floor, metres
    shockWobble: 0.55, // how far the front wanders off a circle, metres
    shockWobbleScale: 2.4,
    shockSpokes: 28, // filaments streaming through the band
    shockSpokeSharp: 1.7,
    shockSpokeDrift: 0.7, // how fast they slide round it
    shockEdge: 1, // brightness of the hot leading line
    shockTrail: 0.14, // the wash left behind the wave
    shockGrain: 0.6,
    shockGrainScale: 1.5,
    shockGlow: 1.35,
    shockOpacity: 1.0,
    colorShockHot: '#ffeccb',
    colorShockBody: '#a76bff',
    colorShockCool: '#2a1250',

    /* --- the air the wave shoves aside --- */
    warpStrength: 1.5,
    warpWidth: 1.2, // depth of the pressure packet, metres
    warpRipples: 6.0, // bands inside it
    warpChop: 0.45, // how far the front is broken up
    warpChopScale: 2.6,

    /* --- the flare envelope every pass is driven off --- */
    /**
     * Water heaves; an accretion disc *flares*. Matter piles up at the
     * innermost orbit, goes in, and the hole brightens for a moment — so unlike
     * the Sumi Tide's swell this envelope is deliberately spiky. Crossing
     * `flareThreshold` on the way up throws a jet of gold along the equator and
     * knocks the camera, so nothing in this ability free-runs on its own sine.
     */
    churnRate: 1.6, // how fast the envelope runs
    churnSharp: 1.9, // >1 leans it toward the troughs
    churnDepth: 0.8, // how hard it modulates everything, 0 = flat
    flareThreshold: 0.66, // the level a flare has to cross to feed
    flareEmbers: 40, // gold thrown when it does
    flareStars: 60,
    flareShake: 0.03, // the knock on the camera

    /* --- particles --- */
    starRate: 620, // micro-stars per second, all of them in orbit
    starSize: 0.055,
    starLifetime: 1.5, // and how long one takes to spiral in
    starShell: 1.15, // the radius they are born on, × the footprint
    starLoft: 0.45, // how far out of the plane, × that shell
    starSwirl: 5, // radians/second the orbit turns
    starInfall: 0.97, // how much of the orbit collapses over a star's life
    colorStarA: '#ffffff',
    colorStarB: '#ffd9a0',
    colorStarC: '#b070ff',
    colorStarD: '#2a1050',

    emberRate: 70, // gold torn off the disc, per second
    emberSpeed: 5.5,
    emberLifetime: 0.9,
    emberSize: 0.1,
    colorEmberA: '#fff6dd',
    colorEmberB: '#ffc257',
    colorEmberC: '#ff7a2a',
    colorEmberD: '#5c1f5e',

    chipRate: 26, // stone lifted at the wavefront, per second
    chipSpeed: 7.5,
    chipLifetime: 1.6,
    chipSize: 0.12,
    colorChipA: '#6b5a8f',
    colorChipB: '#2c2140',
    colorChipC: '#151021',
    colorChipD: '#0a0712',

    dustRate: 55, // and the cloud it lifts with them
    dustSpeed: 2.6,
    dustLifetime: 2.6,
    dustSize: 0.8,
    colorDustA: '#8e86a0',
    colorDustB: '#5d5670',
    colorDustC: '#332e42',
    colorDustD: '#161320',

    /* --- the pull: what the hole does to a body --- */
    /**
     * The second ability on this stage that does not simply *hit* what is
     * standing in it. Everything caught — on its feet or already down — is
     * knocked inward, lifted off the stone, wound in, and consumed.
     *
     * `swirl` against `pull` is the whole shape of it, and `swirl` has to be
     * the larger of the two: the inward pull is what gets a body to the middle,
     * the tangential current is what makes the trip worth watching. Wind `pull`
     * past it and everything takes a straight line in, which is a magnet.
     *
     * `well` is the radius at which the pull is half its peak, as a fraction of
     * the footprint. Referencing the falloff to the *zone* rather than to the
     * horizon is what stops the hole being something that only eats what is
     * already inside it.
     *
     * @see AstralVoidAbility#_drag
     */
    grip: {
      reach: 2.1, // how far it fishes, × the footprint
      well: 0.6, // where the pull is half strength, × the footprint
      pull: 7.5, // metres/second inward, at the middle
      swirl: 9.0, // metres/second tangential, at the horizon — the peak
      tumble: 0.55, // revolutions/second a body turns about its own vertical
      cartwheel: 0.45, // ... and how much of that is end-over-end instead
      windUp: 0.45, // seconds the pull takes to get its hands on a body
      buoy: 1.15, // how much of the body's weight the well carries, 0..1
      grab: 4.2, // how fast a body matches the field, per second
      spiral: 2.8, // seconds it is given to wind in before it is taken anyway
      swallow: 2.4, // the mouth, × the horizon — inside this it is consumed
      devour: 1.4, // how fast that goes, fractions of a body per second
      impulse: 3.0, // the blow that takes it off its feet, inward
      lift: 2.6, // ... and upward
      spin: 1.0, // extra impulse per body-height above the hips — the torque
      swallowEmbers: 70, // thrown when a body crosses the horizon
      swallowStars: 90,
      swallowShake: 0.06
    },

    /* --- the collapse, and the blast it causes --- */
    implodeStars: 220, // matter rushing in as the seed lands
    implodeShake: 0.16,
    blastEmbers: 220, // gold thrown out of the middle
    blastChips: 130,
    blastDust: 70,
    blastStars: 900,
    blastShake: 0.75,
    shakeDuration: 0.55, // seconds that shake decays over
    blastFlash: 0.28,
    scorchRadius: 5.2, // the mark left under the hole
    scorchLife: 8.0,
    scorchIntensity: 0.4,
    rumble: 0.05, // continuous shake while the seed travels
    holdShake: 0.06, // ... and while the hole feeds
    collapseFlash: 0.45, // the pop as it closes on itself
    collapseShake: 0.35,
    // Muted on purpose: the scorch decal runs its second colour hot for the
    // first part of its life, and a saturated stop there throws a bright star
    // across a floor that is meant to read as burnt rather than lit.
    colorScorch: '#100b18',
    colorScorchEmber: '#2a1a44',
    colorFlash: '#c9a2ff',
    colorCollapseFlash: '#ffffff',

    /* --- dynamic light --- */
    /**
     * Violet, high and hard. The hole is the darkest thing in the set and the
     * brightest at the same time: the light is here to model the gas and the
     * shards, not to make the shadow glow — push it and the black disc picks up
     * a purple wash and stops being a hole.
     */
    lightIntensity: 26,
    lightRadius: 22,
    lightPulse: 0.5, // how much of the light the flare envelope owns
    lightColor: '#b98cff'
  },

  /* ------------------------------------------------------------------ */
  /* CASCADE — the Baleful Cascade Mark                                  */
  /* ------------------------------------------------------------------ */
  /**
   * A far cast built to a four-panel breakdown sheet, and the second cast in
   * the sandbox that picks its own targets.
   *
   * The block is laid out in the order of the sheet — glow, mark, wisps, core
   * mesh burst — followed by what the burst *does*. The two knobs worth
   * reaching for first are `zoneRadius` (in the cast) and `crownScale` (in the
   * burst): almost every other length here is a multiple of one of them, so
   * those two re-scale the whole thing in proportion, mid-cast and while
   * paused.
   */
  cascade: {
    /* --- the cast --- */
    range: 24.0, // maximum cast distance, metres
    minRange: 0.0, // it is a zone: dropping it at your own feet is allowed
    zoneRadius: 4.0, // the footprint — what the circle indicator measures out
    speed: 66.0, // how fast the shard runs to the point, metres/second
    cooldown: 3.4,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws
    lifetime: 7.0, // seconds the mark stands, once it has opened
    fadeTime: 2.0, // seconds it takes to close

    /* --- the order things happen in, seconds from the shard landing --- */
    /**
     * The mark is a *sequence*, and this is it. Nothing here overlaps by
     * accident: the glow has to be down before the line work is cut into it,
     * the wisps have to be climbing before there is anything for them to feed,
     * and the crown has to be whole before it is allowed to throw.
     */
    glowTime: 0.34, // the pool opens out to the boundary
    markTime: 0.52, // the line work cuts itself on behind it
    wispDelay: 0.22, // ... and the first wisps are already leaving the floor
    wispTime: 0.9, // how long they take to reach full height
    crownDelay: 0.5, // when the blades start to tear out of the middle
    crownTime: 0.8, // how long the burst takes to assemble
    fireDelay: 0.3, // seconds after that before the first flurry

    /* --- where the shard leaves the caster --- */
    handHeight: 1.25, // metres above the floor
    handForward: 0.62, // metres in front of the caster
    handSide: -0.14, // metres to the side (+ follows `Ability#side`)

    /* --- the pulse everything glowing rides --- */
    /**
     * Not a heartbeat and not a breath: a **bank**. Two sines a fifth apart,
     * cubed, so the envelope spends most of its time down in a long trough and
     * briefly comes up — a thing that glows evenly is friendly, and this one
     * should not be. The glow brightens on it, the mark brightens on it, the
     * wisps thicken on it and the light swells on it: one number, four passes.
     */
    pulseRate: 1.05, // radians/second through the envelope
    pulseDepth: 0.6, // how hard it modulates, 0 = flatline

    /* ------------------------------------------------------------------ */
    /* Layer 4 — the ground glow                                           */
    /* ------------------------------------------------------------------ */
    glowHeight: 0.008, // hover distance above the floor, metres
    glowPool: 0.9, // the soft body of light
    glowPoolFalloff: 1.7,
    glowLip: 0.75, // the band just inside the boundary — what makes it a pool
    glowLipSeat: 0.9, // × footprint
    glowLipWidth: 0.32, // metres
    glowSpill: 0.2, // the low wash reaching out past it
    glowSpillReach: 1.45, // × footprint
    glowSpillFalloff: 2.7,
    glowWobble: 0.012, // how far the boundary wanders, × footprint
    glowWobbleLobes: 7,
    glowWobbleSpeed: 0.5,
    glowGrain: 0.28,
    glowGrainScale: 1.6,
    glowSweep: 0.45, // a read head turning round the pool
    glowSweepSpeed: 0.08, // revolutions/second
    glowSweepWidth: 0.2,
    glowOpacity: 1.0,
    glowGlow: 0.95,

    /* ------------------------------------------------------------------ */
    /* Layer 1 — the decal mark                                            */
    /* ------------------------------------------------------------------ */
    markHeight: 0.03, // metres above the floor — over the glow, under the mist
    markLineWidth: 0.034, // stroke thickness, metres
    markLineGlow: 1.45,

    markPoints: 4, // the star the whole emblem is built on
    markStarOuter: 0.94, // its points, × footprint
    markStarSharp: 3.2, // 2 is the polygon; markPoints is the sharpest star
    markStarSpin: 0.012, // revolutions/second
    markInnerScale: 0.62, // the second star inside it, × the first
    markInnerGain: 0.75,

    markDiamond: 1.0, // the rhombus framing them
    markDiamondSeat: 0.5, // half-diagonal, × footprint
    markDiamondAspect: 1.0, // 1 is square-on; under 1 flattens it
    markDiamondSpin: -0.008, // counter to the star

    markSpear: 1.0, // the barbs driven out along the star's points
    markSpearFrom: 0.36, // where one starts, × footprint
    markSpearTo: 0.9, // ... and where its point ends up
    markSpearWidth: 0.055, // half-width at the base, × footprint

    markHooks: 1.0, // the knot of curls in the middle
    markHookCount: 4,
    markHookSeat: 0.26, // radius, × footprint
    markHookSweep: 0.8, // radians each one covers
    markHookWidth: 0.05, // half-width where it leaves the hub, × footprint
    markHookSpin: 0.022,

    markRibs: 0.5, // the comb down each edge of the diamond
    markRibCount: 9,
    markRibLength: 0.16, // how far in from the edge they reach
    markRibWidth: 0.22,

    markTicks: 0.35, // graduations around the rim
    markTickCount: 32,
    markTickSeat: 0.72, // × footprint
    markTickLength: 0.07,

    markHub: 1.0, // the ring and the dot at the middle
    markHubRing: 0.1, // × footprint
    markHubDot: 0.05,

    markWash: 0.32, // the fill inside the star
    markWashFalloff: 1.6,
    markGrain: 0.45, // break-up over that fill
    markGrainScale: 2.4,
    markOpacity: 1.0,
    markGlow: 0.9,

    /* ------------------------------------------------------------------ */
    /* Layer 2 — the rising wisps                                          */
    /* ------------------------------------------------------------------ */
    wisps: 20, // ribbons climbing out of the mark (capacity is 28)
    wispSeat: 0.57, // where a foot is planted, × footprint
    wispSeatJitter: 0.44,
    wispSpread: 1.11, // how far bearings scatter off even spacing
    wispHeight: 4.4, // how far one climbs, metres
    wispHeightJitter: 0.28,
    wispRise: 0.15, // climbs per second — each wisp is on its own loop
    wispLength: 0.86, // how much of the climb one ribbon covers at once
    wispWander: 0.13, // metres the spine wanders off the vertical
    wispWanderScale: 1.7,
    wispWanderSpeed: 0.32,
    wispSwirl: -1.25, // radians it turns about the mark while climbing
    /**
     * How far the top of a wisp is pulled onto the crown's axis, and where the
     * pull starts. This is the single term that makes layer 2 belong to layer 3
     * rather than sharing a shot with it: at 1 the wisps rise straight and the
     * burst is a separate object hanging over some smoke; at 0.2 they visibly
     * feed it.
     */
    wispDraw: 0,
    wispDrawAt: 0.43,
    wispWidth: 0.055, // half-width, × its own height
    wispWidthBias: 0.45, // how fast it thins as it climbs
    wispIntensity: 1.44,
    wispSoftEdge: 3.85, // how soft it is across the ribbon
    wispErode: 0.72, // how far noise eats into it
    wispErodeScale: 3.1,
    wispErodeSpeed: 0.87,
    wispHeadFade: 0.01, // how much of the top it spends disappearing
    wispTailFade: 0.12, // ... and how fast it arrives at the bottom
    wispSoftFade: 0, // metres of soft fade where it meets geometry
    wispOpacity: 0.85,
    wispGlow: 1.0,

    /* ------------------------------------------------------------------ */
    /* Layer 3 — the core mesh burst                                       */
    /* ------------------------------------------------------------------ */
    crownHeight: 3.1, // where the burst hangs, metres above the floor
    crownRise: 0.9, // how far it climbs while it assembles, metres
    crownScale: 1.65, // master size — every blade length is a multiple of it
    crownBob: 0.05, // metres it breathes up and down
    crownBobSpeed: 0.55,
    crownSpin: 0.03, // revolutions/second about the vertical
    crownTilt: 0.22, // radians it nods off that vertical
    crownTiltSpeed: 0.05, // ... and how slowly, revolutions/second

    /**
     * The three populations, and the whole read of the panel.
     *
     * Long spears define the silhouette, blades fill the body, and short shards
     * skirt the middle so the burst has a base instead of a hole. Make them all
     * one length and it is a sea urchin.
     */
    crownSpears: 10, // ... capacity across all three is 56
    crownBlades: 16,
    crownShards: 14,
    spearLength: 1.85, // × crownScale
    bladeLength: 1.0,
    shardLength: 0.55,
    crownLengthJitter: 0.28,

    /**
     * How far the sphere of headings is squashed toward the equator.
     *
     * At 1 the blades are dealt evenly over a ball, which from the sandbox's
     * three-quarter camera reads as a hedgehog. Pulled down to about 0.7 the
     * burst has a plane in it and reads as a *star* from every angle the rig
     * can reach, without ever collapsing into the flat disc a fixed billboard
     * would give.
     */
    crownFlatten: 0.72,
    crownJitter: 0.16, // scatter off the even deal
    crownInner: 0.16, // where a blade is rooted, × crownScale
    crownStagger: 0.4, // how much of the assembly one blade may lag by
    crownSwell: 0.12, // how far the pulse opens and closes the crown
    crownViolet: 0.42, // the share of blades dealt the violet stone

    /**
     * How long a thrown blade takes to grow back, and how long the gap it left
     * stays empty first.
     *
     * The crown is a magazine: fire faster than this and the burst visibly
     * thins, leave it alone and it fills back in. Raise `crownRegrow` past a
     * couple of seconds and a sustained flurry will strip it bare, which is
     * worth seeing once.
     */
    crownRegrow: 0.9,
    crownRegrowDelay: 0.35,

    /* --- the blade itself: shared by the crown and everything it throws --- */
    /**
     * The cross-section is a **lens**, not a circle: the thickness is pinched
     * to nothing at the two angles where the width is greatest, so the blade
     * has a sharp edge down each side and a spine ridge along each face.
     * `bladeEdge` is how hard that pinch is — at 0.2 it is a spindle, at 1 it
     * is a scalpel.
     */
    bladeWaist: 0.22, // where it is widest, 0 root → 1 point
    bladeRootPower: 0.55, // how fast it swells off the root
    bladeTipPower: 0.9, // how sharply it draws out to the point
    bladeWidth: 0.085, // half-width at the waist, × its own length
    bladeThick: 0.4, // thickness, × that half-width
    bladeEdge: 0.8,
    bladeBow: 0.04, // how far the spine bows, × length
    bladeTwist: 0.3, // radians it winds about itself, root to point

    bladeEdgeGlow: 0.5, // the two sharp edges lighting up
    bladeEdgePower: 14.0, // how tightly that light is held to them
    bladeRim: 0.12, // sheath around the silhouette
    bladeRimPower: 2.6,
    bladeTipGlow: 0.35, // the point
    bladeTipStart: 0.8, // where that starts, along the blade
    bladeVein: 0.3, // flaws running inside the stone
    bladeVeinScale: 5.5,
    bladeVeinBands: 3.0,
    bladeVeinSharp: 3.4,
    /**
     * How hard the heart lights the blades nearest it, and how far that reaches
     * in metres. This is what makes forty separate solids read as one object:
     * turn it off and the burst is a lamp parked in a pile of glass.
     */
    bladeHeartBleed: 0.12,
    bladeHeartReach: 1.3,
    bladeChargeGain: 0.85, // how much brighter the crown runs while winding up
    bladeBurnGlow: 4.0, // the edge left where a blade is being eaten back
    bladeRoughness: 0.45,
    bladeMetalness: 0.05,
    bladeEnv: 0.25, // how much of the probe the crystal picks up
    bladeGlow: 1.0,

    /* --- the heart --- */
    heartSize: 0.24, // radius, metres, × crownScale
    heartSwell: 0.35, // how much bigger it runs at full charge
    heartBoil: 0.13, // how far its silhouette churns
    heartBoilScale: 2.4,
    heartFill: 1.6, // how hard the white is weighted toward the axis
    heartRim: 0.9,
    heartRimPower: 2.2,
    heartFilament: 1.0, // threads turning inside it
    heartFilamentScale: 4.2,
    heartFilamentSpeed: 0.55,
    heartIntensity: 0.5,
    heartChargeGain: 1.5,
    heartSoftFade: 0.4, // metres of soft fade where it meets the blades

    /* --- the halo --- */
    haloSize: 2.3, // radius, metres, × crownScale
    haloGlow: 0.22,
    haloFalloff: 2.6,
    haloRays: 0.3, // spokes combed out of the burst
    haloRayCount: 16,
    haloRaySharp: 6,
    haloRaySpin: 0.02,
    haloRingSeat: 0.62, // a thin ring, × halo radius
    haloRingWidth: 0.05,

    /* ------------------------------------------------------------------ */
    /* What the burst does                                                 */
    /* ------------------------------------------------------------------ */
    /**
     * It picks the nearest body still standing inside `throwRange`, winds up
     * for `throwWarmup` — which is what the heart's charge and the lit blade
     * tips are showing you — and then throws `throwBlades` of its own blades at
     * it, `throwStagger` apart.
     *
     * **Only the last blade of a flurry is lethal.** The ones before it go
     * through and draw sparks off the body; the last one takes it apart. A body
     * that comes apart on the first of three arrivals leaves the other two
     * hitting a corpse, and three landing on the same frame read as one blade
     * with a rendering bug.
     */
    throwEnabled: true,
    throwRange: 12.0, // metres from the burst
    throwInterval: 0.75, // seconds between flurries
    throwWarmup: 0.3, // seconds it winds up before one leaves
    throwTargets: 1, // bodies taken per flurry
    throwBlades: 3, // blades sent at each of them
    throwStagger: 0.07, // seconds between those
    throwAim: 0.62, // where up the body they land, 0 feet 1 head

    throwLife: 0.55, // seconds a blade is on screen
    throwStrike: 0.34, // the fraction of that spent arriving — the cut frame
    throwHold: 0.5, // ... and how long before it starts to be spent
    throwLength: 1.45, // metres, root to point
    throwSmear: 0.5, // how much longer it draws out while it is fast
    throwSpin: 1.4, // revolutions over its life, about its own axis
    /**
     * How far off the straight line the path bows, and the lift on it. Blades
     * of one flurry bow alternate ways, so three of them fan out and converge
     * rather than arriving as a bundle of parallel rods.
     */
    throwCurve: 0.22, // × the distance to the body
    throwLoft: 0.05,
    throwOverrun: 2.4, // metres it carries on past, after the cut
    throwHeat: 1.2, // how much hotter a thrown blade runs than a standing one
    throwFlare: 2.6, // ... and the flash as it goes through
    throwShake: 0.14,
    throwFlash: 0.14,

    /**
     * How the two halves leave. Lower than the field's own numbers on purpose:
     * this is a cut, not a blast, and a body that is *thrown* by being cut in
     * half reads as an explosion going off inside it.
     */
    cutHit: { impulse: 3.6, lift: 2.6, spin: 1.8 },
    cutSparks: 110, // what comes out of the wound, across the cut
    cutMotes: 70,
    cutChips: 26,
    cutSpeed: 5.2,
    cutShake: 0.18,
    cutFlash: 0.12,
    grazeSparks: 34, // ... and what a non-lethal blade draws off it

    launchSparks: 26, // what comes off the crown as a blade tears out
    launchChips: 6,
    trailRate: 220, // sparks per second behind a blade in the air

    /* ------------------------------------------------------------------ */
    /* Layer 5 — motes, sparks, chips and mist                             */
    /* ------------------------------------------------------------------ */
    moteRate: 80, // cold motes lifted off the mark, per second
    moteSize: 0.055,
    moteLifetime: 2.6,
    moteSpeed: 0.9,
    moteRise: 0.5, // gravity, so they climb
    moteTurbulence: 0.65,
    moteSeat: 0.9, // how far out over the footprint they are lifted
    colorMoteA: '#ffffff',
    colorMoteB: '#a8fff0',
    colorMoteC: '#2ecfc4',
    colorMoteD: '#0a3038',

    sparkSize: 0.07, // velocity-aligned streaks: trails and wounds
    sparkLifetime: 0.9,
    sparkSpeed: 6.0,
    sparkGravity: -1.6,
    colorSparkA: '#ffffff',
    colorSparkB: '#ccfff6',
    colorSparkC: '#4fd8ff',
    colorSparkD: '#1a2a6b',

    chipSize: 0.07, // chips of the same crystal the blades are cut from
    chipLifetime: 2.4,
    chipSpeed: 3.2,
    chipGravity: -5.5,
    chipSpin: 5.0,
    colorChipA: '#cffff6',
    colorChipB: '#4fd0c8',
    colorChipC: '#2a3f8a',
    colorChipD: '#101a2e',

    mistRate: 5, // the low bank the mark stands in
    mistSize: 0.95,
    mistLifetime: 3.6,
    mistSpeed: 0.5,
    mistRise: 0.16,
    mistSeat: 0.85, // where it is laid down, × footprint
    mistOpacity: 0.13,
    colorMistA: '#bfe8e6',
    colorMistB: '#6fb3b8',
    colorMistC: '#33555f',
    colorMistD: '#141d24',

    /* --- one-shots --- */
    castMotes: 30, // thrown from the caster's hand as the shard leaves
    creepRate: 26, // motes off the shard while it runs across the floor
    stainRate: 2.6, // ground marks per metre of that run
    landMotes: 120, // ... and the gout as it lands
    landSparks: 70,
    landMist: 16,
    landShake: 0.3,
    landFlash: 0.2,
    shakeDuration: 0.5,
    crownMotes: 140, // what the burst throws as it snaps into place
    crownSparks: 120,
    crownChips: 22,
    crownShake: 0.2,
    crownFlash: 0.22,

    castFlash: 0.1,
    holdShake: 0.035, // the standing rumble
    rumble: 0.03, // ... and the one while the shard is running

    /* --- the marks it leaves on the floor --- */
    stainRadius: 0.8,
    stainLife: 5.0,
    stainIntensity: 0.45,
    colorStain: '#101f26',
    colorStainEdge: '#2f6f70',

    /* --- the light --- */
    lightIntensity: 12,
    lightRadius: 12,
    lightHeight: 0.5, // where it sits, 0 the floor 1 the burst
    lightPulse: 0.45, // how much of it the bank owns

    /* --- the palette --- */
    colorMarkLine: '#5ff2ff',
    colorMarkCore: '#e6ffff',
    colorMarkDeep: '#2b6adf',
    colorMarkWash: '#1a8fa8',
    colorFront: '#dcffff',

    colorGlowCore: '#7ffff2',
    colorGlowPool: '#1fd3c8',
    colorGlowRim: '#aefff4',

    colorWispRoot: '#5fead8',
    colorWispBody: '#2bc6bd',
    colorWispTip: '#12586b',

    colorBladeBody: '#08252f',
    colorBladeFacet: '#1e8f92',
    colorBladeBodyDeep: '#1b1240',
    colorBladeFacetDeep: '#5f4bbd',
    colorBladeEdge: '#3fe4ff',
    colorBladeVein: '#a98cff',
    colorBladeHot: '#8ff2ff',

    colorHeart: '#7ff8e6',
    colorHeartCore: '#ffffff',
    colorHeartEdge: '#0f6f78',
    colorHaloInner: '#9ffff0',
    colorHaloOuter: '#166b7d',

    colorCastFlash: '#a8fff0',
    colorFlash: '#d8fffa',
    lightColor: '#3ff0e0'
  },

  /* ------------------------------------------------------------------ */
  /* REND — the Celestial Rend, and the Judgment Cascade                 */
  /* ------------------------------------------------------------------ */
  /**
   * A far cast built to a four-panel breakdown sheet, and the third cast in the
   * sandbox that picks its own targets.
   *
   * The block is laid out in the order the ability happens — the cast, the
   * order of the beats, then the four panels: mark, tendrils, shards, and the
   * divine impact that is the column, the star and the halos — followed by what
   * the rend does to a body.
   *
   * Three knobs re-scale the whole thing in proportion and are the ones worth
   * reaching for first: `zoneRadius` (in "The cast") sets the footprint and
   * nearly every horizontal length is a multiple of it; `pillarHeight` sets the
   * vertical and the star, the halos and the shard ceiling all seat off it; and
   * `chargeTime` sets how long the shards have to come in before the mark goes
   * off, which is the entire pacing of the piece. All three are live: drag one
   * while a cascade is standing and every layer re-seats around it, paused or
   * not.
   */
  rend: {
    /* --- the cast --- */
    range: 24.0, // maximum cast distance, metres
    minRange: 0.0, // it is a zone: dropping it at your own feet is allowed
    zoneRadius: 5.0, // the footprint — what the circle indicator measures out
    speed: 72.0, // how fast the mote runs to the point, metres/second
    lifetime: 6.2, // seconds the cascade stands, once the mark has landed
    fadeTime: 2.4, // seconds it takes to close
    cooldown: 5.5,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the mote leaves the caster --- */
    handHeight: 1.15, // metres above the floor
    handForward: 0.7, // metres in front of the caster
    handSide: -0.1, // metres to the side (+ follows `Ability#side`)
    trailMotes: 34, // motes per metre of the throw
    seedStarSize: 0.34, // the star riding the mote, × the footprint
    seedHeight: 2.6, // metres above the mark the seed star hangs at

    /* --- the order it happens in --- */
    /**
     * One clock — seconds since the mark landed — and every beat below is a
     * threshold on it. Nothing in this ability runs on a timer of its own,
     * which is why the whole sequence can be scrubbed by dragging these.
     *
     * The rend fires at `sigilTime + chargeTime`. Everything before that is the
     * first three panels winding up; everything after it is the fourth.
     */
    sigilTime: 0.6, // seconds the mark takes to write itself on
    tendrilDelay: 0.3, // seconds before the tendrils start climbing
    tendrilTime: 1.0, // ... and how long they take to reach full height
    chargeTime: 1.7, // seconds of shards coming in before the mark goes off
    rendTime: 0.45, // seconds the detonation itself takes
    pillarRise: 0.34, // seconds the beam's front takes to reach the top
    pulseRate: 1.3, // how fast the toll envelope runs
    pulseDepth: 0.55, // how hard it modulates everything, 0 = flat

    /* --- 1 · the celestial mark --- */
    /**
     * A four-pointed star with concave points, a nest of concentric rings, four
     * satellite glyphs and a band of runic ticks — panel one and panel four out
     * of one field, separated by how far the rend has gone.
     *
     * `sigilStarSharp` is the one to reach for: above 2 the points draw out into
     * the long needles the sheet uses, at 1 it is a rounded clover, and at 0 it
     * is a plain circle. Every length here is a multiple of the footprint, so
     * the mark re-scales around its own middle rather than stretching.
     */
    sigilHeight: 0.03, // hover distance above the floor, metres
    sigilLineWidth: 0.035, // stroke width, metres
    sigilLineGlow: 2.4,

    sigilStar: 1.0,
    sigilStarPoints: 4,
    sigilStarOuter: 1.0, // the points, × the footprint
    sigilStarSharp: 2.6, // >1 draws them out into needles
    sigilStarSpin: 0.012, // revolutions/second
    sigilStarFill: 0.2, // the wash the star holds
    sigilStarInner: 0.7, // the second star inside it
    sigilStarInnerScale: 0.46,

    sigilRings: 1.0,
    sigilRingCount: 5,
    sigilRingInner: 0.24, // the innermost ring, × the footprint
    sigilRingSpread: 0.82, // ... and how far the nest reaches past it
    sigilRingWobble: 0.01, // how far a ring wanders off a circle
    sigilRingWobbleLobes: 7,

    sigilGlyphs: 1.0,
    sigilGlyphCount: 4,
    sigilGlyphSeat: 0.68, // where they sit, × the footprint
    sigilGlyphSize: 0.11,
    sigilGlyphSpin: -0.015, // the other way from the star, on purpose

    sigilTicks: 0.7,
    sigilTickCount: 48,
    sigilTickSeat: 1.04,
    sigilTickLength: 0.1,
    sigilTickSpin: 0.006,

    sigilCracks: 1.0, // the floor splitting, once the rend has opened it
    sigilCrackCount: 9,
    sigilCrackSeat: 1.25, // how far the splits run, × the footprint
    sigilCrackWander: 0.35, // how far they fork off a clean radius
    sigilCrackWidth: 0.07,

    sigilWash: 0.24,
    sigilWashFalloff: 1.8,
    sigilGrain: 0.4,
    sigilGrainScale: 2.2,
    sigilOpacity: 1.0,
    sigilGlow: 1.4,
    colorSigilLine: '#ffcf7a',
    colorSigilCore: '#fff6e0',
    colorSigilDeep: '#3a2a10',
    colorSigilWash: '#ffab3c',
    colorFront: '#fffaf0', // the edge the mark writes itself with

    /* --- 2 · the astral tendrils --- */
    /**
     * Ribbons climbing out of the stone and winding onto the column's axis.
     *
     * `tendrilShear` is what makes them a braid rather than a spring: a strand
     * seated near the axis laps one seated out at the boundary, so they cross
     * each other instead of running parallel. `tendrilDraw` is the other one
     * that matters — how far onto the axis they are pulled at the top, which is
     * what ties this layer to the beam.
     */
    tendrils: 32, // how many ribbons are in the braid
    tendrilSeat: 0.85, // where they leave the floor, × the footprint
    tendrilSeatJitter: 0.5,
    tendrilSpread: 0.9, // jitter on their bearings
    tendrilReach: 0.5, // how far up the column they climb, × its height
    tendrilCharge: 0.22, // ... and how far before the rend, when it is all there is
    tendrilHeightJitter: 0.35,
    tendrilRise: 0.2, // loops per second — how fast one runs its climb
    tendrilLength: 0.75, // how much of the climb one ribbon spans
    tendrilWind: 1.7, // turns about the axis over the whole climb
    tendrilShear: 0.9, // extra winding for the strands seated deepest
    tendrilCounter: 0.35, // fraction of them that wind the other way
    tendrilFlare: 0.35, // how far the seat closes with height
    tendrilDraw: 0.16, // ... and how hard the top is pulled onto the axis
    tendrilDrawAt: 0.62, // where up the climb that starts
    tendrilWander: 0.8, // noise off the helix, metres
    tendrilWanderScale: 1.6,
    tendrilWanderSpeed: 0.4,
    tendrilWidth: 0.008, // ribbon width, × the climb height
    tendrilWidthBias: 0.45, // how fast it thins as it climbs
    tendrilIntensity: 0.5,
    tendrilSoftEdge: 1.4,
    tendrilErode: 0.45, // how much of it is eaten along its length
    tendrilErodeScale: 3.2,
    tendrilErodeSpeed: 0.6,
    tendrilHead: 0.5, // the bright band running up each ribbon
    tendrilHeadWidth: 0.11,
    tendrilHeadRate: 0.55, // how fast it travels
    tendrilHeadFade: 0.4,
    tendrilTailFade: 0.12,
    tendrilSoftFade: 0.5,
    tendrilOpacity: 1.0,
    tendrilGlow: 1.0,
    colorTendrilRoot: '#ffb14a',
    colorTendrilWarm: '#ffd58f',
    colorTendrilCold: '#a9c8ff',
    colorTendrilTip: '#fffdf5',

    /* --- 3 · the radiant shards --- */
    /**
     * Slivers of crystallised light coming in from every bearing, and the
     * debris the detonation throws clear of the column afterward.
     *
     * The arrivals **accelerate**: a shard's landing is drawn from a dice roll
     * biased toward the end of `chargeTime`, so the strikes start lonely and
     * finish as a hail that the rend lands on top of. `shardReach` is where they
     * come in from — push it out and they arrive out of the dark rather than
     * fading in at the edge of the circle.
     */
    shardDensity: 1.0, // 0..1 of the 60 slots that are dealt
    shardSize: 1.7, // length of one sliver, metres
    shardGirth: 1.0, // ... and how thick it is cut, × that
    shardReach: 3.4, // where they come in from, × the footprint
    shardFlight: 0.85, // seconds one takes to cross that
    shardLoft: 1.0, // how high they start, × the column's height
    shardCurve: 0.6, // how far they bow off a clean radius, radians
    shardRoll: 0.4, // revolutions/second one turns on its own axis inbound

    shardScatter: 1.2, // seconds the throw-clear is spread over
    shardSettle: 1.6, // seconds one takes to reach its orbit
    shardOrbit: 1.5, // where that orbit sits, × the footprint
    shardCeiling: 0.42, // ... and how high, × the column's height
    shardDrift: 0.55, // metres/second it keeps climbing after that
    shardSpin: 0.35, // radians/second the orbit turns
    shardTumble: 0.12, // revolutions/second the shard turns on its own axes
    shardDebris: 0.8, // size of a thrown shard, × `shardSize`

    /**
     * Every one of the five terms below except the glint and the spine covers
     * the **whole** surface, and area terms summed at similar weights drown the
     * shading underneath them — a lit solid that comes out as a featureless
     * white blob in this sandbox is almost never the bloom, it is this. So the
     * budget is spent deliberately: the spine is the loud one because it is
     * spatially concentrated on the sliver's own axis, and the three that cover
     * everything are held well under half.
     */
    shardFresnel: 0.6, // the rim that draws the silhouette
    shardFresnelPower: 2.2,
    shardVein: 0.25, // the flaws it is lit through
    shardVeinScale: 5.0,
    shardVeinSharp: 2.6,
    shardSpine: 0.9, // the hot line down its own axis — the loud one
    shardSpinePower: 2.2,
    shardGlint: 1.0, // pinpoint sparkle: tiny area, so it can afford to be hot
    shardGlintScale: 22,
    shardHeatGlow: 5.0, // the white-out on the frame it lands, and only then
    shardBeamBleed: 0.5, // how much of the column's light falls on it
    shardBeamRadius: 8.0, // ... and how far that carries, metres
    // 0.2 roughness against this HDR probe is a mirror, and a mirror at this
    // size is a white chip. This reads as cut crystal.
    shardRoughness: 0.42,
    shardMetalness: 0.18,
    shardEnvIntensity: 0.45,
    colorShardBody: '#1b2436',
    colorShardFacet: '#4a5878',
    colorShardWarm: '#ffc86a',
    colorShardCold: '#9fc4ff',
    colorShardVein: '#ffe6ad',
    colorShardHot: '#fffaf0',

    /* --- 4 · the divine impact: the column --- */
    /**
     * The shaft is shaded on a power of |N·V| rather than on a fresnel, because
     * what the eye reads as a beam's brightness is how much of it the ray
     * crossed — longest through the middle of the silhouette, nothing at the
     * edges. `pillarBodyPower` is that falloff and `pillarCorePower` is the
     * white filament run out of the same term; between them they are most of
     * the look. A fresnel here would give a hollow tube.
     */
    pillarHeight: 30.0, // metres — it leaves the top of the frame on purpose
    pillarRadius: 0.28, // the shaft, × the footprint
    pillarSkirt: 1.1, // how far it flares where it meets the stone
    pillarSkirtPower: 4.5, // ... and how fast that closes with height
    pillarTopFlare: 1.25, // how much wider it is at the top
    pillarFlarePower: 1.6,
    pillarWobble: 0.08, // noise on the barrel, × its radius
    pillarWobbleScale: 1.1,
    pillarWobbleSpeed: 1.2,
    pillarSpin: 0.05, // revolutions/second the whole barrel turns
    pillarBodyPower: 1.3, // the chord falloff — lower is a fatter beam
    pillarCorePower: 9.0, // ... and the white filament out of the same term
    pillarCore: 0.35,
    pillarRim: 0.35, // the caustic boundary. Small: it is only an edge
    pillarRimPower: 2.2,
    pillarFlutes: 22, // vertical channels combed up the barrel
    pillarFluteSharp: 0.55,
    pillarFluteDepth: 0.6, // how much of the brightness they own
    pillarFluteDrift: 0.035, // how fast they slide around it
    pillarStreamScale: 1.0, // the light pouring up through them
    pillarStreamSpeed: 1.6,
    pillarHeadFade: 0.42, // the beam does not end, it loses itself
    pillarFootGlow: 0.7, // ... and it piles up on the stone
    pillarFootReach: 0.12,
    pillarSoftFade: 0.6,
    pillarIntensity: 0.36,
    pillarOpacity: 1.0,
    pillarGlow: 1.0,
    pillarSparks: 140, // gold pouring up the shaft, per second
    colorPillarCore: '#fffdf2',
    colorPillarBody: '#ffd489',
    colorPillarEdge: '#ffb254',
    colorPillarCool: '#bcd8ff',

    /* --- 4 · ... the star welded to its head --- */
    /**
     * Three raised cosines summed into a reach — a long vertical pair, a shorter
     * horizontal pair, four short diagonals — with an exponential falloff along
     * each. Concave-sided by construction, so it stays sharp at any size and
     * under any exposure, which a sprite would not.
     */
    starSeat: 0.42, // where it hangs, × the column's height
    starSize: 2.0, // its half-extent, × the footprint
    starDelay: 0.16, // seconds after the rend it opens
    starTime: 0.5, // ... and how long that takes
    starBob: 0.25, // metres it drifts up and down
    starBobSpeed: 0.18,
    starVertical: 1.0, // the long pair
    starVerticalSharp: 7.0, // higher is narrower
    starHorizontal: 0.72, // the short pair
    starHorizontalSharp: 11.0,
    starDiagonal: 0.1, // the four between them
    starDiagonalSharp: 7.0,
    starReach: 0.86, // how far the points carry, × the half-extent
    starFalloff: 1.5, // how the inside of a point shades toward its edge
    starHalo: 0.35, // the soft bloom the points sit in
    starCore: 0.06, // the hot round middle
    starCoreGain: 0.9,
    starNeedles: 0.18, // the fine spray between the points
    starNeedleCount: 34,
    starNeedleSharp: 9,
    starNeedleReach: 0.5,
    starNeedleSpin: 0.015,
    starRing: 0.3, // the thin circle struck through it
    starRingSeat: 0.5,
    starRingWidth: 0.008,
    starFlicker: 0.12,
    starFlickerRate: 2.6,
    starIntensity: 1.3,
    starOpacity: 1.0,
    starGlow: 1.0,
    colorStarCore: '#fffef8',
    colorStarBody: '#ffe1a4',
    colorStarEdge: '#ffb04a',
    colorStarCool: '#a8c6ff',

    /* --- 4 · ... and the halo rings turning about it --- */
    /**
     * Two, leaning opposite ways and turning at different rates, so they cross.
     * Two rings that lean the same way read as one wide band; two that cross
     * read as an orrery, which is what the sheet's hero image is.
     */
    haloRadius: 1.5, // the outer edge, × the footprint
    haloSeat: 0.87, // where the band sits inside that
    haloBand: 0.1, // ... and how deep it is
    haloSecond: 0.92, // the second ring, × the first
    haloDelay: 0.2, // seconds after the rend they open
    haloStagger: 0.09, // ... and how far apart
    haloTime: 0.45, // how long one takes to write itself round
    haloTilt: 0.34, // radians each leans, opposite ways
    haloSpin: 0.09, // revolutions/second, opposite ways
    haloLift: 0.3, // metres apart they sit, × the footprint
    haloRails: 1.2, // the two bright lines fencing the band
    haloRailWidth: 0.03,
    haloDashes: 0.45, // how hard the band is cut into dashes
    haloDashCount: 40,
    haloDashDuty: 0.62,
    haloDashDrift: 0.03,
    haloGlyphs: 0.9, // the handful of bright beads on it
    haloGlyphCount: 8,
    haloGlyphSize: 0.03,
    haloSweep: 1.1, // the lit limb, and how hard it is beamed
    haloSweepSharp: 2.4,
    haloSweepRate: 0.22, // revolutions/second it travels
    haloGrain: 0.35,
    haloGrainScale: 3.0,
    haloIntensity: 1.2,
    haloOpacity: 1.0,
    haloGlow: 1.0,
    colorHaloCore: '#fff4d6',
    colorHaloBody: '#ffc46a',
    colorHaloCool: '#9dbcff',

    /* --- the air the column shoves aside --- */
    warpReach: 1.35, // the proxy's radius, × the shaft
    warpStrength: 0.35,
    warpRipples: 3.0, // bands up its height
    warpSpeed: 4.5,
    warpChop: 0.45,
    warpChopScale: 2.2,

    /* --- particles --- */
    moteRate: 190, // gold lifted off the mark, per second
    moteSeat: 1.0, // over how much of the footprint, × it
    moteSize: 0.075,
    moteSpeed: 1.6,
    moteLifetime: 1.5,
    moteRise: 1.6,
    moteTurbulence: 0.5,
    colorMoteA: '#fffdf4',
    colorMoteB: '#ffd68a',
    colorMoteC: '#ff9c3a',
    colorMoteD: '#4a2a12',

    sparkSize: 0.1, // the streaks: shard trails and everything that lands
    sparkSpeed: 4.5,
    sparkLifetime: 0.9,
    sparkGravity: -1.4,
    trailRate: 110, // streaks per second behind one inbound shard
    colorSparkA: '#ffffff',
    colorSparkB: '#ffe2a8',
    colorSparkC: '#ffab45',
    colorSparkD: '#6b3a12',

    chipSize: 0.11, // the floor coming up
    chipSpeed: 6.5,
    chipLifetime: 1.6,
    chipGravity: -8.5,
    chipSpin: 0.4,
    colorChipA: '#7a6d55',
    colorChipB: '#3e3527',
    colorChipC: '#211c14',
    colorChipD: '#100d09',

    dustRate: 40, // the bank the column stands in
    dustSeat: 0.9,
    dustSize: 0.85,
    dustSpeed: 2.2,
    dustLifetime: 2.6,
    dustRise: -0.3,
    dustOpacity: 0.75,
    colorDustA: '#9a8f7c',
    colorDustB: '#6b6254',
    colorDustC: '#3d382f',
    colorDustD: '#1a1815',

    /* --- the cast, the mark, the strikes and the rend --- */
    castMotes: 60,
    castFlash: 0.06,
    markMotes: 90,
    markShake: 0.16,
    markFlash: 0.09,
    gildLife: 9.0, // the gilding left under the mark
    gildIntensity: 0.35,
    strikeSparks: 16, // per shard that lands
    strikeChips: 5,
    strikeShake: 0.035,
    shockRadius: 14.0, // how far the ring runs, metres
    rendSparks: 420, // gold thrown straight up the shaft
    rendMotes: 260, // ... and out along the floor with the ring
    rendChips: 160,
    rendDust: 90,
    rendShake: 0.9,
    shakeDuration: 0.6, // seconds that shake decays over
    rendFlash: 0.4,
    rumble: 0.04, // continuous shake while the mote travels
    holdShake: 0.05, // ... and while the column stands
    colorCastFlash: '#ffd79a',
    colorFlash: '#ffe6b8',
    colorGild: '#1a1206',
    colorGildEdge: '#5a3a12',

    /* --- what the rend does to a body --- */
    /**
     * The third cast in the sandbox that picks its own targets, and the only one
     * that deliberately does **not** move them.
     *
     * `impulse` is zero and it is meant to be. `Ragdoll#strike` multiplies it
     * into every joint's horizontal velocity, so zero is a body whose legs
     * simply stop holding it: it collapses into its own footprint instead of
     * being thrown clear of the column that is judging it. `press` and `grab`
     * are the other half — a body left alone after it lands still slides half a
     * metre down the slope of its own limbs, and half a metre reads as having
     * been pushed.
     *
     * Turn `impulse` up if you want a knockback; nothing else has to change.
     *
     * @see CelestialRendAbility#_judge
     */
    judge: {
      reach: 1.0, // how far it takes, × the footprint — exactly the circle
      impulse: 0.0, // the blow, sideways. Zero: judgment does not scatter people
      lift: 0.25, // just enough that the body buckles rather than drops
      spin: 0.0, // no torque either — it goes down where it stood
      press: 1.6, // metres/second the light presses a held body onto the stone
      grab: 9.0, // how fast its sideways momentum is scrubbed off, per second
      grabY: 1.6, // ... and the vertical, where gravity keeps most of its say
      stagger: 0.5, // seconds the circle's burns are spread over
      devour: 0.85, // fractions of a body per second, once it starts
      markMotes: 26, // the trickle off a body that has been marked
      burnMotes: 90, // ... and what comes off it while it goes
      condemnSparks: 30, // the frame its legs go out from under it
      condemnRing: 0.9, // the ring of light closing on that spot, metres
      takenMotes: 90,
      takenShake: 0.07
    },

    /* --- dynamic light --- */
    /**
     * Gold, high, and seated partway up the shaft rather than on the floor. It
     * has to be: this is the only light the shards ever get on the side that
     * faces the column, and a lamp at the foot of a thirty-metre beam leaves
     * everything hanging beside its head unlit.
     */
    lightIntensity: 30,
    lightRadius: 26,
    lightPulse: 0.4, // how much of the light the toll envelope owns
    lightHeight: 0.16, // where it sits, × the column's height
    lightColor: '#ffcf7a'
  },

  /* ------------------------------------------------------------------ */
  /* Camera rig                                                          */
  /* ------------------------------------------------------------------ */
  camera: {
    distance: 11.5,
    minDistance: 3.5,
    maxDistance: 30,
    zoomSpeed: 1.0,
    zoomDamping: 0.002,
    minPolar: 0.35,
    maxPolar: 1.32,
    fov: 46,
    targetHeight: 1.35,
    damping: 0.06,
    autoFrame: 0.35 // how strongly the rig drifts toward an active cast
  },

  /* ------------------------------------------------------------------ */
  /* Environment & lighting                                              */
  /* ------------------------------------------------------------------ */
  environment: {
    // A dark cinematic stage: one cool key, a colder rim from behind, and very
    // little fill, so the ice is the brightest thing on screen and the fog can
    // swallow the floor into the backdrop.
    sunIntensity: 2.6,
    sunColor: '#e8f3ff',
    sunAzimuth: 2.95,
    sunElevation: 0.6,
    ambientIntensity: 0.14,
    ambientColor: '#8ea8d8',
    hemiIntensity: 0.36,
    hemiSkyColor: '#bdd7ff',
    hemiGroundColor: '#3a4552',
    rimIntensity: 1.1,
    rimColor: '#9ec2ff',
    rimAzimuth: 5.45,
    rimElevation: 0.35,
    envIntensity: 0.32,
    backgroundColor: '#121820',
    // Fog is pulled well back so it only dissolves the far edge of the floor into
    // the backdrop rather than sitting on top of the action. Toggle and range are
    // both live in the editor (Environment → Backdrop, fog & dust).
    fogEnabled: true,
    fogColor: '#121820',
    fogNear: 26,
    fogFar: 135,
    shadowBias: -0.0008,
    shadowRadius: 2.2,
    floorColor: '#191f27',
    floorTint: '#232b35',
    floorRoughness: 0.88,
    floorSheen: 0.34,
    floorPool: 0.8,
    // The stone tiling that dresses the floor: ambientCG Rock030 (CC0), a rough
    // natural rock, living in public/textures/cathedral. `floorTextureScale` is metres of floor
    // one tile covers; `floorTexTint` grades the grey stone toward `floorTint` so
    // it sits inside the cool stage palette instead of fighting it.
    floorTexture: false,
    floorTextureScale: 12.0,
    floorNormalScale: 0.85,
    floorTexTint: 0.4,
    dustAmount: 0.85,
    contactShadow: 0.55
  },

  /* ------------------------------------------------------------------ */
  /* Post processing                                                     */
  /* ------------------------------------------------------------------ */
  post: {
    enabled: true,
    exposure: 1.05,
    // Threshold sits above the ice body's lit value on purpose: only the rim,
    // the glints and the impact should bloom, not the whole crystal field.
    // Strength is deliberately near zero — the crystal silhouette carries the
    // read, and bloom was the thing eating it. Push it up if you want the halo.
    bloomStrength: 0.03,
    bloomRadius: 0.6,
    bloomThreshold: 0.88,
    vignette: 0.52,
    chromaticAberration: 0.4,
    contrast: 1.12,
    saturation: 1.08,
    temperature: -0.03, // + warm / - cool
    lift: -0.008,
    gain: 1.0,
    grain: 0.045,
    // Master gain on the screen-space warp written by LAYER.DISTORTION — the
    // last link in the heat-haze chain. Screen widths, so it stays put when the
    // window resizes.
    distortion: 0.045,
    flashStrength: 1.0
  }
};

/**
 * How an ability is aimed.
 *
 * `LINE` is the skillshot the sandbox started with: an arrow swung about the
 * caster, cast along its length. `ZONE` is the **far cast** — a circle with a
 * thick boundary dropped at the cursor, which answers the only question a
 * ground-targeted AoE has to answer before you commit: how much space is this
 * going to take. Both resolve to the same `cast(origin, direction, distance)`
 * event, so an ability never has to care which one aimed it; a zone ability
 * simply reads its target as `pointAt(1)` and works outward from there.
 */
export const CastShape = Object.freeze({
  LINE: 'line',
  ZONE: 'zone'
});

/**
 * Ability ids, in slot order.
 *
 * `AbilityManager`, the HUD, the aim controller and the editor all key off this
 * array, and the index is the slot the keyboard binds to — adding an eleventh
 * ability is a new file, an entry here and a settings block above.
 */
export const ELEMENTS = [
  'ward',
  'acid',
  'growth',
  'cyber',
  'venom',
  'quake',
  'ink',
  'astral',
  'cascade',
  'rend'
];

/**
 * Registry metadata: how an ability is presented, and how it is aimed.
 *
 * `key` must match `InputManager`. `cast` is read by `AimController` to pick
 * between the arrow and the circle; omit it and the ability is a line cast.
 */
export const ELEMENT_META = {
  ward: {
    label: 'Volcanic Ward',
    accent: '#ff4a2a',
    key: 'Q',
    hint: 'Volcanic Horror Ward',
    cast: CastShape.ZONE
  },
  acid: {
    label: 'Caustic Bloom',
    accent: '#9dff2b',
    key: 'E',
    hint: 'Poison Acid Aura',
    cast: CastShape.ZONE
  },
  growth: {
    label: "Arborist's Growth",
    accent: '#6effa8',
    key: 'R',
    hint: "Arborist's Growth Chrono-Summon",
    cast: CastShape.ZONE
  },
  cyber: { label: 'Cyber Serpent', accent: '#5fe9ff', key: 'F', hint: 'Neon Cyber Serpent' },
  venom: {
    label: 'Venom Surge',
    accent: '#a878f0',
    key: 'V',
    hint: 'Crystallized Venom Surge'
  },
  quake: {
    label: 'Monolith Rift',
    accent: '#c9bda6',
    key: 'X',
    hint: 'Brutalist Earth Blast'
  },
  ink: {
    label: 'Sumi Tide',
    accent: '#7fd6cf',
    key: 'B',
    hint: 'Ink-paint Water Zone',
    cast: CastShape.ZONE
  },
  astral: {
    label: 'Astral Void Blast',
    accent: '#b98cff',
    key: 'Z',
    hint: 'Cosmic Singularity',
    cast: CastShape.ZONE
  },
  cascade: {
    label: 'Baleful Cascade',
    accent: '#3ff0e0',
    key: 'N',
    hint: 'Baleful Cascade Mark',
    cast: CastShape.ZONE
  },
  rend: {
    label: 'Celestial Rend',
    accent: '#ffcf7a',
    key: 'K',
    hint: 'Judgment Cascade',
    cast: CastShape.ZONE
  }
};

/** How the given ability is aimed. Line unless its metadata says otherwise. */
export function castShapeOf(element) {
  return ELEMENT_META[element]?.cast ?? CastShape.LINE;
}

/** The footprint a far cast will cover, metres. 0 for a line cast. */
export function zoneRadiusOf(element) {
  return castShapeOf(element) === CastShape.ZONE ? (settings[element]?.zoneRadius ?? 0) : 0;
}

/** Immutable snapshot used by "Reset to defaults" and the preset system. */
export const DEFAULT_SETTINGS = structuredClone(settings);

/**
 * Deep-merge a plain object into `settings` in place.
 * Existing object identity is preserved so every live binding keeps working.
 */
export function applySettings(patch, target = settings) {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (target[key] && typeof target[key] === 'object') applySettings(value, target[key]);
    } else if (key in target) {
      target[key] = value;
    }
  }
  return target;
}

/** Restore every value to the shipped defaults (in place). */
export function resetSettings() {
  applySettings(structuredClone(DEFAULT_SETTINGS));
}

/** Serialisable clone of the current state. */
export function snapshotSettings() {
  return structuredClone(settings);
}
