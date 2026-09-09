# Rendering validation — 2026-09-09

Compared production builds of baseline `8c377c8` and the performance branch with the
new diagnostics panel and timing/lifetime fixes. Both used the same installed dependencies,
Chrome 152, a 1440 × 769 CSS-pixel viewport and device pixel ratio 2 on Mac16,5
(macOS 26.5.2). The other test scene was stopped during each sample.

## Idle comparison

Two sequential 10-second samples per version, no casts, using each version's defaults.
The baseline was uncapped, with pixel ratio 1.75 and 4096² shadows. The updated version
used 30 FPS idle, pixel ratio 1.25 and 2048² shadows. This measures the combined changes,
including lower visual quality; it is not an equal-quality renderer benchmark.

| Sample | FPS | CPU ms/frame | GPU ms/query | Draw calls/frame |
| --- | ---: | ---: | ---: | ---: |
| Before, run 1 | 119.99 | 1.16 | 10.15 | 120 |
| After, run 1 | 29.99 | 2.77 | 4.76 | 58.65 |
| Before, run 2 | 119.98 | 1.11 | 6.69 | 120 |
| After, run 2 | 30.09 | 2.53 | 6.69 | 60.84 |

The comparison harness measured CPU duration around `App.frame()` and sparse asynchronous
GPU elapsed queries around the same call (38–40 completed queries/sample). The updated
panel's own GPU sampler was disabled during this comparison to avoid nesting queries.
The built-in panel normally measures GPU rendering from contact shadows through post-processing.

Draw submissions per frame roughly halved, and the idle frame rate dropped from 120 to 30.
CPU time per frame increased; at the lower frame rate, aggregate measured CPU work per second
was still lower. GPU query durations varied substantially, so these samples do not establish
a stable per-frame GPU speedup. No wattage, battery-life or temperature claim follows from
these numbers. Thermal state and background OS work were not controlled.

## Regression checks

- `npm test`: 15 FPS preserves wall/simulation time, long stalls remain bounded, the 50 ms
  particle minimum remains visible, lifetime edits reveal hidden particles, and shadow
  cadence preserves 30 Hz at 30/60/120/144 display rates.
- `npm run build` and `git diff --check` pass.
- Browser: 15 FPS idle advanced simulation by 2.07 seconds over a 2.10-second observation
  (observation endpoints fall between rendered frames).
- At an active 60 FPS budget, sun and contact shadows each refreshed 63 times in 2.10 seconds.
- All ten abilities were cast and advanced for one second each without console errors after
  removing a duplicate varying declaration in the growth shadow shader. This is a smoke test,
  not a visual verification of every full ability lifecycle.
- Panel: one section at a time, graphics tab selection, Escape to close, UI pointer isolation,
  10-second sample completion and JSON serialization checked.
- Mobile 390 × 844: panel remains 320 px wide inside the viewport without horizontal overflow.
- Simulated document hiding cancelled animation and recording; simulation remained frozen,
  and restoring visibility restarted the loop.

## Remaining measurements

Temperature and power consumption require a separate sustained test with macOS tools.
Repeat both builds under consistent power, brightness, thermal and background-work conditions,
including matched active-cast sequences. The short idle samples above do not replace that test.
