import { describe, expect, it } from 'vitest';
import { defaultProject, normaliseProject } from '../src/core/defaults';
import { resolveLayer, unitPx } from '../src/core/scale';
import { generateJittered } from '../src/dist/jittered';
import { DensityMap } from '../src/image/density';
import type { GenContext } from '../src/dist/types';
import { defaultMask } from '../src/core/defaults';
import type { JitteredParams, Project } from '../src/core/types';

/**
 * Scale independence.
 *
 * Every layer length is stored as a fraction of the document's short edge, and
 * the stochastic screen's density as a count across it, precisely so that the
 * same project draws the same picture whatever size the document is. Nothing in
 * the types can enforce that — a fraction and a pixel count are both `number` —
 * so it is asserted here, at the two places the conversion happens.
 */

/** A vertical ramp at whatever resolution is asked for. */
function ramp(w: number, h: number): DensityMap {
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

function ctx(map: DensityMap, width: number, height: number): GenContext {
  return {
    density: map,
    width,
    height,
    unit: Math.min(width, height),
    mask: defaultMask(),
    quality: 1,
    maxPoints: 4_000_000,
  };
}

describe('unitPx', () => {
  it('is the short edge, whichever way up the document is', () => {
    expect(unitPx({ width: 1600, height: 900 } as never)).toBe(900);
    expect(unitPx({ width: 900, height: 1600 } as never)).toBe(900);
  });
});

describe('resolveLayer', () => {
  it('multiplies every length out to canvas pixels and leaves the rest alone', () => {
    const layer = defaultProject().layers[0];
    layer.size = { ...layer.size, min: 0.001, max: 0.01 };
    layer.prefilter = { ...layer.prefilter, blur: 0.02 };
    layer.transform = { ...layer.transform, offsetX: -0.25, offsetY: 0.5, rotate: 30 };

    const px = resolveLayer(layer, 2000);
    expect(px.size.min).toBe(2);
    expect(px.size.max).toBe(20);
    expect(px.prefilter.blur).toBe(40);
    expect(px.transform.offsetX).toBe(-500);
    expect(px.transform.offsetY).toBe(1000);
    // Angles, flips and everything non-spatial are not lengths.
    expect(px.transform.rotate).toBe(30);
    expect(px.size.fromTone).toBe(layer.size.fromTone);
  });

  it('does not mutate the layer it was given', () => {
    const layer = defaultProject().layers[0];
    const before = JSON.stringify(layer);
    resolveLayer(layer, 4000);
    expect(JSON.stringify(layer)).toBe(before);
  });
});

describe('a stochastic screen at two document sizes', () => {
  const p = { ...defaultProject().layers[0].distribution, density: 64 } as JitteredParams;

  it('draws the same picture, only bigger', () => {
    const small = generateJittered(p, ctx(ramp(128, 128), 256, 256));
    const large = generateJittered(p, ctx(ramp(128, 128), 2048, 2048));

    // Eight times the canvas, the same grid: the count is set by the picture,
    // not by how many pixels it happens to be stored in.
    expect(large.count).toBe(small.count);
    // And the marks land in the same *places*, proportionally.
    expect(large.data[0] / 2048).toBeCloseTo(small.data[0] / 256, 5);
    expect(large.data[1] / 2048).toBeCloseTo(small.data[1] / 256, 5);
  });

  it('is no longer capped by the canvas pixel grid', () => {
    // Two candidate sites per canvas pixel — which the old half-a-pixel floor
    // made impossible, and which is perfectly reasonable when the output is a
    // vector file that has no pixel grid at all.
    const dense = { ...p, density: 512 } as JitteredParams;
    const out = generateJittered(dense, ctx(ramp(128, 128), 256, 256));
    expect(out.count).toBeGreaterThan(256 * 256 * 0.2);
  });

  it('still stops at the point budget rather than walking a hopeless grid', () => {
    const absurd = { ...p, density: 100_000 } as JitteredParams;
    const out = generateJittered(absurd, ctx(ramp(64, 64), 512, 512));
    expect(out.count).toBeLessThanOrEqual(4_000_000);
  });
});

describe('normaliseProject', () => {
  /** A version 1 file: every length in canvas pixels, density as a spacing. */
  function legacy(): Project {
    const project = defaultProject(2000, 1000);
    const layer = project.layers[0];
    layer.size = { ...layer.size, min: 2, max: 8 };
    layer.prefilter = { ...layer.prefilter, blur: 10 };
    layer.transform = { ...layer.transform, offsetX: 250, offsetY: -100 };
    layer.distribution = { ...layer.distribution, spacing: 4 } as never;
    delete (layer.distribution as { density?: number }).density;
    project.version = 1;
    return project;
  }

  it('converts version 1 lengths against the short edge it was saved with', () => {
    const p = normaliseProject(legacy());
    const layer = p.layers[0];
    // Short edge is 1000, so a 8px mark is 0.8% of the picture.
    expect(layer.size.max).toBeCloseTo(0.008);
    expect(layer.size.min).toBeCloseTo(0.002);
    expect(layer.prefilter.blur).toBeCloseTo(0.01);
    expect(layer.transform.offsetX).toBeCloseTo(0.25);
    expect(layer.transform.offsetY).toBeCloseTo(-0.1);
    expect(p.version).toBe(2);
  });

  it('turns a spacing into a dot count across the picture', () => {
    const d = normaliseProject(legacy()).layers[0].distribution as JitteredParams;
    expect(d.density).toBeCloseTo(250); // 1000px short edge, 4px apart
    expect('spacing' in d).toBe(false);
  });

  it('leaves a version 2 file exactly as it is', () => {
    const p = defaultProject();
    const before = JSON.stringify(p);
    expect(JSON.stringify(normaliseProject(p))).toBe(before);
  });
});
