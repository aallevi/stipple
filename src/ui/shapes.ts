import type { Store } from '../core/store';
import type { ShapeDef } from '../core/types';
import { BUILTIN_SHAPES, uid } from '../core/defaults';
import { openFile } from '../platform';
import { importShape } from '../shape/import';
import { rasterizeShape } from '../shape/rasterize';
import { button, h } from './controls';

/**
 * The shape library.
 *
 * Previews are drawn from the very same `rasterizeShape` the atlas uses, so what
 * you pick here is exactly what gets stippled — including imported files, which
 * appear alongside the built-ins with no visual distinction because they are not
 * treated differently anywhere.
 *
 * It has no chrome of its own: the panel that hosts it supplies the heading and
 * hangs `importBtn` / `duplicateBtn` wherever they belong. That is what lets the
 * picker sit directly above the dot settings it drives.
 */
export class ShapesPanel {
  readonly el = h('div', { class: 'shapes' });
  /** Owned here, placed by the host panel. */
  readonly importBtn = button('Import…', () => void this.importShape(), 'sm',
    'Add an SVG or a PNG with transparency to the library');
  readonly duplicateBtn = button('Duplicate', () => this.duplicate(), 'sm',
    'Fork the selected shape so it can be tuned without touching the original');

  private grid = h('div', { class: 'shape-grid' });
  private status = h('p', { class: 'hint' });
  private tiles = new Map<string, HTMLElement>();
  private selectedId?: string;

  constructor(
    private store: Store,
    private onBitmap: (shapeId: string, bitmap: ImageBitmap) => void,
    private onPick: (shapeId: string) => void,
  ) {
    this.el.append(this.grid, this.status);
    this.status.textContent = 'Drop an SVG or a transparent PNG here to add your own stamp.';
    this.setupDrop();
  }

  private setupDrop(): void {
    this.el.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.el.classList.add('drop-active');
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop-active'));
    this.el.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.el.classList.remove('drop-active');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      await this.ingest(file.name, new Uint8Array(await file.arrayBuffer()));
    });
  }

  private async importShape(): Promise<void> {
    const picked = await openFile([
      { name: 'Shape', extensions: ['svg', 'png', 'webp', 'gif'] },
    ]);
    if (picked) await this.ingest(picked.name, picked.bytes);
  }

  private async ingest(name: string, bytes: Uint8Array): Promise<void> {
    try {
      const { def, bitmap } = await importShape(name, bytes);
      if (bitmap) this.onBitmap(def.id, bitmap);
      this.store.updateShapes([...this.store.get().shapes, def], `shape-add:${def.id}`);
      this.status.textContent = `Imported "${def.name}".`;
      this.render(def.id);
      this.onPick(def.id);
    } catch (err) {
      this.status.textContent = `Could not import ${name}: ${(err as Error).message}`;
    }
  }

  /**
   * Copy the selected shape under a new id.
   *
   * Shape definitions are shared by every layer that points at one, so this is
   * the escape hatch that lets a document hold a four-armed and a twelve-armed
   * burst at once instead of forcing a choice between them.
   */
  private duplicate(): void {
    const src = this.store.get().shapes.find((s) => s.id === this.selectedId);
    if (!src) return;
    const copy = { ...JSON.parse(JSON.stringify(src)), id: uid('shape'), name: nextName(src.name) } as ShapeDef;
    this.store.updateShapes([...this.store.get().shapes, copy], `shape-add:${copy.id}`);
    // Raster copies share the decoded bitmap; it is immutable, so one is enough.
    const bmp = this.bitmaps.get(src.id);
    if (bmp) {
      this.bitmaps.set(copy.id, bmp);
      this.onBitmap(copy.id, bmp);
    }
    this.status.textContent = `Duplicated "${src.name}" — edits below apply to the copy.`;
    this.render(copy.id);
    this.onPick(copy.id);
  }

  /**
   * Move the highlight without rebuilding the grid.
   *
   * Selecting a different layer changes which shape is current, but every tile's
   * artwork is unchanged — and each preview is a real rasterise, so redrawing
   * them all on a click would be work for nothing.
   */
  setSelected(shapeId?: string): void {
    if (shapeId === this.selectedId) return;
    this.selectedId = shapeId;
    for (const [id, tile] of this.tiles) tile.classList.toggle('selected', id === shapeId);
    this.duplicateBtn.disabled = !shapeId || !this.tiles.has(shapeId);
  }

  render(selectedId?: string): void {
    this.selectedId = selectedId ?? this.selectedId;
    const shapes = this.store.get().shapes;
    const builtinIds = new Set(BUILTIN_SHAPES.map((s) => s.id));
    this.duplicateBtn.disabled = !shapes.some((s) => s.id === this.selectedId);
    this.tiles.clear();

    const tiles = shapes.map((def) => {
      const cell = h('button', {
        class: `shape-tile${def.id === this.selectedId ? ' selected' : ''}`,
        type: 'button',
        title: def.name,
      });
      cell.append(this.preview(def));
      cell.append(h('span', { class: 'shape-name' }, def.name));
      cell.addEventListener('click', () => {
        this.onPick(def.id);
        this.render(def.id);
      });

      if (!builtinIds.has(def.id)) {
        const del = h('button', { class: 'shape-del', type: 'button', title: 'Remove shape' }, '×');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          this.remove(def.id);
        });
        cell.append(del);
      }
      this.tiles.set(def.id, cell);
      return cell;
    });
    this.grid.replaceChildren(...tiles);
  }

  private remove(id: string): void {
    const project = this.store.get();
    // Any layer pointing at the removed shape falls back to the circle rather
    // than rendering nothing.
    for (const layer of project.layers) {
      if (layer.shapeId === id) this.store.updateLayer(layer.id, { shapeId: 'circle' });
    }
    this.store.updateShapes(project.shapes.filter((s) => s.id !== id), `shape-del:${id}`);
    if (this.selectedId === id) this.selectedId = 'circle';
    this.render();
  }

  /** Small preview drawn through the same rasteriser the atlas uses. */
  private preview(def: ShapeDef): HTMLCanvasElement {
    const size = 40;
    const canvas = h('canvas', { width: String(size), height: String(size) }) as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const alpha = rasterizeShape(def, size, this.bitmaps.get(def.id));
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < alpha.length; i++) {
      img.data[i * 4] = 235;
      img.data[i * 4 + 1] = 238;
      img.data[i * 4 + 2] = 242;
      img.data[i * 4 + 3] = alpha[i];
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  private bitmaps = new Map<string, ImageBitmap>();

  /** Raster shapes need their decoded bitmap to preview and to build an SDF. */
  registerBitmap(id: string, bitmap: ImageBitmap): void {
    this.bitmaps.set(id, bitmap);
  }
}

/** "Burst" → "Burst 2", "Burst 2" → "Burst 3". */
function nextName(name: string): string {
  const m = /^(.*?) (\d+)$/.exec(name);
  return m ? `${m[1]} ${Number(m[2]) + 1}` : `${name} 2`;
}
