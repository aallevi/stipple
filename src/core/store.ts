import type { Layer, Project } from './types';
import { defaultProject } from './defaults';

/**
 * How much work a change forces the engine to redo. Higher subsumes lower.
 *
 * The reason `Composite` covers so much is deliberate: a layer's point buffer
 * stores only *invariants* (x, y, tone, gradient, random). Size, rotation and
 * colour are evaluated in the vertex shader from those plus layer uniforms, so
 * changing them costs a uniform update and a redraw — no regeneration, no buffer
 * upload. Only things that move points land on `Points` or above.
 */
export enum Dirty {
  None = 0,
  /** Re-draw with new uniforms. */
  Composite = 1,
  /** Re-run the distribution to get new point positions. */
  Points = 2,
  /** Rebuild the prefiltered density texture, then the points. */
  Density = 3,
  /** Source image or canvas geometry changed — rebuild everything. */
  All = 4,
}

/** Which dirty level each top-level `Layer` field implies when it changes. */
const FIELD_DIRTY: Record<keyof Layer, Dirty> = {
  id: Dirty.None,
  name: Dirty.None,
  visible: Dirty.Composite,
  opacity: Dirty.Composite,
  blend: Dirty.Composite,
  input: Dirty.Density,
  prefilter: Dirty.Density,
  mask: Dirty.Points,
  distribution: Dirty.Points,
  shapeId: Dirty.Composite,
  size: Dirty.Composite,
  rotation: Dirty.Composite,
  color: Dirty.Composite,
  transform: Dirty.Composite,
};

export type Change = {
  /** Layers that changed, with the worst dirty level seen for each. */
  layers: Map<string, Dirty>;
  /** Set when the layer list itself changed (add/remove/reorder). */
  structural: boolean;
  /** Set when the shape library changed. */
  shapes: boolean;
  /** Set when the canvas or source image changed. */
  global: Dirty;
};

type Listener = (project: Project, change: Change) => void;

function emptyChange(): Change {
  return { layers: new Map(), structural: false, shapes: false, global: Dirty.None };
}

function worst(a: Dirty, b: Dirty): Dirty {
  return a > b ? a : b;
}

/**
 * Holds the project and broadcasts precise invalidation info. Mutations go
 * through the `mutate*` helpers so nothing can change the project without the
 * engine hearing about it at the right granularity.
 */
export class Store {
  private project: Project;
  private listeners = new Set<Listener>();
  private pending = emptyChange();
  private flushScheduled = false;

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastCommitKey = '';
  private lastCommitTime = 0;
  /** Slider drags produce hundreds of changes; collapse them into one undo step. */
  private static readonly COALESCE_MS = 500;
  private static readonly MAX_HISTORY = 100;

  constructor(project: Project = defaultProject()) {
    this.project = project;
  }

  get(): Readonly<Project> {
    return this.project;
  }

