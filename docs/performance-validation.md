# Rendering validation — 2026-09-09

[Recorded test/build output](validation/latest-checks.txt) includes the timestamp, tested code
commit and exit codes. Browser measurements below were captured through the diagnostics panel
and browser evaluation tools; they are separate from the Node test output.

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

Per-frame GPU cost is, however, the wrong quantity for a sustained-load question. What the
same rows say about **duty cycle** is much less ambiguous: before, ~8.4 ms of GPU work landed
in an 8.33 ms frame period, so the GPU was busy essentially all of the time; after, ~5.7 ms
landed in a 33.3 ms period, or roughly 17%. That is about six times less GPU work per second
of wall time, and it is the figure a thermal question is asking about. It still is not a
temperature measurement.

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

## Economy mode and idle bloom follow-up

At Economy settings (30 active / 15 idle FPS, DPR cap 1, 1024² shadows at 15 Hz), two
10-second samples in the same idle scene changed only `idleBloom`:

| Bloom while idle | FPS | Draw calls/frame | CPU ms/frame | GPU ms/query |
| --- | ---: | ---: | ---: | ---: |
| On | 15.00 | 61 | 1.06 | 5.80 |
| Off | 15.00 | 48 | 1.14 | 3.53 |

These are short diagnostic samples, not power measurements. Side-by-side inspection of a
frozen idle scene showed no obvious artifact at the default low bloom strength; stronger
artistic bloom settings can make the change more visible. Balanced keeps idle bloom enabled.
Bloom returned when aiming in the browser test. Reset/import preserved Economy preferences.
Security tests cover reserved keys, atomic imports, numeric ranges, invalid types and
independent graphics persistence. The browser console had only a missing favicon request.

## Review fixes — September 9, 2026

The reviewed adaptive-rendering changes now initialize the renderer scale before its first pixel-ratio calculation. Preset replacements retire quarantined entries, duplicate names avoid quarantined names, and storage writes commit in-memory changes only after persistence succeeds. If an unreadable collection cannot be backed up, writes leave the original untouched and retry the backup on the next attempt.

Validation: 19 Node tests pass, including five new cases covering quarantine replacement, duplicate collisions, backup failure/retry and failed-write atomicity. Production build and `git diff --check` pass. A browser check using a real WebGLRenderer verifies its initial DPR and canvas dimensions before any settings synchronization, followed by an adaptive resize; no console errors were observed. This does not repeat the full ability lifecycle checks or measure power/temperature.

To repeat the renderer check, start `npm run dev`, open the app, and run `await (await import('/tests/browser/renderer-initialization.js')).checkRendererInitialization()` in the browser console. This browser check is separate from `npm test`.

[Captured command output and browser results](validation/review-fixes-checks.txt).
