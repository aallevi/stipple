import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLayer, defaultProject } from '../src/core/defaults';
import { Dirty, Store, type Change } from '../src/core/store';
import type { ShapeDef } from '../src/core/types';

// The store batches notifications on an animation frame; run them synchronously
// so a test can assert on the change immediately after mutating.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
  vi.stubGlobal('performance', { now: () => Date.now() });
});

function capture(store: Store): () => Change | null {
  let last: Change | null = null;
  store.subscribe((_p, c) => { last = c; });
  return () => last;
}

describe('Store invalidation', () => {
  it('treats a colour edit as composite-only', () => {
    const store = new Store(defaultProject());
    const id = store.get().layers[0].id;
    const last = capture(store);
    store.updateLayerField(id, 'color', { alpha: 0.5 });
    expect(last()!.layers.get(id)).toBe(Dirty.Composite);
  });

  it('treats size and rotation as composite-only, since the shader derives them', () => {
    const store = new Store(defaultProject());
    const id = store.get().layers[0].id;
    const last = capture(store);
    store.updateLayerField(id, 'size', { max: 9 });
    expect(last()!.layers.get(id)).toBe(Dirty.Composite);
    store.updateLayerField(id, 'rotation', { random: 1 });
    expect(last()!.layers.get(id)).toBe(Dirty.Composite);
  });

  it('escalates a density change to a point regeneration', () => {
    const store = new Store(defaultProject());
    const id = store.get().layers[0].id;
    const last = capture(store);
    store.updateLayerField(id, 'distribution', { density: 90 } as never);
    expect(last()!.layers.get(id)).toBe(Dirty.Points);
  });

  it('escalates a prefilter change to a density rebuild', () => {
    const store = new Store(defaultProject());
    const id = store.get().layers[0].id;
    const last = capture(store);
    store.updateLayerField(id, 'prefilter', { contrast: 0.4 });
    expect(last()!.layers.get(id)).toBe(Dirty.Density);
  });

  it('cascades to layers above that read from below', () => {
    const store = new Store(defaultProject());
    const lower = store.get().layers[0].id;
    const upper = defaultLayer('Over');
    upper.input = 'below';
    store.addLayer(upper);
    const independent = defaultLayer('Independent'); // input: 'source'
    store.addLayer(independent);

    const last = capture(store);
    store.updateLayerField(lower, 'color', { alpha: 0.2 });

    // The colour edit is composite-only for its own layer, but anything sampling
    // the render beneath it now has a different image to sample.
    expect(last()!.layers.get(lower)).toBe(Dirty.Composite);
    expect(last()!.layers.get(upper.id)).toBe(Dirty.Density);
    expect(last()!.layers.has(independent.id)).toBe(false);
  });

  it('does not cascade downward', () => {
    const store = new Store(defaultProject());
    const lower = store.get().layers[0].id;
    const upper = defaultLayer('Over');
    store.addLayer(upper);
    const last = capture(store);
    store.updateLayerField(upper.id, 'distribution', { density: 340 } as never);
    expect(last()!.layers.has(lower)).toBe(false);
  });
});

