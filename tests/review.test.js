import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformancePanel } from '../src/ui/PerformancePanel.js';
import { CameraRig } from '../src/core/CameraRig.js';
import { settings } from '../src/config/settings.js';

function panel() {
  const value = Object.create(PerformancePanel.prototype);
  Object.assign(value, {
    renderer: { info: { render: { calls: 3, triangles: 10 }, memory: {} }, domElement: { width: 800, height: 600 } },
    gpu: { completed: 0, latest: null },
    element: { querySelector: () => ({ value: 'test' }), dataset: {}, open: false },
    fps: {}, mode: {}, status: {}, recordButton: {}, sampleRows: {},
    frames: 0, windowTime: 0, cpuTotal: 0
  });
  return value;
}

test('completed comparison exposes adaptive trajectory, canvas changes and effective light budget', () => {
  const value = panel();
  value.startRecording();
  const configuredLights = settings.performance.lightCount;
  for (let i = 0; i < 10; i++) {
    if (i === 5) value.renderer.domElement.width = 680;
    value.record(1, 2, { mode: 'Active', targetFps: 60, scale: i < 5 ? 1 : 0.85, lightCount: configuredLights + 2 });
  }
  assert.equal(value.lastSample.mixedRenderingStates, true);
  assert.equal(value.lastSample.lightBudgetRequiresReload, true);
  assert.deepEqual(value.lastSample.effectiveStates, [
    { frame: 0, seconds: 0, state: { scale: 1, lightCount: configuredLights + 2, canvas: [800, 600] } },
    { frame: 5, seconds: 5, state: { scale: 0.85, lightCount: configuredLights + 2, canvas: [680, 600] } }
  ]);
  assert.match(value.status.textContent, /differences/);
});

test('constant effective state completes a comparable sample', () => {
  const value = panel();
  value.startRecording();
  for (let i = 0; i < 10; i++) value.record(1, 2, { mode: 'Idle', targetFps: 15, lightCount: settings.performance.lightCount });
  assert.equal(value.lastSample.effectiveStates.length, 1);
  assert.equal(value.lastSample.mixedRenderingStates, false);
  assert.equal(value.lastSample.lightBudgetRequiresReload, false);
});

test('wheel zoom signals interaction immediately', () => {
  const original = settings.camera.distance;
  let active = false;
  const rig = Object.create(CameraRig.prototype);
  rig.onInteraction = () => { active = true; };
  try {
    rig._onWheel({ preventDefault() {}, deltaMode: 0, deltaY: 100 });
    assert.equal(active, true);
    assert.notEqual(settings.camera.distance, original);
  } finally { settings.camera.distance = original; }
});
