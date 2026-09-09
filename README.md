# Elemental Sandbox

A skillshot VFX sandbox built with **Three.js**, **Vite** and hand-written **GLSL**.

![three.js r185](https://img.shields.io/badge/three.js-r185-000000?logo=three.js&logoColor=white)
![Vite 8.1](https://img.shields.io/badge/Vite-8.1-646CFF?logo=vite&logoColor=white)
![hand-written GLSL](https://img.shields.io/badge/shaders-hand--written%20GLSL-5586A4)
![10 abilities](https://img.shields.io/badge/abilities-10-9dff2b)
![2,261 live sliders](https://img.shields.io/badge/live%20sliders-2%2C261-a878f0)
![procedural](https://img.shields.io/badge/geometry-procedural-ff4a2a)

![The Astral Void Blast: a black disc with a photon ring welded to its edge, wrapped in a sheared violet nebula, with void-shards falling in around it](docs/screenshots/astral.jpg)

Ten abilities and two ways to aim them. Three are **line casts**: press the key to arm, a
League-of-Legends style arrow appears on the ground and swings with the mouse, click to fire. The
other seven are **far casts**: the arrow is replaced by a circle with a deliberately thick boundary
that follows the cursor and answers the only question a ground-targeted AoE has to answer before you
commit — how much space is this going to take.

---

## The ten abilities

Every frame below is the renderer's own output, captured from the running sandbox at the moment the
cast peaks. No compositing, no touch-up, and nothing in shot that the app does not draw itself.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/ward.jpg" alt="Volcanic Horror Ward" width="100%"></td>
<td width="50%"><img src="docs/screenshots/acid.jpg" alt="Caustic Bloom" width="100%"></td>
</tr>
<tr>
<td><b>Q — Volcanic Horror Ward</b> · <sub>far cast</sub><br>A runed barrier standing over a floor of live lava.</td>
<td><b>E — Caustic Bloom</b> · <sub>far cast</sub><br>A pool of live acid under a raymarched column of toxic gas.</td>
</tr>
<tr>
<td><img src="docs/screenshots/growth.jpg" alt="Arborist's Growth Chrono-Summon" width="100%"></td>
<td><img src="docs/screenshots/cyber.jpg" alt="Neon Cyber Serpent" width="100%"></td>
</tr>
<tr>
<td><b>R — Arborist's Growth</b> · <sub>far cast</sub><br>A summon that picks its own targets and fires a lance of green light.</td>
<td><b>F — Cyber Serpent</b> · <sub>line cast</sub><br>A neon serpent whose whole trail is one vertex-shader ribbon.</td>
</tr>
<tr>
<td><img src="docs/screenshots/venom.jpg" alt="Crystallized Venom Surge" width="100%"></td>
<td><img src="docs/screenshots/quake.jpg" alt="Brutalist Earth Blast" width="100%"></td>
</tr>
<tr>
<td><b>V — Crystallized Venom Surge</b> · <sub>line cast</sub><br>An amethyst seam that tears down the line and opens into a starburst.</td>
<td><b>X — Brutalist Earth Blast</b> · <sub>line cast</sub><br>Photo-scanned monoliths, a dust shockwave and real ballistic shrapnel.</td>
</tr>
<tr>
<td><img src="docs/screenshots/ink.jpg" alt="Sumi Tide" width="100%"></td>
<td><img src="docs/screenshots/astral.jpg" alt="Astral Void Blast" width="100%"></td>
</tr>
<tr>
<td><b>B — Sumi Tide</b> · <sub>far cast</sub><br>Ink floods the stone, a wall of water stands up, and what it catches is wound under.</td>
<td><b>Z — Astral Void Blast</b> · <sub>far cast</sub><br>A singularity that lenses the whole frame and eats what it catches.</td>
</tr>
<tr>
<td><img src="docs/screenshots/cascade.jpg" alt="Baleful Cascade Mark" width="100%"></td>
<td><img src="docs/screenshots/rend.jpg" alt="Celestial Rend" width="100%"></td>
</tr>
<tr>
<td><b>N — Baleful Cascade Mark</b> · <sub>far cast</sub><br>A crown of blades that throws itself, one blade at a time, at the nearest body.</td>
<td><b>K — Celestial Rend</b> · <sub>far cast</sub><br>Shards drive into a mark until it detonates into a thirty-metre column of light.</td>
</tr>
</table>

---

## Six of them, up close

**E — Caustic Bloom.** A far cast, and a poison acid aura. A slick of corrosion runs across the
floor to the circle; the stone inside it crazes, pits and dissolves into a pool of live acid with
bubbles breaking on its surface, a ring of light snaps out along the boundary, and a **raymarched**
column of toxic gas climbs out of the pool and stands over it — clipped against the scene depth, so
anything inside the aura is genuinely inside the cloud rather than pasted in front of it. It holds
there boiling on an envelope that never repeats, venting gouts of gas, then goes inert and sinks
back into a stain.

**R — Arborist's Growth Chrono-Summon.** A far cast, and the only one that is not a strike but a
**summon**. A seed of green light runs across the floor to the circle; a nature sigil opens there and
races out to the boundary; a nest of woody tendrils tears up out of it, climbing and curling and
unfurling foliage as the growth front passes them; and an arcane bloom rises out of the middle and
opens, whorl by whorl, over a core that is visibly winding up. Then it goes to work. It is the one
cast in the sandbox that **picks its own targets**: it marks the nearest body still standing, charges
on it, and fires a lance of green light — and what the lance goes through comes apart at the waist.

**V — Crystallized Venom Surge.** A line cast built to a five-panel VFX breakdown sheet, and
organised so you can take the frame apart the same way. A seam of amethyst tears along the line and
opens into a **starburst** at the far end — three populations doing three jobs, long spears defining
the silhouette, blades filling the body, chunky shards skirting the base — every gem purple stone
with green **venom** sealed in its flaws. Heavy **gas** rolls off the bases rather than lifting,
**droplets** are flung out of the break and arc back down, and keep dripping off the tips while it
stands. The floor is cut into slabs by a **Voronoi** and heaved, with light coming up out of the
seams. And a **glow** kernel sits at the heart of it, which the crystals read as a real light source
— the gems nearest it are lit from that direction, so the two layers are one object rather than a
lamp parked in a pile of rocks.

**X — Brutalist Earth Blast.** The one cast in the sandbox with nothing emissive in it. A rupture
front tears down the line, shearing slabs of the floor up behind it, and at the far end the ground
fails outright: a cluster of **monoliths** punches up out of a crater, canted whichever way its own
fracture allowed rather than fanned out like a starburst. The stone is a real `MeshStandardMaterial`
wearing a **triplanar projection of a photographic rock scan** — sun, shadows, IBL, occlusion — with
the fresh fracture faces unweathered, the roots damp from under the floor, and cement dust settling
pale on every up-facing surface over the seconds that follow. A **dust shockwave** rolls outward
along the ground as a genuine torus of lit, non-additive smoke, hollow in the middle, with the plume
climbing behind it. **Shrapnel** is real instanced rock on a ballistic arc: it tumbles, bounces,
loses energy to friction and is left lying where it lands. The floor keeps a heaved **Voronoi
crater** and a network of **dark fissures** racing out past it. And the air itself is displaced — a
radial pressure ring and a column of churn written into the refraction buffer. Built to the
five-panel breakdown sheet, and filed in the editor the same way.

**Z — Astral Void Blast.** A far cast, built to a five-panel breakdown sheet, and the only one that
takes what it catches *out of the world*. A pinprick of collapsed space is thrown to the circle
already bending the frame around itself on the way; where it lands it inflates, holds for a breath,
and then **collapses** — and the collapse is the blast. A **singularity** hangs there as a pitch-black
disc with a photon ring welded to its edge, brighter on the limb turning toward you than on the one
turning away. A real **gravitational lens** on the distortion layer wraps the whole finished frame
around it — the stage, the character, and this ability's own other four layers. A raymarched
**nebula** erupts around it, oblate and differentially sheared so its arms curl into genuine spirals,
deep cosmic violet in the body and gold in the throat, with straight golden spears lancing out along
the equator. Crystalline **void-shards** are thrown clear and immediately caught, tumbling on a
closed-form infall whose winding diverges as they arrive, going incandescent as the tide strains them
apart. And a planar **shockwave** rips outward across the floor, lifting a crest of displaced air and
shoving the frame aside behind it. Then it does what it is for: everything inside the reach is
knocked *inward*, lifted off the stone, wound in, stretched by a pull sampled per joint, and consumed
at the horizon — and when the hole finally closes on itself it takes the light with it.

**N — Baleful Cascade Mark.** A far cast, built to a four-panel breakdown sheet, and the second cast
in the sandbox that picks its own targets. A shard of cold light runs to the circle; a **ground glow**
opens there as a pool with a lit lip; an angular **decal mark** cuts itself on over the top of it —
a barbed four-point star inside a diamond, with a knot of hooks at its middle, every stroke a signed
distance field measured in metres so the whole emblem re-cuts itself when you drag the footprint;
**wisps** climb out of the ring as unbroken ribbons and are drawn inward onto the axis above them;
and a **core mesh burst** tears up out of the middle — a crown of faceted blades, teal and violet,
around a heart that lights the facets nearest it. Then it goes to work. It marks the nearest body
still standing, winds up on it, and **throws its own blades**: the blade that leaves is the one
already pointing that way, it leaves from that blade's actual tip, and the gap it leaves in the crown
stays there until it grows back. Three arrive seventy milliseconds apart and only the last one is
lethal — the first two draw sparks off the body and go through it. What the last one goes through
comes apart at the waist.

Everything you can see is generated. There are no textures, no sprite sheets and no meshes on
disk except the character and the serpent: the crystals and the monoliths are procedural geometry,
the serpent's trail is a strip of ribbon placed entirely by a vertex shader, the summon's
tendrils, its foliage and every petal on its bloom are grids of parameter space placed entirely in a
vertex shader, the arrow, the targeting circle, the nature sigil with its generated runes, the
burns and the fissures are signed-distance and noise shaders, and the mist, sparks, chips,
leaves and glitter are GPU particles. The **Brutalist Earth Blast is the deliberate exception**: its
slabs, shrapnel and crater are procedural geometry like everything else, but they are *shaded* with
the same CC0 ambientCG **Rock030** scan the floor is dressed with, projected triplanar in world
metres. Procedural noise gets you stone that looks like stone; it does not get you stone that looks
photographed, and that ability's whole read depends on the second one.

**Every parameter is a live slider** — 2,261 of them, plus 424 colour pickers — and they stay live while the simulation is
paused. That is the point of the project: freeze a frame mid-eruption, mid-strike or mid-burn with
**P**, then reshape the silhouette, the palette and the timing against a still image.

---

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Then open the URL Vite prints (default <http://127.0.0.1:5173>).

```bash
npm run build
```

```bash
npm run preview
```

### Assets

Six binary assets are served from `public/` and loaded automatically at boot:

| File | Purpose |
| --- | --- |
| `public/models/Idle.fbx` | Rigged character **and** its idle animation clip |
| `public/models/diffuse.png` | The character's colour map |
| `public/models/cast1.fbx` | Cast animation |
| `public/models/cast2.fbx` | Cast animation |
| `public/models/cast3.fbx` | Cast animation — the default for the Ward, the Growth, the Rift, the Tide and the Cascade |
| `public/models/snake.glb` | The Cyber Serpent's body, rebuilt into a ghost-instanced strip at boot |
| `public/hdri/spruit_sunrise.hdr` | HDR probe used for image-based lighting and crystal reflections |

All four FBX files are Mixamo exports of the same rig, each carrying a skinned mesh plus one
animation stack. The character comes from the idle file; the cast files are loaded for their clip
alone, and the duplicate rig that arrives with each one is released the moment its `AnimationClip`
has been taken. Clips bind to the skeleton by bone name, which is the whole reason an animation
authored in another file plays here without retargeting.

The rig ships no material, so `diffuse.png` is loaded beside it and assigned as the colour map when
the imported materials are converted to PBR — an FBX that *does* carry an embedded texture keeps its
own, since that map is authored against its own UVs.

Every ability picks the clip it throws — `castAnim` in its settings block, a dropdown under **The
cast** in its editor folder. Out of the box the Ward, the Growth, the Rift, the Tide and the Cascade
throw `cast3`, the Bloom, the Serpent, the Surge and the Void Blast throw `cast2`, and the Rend
throws `cast1`. The clip is a one-shot laid over the looping idle, with `character.castBlendIn` /
`castBlendOut` as the two edges of that overlap.

The HDR is loaded as image-based lighting and as the reflection source for the crystals — it is
never shown as a visible sky. The stage keeps its flat dark backdrop.

---

## Controls

| Input | Action |
| --- | --- |
| **Q** (or **1**) | Arm Volcanic Horror Ward — a far cast, aimed with a circle |
| **E** (or **2**) | Arm Caustic Bloom — a far cast, and a poison acid aura |
| **R** (or **3**) | Arm the Arborist's Growth Chrono-Summon — a far cast that picks its own targets |
| **F** (or **4**) | Arm the Cyber Serpent — a line cast |
| **V** (or **5**) | Arm the Crystallized Venom Surge — a line cast |
| **X** (or **6**) | Arm the Brutalist Earth Blast — a line cast |
| **B** (or **7**) | Arm the Sumi Tide — a far cast that takes hold of what it catches |
| **Z** (or **8**) | Arm the Astral Void Blast — a far cast that eats what it catches |
| **N** (or **9**) | Arm the Baleful Cascade Mark — a far cast that throws its own blades |
| **K** (or **0**) | Arm the Celestial Rend — a far cast |
| **Move the mouse** | Swing the aim arrow, or move the far-cast circle |
| **Left click** | Cast along the arrow, or drop the circle where it is |
| **Esc** / **right click** | Cancel an armed cast |
| **Right mouse + drag** | Orbit the camera |
| **Scroll** | Zoom |
| **G** | Show/hide the VFX editor |
| **P** | Pause / resume — *the editor keeps applying* |
| **C** | Clear all active effects |
| **H** | Hide the controls panel |

`range` and `minRange` are per ability, so the indicator's reach changes with the slot you have
selected. Aiming closer than the selected ability's `minRange` tints it red and refuses the cast;
set `minRange` to 0 if you would rather cast at your own feet, which is what every far cast ships
with — a ward you cannot drop on yourself is missing half its uses. Cooldowns are per ability too,
so spending one slot never locks the other out.

---

## Project layout

```
src/
  abilities/      Ability base class (the travelling front), WardAbility, AcidAbility,
                  ArborBloomAbility, CyberSerpentAbility, VenomSurgeAbility,
                  MonolithRiftAbility, SumiTideAbility, AstralVoidAbility,
                  BalefulCascadeAbility, CelestialRendAbility, pooling manager
  animation/      FBX character loading, AnimationMixer, the per-ability cast clips,
                  the procedural cast lunge
  assets/         Procedural crystal and boulder geometry, the ribbon strip, and the
                  per-ability geometry builders (monoliths, growth, shatter, rend, serpent)
  config/         settings.js — the single source of truth for every parameter
  core/           App, Renderer, CameraRig, Time, Layers, shared frame uniforms
  effects/        Aim arrow, far-cast circle, ground decals, rift fissures, shatter
                  plates, crater, kinetic warp, bursts, light pool, shake, flash
  input/          InputManager (events) and AimController (both targeting shapes)
  loaders/        AssetLoader with a shared LoadingManager
  materials/      ObsidianMaterial, WardBarrierMaterial, WardGroundMaterial,
                  AcidPoolMaterial, ToxicMistMaterial (the raymarched volume),
                  the growth, serpent, venom, monolith, ink, astral, cascade
                  and rend material sets
  particles/      GPU particle system + engine and rate emitters
  postprocessing/ Composer pipeline, grade shader, distortion shader
  shaders/lib/    Shared GLSL: noise library, common helpers
  ui/             HUD, lil-gui editor, preset manager, styles
  utils/          Maths, colour cache, pooling, disposal, shader patching
  world/          Environment (stage lighting), floor, dust, contact shadows
  archive/        The retired four-element sandbox — see archive/README.md
```

---

## How it fits together

### Settings are the API

`src/config/settings.js` holds every tweakable value. Nothing else owns that state: shaders,
particle systems, lights and post passes *read* those objects every frame. That is what makes the
editor work with no rebuild — moving a slider changes the crystal field that is already standing,
the next cast, the environment and the post stack at once. Preset loading deep-merges *into* the same
objects so every live binding stays valid.

```js
import { settings } from './config/settings.js';
settings.venom.height = 7;        // visible on the next frame, even mid-cast
settings.ward.zoneRadius = 8;     // re-flows a ward that is already standing
settings.global.timeScale = 0.1;  // slow the whole cast to a crawl
```

Ability blocks are keyed by their id in `ELEMENTS`, and the shared systems that need to know
"which ability is the player holding" — the aim controller, the cooldowns, the HUD — look it up as
`settings[element]`. The four fields they rely on being present are `range`, `minRange`, `speed`
and `cooldown`; a far cast adds a fifth, `zoneRadius`. Everything else in a block is that ability's
own business.

### The rule that makes "edit while paused" work

A gem record in `VenomSurgeAbility` stores **only what the dice decided**: a position *fraction*
along the line, a radial *fraction*, a yaw, and a handful of unitless jitters. Not one metre, radian
or second is captured when the cast starts. Every dimension is resolved against `settings.venom`
inside the update loop, which runs on a zero-length frame too.

So dragging `height` re-grows a field that is already standing; dragging `lean` re-tilts it;
dragging `clumping` re-packs it toward the centre line. The only values a record *does* capture
are timestamps — the moment its own eruption was triggered. Those are events, not dimensions.

The four *shape* controls (`facets`, `taper`, `gemRough`, `bend`) cannot be expressed as a
per-instance transform, so they are baked into the geometry instead — and a seven-sided crystal is
a couple of hundred triangles, cheap enough to regenerate outright rather than approximate in a
vertex shader. `VenomSurgeAbility#_syncGeometry` hashes those four values and rebuilds the gem
meshes when the hash changes, carrying the per-instance attributes across, which is what keeps them
live sliders rather than restart-required constants.

### Aiming

`AimController` raycasts the pointer onto the ground plane **every frame**, not only on mouse
move, so orbiting the camera with a cast armed swings the indicator under a stationary cursor. It
clamps the distance into `[minRange, range]`, tracks a 0..1 reveal envelope, and emits a single
`cast` event carrying an origin, a unit direction and a distance — which is exactly the signature
`Ability#spawn` takes. It decides nothing about what the cast does.

It runs on **real** time rather than the scaled simulation delta, so the indicator keeps animating
while the sandbox is paused.

There are two indicators and one controller. Which one is drawn comes from
`ELEMENT_META[element].cast` — `CastShape.LINE` or `CastShape.ZONE` — and that is the *only* thing
the two shapes disagree about. Arming, clamping, validating, revealing and firing are shared, and
both end in the same three-argument `cast` event, because from the targeting side a far cast is a
line cast you only care about the far end of. That is why zone targeting needed no change in
`Ability`, `AbilityManager` or `App`: `WardAbility` reads its centre as `pointAt(1)` and works
outward from there.

### The far-cast circle

`ZoneIndicator` is the arrow's opposite number, and it is built out of the same two ideas: metres,
and no textures.

The **footprint** is one quad whose fragment shader remaps UV into metres from the target, so the
boundary stays 0.34 m thick whether the circle is 2 m or 8 m across. The band is deliberately the
heaviest mark on screen — it is the whole message — and it is split about the nominal radius by
`boundaryBias` rather than centred on it, so its *outer* lip stays honest about where the effect
ends. Inside there is a rim-weighted wash, contour rings travelling outward, warped filaments and a
reticle whose downrange arm is longer, because the quad carries the caster's yaw and that arm is
therefore the heading.

The **reach ring** at the caster is the ribbon strip bent into a circle: `(t, side)` in,
world position out. A quad big enough to hold a 20 m range would be 40 m across and shade a
screenful of discarded fragments for one thin line.

The circle **snaps out past its radius and settles back** when the cast is armed, and the trap does
the same thing when it lands. A circle that grows linearly reads as a UI element; one that
overshoots reads as something the caster did.

### The arrow is one SDF

`AimIndicator` is a single ground quad. Its fragment shader remaps UV into **metres measured from
the caster**, so every control in `settings.aim` is a real measurement — the shaft stays 0.42 m
wide whether the cast is 3 m or 15 m long.

The silhouette is a rounded union of a box (the shaft) and iq's exact triangle SDF (the head);
the cheap half-plane intersection leaves visible corner artefacts on a wedge this shallow. From
that one distance field the shader derives the outline, the rim-weighted interior wash, the
chevrons (a phase skewed by `|x|`, which turns flat bands into arrowheads pointing the way the
cast does), the frost noise and voronoi plates, the ring at the caster's feet, the range cap arc,
a six-fold frost rosette pinned to the impact point, and the sweep-out when the ability is armed.

### The acid

The Caustic Bloom is the only ability in the set built around a **volume** rather than around
surfaces, and it is the one that answers a question the others never had to: what do you do
when the effect is not a thing standing in the world but a region of the world that has been
*changed*.

The mist is **raymarched**, not billboarded. A cylinder of gas made out of camera-facing quads dies
the moment the camera orbits — the cards turn with you, the silhouette never changes, and anything
standing inside the cloud is either entirely in front of every card or entirely behind it. So
`ToxicMistMaterial` marches it:

- **The mesh is a scissor, not the shape.** A closed cylinder drawn back faces only with the depth
  test off, whose single job is to rasterise the pixels the volume could cover. Because a regular
  polygon inscribes its circle, the proxy is scaled by `1 / cos(π / segments)` so it *circumscribes*
  the analytic radius instead — without that the marched cloud has flats on its silhouette, which is
  the one tell you cannot explain away.
- **The span is analytic.** `cylinderSpan` solves the ray against an upright cylinder and clips it to
  the height slab, giving an exact entry and exit distance. No depth peeling, no sorting, and it
  stays correct with the camera inside the cloud.
- **It is clipped against the scene.** The far end of the march is cut at the opaque depth prepass,
  so a character standing in the aura is veiled by exactly the gas in front of them and none of the
  gas behind them. That single line is the difference between an aura and a decal the character is
  pasted on top of.
- **It is lit from underneath.** The pool is the key light and it is *below* the gas, so emission
  falls off with height and one tap toward the sun shades the crown. Light a cloud flat and it stops
  being smoke over a chemical fire and becomes green fog.

Cost is honest and dialled: `mistSteps` samples of a three-octave fbm plus one shadow tap, empty
space skipped before any noise is evaluated, the march stopped as soon as the volume is opaque, and
the step count is a **live slider** — the same build runs on a laptop and on the machine driving the
projector.

The **pool** is the counterweight. It is alpha blended rather than additive, because acid has to eat
the floor and additive can only ever add; its crazing is a two-nearest voronoi *edge* network, which
forks and meets at proper junctions where a threshold on a distance field gives round blobs; and it
carries a real specular lobe off a world-space gradient of its own height field. Everything else on
this stage is rough, and that gloss is the cheapest thing in the project that says *liquid* — take
it out and the pool is scorched rock that happens to be green. Its boundary is pushed around by a
noise on the bearing and bitten into by a second one, because a clean disc reads as a decal no
matter what is drawn inside it.

Gas coming off the surface is drawn **in the pool shader**, not with particles: `surfaceBoil` gives
every cell of a jittered grid its own clock and its own size and draws the expanding rim of one
bubble breaking the surface. Nine cheap hashes per pixel, no two cells ever in step, and it replaces
an emitter outright.

The bubbles that do get particles needed a new silhouette, so `ParticleShape.BUBBLE` was added to the
shared system: a film is only visible where you look *through* it edge-on, so the shape is a thin
ring rather than a disc, with a little of the far wall left across the middle, a hard white
catchlight from the key and a soft bounce off the pool below. It does not fade out either — in the
last of its life the film springs outward, thins and tears, which is the only ending a bubble has.

**The boil is what makes the five passes one thing.** Where the Ward has a heartbeat, this has a
sum of three sines at incommensurate frequencies (1, φ, 1+√2) raised to `boilSharp` — an envelope
with no period, which spends most of its time near zero and spikes. A heartbeat is *supposed* to be
regular; a chemical reaction very much is not, and within the six seconds an aura stands the surge
never lands twice on the same rhythm. It is evaluated once per frame and handed to every material,
the light, the emitters and the camera; when a surge crosses `boilThreshold` on the way up the aura
**vents** — a gout of gas off the whole pool, a ring pushed across it and a knock on the camera.
Set `boilDepth` to zero and the whole thing flatlines, every pass at once.

### The growth

The Arborist's Growth Chrono-Summon is the only ability in the set that is not a *strike*. Everything
else in the sandbox reaches: it travels down a line, it lands, and `DummyField` reads the volume it
covered and fells whatever was standing in it. A summon does not reach. It stands there and picks —
so this one answers `handlesOwnHits`, the field leaves it alone, and it asks who is nearby, marks
one, charges on it, and fires. The cut is not an effect layered on top of the kill; it *is* the kill.

**The tendrils and their foliage are one shape.** A leaf is not decoration scattered near a stem, it
is *clipped to* one. The tube and the blades include the same `vinePoint` / `vineFrame` /
`vineRadius` block and are handed the same uniform boxes by identity, so a leaf resolves the exact
stem position the tube resolved, on the same frame, from the same numbers. Drag `curl turns` while a
summon is standing and three hundred leaves curl with the wood. The alternative is to bake the stems
— and lose the live controls — or to read geometry back off the GPU, and lose the frame.

There is no path buffer and no CPU pass at all. `vinePoint(vine, t)` is analytic: a bearing, a radius
that bows out at the waist and draws back in under the bloom, a rise curve, a twist, and a spiral
that tightens over the last third — which is the one term that says *grown* rather than *extruded*.
The frame that rides it takes its reference axis from the stem's own outward radial rather than from
world up, because the usual trick flips somewhere up a tendril that passes through vertical, and a
frame that flips between two rows of a tube twists every quad between them into a bow tie.

**The bloom opens by animating one angle.** A petal is a bent, cupped, twisted sheet placed on an arc
— `p(u) = centre + (out·sin a + up·cos a)·(len·u)` with `a = pitch + curve·u` — so a petal that starts
at 20° and curves 90° is standing at its base and folded back at its tip, which is what an open
flower actually does. `uOpen` runs 0 → 1 and interpolates every petal's pitch from the bud's to its
whorl's, outer whorls leading. There is no second pose and nothing is blended. The read of a flower
is entirely in how the whorls *stack*, and that stack is three vec3s.

**These are lit materials, not additive shaders**, which is the split that separates this ability
from every other one here. Fire and lightning *are* light; wood is matter, and matter that does not
sit in the sun, take a shadow and occlude what is behind it reads as a decal wrapped around the scene
however good its silhouette is. So the tendrils, the foliage and the petals are
`MeshStandardMaterial` with their vertex stage replaced: three's shading model, our geometry. Two
things fall out of that and both are load-bearing — the shadow pass needs the *same* vertex stage
(each material hands back a matching `MeshDepthMaterial` for the mesh's `customDepthMaterial`), and
the model matrix must stay identity, because the vertex stage writes world positions.

They also need a layer of their own. `LAYER.SHAPED` exists because the depth prepass draws the whole
world layer with one `overrideMaterial`, which would rasterise the raw parameter buffer — a
metre-wide sheet at the origin — straight into the soft-particle depth buffer. The shadow map is the
one pass where three honours `customDepthMaterial`, so the summon casts properly and stays out of the
prepass.

There is a second three.js footgun in the same neighbourhood, and it cost a debugging session worth
recording: three keys its **program cache** off `customProgramCacheKey()`, whose default is
`onBeforeCompile.toString()` — and `patchOnBeforeCompile` installs a function with the *same* source
text on every material it touches. Three materials that patch the same base with the same parameters
therefore shared one compiled program, and the second and third silently rendered with the first
one's shader. Nothing errors; the petals simply came out as more tendrils. `patchOnBeforeCompile` now
folds the patch's own source into the key, which fixes it for every caller in the project.

**The sigil is drawn in metres from its own centre**, not in quad space: drag `footprint radius`
while a summon is standing and the mark re-scales with its strokes the same physical width and the
same number of runes per metre of arc. The runes are *generated* — every cell hashes its own subset
out of a nine-stroke alphabet, so the ring carries genuinely non-repeating script and moving `runes`
re-cuts all of them. Fine detail is faded by the world-space pixel footprint and every band's width
is floored at it with the brightness scaled back to match, which is what stops a floor full of thin
bright rings turning into a bolt of white speckle across the far half of the stage.

**The lance is one draw call for the whole volley.** Every shot is an instance of the same tube
reading its two endpoints and its own clock out of a small uniform array, so four bodies going down
at once costs what one does. It does not fade up: it arrives, in the first tenth of its life, as a
point that reaches the target — and the cut lands on the frame its *head* gets there rather than on
the frame it was fired. Fifty milliseconds apart, and worth every one of them.

**The cut itself** is one plane and one clone (`combat/Dummy.js`). The body's mesh is duplicated,
each copy is told which side of the plane it keeps with a `discard`, and each gets its own solver
seeded with only the joints that half actually owns — leave the legs in the torso's solver and they
land on the floor holding an invisible pelvis a metre in the air. Because the material has been
double-sided since birth the far wall of the shell is already being rasterised, so painting *that* as
the interior is the whole of the cross-section: no cap geometry, no re-tessellation, right from every
angle for free. The plane lives in the geometry's **bind** space — the one space no bone can move —
so a cut measured at the waist stays at the waist however far the corpse folds. The two halves are
then made solid to each other (`collideRagdolls`), because two solvers that know nothing of each
other let the torso fall straight through the legs it was cut off.


### The cascade

The Baleful Cascade Mark is the second cast that picks its own targets, and the only one that
**spends something to do it**. The crown of blades standing over the mark is a magazine: throwing one
takes it out of the crown, the gap is visible, and it grows back over `crownRegrow`. Fire faster than
that and the burst visibly thins; leave it alone and it fills back in. It costs one float per blade
and it is the whole difference between a thing spending itself and a turret with an infinite belt.

**The crown is dealt on the CPU, and that is deliberate.** Everywhere else in this project the shape
lives in the shader — the Chrono-Summon derives a tendril's bearing from its instance index and never
tells anyone where it ended up, which is right for something that only has to be drawn. This ability
has to *throw* a blade, so it has to answer a question a shader cannot: **where is the point of blade
seventeen**. So `_dealCrown` writes `aDir` and `aShape` every frame, resolved from the live settings
on the frame they are read, and `_bladeTip` reads the answer straight back out of the buffer the
draw is about to use. Nothing is captured at spawn and dragging a slider still re-cuts a crown that
is already standing; the deal simply happens on the other side of the bus. It is a few hundred float
writes a frame, and it buys the one thing the layer is for.

Which blade goes is chosen the same way: `_pickBlade` takes the blade already pointing nearest the
body, so what arrives is what was standing there a frame earlier rather than a projectile the crown
happened to spawn. The three populations — long spears for the silhouette, blades for the body,
short shards to skirt the middle — are dealt by walking a Fibonacci spiral with a **stride coprime to
its length**. Consecutive indices on that spiral sit at nearly the same latitude, so taking the
populations as three blocks of it would put every spear round one pole; the coprime walk keeps the
counts exact and scatters each population over the whole sphere.

**One blade, two materials.** The crown and the volley are handed the same uniform block by identity,
so a shot is drawn with the section, the taper, the facets and the palette of the crown it left.
A thrown blade drawn by a second, similar shader reads as a projectile; this one reads as the crown
coming apart. The section is a **lens** rather than a circle — the thickness is pinched to nothing at
the two angles where the width is greatest — so the blade has a sharp edge down each side and a spine
ridge along each face, and `flatShading` lets every one of the eight facets take the key light on its
own. It is not a style choice: smooth-shaded, at forty instances, the burst is a bundle of carrots.

**Only the last blade of a flurry is lethal.** The ones before it go through the body, draw sparks
off it and change nothing. A body that comes apart on the first of three arrivals leaves the other
two hitting a corpse, and three that land on the same frame read as one blade with a rendering bug.
The cut itself lands on the frame the blade's *point* reaches the body — a fifth of a second after it
was thrown, at the shipped numbers — and the blade keeps going out the other side, which is what
makes it a cut rather than an impalement.

**What went wrong first, twice.** The burst came out as a white star-shaped hole in the frame, and
neither time was it the bloom (which is at 0.03 in this project and was never the problem). It was
the *area* terms of the blade's own emissive. A rim, a vein field and a bleed from the heart each
cover the whole surface; an edge term covers two columns of it. Summed at similar weights the areas
win everywhere, the stone underneath stops mattering and the silhouette — the entire read of the
reference sheet's third panel — goes with it. The shipped balance is the edge at 0.5 with a power of 14
and every area term at or under 0.3, with a hard soft-ceiling behind them as a guard rather than as
the mechanism. If a lit ability solid in this project ever goes white, turn the area terms off first and
put them back one at a time; the ceiling will not save you, because by the time it engages the blade
is already a lamp.

### Adding another ability

1. Add a settings block in `config/settings.js` and an entry in `ELEMENTS` / `ELEMENT_META`.
2. Subclass `Ability` and implement `createShaders`, `createParticles`, `onTravel`, `onImpact`,
   `onFade`.
3. Register the class in `abilities/AbilityManager.js`.
4. Add an editor folder in `ui/Editor.js`, and a sigil in `ui/glyphs.js`.
5. Bind a key in `input/InputManager.js` — it emits `ability` with the 0-based slot index, which
   `App` maps through `ELEMENTS`.

To make it a **far cast** instead of a line cast, add two things and nothing else: `cast:
CastShape.ZONE` in its `ELEMENT_META` entry, and a `zoneRadius` in its settings block. The circle
indicator, the reach ring, the snap-out and the whole targeting loop come for free, and the ability
reads its centre as `pointAt(1)`.

Everything else — pooling, the travelling front, the local frame, lights, phases, per-ability
cooldowns, the aim reach and camera framing — is inherited or driven off `ELEMENTS`. The HUD
builds its slots from that array, so a new ability appears in the bar on its own.

### Particles

`particles/ParticleSystem.js` is a GPU-simulated, instanced-quad system. Motion (velocity, gravity,
analytic drag, curl turbulence, vortex swirl), size-over-lifetime, the colour gradient and alpha
fade are all evaluated in the shader from per-instance attributes; the CPU only ever writes spawn
data, and only the slots that changed are uploaded. Particles live in a ring buffer, so spamming
the ability recycles slots instead of allocating. Silhouettes (soft, smoke, streak, leaf, chip,
ring) are procedural — there are no sprite textures anywhere in the project.

The Venom Surge uses three systems: **gas** (non-additive, so the cloud genuinely occludes the gems
behind it and the cluster keeps its depth), **droplets** (lit, under gravity, flung out of the break
and arcing back down) and **motes** (additive, tiny — the airborne glitter that sells the gems as
faceted).

The Volcanic Ward uses four: **embers** rising off the obsidian, **ash**, **gore** splash, and the
non-additive **smoke** off the shattered floor. Its embers are emitted from several points around
the ring each frame rather than one: a ward sheds along its whole boundary, and a single origin
makes every batch read as a starburst.

The Brutalist Earth Blast is the one that works a system twice: its **dust** is both the rolling
ground ring and the plume climbing behind it — the same non-additive smoke, thrown two different
ways — while its **shrapnel** is real instanced rock rather than particles at all, because it has to
tumble, bounce and be left lying where it lands.

### Render pipeline

Per frame:

1. **Depth prepass** — the opaque world into a half-res packed-depth buffer. Every VFX shader
   samples it for soft intersections, so nothing cuts a hard line into the ground. The crystals and
   the monoliths sit on `LAYER.WORLD`, so mist and glitter fade softly against them.
2. **Distortion pass** — meshes on the distortion layer write screen-space UV offsets into a second
   half-res buffer. The ward's heat haze, the Rift's kinetic air and the Void Blast's gravitational
   lens all write into it.
3. **Composer** — scene → refraction warp → bloom → tone map (ACES) → grade.

The grade pass folds chromatic aberration, lift/gain/contrast/saturation/temperature, vignette,
film grain and the impact flash into one resample.

Shadows come from a single directional light whose orthographic shadow camera is re-centred on the
character each frame and fitted to a 52 m box at 4096² (~1.3 cm/texel). The `three/addons` CSM
module was tried first and removed: it replaces three's `lights_fragment_begin` chunk *globally*,
so any material not explicitly registered with it silently loses all directional lighting.

Contact shadows are a real render: the character's depth is captured from below into a 256²
target, blurred twice and projected onto the ground.

---

## Editor and presets

![The sandbox with its HUD and the lil-gui editor open beside a live cast](docs/screenshots/editor.jpg)

Press **G** for the panel. Folders: Presets, Global, Aim indicator, Far-cast circle, Volcanic Ward,
Caustic Bloom, Arborist's Growth, Cyber Serpent, Crystallized Venom Surge, Brutalist Earth Blast,
Sumi Tide, Astral Void Blast, Baleful Cascade, Celestial Rend, Environment, Post processing, Camera,
Character, Target dummies. Every folder starts collapsed — there are enough controls here that one open
section pushes the rest off the screen.

- **Global** multipliers scale everything at once (speed, glow, noise, particles, lights, impact
  intensity, camera shake, time scale…).
- **Aim indicator** — the arrow's silhouette in metres, its outline and fill, the chevrons and
  frost, and the rings and rosette.
- **Far-cast circle** (40 controls) — the boundary band, the interior, the ticks, sweep and
  reticle, the reach ring, and the snap-out. Shared by every far cast, so it is filed with the
  targeting rather than with any one ability.
- **Volcanic Ward** (230 controls, 45 of them colours) — the cast and its footprint, the heartbeat
  everything is driven off, then one folder per pass of the reference sheet: the barrier, the floor,
  the obsidian, the rune bands, the core flare, the heat haze, embers/ash/gore/smoke, and the
  dynamic light.
- **Caustic Bloom** (203 controls, 38 of them colours) — the cast, the boil envelope every pass is
  driven off, the acid pool, the raymarched toxic mist, the base ring, the corrosive shimmer,
  bubbles & motes, fog & splatter, the marks on the ground, throw/bloom/hold, and the dynamic
  light.
- **Crystallized Venom Surge** (194 controls, 36 of them colours) — filed as the five panels of
  its breakdown sheet rather than by system, so judging one layer is a matter of opening one
  folder: *1 Crystals* (the seam, the starburst, one gem, the eruption, the amethyst), *2 Gas*,
  *3 Droplets* (with the airborne glitter under it), *4 Cracks* (the plate, and the marks laid
  along the line), *5 Glow* (the kernel, and the halo under it), then the strike and the light.
  The four `slab*` controls marked *re-cuts* rebuild the Voronoi; every other control on the
  plate reshapes one that is already lying on the floor.
- **Brutalist Earth Blast** (195 controls, 25 of them colours — one per value in its settings
  block, with nothing hidden) — filed as the five panels of its breakdown sheet: *1 Monoliths*
  (the rift, the cluster, one slab, the eruption, the stone surface), *2 Cement dust* (with the
  rolling ring under it), *3 Geometric shrapnel* (with grit and suspended powder), *4 Fissure
  scars* (the crater, the cracks, the marks along the line), *5 Kinetic air*, then the strike and
  the light. The seven shape controls under *One slab* re-cut the geometry; everything else
  reshapes stone that is already standing. Each panel can be taken to zero on its own to judge the
  others — `density` empties the stone, `dustOpacity` clears the air, `shrapnelCount` stops the
  debris, `warpStrength` switches off the refraction.
- **Presets** save to `localStorage`, and can be duplicated, deleted, exported to JSON, imported
  from JSON, or reset to the shipped defaults.

Every ability exposes **every** colour it draws with, and none is derived from another: the crystal
palette, the ward's membrane and its rune bands, the acid pool and the gas above it, the ground
marks, the impact shells, the shockwave rings, the screen flashes, and a four-stop lifetime gradient
(`birth → early → late → death`) for each particle system. Tinting the fog without touching the
crystals, or cooling the embers to orange while the runes stay red, is a picker away.

Presets are plain snapshots of the settings tree, so an exported file is readable and editable by
hand.

Knobs worth knowing about, because they reshape their ability the most:

- `venom.heightCurve` — how late the ramp climbs; raise it and the seam stays low until it explodes
  at the target. `venom.frontBias` below 1 crowds the gems toward the impact point.
- `ward.zoneRadius` — the one number the whole far cast is built on. It resizes the targeting
  circle, the membrane, the rune bands, the shattered floor and the ring of monoliths together,
  live. After that, `ward.bpm` and `ward.beatDepth` carry the heartbeat every pass is driven off:
  take `beatDepth` to zero and the ward flatlines, every pass at once.
- `quake.density` and `quake.warpStrength` — how much stone comes up out of the crater, and how hard
  the air is shoved aside behind the blast. Each panel of that ability can be taken to zero on its
  own, which is how you judge one layer against the others.
- `zone.boundary` and `zone.snap` — how thick the far-cast circle's edge reads, and how hard it
  overshoots on the way out. Between them they decide whether the indicator feels like a UI overlay
  or like something the caster is doing.

---

## Performance notes

- Abilities, decals, bursts and particles are pooled, per type. Twelve casts in a row build at most
  **four** instances of an ability and then stop allocating.
- A whole crystal field is a handful of draw calls regardless of crystal count — the gems are
  instanced per shape variant, not per gem.
- The Cyber Serpent's trail is **one** instanced ribbon strip regardless of how many ghosts are on
  it. Nothing about the path touches the CPU, so the trail count is nearly free.
- A far cast's targeting circle is two draw calls: one quad and one ring strip.
- The six dynamic point lights are created at boot and parked at zero intensity rather than added
  and removed — changing the light count forces three to recompile every material.
- The scene is rendered several times per frame, but the sun's shadow map is built exactly once,
  by the main pass. The depth and distortion passes deliberately hold the flag back: three picks
  shadow casters by testing them against the layers of the camera the frame is being *rendered*
  with, and both of those passes pin the camera to a single layer.
- `renderer.compileAsync()` runs during boot so the first cast never stutters on shader compile.
- MSAA is off. Everything is drawn into the composer's (non-multisampled) targets, so `antialias`
  on the canvas buys nothing and costs a multisampled back buffer plus a resolve per swap.

**Not paying for an empty stage.** Standing still is the state the sandbox spends most of its
time in, and it used to cost the same as a four-cast fight:

- The loop drops to `idleFps` (30) whenever nothing is cast, armed, decaying or under the cursor,
  and snaps back to `maxFps` (60) on the first input or spawn. It also suspends entirely in a
  hidden tab.
- The depth prepass and the distortion pass are skipped when no ability, particle or burst is
  alive — those are the only things that read either buffer.
- Particle systems hide themselves once their last particle has died. Without this a system keeps
  issuing a full-capacity instanced draw forever after its one cast, and since the boot warm-up
  builds every ability, that is 37 draws and ~111k instances on a stage with nothing on it.
- The sun shadow map and the contact shadow refresh at `shadowFps` (30) rather than every frame.
- Pixel ratio is capped at 1.25; the depth and distortion buffers are half resolution.

The editor's **Performance** folder drives all of it live: frame limit, idle frame limit, pixel
ratio, shadow resolution and shadow refresh. For lower power use, choose 30 FPS / 15 FPS idle,
pixel ratio 1, 1024² shadows and a 15 FPS shadow refresh. Note that these values travel inside
saved presets, which is worth knowing before importing a preset onto a phone.

Four concurrent casts — the pool's ceiling, whichever slots they came from — is what the budget is
set against, and `MAX_CONCURRENT` in `AbilityManager` retires the oldest one past that whichever
element it came from. Arming a far-cast circle costs two draw calls.

Live counters (FPS, live particles, instances, draw calls) are in the top-right of the HUD.

---

## The archive

`src/archive/` holds the previous incarnation of this project: a four-element bending sandbox
(fire, water, earth, air) cast along a freehand-drawn spline, plus a walk mode that let the avatar
ride the same stroke. None of it is imported by the live app, so Vite never bundles it.

It was retired because this build replaced path drawing with a linear skillshot, which removed the
input every one of those systems was built on. The raymarched flame and water surfaces in
particular are worth mining. See `src/archive/README.md` for what is in there and how to restore a
piece of it.

---

## Known rough edges

- Crystals are drawn with `transparent: true` and `depthWrite: true`. That is the right trade for
  near-opaque gems and it keeps the field from sorting through itself, but at low `venom.gemOpacity`
  the sorting artefacts between overlapping spikes become visible.
- The eruption front is a straight line on a flat floor. Both assumptions are baked in — the ground
  is a single plane at y = 0, and the aim raycast targets that plane.
- The impact cluster is placed radially around the end point, so at very short cast distances it
  can overlap the band behind it more than it should.
- The far cast inherits the flat-floor assumption twice over: the circle is drawn on a single quad
  at `y = 0`, and the ward's rune bands and shattered plates are placed against that same plane.
  Neither would drape over a step.
- The targeting circle is additive, so the footprint brightens the floor rather than shading it. On
  a pale floor the boundary would need a non-additive pass under it to stay readable.

---

## Licence

Code is provided as-is for the purposes of this project. The bundled HDR probe and the character
FBX retain their original licences.
