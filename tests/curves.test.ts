import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_LEVELS, addCurvePoint, channelLUTs, gammaToPosition, isIdentityCurve, levelsFn,
  monotoneSpline, moveCurvePoint, positionToGamma, removeCurvePoint, toneMapper,
} from '../src/image/curves';
import { DensityMap, type ImageSource } from '../src/image/density';
import type { Prefilter } from '../src/core/types';

describe('monotone spline', () => {
  it('passes through its control points', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.3, y: 0.7 }, { x: 1, y: 1 }];
    const f = monotoneSpline(pts);
    for (const p of pts) expect(f(p.x)).toBeCloseTo(p.y, 6);
  });

  it('never overshoots between close control points', () => {
    // A step then a plateau: a natural cubic spline dips below the lower point here.
    const f = monotoneSpline([{ x: 0, y: 0 }, { x: 0.45, y: 0.05 }, { x: 0.55, y: 0.95 }, { x: 1, y: 1 }]);
    for (let i = 0; i <= 200; i++) {
      const y = f(i / 200);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('stays monotone when its points do', () => {
    const f = monotoneSpline([{ x: 0, y: 0 }, { x: 0.2, y: 0.1 }, { x: 0.7, y: 0.85 }, { x: 1, y: 1 }]);
    let prev = -Infinity;
    for (let i = 0; i <= 300; i++) {
      const y = f(i / 300);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });
});

describe('levels', () => {
  it('maps the input range onto the output range', () => {
    const f = levelsFn({ inBlack: 0.2, inWhite: 0.8, gamma: 1, outBlack: 0, outWhite: 1 });
    expect(f(0.2)).toBeCloseTo(0, 5);
    expect(f(0.8)).toBeCloseTo(1, 5);
    expect(f(0.5)).toBeCloseTo(0.5, 5);
    expect(f(0.1)).toBe(0);
    expect(f(0.9)).toBe(1);
  });

  it('brightens as gamma rises', () => {
    expect(levelsFn({ ...NEUTRAL_LEVELS, gamma: 2 })(0.5)).toBeGreaterThan(0.5);
    expect(levelsFn({ ...NEUTRAL_LEVELS, gamma: 0.5 })(0.5)).toBeLessThan(0.5);
  });

  it('puts the midtone handle on the input that comes out mid grey', () => {
    for (const g of [0.4, 1, 2.5]) {
      const f = levelsFn({ ...NEUTRAL_LEVELS, gamma: g });
      expect(f(gammaToPosition(g))).toBeCloseTo(0.5, 4);
      expect(positionToGamma(gammaToPosition(g))).toBeCloseTo(g, 3);
    }
  });
});

describe('the tone mapper', () => {
  it('is skipped entirely when levels and curve are neutral', () => {
    expect(toneMapper({})).toBeNull();
    expect(toneMapper({ levels: { ...NEUTRAL_LEVELS }, curve: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBeNull();
    expect(channelLUTs(undefined)).toBeNull();
  });

  it('applies levels before the curve', () => {
    // Levels clip everything under 0.5 to black; the curve then lifts black to 0.2.
    const map = toneMapper({
      levels: { ...NEUTRAL_LEVELS, inBlack: 0.5 },
      curve: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }],
    })!;
    expect(map(0.3)).toBeCloseTo(0.2, 3);
    expect(map(1)).toBeCloseTo(1, 3);
  });

  it('treats a straight line with extra points on it as the identity', () => {
    expect(isIdentityCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }])).toBe(true);
    expect(isIdentityCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }])).toBe(false);
  });
});

describe('editing control points', () => {
  it('keeps points sorted and refuses duplicates at the same x', () => {
    let pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    pts = addCurvePoint(pts, { x: 0.5, y: 0.8 });
    pts = addCurvePoint(pts, { x: 0.502, y: 0.2 });
    expect(pts).toHaveLength(3);
    expect(pts.map((p) => p.x)).toEqual([...pts.map((p) => p.x)].sort((a, b) => a - b));
  });

  it('pins the end points to their edges', () => {
    const pts = moveCurvePoint([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0, { x: 0.4, y: 0.3 });
    expect(pts[0].x).toBe(0);
    expect(pts[0].y).toBeCloseTo(0.3, 6);
  });

  it('never removes an end point', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    expect(removeCurvePoint(pts, 0)).toHaveLength(3);
    expect(removeCurvePoint(pts, 2)).toHaveLength(3);
    expect(removeCurvePoint(pts, 1)).toHaveLength(2);
  });
});

describe('curves in the density pass', () => {
  const base: Prefilter = { brightness: 0, contrast: 0, gamma: 1, blur: 0, sharpen: 0, invert: false };
  const grey = (r: number, g: number, b: number): ImageSource => {
    const rgba = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < 256; i++) rgba.set([r, g, b, 255], i * 4);
    return { width: 16, height: 16, rgba };
  };

  it('leaves the tone alone when nothing is set', () => {
    const m = DensityMap.fromSource(grey(128, 128, 128), base);
    expect(m.lum[0]).toBeCloseTo(128 / 255, 4);
  });

  it('moves the measured tone with the tone curve, and records both histograms', () => {
    const m = DensityMap.fromSource(grey(128, 128, 128), { ...base, curve: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }] });
    expect(m.lum[0]).toBeGreaterThan(0.75);
    expect(m.toneIn.indexOf(Math.max(...m.toneIn))).toBe(128);
    expect(m.toneOut.indexOf(Math.max(...m.toneOut))).toBeGreaterThan(190);
  });

  it('applies colour curves before the layer measures', () => {
    // Pull the red down to nothing: a pure red now reads as black.
    const m = DensityMap.fromSource(grey(255, 0, 0), {
      ...base,
      curves: { r: [{ x: 0, y: 0 }, { x: 1, y: 0 }], g: [{ x: 0, y: 0 }, { x: 1, y: 1 }], b: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    });
    expect(m.lum[0]).toBeCloseTo(0, 4);
    // ...but the colour the dots can take from the picture is untouched.
    expect(m.rgba[0]).toBe(255);
  });
});
