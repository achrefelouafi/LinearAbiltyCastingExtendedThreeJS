import { settings, DEFAULT_SETTINGS } from './settings.js';
import { assertPlainObject, assertSafeTree } from './SettingsValidation.js';

const KEY = 'casting.performance.v1';
const allowed = {
  maxFps: [30, 60, 120], idleFps: [15, 30, 240],
  pixelRatio: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  shadowResolution: [1024, 2048, 4096], shadowFps: [15, 30, 240], idleBloom: [true, false]
};
export const PERFORMANCE_PROFILES = {
  Balanced: { ...DEFAULT_SETTINGS.performance },
  Economy: { maxFps: 30, idleFps: 15, pixelRatio: 1, shadowResolution: 1024, shadowFps: 15, idleBloom: false }
};

export function validatePerformance(patch) {
  assertPlainObject(patch);
  assertSafeTree(patch);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(allowed, key) || !allowed[key].includes(value)) throw new Error(`Invalid performance setting: ${key}`);
  }
  return { ...patch };
}

export function savePerformancePreferences() {
  const valid = validatePerformance(settings.performance);
  try { localStorage.setItem(KEY, JSON.stringify(valid)); } catch { /* Storage is optional. */ }
}

export function loadPerformancePreferences() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw && raw.length <= 2048) Object.assign(settings.performance, validatePerformance(JSON.parse(raw)));
  } catch { /* Ignore corrupt preferences; keep the shipped defaults. */ }
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
