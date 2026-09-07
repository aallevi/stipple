/**
 * Deterministic random helpers.
 *
 * Everything generative in the app is seeded so that a given project always
 * renders identically — that is what makes the point buffers cacheable and the
 * distribution unit tests meaningful.
 */

/** mulberry32 — small, fast, good enough distribution for point jitter. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stateless hash of two integers plus a seed, in 0..1.
 *
 * Used for per-point randomness: because it depends only on the point's grid
 * coordinates, a point keeps the same random value when unrelated parameters
 * change, so nothing shimmers while you drag a slider.
 */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
