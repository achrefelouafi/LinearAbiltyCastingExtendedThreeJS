# Archive

Nothing in this folder is imported by the live app. Vite only bundles what is
reachable from `index.html` → `src/main.js`, so these files cost nothing at build
time — they are kept purely so the work can be mined for future abilities.

## What is here, and why it left

The sandbox was reduced to a **single ability** (`src/abilities/IceAbility.js`)
aimed with a League-of-Legends style ground arrow. The old sandbox cast along a
*freehand drawn path*; removing path drawing removed the input every one of these
systems was built on, so they moved here together rather than rotting in place.

```
abilities/
  Ability.js            the old spline-driven base class (arc-length traversal,
                        trailing point window, phase machine)
  FireAbility.js        raymarched black-body flame volume + embers/smoke
  WaterAbility.js       raymarched water surface + spray/foam + splash crown
  EarthAbility.js       instanced crust plates, heaved boulders, finale tower
  WindAbility.js        combed silk ribbons, vortex, tornado finale
materials/
  VolumetricFireMaterial.js   4-layer raymarched flame (silhouette → vortex →
                              turbulence → shred), Planckian shading
  OceanWaterMaterial.js       raymarched water surface, fresnel + foam + refraction
  WindMaterial.js             filament-combed transparent sheets
  RockMaterial.js             MeshStandard patch: strata, moss, hot seams
  DistortionMaterial.js       writes screen-space UV offsets on LAYER.DISTORTION
  TrailMaterial.js            the drawn-path preview ribbon
  AirScooterMaterial.js       the walk-mode air ball
effects/
  PathTrail.js          the glowing preview under the cursor while drawing
  AirScooter.js         the ball the avatar rode in walk mode
input/
  PathDrawer.js         pointer → ground raycast → smoothed CatmullRom spline
animation/
  WalkController.js     leap onto the stroke, ride it seated, dismount
assets/
  ProceduralGeometry.js rock / slab / obelisk / shard generators
config/
  legacySettings.js     the exact `settings` blocks these systems read
```

## Restoring one of them

1. Move the ability and the materials it imports back under `src/`.
2. Spread the matching block from `config/legacySettings.js` into
   `src/config/settings.js`.
3. Register it in `src/abilities/AbilityManager.js` (`ABILITY_TYPES`) and add its
   id to `ELEMENTS` / `ELEMENT_META` in the settings module.
4. The archived abilities extend the **old** `Ability` base (spline driven). The
   live base in `src/abilities/Ability.js` is line driven — `spawn(origin,
   direction, distance)` instead of `spawn(curve)`. Either port the ability onto
   the new base or restore `abilities/Ability.js` alongside it under a different
   name; nothing else in the project depends on which one an ability uses.
5. `PathDrawer` + `PathTrail` are only needed if you want freehand paths back.
   `AimController` can drive a spline-based ability just as well by handing it a
   two-point curve.

`RibbonGeometry` has already been restored this way: it now lives at
`src/effects/RibbonGeometry.js`, where it builds the meteor's fire trail.
