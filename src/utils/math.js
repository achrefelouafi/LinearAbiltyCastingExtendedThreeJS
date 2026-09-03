/** Small maths helpers shared across systems. All allocation-free. */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const saturate = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, saturate(invLerp(a, b, v)));
export const smoothstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential damping. `rate` = fraction remaining after 1s. */
export const damp = (current, target, rate, dt) => lerp(target, current, Math.pow(rate, dt));

export const randRange = (a, b) => a + Math.random() * (b - a);
export const randSign = () => (Math.random() < 0.5 ? -1 : 1);

/** Deterministic hash → [0,1). Useful for stable per-instance randomness. */
export function hash11(n) {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

/* ------------------------------ easing ------------------------------ */

export const Easing = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  /** Fast rise, slow decay — the classic VFX "pop" curve. */
  pop: (t) => Math.sin(Math.min(1, t) * Math.PI) ** 0.6
};

/** 0→1→0 envelope with configurable attack. */
export function envelope(t, attack = 0.15) {
  if (t <= 0 || t >= 1) return 0;
  return t < attack ? Easing.outCubic(t / attack) : Easing.inOutCubic(1 - (t - attack) / (1 - attack));
}
