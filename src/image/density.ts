import type { Prefilter } from '../core/types';

/** Decoded source pixels. Kept as raw RGBA so workers can transfer it cheaply. */
export type ImageSource = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};

/**
 * The luminance field that drives point placement, plus everything derived from
 * it that a distribution might need.
 *
 * Built once per (source, prefilter) pair and cached by the engine — this is the
 * `Dirty.Density` tier. Distributions treat it as read-only.
 */
export class DensityMap {
  /** Prefiltered luminance, 0..1. */
  readonly lum: Float32Array;
  /** Original colours, for the `image` colour mode. */
  readonly rgba: Uint8ClampedArray;
  /** Box-filtered mip chain for cheap area averages (halftone cells). */
  private mips: { data: Float32Array; w: number; h: number }[] = [];
  private gradient: Float32Array | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    lum: Float32Array,
    rgba: Uint8ClampedArray,
  ) {
    this.lum = lum;
    this.rgba = rgba;
  }

  /**
   * @param pixelScale density pixels per canvas pixel. Spatial filters are
   *   specified in canvas pixels, so this keeps `blur` meaning the same thing
   *   whether the input is a 4000px photo or a readback of the layers below at
   *   whatever resolution the viewport happens to be rendering at.
   */
  static fromSource(src: ImageSource, f: Prefilter, pixelScale = 1): DensityMap {
    const { width, height, rgba } = src;
    const n = width * height;
    let lum: Float32Array = new Float32Array(n);

    // Rec. 709 luma, then gamma — or, for a separation, this layer's ink.
    const invGamma = 1 / Math.max(0.01, f.gamma);
    const ink = f.channel === 'ink' ? inkProjector(f) : null;
    // `flat` reads as tone 0 everywhere, which downstream means "fully inked":
    // an even field of dots, with lightness left entirely to the ink each one
    // takes. Grades still apply on top, so the layer stays adjustable.

    for (let i = 0; i < n; i++) {
      const r = rgba[i * 4] / 255;
      const g = rgba[i * 4 + 1] / 255;
      const b = rgba[i * 4 + 2] / 255;
      // `lum` is tone, where 0 is dark and gets the most ink. A separation
      // measures coverage, which runs the other way, so it is inverted here and
      // every downstream rule — tone range, size ramp, masks — keeps working
      // without knowing which kind of layer it is looking at.
      let v = f.channel === 'flat' ? 0
        : ink ? 1 - ink(r, g, b)
        : 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (f.gamma !== 1) v = Math.pow(v, invGamma);
      lum[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }

    // Blur comes *before* contrast and brightness, the way a compositing graph
    // would order defocus then grade. It matters most for a layer reading the
    // render beneath it: the input there is a field of hard dots, and grading it
    // before it has been smoothed into continuous tone leaves nothing to grade.
    if (f.blur > 0) lum = boxBlur(lum, width, height, f.blur * pixelScale);

    // Brightness offsets *before* contrast gains, so contrast can be centred on
    // whatever part of the range the image actually occupies. With the opposite
    // order, contrast always pivots on mid-grey, which is useless for input that
    // sits at one end — exactly the case for a layer reading sparse ink below it.
    const contrast = f.contrast >= 0 ? 1 + f.contrast * 3 : 1 + f.contrast;
    if (contrast !== 1 || f.brightness !== 0) {
      for (let i = 0; i < n; i++) {
        const v = (lum[i] + f.brightness - 0.5) * contrast + 0.5;
        lum[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }

    if (f.sharpen > 0) lum = unsharp(lum, width, height, f.sharpen, pixelScale);
    if (f.invert) for (let i = 0; i < n; i++) lum[i] = 1 - lum[i];

    return new DensityMap(width, height, lum, rgba);
  }

  /** Bilinear luminance lookup in pixel coordinates. */
  sample(x: number, y: number): number {
    const { width: w, height: h, lum } = this;
    const fx = Math.min(Math.max(x, 0), w - 1);
    const fy = Math.min(Math.max(y, 0), h - 1);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0;
    const y1 = y0 + 1 < h ? y0 + 1 : y0;
    const tx = fx - x0;
    const ty = fy - y0;
    const a = lum[y0 * w + x0];
    const b = lum[y0 * w + x1];
    const c = lum[y1 * w + x0];
    const d = lum[y1 * w + x1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  /** Nearest-neighbour colour lookup, as 0..1 RGB. */
  sampleColor(x: number, y: number): [number, number, number] {
    const xi = Math.min(Math.max(x | 0, 0), this.width - 1);
    const yi = Math.min(Math.max(y | 0, 0), this.height - 1);
    const i = (yi * this.width + xi) * 4;
    return [this.rgba[i] / 255, this.rgba[i + 1] / 255, this.rgba[i + 2] / 255];
  }

  /**
   * Average luminance over a box of `radius` px, via the mip chain.
   *
   * Halftone cells need the mean tone across the whole cell, not a point sample;
   * point sampling a 40lpi screen produces visible aliasing on fine detail.
   */
  sampleArea(x: number, y: number, radius: number): number {
    if (radius <= 1) return this.sample(x, y);
    this.buildMips();
    const level = Math.min(this.mips.length - 1, Math.max(0, Math.log2(radius)));
    const lo = this.mips[Math.floor(level)];
    const hi = this.mips[Math.min(this.mips.length - 1, Math.ceil(level))];
    const t = level - Math.floor(level);
    const a = bilinear(lo.data, lo.w, lo.h, (x / this.width) * lo.w, (y / this.height) * lo.h);
    const b = bilinear(hi.data, hi.w, hi.h, (x / this.width) * hi.w, (y / this.height) * hi.h);
    return a + (b - a) * t;
  }

  /** Luminance gradient direction in radians, for contour-following shapes. */
  gradientAt(x: number, y: number): number {
    if (!this.gradient) this.buildGradient();
    const xi = Math.min(Math.max(x | 0, 0), this.width - 1);
    const yi = Math.min(Math.max(y | 0, 0), this.height - 1);
    return this.gradient![yi * this.width + xi];
  }

  private buildGradient(): void {
    const { width: w, height: h, lum } = this;
    const g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const yUp = y > 0 ? y - 1 : y;
      const yDn = y < h - 1 ? y + 1 : y;
      for (let x = 0; x < w; x++) {
        const xL = x > 0 ? x - 1 : x;
        const xR = x < w - 1 ? x + 1 : x;
        // Sobel
        const gx =
          -lum[yUp * w + xL] + lum[yUp * w + xR] +
          -2 * lum[y * w + xL] + 2 * lum[y * w + xR] +
          -lum[yDn * w + xL] + lum[yDn * w + xR];
        const gy =
          -lum[yUp * w + xL] - 2 * lum[yUp * w + x] - lum[yUp * w + xR] +
          lum[yDn * w + xL] + 2 * lum[yDn * w + x] + lum[yDn * w + xR];
        g[y * w + x] = Math.atan2(gy, gx);
      }
    }
    this.gradient = g;
  }

  private buildMips(): void {
    if (this.mips.length) return;
    this.mips.push({ data: this.lum, w: this.width, h: this.height });
    let cur = this.mips[0];
    while (cur.w > 2 && cur.h > 2) {
      const w = Math.max(1, cur.w >> 1);
      const h = Math.max(1, cur.h >> 1);
      const data = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const x0 = Math.min(x * 2, cur.w - 1);
          const x1 = Math.min(x * 2 + 1, cur.w - 1);
          const y0 = Math.min(y * 2, cur.h - 1);
          const y1 = Math.min(y * 2 + 1, cur.h - 1);
          data[y * w + x] = 0.25 * (
            cur.data[y0 * cur.w + x0] + cur.data[y0 * cur.w + x1] +
            cur.data[y1 * cur.w + x0] + cur.data[y1 * cur.w + x1]
          );
        }
      }
      cur = { data, w, h };
      this.mips.push(cur);
    }
  }

  /**
   * Inverse-transform sampling tables over a weight function.
   *
   * Voronoi seeding needs points drawn *proportional to ink*, not uniformly —
   * seeding uniformly wastes most of the relaxation budget just migrating points
   * out of the highlights.
   */
  buildCDF(weight: (lum: number) => number): { rows: Float32Array; total: Float32Array } {
    const { width: w, height: h, lum } = this;
    const rows = new Float32Array(w * h);
    const total = new Float32Array(h);
    let running = 0;
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += weight(lum[y * w + x]);
        rows[y * w + x] = rowSum;
      }
      running += rowSum;
      total[y] = running;
    }
    return { rows, total };
  }
}

