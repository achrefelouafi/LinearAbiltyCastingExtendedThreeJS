import { assertPlainObject, assertSafeTree } from '../config/SettingsValidation.js';
import { settings, applySettings, snapshotSettings, DEFAULT_SETTINGS, validateSettings } from '../config/settings.js';

// Namespaced afresh: the settings tree was rebuilt around the ward ability, so
// presets saved against the old elemental blocks would merge into nothing.
const STORAGE_KEY = 'frost-sandbox.presets.v1';
const LAST_KEY = 'frost-sandbox.lastPreset';
const BROKEN_KEY = 'frost-sandbox.presets.v1.unreadable';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PRESETS = 100;
const MAX_STORAGE_BYTES = 8 * 1024 * 1024;

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

  /**
   * Load the stored collection, preset by preset.
   *
   * Validation is deliberately *not* all-or-nothing here, unlike an import. A
   * collection in storage was written by this app over months; one entry the
   * current tree no longer understands — a knob renamed between builds is
   * enough — must not take the rest of the user's work with it. Entries that
   * fail are quarantined: they stay out of the UI but are written back
   * untouched, so nothing is destroyed by the next save.
   */
  _read() {
    this._quarantine = Object.create(null);
    this._pendingBackup = null;
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      console.warn('[PresetManager] storage unavailable', error);
      return Object.create(null);
    }
    if (!raw) return Object.create(null);

    let data;
    try {
      if (new TextEncoder().encode(raw).length > MAX_STORAGE_BYTES) {
        throw new Error('Preset storage exceeds 8 MB.');
      }
      data = JSON.parse(raw);
      assertPlainObject(data);
      assertSafeTree(data);
    } catch (error) {
      // The blob itself is unusable, so nothing can be salvaged from it. Move
      // it aside rather than letting the next save overwrite it in place.
      console.warn('[PresetManager] unreadable preset collection', error);
      this._pendingBackup = raw;
      this._backupUnreadable();
      return Object.create(null);
    }

    const result = Object.create(null);
    for (const [name, preset] of Object.entries(data)) {
      try {
        if (Object.keys(result).length >= MAX_PRESETS) throw new Error('Maximum 100 presets per collection.');
        validName(name);
        result[name] = validateSettings(preset);
      } catch (error) {
        this._quarantine[name] = preset;
        console.warn(`[PresetManager] preset "${name}" is not loadable and was left in storage`, error);
      }
    }
    return result;
  }

  /** How many stored presets this build could not read. */
  get quarantined() {
    return Object.keys(this._quarantine).length;
  }

  _backupUnreadable() {
    if (this._pendingBackup === null) return true;
    try {
      localStorage.setItem(BROKEN_KEY, this._pendingBackup);
      this._pendingBackup = null;
      return true;
    } catch (error) {
      console.warn('[PresetManager] backup failed; original presets remain untouched', error);
      return false;
    }
  }

  _write(presets = this.presets) {
    // Retry a failed backup before allowing any replacement of the original.
    if (!this._backupUnreadable()) return false;
    const quarantine = Object.assign(Object.create(null), this._quarantine);
    for (const name of Object.keys(presets)) delete quarantine[name];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...quarantine, ...presets }));
      this.presets = presets;
      this._quarantine = quarantine;
      return true;
    } catch (error) {
      console.warn('[PresetManager] could not persist presets', error);
      return false;
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
    const next = Object.assign(Object.create(null), this.presets, { [name]: snapshotSettings() });
    if (!this._write(next)) return false;
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
    while (this.has(copy) || Object.hasOwn(this._quarantine, copy)) copy = `${base} copy ${index++}`;
    const next = Object.assign(Object.create(null), this.presets, { [copy]: structuredClone(this.presets[name]) });
    if (!this._write(next)) return null;
    return copy;
  }

  remove(name) {
    if (!this.has(name)) return false;
    const next = Object.assign(Object.create(null), this.presets);
    delete next[name];
    return this._write(next);
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
    const blob = new Blob([JSON.stringify({ ...this._quarantine, ...this.presets }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'frost-presets.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /** Download the original unreadable bytes, including when storage backup failed. */
  exportUnreadable() {
    let raw = this._pendingBackup;
    if (raw === null) {
      try { raw = localStorage.getItem(BROKEN_KEY); } catch { return false; }
    }
    if (raw === null) return false;
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'frost-presets-unreadable.txt';
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
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
    if (!this._write(merged)) throw new Error('Could not persist imported presets. Existing storage was preserved.');
    return { imported: Object.keys(imported), applied: false };
  }

  /** Current live settings, for callers that want to inspect them. */
  get current() {
    return settings;
  }
}