describe('Store history', () => {
  it('undoes and redoes a value change', () => {
    const store = new Store(defaultProject());
    const id = store.get().layers[0].id;
    store.updateLayer(id, { name: 'Renamed' }, 'unique-1');
    expect(store.layer(id)!.name).toBe('Renamed');
    store.undo();
    expect(store.layer(id)!.name).toBe('Stipple 1');
    store.redo();
    expect(store.layer(id)!.name).toBe('Renamed');
  });

  it('coalesces a rapid run of edits into one undo step', () => {
    const store = new Store(defaultProject());
    const id = store.get().layers[0].id;
    // A slider drag: many updates under one history key inside the coalesce window.
    for (let i = 1; i <= 20; i++) store.updateLayerField(id, 'size', { max: i / 1000 });
    expect(store.layer(id)!.size.max).toBe(0.02);
    store.undo();
    expect(store.layer(id)!.size.max).toBe(0.004); // back to the default in one step
    expect(store.canUndo()).toBe(false);
  });

  it('keeps layer ordering through move and undo', () => {
    const store = new Store(defaultProject());
    const first = store.get().layers[0].id;
    const second = defaultLayer('Second');
    store.addLayer(second);
    store.moveLayer(second.id, 0);
    expect(store.get().layers.map((l) => l.id)).toEqual([second.id, first]);
    store.undo();
    expect(store.get().layers.map((l) => l.id)).toEqual([first, second.id]);
  });

  /**
   * `moveLayer` takes an insertion point in the list as it stands, not a
   * destination index. The two differ by one whenever the layer travels
   * upwards, because lifting it out shifts everything above it down — which is
   * exactly the off-by-one that makes a drag land one row short of the line the
   * panel drew.
   */
  describe('moveLayer insertion points', () => {
    const stack = (): { store: Store; ids: string[] } => {
      const store = new Store(defaultProject());
      const ids = [store.get().layers[0].id];
      for (const name of ['B', 'C', 'D']) {
        const l = defaultLayer(name);
        store.addLayer(l);
        ids.push(l.id);
      }
      return { store, ids };
    };
    const order = (store: Store): string[] => store.get().layers.map((l) => l.name);

    it('moves a layer up to the slot the drop line was drawn at', () => {
      const { store, ids } = stack();
      // A → above D, which in a four-layer stack is slot 4.
      store.moveLayer(ids[0], 4);
      expect(order(store)).toEqual(['B', 'C', 'D', 'Stipple 1']);
    });

    it('moves a layer down to the same slot, unadjusted', () => {
      const { store, ids } = stack();
      store.moveLayer(ids[3], 1);
      expect(order(store)).toEqual(['Stipple 1', 'D', 'B', 'C']);
    });

    it('treats a drop on either side of the layer itself as no move', () => {
      const { store, ids } = stack();
      const before = order(store);
      store.moveLayer(ids[1], 1);
      store.moveLayer(ids[1], 2);
      expect(order(store)).toEqual(before);
      // And neither one spent an undo step on doing nothing.
      expect(store.canUndo()).toBe(true);
      store.undo();
      store.undo();
      store.undo();
      expect(store.canUndo()).toBe(false);
    });

    it('clamps a slot past either end instead of dropping the layer', () => {
      const { store, ids } = stack();
      store.moveLayer(ids[2], 99);
      expect(order(store)).toEqual(['Stipple 1', 'B', 'D', 'C']);
      store.moveLayer(ids[2], -5);
      expect(order(store)).toEqual(['C', 'Stipple 1', 'B', 'D']);
    });
  });
});

describe('shape definitions', () => {
  it('patches one shape and leaves the rest identical', () => {
    const store = new Store(defaultProject());
    const before = store.get().shapes;
    const last = capture(store);

    store.updateShape('burst', { segments: 16, thickness: 0.35 });

    const after = store.get().shapes;
    const burst = after.find((s) => s.id === 'burst') as Extract<ShapeDef, { kind: 'line' }>;
    expect(burst.segments).toBe(16);
    expect(burst.thickness).toBeCloseTo(0.35);
    expect(last()!.shapes).toBe(true);
    // Every other definition must be untouched by identity, since the atlas
    // skips a rebuild only when the object it hashed is the same one.
    for (const s of after) {
      if (s.id !== 'burst') expect(s).toBe(before.find((b) => b.id === s.id));
    }
  });

  it('leaves a shape edit undoable', () => {
    const store = new Store(defaultProject());
    store.updateShape('star', { innerRadius: 0.2 });
    expect(shapeField(store, 'star', 'innerRadius')).toBeCloseTo(0.2);
    store.undo();
    expect(shapeField(store, 'star', 'innerRadius')).toBeCloseTo(0.45);
  });

  it('ignores a patch aimed at a shape that is not there', () => {
    const store = new Store(defaultProject());
    const before = store.get().shapes;
    store.updateShape('nope', { segments: 4 } as never);
    expect(store.get().shapes).toBe(before);
  });
});

