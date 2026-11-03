import type { JitteredParams } from '../core/types';
import { hash2 } from '../core/rng';
import { allocPoints, inkAt, quantise, type GenContext, type PointBuffer } from './types';

/**
 * Jittered-grid stochastic screening — the workhorse.
 *
 * Walk a grid, offset each candidate randomly inside its cell, and keep it with
 * probability equal to the local ink coverage. O(cells), no neighbour queries,
 * no relaxation: millions of points in a few milliseconds, which is what makes
 * dragging the density slider feel continuous.
 *
 * The randomness is a stateless hash of the *cell index*, not a running PRNG.
 * That matters more than it looks: a point keeps its identity when unrelated
 * parameters change, so the stipple settles rather than reshuffling on every
 * edit, and the generator can be trivially parallelised by row later.
 */
export function generateJittered(p: JitteredParams, ctx: GenContext): PointBuffer {
  const { width, height, mask } = ctx;
  const map = ctx.density;
  const passes = 1 + Math.max(0, Math.floor(p.overpaint));

  // The grid is set by the picture, not by the canvas pixel grid: `density` is
  // sites across the short edge, so the same number draws the same stipple on a
  // 512 px document and on a 6000 px one. This used to floor the spacing at half
  // a canvas pixel, which quietly made the document's resolution the limit on
  // how fine a screen could be — a nonsense for an output that is vector.
  const wanted = ctx.unit / Math.max(1, p.density);
  // The one real ceiling is the point budget. A grid finer than the buffer can
  // ever hold is not a finer drawing, it is a second spent walking cells whose
  // points are dropped on the floor, so the spacing stops there.
  const maxCells = Math.max(1, ctx.maxPoints / passes);
  const spacing = Math.max(wanted, Math.sqrt((width * height) / maxCells));

  const cols = Math.ceil(width / spacing);
  const rows = Math.ceil(height / spacing);

  // Estimating capacity rather than growing avoids reallocating a 40MB buffer
  // mid-generation. Ink averages well under 1, so cells * passes is generous.
  const estimate = Math.min(ctx.maxPoints, cols * rows * passes);
  const { write } = allocPoints(estimate);

  const sx = map.width / width;
  const sy = map.height / height;
  // Interactive previews keep a stratified subset: the hash is uniform, so
  // testing it against `quality` thins the cloud evenly instead of clipping a
  // region, and the preview reads as the same image at lower density.
  const thin = ctx.quality < 1 ? ctx.quality : 1;

  for (let pass = 0; pass < passes; pass++) {
    // Each overpaint pass is offset by an irrational fraction of a cell so the
    // layers never re-align into a visible moiré.
    const off = pass * spacing * 0.618;
    const seed = p.seed + pass * 7919;

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const r1 = hash2(cx, cy, seed);
        if (thin < 1 && r1 > thin) continue;

        const r2 = hash2(cx + 1013, cy + 337, seed);
        const r3 = hash2(cx + 7717, cy + 4231, seed);

        const x = (cx + 0.5 + (r2 - 0.5) * p.jitter) * spacing + off;
        const y = (cy + 0.5 + (r3 - 0.5) * p.jitter) * spacing + off;
        if (x < 0 || x >= width || y < 0 || y >= height) continue;

        const tone = map.sample(x * sx, y * sy);
        const ink = quantise(inkAt(tone, p.invertDensity, p.toneRange, mask), p.phases);
        if (ink <= 0) continue;

        // Threshold against an independent hash: expected density matches ink
        // exactly, with blue-noise-ish spatial character from the jitter.
        const r4 = hash2(cx + 2087, cy + 9151, seed + 31);
        if (r4 >= ink) continue;

        const grad = map.gradientAt(x * sx, y * sy);
        if (!write.push(x, y, tone, grad, r2)) return write.finish();
      }
    }
  }

  return write.finish();
}
