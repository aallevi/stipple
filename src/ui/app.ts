import { defaultProject, BUILTIN_SHAPES } from '../core/defaults';
import { Store } from '../core/store';
import type { Project } from '../core/types';
import { exportPDF } from '../export/pdf';
import { exportPNG } from '../export/png';
import { estimatePoints, exportSVG, WARN_POINTS } from '../export/svg';
import { decodeImage } from '../image/loader';
import { testCard } from '../image/testcard';
import { Engine } from '../pipeline/engine';
import { decodeNative, openFile, saveFile, supportedImageExtensions } from '../platform';
import { rasterBitmap } from '../shape/import';
import { button, colorControl, h, slider, type Interaction } from './controls';
import { Inspector } from './inspector';
import { LayersPanel } from './layers';
import { ShapesPanel } from './shapes';
import { PRESETS } from './presets';

/**
 * Wires the store, the engine and the panels together, and owns the render loop.
 *
 * The loop is deliberately dumb: it calls `engine.render()` every frame and the
 * engine returns immediately when nothing is dirty. All the intelligence about
 * what to recompute lives in the store's dirty levels and the engine's caches,
 * so there is no scheduling logic to get out of sync here.
 */
export class App {
  private store = new Store(defaultProject());
  private canvas = h('canvas', { class: 'viewport' }) as HTMLCanvasElement;
  private engine: Engine;
  private layers: LayersPanel;
  private shapes: ShapesPanel;
  private inspector: Inspector;
  private hud = h('div', { class: 'hud' });
  private toast = h('div', { class: 'toast' });
  private interaction: Interaction;

