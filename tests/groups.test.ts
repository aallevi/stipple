import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nearestShare, oklab } from '../src/core/color';
import { defaultLayer, defaultProject } from '../src/core/defaults';
import { tidyGroups } from '../src/core/groups';
import { Store } from '../src/core/store';
import type { Layer, Project, RGBA } from '../src/core/types';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
  vi.stubGlobal('performance', { now: () => Date.now() });
});

/** A stack of named layers, bottom first, with `g` the group of those named in `members`. */
function stack(names: string[], members: string[] = []): Project {
  const p = defaultProject();
  p.layers = names.map((n) => ({ ...defaultLayer(n), id: n, name: n }) as Layer);
  p.groups = members.length ? [{ id: 'g', name: 'G', collapsed: false }] : [];
  for (const l of p.layers) if (members.includes(l.id)) l.groupId = 'g';
  return p;
}
const order = (s: Store): string => s.get().layers.map((l) => `${l.id}${l.groupId ? '*' : ''}`).join(' ');

describe('tidyGroups', () => {
  it('keeps the longest run of a split group and lets the strays go', () => {
    const p = stack(['a', 'b', 'c', 'd', 'e'], ['a', 'c', 'd']);
    tidyGroups(p);
    expect(p.layers.map((l) => l.groupId ?? '-').join('')).toBe('--gg-');
  });

  it('drops empty groups and memberships of groups that do not exist', () => {
    const p = stack(['a', 'b']);
    p.groups = [{ id: 'ghost', name: 'x', collapsed: false }];
    p.layers[0].groupId = 'missing';
    tidyGroups(p);
    expect(p.groups).toEqual([]);
    expect(p.layers[0].groupId).toBeUndefined();
  });
});

describe('moving layers and groups', () => {
  it('a layer dropped between two layers of a group joins it', () => {
    const s = new Store(stack(['a', 'g1', 'g2', 'z'], ['g1', 'g2']));
    s.moveLayer('z', 2); // between g1 and g2
    expect(order(s)).toBe('a g1* z* g2*');
  });

  it('a layer dragged out of a group leaves it', () => {
    const s = new Store(stack(['a', 'g1', 'g2', 'g3'], ['g1', 'g2', 'g3']));
    s.moveLayer('g2', 0);
    expect(order(s)).toBe('g2 a g1* g3*');
  });

  it('the slot under a folder row puts the layer in the group', () => {
    const s = new Store(stack(['g1', 'g2', 'z'], ['g1', 'g2']));
    s.moveLayer('z', 2, 'g'); // just above g2, explicitly into g
    expect(order(s)).toBe('g1* g2* z*');
  });

  it('moves a group as one block, and never into another group', () => {
    const p = stack(['a', 'g1', 'g2', 'b', 'h1', 'h2'], ['g1', 'g2']);
    p.groups!.push({ id: 'h', name: 'H', collapsed: false });
    p.layers[4].groupId = 'h';
    p.layers[5].groupId = 'h';
    const s = new Store(p);
    s.moveGroup('g', 5); // between h1 and h2: lands above h instead
    expect(s.get().layers.map((l) => l.id).join(' ')).toBe('a b h1 h2 g1 g2');
    s.nudgeGroup('g', -1); // one step down passes the whole of h
    expect(s.get().layers.map((l) => l.id).join(' ')).toBe('a b g1 g2 h1 h2');
  });

  it('undo brings a deleted group back with its layers', () => {
    const s = new Store(stack(['a', 'g1', 'g2'], ['g1', 'g2']));
    s.removeGroup('g');
    expect(order(s)).toBe('a');
    s.undo();
    expect(order(s)).toBe('a g1* g2*');
    expect(s.get().groups?.map((g) => g.id)).toEqual(['g']);
  });
});

