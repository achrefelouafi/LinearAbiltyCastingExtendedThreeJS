/**
 * Ability sigils for the HUD — drawn inline so they inherit `currentColor` (the
 * slot's `--accent`) and need no image assets.
 *
 * A 100×100 box, stroke only, so the mark reads the same at 34px in the ability
 * slot as it does scaled up.
 */

const WRAP = (body) =>
  `<svg class="glyph-svg" viewBox="0 0 100 100" aria-hidden="true" fill="none"
     stroke="currentColor" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/**
 * Ice — a six-fold snowflake over a rising lance.
 *
 * Three axes at 60°, each with a pair of barbs, and a heavier vertical that runs
 * past the star into a point: the star says frost, the point says skillshot.
 */
const ICE = WRAP(`
  <path d="M50 12V88"/>
  <path d="M17.5 30.5L82.5 69.5"/>
  <path d="M82.5 30.5L17.5 69.5"/>
  <path d="M50 24L41 33M50 24L59 33"/>
  <path d="M50 76L41 67M50 76L59 67"/>
  <path d="M27.5 36.5L27.7 49.2M27.5 36.5L38.5 30.4"/>
  <path d="M72.5 63.5L72.3 50.8M72.5 63.5L61.5 69.6"/>
  <path d="M72.5 36.5L72.3 49.2M72.5 36.5L61.5 30.4"/>
  <path d="M27.5 63.5L27.7 50.8M27.5 63.5L38.5 69.6"/>
`);

/**
 * Thunder — a bolt struck through a pair of arcs.
 *
 * The zigzag is drawn on the same diagonal the cast travels on, and the two
 * open arcs behind it read as the discharge spreading off it. Stroke only, like
 * the snowflake, so the two slots sit at the same visual weight.
 */
const THUNDER = WRAP(`
  <path d="M60 10L30 52H49L40 90L72 45H52L60 10Z"/>
  <path d="M23 26C13 36 11 52 17 65"/>
  <path d="M84 34C90 47 88 63 78 73"/>
`);

/**
 * Meteor — a cracked ball trailing fire.
 *
 * The circle sits forward and low with three seams splitting it, and three
 * tapering streaks run back up the same diagonal the other two sigils are drawn
 * on, so the slot reads as "the rock, thrown" at 34px.
 */
const METEOR = WRAP(`
  <circle cx="62" cy="62" r="24"/>
  <path d="M46 45L58 58L52 72M74 46L66 60L79 72M58 84L64 70"/>
  <path d="M30 70L10 90M40 34L18 22M22 48L4 44"/>
`);

/**
 * Beam — a charge held in a bracket, firing a cone.
 *
 * The orb sits low-left where the other three sigils start their diagonal, two
 * open brackets behind it read as the hands holding it, and three tapering rays
 * open out to the upper right with a single wave threaded through them: the
 * column, and the coil wrapped around it.
 */
const BEAM = WRAP(`
  <circle cx="27" cy="66" r="11"/>
  <path d="M13 55C7 62 7 74 13 81"/>
  <path d="M40 79C47 73 47 61 40 55"/>
  <path d="M41 57L92 20M42 66L94 50M43 75L92 80"/>
  <path d="M46 63C56 49 64 71 74 57C82 46 88 52 93 46"/>
`);

/**
 * Snare — a ring with a bolt standing in it.
 *
 * The only sigil in the set built around a *circle you look into* rather than a
 * diagonal, because that is the one thing this slot has to say before anything
 * else: it is not a skillshot, it is a footprint. The ellipse is the boundary
 * seen in perspective, four arcs step around it where the rim current runs, and
 * the zigzag rises out of the middle.
 */
const SNARE = WRAP(`
  <ellipse cx="50" cy="70" rx="38" ry="15"/>
  <path d="M12 70L4 70M88 70L96 70M31 82L27 89M69 82L73 89"/>
  <path d="M56 18L38 46H50L44 68"/>
  <path d="M50 55L62 40H52L58 26"/>
`);

/**
 * Glacier — a crown of blades standing on a ring.
 *
 * The second sigil built around a *circle you look into*, because it is the
 * second far cast and that is the first thing the slot has to say. Where the
 * Snare stands one bolt in the middle of its ellipse, this one stands the ring
 * itself up: five blades of uneven height rising off the boundary with the
 * spire tallest in the middle, which is the silhouette the ability actually
 * makes.
 */
const GLACIER = WRAP(`
  <ellipse cx="50" cy="74" rx="38" ry="13"/>
  <path d="M9 70L13 41L21 66"/>
  <path d="M24 65L30 31L37 60"/>
  <path d="M42 61L50 15L58 61"/>
  <path d="M63 60L70 31L76 65"/>
  <path d="M79 66L87 41L91 70"/>
