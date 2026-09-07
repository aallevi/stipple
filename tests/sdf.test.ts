import { describe, expect, it } from 'vitest';
import { encodeSDF, signedDistanceField } from '../src/shape/sdf';

/** Build an alpha mask from a predicate over pixel centres. */
function mask(w: number, h: number, inside: (x: number, y: number) => boolean): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) a[y * w + x] = inside(x, y) ? 255 : 0;
  }
  return a;
}

describe('signedDistanceField', () => {
  it('is negative inside, positive outside, near zero at the boundary', () => {
    const w = 33;
    const cx = 16;
    const r = 10;
    const field = signedDistanceField(
      mask(w, w, (x, y) => Math.hypot(x - cx, y - cx) <= r),
      w, w,
    );

    expect(field[cx * w + cx]).toBeLessThan(-r + 1.5); // centre, deep inside
    expect(field[0]).toBeGreaterThan(0);               // corner, outside
    // A pixel just inside the rim should read close to zero.
    expect(Math.abs(field[cx * w + (cx + r - 1)])).toBeLessThan(2);
  });

  it('matches the exact Euclidean distance for a single seed pixel', () => {
    const w = 21;
    const field = signedDistanceField(mask(w, w, (x, y) => x === 10 && y === 10), w, w);
    // 8SSEDT is exact for this configuration; anything else means the sweep is wrong.
    for (const [x, y] of [[10, 13], [7, 10], [13, 14], [0, 0]] as [number, number][]) {
      expect(field[y * w + x]).toBeCloseTo(Math.hypot(x - 10, y - 10), 4);
    }
  });

  it('reports a half-covered edge pixel as sitting on the boundary', () => {
    const w = 9;
    const a = mask(w, w, (x) => x < 4);
    a[4 * w + 4] = 128; // half-covered pixel on the edge
    const field = signedDistanceField(a, w, w);
    expect(Math.abs(field[4 * w + 4])).toBeLessThan(0.1);
  });
});

describe('encodeSDF', () => {
  it('maps the shape edge to mid-grey and clamps beyond the spread', () => {
    const field = new Float32Array([0, -100, 100, -2, 2]);
    const enc = encodeSDF(field, 4);
    expect(enc[0]).toBe(127);       // exactly on the edge
    expect(enc[1]).toBe(255);       // far inside, clamped
    expect(enc[2]).toBe(0);         // far outside, clamped
    expect(enc[3]).toBeGreaterThan(enc[0]);
    expect(enc[4]).toBeLessThan(enc[0]);
  });
});
