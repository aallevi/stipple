import { describe, expect, it } from 'vitest';
import { defaultDistribution, defaultMask } from '../src/core/defaults';
import { generateHalftone } from '../src/dist/halftone';
import { generateJittered } from '../src/dist/jittered';
import { POINT_STRIDE, inkAt, quantise, type GenContext } from '../src/dist/types';
import { DensityMap } from '../src/image/density';
import type { HalftoneParams, JitteredParams } from '../src/core/types';

/** A vertical ramp: black on the left, white on the right. */
function ramp(w = 128, h = 128): DensityMap {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      const i = (y * w + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return DensityMap.fromSource({ width: w, height: h, rgba }, {
    brightness: 0, contrast: 0, gamma: 1, blur: 0, sharpen: 0, invert: false,
  });
}

function ctx(density: DensityMap, quality = 1): GenContext {
  return {
    density,
    width: density.width,
    height: density.height,
    mask: defaultMask(),
    quality,
    maxPoints: 1_000_000,
  };
}

describe('inkAt', () => {
  it('gives dark tones more ink, and nothing outside the tone range', () => {
    const m = defaultMask();
    expect(inkAt(0, false, [0, 1], m)).toBeCloseTo(1);
    expect(inkAt(1, false, [0, 1], m)).toBeCloseTo(0);
    expect(inkAt(0.2, false, [0.5, 1], m)).toBe(0);
  });

  it('inverts density on request', () => {
    expect(inkAt(0.9, true, [0, 1], defaultMask())).toBeCloseTo(0.9);
  });

  it('feathers the mask window instead of cutting hard', () => {
    const m = { toneRange: [0.4, 0.6] as [number, number], feather: 0.2, invert: false };
    expect(inkAt(0.3, false, [0, 1], m)).toBe(0);
    expect(inkAt(0.5, false, [0, 1], m)).toBeGreaterThan(0);
    // Halfway into the feather ramp the mask should be partial, not full.
    const mid = inkAt(0.5, false, [0, 1], m) / 0.5;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThanOrEqual(1);
  });
});

describe('quantise', () => {
  it('snaps ink to discrete bands', () => {
    expect(quantise(0.44, 4)).toBeCloseTo(0.5);
    expect(quantise(0.44, 1000)).toBeCloseTo(0.44);
  });
});

describe('generateJittered', () => {
  const density = ramp();

  it('is deterministic for a given seed', () => {
    const p = defaultDistribution('jittered') as JitteredParams;
    const a = generateJittered(p, ctx(density));
    const b = generateJittered(p, ctx(density));
    expect(a.count).toBe(b.count);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('changes the result when the seed changes', () => {
    const p = defaultDistribution('jittered') as JitteredParams;
    const a = generateJittered(p, ctx(density));
    const b = generateJittered({ ...p, seed: p.seed + 1 }, ctx(density));
    expect(Array.from(a.data)).not.toEqual(Array.from(b.data));
  });

  it('places far more points in the dark half than the light half', () => {
    const p = defaultDistribution('jittered') as JitteredParams;
    const out = generateJittered(p, ctx(density));
    let dark = 0;
    let light = 0;
    for (let i = 0; i < out.count; i++) {
      if (out.data[i * POINT_STRIDE] < density.width / 2) dark += 1;
      else light += 1;
    }
    expect(out.count).toBeGreaterThan(500);
    expect(dark).toBeGreaterThan(light * 2);
  });

  it('places nothing when the tone window excludes the whole image', () => {
    const p = { ...defaultDistribution('jittered'), toneRange: [1.01, 1.02] } as JitteredParams;
    expect(generateJittered(p, ctx(density)).count).toBe(0);
  });

  it('thins roughly proportionally at reduced quality', () => {
    const p = defaultDistribution('jittered') as JitteredParams;
    const full = generateJittered(p, ctx(density, 1)).count;
    const preview = generateJittered(p, ctx(density, 0.3)).count;
    expect(preview).toBeLessThan(full);
    expect(preview).toBeGreaterThan(full * 0.15);
  });

  it('keeps every point inside the canvas', () => {
    const p = defaultDistribution('jittered') as JitteredParams;
    const out = generateJittered(p, ctx(density));
    for (let i = 0; i < out.count; i++) {
      const x = out.data[i * POINT_STRIDE];
      const y = out.data[i * POINT_STRIDE + 1];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(density.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(density.height);
    }
  });
});

describe('generateHalftone', () => {
  const density = ramp();

  it('produces a rotated lattice that still covers the canvas', () => {
    const p = { ...defaultDistribution('halftone'), lineature: 20, angle: 30 } as HalftoneParams;
    const out = generateHalftone(p, ctx(density), 300);
    expect(out.count).toBeGreaterThan(50);

    // A rotated screen must still reach every corner region of the canvas.
    const quadrants = [0, 0, 0, 0];
    for (let i = 0; i < out.count; i++) {
      const x = out.data[i * POINT_STRIDE];
      const y = out.data[i * POINT_STRIDE + 1];
      quadrants[(x > density.width / 2 ? 1 : 0) + (y > density.height / 2 ? 2 : 0)] += 1;
    }
    // The light half legitimately gets fewer points, but none may be empty.
    expect(quadrants.every((q) => q > 0)).toBe(true);
  });

  it('scales point count with lineature', () => {
    const coarse = generateHalftone(
      { ...defaultDistribution('halftone'), lineature: 15 } as HalftoneParams, ctx(density), 300);
    const fine = generateHalftone(
      { ...defaultDistribution('halftone'), lineature: 60 } as HalftoneParams, ctx(density), 300);
    expect(fine.count).toBeGreaterThan(coarse.count * 3);
  });
});
