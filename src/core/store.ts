import type { Layer, Project, ShapeDef, LayerGroup } from './types';
import { defaultProject, normaliseProject } from './defaults';
import { groupSpan, tidyGroups } from './groups';
import { releaseFollowers } from './angles';

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
/**
 * What a linked edit leaves alone on every layer but the one being edited:
 * `true` for a whole field, or the keys inside it. These are what make a plate
 * that plate — its identity, its ink, its screen angle, its random seed.
 */
const LAYER_OWN: Partial<Record<keyof Layer, true | string[]>> = {
  id: true,
  name: true,
  visible: true,
  color: true,
  groupId: true,
  prefilter: ['channel', 'ink', 'undercolor', 'nearestSet', 'nearestPaperColor', 'nearestPicked', 'nearestBand'],
  distribution: ['angle', 'angleFrom', 'shift', 'seed'],
};

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
  groupId: Dirty.None,
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
  /**
   * Raster shapes' pixels, held out of the history.
   *
   * A `raster` ShapeDef carries its whole bitmap as a base64 data URL, so a
   * snapshot that included it made every undo entry megabytes heavier — a
   * hundred of those for one imported stamp. The pixels never change once
   * imported, so the snapshot keeps a reference and the bytes live here.
   */
  private blobs = new Map<string, string>();
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
    this.applyLayer(idx, patch);
  }

  private applyLayer(idx: number, patch: Partial<Layer>): void {
    let level = Dirty.None;
    for (const key of Object.keys(patch) as (keyof Layer)[]) {
      level = worst(level, FIELD_DIRTY[key] ?? Dirty.Composite);
    }
    this.project.layers[idx] = { ...this.project.layers[idx], ...patch } as Layer;
    this.markLayer(this.project.layers[idx].id, level);
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

  /**
   * Edit every layer at once, from the inspector.
   *
   * A set of ink plates is several layers that should mostly move together —
   * one dot size, one lineature, one shape — but differ in exactly the things
   * that make each one a plate. With `linked` on, an edit made to the selected
   * layer is made to all of them, minus `LAYER_OWN`: the ink a plate measures
   * and prints, its screen angle and its seed. Distribution parameters only
   * reach layers on the same algorithm, since a lineature means nothing to a
   * stochastic screen.
   *
   * These are separate from `updateLayer`/`updateLayerField` on purpose, so the
   * store's own bookkeeping (a deleted shape falling back to the circle on each
   * layer that used it) never fans out by accident. One undo step covers the
   * whole edit.
   */
  /**
   * The layers an inspector edit fans out to — a selected group's members — or
   * null for a single layer. Set by the layer panel from what is selected.
   */
  scope: string[] | null = null;

  editLayer(id: string, patch: Partial<Layer>): void {
    if (!this.linkedHere(id)) return this.updateLayer(id, patch);
    this.commit(`linked:${Object.keys(patch).join(',')}`);
    const layers = this.project.layers;
    layers.forEach((l, i) => {
      if (l.id === id) return this.applyLayer(i, patch);
      if (!this.inScope(l)) return;
      const own: Partial<Layer> = {};
      for (const [k, v] of Object.entries(patch) as [keyof Layer, unknown][]) {
        if (LAYER_OWN[k] === true) continue;
        if (k === 'distribution') {
          // Switching algorithm for the whole set: keep each plate's angle and
          // give each its own seed, or every stochastic plate would put its
          // dots in exactly the same places and they would print as one.
          const d = { ...(v as Layer['distribution']) } as Record<string, unknown>;
          const mine = l.distribution as Record<string, unknown>;
          if ('angle' in d && 'angle' in mine) d.angle = mine.angle;
          if ('seed' in d) d.seed = (Number(d.seed) || 1) + i * 137;
          (own as Record<string, unknown>)[k] = d;
          continue;
        }
        (own as Record<string, unknown>)[k] = v;
      }
      if (Object.keys(own).length) this.applyLayer(i, own);
    });
  }

  editLayerField<K extends keyof Layer>(id: string, field: K, patch: Partial<Layer[K]>, historyKey?: string): void {
    if (!this.linkedHere(id) || LAYER_OWN[field] === true) {
      return this.updateLayerField(id, field, patch, historyKey);
    }
    this.commit(historyKey ?? `linked:${String(field)}`);
    const source = this.layer(id)!;
    const skip = Array.isArray(LAYER_OWN[field]) ? LAYER_OWN[field] as string[] : [];
    this.project.layers.forEach((l, i) => {
      if (l.id !== id && !this.inScope(l)) return;
      let p = patch as Record<string, unknown>;
      if (l.id !== id) {
        if (field === 'distribution' && l.distribution.algo !== source.distribution.algo) return;
        p = Object.fromEntries(Object.entries(p).filter(([k]) => !skip.includes(k)));
        if (!Object.keys(p).length) return;
      }
      this.applyLayer(i, { [field]: { ...(l[field] as object), ...p } } as Partial<Layer>);
    });
  }

  private linkedHere(id: string): boolean {
    return !!this.scope && this.scope.length > 1 && this.scope.includes(id) && !!this.layer(id);
  }

  private inScope(l: Layer): boolean {
    return !!this.scope && this.scope.includes(l.id);
  }

  // -- groups ---------------------------------------------------------------

  group(id: string): LayerGroup | undefined {
    return this.project.groups?.find((g) => g.id === id);
  }

  /** Rename, or fold and unfold. Folding is how you look at the stack, so it is not undoable. */
  updateGroup(id: string, patch: Partial<Omit<LayerGroup, 'id'>>): void {
    const g = this.group(id);
    if (!g) return;
    if ('name' in patch) this.commit(`group-name:${id}`);
    Object.assign(g, patch);
    this.pending.structural = true;
    this.schedule();
  }

  /** Show or hide every layer of a group at once. */
  setGroupVisible(id: string, visible: boolean): void {
    this.commit(`group-vis:${id}`);
    this.project.layers.forEach((l, i) => {
      if (l.groupId === id && l.visible !== visible) this.applyLayer(i, { visible });
    });
    this.pending.structural = true;
    this.schedule();
  }

  /** Delete a group and every layer in it. */
  removeGroup(id: string): void {
    const remaining = this.project.layers.filter((l) => l.groupId !== id);
    if (!remaining.length || remaining.length === this.project.layers.length) return;
    this.commit(`remove-group:${id}`);
    this.project.layers = remaining;
    tidyGroups(this.project);
    this.pending.structural = true;
    this.pending.global = worst(this.pending.global, Dirty.All);
    this.schedule();
  }

  /** Put adjacent layers into a new group. Layers already in another group leave it. */
  createGroup(group: LayerGroup, ids: string[]): void {
    this.commit(`group:${group.id}`);
    this.project.groups = [...(this.project.groups ?? []), group];
    for (const l of this.project.layers) if (ids.includes(l.id)) l.groupId = group.id;
    tidyGroups(this.project);
    this.pending.structural = true;
    this.schedule();
  }

  /**
   * Gather any layers into a new group, as one undo step.
   *
   * They need not be next to each other: the others close up under the
   * topmost one picked, keeping their order, so the group lands where the
   * highest of them was.
   */
  groupLayers(ids: string[], group: LayerGroup): void {
    const layers = this.project.layers;
    const chosen = layers.filter((l) => ids.includes(l.id));
    if (!chosen.length) return;
    this.commit(`group:${group.id}`);
    const top = Math.max(...chosen.map((l) => layers.indexOf(l)));
    const rest = layers.filter((l) => !ids.includes(l.id));
    const at = layers.slice(0, top).filter((l) => !ids.includes(l.id)).length;
    for (const l of chosen) l.groupId = group.id;
    rest.splice(at, 0, ...chosen);
    this.project.layers = rest;
    this.project.groups = [...(this.project.groups ?? []), group];
    tidyGroups(this.project);
    this.pending.structural = true;
    for (const l of this.project.layers) {
      if (l.input === 'below') this.markLayer(l.id, Dirty.Density);
    }
    this.schedule();
  }

  /** Delete several layers in one undo step. The last layer of a document stays. */
  removeLayers(ids: string[]): void {
    const remaining = this.project.layers.filter((l) => !ids.includes(l.id));
    if (!remaining.length || remaining.length === this.project.layers.length) return;
    this.commit(`remove:${ids.join(',')}`);
    for (const id of ids) releaseFollowers(this.project.layers, id);
    this.project.layers = this.project.layers.filter((l) => !ids.includes(l.id));
    tidyGroups(this.project);
    this.pending.structural = true;
    this.pending.global = worst(this.pending.global, Dirty.All);
    this.schedule();
  }

  /** Insert a new group's layers at an index of the stack, as one undo step. */
  insertGroup(layers: Layer[], group: LayerGroup, at: number): void {
    this.commit(`insert-group:${group.id}`);
    const i = Math.max(0, Math.min(at, this.project.layers.length));
    this.project.layers.splice(i, 0, ...layers);
    this.project.groups = [...(this.project.groups ?? []), group];
    tidyGroups(this.project);
    this.pending.structural = true;
    this.pending.global = worst(this.pending.global, Dirty.All);
    this.schedule();
  }

  /** Dissolve a group, keeping its layers where they are. */
  ungroup(id: string): void {
    this.commit(`ungroup:${id}`);
    for (const l of this.project.layers) if (l.groupId === id) delete l.groupId;
    tidyGroups(this.project);
    this.pending.structural = true;
    this.schedule();
  }

  /**
   * Move a whole group to an insertion point in the stack as it stands now,
   * the same convention as `moveLayer`. A point inside another group lands at
   * that group's top instead: groups do not nest.
   */
  moveGroup(id: string, toIndex: number): void {
    const layers = this.project.layers;
    const span = groupSpan(this.project, id);
    if (!span) return;
    const [a, b] = span;
    let t = Math.max(0, Math.min(toIndex, layers.length));
    if (t > a && t <= b + 1) return; // inside itself, or just after: no move
    const block = layers.slice(a, b + 1);
    const rest = [...layers.slice(0, a), ...layers.slice(b + 1)];
    if (t > b) t -= block.length;
    const host = rest[t]?.groupId;
    if (host && rest[t - 1]?.groupId === host) {
      while (t < rest.length && rest[t].groupId === host) t += 1;
    }
    this.commit(`move-group:${id}`);
    rest.splice(t, 0, ...block);
    this.project.layers = rest;
    tidyGroups(this.project);
    this.pending.structural = true;
    for (const l of this.project.layers) {
      if (l.input === 'below') this.markLayer(l.id, Dirty.Density);
    }
    this.schedule();
  }

  /** One step up (+1) or down (-1), past the whole layer or group that is next. */
  nudgeGroup(id: string, delta: number): void {
    const span = groupSpan(this.project, id);
    if (!span) return;
    const layers = this.project.layers;
    const [a, b] = span;
    if (delta > 0) {
      const next = layers[b + 1];
      if (!next) return;
      const nspan = next.groupId ? groupSpan(this.project, next.groupId) : [b + 1, b + 1];
      this.moveGroup(id, nspan![1] + 1);
    } else {
      const prev = layers[a - 1];
      if (!prev) return;
      const pspan = prev.groupId ? groupSpan(this.project, prev.groupId) : [a - 1, a - 1];
      this.moveGroup(id, pspan![0]);
    }
  }

  addLayer(layer: Layer, at?: number): void {
    this.commit(`add:${layer.id}`);
    const index = at ?? this.project.layers.length;
    this.project.layers.splice(index, 0, layer);
    this.pending.structural = true;
    this.markLayer(layer.id, Dirty.Density);
  }

  /** Swap the whole stack, for operations that only make sense as a set. */
  replaceLayers(layers: Layer[], groups: LayerGroup[] = []): void {
    this.commit('replace-layers');
    this.project.layers = layers;
    this.project.groups = groups;
    tidyGroups(this.project);
    this.pending.structural = true;
    this.pending.global = worst(this.pending.global, Dirty.All);
    this.schedule();
  }

  removeLayer(id: string): void {
    const idx = this.project.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    this.commit(`remove:${id}`);
    releaseFollowers(this.project.layers, id);
    this.project.layers.splice(idx, 1);
    tidyGroups(this.project);
    this.pending.structural = true;
    this.schedule();
  }

  /**
   * Move a layer to sit before `toIndex` of the stack *as it stands now*.
   *
   * An insertion point rather than a destination index, because that is the only
   * one of the two a caller can name without knowing which way the layer is
   * about to travel: a drop between two rows is "here", and "here" is a
   * different index once the dragged layer has been lifted out from below it.
   * Doing that adjustment here is what keeps a drop landing where the line was
   * drawn, in both directions.
   */
  /**
   * `into`: leave undefined to decide by where it lands (between two layers of
   * a group joins it), pass a group id to put it in that group regardless —
   * the slot just under a group's header row — or null to take it out.
   */
  moveLayer(id: string, toIndex: number, into?: string | null): void {
    const from = this.project.layers.findIndex((l) => l.id === id);
    if (from < 0) return;
    const target = Math.max(0, Math.min(toIndex, this.project.layers.length));
    const dest = target > from ? target - 1 : target;
    if (dest === from && into === undefined) return;
    this.commit(`move:${id}`);
    const [layer] = this.project.layers.splice(from, 1);
    this.project.layers.splice(dest, 0, layer);
    // Dropped between two layers of one group, it joins that group; dropped
    // anywhere else, it leaves the one it was in — the way a layer moves in
    // and out of a folder in any compositing tool.
    const below = this.project.layers[dest - 1];
    const above = this.project.layers[dest + 1];
    if (into) layer.groupId = into;
    else if (into === null) delete layer.groupId;
    else if (below?.groupId && below.groupId === above?.groupId) layer.groupId = below.groupId;
    else if (layer.groupId && below?.groupId !== layer.groupId && above?.groupId !== layer.groupId) delete layer.groupId;
    tidyGroups(this.project);
    this.pending.structural = true;
    // Anything reading from `below` sees a different image now.
    for (const l of this.project.layers) {
      if (l.input === 'below') this.markLayer(l.id, Dirty.Density);
    }
    this.schedule();
  }

  updateCanvas(patch: Partial<Project['canvas']>): void {
    // The unit is a display preference — it changes how lengths are written and
    // nothing about the document — so it is not worth an undo step of its own.
    // It still notifies, because the panels are built against one unit.
    const displayOnly = Object.keys(patch).length === 1 && 'units' in patch;
    if (!displayOnly) this.commit('canvas');
    const sizeChanged = ('width' in patch && patch.width !== this.project.canvas.width)
      || ('height' in patch && patch.height !== this.project.canvas.height);
    this.project.canvas = { ...this.project.canvas, ...patch };
    this.pending.global = worst(this.pending.global, sizeChanged ? Dirty.All : Dirty.Composite);
    this.schedule();
  }

  updateShapes(shapes: Project['shapes'], historyKey = 'shapes'): void {
    this.commit(historyKey);
    this.project.shapes = shapes;
    this.pending.shapes = true;
    this.schedule();
  }

  /**
   * Patch one shape definition in place.
   *
   * Shapes are project-scoped copies of the built-ins, so tuning a shape's
   * geometry is an edit to this document rather than a global preference. The
   * atlas re-rasterises only the tile whose definition actually changed, which
   * is what makes dragging a segment-count slider cheap.
   */
  updateShape(id: string, patch: Partial<ShapeDef>): void {
    const idx = this.project.shapes.findIndex((s) => s.id === id);
    if (idx < 0) return;
    this.commit(`shape:${id}:${Object.keys(patch).join(',')}`);
    const next = [...this.project.shapes];
    next[idx] = { ...next[idx], ...patch } as ShapeDef;
    this.project.shapes = next;
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

  /** The project as a history entry, with raster pixels swapped for a reference. */
  private snapshot(): string {
    const { shapes, ...rest } = this.project;
    const lean = shapes.map((s) => {
      if (s.kind !== 'raster') return s;
      this.blobs.set(s.id, s.data);
      return { ...s, data: `blob:${s.id}` };
    });
    return JSON.stringify({ ...rest, shapes: lean });
  }

  /** The inverse of `snapshot`, putting the raster pixels back. */
  private restore(snap: string): Project {
    const project = JSON.parse(snap) as Project;
    project.shapes = project.shapes.map((s) =>
      s.kind === 'raster' && s.data.startsWith('blob:')
        ? { ...s, data: this.blobs.get(s.data.slice(5)) ?? s.data }
        : s);
    return project;
  }

  /**
   * Run several edits as one undo step — recolouring a whole colour group, or
   * growing it by three layers, is one thing to the person doing it.
   */
  batch(key: string, fn: () => void): void {
    this.commit(key);
    this.batching = true;
    try { fn(); } finally { this.batching = false; }
  }
  private batching = false;

  /** Swap one layer for a group of layers in its place, as one undo step. */
  replaceLayerWithGroup(id: string, layers: Layer[], group: LayerGroup): void {
    const idx = this.project.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    this.commit(`to-group:${id}`);
    this.project.layers.splice(idx, 1, ...layers);
    this.project.groups = [...(this.project.groups ?? []), group];
    tidyGroups(this.project);
    this.pending.structural = true;
    this.pending.global = worst(this.pending.global, Dirty.All);
    this.schedule();
  }

  private commit(key: string): void {
    if (this.batching) return;
    const now = performance.now();
    if (key === this.lastCommitKey && now - this.lastCommitTime < Store.COALESCE_MS) {
      this.lastCommitTime = now;
      return;
    }
    this.lastCommitKey = key;
    this.lastCommitTime = now;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > Store.MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this.snapshot());
    this.project = this.restore(snap);
    this.lastCommitKey = '';
    this.invalidateAll();
    this.pending.structural = true;
    this.pending.shapes = true;
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.snapshot());
    this.project = this.restore(snap);
    this.lastCommitKey = '';
    this.invalidateAll();
    this.pending.structural = true;
    this.pending.shapes = true;
  }

  /** Replace the whole project (open a file / new document). */
  load(project: Project): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.blobs.clear();
    this.project = tidyGroups(normaliseProject(project));
    this.pending = emptyChange();
    this.pending.structural = true;
    this.pending.shapes = true;
    this.invalidateAll();
  }
}
