import type { Store } from '../core/store';
import type { ShapeDef } from '../core/types';
import { BUILTIN_SHAPES } from '../core/defaults';
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
 */
export class ShapesPanel {
  readonly el = h('div', { class: 'shapes' });
  private grid = h('div', { class: 'shape-grid' });
  private status = h('p', { class: 'hint' });

  constructor(
    private store: Store,
    private onBitmap: (shapeId: string, bitmap: ImageBitmap) => void,
    private onPick: (shapeId: string) => void,
  ) {
    this.el.append(
      h('div', { class: 'panel-head' },
        h('span', {}, 'Shapes'),
        h('div', { class: 'panel-actions' }, button('Import…', () => this.importShape())),
      ),
      this.grid,
      this.status,
    );
    this.status.textContent = 'Import an SVG or a PNG with transparency to use it as a stamp.';
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
      this.store.updateShapes([...this.store.get().shapes, def]);
      this.status.textContent = `Imported "${def.name}".`;
      this.render();
      this.onPick(def.id);
    } catch (err) {
      this.status.textContent = `Could not import ${name}: ${(err as Error).message}`;
    }
  }

  render(selectedId?: string): void {
    const shapes = this.store.get().shapes;
    const builtinIds = new Set(BUILTIN_SHAPES.map((s) => s.id));

    const tiles = shapes.map((def) => {
      const cell = h('button', {
        class: `shape-tile${def.id === selectedId ? ' selected' : ''}`,
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
        const del = h('span', { class: 'shape-del', title: 'Remove shape' }, '×');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          this.remove(def.id);
        });
        cell.append(del);
      }
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
    this.store.updateShapes(project.shapes.filter((s) => s.id !== id));
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
