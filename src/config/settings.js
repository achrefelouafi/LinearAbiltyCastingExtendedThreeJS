/**
 * settings.js — the single source of truth for every tweakable value in the sandbox.
 *
 * Nothing in the renderer owns state that lives here: shaders, particle systems,
 * lights and post processing all *read* these objects every frame. That is what
 * makes the real-time editor work without rebuilding anything — mutating a field
 * is immediately visible on screen, including on an ice field that is already
 * standing, and including while the clock is paused (`P`), which is when the
 * shapes are actually worth tuning.
 *
 * The one rule that keeps that promise: a system may only ever *sample* these
 * values. It must never copy one into a record at spawn time and read it back
 * later — see `IceAbility`, whose spike records hold nothing but unitless dice
 * rolls, and resolve every metre, radian and second against this file each frame.
 *
 * Conventions
 *  - Colours are stored as `#rrggbb` strings so lil-gui can bind them directly.
 *    Use `utils/color.js#getColor()` to read them as a cached THREE.Color.
 *  - `global` holds multipliers that scale everything at once (1 = neutral).
 *  - The per-ability blocks (`ice`, `thunder`, `meteor`, `beam`) hold absolute values.
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
  /* ICE — ability one                                                   */
  /* ================================================================== */
  /**
   * A glacial eruption: a fracture front races out along the aimed line and a
   * field of crystal spikes tears up out of the floor behind it, small and dense
   * at the caster, tall and violent at the far end.
   *
   * Everything is generated — the crystals are procedural geometry
   * (`assets/ProceduralGeometry.js`), their shading is a patched standard
   * material (`materials/IceMaterial.js`), the frost is a shader on a quad and
   * the mist, shards and glitter are GPU particles. There are no textures and no
   * meshes on disk.
   */
  ice: {
    /* --- the cast itself --- */
    range: 15.0, // maximum cast distance, metres
    minRange: 2.5, // closer than this and the cast is refused
    speed: 26.0, // how fast the fracture front travels, metres/second
    lifetime: 3.6, // seconds the field stands before it withdraws
    cooldown: 0.4, // seconds before the ability can be armed again
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the footprint the spikes fill --- */
    widthNear: 0.55, // half-width of the band at the caster, metres
    width: 2.5, // half-width at the far end, metres
    widthCurve: 0.75, // <1 flares early, >1 stays narrow then opens out
    spikeCount: 190, // instances spent on one cast (capped at 288)
    density: 1.0, // multiplier on that count
    clumping: 1.35, // >1 pulls spikes toward the centre line
    scatter: 0.55, // extra lateral jitter, fraction of the local half-width
    frontBias: 0.85, // <1 crowds spikes toward the impact point

    /* --- silhouette of the field --- */
    heightNear: 0.5, // spike height at the caster, metres
    height: 3.1, // spike height at the far end, metres
    heightCurve: 1.7, // how late the ramp climbs
    heightJitter: 0.55,
    crown: 0.55, // how much shorter the flank blades are than the spine, 0..1
    peak: 1.45, // extra height multiplier at the impact point
    peakWidth: 0.28, // how much of the line that swell covers, 0..1
    rubble: 0.42, // fraction of the spikes demoted to ankle-height shards
    rubbleScale: 0.3,

    /* --- an individual crystal --- */
    radius: 0.41, // base radius, metres
    radiusJitter: 0.93,
    taper: 0.69, // tip radius as a fraction of the base
    facets: 7, // sides of the prism (5–8 read best)
    roughness: 0.09, // how far the facets are pushed off a clean prism
    bend: 0.66, // sideways curve from base to tip
    lean: 0.42, // radians the spikes lean away from the caster
    leanJitter: 1.5,
    twist: 1.0, // random yaw, 0..1 of a full turn

    /* --- the eruption --- */
    riseTime: 0.17, // seconds from buried to full height
    riseOvershoot: 0.26, // how far past full height the punch carries
    riseStagger: 0.09, // seconds of random delay between neighbours
    settle: 0.55, // seconds the overshoot takes to damp out
    shatterDelay: 0.6, // seconds after `lifetime` before they start to go
    sinkTime: 1.0, // seconds to withdraw into the floor

    /* --- the ice material --- */
    colorDeep: '#3e737a', // the colour thick ice accumulates toward
    colorIce: '#8adaff', // body
    colorRim: '#f2feff', // fresnel edge
    colorCore: '#638797', // the light trapped inside a fresh crystal
    opacity: 0.92,
    depthTint: 1.15, // how fast the deep tint builds with thickness
    fresnel: 2.3,
    fresnelPower: 2.4,
    translucency: 1.5, // light bleeding through from behind
    envIntensity: 0.9, // how much of the HDR probe the facets catch
    facetSharp: 0.68, // crispness of the internal facet shading
    fracture: 0.62, // internal crack planes
    fractureScale: 6.5, // cracks per metre
    veins: 0.45, // milky feather-frost inside the crystal
    veinScale: 3.2,
    // Named `glint*` rather than `sparkle*` on purpose: these are the pinpoint
    // highlights on the crystal *surface*, and the `sparkle*` family further
    // down drives the glitter *particles*. Two different effects.
    glint: 1.1,
    glintScale: 34.0,
    glintSpeed: 0.7,
    frostLine: 0.5, // rime banding climbing the crystal
    glow: 0.85, // overall emissive gain
    edgeGlow: 1.1, // brightness of the silhouette rim
    birthGlow: 1.6, // extra glow on a crystal that has just erupted
    birthFade: 0.45, // seconds that birth flash lasts

    /* --- what the ground does --- */
    frostSpread: 1.35, // frost patch radius, × the local half-width
    frostRate: 3.6, // patches laid per metre of front travel
    frostLife: 7.0, // seconds a patch lingers
    frostIntensity: 0.85,
    frostCrystals: 1.5, // grain of the packed snow
    colorFrost: '#f0f9ff', // the lit face of the snow
    colorFrostEdge: '#79b6dd', // what it goes in its own shadow
    shockRadius: 5.5, // impact shockwave ring, metres
    colorShockA: '#5fd0ff', // body of the shockwave ring
    colorShockB: '#f2feff', // its crest

    /* --- mist, shards and glitter --- */
    /**
     * Every particle system is coloured by a four-stop gradient sampled over the
     * particle's own lifetime: `A` the instant it is born, `D` as it dies. They
     * are spelled out rather than derived from the crystal palette so the fog can
     * be warmed, or the glitter recoloured, without touching the ice itself.
     */
    mistRate: 260, // rolling ground fog, particles/second
    mistSize: 1.15,
    mistSpeed: 1.3,
    mistLifetime: 2.8,
    mistOpacity: 0.05,
    mistRise: 0.35, // how fast the fog lifts, metres/second
    colorMistA: '#f2feff',
    colorMistB: '#cdefff',
    colorMistC: '#a9e4ff',
    colorMistD: '#09304c',
    shardRate: 150, // ice chips thrown off the eruption
    shardSize: 0.075,
    shardSpeed: 7.0,
    shardLifetime: 1.7,
    shardGravity: -14.0,
    colorShardA: '#f2feff',
    colorShardB: '#a9e4ff',
    colorShardC: '#a9e4ff',
    colorShardD: '#12496f',
    sparkleRate: 130, // the rising glitter plume
    sparkleSize: 0.055,
    sparkleSpeed: 3.4,
    sparkleLifetime: 2.6,
    sparkleRise: 1.6, // upward drift, metres/second
    sparkleTurbulence: 0.55,
    colorSparkleA: '#f2feff',
    colorSparkleB: '#57c9ff',
    colorSparkleC: '#a9e4ff',
    colorSparkleD: '#041e32',

    /* --- dynamic light --- */
    lightIntensity: 9,
    lightRadius: 13,
    lightColor: '#7fd4ff',

    /* --- the impact at the far end --- */
    burstSize: 3.6,
    burstIntensity: 0.75,
    burstShards: 90, // extra chips thrown at the impact
    impactShake: 0.7,
    impactFlash: 0.12,
    shakeDuration: 0.9,
    rumble: 0.06, // continuous shake while the front travels
    // The frost shell mixes A→B across its billowing noise and lays C over the
    // crystallised plates and the fresnel rim, so C is the one that reads hot.
    colorBurstA: '#a9e4ff',
    colorBurstB: '#cdefff',
    colorBurstC: '#f2feff',
    colorFlash: '#f2feff' // the full-screen flash on impact
  },

  /* ================================================================== */
  /* THUNDER — ability two                                               */
  /* ================================================================== */
  /**
   * A bolt thrown from the caster's hand along the aimed line: a bundle of
   * lightning filaments that snap into existence, hold while they gutter, and
   * blow out. Reference for the look: `thundercast.jpg`.
   *
   * The bolt is **one mesh**. Every filament is an instance of the same ribbon
   * strip, and its entire shape — the sag of the axis, the fan of the bundle,
   * the kinks in an individual strand, the camera-facing width — is evaluated in
   * the vertex shader from the numbers below. Nothing about the path exists on
   * the CPU, which is why `strands`, `jitter` and `spread` reshape a bolt that
   * is already in the air, and do it with the clock paused.
   *
   * The one thing a cast *does* capture is `uSeed`, a single random number
   * rolled at spawn so two casts do not draw the identical bolt. That is an
   * event, not a dimension — the same rule `IceAbility` follows.
   */
  thunder: {
    /* --- the cast --- */
    range: 24.0, // maximum cast distance, metres
    minRange: 2.0, // closer than this and the cast is refused
    speed: 105.0, // how fast the strike front travels, metres/second
    lifetime: 0.45, // seconds the bolt holds after it lands
    fadeTime: 0.5, // seconds it takes to blow out
    cooldown: 0.5,
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the bolt leaves the caster --- */
    // The beam starts at the hand, not at the feet, so these are measured from
    // the caster's origin in the cast's own frame.
    handHeight: 1.28, // metres above the floor
    handForward: 0.55, // metres in front of the caster
    handSide: 0.16, // metres to the side (+ follows `Ability#side`)
    endHeight: 0.35, // height of the bolt where it lands, metres
    sag: 0.22, // metres the mid-span bows upward (negative droops)

    /* --- the bundle of filaments --- */
    strands: 9, // separate filaments (capped at 24)
    spread: 0.75, // metres the bundle fans out at the far end
    spreadNear: 0.05, // ... and at the hand
    spreadCurve: 1.6, // >1 keeps the bundle tight then opens it late
    twist: 0.45, // turns the bundle makes around the axis over its length
    twistSpeed: 0.8, // turns/second it rolls on top of that
    branchDim: 0.72, // how much dimmer an outer filament is than the spine

    /* --- the shape of one filament --- */
    jitter: 0.34, // metres of kink at the coarsest octave
    jitterScale: 0.85, // kinks per metre
    octaves: 4, // 1–5; each one halves the amplitude and doubles the rate
    jitterFalloff: 0.55, // amplitude kept per octave
    crawl: 3.2, // how fast the kinks slide along the bolt
    pinch: 0.14, // fraction of the span the ends are pulled straight over
    converge: 0.8, // how hard the far end is pulled onto the target, 0..1

    /* --- the ribbon --- */
    width: 0.025, // half-width of a filament at the hand, metres
    widthTip: 0.43, // that width at the impact point, as a fraction
    widthCurve: 1.09, // how early the taper happens
    coreWidth: 1.31, // multiplier on the central spine
    coreSharp: 4.95, // how hard the hot core falls off across the ribbon
    glowWidth: 5.7, // the halo, × the core width
    glowFalloff: 2.4, // how fast the halo fades across its ribbon
    glowOpacity: 0.49,
    softFade: 0.78, // metres of soft fade where the bolt meets geometry

    /* --- flicker & restrike --- */
    restrike: 24, // times/second the filaments re-roll their shape
    flicker: 0.3, // depth of the whole-bolt brightness stutter
    flickerSpeed: 34, // stutters/second
    strandFlash: 0.5, // how much individual filaments blink out
    tipGlow: 2.0, // extra heat on the leading edge while it travels
    tipLength: 0.08, // length of that leading edge, fraction of the span

    /* --- colour --- */
    colorCore: '#ffffff', // the centre of a filament
    colorInner: '#c9ecff',
    colorOuter: '#3aa0ff', // the outside of a filament
    colorHalo: '#0b3fc8', // the wide glow around the bundle
    glow: 2.3, // overall emissive gain
    opacity: 1.0,

    /* --- what the ground does --- */
    arcRate: 0.9, // electric burns laid per metre of front travel
    arcRadius: 1.5, // radius of one burn, metres
    arcLife: 0.6, // seconds a burn lingers
    arcIntensity: 1.0,
    arcBranches: 0.6, // how finely the burn splits into filaments
    scorchRadius: 0.5, // dark burn mark under the bolt, metres
    scorchLife: 6.5,
    scorchIntensity: 0.45,
    colorArc: '#9fdcff',
    colorScorch: '#080b11',
    colorEmber: '#4aa8ff',
    shockRadius: 6.5, // impact shockwave ring, metres
    colorShockA: '#c9ecff', // body of the shockwave ring
    colorShockB: '#ffffff', // its crest

    /* --- sparks, motes, smoke and debris --- */
    /**
     * As in `ice`: each system is coloured by a four-stop gradient sampled over
     * the particle's own lifetime, `A` at birth through `D` as it dies. Spelled
     * out rather than derived from the bolt palette, so the sparks can be made
     * to cool to orange while the filaments stay blue.
     */
    sparkRate: 240, // sparks thrown off the bolt, particles/second
    sparkSize: 0.16,
    sparkSpeed: 9.0,
    sparkLifetime: 0.5,
    sparkGravity: -12.0,
    sparkStretch: 0.18, // how far a spark smears along its velocity
    colorSparkA: '#ffffff',
    colorSparkB: '#ffffff',
    colorSparkC: '#c9ecff',
    colorSparkD: '#1e5b95',
    moteRate: 90, // the slow ionised motes drifting off the bolt
    moteSize: 0.05,
    moteSpeed: 1.5,
    moteLifetime: 1.6,
    moteRise: 1.0, // upward drift, metres/second
    moteTurbulence: 0.7,
    colorMoteA: '#ffffff',
    colorMoteB: '#c9ecff',
    colorMoteC: '#3aa0ff',
    colorMoteD: '#02195f',
    smokeRate: 50, // thin haze off the scorched floor
    smokeSize: 1.0,
    smokeSpeed: 1.1,
    smokeLifetime: 2.2,
    smokeOpacity: 0.06,
    smokeRise: 0.55,
    colorSmokeA: '#3d546e',
    colorSmokeB: '#33475e',
    colorSmokeC: '#33475e',
    colorSmokeD: '#1c2938',
    debrisRate: 24, // chips kicked off the floor under the bolt
    debrisSize: 0.055,
    debrisSpeed: 5.0,
    debrisLifetime: 1.3,
    debrisGravity: -17.0,
    colorDebrisA: '#252c36',
    colorDebrisB: '#1c222a',
    colorDebrisC: '#1c222a',
    colorDebrisD: '#1c222a',

    /* --- dynamic light --- */
    lightIntensity: 26,
    lightRadius: 17,
    lightColor: '#63b8ff',
    lightFlicker: 0.4, // depth of the light's gutter, 0 = steady
    lightFlickerSpeed: 26,

    /* --- the muzzle and the impact --- */
    // Both shells are the same shader: A→B is mixed across the billowing noise
    // and stays nearly empty, and C is what the racing filaments and the fresnel
    // rim are drawn in — so C is the one carrying the read.
    muzzleSize: 0.55, // the flash at the hand, metres
    muzzleIntensity: 1.9,
    castFlash: 0.1, // screen flash on release
    colorMuzzleA: '#3aa0ff',
    colorMuzzleB: '#c9ecff',
    colorMuzzleC: '#ffffff',
    colorCastFlash: '#c9ecff',
    burstSize: 3.0, // the shell at the impact point, metres
    burstIntensity: 1.4,
    burstSparks: 170, // extra sparks thrown at the impact
    burstDebris: 45,
    impactShake: 0.8,
    shakeDuration: 0.55,
    impactFlash: 0.28,
    rumble: 0.03, // continuous shake while the front travels
    colorBurstA: '#3aa0ff',
    colorBurstB: '#c9ecff',
    colorBurstC: '#ffffff',
    colorFlash: '#c9ecff' // the full-screen flash on impact
  },

  /* ================================================================== */
  /* METEOR — ability three                                              */
  /* ================================================================== */
  /**
   * A burning rock lobbed along the aimed line, which detonates on arrival.
   *
   * The rock is real geometry — a cratered, faceted asteroid generated by
   * `assets/ProceduralGeometry.js` — shaded by a patched standard material so it
   * casts and receives the stage's shadows. Its signature is the **lava seams**:
   * the zero crossing of an fbm field sampled in the rock's own local space, so
   * the cracks are welded to it and tumble with it. `chargeCurve` decides how
   * fast they prise open on the way in.
   *
   * Behind it hangs the **fire trail**: a black-body volume raymarched inside a
   * camera-facing proxy hull laid along the arc. See the `trail*` block.
   *
   * As in `ice` and `thunder`, a cast captures nothing but dice and timestamps:
   * one seed, one tumble axis and a few unitless rolls per debris chunk. The
   * trajectory, the size of the rock, the width of its seams and the whole
   * ballistic flight of every chunk are resolved against this block each frame —
   * which is why dragging `arc` re-lofts a meteor already in the air, and
   * dragging `chunkSpeed` re-throws debris that has already landed.
   */
  meteor: {
    /* --- the cast --- */
    range: 20.0, // maximum cast distance, metres
    minRange: 3.0, // closer than this and the cast is refused
    speed: 21.0, // how fast the rock travels downrange, metres/second
    lifetime: 2.2, // seconds the crater burns after the impact
    fadeTime: 1.6, // seconds everything takes to clear
    cooldown: 0.9,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the flight path --- */
    // The rock is thrown from a hand, so these are measured from the caster's
    // origin in the cast's own frame.
    handHeight: 1.35, // metres above the floor
    handForward: 0.6, // metres in front of the caster
    handSide: 0.2, // metres to the side (+ follows `Ability#side`)
    endHeight: 0.75, // height of the rock where it lands, metres
    arc: 2.6, // metres the mid-span lobs upward
    arcCurve: 0.85, // <1 flattens the top of the arc, >1 peaks it

    /* --- the rock --- */
    radius: 0.8, // metres
    facets: 3, // icosphere subdivisions, 0–3 (3 = 1280 triangles)
    lumpiness: 0.26, // low-frequency deformation, × the radius
    lumpScale: 1.5, // lumps per unit radius
    surfaceRoughness: 0.16, // high-frequency chipping
    cuts: 9, // planar fracture faces sliced off it
    cutDepth: 0.28, // how far in those planes bite, × the radius
    craters: 5, // impact bowls punched into it
    craterDepth: 0.18, // how deep those bowls go, × the radius
    craterSize: 0.5, // their angular radius, radians
    spin: 3.4, // tumble rate, radians/second

    /* --- the lava seams --- */
    chargeCurve: 1.6, // how late the rock heats up on its way in
    crackScale: 0.95, // seams per unit radius
    crackWidth: 0.045, // how wide a seam opens (doubled at full charge)
    crackBranches: 0.5, // strength of the finer seams splitting off
    crackGlow: 2.2,
    crackFlow: 0.7, // how much the magma brightness crawls
    crackFlowSpeed: 0.9,
    rockScale: 3.4, // mottling of the rock between the seams
    facetTint: 0.5, // per-facet value break-up — what makes it read as stone
    cavity: 0.25, // darkening down in the craters and the cut faces
    soot: 0.6, // charring either side of a seam
    rimHeat: 0.7, // heat sheath around the silhouette
    leadGlow: 0.9, // compression heat on the leading facets
    leadSharp: 2.6, // how tightly that hugs the nose
    glow: 0.75, // overall emissive gain
    envIntensity: 1.25, // how much of the HDR probe the rock catches
    colorRock: '#6e675f',
    colorChar: '#17130f',
    colorCrack: '#ff6a12',
    colorHot: '#fff3d0',

    /* --- the fire trail --- */
    /**
     * The burning wake, **raymarched as a black-body volume** — the firebending
     * stream from the freehand sandbox, re-aimed at the meteor's arc. The mesh
     * drawn is only a camera-facing proxy hull; the flame itself is integrated
     * inside it by `materials/VolumetricFireMaterial.js`, which is where the four
     * layers these controls drive (silhouette → vortex roll-up → turbulence →
     * shred) are explained.
     *
     * As with everything else here it is not a recorded history: the hull's
     * centre line is sampled straight off the trajectory, so these reshape fire
     * that is already in the air.
     *
     * The volume borrows the rock's palette — `colorHot`, `colorFlameMid`,
     * `colorFlameEdge`, `colorFlameSmoke` — but only reaches for it in
     * proportion to `trailPalette`; at 0 it is a pure Planckian radiator and the
     * colour comes out of `trailTempCore` / `trailTempEdge` instead.
     */
    trailSpan: 7.0, // metres of arc the fire covers behind the rock
    trailWidth: 0.66, // tube radius, metres
    trailHeadSize: 1.8, // fireball radius at the rock, × trailWidth
    trailPlume: 1.1, // upward stretch of the volume (buoyant elongation)
    trailWakeSpread: 0.22, // how far the spent gas behind the head has ballooned
    trailRise: 0.35, // how far the far end of the wake has floated upward, metres
    // Metre-scale lobes in the silhouette. Without these the outline stays a
    // capsule no matter how much fine turbulence is piled on top of it, and the
    // trail reads as a shaded tube.
    trailBulge: 0.18, // how far those lobes swell and pinch the local radius
    trailBulgeScale: 0.34, // lobes per metre — lower = bigger, slower shapes
    // Ring vortices shed off the head and travelling back down the wake. This is
    // what folds the field into curling, mushrooming billows; fbm alone can only
    // make clouds.
    trailVortex: 0.0, // roll-up strength
    trailRingFrequency: 0.0, // vortices per metre of stream
    trailRingSpeed: 4.0, // how fast they travel backwards
    // Kept low on purpose: rolling the noise frame hard around the axis wraps
    // the filaments circumferentially and the flame reads as concentric contour
    // lines rather than as tongues running along the flow.
    trailCurl: 0.0, // swirl of the density field around the axis
    trailTurbulence: 2.94, // noise amplitude eating into the volume
    trailWarp: 0.45, // domain warp — folds the noise into curling sheets
    trailTongue: 0.94, // < 1 stretches structures upward into licking tongues
    trailStreamStretch: 1.13, // < 1 draws them out along the flow
    // Radial shear: how far the fringe is dragged up and back relative to the
    // axis. This is what makes the edge structures read as licking tongues
    // rather than as blobs of the same shape at every radius.
    trailLick: 3.1,
    trailWisps: 0.81, // ridged filaments shredding the fringe into strands
    trailShred: 1.57, // how violently the fringe tears compared to the core
    trailOctaves: 5, // turbulence octaves (quality ↔ cost)
    trailSpeed: 4.62, // how fast the field streams backwards along the path
    trailBuoyancy: 3.5, // how fast it climbs inside the volume
    trailDetachment: 0.9, // how hard the tail tears into separate puffs
    trailNoiseStrength: 0.78,
    trailNoiseFrequency: 3.23,
    trailSoftness: 0.42, // 0 = hard tongues, 1 = a soft glow
    trailFlicker: 0.74,
    trailDensity: 2.09,
    trailSoot: 1.42, // absorption — how much the cool gas occludes
    trailCoreClarity: 0.54, // extinction left in the hottest gas (low = white blob)
    trailSteps: 35, // raymarch samples per pixel (quality ↔ cost)
    trailGlow: 3.06,
    trailOpacity: 0.96,
    trailTailFade: 0.71, // fraction of the trail that has already burnt out
    trailBurnout: 1.2, // seconds the trail takes to die after the impact
    // Temperature & radiance. The flame is shaded as a Planckian radiator: these
    // are the two ends of its temperature range in kelvin, and the exponent the
    // emitted power follows. 4 would be Stefan-Boltzmann; a little gentler keeps
    // the mid-tones off the floor at this exposure.
    trailTempCore: 1920,
    trailTempEdge: 1590,
    trailEmissionCurve: 4.79,
    trailHeatFocus: 1.54, // how fast the gas reaches full heat inside the surface
    trailHeatFalloff: 2.46, // how sharply it cools toward that surface
    // How far the turbulence is allowed to drag the temperature profile around.
    // Radiated power goes as a high power of T, so this number is amplified
    // several-fold on screen — past ~0.5 the noise's own contour lines start
    // showing through as agate banding.
    trailHeatFollow: 0.26,
    trailTailHeat: 0.36, // temperature of the spent gas at the far end of the wake
    trailPalette: 0.62, // 0 = pure black-body physics, 1 = the colour stops below
    trailScatter: 1.99, // firelight bouncing inside the sooty fringe
    trailScatterFalloff: 4.4, // how fast that bath dies away from the core
    colorFlameMid: '#ffb02e',
    colorFlameEdge: '#ff3d10',
    colorFlameSmoke: '#181616',

    /* --- the debris the rock breaks into --- */
    chunkCount: 18, // chunks thrown at the impact (capped at 28)
    chunkScale: 0.28, // their radius, × the meteor's
    chunkSpeed: 7.5, // metres/second they leave the crater at
    chunkForward: 0.55, // how far the spray is biased downrange
    chunkLoft: 1.0, // how steeply they are thrown
    chunkGravity: -17.0,
    chunkSpin: 6.0, // tumble rate, radians/second
    chunkCool: 2.6, // seconds a chunk's seams take to go out
    chunkLinger: 0.5, // seconds they lie there before sinking
    chunkSink: 1.0, // seconds to withdraw into the floor

    /* --- embers, sparks, smoke and grit --- */
    /**
     * As in `ice` and `thunder`: each system is coloured by a four-stop gradient
     * sampled over the particle's own lifetime, `A` at birth through `D` as it
     * dies. Spelled out rather than derived from the flame palette, so the
     * trail can be cooled to red while the rock itself stays white-hot.
     */
    emberRate: 180, // embers streaming off the rock, particles/second
    emberSize: 0.1,
    emberSpeed: 2.4,
    emberLifetime: 1.5,
    emberRise: 1.5, // buoyancy, metres/second
    emberGlow: 1.2,
    emberTurbulence: 0.5,
    colorEmberA: '#fff3d0',
    colorEmberB: '#ff9a2e',
    colorEmberC: '#ff3b0d',
    colorEmberD: '#2b0d05',
    sparkRate: 110, // sparks flung off it
    sparkSize: 0.14,
    sparkSpeed: 6.5,
    sparkLifetime: 0.8,
    sparkGravity: -11.0,
    sparkStretch: 0.16, // how far a spark smears along its velocity
    colorSparkA: '#fffdf2',
    colorSparkB: '#ffd27a',
    colorSparkC: '#ff6a12',
    colorSparkD: '#3d1103',
    smokeRate: 70, // the trail and the column off the crater
    smokeSize: 1.1,
    smokeSpeed: 1.2,
    smokeLifetime: 3.0,
    smokeOpacity: 0.12,
    smokeRise: 0.9,
    colorSmokeA: '#6b503f',
    colorSmokeB: '#3b2c25',
    colorSmokeC: '#241b17',
    colorSmokeD: '#141010',
    debrisSize: 0.06, // grit kicked off the floor
    debrisSpeed: 6.0,
    debrisLifetime: 1.5,
    debrisGravity: -18.0,
    colorDebrisA: '#3a322c',
    colorDebrisB: '#2a231e',
    colorDebrisC: '#1c1714',
    colorDebrisD: '#151110',

    /* --- the molten cracks torn through the floor --- */
    /**
     * Real geometry, not a decal: arms of crack that meander outward from the
     * impact, shed branches, glow from a white-hot core through a wide orange
     * underglow, and heave basalt up along their lips. See
     * `effects/GroundFissures.js` — the network is baked in a unit disc, so
     * `fissureRadius` re-scales cracks that are already on the ground.
     */
    fissureRadius: 5.2, // how far the cracks reach, metres
    fissureLife: 6.5, // seconds before they close up
    fissureArms: 6, // main cracks radiating from the impact
    fissureWander: 1.6, // how hard an arm veers, radians per unit walked
    fissureBranches: 0.75, // fraction of the generated branches kept, 0..1
    fissureBranchLength: 0.85, // how far along a branch runs before its point, 0..1
    fissureWidth: 0.14, // width of the open seam, metres
    fissureHeat: 1.5, // core temperature
    fissurePulse: 1.0, // speed of the heat waves travelling along them
    fissureGrowth: 9.0, // how fast the cracks race outward, metres/second
    fissureRockSize: 0.3, // basalt heaved up along the lips, metres

    /* --- what else the ground does --- */
    scorchRadius: 2.8, // burnt patch under it, metres
    scorchLife: 8.0,
    scorchIntensity: 0.95,
    shockRadius: 6.0, // impact shockwave ring, metres
    colorScorch: '#0d0907',
    colorShockA: '#ff9a2e', // body of the shockwave ring
    colorShockB: '#fff3d0', // its crest

    /* --- dynamic light --- */
    lightIntensity: 16,
    lightRadius: 14,
    lightColor: '#ff8a3c',
    lightFlicker: 0.25, // depth of the light's gutter, 0 = steady
    lightFlickerSpeed: 13,

    /* --- the launch and the detonation --- */
    muzzleSize: 0.0, // the flare at the hand as the rock leaves it — 0 = none
    muzzleIntensity: 1.6,
    castFlash: 0.08, // screen flash on release
    colorCastFlash: '#ff9a2e',
    burstSize: 3.6, // the fireball at the impact point, metres
    burstIntensity: 1.0,
    burstTurbulence: 2.0, // how hard the noise eats into the fireball's shell
    burstEmbers: 260, // extra embers thrown at the impact
    burstSparks: 180,
    burstDebris: 90,
    burstSmoke: 70,
    impactShake: 1.0,
    shakeDuration: 1.1,
    impactFlash: 0.3,
    rumble: 0.04, // continuous shake while the rock is in the air
    colorFlash: '#ff9a2e' // the full-screen flash on impact
  },

  /* ================================================================== */
  /* BEAM — ability four                                                 */
  /* ================================================================== */
  /**
   * A sustained super beam: the caster winds up a ball of light in both hands,
   * then lets a column of it out along the aimed line, where it *stays* —
   * burning into the floor for `lifetime` before it collapses back to a thread
   * and blinks out. Reference for the look: `superbeam.jpg`.
   *
   * This is the ability with a **fourth beat**. Ice, thunder and meteor all run
   * travel → impact → fade; the beam puts a `charge` in front of that, so the
   * shot is something you watch arrive *and* something that lands and holds.
   * Nothing in the base class needed changing for it — `BeamAbility` simply
   * refuses to let the front leave the hand until the orb is up to power.
   *
   * The column is **one tube** — see `assets/ProceduralGeometry.js` — drawn
   * three times at three radii by `materials/BeamMaterial.js`: a wide halo, a
   * hollow rim-weighted sheath and, inside it, a core weighted the *opposite*
   * way, brightest where the view ray runs down the barrel. That inversion is
   * what makes the middle read as a solid rod of light instead of as a lit
   * pipe. The coils spiralling around it and the shock discs racing down it are
   * two more instanced passes placed against the same radius profile, so all
   * five stay welded together when the shape is dragged.
   *
   * Deliberately *not* electric: no kinks anywhere. The bolt's noise is
   * piecewise-linear so it keeps its corners; every noise term here is smooth
   * and stretched hard along the flow, because a beam that kinks is a bolt.
   *
   * As in every other block, a cast captures nothing but one seed and a few
   * timestamps. The barrel, the flare, the coil pitch and the disc train are all
   * resolved against these numbers each frame — which is why dragging `radius`
   * re-bores a beam that is already burning, with the clock stopped.
   */
  beam: {
    /* --- the cast --- */
    range: 26.0, // maximum cast distance, metres
    minRange: 3.0, // closer than this and the cast is refused
    charge: 0.42, // seconds the orb winds up before the beam is let out
    speed: 150.0, // how fast the leading edge races downrange, metres/second
    lifetime: 1.15, // seconds it burns once it lands
    fadeTime: 0.4, // seconds it takes to collapse
    cooldown: 1.6,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where it leaves the caster --- */
    // Both hands, so this one sits on the centre line rather than off a
    // shoulder like the bolt and the rock.
    handHeight: 1.3, // metres above the floor
    handForward: 0.72, // metres in front of the caster
    handSide: 0.0, // metres to the side (+ follows `Ability#side`)
    endHeight: 1.0, // height of the beam where it lands, metres

    /* --- the column --- */
    // A narrow throat that stays tight (`radiusCurve` above 1) and then opens
    // hard over the last tenth of the span: the beam reads as a jet with a bell
    // on the end rather than as a cone, which is what puts the weight at the
    // impact instead of spreading it down the whole line.
    radiusNear: 0.16, // half-width at the muzzle, metres
    radius: 0.77, // half-width at the target
    radiusCurve: 1.27, // <1 opens out early, >1 stays tight then flares late
    flare: 1.74, // extra swell where it lands
    flareWidth: 0.09, // how much of the span that swell covers, 0..1
    // Both wobbles ship at zero. The column reads cleaner with a hard, still
    // silhouette — the coils already give the eye something moving to follow —
    // but the rates below are tuned, so raising either one is a single drag.
    throb: 0.0, // pressure waves travelling out along it
    throbScale: 4.8, // waves over the length
    throbSpeed: 2.6, // waves/second
    wander: 0.0, // metres the axis drifts, pinned at both ends
    wanderScale: 0.9, // drift features per unit length
    wanderSpeed: 0.7,

    /* --- the three tube passes --- */
    // The core is deliberately narrow and not fully opaque. Widen it or push
    // `coreFill` up and the three layers stack into one white rod: the cyan
    // sheath and the gold coils are only readable because the middle leaves
    // them room.
    coreWidth: 0.2, // the hot rod, × the column radius
    coreSharp: 1.55, // how tightly the core hugs the axis
    coreFill: 0.6, // how solid it reads
    shellWidth: 1.0, // the sheath
    shellRim: 1.15, // brightness of its silhouette edges
    shellFill: 0.18, // how much body it has between them
    shellOpacity: 0.95,
    // Wide and faint: the halo is atmosphere, not a second beam. Pushing its
    // opacity up fogs the sheath's silhouette edges, which are the read.
    haloWidth: 2.75, // the outer bloom
    haloRim: 4.3, // how tightly that hugs the silhouette
    haloOpacity: 0.14,
    edgePower: 2.2, // rim exponent shared by the sheath

    /* --- the surface --- */
    ripple: 0.2, // how far the noise pushes the barrel off round
    rippleBands: 2.2, // ripple features around the barrel
    rippleScale: 4.25, // ... and along it
    rippleSpeed: 2.0, // how fast they crawl downrange
    streak: 1.1, // filaments streaming along the flow
    streakSharp: 0.45, // 0 = a wash, 1 = hard threads
    streakScale: 4.2, // threads per unit length
    streakBands: 1.8, // ... and around the barrel
    // Kept low: the threads carry heat into the *sheath*, and pushing this up
    // whitens it out until the beam is one colour from axis to rim.
    streakGlow: 0.55, // how hot a thread burns in the sheath
    flowSpeed: 7.0, // how fast the whole field streams downrange
    mouthGlow: 1.6, // heat where the column leaves the orb
    mouthLength: 0.1, // how far that reaches, fraction of the span
    // Kept below the muzzle's: the flare and the impact shell already carry the
    // far end, and stacking a hot cap on top of them blows it out to a disc.
    tipGlow: 0.6, // heat on the leading edge / the burning end
    tipLength: 0.09, // length of that edge, fraction of the span
    softFade: 0.62, // metres of soft fade where it meets geometry

    /* --- colour --- */
    colorCore: '#ffffff', // the axis
    colorInner: '#d3f4ff',
    colorOuter: '#3ec6ff', // the outside of the sheath
    colorHalo: '#0d3ce0', // the wide bloom around it
    // The column is deliberately held *back*. Three additive tube passes at full
    // strength clip to white and the beam becomes a flat plank; dropping the
    // gain and the opacity keeps it glassy and hands the read to the coils.
    glow: 0.74, // overall emissive gain
    opacity: 0.29,

    /* --- the coils --- */
    /**
     * Ribbons spiralling around the column, on the same strip the bolt is drawn
     * on. Warm on purpose: the reference frames a white-hot beam with gold
     * coils, and the colour split is what stops them dissolving into the sheath.
     */
    coils: 4, // ribbons (capped at 8)
    coilTurns: 1.45, // turns each one makes over the length
    // Negative, so the ribbons roll *against* the direction the charge pulse
    // runs. The two motions reading differently is what keeps a held beam from
    // looking like a single rotating screw.
    coilSpeed: -0.69, // turns/second they roll on top of that
    coilRadius: 1.88, // how far out they ride, × the column radius
    coilFlare: 0.57, // extra opening at the far end
    coilWidth: 0.1, // half-width at the muzzle, metres
    coilWidthTip: 1.9, // that width at the target, as a multiple
    coilSharp: 2.2, // how hard the ribbon falls off across its width
    coilPulse: 0.65, // depth of the charge running along it
    coilPulseFreq: 3.0, // pulses over the length
    coilPulseSpeed: 1.6, // pulses/second
    // Driven hard on purpose. With the column dialled back above, the ribbons
    // are what the eye actually follows down the beam.
    coilGlow: 8.0,
    coilOpacity: 2.0,
    colorCoil: '#ffdc8c',
    colorCoilEdge: '#ff6a12',

    /* --- the shock discs --- */
    rings: 10, // discs in flight (capped at 12)
    ringSpeed: 1.31, // trips down the beam per second
    // Both lips well clear of the sheath, and close together: the discs read as
    // thin hoops orbiting the column rather than as plates growing out of it.
    ringInner: 2.42, // inner lip, × the local column radius
    ringOuter: 2.73, // outer lip
    ringSwell: 0.55, // how much they open out as they travel
    ringFade: 0.18, // how much is left of one by the time it lands
    ringSharp: 1.6, // how thin the band reads
    ringGlow: 2.4,
    ringOpacity: 0.7,
    colorRing: '#9ceeff',

    /* --- the charge orb --- */
    orbSize: 0.39, // radius once it is up to power, metres
    orbThrob: 0.11, // how hard it pulses
    orbThrobSpeed: 6.9,
    orbTurbulence: 0.24, // how far the noise eats into its surface
    orbScale: 2.2, // features over the surface
    orbFlow: 0.9, // how fast they crawl
    orbBands: 5.0, // filament frequency
    orbRim: 1.8, // rim exponent
    orbGlow: 2.8,
    orbOpacity: 1.0,

    /* --- what the ground does --- */
    scorchRate: 1.1, // burns laid per metre of front travel
    scorchRadius: 0.7, // radius of one, metres
    scorchLife: 7.0, // seconds it lingers
    scorchIntensity: 0.55,
    colorScorch: '#0a0d14',
    colorEmber: '#4ad6ff',
    dustRate: 7.0, // dust rings thrown off the burning end, per second
    dustRadius: 2.4, // radius of one, metres
    dustLife: 0.9,
    colorDustA: '#3d5c74',
    colorDustB: '#9ceeff',
    shockRate: 3.5, // pressure rings snapped across the floor, per second
    shockRadius: 7.0, // radius of the one at the impact, metres
    colorShockA: '#3ec6ff', // body of the shockwave ring
    colorShockB: '#ffffff', // its crest

    /* --- sparks, motes, smoke and debris --- */
    /**
     * As in `ice`, `thunder` and `meteor`: each system is coloured by a four-stop
     * gradient sampled over the particle's own lifetime, `A` at birth through
     * `D` as it dies. The motes do double duty — they are the intake spiralling
     * *into* the orb while it charges, and the drift shed off the column once it
     * is firing.
     */
    sparkRate: 300, // sparks shed off the column, particles/second
    sparkSize: 0.15,
    sparkSpeed: 8.0,
    sparkLifetime: 0.55,
    sparkGravity: -9.0,
    sparkStretch: 0.22, // how far a spark smears along its velocity
    sparkForward: 0.9, // how hard the spray is dragged downrange
    colorSparkA: '#ffffff',
    colorSparkB: '#d3f4ff',
    colorSparkC: '#3ec6ff',
    colorSparkD: '#0b2f7a',
    moteRate: 120, // the drift hanging around the column
    moteSize: 0.06,
    moteSpeed: 1.6,
    moteLifetime: 1.5,
    moteRise: 0.9, // upward drift, metres/second
    moteTurbulence: 0.8,
    colorMoteA: '#ffffff',
    colorMoteB: '#9ceeff',
    colorMoteC: '#3ec6ff',
    colorMoteD: '#06205e',
    intakeRate: 260, // motes pulled into the orb while it charges
    intakeRadius: 2.6, // how far out they are drawn from, metres
    intakeSpeed: 7.5, // how fast they fall in
    smokeRate: 90, // steam scoured off the floor under the beam
    smokeSize: 1.1,
    smokeSpeed: 1.4,
    smokeLifetime: 2.4,
    smokeOpacity: 0.07,
    smokeRise: 0.7,
    colorSmokeA: '#41566d',
    colorSmokeB: '#35485e',
    colorSmokeC: '#2a3949',
    colorSmokeD: '#1a2430',
    debrisRate: 34, // chips torn off the floor along the burn line
    debrisSize: 0.06,
    debrisSpeed: 6.0,
    debrisLifetime: 1.4,
    debrisGravity: -18.0,
    colorDebrisA: '#2b323c',
    colorDebrisB: '#1f252d',
    colorDebrisC: '#1a1f26',
    colorDebrisD: '#1a1f26',

    /* --- dynamic light --- */
    // Two lights: one rides the beam, one sits in the caster's hands so the
    // charge actually lights the body that is holding it.
    lightIntensity: 30,
    lightRadius: 20,
    lightColor: '#7fdcff',
    lightPulse: 0.18, // depth of the hum, 0 = steady
    lightPulseSpeed: 5.0, // pulses/second
    muzzleLightIntensity: 16,
    muzzleLightRadius: 9,

    /* --- the wind-up, the release and the burn --- */
    chargeShake: 0.045, // rumble while the orb spools up
    castFlash: 0.22, // screen flash as it is released
    muzzleSize: 1.1, // the pressure shell thrown off the hands, metres
    muzzleIntensity: 2.0,
    colorCastFlash: '#d3f4ff',
    burstSize: 4.2, // the shell at the impact point, metres
    burstIntensity: 1.6,
    burstSparks: 220, // extra sparks thrown when it lands
    burstDebris: 70,
    pulseRate: 2.6, // pressure shells off the burning end, per second
    pulseSize: 2.2, // radius of one, metres
    pulseIntensity: 1.1,
    splashRate: 260, // sparks kicked back up the beam while it burns
    impactShake: 0.9,
    shakeDuration: 0.7,
    burnShake: 0.09, // continuous rumble while the beam is standing
    impactFlash: 0.3,
    rumble: 0.05, // rumble while the leading edge travels
    colorBurstA: '#3ec6ff',
    colorBurstB: '#d3f4ff',
    colorBurstC: '#ffffff',
    colorFlash: '#d3f4ff' // the full-screen flash on impact
  },

  /* ================================================================== */
  /* SNARE — ability five, and the first **far cast**                    */
  /* ================================================================== */
  /**
   * A trap planted at a point rather than a shot fired along a line: the caster
   * whips a leash of current out across the floor, and where it lands the ring
   * snaps open — a column of lightning tears up out of the middle, tendrils
   * crawl outward to the boundary and arcs run around the rim, all of it
   * holding, re-striking and dragging the air upward for `lifetime` before it
   * collapses. Reference for the look: `electricalboost.jpg`.
   *
   * This is the block that defines what a far cast *is* in this project. The
   * targeting is a circle (see the `zone` block) and `zoneRadius` is the promise
   * that circle makes: the boundary the indicator draws is the boundary the
   * field burns, the tendrils reach and the rim arcs run along, so dragging that
   * one number re-scales the indicator and a snare that is already standing
   * together.
   *
   * The whole cage is **one instanced strip** — see `materials/SnareMaterial.js`.
   * Every filament is the same ribbon, and a *role* decided from its instance
   * index (leash → column → tendril → rim) picks which parametric path the
   * vertex shader threads it along. Two draw calls for all four, however many
   * filaments are in the air.
   *
   * As in every other block, a cast captures nothing but a seed and a few
   * timestamps. Every metre, radian and second is resolved against these numbers
   * each frame — including a zero-length one, which is why the trap reshapes
   * under the sliders with the clock stopped.
   */
  snare: {
    /* --- the cast --- */
    range: 20.0, // maximum cast distance, metres
    minRange: 0.0, // a trap can legitimately be dropped on your own feet
    zoneRadius: 4.4, // the footprint — what the circle indicator measures out
    speed: 62.0, // how fast the leash races to the point, metres/second
    snapTime: 0.16, // seconds the ring takes to slam open once it lands
    lifetime: 2.6, // seconds the snare stands
    fadeTime: 0.75, // seconds it takes to collapse
    cooldown: 1.4,
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the leash that plants it --- */
    // Thrown from a hand, so these are measured from the caster's origin in the
    // cast's own frame, exactly as the bolt and the rock are.
    handHeight: 1.24, // metres above the floor
    handForward: 0.58, // metres in front of the caster
    handSide: 0.18, // metres to the side (+ follows `Ability#side`)
    leashStrands: 3, // filaments in the whip
    leashSag: -0.35, // metres the mid-span bows (negative drops it to the floor)
    leashSpread: 0.22, // how far the filaments separate, metres
    leashKink: 0.3, // kink amplitude on the whip, metres
    leashWidth: 1.0, // × the shared filament width
    leashCling: 0.12, // how far above the floor the tip runs, metres

    /* --- the column --- */
    strands: 15, // filaments in the pillar
    height: 9.2, // how high it reaches, metres
    heightCurve: 1.45, // <1 gets it up fast, >1 makes it climb late
    throat: 0.16, // radius where it leaves the floor, × zoneRadius
    columnSpread: 0.25, // radius at the top, × zoneRadius
    columnCurve: 2.88, // >1 keeps the throat tight then opens it late
    columnFlare: 0.585, // extra opening over the last quarter, × zoneRadius
    columnTwist: 0.22, // turns a filament makes over the climb
    columnSpin: 1.26, // turns/second the whole pillar rolls
    columnKink: 0.27, // kink amplitude, metres
    columnWidth: 1.86, // × the shared filament width
    columnTaper: 1.09, // how much thinner the top is than the base

    /* --- the tendrils crawling out to the boundary --- */
    tendrils: 20, // separate ground filaments (capped with the rest at 56)
    tendrilInner: 0.0, // where they leave the column, × zoneRadius
    tendrilReach: 1.07, // where they end, × zoneRadius (1 = exactly on the band)
    tendrilCurve: 1.18, // <1 throws them outward early
    tendrilWander: 1.41, // radians a tendril veers over its run
    tendrilArch: 1.16, // metres it hops off the floor mid-span
    tendrilHug: 0.005, // how far above the floor it runs, metres
    tendrilSpin: -0.225, // turns/second the whole fan rotates
    tendrilKink: 0.72, // kink amplitude, metres
    tendrilWidth: 0.75, // × the shared filament width
    tendrilDim: 0.8, // how much dimmer than the column

    /* --- the arcs running around the rim --- */
    rimArcs: 14, // arcs on the boundary at once
    rimSpan: 0.335, // fraction of the circle one arc covers
    rimSpeed: -1.84, // revolutions/second they travel
    // High enough to clear the burnt band underneath them: an arc that hops
    // 0.3 m over a band this bright is simply invisible.
    rimHeight: 0.98, // metres they hop at mid-span
    rimJitter: 0.23, // radial wobble, × zoneRadius
    rimKink: 0.15, // kink amplitude, metres
    rimWidth: 0.85, // × the shared filament width
    rimDim: 1.0,

    /* --- the shape every filament shares --- */
    // The same piecewise-linear value noise the bolt uses — linear on purpose,
    // because smoothstep rounds the corners off and the corners are the entire
    // reason it reads as lightning.
    jitter: 1.0, // master multiplier on the four per-role kink amplitudes
    jitterScale: 1.4, // kinks per metre
    octaves: 4, // 1–5; each halves the amplitude and doubles the rate
    jitterFalloff: 0.55, // amplitude kept per octave
    crawl: 2.4, // how fast the kinks slide along a filament
    pinch: 0.16, // fraction of the span the ends are pulled straight over
    restrike: 21, // times/second every filament re-rolls its shape
    flicker: 0.26, // depth of the whole-cage brightness stutter
    flickerSpeed: 30,
    strandFlash: 0.45, // how much individual filaments blink out

    /* --- the ribbon --- */
    width: 0.032, // half-width of a filament, metres
    coreSharp: 4.4, // how hard the hot core falls off across the ribbon
    glowWidth: 6.2, // the halo, × the core width
    glowFalloff: 2.3, // how fast the halo fades across its ribbon
    glowOpacity: 0.44,
    softFade: 0.7, // metres of soft fade where a filament meets geometry

    /* --- colour --- */
    // Violet rather than the Storm Lance's blue: two electric abilities on the
    // bar need to be told apart at a glance, and the hue split does it before
    // the silhouette does.
    colorCore: '#ffffff', // the centre of a filament
    colorInner: '#dcd0ff',
    colorOuter: '#8f6bff', // the outside of a filament
    colorHalo: '#2a0e8c', // the wide glow around the cage
    glow: 2.2, // overall emissive gain
    opacity: 1.0,

    /* --- the field burnt into the floor --- */
    /**
     * The indicator's promise, made real: the same circle, the same thick
     * boundary, now a live shader instead of a targeting aid. It is an
     * ability-owned mesh rather than a decal precisely because a decal captures
     * its radius when it spawns — this one has to re-scale under `zoneRadius`
     * while it is standing.
     */
    fieldBoundary: 0.02, // thickness of the burnt band, metres
    fieldBoundaryGlow: 2.9,
    fieldFill: 0.65, // the wash inside it
    fieldFalloff: 3.6, // how hard that wash crowds to the rim
    fieldVeins: 2.98, // filaments burnt across the disc
    fieldVeinScale: 2.0, // veins per metre
    fieldVeinSharp: 0.72, // 0 = a wash, 1 = hard threads
    fieldWarp: 0.55, // domain warp — what stops the veins reading as spokes
    fieldCrawl: 0.5, // how fast they writhe
    fieldRings: 2.4, // pressure rings travelling out from the middle
    fieldRingSpeed: 0.8, // rings/second
    fieldSpokes: 20, // ticks stepping around the boundary
    fieldSpokeLength: 0.5, // how far they reach in, metres
    fieldSpin: 0.05, // revolutions/second the ticks step around
    fieldCore: 1.3, // brightness of the pool the column stands in
    fieldCoreSize: 0.22, // its radius, × zoneRadius
    fieldPulse: 0.0, // brightness breathing
    fieldPulseSpeed: 3.95,
    fieldOpacity: 1.0,
    fieldHeight: 0.03, // hover distance above the floor, metres
    colorField: '#8f6bff', // the wash and the veins
    colorFieldEdge: '#ffffff', // the boundary band and the core pool

    /* --- what else the ground does --- */
    arcRate: 5.0, // branching burns laid around the rim, per second
    arcRadius: 1.2, // radius of one, metres
    arcLife: 0.75,
    arcIntensity: 0.9,
    arcBranches: 0.7, // how finely a burn splits into filaments
    trailRate: 1.1, // burns laid per metre while the leash races out
    scorchRadius: 1.6, // dark burn under the column, metres
    scorchLife: 7.5,
    scorchIntensity: 0.5,
    colorArc: '#c3b0ff',
    colorEmber: '#8f6bff',
    colorScorch: '#0b0813',
    shockRadius: 7.0, // the ring that snaps out when the trap opens, metres
    colorShockA: '#8f6bff', // body of the shockwave ring
    colorShockB: '#ffffff', // its crest

    /* --- sparks, updraft, smoke and debris --- */
    /**
     * As in every other block: a four-stop gradient sampled over the particle's
     * own lifetime, `A` at birth through `D` as it dies. The **updraft** is this
     * ability's signature system — motes drawn off the whole disc and hauled
     * inward and up into the column, which is the read that says the trap is
     * pulling on the air rather than just sitting in it.
     */
    sparkRate: 320, // sparks thrown off the cage, particles/second
    sparkSize: 0.15,
    sparkSpeed: 8.5,
    sparkLifetime: 0.55,
    sparkGravity: -13.0,
    sparkStretch: 0.2, // how far a spark smears along its velocity
    colorSparkA: '#ffffff',
    colorSparkB: '#dcd0ff',
    colorSparkC: '#8f6bff',
    colorSparkD: '#2a0e8c',
    updraftRate: 210, // motes hauled up the column, particles/second
    updraftSize: 0.07,
    updraftSpeed: 6.0, // how fast they are pulled in
    updraftLifetime: 1.4,
    updraftRise: 5.5, // upward acceleration once they are inside, m/s²
    updraftInset: 0.15, // how far inside the boundary they are picked up
    updraftTurbulence: 0.9,
    colorUpdraftA: '#8f6bff',
    colorUpdraftB: '#dcd0ff',
    colorUpdraftC: '#ffffff',
    colorUpdraftD: '#1b0a5e',
    smokeRate: 70, // haze scoured off the burnt floor
    smokeSize: 1.05,
    smokeSpeed: 1.2,
    smokeLifetime: 2.4,
    smokeOpacity: 0.06,
    smokeRise: 0.6,
    colorSmokeA: '#4a4368',
    colorSmokeB: '#3a3554',
    colorSmokeC: '#2b2740',
    colorSmokeD: '#191728',
    debrisRate: 30, // chips torn off the floor inside the ring
    debrisSize: 0.055,
    debrisSpeed: 5.5,
    debrisLifetime: 1.3,
    debrisGravity: -17.0,
    colorDebrisA: '#2a2733',
    colorDebrisB: '#201e28',
    colorDebrisC: '#1a1822',
    colorDebrisD: '#1a1822',

    /* --- dynamic light --- */
    lightIntensity: 24,
    lightRadius: 18,
    lightHeight: 0.38, // how far up the column the light sits, 0..1
    lightColor: '#a98bff',
    lightFlicker: 0.38, // depth of the light's gutter, 0 = steady
    lightFlickerSpeed: 24,

    /* --- the throw, the snap and the hold --- */
    muzzleSize: 0.5, // the flash at the hand as the leash leaves it
    muzzleIntensity: 1.7,
    castFlash: 0.09, // screen flash on release
    colorCastFlash: '#c3b0ff',
    burstSize: 2.8, // the shell thrown off when the ring opens, metres
    burstIntensity: 1.5,
    burstSparks: 200, // extra sparks at the snap
    burstDebris: 60,
    pulseRate: 1.5, // pressure shells shed off the column while it holds, /s
    pulseSize: 1.2, // radius of one, metres
    pulseIntensity: 0.5,
    ringRate: 1.4, // dust rings pushed across the floor while it holds, /s
    impactShake: 0.85,
    shakeDuration: 0.6,
    holdShake: 0.07, // continuous rumble while the snare stands
    impactFlash: 0.26,
    rumble: 0.025, // rumble while the leash races out
    colorBurstA: '#8f6bff',
    colorBurstB: '#dcd0ff',
    colorBurstC: '#ffffff',
    colorFlash: '#c3b0ff' // the full-screen flash when it snaps open
  },

  /* ================================================================== */
  /* GLACIER — ability six, and the far cast that comes out of the floor */
  /* ================================================================== */
  /**
   * A cold front races along the floor to the aimed point, the disc freezes out
   * to the boundary the circle drew, and a wall of crystal tears up out of the
   * ground around it: a ring of blades leaning outward with a skirt of wreckage
   * banked against their feet. It stands, glints, breathes cold off its rim —
   * and then breaks into plates and sinks back into the floor. Reference for the
   * look: `Hud7Xfg3LH.jpg`.
   *
   * The **middle stays open**: every shard is seated in a band about
   * `zoneRadius` and nothing is planted in the centre, because the read is a
   * wall you are looking into and filling the disc stops it being a ring. What
   * lives inside it is air and frozen ground.
   *
   * The second **far cast**, and the counterpart to the Voltaic Snare: same
   * circle, same promise, opposite answer. The snare fills the footprint with
   * current standing in the air; this one fills it with geometry standing on the
   * ground, so `zoneRadius` is again the one number that matters — it is where
   * the ring of blades is seated, where the sheet's boundary band burns, where
   * the curtain of cold air stands and where the rime creeps.
   *
   * Three things carry it, and each has its own group below:
   *
   *  - **the sweep.** The ring does not appear; it *closes*. The blade nearest
   *    the caster goes up first and the wave runs around both sides to meet
   *    behind the crown (`sweepTime`), with the skirt banking up behind the wave
   *    (`skirtDelay`, `skirtWave`).
   *  - **the freeze front.** Every shard crystallises upward along its own axis
   *    while it rises (`frontRough`, `frontWidth`, `frontGlow` — see
   *    `materials/GlacierMaterial.js`), so the ice *forms* rather than sliding
   *    out of a hole.
   *  - **the shatter.** It leaves the same way it arrived, in pieces: a
   *    per-shard ramp against a chunk id made of voronoi cells and flat facets,
   *    so plates and wedges come away one at a time (`shatterScale`,
   *    `shatterEdge`, `shatterGlow`).
   *
   * As in every other block, a cast captures nothing but a seed and a handful of
   * timestamps. Every metre, radian and second is resolved against these numbers
   * each frame — including a zero-length one, which is why the crown reshapes
   * under the sliders with the clock stopped.
   */
  glacier: {
    /* --- the cast --- */
    range: 18.0, // maximum cast distance, metres
    minRange: 0.0, // a wall of ice around your own feet is a legitimate play
    zoneRadius: 4.6, // the footprint — what the circle indicator measures out
    speed: 44.0, // how fast the front races to the point, metres/second
    snapTime: 0.22, // seconds the sheet takes to freeze out to the boundary
    lifetime: 4.2, // seconds the crown stands
    shatterDelay: 0.5, // seconds after `lifetime` before the ice starts to break
    shatterStagger: 0.45, // seconds of random delay between neighbours
    sinkTime: 1.15, // seconds one shard takes to crumble and withdraw
    cooldown: 1.6,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the front leaves the caster --- */
    // Thrown from a hand, so these are measured from the caster's origin in the
    // cast's own frame, exactly as the bolt, the rock and the leash are.
    handHeight: 1.22, // metres above the floor
    handForward: 0.6, // metres in front of the caster
    handSide: 0.18, // metres to the side (+ follows `Ability#side`)

    /* --- how the footprint is filled --- */
    /**
     * Everything is seated in a band about `zoneRadius`; the middle of the
     * circle is left empty on purpose, because the read of the ability is a wall
     * you are looking *into* and filling the disc stops it being a ring. The
     * spire in the middle is kept as a control and ships at zero.
     */
    spikeCount: 220, // instances spent on one cast (capped at 320)
    density: 1.0, // multiplier on that count
    ringShare: 0.6, // fraction of them spent on the wall at the boundary
    coreShare: 0.0, // ... on the spire in the middle (0 = the middle stays open)
    lateShare: 0.12, // ... held back to push up during the hold
    ringSeat: 0.94, // where the wall stands, × zoneRadius
    ringScatter: 0.16, // radial jitter of the wall, × zoneRadius
    skirtSeat: 0.74, // inner lip of the wreckage banked against it, × zoneRadius
    skirtBand: 0.42, // how wide that band is, × zoneRadius
    skirtBias: 0.9, // <1 pushes the skirt outward, >1 crowds it inward
    coreSpread: 0.16, // radius of the cluster in the middle, × zoneRadius

    /* --- the silhouette --- */
    /**
     * The reference is a *starburst*, not a fence: long needles thrown outward
     * from the rim at a steep angle, fanned off the radius so they cross, with
     * wildly uneven lengths. `ringLean` is the single control that decides
     * whether this reads as a crown or a picket line — at 0 it is a fence, and
     * the higher it goes the further the blades are thrown out over the floor.
     */
    ringHeight: 1.4, // length of a blade on the wall, metres
    ringWave: 0.61, // how uneven the crest of that wall is, 0..1
    skirtHeight: 1.7, // length of a shard in the skirt, metres
    coreHeight: 5.2, // length of the spire, metres
    heightJitter: 0.65,
    ringLean: 0.33, // radians the wall is thrown outward (≈19°)
    skirtLean: 0.3, // ... and the skirt
    coreLean: 0.2, // the spire stands nearly upright
    leanJitter: 1.3,
    fan: 1.16, // radians a blade is splayed off its own radius, ± — the crossing
    twist: 1.0, // random yaw, 0..1 of a full turn
    rubble: 0.53, // fraction of the skirt demoted to ankle-height wreckage
    rubbleScale: 0.34,

    /* --- an individual crystal --- */
    // Blunt wedges rather than needles: a thick base that only narrows to about
    // a third at the tip, so each facet stays wide enough to catch a flash.
    radius: 0.375, // base radius, metres
    radiusJitter: 0.94,
    taper: 0.36, // tip radius as a fraction of the base
    facets: 7, // sides of the prism — fewer, so each facet is a broad flash
    roughness: 0.0, // how far the facets are pushed off a clean prism
    bend: 0.0, // sideways curve from base to tip — nearly straight

    /* --- the bloom: when each shard goes up --- */
    riseTime: 0.2, // seconds from buried to full height
    riseOvershoot: 0.3, // how far past full height the punch carries
    settle: 0.5, // seconds the overshoot takes to damp out
    sweepTime: 0.42, // seconds the wave takes to run around the ring
    skirtDelay: 0.1, // seconds before the skirt starts
    skirtWave: 0.26, // ... and how long it takes to cross the band
    coreDelay: 0.2, // seconds before the spire comes up
    stagger: 0.07, // seconds of random delay on top of all of it
    bloomSpread: 0.7, // fraction of the hold the late shards are scattered over

    /* --- the ice: prismatic glass, not the Lance's quarried crystal --- */
    /**
     * Deliberately the *opposite* treatment to `ice`. Two frost abilities on one
     * bar have to be told apart before the silhouette does it, and a recolour is
     * not enough — so where the Frost Lance is milky, diffuse and tinted deeper
     * the thicker it gets, these blades are near-empty glass carried entirely by
     * their edges: a chromatically split fresnel (`dispersion`), light piped up
     * the body to an incandescent point (`pipe`, `tipBias`, `tipGlow`), flow
     * lines instead of feather frost (`stria`) and one real reflection of the
     * stage off every facet (`envIntensity`, `specular`).
     * See `materials/GlacierMaterial.js`.
     */
    colorGlass: '#0e4a66', // the little body it has
    colorEdge: '#ffffff', // the silhouette, the flow lines and the glint
    colorPrismA: '#57f0ff', // one end of the dispersion split
    colorPrismB: '#8f9bff', // ... and the other
    colorCore: '#a8f4ff', // the light piped up the blade
    colorTip: '#ffffff', // the incandescent point
    body: 1.37, // how much of a body it has at all, 0 = pure edges
    edgePower: 1.14, // how tightly the silhouette hugs the rim
    edgeGain: 0.81, // how hard it burns
    dispersion: 0.73, // how far the red, green and blue fresnels come apart
    pipe: 1.09, // light piped along the blade
    tipBias: 1.6, // how hard that light crowds toward the point
    bands: 1.4, // slow waves travelling up it
    pulseSpeed: 0.6,
    tipStart: 0.6, // where the incandescent tip begins, 0..1 up the blade
    tipGlow: 1.5,
    stria: 0.75, // flow lines running the blade's length
    striaScale: 6.0,
    envIntensity: 0.6, // how much of the HDR probe the facets catch
    specular: 2.0, // the tight sun lobe off them
    glow: 1.0, // overall emissive gain
    opacity: 1.0,
    birthGlow: 2.2, // extra glow on a shard that has just erupted
    birthFade: 0.5, // seconds that birth flash lasts

    /* --- the freeze front and the shatter --- */
    /**
     * The two things that make this ability's ice *arrive* and *leave* rather
     * than fade in and out. Both are per-instance ramps the ability drives; what
     * lives here is only their look.
     */
    frontRough: 0.35, // how ragged the crystallising edge is
    frontWidth: 0.12, // how much of the shard is lit behind that edge
    frontGlow: 2.4, // how hard it burns
    shatterScale: 7.0, // break-up cells per unit of the crystal
    shatterEdge: 0.08, // width of the lit rim on a fresh break
    shatterGlow: 3.0,

    /* --- the sheet of ice on the floor --- */
    /**
     * The indicator's promise, made real: the same circle and the same thick
     * boundary, now a frozen sheet instead of a targeting aid. An ability-owned
     * mesh rather than a decal precisely because a decal captures its radius
     * when it spawns — this one has to re-scale under `zoneRadius` while the
     * crown is standing, and to run its own front outward and back.
     */
    fieldBoundary: 0.4, // thickness of the band at the edge, metres
    fieldBoundaryGlow: 2.4,
    fieldFill: 0.26, // the wash inside it
    fieldFalloff: 1.4, // how hard that wash crowds to the rim
    fieldPlates: 1.0, // tonal break-up between plates
    fieldPlateScale: 2.2, // plates per metre
    fieldSeam: 0.8, // rime piled in the seams between them
    fieldFingers: 0.9, // frost fingers crawling over the sheet
    fieldFingerScale: 1.6, // fingers per metre
    fieldWarp: 0.5, // domain warp — what stops them reading as spokes
    fieldCrawl: 0.12, // how fast they writhe
    fieldRings: 2.6, // pressure rings travelling in toward the spire
    fieldRingSpeed: -0.5, // rings/second (negative travels inward)
    fieldSweep: 0.4, // slow cold sweep around the disc
    fieldSweepSpeed: 0.12, // revolutions/second
    fieldCore: 1.0, // brightness of the pool the spire stands in
    fieldCoreSize: 0.2, // its radius, × zoneRadius
    fieldPulse: 0.18, // brightness breathing
    fieldPulseSpeed: 1.6,
    fieldOpacity: 1.0,
    fieldHeight: 0.03, // hover distance above the floor, metres
    colorField: '#a7e6ff', // the wash, the plates and the fingers
    colorFieldEdge: '#ffffff', // the boundary band, the seams and the pool

    /* --- the curtain of cold air standing on the ring --- */
    /**
     * An open cylinder seated on the boundary, eroded by ridged noise stretched
     * hard vertically and scrolled downward. This is the piece that frames the
     * crown from the outside: without it the wall of blades ends at its own
     * silhouette, and a wall of ice that is not shedding cold reads as glass.
     * Set `veil` to 0 to take it off.
     */
    veil: 0.5, // master opacity of the curtain, 0 hides it
    veilHeight: 1.9, // how high it stands, metres
    veilRadius: 1.02, // where it stands, × zoneRadius
    veilFlare: 0.32, // how far it leans outward at the top
    veilBillow: 0.22, // metre-scale lobes pushing its silhouette off round
    veilScale: 1.4, // noise features per metre
    veilStretch: 0.5, // <1 draws the structures out into vertical falls
    veilFlow: 0.4, // how fast they pour downward
    veilErode: 0.55, // how much harder the top is eaten away than the base
    veilFalloff: 1.8, // how fast it thins with height
    veilSpin: 0.02, // revolutions/second the whole curtain turns
    veilSoftFade: 0.8, // metres of soft fade where it meets geometry
    colorVeil: '#8cd2ff',
    colorVeilCrest: '#ffffff',

    /* --- what the ground does --- */
    trailFrostRate: 2.2, // rime patches laid per metre of front travel
    trailFrostRadius: 1.0, // radius of one, metres
    frostSpread: 1.5, // the rime sheet under the crown, × zoneRadius
    frostLife: 7.5, // seconds a rime patch lingers
    frostIntensity: 0.85,
    frostCrystals: 1.5, // grain of the packed snow
    frostCollar: 2.6, // rime around the foot of a blade, × its own radius
    rimeRate: 3.0, // rime patches creeping around the boundary, per second
    rimeRadius: 1.0, // radius of one, metres
    colorFrost: '#f0f9ff', // the lit face of the snow
    colorFrostEdge: '#79b6dd', // what it goes in its own shadow
    shockRadius: 7.5, // the ring that snaps out when the crown blooms, metres
    ringRate: 0.9, // pressure rings pushed out while it stands, per second
    colorShockA: '#8ee8ff', // body of the shockwave ring
    colorShockB: '#ffffff', // its crest

    /* --- mist, chips, glitter and snow --- */
    /**
     * As in every other block: a four-stop gradient sampled over the particle's
     * own lifetime, `A` at birth through `D` as it dies. The **snow** is this
     * ability's signature system — ice dust spawned *above* the crown and left
     * to fall back down through it. Everything else in the project is thrown
     * upward, and a slow fall inside the ring is what says the air over it is
     * freezing rather than burning.
     */
    mistRate: 240, // cold air pouring off the rim, particles/second
    mistSize: 1.1,
    mistSpeed: 1.6,
    mistLifetime: 3.0,
    mistOpacity: 0.055,
    mistRise: -0.12, // negative: cold air is heavy, it falls and spreads
    mistTurbulence: 0.4,
    colorMistA: '#f2feff',
    colorMistB: '#cdefff',
    colorMistC: '#8ec9e8',
    colorMistD: '#0a2c42',
    shardSize: 0.07, // ice chips
    shardSpeed: 6.5,
    shardLifetime: 1.6,
    shardGravity: -15.0,
    breachShards: 3, // chips thrown as one shard breaks the surface
    shatterShards: 5, // ... and as it comes apart
    colorShardA: '#ffffff',
    colorShardB: '#cdefff',
    colorShardC: '#8ee8ff',
    colorShardD: '#0a3c55',
    glitterRate: 150, // the sparkle lifting off the sheet
    glitterSize: 0.05,
    glitterSpeed: 2.6,
    glitterLifetime: 2.4,
    glitterRise: 1.3, // upward drift, metres/second
    glitterTurbulence: 0.6,
    glitterGlow: 1.0,
    colorGlitterA: '#ffffff',
    colorGlitterB: '#6fe0ff',
    colorGlitterC: '#bdeeff',
    colorGlitterD: '#062434',
    snowRate: 110, // ice dust falling back through the crown
    snowSize: 0.045,
    snowSpeed: 0.9, // how hard it is pushed downward to start with
    snowLifetime: 3.2,
    snowFall: -1.1, // gravity on it, metres/second²
    snowTurbulence: 0.85, // what turns the fall into a drift
    snowGlow: 0.9,
    snowInset: 0.85, // how far inside the boundary it falls, × zoneRadius
    snowHeight: 1.35, // where it starts, × the height of the wall
    colorSnowA: '#ffffff',
    colorSnowB: '#e4f9ff',
    colorSnowC: '#a7e6ff',
    colorSnowD: '#0c3348',

    /* --- dynamic light --- */
    lightIntensity: 14,
    lightRadius: 16,
    lightHeight: 0.45, // how far up the crown the light sits, 0..1
    lightColor: '#8ee8ff',

    /* --- the throw, the bloom and the hold --- */
    muzzleSize: 0.55, // the puff at the hand as the front leaves it
    muzzleIntensity: 1.5,
    castFlash: 0.08, // screen flash on release
    colorCastFlash: '#cdefff',
    burstSize: 4.0, // the vapour shell thrown off at the bloom, metres
    burstIntensity: 1.1,
    burstShards: 120, // extra chips at the bloom
    burstMist: 70,
    burstGlitter: 140,
    vapourRate: 1.6, // vapour shells shed off the wall while it stands, /s
    vapourSize: 1.4, // radius of one, metres
    vapourIntensity: 0.7,
    impactShake: 0.85,
    shakeDuration: 0.85,
    holdShake: 0.05, // continuous rumble while the crown stands
    impactFlash: 0.2,
    rumble: 0.045, // rumble while the front races out
    colorBurstA: '#a7e6ff',
    colorBurstB: '#cdefff',
    colorBurstC: '#ffffff',
    colorFlash: '#cdefff' // the full-screen flash when it blooms
  },

  /* ================================================================== */
  /* WARD — ability seven, and the one that stands *around* a point      */
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
   * The third **far cast**, so `zoneRadius` is again the one number that
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

    whorlOuter: 11, // petals in each whorl (capacity is 30 across all three)
    whorlMid: 9,
    whorlInner: 7,
    petalLengthOuter: 1.0, // × bloom scale
    petalLengthMid: 0.72,
    petalLengthInner: 0.44,
    /**
     * Radians from straight up, once open.
     *
     * The read of a flower is entirely in this stack: the outer whorl lying
     * almost flat, the middle one half raised, the inner one still cupped
     * around the core. Flatten them all to the same angle and it is a rosette.
     */
    petalPitchOuter: 1.2,
    petalPitchMid: 0.87,
    petalPitchInner: 0.52,
    petalCurveOuter: 0.64, // extra radians the blade keeps turning as it runs out
    petalCurveMid: 0.5,
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
 * array, and the index is the slot the keyboard binds to — adding a third
 * ability is a new file, an entry here and a settings block above.
 */
