import { assertPlainObject, assertSafeTree } from '../config/SettingsValidation.js';
import { settings, applySettings, snapshotSettings, DEFAULT_SETTINGS, validateSettings } from '../config/settings.js';

// Namespaced afresh: the settings tree was rebuilt around the ward ability, so
// presets saved against the old elemental blocks would merge into nothing.
const STORAGE_KEY = 'frost-sandbox.presets.v1';
const LAST_KEY = 'frost-sandbox.lastPreset';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PRESETS = 100;

function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || ['__proto__', 'prototype', 'constructor'].includes(name)) {
    throw new Error('Use a preset name of 1–80 characters without reserved keys.');
  }
}

export function validateCollection(data) {
  assertPlainObject(data);
  assertSafeTree(data);
  if (Object.keys(data).length > MAX_PRESETS) throw new Error('Maximum 100 presets per collection.');
  const result = Object.create(null);
  for (const [name, preset] of Object.entries(data)) {
    validName(name);
    result[name] = validateSettings(preset);
  }
  return result;
}

/**
 * Preset persistence.
 *
 * Presets are plain snapshots of the settings tree, stored in localStorage and
 * exportable as JSON. Loading merges *into* the live settings objects rather
 * than replacing them, so every binding held by a shader or particle system
 * stays valid — which is why a preset can be swapped mid-cast.
 */
export class PresetManager {
  constructor() {
    this.presets = this._read();
  }

  _read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw && new TextEncoder().encode(raw).length > 8 * 1024 * 1024) throw new Error('Preset storage exceeds 8 MB.');
      return raw ? validateCollection(JSON.parse(raw)) : Object.create(null);
    } catch (error) {
      console.warn('[PresetManager] could not read presets', error);
      return Object.create(null);
    }
  }

  _write() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.presets));
    } catch (error) {
      console.warn('[PresetManager] could not persist presets', error);
    }
  }

  get names() {
    return Object.keys(this.presets).sort();
  }

  has(name) {
    return Object.prototype.hasOwnProperty.call(this.presets, name);
  }

  save(name) {
    try { validName(name); } catch { return false; }
    if (!this.has(name) && this.names.length >= MAX_PRESETS) return false;
    this.presets[name] = snapshotSettings();
    this._write();
    try { localStorage.setItem(LAST_KEY, name); } catch { /* Storage is optional. */ }
    return true;
  }

  load(name) {
    if (!this.has(name)) return false;
    try { applySettings(this.presets[name]); } catch { return false; }
    try { localStorage.setItem(LAST_KEY, name); } catch { /* Storage is optional. */ }
    return true;
  }

  duplicate(name) {
    if (!this.has(name) || this.names.length >= MAX_PRESETS) return null;
    const base = name.slice(0, 65);
    let copy = `${base} copy`;
    let index = 2;
    while (this.has(copy)) copy = `${base} copy ${index++}`;
    this.presets[copy] = structuredClone(this.presets[name]);
    this._write();
    return copy;
  }

  remove(name) {
    if (!this.has(name)) return false;
    delete this.presets[name];
    this._write();
    return true;
  }

  reset() {
    applySettings(structuredClone(DEFAULT_SETTINGS));
  }

  /** Trigger a download of the current settings (or a named preset). */
  exportJSON(name = null) {
    const data = name && this.has(name) ? this.presets[name] : snapshotSettings();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(name ?? 'frost-settings').replace(/\s+/g, '-').toLowerCase()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /** Export every stored preset in one file. */
  exportAll() {
    const blob = new Blob([JSON.stringify(this.presets, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'frost-presets.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Import from a JSON file chosen by the user.
   * Accepts either a single settings snapshot or a map of presets.
   * @returns {Promise<{ imported: string[], applied: boolean }>}
   */
  importFromFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve({ imported: [], applied: false });
        try {
          if (file.size > MAX_BYTES) throw new Error('Preset files must be at most 2 MB.');
          resolve(this.importJSON(await file.text()));
        } catch (error) {
          console.error('[PresetManager] import failed', error);
          resolve({ imported: [], applied: false, error: error.message });
        }
      };
      input.addEventListener('cancel', () => resolve({ imported: [], applied: false }));
      input.click();
    });
  }

  importJSON(text) {
    if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Preset files must be at most 2 MB.');
    const data = JSON.parse(text);
    assertPlainObject(data);
    assertSafeTree(data);
    // A collection can itself contain a preset named 'global'. Its value
    // has settings blocks, whereas a snapshot's global block has scalars.
    if (Object.hasOwn(data, 'global') && data.global &&
        Object.values(data.global).every(value => value === null || typeof value !== 'object')) {
      applySettings(data);
      return { imported: [], applied: true };
    }
    const imported = validateCollection(data);
    const merged = Object.assign(Object.create(null), this.presets, imported);
    if (Object.keys(merged).length > MAX_PRESETS) throw new Error('Maximum 100 saved presets.');
    this.presets = merged;
    this._write();
    return { imported: Object.keys(imported), applied: false };
  }

  /** Current live settings, for callers that want to inspect them. */
  get current() {
    return settings;
  }
}
