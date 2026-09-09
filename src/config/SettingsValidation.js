const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const ranges = new WeakMap();

export function registerSettingRange(object, key, min, max) {
  if (!ranges.has(object)) ranges.set(object, new Map());
  ranges.get(object).set(key, [min, max]);
}

export function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('Expected a settings object.');
  }
}

/** Inspect ignored keys too, before merging or storing any imported data. */
export function assertSafeTree(value, depth = 0) {
  if (depth > 12) throw new Error('Preset nesting is too deep.');
  if (!value || typeof value !== 'object') return;
  assertPlainObject(value);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error(`Reserved preset key: ${key}`);
    assertSafeTree(child, depth + 1);
  }
}

/** Build a validated copy first: an invalid field must never partially apply. */
export function validatePatch(patch, schema, target, { omitPerformance = false } = {}) {
  assertPlainObject(patch);
  assertSafeTree(patch);
  function visit(input, defaults, live, path = '') {
    const result = {};
    for (const [key, value] of Object.entries(input)) {
      if (omitPerformance && !path && key === 'performance') continue;
      if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown setting: ${path}${key}`);
      const expected = defaults[key];
      const label = `${path}${key}`;
      if (expected && typeof expected === 'object') {
        assertPlainObject(value);
        result[key] = visit(value, expected, live[key], `${label}.`);
      } else {
        if (typeof value !== typeof expected) throw new Error(`Invalid type: ${label}`);
        if (typeof value === 'number') {
          // Editor ranges are reused at runtime; a hard bound protects headless
          // consumers and settings that have no editor control.
          const [min, max] = ranges.get(live)?.get(key) ?? [-10000, 10000];
          if (!Number.isFinite(value) || (value !== expected && (value < min || value > max))) {
            throw new Error(`Out-of-range setting: ${label}`);
          }
        }
        if (typeof value === 'string') {
          const valid = key === 'castAnim' ? ['cast1', 'cast2', 'cast3'].includes(value)
            : /^#[0-9a-f]{6}$/i.test(value);
          if (!valid) throw new Error(`Invalid value: ${label}`);
        }
        result[key] = value;
      }
    }
    return result;
  }
  return visit(patch, schema, target);
}

export function mergeValidated(patch, target) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object') mergeValidated(value, target[key]);
    else target[key] = value;
  }
  return target;
}