`);

/**
 * Ward — a barrel of blood with a monolith standing in it.
 *
 * The third sigil built around a shape you look *into*, and the only one that is
 * a closed vessel: two rims joined by walls that bow out at the waist, which is
 * the silhouette the membrane actually makes. Inside it, the two things the ward
 * contains — a slab of obsidian and the flare burning beside it.
 */
const WARD = WRAP(`
  <ellipse cx="50" cy="28" rx="33" ry="11"/>
  <ellipse cx="50" cy="74" rx="33" ry="11"/>
  <path d="M17 28C12 43 12 59 17 74"/>
  <path d="M83 28C88 43 88 59 83 74"/>
  <path d="M36 72L44 41L53 48L57 72"/>
  <path d="M67 60V42M58 51H76"/>
`);

/**
 * Acid — a ring with gas climbing out of it.
 *
 * The fourth sigil built around a circle you look *into*, and the only one
 * whose contents leave the frame: two strands of mist curl up out of the ring
 * and off the top of the box, with bubbles rising between them and getting
 * smaller as they go. Where the Ward is a closed vessel, this one is open —
 * which is the one thing that separates the two green-and-glowing slots at a
 * glance.
 */
const ACID = WRAP(`
  <ellipse cx="50" cy="78" rx="36" ry="12"/>
  <path d="M27 72C22 57 32 50 28 38C25 29 33 23 30 12"/>
  <path d="M73 72C78 57 68 50 72 38C75 29 67 23 70 12"/>
  <path d="M50 68C47 55 55 48 50 36"/>
  <circle cx="41" cy="50" r="5.4"/>
  <circle cx="61" cy="36" r="3.8"/>
  <circle cx="49" cy="23" r="2.6"/>
`);

/**
 * Growth — a bloom standing in a nest, over a circle you look into.
 *
 * The fifth sigil built around an ellipse, because it is the fifth far cast and
 * that is the first thing the slot has to say. What separates it from the other
 * four is that its contents *grow*: four tendrils rise out of the ring at
 * uneven heights and a six-petal flower opens above them, which is the whole
 * ability in one silhouette. Where the Ward is a closed vessel and the Acid an
 * open one, this one is a thing standing in the circle rather than filling it.
 */
const GROWTH = WRAP(`
  <ellipse cx="50" cy="84" rx="32" ry="9"/>
  <path d="M22 82C16 67 28 59 24 46"/>
  <path d="M78 82C84 67 72 59 76 46"/>
  <path d="M37 85C35 74 43 68 41 58"/>
  <path d="M63 85C65 74 57 68 59 58"/>
  <g>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z"/>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z" transform="rotate(60 50 44)"/>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z" transform="rotate(120 50 44)"/>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z" transform="rotate(180 50 44)"/>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z" transform="rotate(240 50 44)"/>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z" transform="rotate(300 50 44)"/>
  </g>
  <circle cx="50" cy="44" r="6"/>
`);

/**
 * Cyber Serpent — a serpent drawn as a trace on a board.
 *
 * The body is one continuous run with a wedge head, and it *terminates* the way
 * a trace does: right-angle stubs into vias at both ends, with a pad on the
 * spine. At 34px the slot reads as a circuit that happens to be alive, which is
 * the whole ability — the other sigils are creatures or weapons, this one is a
 * thing that was compiled.
 */
const CYBER = WRAP(`
  <path d="M18 80C34 80 28 58 46 56C64 54 58 32 74 28"/>
  <path d="M74 28L86 18L94 30L82 40Z"/>
  <path d="M18 80H10V66"/>
  <path d="M94 30H98"/>
  <path d="M6 96H34M46 96H92"/>
  <circle cx="10" cy="61" r="4"/>
  <circle cx="40" cy="96" r="5"/>
  <circle cx="46" cy="56" r="4.5"/>
  <path d="M88 26L91 29"/>
