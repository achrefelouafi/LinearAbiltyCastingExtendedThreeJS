import { settings, DEFAULT_SETTINGS } from './settings.js';
import { assertPlainObject, assertSafeTree } from './SettingsValidation.js';

const KEY = 'casting.performance.v1';
const allowed = {
  maxFps: [30, 60, 120], idleFps: [15, 30, 240],
  pixelRatio: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  shadowResolution: [1024, 2048, 4096], shadowFps: [15, 30, 240], idleBloom: [true, false],
  bloomScale: [0.5, 0.75, 1], dynamicResolution: [true, false], lightCount: [3, 4, 6]
};
export const PERFORMANCE_PROFILES = {
  Balanced: { ...DEFAULT_SETTINGS.performance },
  // Economy keeps bloom on and halves its resolution instead of dropping it at
  // idle: the saving is comparable, it also applies during a cast, and the
  // look no longer changes every time the pointer moves.
  Economy: {
    maxFps: 30, idleFps: 15, pixelRatio: 1, shadowResolution: 1024, shadowFps: 15,
    idleBloom: true, bloomScale: 0.5, dynamicResolution: true, lightCount: 4
  }
};

/**
 * Where a device with no stored preference should start.
 *
 * A phone that never opens the graphics panel would otherwise boot straight
 * into the desktop defaults. None of these signals is precise — `deviceMemory`
 * is coarse and absent on Safari, a coarse pointer covers tablets too — but
 * each of them is only ever used to pick a *starting* profile that the user
 * can change in two clicks, and `dynamicResolution` corrects the rest.
 */
export function suggestedProfile() {
  if (typeof navigator === 'undefined' || typeof matchMedia !== 'function') return 'Balanced';
  const coarse = matchMedia('(pointer: coarse)').matches;
  return coarse || (navigator.deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4
    ? 'Economy'
    : 'Balanced';
}

export function validatePerformance(patch) {
  assertPlainObject(patch);
  assertSafeTree(patch);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(allowed, key) || !allowed[key].includes(value)) throw new Error(`Invalid performance setting: ${key}`);
  }
  return { ...patch };
}

/**
 * Persist the current device preferences.
 *
 * Every caller is a UI change handler, and what it validates is local state we
 * just wrote ourselves — so a rejected value here is a bug in a control, not
 * hostile input, and must not escape into the widget that fired the event.
 * `validatePerformance` still throws on the load path, where the data really
 * is untrusted.
 */
export function savePerformancePreferences() {
  try {
    localStorage.setItem(KEY, JSON.stringify(validatePerformance(settings.performance)));
  } catch (error) {
    console.warn('[performance] preferences not saved', error);
  }
}

export function loadPerformancePreferences() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { /* Storage is optional. */ }

  if (raw !== null) {
    // Something was stored, so a choice was made on this device. Honour it, or
    // keep the live values if it is corrupt — guessing over a decision the
    // user already made would be worse than doing nothing.
    try {
      if (raw.length <= 2048) Object.assign(settings.performance, validatePerformance(JSON.parse(raw)));
    } catch (error) {
      console.warn('[performance] ignoring stored preferences', error);
    }
    return;
  }

  // First run. The guess is not saved, so it is re-made every boot until the
  // user picks something themselves.
  Object.assign(settings.performance, PERFORMANCE_PROFILES[suggestedProfile()]);
}

export function setPerformanceProfile(name) {
  if (!Object.hasOwn(PERFORMANCE_PROFILES, name)) return;
  Object.assign(settings.performance, PERFORMANCE_PROFILES[name]);
  savePerformancePreferences();
}

export function performanceProfile() {
  return Object.entries(PERFORMANCE_PROFILES).find(([, profile]) =>
    Object.keys(profile).every(key => profile[key] === settings.performance[key]))?.[0] ?? 'Custom';
}
