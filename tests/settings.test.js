import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { settings, DEFAULT_SETTINGS, applySettings, snapshotSettings, resetSettings } from '../src/config/settings.js';
import { registerSettingRange } from '../src/config/SettingsValidation.js';
import { PresetManager } from '../src/ui/PresetManager.js';
import { setPerformanceProfile, loadPerformancePreferences, performanceProfile, validatePerformance } from '../src/config/PerformancePreferences.js';

beforeEach(() => {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (k,v) => storage.set(k,v) };
  Object.assign(settings.performance, DEFAULT_SETTINGS.performance);
  resetSettings();
});

test('reject prototype pollution at every depth without partial mutation', () => {
  const original = Object.prototype.toString;
  for (const text of [
    '{"global":{"glow":2},"__proto__":{"toString":null}}',
    '{"global":{"constructor":{"prototype":{"toString":null}}}}',
    '{"performance":{"__proto__":{"toString":null}}}'
  ]) assert.throws(() => applySettings(JSON.parse(text)), /Reserved/);
  assert.equal(Object.prototype.toString, original);
  assert.equal(settings.global.glow, DEFAULT_SETTINGS.global.glow);
});

test('reject types, non-finite numbers, unknown keys, oversized values, arrays and invalid strings', () => {
  for (const value of ['1', null, Infinity, NaN, 1e9, []]) {
    assert.throws(() => applySettings({ global: { glow: 2, timeScale: value } }));
    assert.equal(settings.global.glow, DEFAULT_SETTINGS.global.glow);
  }
  assert.throws(() => applySettings({ unknown: true }));
  assert.throws(() => applySettings({ ward: { castAnim: '<script>' } }));
  registerSettingRange(settings.global, 'speed', 0.1, 4);
  assert.throws(() => applySettings({ global: { speed: 5 } }), /Out-of-range/);
  applySettings({ global: { speed: 2 } });
  assert.equal(settings.global.speed, 2);
});

test('snapshots, old imports, saved collections and resets preserve device preferences', () => {
  const manager = new PresetManager();
  setPerformanceProfile('Economy');
  const perf = structuredClone(settings.performance);
  assert.equal(Object.hasOwn(snapshotSettings(), 'performance'), false);
  manager.importJSON(JSON.stringify({ ...snapshotSettings(), performance: DEFAULT_SETTINGS.performance }));
  assert.deepEqual(settings.performance, perf);
  manager.importJSON(JSON.stringify({ old: { ...snapshotSettings(), performance: DEFAULT_SETTINGS.performance } }));
  assert.equal(Object.hasOwn(manager.presets.old, 'performance'), false);
  assert.equal(manager.load('old'), true);
  manager.reset();
  assert.deepEqual(settings.performance, perf);
  assert.equal(manager.save('saved'), true);
  assert.equal(Object.hasOwn(manager.presets.saved, 'performance'), false);
});

test('collection imports are atomic and names cannot address inherited properties', () => {
  const manager = new PresetManager();
  assert.equal(manager.load('toString'), false);
  assert.equal(manager.save('__proto__'), false);
  assert.throws(() => manager.importJSON('{"__proto__":{}}'));
  assert.throws(() => manager.importJSON(JSON.stringify({ good: snapshotSettings(), bad: { global: { glow: 'bad' } } })));
  assert.deepEqual(manager.names, []);
  manager.importJSON(JSON.stringify({ global: snapshotSettings() }));
  assert.equal(manager.load('global'), true);
  assert.throws(() => manager.importJSON(' '.repeat(2 * 1024 * 1024 + 1)), /2 MB/);
});

test('profiles persist independently and corrupt device settings are ignored', () => {
  setPerformanceProfile('Economy');
  assert.equal(performanceProfile(), 'Economy');
  assert.equal(settings.performance.idleBloom, false);
  Object.assign(settings.performance, DEFAULT_SETTINGS.performance);
  loadPerformancePreferences();
  assert.equal(performanceProfile(), 'Economy');
  assert.throws(() => validatePerformance({ shadowResolution: 999999 }));
  localStorage.setItem('casting.performance.v1', '{"maxFps":"bad"}');
  loadPerformancePreferences();
  assert.equal(performanceProfile(), 'Economy');
});
