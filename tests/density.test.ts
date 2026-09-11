import { describe, expect, it } from 'vitest';
import { DensityMap, type ImageSource } from '../src/image/density';
import type { Prefilter } from '../src/core/types';

function flat(value: number, w = 32, h = 32): ImageSource {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const c = Math.round(value * 255);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = c;
    rgba[i * 4 + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

/** A field of isolated dark dots on white — what a `below` readback looks like. */
function dots(w = 64, h = 64, step = 4): ImageSource {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dark = x % step === 0 && y % step === 0;
      const i = (y * w + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = dark ? 0 : 255;
      rgba[i + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

const base: Prefilter = { brightness: 0, contrast: 0, gamma: 1, blur: 0, sharpen: 0, invert: false };

function range(m: DensityMap): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of m.lum) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}

describe('DensityMap prefilter', () => {
  it('offsets brightness before applying contrast', () => {
    // The point of this order: contrast can be re-centred onto data that sits
    // away from mid-grey. With contrast applied first, a bright flat field
    // saturates to white no matter what brightness does afterwards.
    const bright = flat(0.9);
    const withBoth = DensityMap.fromSource(bright, { ...base, brightness: -0.4, contrast: 1 });
    // 0.9 - 0.4 = 0.5, which is the contrast pivot, so it should stay put.
    // The tolerance is loose because an 8-bit source quantises 0.9 to 230/255,
    // and the contrast gain multiplies that rounding error by four.
    expect(withBoth.lum[0]).toBeCloseTo(0.5, 1);

    // Whereas contrast alone on the same input blows it out.
    const contrastOnly = DensityMap.fromSource(bright, { ...base, contrast: 1 });
    expect(contrastOnly.lum[0]).toBeCloseTo(1, 3);
  });

  it('turns a field of isolated dots into continuous tone when blurred', () => {
    const src = dots();
    const sharp = range(DensityMap.fromSource(src, base));
    expect(sharp.lo).toBeCloseTo(0, 2);
    expect(sharp.hi).toBeCloseTo(1, 2);

    // After blurring, nothing is pure black or pure white any more — that is
    // what makes a layer reading the render below it able to sample tone.
    const blurred = range(DensityMap.fromSource(src, { ...base, blur: 6 }));
    expect(blurred.lo).toBeGreaterThan(0.3);
    expect(blurred.hi).toBeLessThan(1);
    expect(blurred.hi - blurred.lo).toBeLessThan(sharp.hi - sharp.lo);
  });

  it('scales the blur radius so it means the same in canvas pixels', () => {
    // The same content at two resolutions, blurred by the same canvas-space
    // radius, must produce comparable tone. Without the scale factor the
    // higher-resolution version would be blurred far less.
    const small = DensityMap.fromSource(dots(64, 64, 4), { ...base, blur: 4 }, 1);
    const large = DensityMap.fromSource(dots(128, 128, 8), { ...base, blur: 4 }, 2);
    const a = range(small);
    const b = range(large);
    expect(Math.abs((b.hi - b.lo) - (a.hi - a.lo))).toBeLessThan(0.15);
  });

  it('inverts last, after every tonal control', () => {
    const m = DensityMap.fromSource(flat(0.25), { ...base, brightness: 0.1, invert: true });
    expect(m.lum[0]).toBeCloseTo(1 - 0.35, 2);
  });

  it('samples bilinearly between pixels', () => {
    const w = 4;
    const rgba = new Uint8ClampedArray(w * 1 * 4);
    for (let x = 0; x < w; x++) {
      const c = x === 0 ? 0 : 255;
      rgba[x * 4] = rgba[x * 4 + 1] = rgba[x * 4 + 2] = c;
      rgba[x * 4 + 3] = 255;
    }
    const m = DensityMap.fromSource({ width: w, height: 1, rgba }, base);
    expect(m.sample(0, 0)).toBeCloseTo(0, 3);
    expect(m.sample(0.5, 0)).toBeCloseTo(0.5, 2);
    expect(m.sample(1, 0)).toBeCloseTo(1, 3);
  });

  it('averages over an area for halftone cells', () => {
    const m = DensityMap.fromSource(dots(64, 64, 4), base);
    // A point sample lands on black or white; an area sample sees the mean.
    const area = m.sampleArea(32, 32, 8);
    expect(area).toBeGreaterThan(0.6);
    expect(area).toBeLessThan(1);
  });

  it('builds a CDF whose total matches the summed weights', () => {
    const m = DensityMap.fromSource(flat(0.5, 16, 16), base);
    const { total } = m.buildCDF((l) => 1 - l);
    // 0.5 quantises to 128/255, so the expected total is off by half a count.
    expect(Math.abs(total[15] - 16 * 16 * 0.5)).toBeLessThan(1);
  });
});

describe('ink separation', () => {
  function solid(r: number, g: number, b: number): ImageSource {
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      rgba[i * 4] = Math.round(r * 255);
      rgba[i * 4 + 1] = Math.round(g * 255);
      rgba[i * 4 + 2] = Math.round(b * 255);
      rgba[i * 4 + 3] = 255;
    }
    return { width: 4, height: 4, rgba };
  }

  const base: Prefilter = {
    brightness: 0, contrast: 0, gamma: 1, blur: 0, sharpen: 0, invert: false,
  };
  const inked = (ink: [number, number, number, number], undercolor = 0): Prefilter =>
    ({ ...base, channel: 'ink', ink, undercolor });

  /** The map stores tone, and coverage is its complement. */
  const coverage = (src: ImageSource, f: Prefilter): number =>
    1 - DensityMap.fromSource(src, f).sample(2, 2);

  const CYAN: [number, number, number, number] = [0, 0.67, 0.93, 1];
  const BLACK: [number, number, number, number] = [0.08, 0.08, 0.08, 1];

  it('asks for no cyan on red, and a full plate on cyan', () => {
    expect(coverage(solid(1, 0.05, 0.05), inked(CYAN))).toBeLessThan(0.1);
    expect(coverage(solid(0, 0.67, 0.93), inked(CYAN))).toBeGreaterThan(0.9);
  });

  it('keeps a saturated colour off the black plate', () => {
    // Projecting absorption onto the ink reads a pure red as most of a black
    // plate, which is what turns a four-colour print into mud.
    expect(coverage(solid(0.88, 0.12, 0.12), inked(BLACK))).toBeLessThan(0.25);
  });

  it('puts a neutral grey on the black plate at roughly its darkness', () => {
    expect(coverage(solid(0.5, 0.5, 0.5), inked(BLACK))).toBeCloseTo(0.54, 1);
  });

  it('hands the neutrals to black when undercolour is on', () => {
    const grey = solid(0.5, 0.5, 0.5);
    expect(coverage(grey, inked(CYAN, 0))).toBeGreaterThan(0.4);
    expect(coverage(grey, inked(CYAN, 1))).toBeLessThan(0.05);
  });

  it('leaves a white ink carrying nothing, rather than dividing by zero', () => {
    const c = coverage(solid(0.2, 0.2, 0.2), inked([1, 1, 1, 1]));
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBe(0);
  });

  it('reads overall tone when no channel is set, as older projects have', () => {
    expect(DensityMap.fromSource(solid(0.5, 0.5, 0.5), base).sample(2, 2)).toBeCloseTo(0.5, 1);
  });
});

/**
 * A single bright column on a flat ground — the case that separates a filter's
 * strength from its radius, because a thin line is exactly what a wide blur
 * flattens and a narrow one does not.
 */
function brightLine(w = 96, h = 9, bg = 0.2, fg = 0.6): ImageSource {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x === (w >> 1) ? fg : bg) * 255);
      const i = (y * w + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

/** Peak value and halo width along the middle row. */
function profile(m: DensityMap, ground: number): { peak: number; halo: number } {
  const row = m.height >> 1;
  let peak = -Infinity;
  let halo = 0;
  for (let x = 0; x < m.width; x++) {
    const v = m.lum[row * m.width + x];
    if (v > peak) peak = v;
    if (v < ground - 1e-4) halo += 1;
  }
  return { peak, halo };
}

/**
 * `pixelScale` exists so a spatial filter means the same thing whatever
 * resolution the input happens to be. For sharpen it used to multiply the
 * *strength* instead of the radius, so a 4000px photo on a 1024px canvas was
 * sharpened four times as hard as the slider said while the halo stayed two
 * pixels wide.
 */
describe('sharpen under pixelScale', () => {
  const sharpen = 0.05;
  const fg = 0.6;

  it('keeps strength bounded by the amount, whatever the scale', () => {
    // unsharp adds (src - blurred) * 2 * amount, and that difference cannot
    // exceed 1, so no pixel may rise more than 2 * amount above the source
    // peak. Scaling the amount by pixelScale broke exactly this bound.
    const bound = fg + 2 * sharpen;
    for (const pixelScale of [1, 2, 4, 8]) {
      const m = DensityMap.fromSource(brightLine(), { ...base, sharpen }, pixelScale);
      expect(profile(m, 0.2).peak).toBeLessThanOrEqual(bound);
    }
  });

  it('widens the halo instead', () => {
    const near = profile(DensityMap.fromSource(brightLine(), { ...base, sharpen }, 1), 0.2);
    const far = profile(DensityMap.fromSource(brightLine(), { ...base, sharpen }, 4), 0.2);
    // The radius is what tracks the scale, so a denser source spreads the
    // halo further while the overshoot at the line stays put.
    expect(far.halo).toBeGreaterThan(near.halo * 2);
    expect(far.peak).toBeCloseTo(near.peak, 1);
  });
});
