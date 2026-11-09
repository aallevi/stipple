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
export function generateHalftone(p: HalftoneParams, ctx: GenContext): PointBuffer {
  const { density, width, height, mask } = ctx;

  // Cells across the short edge -> px per cell. Clamped so a stray parameter
  // cannot ask for a 1px screen across a 10000px canvas.
  const cell = Math.max(1.5, ctx.unit / Math.max(1, p.cells));
  const theta = (p.angle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // The rotated lattice must cover the canvas corners, so work in screen space
  // over a bounding radius and rotate each site back.
  const diag = Math.ceil(Math.hypot(width, height) / cell) + 4;
  const half = Math.ceil(diag / 2);
  // Rows sit closer than a cell on a hexagonal lattice, so it needs more of
  // them to reach as far. With the square count, a hex screen turned towards
  // the long side of a wide picture ran out of rows before the ends.
  const rowPitch = p.lattice === 'hex' ? Math.sqrt(3) / 2 : 1;
  const rows = Math.ceil(half / rowPitch);
  const cx = width / 2;
  const cy = height / 2;
  // The screen's own position, in cells along and across its rows. Only the
  // part within one repeat matters — a whole cell along, or a whole row across,
  // lands on the same grid — so it is folded there, which also keeps it inside
  // the cell of margin the bounds above leave. Hex rows alternate, so they
  // repeat every second row.
  const fold = (v: number, period: number): number => v - period * Math.round(v / period);
  const [shiftAlong, shiftAcross] = p.shift ?? [0, 0];
  const ox = fold(shiftAlong || 0, 1);
  const oy = fold(shiftAcross || 0, p.lattice === 'hex' ? 2 : 1);

  // Every lattice puts one row of sites per cell; a line screen differs only in
  // packing its sites densely *along* the row, which is what turns a row of
  // separate dots into a continuous ruled line.
  const colStep = p.lattice === 'line' ? 0.25 : 1;

  const estimate = Math.min(
    ctx.maxPoints,
    Math.ceil((2 * rows + 1) * (diag / colStep)) + 16,
  );
  const { write } = allocPoints(estimate);

  const sx = density.width / width;
  const sy = density.height / height;
  // The cell's own footprint. A line screen's extra sites oversample that same
  // footprint rather than covering a smaller one, so the radius does not change.
  const areaRadius = cell * 0.5;

  for (let j = -rows; j <= rows; j++) {
    // Hex offsets alternate rows by half a cell, giving the denser, less grid-like
    // packing used for stochastic-leaning screens.
    const stagger = p.lattice === 'hex' && (Math.abs(j) & 1) === 1 ? 0.5 : 0;
    const rowY = (j + oy) * cell * rowPitch;

    for (let i = -half; i <= half; i += colStep) {
      const localX = (i + stagger + ox) * cell;
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