export const ELEMENTS = [
  'ice',
  'thunder',
  'meteor',
  'beam',
  'snare',
  'glacier',
  'ward',
  'acid',
  'growth'
];

/**
 * Registry metadata: how an ability is presented, and how it is aimed.
 *
 * `key` must match `InputManager`. `cast` is read by `AimController` to pick
 * between the arrow and the circle; omit it and the ability is a line cast.
 */
export const ELEMENT_META = {
  ice: { label: 'Frost Lance', accent: '#5fd0ff', key: 'Q', hint: 'Frost Lance' },
  thunder: { label: 'Storm Lance', accent: '#7fb4ff', key: 'E', hint: 'Storm Lance' },
  meteor: { label: 'Cinder Fall', accent: '#ff8a3c', key: 'R', hint: 'Cinder Fall' },
  beam: { label: 'Nova Beam', accent: '#7ff0ff', key: 'F', hint: 'Nova Beam' },
  snare: {
    label: 'Voltaic Snare',
    accent: '#a98bff',
    key: 'V',
    hint: 'Voltaic Snare',
    cast: CastShape.ZONE
  },
  glacier: {
    label: 'Glacial Crown',
    accent: '#8ee8ff',
    key: 'X',
    hint: 'Glacial Crown',
    cast: CastShape.ZONE
  },
  ward: {
    label: 'Volcanic Ward',
    accent: '#ff4a2a',
    key: 'B',
    hint: 'Volcanic Horror Ward',
    cast: CastShape.ZONE
  },
  acid: {
    label: 'Caustic Bloom',
    accent: '#9dff2b',
    key: 'Z',
    hint: 'Poison Acid Aura',
    cast: CastShape.ZONE
  },
  growth: {
    label: "Arborist's Growth",
    accent: '#6effa8',
    key: 'N',
    hint: "Arborist's Growth Chrono-Summon",
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
