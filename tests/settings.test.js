import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { settings, DEFAULT_SETTINGS, applySettings, snapshotSettings, resetSettings } from '../src/config/settings.js';
import { registerSettingRange } from '../src/config/SettingsValidation.js';
import { PresetManager } from '../src/ui/PresetManager.js';
import { setPerformanceProfile, loadPerformancePreferences, performanceProfile, validatePerformance, suggestedProfile } from '../src/config/PerformancePreferences.js';

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
  // Economy halves the bloom chain rather than dropping it at rest: the saving
  // also applies during a cast, and the look stops changing with the pointer.
  assert.equal(settings.performance.bloomScale, 0.5);
  assert.equal(settings.performance.idleBloom, true);
  Object.assign(settings.performance, DEFAULT_SETTINGS.performance);
  loadPerformancePreferences();
  assert.equal(performanceProfile(), 'Economy');
  assert.throws(() => validatePerformance({ shadowResolution: 999999 }));
  localStorage.setItem('casting.performance.v1', '{"maxFps":"bad"}');
  loadPerformancePreferences();
  assert.equal(performanceProfile(), 'Economy');
});

test('a device with no stored preference is guessed at, and a stored one is never overridden', () => {
  const original = globalThis.matchMedia;
  try {
    globalThis.matchMedia = () => ({ matches: true });
    assert.equal(suggestedProfile(), 'Economy');
    loadPerformancePreferences();
    assert.equal(performanceProfile(), 'Economy', 'first run follows the guess');

    // A choice on this device outranks the guess, corrupt or not.
    setPerformanceProfile('Balanced');
    loadPerformancePreferences();
    assert.equal(performanceProfile(), 'Balanced');
    localStorage.setItem('casting.performance.v1', '{"maxFps":"bad"}');
    loadPerformancePreferences();
    assert.equal(performanceProfile(), 'Balanced');

    globalThis.matchMedia = () => ({ matches: false });
    assert.equal(suggestedProfile(), 'Balanced');
  } finally { globalThis.matchMedia = original; }
});

test('one unreadable preset does not take the rest of the collection with it', () => {
  const good = snapshotSettings();
  const stale = structuredClone(good);
  stale.global.knobRemovedInALaterBuild = 1;
  localStorage.setItem('frost-sandbox.presets.v1',
    JSON.stringify({ 'Look A': good, Stale: stale, 'Look B': good }));

  const manager = new PresetManager();
  assert.deepEqual(manager.names, ['Look A', 'Look B'], 'the readable presets still load');
  assert.equal(manager.quarantined, 1);

  manager.save('New');
  const stored = JSON.parse(localStorage.getItem('frost-sandbox.presets.v1'));
  assert.deepEqual(Object.keys(stored).sort(), ['Look A', 'Look B', 'New', 'Stale'],
    'saving must not destroy what this build could not read');
  assert.deepEqual(stored.Stale, stale, 'the quarantined preset goes back untouched');
});

test('a wholesale unreadable collection is moved aside, not overwritten', () => {
  localStorage.setItem('frost-sandbox.presets.v1', '{ not json');
  const manager = new PresetManager();
  assert.deepEqual(manager.names, []);
  assert.equal(localStorage.getItem('frost-sandbox.presets.v1.unreadable'), '{ not json');
  manager.save('New');
  assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem('frost-sandbox.presets.v1'))), ['New']);
  assert.equal(localStorage.getItem('frost-sandbox.presets.v1.unreadable'), '{ not json');
});

for (const operation of ['save', 'import']) {
  test(`${operation} replaces a quarantined preset permanently`, () => {
    const key = 'frost-sandbox.presets.v1';
    localStorage.setItem(key, JSON.stringify({ Look: { global: { removedKnob: 1 } } }));
    const manager = new PresetManager();
    assert.equal(manager.quarantined, 1);
    if (operation === 'save') assert.equal(manager.save('Look'), true);
    else manager.importJSON(JSON.stringify({ Look: snapshotSettings() }));
    assert.equal(manager.quarantined, 0);
    assert.equal(manager.remove('Look'), true);
    assert.deepEqual(JSON.parse(localStorage.getItem(key)), {});
    assert.equal(new PresetManager().quarantined, 0);
  });
}

test('duplicates do not overwrite quarantined names', () => {
  const key = 'frost-sandbox.presets.v1';
  const stale = { global: { removedKnob: 1 } };
  localStorage.setItem(key, JSON.stringify({ Look: snapshotSettings(), 'Look copy': stale }));
  const manager = new PresetManager();
  assert.equal(manager.duplicate('Look'), 'Look copy 2');
  assert.deepEqual(JSON.parse(localStorage.getItem(key))['Look copy'], stale);
});

test('failed backup blocks writes until the original can be preserved', () => {
  const key = 'frost-sandbox.presets.v1';
  const raw = '{ not json';
  localStorage.setItem(key, raw);
  const setItem = localStorage.setItem;
  let full = true;
  localStorage.setItem = (name, value) => {
    if (name === `${key}.unreadable` && full) throw new Error('QuotaExceededError');
    setItem(name, value);
  };
  const manager = new PresetManager();
  assert.equal(manager.save('New'), false);
  assert.throws(() => manager.importJSON(JSON.stringify({ Imported: snapshotSettings() })), /persist/);
  assert.equal(localStorage.getItem(key), raw);
  assert.equal(localStorage.getItem(`${key}.unreadable`), null);
  assert.deepEqual(manager.names, []);

  full = false;
  assert.equal(manager.save('New'), true);
  assert.equal(localStorage.getItem(`${key}.unreadable`), raw);
  assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem(key))), ['New']);
});

test('failed persistence leaves saved presets and quarantine unchanged', () => {
  const key = 'frost-sandbox.presets.v1';
  const raw = JSON.stringify({ Look: snapshotSettings(), Stale: { global: { removedKnob: 1 } } });
  localStorage.setItem(key, raw);
  const manager = new PresetManager();
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(manager.save('Stale'), false);
  assert.equal(manager.remove('Look'), false);
  assert.equal(manager.duplicate('Look'), null);
  assert.throws(() => manager.importJSON(JSON.stringify({ Stale: snapshotSettings() })), /persist/);
  assert.deepEqual(manager.names, ['Look']);
  assert.equal(manager.quarantined, 1);
  assert.equal(localStorage.getItem(key), raw);
});
