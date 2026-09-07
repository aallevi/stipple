import { describe, expect, it } from 'vitest';
import { defaultLayer, BUILTIN_SHAPES } from '../src/core/defaults';
import { evaluatePoint, shapeGeometry } from '../src/export/geometry';
import type { Layer } from '../src/core/types';

/**
 * `evaluatePoint` is the CPU mirror of the point vertex shader; if the two drift,
 * vector exports stop matching the preview. These lock down the rules the shader
 * implements so a change on one side fails loudly here.
 */

function layerWith(patch: Partial<Layer>): Layer {
  return { ...defaultLayer('t'), ...patch };
}

describe('evaluatePoint size mapping', () => {
  it('maps dark tones to the max size and light tones to the min', () => {
    const layer = layerWith({ size: { min: 1, max: 10, fromTone: 1, invert: false, jitter: 0 } });
    expect(evaluatePoint(layer, 0, 0, 0, 0, 0.5).size).toBeCloseTo(10); // black
    expect(evaluatePoint(layer, 0, 0, 1, 0, 0.5).size).toBeCloseTo(1);  // white
    expect(evaluatePoint(layer, 0, 0, 0.5, 0, 0.5).size).toBeCloseTo(5.5);
  });

  it('holds every point at the max size when fromTone is 0', () => {
    const layer = layerWith({ size: { min: 1, max: 10, fromTone: 0, invert: false, jitter: 0 } });
    for (const tone of [0, 0.3, 1]) {
      expect(evaluatePoint(layer, 0, 0, tone, 0, 0.5).size).toBeCloseTo(10);
    }
  });

  it('flips the mapping when inverted', () => {
    const layer = layerWith({ size: { min: 1, max: 10, fromTone: 1, invert: true, jitter: 0 } });
    expect(evaluatePoint(layer, 0, 0, 0, 0, 0.5).size).toBeCloseTo(1);
    expect(evaluatePoint(layer, 0, 0, 1, 0, 0.5).size).toBeCloseTo(10);
  });

  it('never returns a negative size, even with heavy jitter', () => {
    const layer = layerWith({ size: { min: 0, max: 1, fromTone: 1, invert: false, jitter: 1 } });
    for (let i = 0; i < 200; i++) {
      expect(evaluatePoint(layer, 0, 0, i / 200, 0, i / 200).size).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('evaluatePoint rotation', () => {
  it('aligns to the contour, perpendicular to the gradient', () => {
    const layer = layerWith({ rotation: { base: 0, random: 0, followGradient: 1 } });
    expect(evaluatePoint(layer, 0, 0, 0.5, 0, 0).rotation).toBeCloseTo(Math.PI / 2);
  });

  it('adds the base rotation in radians', () => {
    const layer = layerWith({ rotation: { base: 90, random: 0, followGradient: 0 } });
    expect(evaluatePoint(layer, 0, 0, 0.5, 1.2, 0.3).rotation).toBeCloseTo(Math.PI / 2);
  });
});

describe('evaluatePoint colour', () => {
  it('returns the solid colour untouched when jitter is off', () => {
    const layer = layerWith({});
    layer.color = { ...layer.color, mode: 'solid', color: [0.2, 0.4, 0.6, 1], jitter: 0 };
    expect(evaluatePoint(layer, 0, 0, 0.5, 0, 0.5).rgb).toEqual([0.2, 0.4, 0.6]);
  });

  it('picks deterministically from the palette in multicolour mode', () => {
    const layer = layerWith({});
    layer.color = { ...layer.color, mode: 'multicolor', jitter: 0 };
    const a = evaluatePoint(layer, 0, 0, 0.5, 0, 0.1).rgb;
    const b = evaluatePoint(layer, 0, 0, 0.5, 0, 0.1).rgb;
    const c = evaluatePoint(layer, 0, 0, 0.5, 0, 0.9).rgb;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('uses the supplied image sampler in image mode', () => {
    // Vector export has no texture to sample, so it passes a CPU sampler. If the
    // sampler is ignored the layer silently exports as flat colour.
    const layer = layerWith({});
    layer.color = { ...layer.color, mode: 'image', jitter: 0 };
    const sampler = (x: number, y: number): [number, number, number] => [x / 100, y / 100, 0.5];
    expect(evaluatePoint(layer, 40, 80, 0.5, 0, 0.5, sampler).rgb).toEqual([0.4, 0.8, 0.5]);
  });

  it('falls back to the solid colour when no sampler is available', () => {
    const layer = layerWith({});
    layer.color = { ...layer.color, mode: 'image', color: [0.1, 0.2, 0.3, 1], jitter: 0 };
    expect(evaluatePoint(layer, 40, 80, 0.5, 0, 0.5).rgb).toEqual([0.1, 0.2, 0.3]);
  });

  it('keeps jittered colour inside 0..1', () => {
    const layer = layerWith({});
    layer.color = { ...layer.color, mode: 'solid', color: [1, 1, 1, 1], jitter: 1 };
    for (let i = 0; i < 100; i++) {
      for (const ch of evaluatePoint(layer, 0, 0, 0.5, 0, i / 100).rgb) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('shapeGeometry', () => {
  it('gives every built-in shape drawable vector geometry', () => {
    for (const def of BUILTIN_SHAPES) {
      const g = shapeGeometry(def);
      if (g.kind === 'circle') expect(g.r).toBeGreaterThan(0);
      else if (g.kind === 'fill' || g.kind === 'stroke') expect(g.d.length).toBeGreaterThan(4);
      else throw new Error(`unexpected geometry for ${def.id}`);
    }
  });

  it('keeps geometry inside the unit box so instances scale predictably', () => {
    for (const def of BUILTIN_SHAPES) {
      const g = shapeGeometry(def);
      if (g.kind === 'circle') {
        expect(g.r).toBeLessThanOrEqual(0.5);
        continue;
      }
      if (g.kind === 'image') continue;
      const coords = (g.d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
      for (const c of coords) expect(Math.abs(c)).toBeLessThanOrEqual(0.5001);
    }
  });

  it('recentres an imported SVG from its 0..1 box onto the origin', () => {
    const g = shapeGeometry({
      kind: 'svg', id: 's', name: 's',
      paths: ['M0,0L1,0L1,1L0,1Z'],
      viewBox: [0, 0, 1, 1],
      fillRule: 'nonzero',
    });
    expect(g.kind).toBe('fill');
    const coords = (('d' in g ? g.d : '').match(/-?\d*\.?\d+/g) ?? []).map(Number);
    // The unit square becomes symmetric about the origin, inset by the atlas pad.
    expect(Math.min(...coords)).toBeCloseTo(-0.42, 2);
    expect(Math.max(...coords)).toBeCloseTo(0.42, 2);
  });
});

describe('path simplification', () => {
  it('keeps the shape of a closed ring', async () => {
    const { simplify } = await import('../src/shape/import');
    // A circle sampled densely. Because it is closed, the first and last points
    // coincide — the case that collapses a naive Ramer-Douglas-Peucker to two
    // points, since the initial chord has zero length.
    const ring: [number, number][] = [];
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * Math.PI * 2;
      ring.push([Math.cos(t) * 0.4, Math.sin(t) * 0.4]);
    }
    const out = simplify(ring, 0.0015);
    expect(out.length).toBeGreaterThan(20);
    expect(out.length).toBeLessThan(ring.length);

    // Every kept point must still lie on the circle.
    for (const [x, y] of out) expect(Math.hypot(x, y)).toBeCloseTo(0.4, 3);
  });

  it('reduces a straight line to its endpoints', async () => {
    const { simplify } = await import('../src/shape/import');
    const line: [number, number][] = [];
    for (let i = 0; i <= 50; i++) line.push([i / 50, i / 50]);
    expect(simplify(line, 0.001)).toEqual([[0, 0], [1, 1]]);
  });
});