describe('editing a group', () => {
  it('reaches every layer in scope and no other, sparing each layer its own ink', () => {
    const p = stack(['a', 'g1', 'g2'], ['g1', 'g2']);
    p.layers[1].color = { ...p.layers[1].color, color: [1, 0, 0, 1] };
    p.layers[2].color = { ...p.layers[2].color, color: [0, 0, 1, 1] };
    const s = new Store(p);
    s.scope = ['g1', 'g2'];
    s.editLayerField('g2', 'size', { max: 0.02 });
    s.editLayerField('g2', 'color', { color: [0, 1, 0, 1] });
    const [a, g1, g2] = s.get().layers;
    expect(g1.size.max).toBe(0.02);
    expect(g2.size.max).toBe(0.02);
    expect(a.size.max).not.toBe(0.02);
    expect(g1.color.color).toEqual([1, 0, 0, 1]); // colour is a layer's own
    expect(g2.color.color).toEqual([0, 1, 0, 1]);
  });

  it('is a single undo step', () => {
    const s = new Store(stack(['g1', 'g2', 'g3'], ['g1', 'g2', 'g3']));
    s.scope = ['g1', 'g2', 'g3'];
    s.editLayerField('g1', 'size', { max: 0.03 });
    s.undo();
    expect(s.get().layers.every((l) => l.size.max !== 0.03)).toBe(true);
  });
});

describe('nearestShare — the closest-colour measure', () => {
  const lab = (c: RGBA): [number, number, number] => oklab(c[0], c[1], c[2]);
  const inks: RGBA[] = [[0.32, 0.18, 0.11, 1], [0.66, 0.45, 0.28, 1], [0.89, 0.72, 0.35, 1], [0.8, 0.1, 0.1, 1]];
  const set = inks.map(lab);
  const paper = lab([1, 1, 1, 1]);
  const pixels: [number, number, number][] = [];
  for (let r = 0; r <= 1; r += 0.125) for (let g = 0; g <= 1; g += 0.125) for (let b = 0; b <= 1; b += 0.125) pixels.push(oklab(r, g, b));

  it('with hard borders, every pixel belongs to exactly one colour or to the paper', () => {
    for (const px of pixels) {
      const shares = set.map((_, i) => nearestShare(px, set, i, paper, 0, false));
      const total = shares.reduce((a, b) => a + b, 0);
      expect(total === 0 || total === 1).toBe(true);
      expect(shares.every((v) => v === 0 || v === 1)).toBe(true);
    }
  });

  it('with soft borders, the colours and the paper still share each pixel exactly once', () => {
    for (const px of pixels) {
      const shares = set.map((_, i) => nearestShare(px, set, i, paper, 0.6, false));
      const paperShare = 1 - shares.reduce((a, b) => a + b, 0);
      expect(paperShare).toBeGreaterThanOrEqual(-1e-9);
      expect(paperShare).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('gives a small, distinct colour its own region even among large similar ones', () => {
    // A red detail in an earthy picture: the red layer must own red pixels.
    expect(nearestShare(lab([0.78, 0.12, 0.1, 1]), set, 3, paper, 0, false)).toBe(1);
    expect(nearestShare(lab([0.78, 0.12, 0.1, 1]), set, 0, paper, 0, false)).toBe(0);
  });

  it('following the darkness gives a lighter pixel of the same colour fewer dots', () => {
    const dark = nearestShare(lab([0.6, 0.42, 0.26, 1]), set, 1, null, 0, true);
    const light = nearestShare(lab([0.75, 0.55, 0.38, 1]), set, 1, null, 0, true);
    expect(dark).toBeGreaterThan(light);
  });
});

describe('bandShare — tone ranges', () => {
  it('adjacent ranges share every lightness exactly once, hard or soft', async () => {
    const { bandShare } = await import('../src/core/color');
    const bands: [number, number][] = [[0, 0.3], [0.3, 0.62], [0.62, 0.9]];
    for (const mix of [0, 0.4, 1]) {
      for (let L = 0; L <= 0.85; L += 0.01) {
        const total = bands.reduce((a, [lo, hi]) => a + bandShare(L, lo, hi, mix), 0);
        expect(total).toBeCloseTo(1, 6);
      }
    }
    // Above the last range is the paper's: nothing prints.
    expect(bands.reduce((a, [lo, hi]) => a + bandShare(0.97, lo, hi, 0), 0)).toBe(0);
  });
});
