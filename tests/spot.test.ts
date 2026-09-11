import { describe, expect, it } from 'vitest';
import { assignInk, buildInkSet, extractPalette, oklab, spotHash, srgbToLinear } from '../src/core/color';
import { defaultColor, defaultLayer, defaultProject, normaliseProject } from '../src/core/defaults';
import { collectPlates, inkName } from '../src/export/plates';
import type { RGBA } from '../src/core/types';

const RED: RGBA = [1, 0, 0, 1];
const BLUE: RGBA = [0, 0, 1, 1];
const WHITE: RGBA = [1, 1, 1, 1];
const BLACK: RGBA = [0, 0, 0, 1];

/** The share of dots that took each ink, over a spread of stable randoms. */
function shares(set: ReturnType<typeof buildInkSet>, rgb: RGBA, mixing: number, n = 4000): number[] {
  const out = new Array(set.count).fill(0);
  for (let i = 0; i < n; i++) {
    out[assignInk(set, rgb[0], rgb[1], rgb[2], mixing, (i + 0.5) / n)] += 1 / n;
  }
  return out;
}

describe('spot ink assignment', () => {
  it('takes the nearest ink and nothing else when mixing is off', () => {
    const set = buildInkSet([RED, BLUE], null);
    const red = shares(set, [0.9, 0.1, 0.1, 1], 0);
    expect(red[0]).toBeCloseTo(1, 6);
    expect(red[1]).toBe(0);
    const blue = shares(set, [0.1, 0.1, 0.9, 1], 0);
    expect(blue[1]).toBeCloseTo(1, 6);
    expect(blue[0]).toBe(0);
  });

  it('posterises a colour that lies between two inks', () => {
    // Purple is genuinely between red and blue; with no mixing every dot still
    // has to commit to one of them, which is what makes a flat poster.
    const set = buildInkSet([RED, BLUE], null);
    const s = shares(set, [0.5, 0, 0.5, 1], 0);
    expect(Math.max(...s)).toBeCloseTo(1, 6);
  });

  it('splits the dots between two inks when mixing is on', () => {
    const set = buildInkSet([RED, BLUE], null);
    const s = shares(set, [0.5, 0, 0.5, 1], 1);
    expect(s[0]).toBeGreaterThan(0.2);
    expect(s[1]).toBeGreaterThan(0.2);
  });

  it('mixes in linear light, so a half-grey is half the dots', () => {
    // The whole reason the fraction is solved in linear RGB rather than Oklab:
    // 50% reflectance is 50% of the dots, not the 12.5% an Oklab midpoint gives.
    const set = buildInkSet([BLACK, WHITE], null);
    // Mid-grey in sRGB is only ~0.21 of the light, which is exactly the trap:
    // solving the fraction perceptually would lay down twice the black it should.
    expect(srgbToLinear(0.5)).toBeGreaterThan(0.2);
    expect(srgbToLinear(0.5)).toBeLessThan(0.25);
    // A pixel whose *linear* value is 0.5 should come out as half white dots.
    const half = 1.055 * Math.pow(0.5, 1 / 2.4) - 0.055;
    const s = shares(set, [half, half, half, 1], 1);
    expect(s[1]).toBeGreaterThan(0.42);
    expect(s[1]).toBeLessThan(0.58);
  });

  it('never strays further than mixing allows', () => {
    const set = buildInkSet([RED, BLUE], null);
    const full = shares(set, [0.5, 0, 0.5, 1], 1);
    const half = shares(set, [0.5, 0, 0.5, 1], 0.5);
    const minor = full[0] < full[1] ? 0 : 1;
    expect(half[minor]).toBeLessThan(full[minor]);
    expect(half[minor]).toBeGreaterThan(0);
  });

  it('sends highlights to paper, which is past the last ink', () => {
    const set = buildInkSet([RED, BLUE], WHITE);
    expect(set.inkCount).toBe(2);
    expect(set.count).toBe(3);
    const idx = assignInk(set, 0.99, 0.99, 0.99, 0, 0.5);
    expect(idx).toBeGreaterThanOrEqual(set.inkCount);
  });

  it('prints every dot when there is no paper', () => {
    const set = buildInkSet([RED, BLUE], null);
    for (let i = 0; i < 200; i++) {
      expect(assignInk(set, 0.99, 0.99, 0.99, 1, i / 200)).toBeLessThan(set.inkCount);
    }
  });

  it('survives a one-ink palette and duplicated inks', () => {
    expect(assignInk(buildInkSet([BLACK], null), 0.5, 0.5, 0.5, 1, 0.3)).toBe(0);
    // Two coincident inks define no line to mix along; the search must skip the
    // pair rather than divide by a zero-length segment.
    const dup = buildInkSet([RED, RED], null);
    const idx = assignInk(dup, 0.2, 0.7, 0.3, 1, 0.77);
    expect(Number.isInteger(idx)).toBe(true);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(2);
  });

  it('caps the palette at the shader s limit', () => {
    const many: RGBA[] = Array.from({ length: 12 }, (_, i) => [i / 12, 0.4, 0.6, 1]);
    const set = buildInkSet(many, WHITE);
    expect(set.inkCount).toBe(8);
    expect(set.count).toBe(9);
  });
});

