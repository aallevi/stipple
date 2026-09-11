import type { JitteredParams } from '../core/types';
import { hash2 } from '../core/rng';
import { allocPoints, inkAt, quantise, type GenContext, type PointBuffer } from './types';

/**
 * Jittered-grid stochastic screening — the workhorse.
 *
 * Walk a grid at `spacing`, offset each candidate randomly inside its cell, and
 * keep it with probability equal to the local ink coverage. O(cells), no
 * neighbour queries, no relaxation: millions of points in a few milliseconds,
 * which is what makes dragging the spacing slider feel continuous.
 *
 * The randomness is a stateless hash of the *cell index*, not a running PRNG.
 * That matters more than it looks: a point keeps its identity when unrelated
 * parameters change, so the stipple settles rather than reshuffling on every
 * edit, and the generator can be trivially parallelised by row later.
 */
export function generateJittered(p: JitteredParams, ctx: GenContext): PointBuffer {
  const { density, width, height, mask } = ctx;
  const spacing = Math.max(0.5, p.spacing);
  const passes = 1 + Math.max(0, Math.floor(p.overpaint));

  const cols = Math.ceil(width / spacing);
  const rows = Math.ceil(height / spacing);

  // Estimating capacity rather than growing avoids reallocating a 40MB buffer
  // mid-generation. Ink averages well under 1, so cells * passes is generous.
  const estimate = Math.min(ctx.maxPoints, cols * rows * passes);
  const { write } = allocPoints(estimate);

  const sx = density.width / width;
  const sy = density.height / height;
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

        const tone = density.sample(x * sx, y * sy);
        const ink = quantise(inkAt(tone, p.invertDensity, p.toneRange, mask), p.phases);
        if (ink <= 0) continue;

        // Threshold against an independent hash: expected density matches ink
        // exactly, with blue-noise-ish spatial character from the jitter.
        const r4 = hash2(cx + 2087, cy + 9151, seed + 31);
        if (r4 >= ink) continue;

        const grad = density.gradientAt(x * sx, y * sy);
        if (!write.push(x, y, tone, grad, r2)) return write.finish();
      }
    }
  }

  return write.finish();
}
