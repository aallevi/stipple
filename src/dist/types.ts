import type { DensityMap } from '../image/density';
import type { LayerMask } from '../core/types';

/**
 * Points are stored as one interleaved Float32Array of *invariants* — the
 * quantities that only change when points actually move.
 *
 *   0 x          canvas px
 *   1 y          canvas px
 *   2 tone       prefiltered source luminance at (x, y), 0..1
 *   3 gradient   luminance gradient angle in radians
 *   4 rand       stable per-point random, 0..1
 *
 * Size, rotation and colour are *not* here: they are derived in the vertex
 * shader from `tone`, `gradient`, `rand` and layer uniforms. That is the whole
 * reason dragging a size or colour slider costs a uniform update instead of a
 * regeneration — at 1M points the difference is ~200ms versus ~0.
 */
export const POINT_STRIDE = 5;

export type PointBuffer = {
  data: Float32Array;
  count: number;
};

export function allocPoints(capacity: number): { data: Float32Array; write: Writer } {
  const data = new Float32Array(capacity * POINT_STRIDE);
  return { data, write: new Writer(data) };
}

/** Appends points into a preallocated buffer, tracking the count. */
export class Writer {
  count = 0;
  constructor(private data: Float32Array) {}

  get capacity(): number {
    return this.data.length / POINT_STRIDE;
  }

  push(x: number, y: number, tone: number, gradient: number, rand: number): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count * POINT_STRIDE;
    this.data[i] = x;
    this.data[i + 1] = y;
    this.data[i + 2] = tone;
    this.data[i + 3] = gradient;
    this.data[i + 4] = rand;
    this.count += 1;
    return true;
  }

  /**
   * Hand back just the points that were written.
   *
   * `slice`, not `subarray`: a subarray shares its parent's `ArrayBuffer`, so a
   * generator that estimated four million points and wrote a thousand would
   * leave the engine holding the whole 76 MB allocation for the life of the
   * layer. One copy of the real data is much the cheaper end of that trade.
   */
  finish(): PointBuffer {
    return { data: this.data.slice(0, this.count * POINT_STRIDE), count: this.count };
  }
}

export type GenContext = {
  density: DensityMap;
  /** Canvas dimensions; the density map may be a different resolution. */
  width: number;
  height: number;
  /**
   * Canvas pixels in one document unit — the short edge. Distributions that
   * express their density relative to the picture rather than to the pixel grid
   * multiply by this to get a spacing. See `core/scale.ts`.
   */
  unit: number;
  mask: LayerMask;
  /** 0..1. Below 1 the generator may thin the output for interactive preview. */
  quality: number;
  /** Hard ceiling so a bad parameter cannot allocate gigabytes. */
  maxPoints: number;
};

/**
 * Ink coverage at a tone, after the layer's density inversion and tone window.
 * Returns 0 where no point should be placed at all.
 */
export function inkAt(
  tone: number,
  invertDensity: boolean,
  range: [number, number],
  mask: LayerMask,
): number {
  if (tone < range[0] || tone > range[1]) return 0;

  let m = 1;
  const [lo, hi] = mask.toneRange;
  if (mask.feather > 0) {
    // Smooth ramps inside each edge of the window rather than a hard cut.
    const f = Math.max(1e-4, mask.feather);
    const a = Math.min(1, Math.max(0, (tone - lo) / f));
    const b = Math.min(1, Math.max(0, (hi - tone) / f));
    m = Math.min(a, b);
  } else {
    m = tone >= lo && tone <= hi ? 1 : 0;
  }
  if (mask.invert) m = 1 - m;
  if (m <= 0) return 0;

  // Dark areas take ink by default; `invertDensity` flips that.
  const ink = invertDensity ? tone : 1 - tone;
  return ink * m;
}

/** Quantise ink into `phases` discrete bands, as the reference tool does. */
export function quantise(ink: number, phases: number): number {
  if (phases >= 256) return ink;
  const p = Math.max(1, Math.floor(phases));
  return Math.round(ink * p) / p;
}
