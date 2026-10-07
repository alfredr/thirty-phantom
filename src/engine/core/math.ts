/** A point or vector in x, y, z order. */
export type V3 = [number, number, number];

export const TAU = Math.PI * 2;

/**
 * Signed 2D cross product. For x/z inputs, this is the negative of the 3D
 * cross product's y component.
 */
export const cross2 = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => ax * by - ay * bx;

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number =>
  clamp((v - a) / (b - a), 0, 1);
/** Remainder with the sign of `n`: mod(-1, 4) is 3. */
export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Frame-rate independent exponential approach. */
export const damp = (
  a: number,
  b: number,
  lambda: number,
  dt: number,
): number => lerp(a, b, 1 - Math.exp(-lambda * dt));

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;

  if (a < 0) {
    a += TAU;
  }

  return a - Math.PI;
}

export const dampAngle = (
  a: number,
  b: number,
  lambda: number,
  dt: number,
): number => a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function easeOutBack(t: number, s = 1.70158): number {
  const u = t - 1;
  return 1 + u * u * ((s + 1) * u + s);
}

export function easeOutElastic(t: number): number {
  if (t <= 0) {
    return 0;
  }

  if (t >= 1) {
    return 1;
  }

  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;
}

export const easeInOut = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