  layer(id: string): Layer | undefined {
    return this.project.layers.find((l) => l.id === id);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // -- mutation ------------------------------------------------------------

  /**
   * Patch one layer. The dirty level is derived from which fields the patch
   * touches, so callers never have to reason about invalidation.
   *
   * `historyKey` groups rapid edits (a slider drag) into a single undo entry.
   */
  updateLayer(id: string, patch: Partial<Layer>, historyKey?: string): void {
    const idx = this.project.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    this.commit(historyKey ?? `layer:${id}:${Object.keys(patch).join(',')}`);

    let level = Dirty.None;
    for (const key of Object.keys(patch) as (keyof Layer)[]) {
      level = worst(level, FIELD_DIRTY[key] ?? Dirty.Composite);
    }
    this.project.layers[idx] = { ...this.project.layers[idx], ...patch } as Layer;
    this.markLayer(id, level);
  }

  /** Patch a nested object on a layer (`prefilter`, `size`, `color`, ...). */
  updateLayerField<K extends keyof Layer>(
    id: string,
    field: K,
    patch: Partial<Layer[K]>,
    historyKey?: string,
  ): void {
    const layer = this.layer(id);
    if (!layer) return;
    const merged = { ...(layer[field] as object), ...(patch as object) } as Layer[K];
    this.updateLayer(id, { [field]: merged } as Partial<Layer>, historyKey ?? `layer:${id}:${String(field)}`);
  }

  addLayer(layer: Layer, at?: number): void {
    this.commit(`add:${layer.id}`);
    const index = at ?? this.project.layers.length;
    this.project.layers.splice(index, 0, layer);
    this.pending.structural = true;
    this.markLayer(layer.id, Dirty.Density);
  }

  removeLayer(id: string): void {
    const idx = this.project.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    this.commit(`remove:${id}`);
    this.project.layers.splice(idx, 1);
    this.pending.structural = true;
    this.schedule();
  }

  moveLayer(id: string, toIndex: number): void {
    const from = this.project.layers.findIndex((l) => l.id === id);
    if (from < 0 || from === toIndex) return;
    this.commit(`move:${id}`);
    const [layer] = this.project.layers.splice(from, 1);
    this.project.layers.splice(Math.max(0, Math.min(toIndex, this.project.layers.length)), 0, layer);
    this.pending.structural = true;
    // Anything reading from `below` sees a different image now.
    for (const l of this.project.layers) {
      if (l.input === 'below') this.markLayer(l.id, Dirty.Density);
    }
    this.schedule();
  }

  updateCanvas(patch: Partial<Project['canvas']>): void {
    this.commit('canvas');
    const sizeChanged = ('width' in patch && patch.width !== this.project.canvas.width)
      || ('height' in patch && patch.height !== this.project.canvas.height);
    this.project.canvas = { ...this.project.canvas, ...patch };
    this.pending.global = worst(this.pending.global, sizeChanged ? Dirty.All : Dirty.Composite);
    this.schedule();
  }

  updateShapes(shapes: Project['shapes']): void {
    this.commit('shapes');
    this.project.shapes = shapes;
    this.pending.shapes = true;
    this.schedule();
  }

  /** The source image changed — nothing survives. */
  invalidateAll(): void {
    this.pending.global = Dirty.All;
    this.schedule();
  }

  /** Force a redraw without touching the project (e.g. viewport pan/zoom). */
  requestRedraw(): void {
    this.pending.global = worst(this.pending.global, Dirty.Composite);
    this.schedule();
  }

  private markLayer(id: string, level: Dirty): void {
    if (level === Dirty.None) return;
    const prev = this.pending.layers.get(id) ?? Dirty.None;
    this.pending.layers.set(id, worst(prev, level));

    // A layer that samples the composite below it depends on every layer under
    // it, so a change here cascades upward through the stack.
    const idx = this.project.layers.findIndex((l) => l.id === id);
    if (idx >= 0) {
      for (let i = idx + 1; i < this.project.layers.length; i++) {
        const above = this.project.layers[i];
        if (above.input !== 'below') continue;
        const p = this.pending.layers.get(above.id) ?? Dirty.None;
        this.pending.layers.set(above.id, worst(p, Dirty.Density));
      }
    }
    this.schedule();
  }

  /** Coalesce every mutation in a frame into one notification. */
  private schedule(): void {
    // The flag is set before the callback is registered, not after: a host that
    // runs the callback synchronously would otherwise leave the handle assigned
    // after the flush and wedge every later notification.
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      const change = this.pending;
      this.pending = emptyChange();
      for (const fn of this.listeners) fn(this.project, change);
    });
  }

  // -- history -------------------------------------------------------------

  private commit(key: string): void {
    const now = performance.now();
    if (key === this.lastCommitKey && now - this.lastCommitTime < Store.COALESCE_MS) {
      this.lastCommitTime = now;
      return;
    }
    this.lastCommitKey = key;
    this.lastCommitTime = now;
    this.undoStack.push(JSON.stringify(this.project));
    if (this.undoStack.length > Store.MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(snap) as Project;
    this.lastCommitKey = '';
    this.invalidateAll();
    this.pending.structural = true;
    this.pending.shapes = true;
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(snap) as Project;
    this.lastCommitKey = '';
    this.invalidateAll();
    this.pending.structural = true;
    this.pending.shapes = true;
  }

  /** Replace the whole project (open a file / new document). */
  load(project: Project): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.project = project;
    this.pending = emptyChange();
    this.pending.structural = true;
    this.pending.shapes = true;
    this.invalidateAll();
  }
}