describe('spot hash', () => {
  it('stays inside 0..1 and spreads evenly', () => {
    let sum = 0;
    let below = 0;
    for (let i = 0; i < 5000; i++) {
      const v = spotHash(i / 5000);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
      if (v < 0.5) below += 1;
    }
    expect(sum / 5000).toBeGreaterThan(0.46);
    expect(sum / 5000).toBeLessThan(0.54);
    expect(below / 5000).toBeGreaterThan(0.46);
    expect(below / 5000).toBeLessThan(0.54);
  });

  it('is decorrelated from the size jitter, which keys off the same random', () => {
    // Sharing a stream would tie ink choice to dot size and put a texture in the
    // separation that is not in the image.
    let agree = 0;
    for (let i = 0; i < 4000; i++) {
      const r = (i + 0.5) / 4000;
      const jitter = (r * 7919.13) - Math.floor(r * 7919.13);
      if ((spotHash(r) < 0.5) === (jitter < 0.5)) agree += 1;
    }
    expect(Math.abs(agree / 4000 - 0.5)).toBeLessThan(0.05);
  });
});

describe('palette extraction', () => {
  const image = (colors: [number, number, number][]): { width: number; height: number; rgba: Uint8ClampedArray } => {
    const w = colors.length * 10;
    const rgba = new Uint8ClampedArray(w * 10 * 4);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < w; x++) {
        const c = colors[Math.floor(x / 10)];
        const o = (y * w + x) * 4;
        rgba[o] = c[0] * 255; rgba[o + 1] = c[1] * 255; rgba[o + 2] = c[2] * 255; rgba[o + 3] = 255;
      }
    }
    return { width: w, height: 10, rgba };
  };

  it('finds the colours the picture is made of', () => {
    const src = image([[1, 0, 0], [0, 0.6, 0], [0.1, 0.2, 0.9]]);
    const found = extractPalette(src, 3, null);
    expect(found).toHaveLength(3);
    for (const target of [[1, 0, 0], [0, 0.6, 0], [0.1, 0.2, 0.9]]) {
      const [tl, ta, tb] = oklab(target[0], target[1], target[2]);
      const near = found.some((c) => {
        const [l, a, b] = oklab(c[0], c[1], c[2]);
        return (tl - l) ** 2 + (ta - a) ** 2 + (tb - b) ** 2 < 0.01;
      });
      expect(near).toBe(true);
    }
  });

  it('is reproducible, so an ink does not move when you ask again', () => {
    const src = image([[0.8, 0.2, 0.1], [0.1, 0.3, 0.7], [0.9, 0.85, 0.2]]);
    expect(extractPalette(src, 3, null)).toEqual(extractPalette(src, 3, null));
  });

  it('does not spend a screen on the paper', () => {
    // Three quarters of this image is white. Clustering it naively burns an ink
    // on the background, which the stock already provides for nothing.
    const src = image([[1, 1, 1], [1, 1, 1], [1, 1, 1], [0.85, 0.1, 0.1]]);
    const found = extractPalette(src, 2, WHITE);
    for (const c of found) {
      expect(Math.min(c[0], c[1], c[2])).toBeLessThan(0.9);
    }
  });
});

describe('plate collection', () => {
  it('names an ink from its colour, so films cannot be taped to the wrong screen', () => {
    expect(inkName([0.9, 0.1, 0.1, 1])).toBe('red');
    expect(inkName([0.0, 0.67, 0.93, 1])).toBe('cyan');
    expect(inkName([0.93, 0.0, 0.55, 1])).toBe('magenta');
    expect(inkName([0.32, 0.18, 0.11, 1])).toBe('brown');
    expect(inkName([0.08, 0.08, 0.08, 1])).toBe('black');
    expect(inkName([1, 1, 1, 1])).toBe('white');
  });

  it('takes its plates from a spot layer s palette', () => {
    const project = defaultProject(64, 64);
    project.layers[0].color = {
      ...project.layers[0].color,
      mode: 'spot',
      palette: [[0.9, 0.1, 0.1, 1], [0.1, 0.2, 0.8, 1]],
      paper: [1, 1, 1, 1],
    };
    const set = collectPlates(project);
    expect(set.plates.map((p) => p.name)).toEqual(['red', 'blue']);
    // Paper is not a plate: there is no screen for bare stock.
    expect(set.plates).toHaveLength(2);
    expect(set.route(project.layers[0])).toBe('per-point');
  });

  it('treats a stack of solid layers as one plate each', () => {
    const project = defaultProject(64, 64);
    const cyan = { ...defaultLayer('Cyan'), color: { ...defaultColor(), mode: 'solid' as const, color: [0, 0.67, 0.93, 1] as RGBA } };
    const black = { ...defaultLayer('Black'), color: { ...defaultColor(), mode: 'solid' as const, color: [0.08, 0.08, 0.08, 1] as RGBA } };
    project.layers = [cyan, black];
    const set = collectPlates(project);
    expect(set.plates.map((p) => p.name)).toEqual(['Cyan', 'Black']);
    expect(set.route(cyan)).toBe(0);
    expect(set.route(black)).toBe(1);
  });

  it('leaves out a layer that is not one ink, and says why', () => {
    const project = defaultProject(64, 64);
    project.layers = [{ ...defaultLayer('Photo'), color: { ...defaultColor(), mode: 'image' as const } }];
    const set = collectPlates(project);
    expect(set.plates).toHaveLength(0);
    expect(set.warnings.join(' ')).toContain('sampled from the image');
  });
});

describe('loading an older project', () => {
  it('fills in fields that would otherwise reach a shader as NaN', () => {
    // Spot mode postdates version 1, so these arrive undefined from disk. A NaN
    // uniform fails silently — every comparison against it is false — so the
    // feature would just quietly stop dithering.
    const project = defaultProject(64, 64);
    const colour = project.layers[0].color as Record<string, unknown>;
    delete colour.mixing;
    delete colour.paper;
    const fixed = normaliseProject(project);
    expect(Number.isFinite(fixed.layers[0].color.mixing)).toBe(true);
    expect(fixed.layers[0].color.paper).toBeNull();
  });
});
