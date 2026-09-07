import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLayer, defaultProject } from '../src/core/defaults';
import { Dirty, Store, type Change } from '../src/core/store';

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

  it('escalates a spacing change to a point regeneration', () => {
    const store = new Store(defaultProject());
    const id = store.get().layers[0].id;
    const last = capture(store);
    store.updateLayerField(id, 'distribution', { spacing: 12 } as never);
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
    store.updateLayerField(upper.id, 'distribution', { spacing: 3 } as never);
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
    for (let i = 1; i <= 20; i++) store.updateLayerField(id, 'size', { max: i });
    expect(store.layer(id)!.size.max).toBe(20);
    store.undo();
    expect(store.layer(id)!.size.max).toBe(4); // back to the default in one step
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
});

describe('project serialisation', () => {
  it('round-trips through JSON unchanged', () => {
    const store = new Store(defaultProject(800, 600));
    const id = store.get().layers[0].id;
    store.updateLayerField(id, 'color', { mode: 'multicolor' });
    store.updateLayerField(id, 'distribution', { spacing: 7 } as never);

    const json = JSON.stringify(store.get());
    const restored = JSON.parse(json);
    expect(restored).toEqual(JSON.parse(JSON.stringify(store.get())));
    expect(restored.layers[0].color.mode).toBe('multicolor');
    expect(restored.layers[0].distribution.spacing).toBe(7);
  });
});
