import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Time } from '../src/core/Time.js';
import { Cadence } from '../src/core/Cadence.js';
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
