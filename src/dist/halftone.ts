import type { HalftoneParams } from '../core/types';
import { hash2 } from '../core/rng';
import { allocPoints, inkAt, type GenContext, type PointBuffer } from './types';

/**
 * Classic AM halftone: one point per screen cell, sized by the cell's mean tone.
 *
 * Unlike the stochastic screens this places a point in *every* cell inside the
 * tone window — the tonal information lives in the point's size, which the
 * vertex shader derives from `tone`. Rotating the screen is therefore free and
 * exact, and stacking three of these at 15°/45°/75° gives you real rosette
 * separations.
 */
export function generateHalftone(p: HalftoneParams, ctx: GenContext, dpi: number): PointBuffer {
  const { density, width, height, mask } = ctx;

  // lpi -> px per cell. Clamped so a stray parameter cannot ask for a 1px screen
  // across a 10000px canvas.
  const cell = Math.max(1.5, dpi / Math.max(1, p.lineature));
  const theta = (p.angle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // The rotated lattice must cover the canvas corners, so work in screen space
  // over a bounding radius and rotate each site back.
  const diag = Math.ceil(Math.hypot(width, height) / cell) + 2;
  const half = Math.ceil(diag / 2);
  const cx = width / 2;
  const cy = height / 2;

  // Every lattice puts one row of sites per cell; a line screen differs only in
  // packing its sites densely *along* the row, which is what turns a row of
  // separate dots into a continuous ruled line.
  const colStep = p.lattice === 'line' ? 0.25 : 1;

  const estimate = Math.min(
    ctx.maxPoints,
    Math.ceil(diag * (diag / colStep)) + 16,
  );
  const { write } = allocPoints(estimate);

  const sx = density.width / width;
  const sy = density.height / height;
  // The cell's own footprint. A line screen's extra sites oversample that same
  // footprint rather than covering a smaller one, so the radius does not change.
  const areaRadius = cell * 0.5;

  for (let j = -half; j <= half; j++) {
    // Hex offsets alternate rows by half a cell, giving the denser, less grid-like
    // packing used for stochastic-leaning screens.
    const stagger = p.lattice === 'hex' && (Math.abs(j) & 1) === 1 ? 0.5 : 0;
    const rowY = j * cell * (p.lattice === 'hex' ? 0.866 : 1);

    for (let i = -half; i <= half; i += colStep) {
      const localX = (i + stagger) * cell;
      const x = cx + localX * cos - rowY * sin;
      const y = cy + localX * sin + rowY * cos;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;

      const tone = density.sampleArea(x * sx, y * sy, areaRadius * Math.max(sx, sy));
      const ink = inkAt(tone, p.invertDensity, p.toneRange, mask);
      if (ink <= 0) continue;

      const grad = density.gradientAt(x * sx, y * sy);
      const rand = hash2(Math.round(i * 4), j, 17);
      if (!write.push(x, y, tone, grad, rand)) return write.finish();
    }
  }

  return write.finish();
}
