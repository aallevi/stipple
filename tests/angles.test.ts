import { describe, expect, it } from 'vitest';
import { defaultLayer, defaultMask } from '../src/core/defaults';
import { angleBetween, canFollow, foldAngle, releaseFollowers, screenAngle, screenPeriod } from '../src/core/angles';
import type { HalftoneParams, Layer } from '../src/core/types';
import { generateHalftone } from '../src/dist/halftone';
import { POINT_STRIDE } from '../src/dist/types';
import { DensityMap } from '../src/image/density';

function screen(id: string, angle: number, angleFrom?: string, lattice: HalftoneParams['lattice'] = 'square'): Layer {
  const l = defaultLayer(id, 'halftone');
  return { ...l, id, distribution: { ...(l.distribution as HalftoneParams), angle, angleFrom, lattice } };
}

describe('screen angles', () => {
  it('adds offsets along a chain of references', () => {
    const layers = [screen('k', 45), screen('c', 30, 'k'), screen('m', 30, 'c')];
    expect(screenAngle(layers[0], layers)).toBe(45);
    expect(screenAngle(layers[1], layers)).toBe(75);
    expect(screenAngle(layers[2], layers)).toBe(105);
  });

  it('reads an offset as absolute when its reference is gone or loops', () => {
    expect(screenAngle(screen('a', 20, 'missing'), [])).toBe(20);
    const loop = [screen('a', 10, 'b'), screen('b', 5, 'a')];
    expect(Number.isFinite(screenAngle(loop[0], loop))).toBe(true);
  });

  it('will not let a screen follow itself or one that follows it', () => {
    const layers = [screen('k', 45), screen('c', 30, 'k')];
    expect(canFollow(layers, 'k', 'k')).toBe(false);
    expect(canFollow(layers, 'k', 'c')).toBe(false);
    expect(canFollow(layers, 'c', 'k')).toBe(true);
    expect(canFollow([...layers, defaultLayer('dots', 'jittered')], 'c', layers[0].id)).toBe(true);
  });

  it('keeps every follower where it was when its reference is deleted', () => {
    const layers = [screen('k', 45), screen('c', 30, 'k'), screen('m', -15, 'c')];
    const before = layers.map((l) => screenAngle(l, layers));
    releaseFollowers(layers, 'c');
    const after = layers.filter((l) => l.id !== 'c');
    expect(screenAngle(after[1], after)).toBeCloseTo(before[2]);
    expect((after[1].distribution as HalftoneParams).angleFrom).toBe('k');
  });

  it('folds by the lattice: hexagonal screens 60° apart are the same screen', () => {
    expect(screenPeriod('hex')).toBe(60);
    expect(foldAngle(75, 60)).toBeCloseTo(15);
    expect(foldAngle(-15, 90)).toBeCloseTo(75);
    expect(angleBetween(75, 15, 60)).toBeCloseTo(0);
    expect(angleBetween(15, 75, 90)).toBeCloseTo(30);
  });
});

describe('a turned hexagonal screen', () => {
  it('reaches the ends of a wide picture at every angle', () => {
    const w = 1200;
    const h = 120;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const density = DensityMap.fromSource({ width: w, height: h, rgba },
      { brightness: 0, contrast: 0, gamma: 1, blur: 0, sharpen: 0, invert: false });
    const cell = 10;
    for (const angle of [0, 30, 60, 90, 120]) {
      const pts = generateHalftone(
        { algo: 'halftone', cells: h / cell, angle, lattice: 'hex', toneRange: [0, 1], invertDensity: false },
        { density, width: w, height: h, unit: h, mask: defaultMask(), quality: 1, maxPoints: 1e6 },
      );
      for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
        let best = Infinity;
        for (let i = 0; i < pts.count; i++) {
          best = Math.min(best, Math.hypot(pts.data[i * POINT_STRIDE] - cx, pts.data[i * POINT_STRIDE + 1] - cy));
        }
        // Within one cell and a half of every corner — before the fix, six cells short at 90°.
        expect(best, `${angle}° at (${cx}, ${cy})`).toBeLessThan(cell * 1.5);
      }
    }
  });
});

describe('a shifted screen', () => {
  const w = 200;
  const h = 200;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const density = DensityMap.fromSource({ width: w, height: h, rgba },
    { brightness: 0, contrast: 0, gamma: 1, blur: 0, sharpen: 0, invert: false });
  const cell = 10;
  const run = (angle: number, lattice: HalftoneParams['lattice'], shift?: [number, number]): [number, number][] => {
    const pts = generateHalftone(
      { algo: 'halftone', cells: h / cell, angle, lattice, toneRange: [0, 1], invertDensity: false, shift },
      { density, width: w, height: h, unit: h, mask: defaultMask(), quality: 1, maxPoints: 1e6 },
    );
    return Array.from({ length: pts.count }, (_, i) => [pts.data[i * POINT_STRIDE], pts.data[i * POINT_STRIDE + 1]]);
  };
  const near = (pts: [number, number][], x: number, y: number): number =>
    Math.min(...pts.map(([px, py]) => Math.hypot(px - x, py - y)));

  it('moves the grid by the asked fraction of a cell, in the screen’s own axes', () => {
    const angle = 30;
    const t = (angle * Math.PI) / 180;
    const base = run(angle, 'square');
    const moved = run(angle, 'square', [0.5, 0.25]);
    // Every dot of the moved screen is the unmoved one's, carried half a cell
    // along the rows and a quarter across them.
    const dx = 0.5 * cell * Math.cos(t) - 0.25 * cell * Math.sin(t);
    const dy = 0.5 * cell * Math.sin(t) + 0.25 * cell * Math.cos(t);
    const inner = moved.filter(([x, y]) => x > 20 && x < w - 20 && y > 20 && y < h - 20);
    expect(inner.length).toBeGreaterThan(100);
    for (const [x, y] of inner) expect(near(base, x - dx, y - dy)).toBeLessThan(1e-3);
    // ...and half a cell puts the dots exactly between the old ones.
    expect(near(base, inner[0][0], inner[0][1])).toBeGreaterThan(cell * 0.25);
  });

  it('lands on the same grid after a whole repeat, and still covers the picture', () => {
    const key = (p: [number, number][]): string => p.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).sort().join(' ');
    expect(key(run(15, 'square', [1, -1]))).toBe(key(run(15, 'square')));
    expect(key(run(15, 'hex', [0, 2]))).toBe(key(run(15, 'hex')));
    for (const shift of [[0.99, 0.99], [-0.99, -0.99]] as [number, number][]) {
      const pts = run(45, 'hex', shift);
      for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) expect(near(pts, cx, cy)).toBeLessThan(cell * 1.5);
    }
  });
});
