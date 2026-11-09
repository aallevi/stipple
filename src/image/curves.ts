import type { ChannelCurves, CurvePoint, Levels, Prefilter } from '../core/types';

/**
 * Curves and levels, as lookup tables.
 *
 * Kept pure and away from the density code on purpose: this is the arithmetic
 * that decides what a photograph's tones become, so it is the part worth being
 * able to test on its own. Ported from Contour, where it was written first.
 */

export const IDENTITY: readonly CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

export const NEUTRAL_LEVELS: Readonly<Levels> = { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Monotone cubic interpolation through the control points (Fritsch–Carlson).
 *
 * A natural cubic spline is the obvious choice and the wrong one: between two
 * close control points it overshoots, so dragging a handle down can make the
 * region just before it get *brighter*. Clamping the tangents removes the
 * overshoot entirely — the drawn curve never leaves the box its handles make.
 */
export function monotoneSpline(points: readonly CurvePoint[]): (x: number) => number {
  const pts = [...points]
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  if (pts.length === 0) return (x) => x;
  if (pts.length === 1) return () => clamp01(pts[0].y);

  const n = pts.length;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i];
    dx.push(h);
    // Two handles on the same x would divide by zero; treat the pair as a step.
    slope.push(h === 0 ? 0 : (ys[i + 1] - ys[i]) / h);
  }

  // Tangents: one-sided at the ends, averaged in the middle, flat at a turn.
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  // Pull the tangents inside the circle of radius 3, so no segment can leave
  // the interval its endpoints define.
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  return (x: number): number => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = dx[i];
    if (h === 0) return ys[i + 1];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

export function isIdentityCurve(points: readonly CurvePoint[] | undefined): boolean {
  if (!points || points.length === 0) return true;
  return points.every((p) => Math.abs(p.x - p.y) < 1e-6)
    && points.some((p) => p.x <= 1e-6) && points.some((p) => p.x >= 1 - 1e-6);
}

export function isNeutralLevels(l: Levels | undefined): boolean {
  return !l || (l.inBlack === 0 && l.inWhite === 1 && l.gamma === 1 && l.outBlack === 0 && l.outWhite === 1);
}

/** Levels as the classic dialog does them: clip to the input range, gamma, remap to the output. */
export function levelsFn(l: Levels | undefined): (v: number) => number {
  if (isNeutralLevels(l)) return clamp01;
  const { inBlack, outBlack } = l!;
  const span = Math.max(1e-4, l!.inWhite - inBlack);
  const inv = 1 / Math.max(0.01, l!.gamma);
  const outSpan = l!.outWhite - outBlack;
  return (v) => clamp01(outBlack + clamp01((v - inBlack) / span) ** inv * outSpan);
}

/** Resolution of the tone table; lookups between entries are interpolated. */
const TONE_LUT = 1024;

/**
 * Levels then the tone curve, as one function backed by a table — or null when
 * both are neutral, so the density pass can skip the loop entirely.
 */
export function toneMapper(f: Pick<Prefilter, 'levels' | 'curve'>): ((v: number) => number) | null {
  if (isNeutralLevels(f.levels) && isIdentityCurve(f.curve)) return null;
  const lv = levelsFn(f.levels);
  const cv = monotoneSpline(f.curve ?? IDENTITY);
  const lut = new Float32Array(TONE_LUT + 1);
  for (let i = 0; i <= TONE_LUT; i++) lut[i] = clamp01(cv(lv(i / TONE_LUT)));
  return (v) => {
    const t = clamp01(v) * TONE_LUT;
    const i = t | 0;
    if (i >= TONE_LUT) return lut[TONE_LUT];
    return lut[i] + (lut[i + 1] - lut[i]) * (t - i);
  };
}

/**
 * The colour curves as three 8-bit tables, or null when all three are straight.
 * The source is 8-bit, so a 256-entry table per channel is exact.
 */
export function channelLUTs(c: ChannelCurves | undefined): [Float32Array, Float32Array, Float32Array] | null {
  if (!c || (isIdentityCurve(c.r) && isIdentityCurve(c.g) && isIdentityCurve(c.b))) return null;
  return [c.r, c.g, c.b].map((pts) => {
    const f = monotoneSpline(pts ?? IDENTITY);
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = clamp01(f(i / 255));
    return lut;
  }) as [Float32Array, Float32Array, Float32Array];
}

/** Insert a point, keeping the list sorted and free of near-duplicate x values. */
export function addCurvePoint(points: readonly CurvePoint[], p: CurvePoint): CurvePoint[] {
  const next = points.filter((q) => Math.abs(q.x - p.x) > 0.008);
  next.push({ x: clamp01(p.x), y: clamp01(p.y) });
  return next.sort((a, b) => a.x - b.x);
}

/**
 * Move a point, with the ends pinned to their edges.
 *
 * The first and last handle keep their x so the curve always spans the whole
 * range; letting them slide inwards would leave the tones beyond undefined.
 * Middle handles stay a sliver away from their neighbours, so they cannot swap.
 */
export function moveCurvePoint(points: readonly CurvePoint[], index: number, p: CurvePoint): CurvePoint[] {
  const next = points.map((q) => ({ ...q }));
  if (index < 0 || index >= next.length) return next;
  next[index].y = clamp01(p.y);
  if (index > 0 && index < next.length - 1) {
    const lo = next[index - 1].x + 0.008;
    const hi = next[index + 1].x - 0.008;
    next[index].x = Math.min(Math.max(clamp01(p.x), lo), hi);
  }
  return next;
}

/** Remove a middle point; the two ends always stay. */
export function removeCurvePoint(points: readonly CurvePoint[], index: number): CurvePoint[] {
  if (points.length <= 2 || index <= 0 || index >= points.length - 1) return [...points];
  return points.filter((_, i) => i !== index);
}

/**
 * Gamma as a position between the black and white points, and back.
 *
 * The marker sits on the *input* that comes out as mid grey: levels maps `t`
 * to `t ** (1 / gamma)`, so that input is `0.5 ** gamma`. A gamma above 1,
 * which brightens, puts the marker left of centre — the way dragging the
 * midtone handle left brightens in every levels dialog.
 */
export const gammaToPosition = (gamma: number): number => clamp01(0.5 ** Math.max(0.01, gamma));

export const positionToGamma = (t: number): number => {
  const p = Math.min(0.999, Math.max(0.001, t));
  return Math.min(10, Math.max(0.1, Math.log(p) / Math.log(0.5)));
};

/** Tones counted into 256 bins, sampled for speed — a histogram needs shape, not every pixel. */
export function toneHistogram(lum: Float32Array, bins = 256): Uint32Array {
  const out = new Uint32Array(bins);
  const stride = Math.max(1, Math.floor(lum.length / 250_000));
  for (let i = 0; i < lum.length; i += stride) {
    const v = lum[i];
    out[v >= 1 ? bins - 1 : v <= 0 ? 0 : (v * bins) | 0] += 1;
  }
  return out;
}