`);

/**
 * Venom Surge — a burst of gems with a drop held at the middle of it.
 *
 * Five blades fanning off one point, the outer pair leaning hardest, which is
 * the starburst the ability actually builds; a broken line across their feet
 * for the floor they came through; and a single droplet at the heart, because
 * at 34px the fan alone could be any crystal ability and the drop is the only
 * mark that says *venom*.
 */
const VENOM = WRAP(`
  <path d="M50 8L57 46L50 58L43 46Z"/>
  <path d="M24 22L44 50L42 62L31 55Z"/>
  <path d="M76 22L56 50L58 62L69 55Z"/>
  <path d="M8 46L36 62L37 71L24 68Z"/>
  <path d="M92 46L64 62L63 71L76 68Z"/>
  <path d="M12 84H36M46 84H58M68 84H90"/>
  <path d="M50 62C56 70 59 74 59 78A9 9 0 0 1 41 78C41 74 44 70 50 62Z"/>
`);

/**
 * Monolith Rift — three slabs standing out of a broken floor.
 *
 * The only sigil in the set with no curve and no radiating fan in it, because
 * that is the one thing this slot has to say before anything else: it is not
 * energy, it is *mass*. Each slab is a closed quadrilateral with a sheared top
 * — the snapped break that the geometry itself is built around — the middle one
 * near plumb and the outer pair canted apart, and the line under their feet is
 * broken rather than continuous so the floor reads as having failed. Two chips
 * thrown clear of the top corners are all the room there is for the shrapnel.
 */
const QUAKE = WRAP(`
  <path d="M44 82L38 26L54 18L60 80Z"/>
  <path d="M26 84L14 44L25 39L37 83Z"/>
  <path d="M66 83L74 34L86 40L78 84Z"/>
  <path d="M6 88H30M38 88H58M66 88H94"/>
  <path d="M32 88L28 96M62 88L67 96"/>
  <path d="M13 22L21 17L18 27Z"/>
  <path d="M85 15L93 20L86 26Z"/>
`);

/**
 * Sumi Tide — a loaded brush stroke curling into a drain, with a drop falling
 * into it.
 *
 * The only sigil in the set drawn as a *stroke* rather than as an outline: one
 * open spiral that starts wide and tapers, which is both the brush mark the
 * ability is painted with and the vortex it ends as. Two shorter arcs outside
 * it are the ripples running off, the disc at the centre is the throat, and the
 * teardrop above it is what is about to go down. At 34px the spiral alone reads
 * as water going somewhere, which is the one thing this slot has to say.
 */
const INK = WRAP(`
  <path d="M74 26C60 14 36 16 26 30C15 45 21 66 38 73C53 79 70 73 74 60C77 49 70 40 59 39C50 38 43 45 44 53C45 60 52 64 58 61"/>
  <circle cx="55" cy="52" r="5"/>
  <path d="M14 74C24 88 44 94 60 90"/>
  <path d="M86 44C90 58 87 73 79 84"/>
  <path d="M55 12C60 20 63 25 63 29A8 8 0 0 1 47 29C47 25 50 20 55 12Z"/>
`);

/**
 * Astral Void Blast — a shadow inside its photon ring, with the light bent
 * round it and gold thrown off the equator.
 *
 * The only sigil in the set built around a *hole*: the disc at the middle is
 * filled with the slot's own accent so it reads as solid at 34px, where a bare
 * circle would read as a bubble. The tight ring welded to its edge is the
 * photon ring, the two long arcs sweeping past above and below are the frame
 * being lensed around it — deliberately not concentric, so they read as light
 * passing rather than as more rings — and the four tapering spears on the
 * horizontal are the ejecta, kept in the plane because that is where the gas
 * is. Nothing radiates evenly: a black hole is an equator, not a star.
 */
const ASTRAL = WRAP(`
  <circle cx="50" cy="50" r="11" fill="currentColor" stroke="none"/>
  <circle cx="50" cy="50" r="15.5"/>
  <path d="M18 34C31 22 66 21 81 32"/>
  <path d="M20 68C33 79 68 78 82 66"/>
  <path d="M72 50H94M6 50H28"/>
  <path d="M69 41L88 33M69 59L88 67"/>
  <path d="M31 41L12 33M31 59L12 67"/>
`);

/** Keyed by the ids in `ELEMENTS`. */
export const ELEMENT_SIGILS = {
  ice: ICE,
  thunder: THUNDER,
  meteor: METEOR,
  beam: BEAM,
  snare: SNARE,
  glacier: GLACIER,
  ward: WARD,
  acid: ACID,
  growth: GROWTH,
  cyber: CYBER,
  venom: VENOM,
  quake: QUAKE,
  ink: INK,
  astral: ASTRAL
};