  constructor(root: HTMLElement) {
    this.engine = new Engine(this.canvas, this.store);

    let depth = 0;
    this.interaction = {
      begin: () => {
        depth += 1;
        this.engine.setInteractive(true);
      },
      end: () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) {
          this.engine.setInteractive(false);
          this.store.requestRedraw();
        }
      },
    };

    this.layers = new LayersPanel(this.store, (id) => this.inspector.update(id));
    this.shapes = new ShapesPanel(
      this.store,
      (id, bmp) => {
        this.shapes.registerBitmap(id, bmp);
        this.engine.setShapeBitmap(id, bmp);
      },
      (shapeId) => {
        if (this.layers.selected) this.store.updateLayer(this.layers.selected, { shapeId });
      },
    );
    this.inspector = new Inspector(
      this.store,
      this.interaction,
      () => this.store.get().shapes.map((s) => ({ value: s.id, label: s.name })),
      this.engine.voronoiAvailable,
    );

    root.append(this.buildLayout());
    this.bindViewport();
    this.bindKeys();

    this.store.subscribe((project, change) => {
      this.engine.sync(project, change);
      if (change.structural) this.layers.render();
      if (change.shapes) this.shapes.render(this.selectedShapeId());
      this.inspector.update(this.layers.selected);
    });

    this.engine.setSource(testCard());
    this.layers.select(this.store.get().layers[0].id);
    this.shapes.render(this.selectedShapeId());
    this.fitToWindow();
    this.loop();
  }

  /**
   * Handles for the dev-mode console and the verification script. Exposed only
   * under `import.meta.env.DEV`, so it never reaches a shipped build.
   */
  get debug(): {
    store: Store;
    engine: Engine;
    selectLayer(id: string): void;
    applyPreset(name: string): boolean;
    setAutoRender(on: boolean): void;
  } {
    return {
      store: this.store,
      engine: this.engine,
      selectLayer: (id) => this.layers.select(id),
      // Benchmarks need to own the clock; with the loop running, a forced render
      // measures whatever the loop left undone rather than the work itself.
      setAutoRender: (on) => { this.autoRender = on; },
      applyPreset: (name) => {
        const preset = PRESETS.find((p) => p.name === name);
        if (!preset) return false;
        const project = this.store.get();
        this.store.load({
          ...preset.build(project.canvas.width, project.canvas.height),
          shapes: project.shapes,
        });
        this.layers.render();
        this.layers.select(this.store.get().layers[0].id);
        return true;
      },
    };
  }

  private selectedShapeId(): string | undefined {
    return this.layers.selected ? this.store.layer(this.layers.selected)?.shapeId : undefined;
  }

  private buildLayout(): HTMLElement {
    const openBtn = button('Open image…', () => this.openImage(), 'primary');
    const fitBtn = button('Fit', () => this.fitToWindow());
    const oneToOne = button('100%', () => {
      this.engine.setViewport({ zoom: 1, panX: 0, panY: 0 });
      this.store.requestRedraw();
    });
    const undoBtn = button('Undo', () => this.store.undo());
    const redoBtn = button('Redo', () => this.store.redo());

    const presetSel = h('select', { class: 'preset-select' }) as HTMLSelectElement;
    presetSel.append(h('option', { value: '' }, 'Presets…'));
    for (const p of PRESETS) presetSel.append(h('option', { value: p.name }, p.name));
    presetSel.addEventListener('change', () => {
      const preset = PRESETS.find((p) => p.name === presetSel.value);
      if (!preset) return;
      const project = this.store.get();
      this.store.load({
        ...preset.build(project.canvas.width, project.canvas.height),
        shapes: project.shapes,
      });
      this.layers.render();
      this.layers.select(this.store.get().layers[0].id);
      presetSel.value = '';
    });

    const canvasControls = [
      slider({
        label: 'Canvas W', min: 128, max: 8000, step: 1,
        get: () => this.store.get().canvas.width,
        set: (v) => this.store.updateCanvas({ width: Math.round(v) }),
      }),
      slider({
        label: 'Canvas H', min: 128, max: 8000, step: 1,
        get: () => this.store.get().canvas.height,
        set: (v) => this.store.updateCanvas({ height: Math.round(v) }),
      }),
      slider({
        label: 'DPI', min: 36, max: 1200, step: 1,
        get: () => this.store.get().canvas.dpi,
        set: (v) => this.store.updateCanvas({ dpi: Math.round(v) }),
      }),
      colorControl({
        label: 'Background', interaction: this.interaction,
        get: () => this.store.get().canvas.background,
        set: (v) => this.store.updateCanvas({ background: v }),
      }),
    ];
    for (const c of canvasControls) c.sync();

    return h('div', { class: 'app' },
      h('header', { class: 'toolbar' },
        h('span', { class: 'brand' }, 'Stipple'),
        openBtn, fitBtn, oneToOne, undoBtn, redoBtn, presetSel,
        h('span', { class: 'spacer' }),
        button('Export PNG', () => this.doExport('png')),
        button('Export SVG', () => this.doExport('svg')),
        button('Export PDF', () => this.doExport('pdf')),
        button('Save', () => this.saveProject()),
        button('Load', () => this.loadProject()),
      ),
      h('main', { class: 'main' },
        h('div', { class: 'stage' }, this.canvas, this.hud, this.toast),
        h('aside', { class: 'sidebar' },
          this.layers.el,
          this.inspector.el,
          this.shapes.el,
          h('div', { class: 'section' },
            h('button', { class: 'section-head', type: 'button' }, 'Document'),
            h('div', { class: 'section-body' }, ...canvasControls.map((c) => c.el)),
          ),
        ),
      ),
    );
  }

  // -- viewport ------------------------------------------------------------

  private bindViewport(): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const v = this.engine.getViewport();
      this.engine.setViewport({ panX: v.panX + (e.clientX - lastX), panY: v.panY + (e.clientY - lastY) });
      lastX = e.clientX;
      lastY = e.clientY;
      this.store.requestRedraw();
    });
    const stop = (e: PointerEvent): void => {
      dragging = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = this.engine.getViewport();
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.engine.setViewport({ zoom: Math.min(8, Math.max(0.05, v.zoom * factor)) });
      this.store.requestRedraw();
    }, { passive: false });

    window.addEventListener('resize', () => this.store.requestRedraw());
  }

  private fitToWindow(): void {
    const { width, height } = this.store.get().canvas;
    const rect = this.canvas.getBoundingClientRect();
    const zoom = Math.min((rect.width - 48) / width, (rect.height - 48) / height);
    this.engine.setViewport({ zoom: Math.max(0.05, zoom), panX: 0, panY: 0 });
    this.store.requestRedraw();
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.store.redo();
        else this.store.undo();
      } else if (meta && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void this.openImage();
      } else if (e.key === '0') {
        this.fitToWindow();
      }
    });
  }

  // -- files ---------------------------------------------------------------

  private async openImage(): Promise<void> {
    const extensions = await supportedImageExtensions();
    const picked = await openFile([{ name: 'Image', extensions }]);
    if (!picked) return;
    try {
      // TIFF and friends have no web-view decoder; fall back to the Rust one,
      // which is only present in the desktop shell.
      const src = /\.tiff?$/i.test(picked.name) && picked.path
        ? toSource(await decodeNative(picked.path))
        : await decodeImage(picked.bytes);
      this.engine.setSource(src);
      // Match the canvas to the image so 100% means one canvas pixel per source
      // pixel — otherwise spacing values mean something different per image.
      this.store.updateCanvas({ width: src.width, height: src.height });
      this.fitToWindow();
      this.notify(`Loaded ${picked.name} (${src.width}×${src.height})`);
    } catch (err) {
      this.notify(`Could not open ${picked.name}: ${(err as Error).message}`, true);
    }
  }

  private async doExport(kind: 'png' | 'svg' | 'pdf'): Promise<void> {
    const project = this.store.get();
    try {
      this.engine.prepareForExport();
      if (kind === 'png') {
        const scale = project.canvas.dpi / 96;
        this.notify('Rendering PNG…');
        const blob = await exportPNG(this.engine, project, scale, (done, total) =>
          this.notify(`Rendering PNG… tile ${done}/${total}`));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await saveFile(bytes, 'stipple.png', [{ name: 'PNG', extensions: ['png'] }]);
        this.notify(`Exported PNG at ${Math.round(project.canvas.width * scale)}×${Math.round(project.canvas.height * scale)}`);
        return;
      }

      const count = estimatePoints(this.engine, project);
      if (count > WARN_POINTS) {
        const ok = confirm(
          `This stack has ${count.toLocaleString()} points. A vector file that large ` +
          `can be very slow to open in most editors.\n\nExport anyway?`,
        );
        if (!ok) return;
      }

      if (kind === 'svg') {
        const svg = exportSVG(this.engine, project);
        await saveFile(svg, 'stipple.svg', [{ name: 'SVG', extensions: ['svg'] }]);
        this.notify(`Exported SVG (${count.toLocaleString()} points)`);
      } else {
        const { bytes, warnings } = exportPDF(this.engine, project);
        await saveFile(bytes, 'stipple.pdf', [{ name: 'PDF', extensions: ['pdf'] }]);
        this.notify(warnings.length ? warnings.join(' ') : `Exported PDF (${count.toLocaleString()} points)`, warnings.length > 0);
      }
    } catch (err) {
      this.notify(`Export failed: ${(err as Error).message}`, true);
    }
  }

  private async saveProject(): Promise<void> {
    await saveFile(JSON.stringify(this.store.get(), null, 2), 'untitled.stipple',
      [{ name: 'Stipple project', extensions: ['stipple', 'json'] }]);
    this.notify('Project saved');
  }

  private async loadProject(): Promise<void> {
    const picked = await openFile([{ name: 'Stipple project', extensions: ['stipple', 'json'] }]);
    if (!picked) return;
    try {
      const project = JSON.parse(new TextDecoder().decode(picked.bytes)) as Project;
      if (project.version !== 1) throw new Error(`unsupported project version ${project.version}`);
      // Built-ins are not stored per-project by identity, so make sure a project
      // saved before a built-in existed still resolves every shape reference.
      const ids = new Set(project.shapes.map((s) => s.id));
      project.shapes = [...BUILTIN_SHAPES.filter((s) => !ids.has(s.id)), ...project.shapes];

      this.store.load(project);
      // Raster shapes carry their pixels as data URLs; decode them before the
      // atlas tries to build distance fields.
      for (const def of project.shapes) {
        if (def.kind !== 'raster') continue;
        const bmp = await rasterBitmap(def);
        this.shapes.registerBitmap(def.id, bmp);
        this.engine.setShapeBitmap(def.id, bmp);
      }
      this.store.updateShapes(project.shapes);
      this.layers.render();
      this.layers.select(project.layers[0]?.id ?? null);
      this.shapes.render(this.selectedShapeId());
      this.notify(`Loaded ${picked.name}`);
    } catch (err) {
      this.notify(`Could not load project: ${(err as Error).message}`, true);
    }
  }

  private toastTimer = 0;
  private notify(message: string, isError = false): void {
    this.toast.textContent = message;
    this.toast.classList.toggle('error', isError);
    this.toast.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('visible'), 4000);
  }

  // -- loop ----------------------------------------------------------------

  private frameTimes: number[] = [];
  private autoRender = true;
  private loop = (): void => {
    const t0 = performance.now();
    try {
      if (this.autoRender) this.engine.render();
    } catch (err) {
      this.notify(`Render error: ${(err as Error).message}`, true);
      console.error(err);
    }
    const dt = performance.now() - t0;
    if (dt > 0.05) {
      this.frameTimes.push(dt);
      if (this.frameTimes.length > 30) this.frameTimes.shift();
    }
    this.updateHUD();
    requestAnimationFrame(this.loop);
  };

  private updateHUD(): void {
    const s = this.engine.stats;
    const avg = this.frameTimes.length
      ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
      : 0;
    this.hud.textContent =
      `${s.points.toLocaleString()} pts · ${s.layers} layer${s.layers === 1 ? '' : 's'} · ` +
      `gen ${s.generateMs.toFixed(1)}ms · draw ${s.renderMs.toFixed(1)}ms · ` +
      `${avg.toFixed(1)}ms/update · ${Math.round(this.engine.getViewport().zoom * 100)}%`;
  }
}

/** Adapt a native decode result to the engine's `ImageSource` shape. */
function toSource(
  decoded: { width: number; height: number; rgba: Uint8Array } | null,
): { width: number; height: number; rgba: Uint8ClampedArray } {
  if (!decoded) throw new Error('native decoding is unavailable here');
  return {
    width: decoded.width,
    height: decoded.height,
    rgba: new Uint8ClampedArray(decoded.rgba.buffer, decoded.rgba.byteOffset, decoded.rgba.length),
  };
}