function shapeField(store: Store, id: string, field: string): number {
  return (store.get().shapes.find((s) => s.id === id) as unknown as Record<string, number>)[field];
}

describe('project serialisation', () => {
  it('round-trips through JSON unchanged', () => {
    const store = new Store(defaultProject(800, 600));
    const id = store.get().layers[0].id;
    store.updateLayerField(id, 'color', { mode: 'multicolor' });
    store.updateLayerField(id, 'distribution', { density: 146 } as never);

    const json = JSON.stringify(store.get());
    const restored = JSON.parse(json);
    expect(restored).toEqual(JSON.parse(JSON.stringify(store.get())));
    expect(restored.layers[0].color.mode).toBe('multicolor');
    expect(restored.layers[0].distribution.density).toBe(146);
  });
});

describe('Store history', () => {
  const bigRaster = (id = 'r1'): Extract<ShapeDef, { kind: 'raster' }> => ({
    kind: 'raster',
    id,
    name: 'Stamp',
    // Stands in for a real imported PNG, which is what made snapshots heavy.
    data: `data:image/png;base64,${'A'.repeat(4096)}`,
    width: 8,
    height: 8,
  });

  it('does not spend an undo step on the display unit', () => {
    const store = new Store(defaultProject());
    expect(store.canUndo()).toBe(false);

    // The unit changes how lengths are written and nothing about the document.
    store.updateCanvas({ units: 'in' });
    expect(store.get().canvas.units).toBe('in');
    expect(store.canUndo()).toBe(false);

    // Anything that does change the document still does.
    store.updateCanvas({ dpi: 600 });
    expect(store.canUndo()).toBe(true);
  });

  it('carries a raster shape\'s pixels back through undo and redo', () => {
    const raster = bigRaster();
    const store = new Store(defaultProject());
    store.updateShapes([...store.get().shapes, raster]);
    store.updateCanvas({ dpi: 600 });

    const dataOf = (): string | undefined => {
      const s = store.get().shapes.find((x) => x.id === raster.id);
      return s?.kind === 'raster' ? s.data : undefined;
    };
    expect(dataOf()).toBe(raster.data);

    // Snapshots hold a reference rather than the base64 itself, so the round
    // trip has to put the real pixels back or the stamp renders as nothing.
    store.undo();
    expect(store.get().canvas.dpi).toBe(300);
    expect(dataOf()).toBe(raster.data);

    store.redo();
    expect(store.get().canvas.dpi).toBe(600);
    expect(dataOf()).toBe(raster.data);

    // And back past the import, where the shape should be gone entirely.
    store.undo();
    store.undo();
    expect(store.get().shapes.some((x) => x.id === raster.id)).toBe(false);
  });
});

describe('several layers at once', () => {
  const stack = (): Store => {
    const p = defaultProject();
    p.layers = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ ...defaultLayer(n), id: n }));
    return new Store(p);
  };
  const names = (s: Store): string => s.get().layers.map((l) => l.id + (l.groupId ? '*' : '')).join('');

  it('groups scattered layers under the topmost one, in one undo step', () => {
    const s = stack();
    s.groupLayers(['a', 'c', 'e'], { id: 'g', name: 'G', collapsed: false });
    expect(names(s)).toBe('bda*c*e*');
    s.undo();
    expect(names(s)).toBe('abcde');
  });

  it('closes up below the top when the top one sits lower', () => {
    const s = stack();
    s.groupLayers(['a', 'c'], { id: 'g', name: 'G', collapsed: false });
    expect(names(s)).toBe('ba*c*de');
  });

  it('deletes several in one undo step, but never the last layer', () => {
    const s = stack();
    s.removeLayers(['b', 'd']);
    expect(names(s)).toBe('ace');
    s.removeLayers(['a', 'c', 'e']);
    expect(names(s)).toBe('ace');
    s.undo();
    expect(names(s)).toBe('abcde');
  });
});
