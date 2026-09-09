import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Time } from '../src/core/Time.js';
import { Cadence } from '../src/core/Cadence.js';
import { AdaptiveResolution } from '../src/core/AdaptiveResolution.js';
import { ParticleSystem } from '../src/particles/ParticleSystem.js';

function system(life) {
  const value = new ParticleSystem({ name: 'test', capacity: 2 });
  value.emit(1, { position: new Vector3(), time: 0, life, lifeVariance: 0 });
  value.sync(0, value.flush());
  return value;
}

test('15 FPS preserves one second of simulation and wall time', () => {
  const original = globalThis.performance;
  let now = 0;
  globalThis.performance = { now: () => now };
  try {
    const time = new Time();
    let wall = 0;
    for (let i = 0; i < 15; i++) {
      now += 1000 / 15;
      time.tick();
      wall += time.rawDelta;
    }
    assert.ok(Math.abs(time.elapsed - 1) < 1e-9);
    assert.ok(Math.abs(wall - 1) < 1e-9);
    now += 2000;
    assert.equal(time.tick(), 0.1);
    assert.ok(Math.abs(time.rawDelta - 2) < 1e-9);
    time.reset();
    assert.equal(time.rawDelta, 0);
  } finally { globalThis.performance = original; }
});

test('particle visibility includes the 50 ms minimum lifetime', () => {
  const particle = system(0.01);
  assert.equal(particle.countLive(0.03), 1);
  assert.equal(particle.sync(0.03, false), true);
  assert.equal(particle.sync(0.06, false), false);
  particle.dispose();
});

test('hidden particles can reappear after live lifetime editing', () => {
  const particle = system(1);
  assert.equal(particle.sync(1.1, false), false);
  particle.uniforms.uLifeScale.value = 2;
  assert.equal(particle.countLive(1.2), 1);
  assert.equal(particle.sync(1.2, false), true);
  particle.reset();
  assert.equal(particle.sync(1.2, false), false);
  particle.dispose();
});

test('shadow cadence preserves 30 refreshes/second at different display rates', () => {
  for (const fps of [30, 60, 120, 144]) {
    const cadence = new Cadence();
    cadence.due(0, 30);
    let updates = 0;
    for (let i = 0; i < fps * 10; i++) if (cadence.due(1 / fps, 30)) updates++;
    assert.equal(updates, 300, `display rate ${fps}`);
  }
});

/** Feed `seconds` of frames at `fps` and report every scale the run produced. */
function run(resolution, { seconds, fps, targetFps, active = true }) {
  const dt = 1 / fps;
  const scales = [];
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    if (resolution.sample(dt, targetFps, active)) scales.push(resolution.scale);
  }
  return scales;
}

test('adaptive resolution steps down under sustained overrun and back up when it clears', () => {
  const resolution = new AdaptiveResolution();
  // Asking for 60 and delivering 30 for six seconds: three windows, three steps.
  assert.deepEqual(run(resolution, { seconds: 6, fps: 30, targetFps: 60 }), [0.85, 0.7, 0.6]);
  assert.equal(resolution.scale, 0.6);

  // It takes three calm windows to earn one step back, and no more than one.
  assert.deepEqual(run(resolution, { seconds: 4, fps: 60, targetFps: 60 }), []);
  assert.deepEqual(run(resolution, { seconds: 4, fps: 60, targetFps: 60 }), [0.7]);
});

test('adaptive resolution ignores idle frames and a display slower than the cap', () => {
  const idle = new AdaptiveResolution();
  // 15 FPS against a 60 FPS cap is the idle throttle doing its job, not a
  // device falling behind; nothing about it should touch the resolution.
  assert.deepEqual(run(idle, { seconds: 10, fps: 15, targetFps: 60, active: false }), []);
  assert.equal(idle.scale, 1);

  const capped = new AdaptiveResolution();
  // A 120 FPS cap on a 60 Hz panel is permanently "late" against the budget.
  assert.deepEqual(run(capped, { seconds: 10, fps: 60, targetFps: 120 }), []);
  assert.equal(capped.scale, 1);
});