/**
 * How much of one ink a pixel asks for, in 0..1.
 *
 * Ink is subtractive, so work in absorption: `a = 1 - pixel` is what the pixel
 * takes out of white, `b = 1 - ink` is what one unit of this ink takes out. The
 * answer is the most of this ink that overshoots no channel —
 * `min(a_c / b_c)` over the channels this ink actually touches.
 *
 * The tempting alternative, projecting a onto b, is wrong in exactly the case
 * that matters: it reads a saturated red as 68% black, because it measures total
 * absorption rather than the part this one ink can account for. Every plate then
 * fires everywhere and the print comes out mud.
 *
 * Channels the ink cannot affect (b ~ 0, as green and blue are for cyan) impose
 * no limit — another plate covers those.
 *
 * `undercolor` then removes the neutral part of the answer, because a grey is
 * cheaper and cleaner to print with one black plate than by stacking three
 * chromatic inks on top of each other.
 */
function inkProjector(f: Prefilter): (r: number, g: number, b: number) => number {
  const ink = f.ink ?? [0, 0, 0, 1];
  const b0 = 1 - ink[0];
  const b1 = 1 - ink[1];
  const b2 = 1 - ink[2];
  const peak = Math.max(b0, b1, b2);
  // A pure white ink absorbs nothing and can carry no image.
  if (peak < 1e-6) return () => 0;
  const gcr = f.undercolor ?? 0;

  return (r, g, b) => {
    const a0 = 1 - r;
    const a1 = 1 - g;
    const a2 = 1 - b;
    let t = Infinity;
    if (b0 > 1e-6) t = Math.min(t, a0 / b0);
    if (b1 > 1e-6) t = Math.min(t, a1 / b1);
    if (b2 > 1e-6) t = Math.min(t, a2 / b2);
    // The neutral component, expressed as a quantity of *this* ink.
    const grey = Math.min(a0, a1, a2) / peak;
    const v = t - gcr * grey;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
}

function bilinear(data: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(Math.max(x, 0), w - 1);
  const fy = Math.min(Math.max(y, 0), h - 1);
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = data[y0 * w + x0];
  const b = data[y0 * w + x1];
  const c = data[y1 * w + x0];
  const d = data[y1 * w + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Three box passes approximate a gaussian closely enough and stay O(n). */
function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const a = new Float32Array(src.length);
  a.set(src);
  const b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  return a;
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = src[row] * (r + 1);
    for (let i = 1; i <= r; i++) sum += src[row + Math.min(i, w - 1)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * norm;
      sum += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (r * 2 + 1);
  for (let x = 0; x < w; x++) {
    let sum = src[x] * (r + 1);
    for (let i = 1; i <= r; i++) sum += src[Math.min(i, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * norm;
      sum += src[Math.min(y + r + 1, h - 1) * w + x] - src[Math.max(y - r, 0) * w + x];
    }
  }
}

/**
 * Unsharp mask.
 *
 * `amount` is strength and stays as the user set it; `pixelScale` widens the
 * radius instead, because the halo is the spatial part and spatial filters are
 * specified in canvas pixels. Scaling the strength by it, as this used to,
 * sharpened a 4000px photo on a 1024px canvas four times as hard as the slider
 * said while leaving the halo two pixels wide.
 */
function unsharp(
  src: Float32Array,
  w: number,
  h: number,
  amount: number,
  pixelScale: number,
): Float32Array {
  const blurred = boxBlur(src, w, h, 2 * pixelScale);
  const out = new Float32Array(src.length);
  const k = amount * 2;
  for (let i = 0; i < src.length; i++) {
    const v = src[i] + (src[i] - blurred[i]) * k;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}
