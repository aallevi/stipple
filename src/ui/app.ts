import { defaultProject, BUILTIN_SHAPES } from '../core/defaults';
import { Store } from '../core/store';
import type { Project } from '../core/types';
import { exportPDF } from '../export/pdf';
import { exportPlates, planPlates } from '../export/plates';
import { exportPNG } from '../export/png';
import { estimatePoints, exportSVG, WARN_POINTS } from '../export/svg';
import { decodeImage } from '../image/loader';
import type { ImageSource } from '../image/density';
import { testCard } from '../image/testcard';
import { Engine } from '../pipeline/engine';
import { decodeNative, isTauri, openFile, saveFile, saveFiles, supportedImageExtensions, type PickedFile } from '../platform';
import { rasterBitmap } from '../shape/import';
import { button, colorControl, h, raw, readout, section, select, slider, type Control, type Interaction, installTouchSliders } from './controls';
import { InksPanel } from './inks';
import { Inspector } from './inspector';
import { extractPalette } from '../core/color';
import type { PreviewInks } from '../gl/composite';
import { LayersPanel } from './layers';
import { ShapesPanel } from './shapes';
import { PRESETS } from './presets';
import markSvg from '../../assets/brand/mark.svg?raw';
import { formatLength } from './units';

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
  private inks!: InksPanel;
  private layers: LayersPanel;
  private shapes: ShapesPanel;
  private inspector: Inspector;
  private hud = h('div', { class: 'hud' });
  private toast = h('div', { class: 'toast' });
  /** A thin bar while layers are being built, in place of a frozen window. */
  private progressFill = h('div', { class: 'progress-fill' });
  private progressLabel = h('span', { class: 'progress-label' });
  private progressBar = h('div', { class: 'progress', hidden: '' }, this.progressFill, this.progressLabel);
  /**
   * What the canvas shows before there is a picture: a place to drop one. The
   * app used to start on a synthetic test card so there was "always something
   * on screen", but a stippled gradient you did not ask for is not something —
   * it is noise to clear before you can begin. The card is still there for the
   * verification run, behind `?testcard`.
   */
  private dropZone = h('div', { class: 'drop-zone' },
    h('div', { class: 'drop-zone-inner' },
      h('p', { class: 'drop-zone-title' }, 'Drop an image here'),
      button('Open image\u2026', () => void this.openImage()),
      h('p', { class: 'drop-zone-hint' }, 'PNG, JPEG, WebP or GIF. It stays on your device.'),
    ),
  );
  private interaction: Interaction;
  private document!: Control;

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

    this.layers = new LayersPanel(this.store, (id) => {
      // Selecting a layer is not a store change, so the shape grid has to be
      // told directly which of its tiles is now the current one.
      this.shapes.setSelected(this.store.layer(id)?.shapeId);
      this.inspector.update(id);
      this.inks.update();
      this.syncPreviewInks();
    });
    this.shapes = new ShapesPanel(
      this.store,
      (id, bmp) => {
        this.shapes.registerBitmap(id, bmp);
        this.engine.setShapeBitmap(id, bmp);
      },
      (shapeId) => {
        if (this.layers.selected) this.store.editLayer(this.layers.selected, { shapeId });
      },
    );
    this.inspector = new Inspector(
      this.store,
      this.interaction,
      this.shapes,
      this.engine.voronoiAvailable,
      () => this.engine.sourceImage,
      (done) => this.pickColour(done),
      (layerId) => this.inks.make('spot', 3, layerId),
      () => {
        const sec = this.inks.el.querySelector('.section');
        sec?.classList.remove('collapsed');
        this.inks.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    );
    this.inks = new InksPanel(this.store, this.interaction, {
      getSource: () => this.engine.sourceImage,
      pickColour: (done) => this.pickColour(done),
      selection: () => ({ layer: this.layers.selected, group: this.layers.selectedGroup }),
      selectGroup: (gid) => this.layers.selectGroup(gid),
      exportPlates: () => void this.doExportPlates(),
      expectHeavy: () => this.engine.expectHeavy(),
      notify: (m, e) => this.notify(m, e),
    });

    root.append(this.buildLayout());
    this.toolbarAnchor = this.compare.el.previousElementSibling;
    this.placeCompare();
    this.stacked.addEventListener('change', () => this.placeCompare());
    installTouchSliders(root);
    this.bindViewport();
    this.bindDrop();
    this.bindSplit();
    this.compare.sync();
    this.bindKeys();

    this.store.subscribe((project, change) => {
      this.engine.sync(project, change);
      if (change.structural) this.layers.render();
      if (change.shapes) this.shapes.render(this.selectedShapeId());
      else this.shapes.setSelected(this.selectedShapeId());
      this.inspector.update(this.layers.selected);
      this.inks.update();
      this.syncPreviewInks();
      // Undo, a preset and a freshly opened image all rewrite the canvas
      // settings without going through those controls, so push the values back.
      if (change.global) this.document.sync();
    });

    if (new URLSearchParams(location.search).has('testcard')) {
      this.engine.setSource(testCard());
      this.dropZone.hidden = true;
    } else {
      // A blank white sheet: nothing to measure, so no dots until an image arrives.
      this.engine.setSource(blankSource());
    }
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
    const presetSel = h('select', { class: 'preset-select', title: 'Load a starting point' }) as HTMLSelectElement;
    presetSel.append(h('option', { value: '' }, 'Presets…'));
    for (const p of PRESETS) presetSel.append(h('option', { value: p.name }, p.name));
    presetSel.addEventListener('change', () => {
      this.engine.expectHeavy();
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

    this.document = this.documentSection();
    this.document.sync();

    // The toolbar reads left to right as the workflow does — bring an image in,
    // frame it, step through history, start from a preset — with everything that
    // sends work back out grouped together on the far right.
    return h('div', { class: 'app' },
      h('header', { class: 'toolbar' },
        h('span', { class: 'brand' }, brandMark(), 'Stipple'),
        h('div', { class: 'tool-group' },
          button('Open image…', () => void this.openImage(), 'primary', 'Open an image to stipple (⌘O)'),
        ),
        h('div', { class: 'tool-group' },
          button('Fit', () => this.fitToWindow(), '', 'Fit the canvas to the window (0)'),
          button('100%', () => {
            this.engine.setViewport({ zoom: 1, panX: 0, panY: 0 });
            this.fitted = false;
            this.store.requestRedraw();
          }, '', 'View at one canvas pixel per screen pixel'),
        ),
        // How you look at the picture sits with how it is framed.
        this.compare.el,
        h('div', { class: 'tool-group' },
          button('Undo', () => this.store.undo(), '', 'Undo (⌘Z)'),
          button('Redo', () => this.store.redo(), '', 'Redo (⇧⌘Z)'),
        ),
        presetSel,
        h('span', { class: 'spacer' }),
        h('span', { class: 'tool-caption' }, 'Export'),
        this.exportMenu(),
        h('div', { class: 'tool-group export-buttons' },
          button('PNG', () => void this.doExport('png'), '', 'Export a raster image at the document resolution'),
          button('SVG', () => void this.doExport('svg'), '', 'Export vector geometry'),
          button('PDF', () => void this.doExport('pdf'), '', 'Export a print-ready vector PDF'),
        button('Plates', () => void this.doExportPlates(), '',
          'One black-on-white film per ink, plus a colour proof — for screenprinting'),
        ),
        h('div', { class: 'tool-group' },
          button('Save', () => void this.saveProject(), '', 'Save the project file'),
          button('Load', () => void this.loadProject(), '', 'Open a saved project file'),
        ),
      ),
      this.compareRow,
      h('main', { class: 'main' },
        this.stage,
        // Global first, then the stack, then the selected layer's chain: the
        // sidebar narrows from the whole document down to one layer.
        h('aside', { class: 'sidebar' },
          this.document.el,
          this.inks.el,
          this.layers.el,
          this.inspector.el,
        ),
      ),
    );
  }

  /**
   * Export as one menu whose every entry says what it makes.
   *
   * The buttons rely on tooltips to explain themselves, and a touch screen has
   * no hover, so on a phone "PDF" and "Plates" were four guesses. The stylesheet
   * shows this in their place under a coarse pointer; on a desktop it is hidden.
   */
  private exportMenu(): HTMLElement {
    const sel = h('select', { class: 'export-select', 'aria-label': 'Export' }) as HTMLSelectElement;
    const entries: [string, string, () => void][] = [
      ['png', 'PNG \u2014 a picture file, at the document\u2019s pixel size', () => void this.doExport('png')],
      ['svg', 'SVG \u2014 vector drawing, sharp at any size', () => void this.doExport('svg')],
      ['pdf', 'PDF \u2014 vector, print-ready at the document\u2019s size', () => void this.doExport('pdf')],
      ['plates', 'Plates \u2014 one black film per ink, for burning screens', () => void this.doExportPlates()],
    ];
    sel.append(h('option', { value: '' }, 'Export\u2026'));
    for (const [value, label] of entries) sel.append(h('option', { value }, label));
    sel.addEventListener('change', () => {
      const entry = entries.find(([v]) => v === sel.value);
      sel.value = '';
      entry?.[2]();
    });
    return sel;
  }

  /**
   * Canvas size, resolution and background.
   *
   * Size is staged, not applied live. Resizing the document invalidates every
   * cache in the engine and re-runs every distribution, so typing a width digit
   * by digit would queue a full rebuild per keystroke, each one a size nobody
   * wanted. The fields show what you are about to get; Apply commits it.
   *
   * Each edge is shown twice, in canvas pixels and in print length, because
   * they answer different questions: pixels are how detailed the file is,
   * millimetres are how big the print is, and resolution is the exchange rate
   * between them. So changing resolution keeps the print size and changes the
   * pixel count — more dpi, finer file, same sheet — the way an image editor
   * resamples. And because every length in a layer is a fraction of the
   * picture, enlarging the document is a true upscale: the same drawing, the
   * same marks, each drawn with more pixels.
   */
  private documentSection(): Control {
    const store = this.store;
    const project = store.get();
    const pending = { width: project.canvas.width, height: project.canvas.height, dpi: project.canvas.dpi };
    let locked = true;
    const MIN_PX = 128;
    const MAX_PX = 8000;

    const physical = (): 'mm' | 'in' => (this.store.get().canvas.units === 'in' ? 'in' : 'mm');
    const toLen = (px: number, dpi: number): number => (physical() === 'in' ? px / dpi : (px / dpi) * 25.4);
    const fromLen = (len: number, dpi: number): number => (physical() === 'in' ? len * dpi : (len / 25.4) * dpi);
    const clampPx = (v: number): number => Math.round(Math.min(MAX_PX, Math.max(MIN_PX, v)));

    const apply = button('Apply', () => {
      const w = Math.round(pending.width);
      const ht = Math.round(pending.height);
      this.engine.expectHeavy();
      this.store.updateCanvas({ width: w, height: ht, dpi: Math.round(pending.dpi) });
      this.fitToWindow();
      this.notify(`Document set to ${w} × ${ht} px at ${Math.round(pending.dpi)} dpi`);
      refresh();
    }, 'sm primary', 'Resize the document to the staged size and resolution');

    const dirty = (): boolean => {
      const c = this.store.get().canvas;
      return Math.round(pending.width) !== c.width || Math.round(pending.height) !== c.height
        || Math.round(pending.dpi) !== c.dpi;
    };
    let refresh = (): void => {};

    /**
     * Stage one edge in pixels. With the ratio locked, the other edge follows so
     * the picture keeps its shape — and if that pushes it past the limits, both
     * are pulled back together rather than one being clipped out of proportion.
     */
    const stageEdge = (edge: 'width' | 'height', px: number): void => {
      const other = edge === 'width' ? 'height' : 'width';
      if (!locked) {
        pending[edge] = clampPx(px);
      } else {
        const ratio = pending[other] / pending[edge];
        let a = px;
        let b = px * ratio;
        const over = Math.max(a, b) / MAX_PX;
        const under = Math.min(a, b) / MIN_PX;
        if (over > 1) { a /= over; b /= over; }
        if (under < 1) { a /= under; b /= under; }
        pending[edge] = clampPx(a);
        pending[other] = clampPx(b);
      }
      refresh();
    };

    const field = (step: string): HTMLInputElement =>
      h('input', { type: 'number', class: 'num', step, min: '0', inputmode: 'decimal' }) as HTMLInputElement;
    const edgeRow = (edge: 'width' | 'height', label: string): { el: HTMLElement; sync(): void } => {
      const px = field('1');
      const len = field('0.1');
      const lenUnit = h('span', { class: 'unit' }, 'mm');
      px.addEventListener('change', () => stageEdge(edge, parseFloat(px.value) || pending[edge]));
      len.addEventListener('change', () => {
        const v = parseFloat(len.value);
        stageEdge(edge, Number.isFinite(v) && v > 0 ? fromLen(v, pending.dpi) : pending[edge]);
      });
      return {
        el: h('div', { class: 'size-row' },
          h('span', { class: 'ctl-label' }, label),
          h('span', { class: 'size-field' }, px, h('span', { class: 'unit' }, 'px')),
          h('span', { class: 'size-field' }, len, lenUnit),
        ),
        sync() {
          px.value = String(Math.round(pending[edge]));
          const d = physical() === 'in' ? 2 : 1;
          len.value = toLen(pending[edge], pending.dpi).toFixed(d);
          lenUnit.textContent = physical();
        },
      };
    };

    const widthRow = edgeRow('width', 'Width');
    const heightRow = edgeRow('height', 'Height');
    // The chain sits beside both rows, the way a linked pair is drawn in a
    // layout tool: one link, two edges.
    const lock = h('button', {
      class: 'size-lock on', type: 'button', 'aria-pressed': 'true',
      title: 'Keep the proportions: changing one edge changes the other',
    }, h('span', { class: 'size-lock-icon' }));
    lock.addEventListener('click', () => {
      locked = !locked;
      lock.classList.toggle('on', locked);
      lock.setAttribute('aria-pressed', String(locked));
    });
    const sizeBlock: Control = {
      el: h('div', { class: 'size-block' }, h('div', { class: 'size-rows' }, widthRow.el, heightRow.el), lock),
      sync() { widthRow.sync(); heightRow.sync(); },
    };

    /**
     * Twice the pixels on the same sheet: resolution and pixel count move
     * together, so the print size, the halftone screen and every mark stay
     * exactly as they are and the file simply gets finer. That is the upscale —
     * a bigger sheet would be a different print, with more screen cells across
     * it. Proportional whether or not the link is closed.
     */
    const scaleBy = (k: number): void => {
      const dpi = Math.min(1200, Math.max(36, Math.round(pending.dpi * k)));
      const real = dpi / pending.dpi;
      const w = pending.width * real;
      const ht = pending.height * real;
      const fit = Math.min(1, MAX_PX / Math.max(w, ht));
      const lift = Math.max(1, MIN_PX / Math.min(w * fit, ht * fit));
      pending.width = clampPx(w * fit * lift);
      pending.height = clampPx(ht * fit * lift);
      pending.dpi = dpi;
      refresh();
    };

    const controls: Control[] = [
      sizeBlock,
      // DPI changes keep the print size and move the pixel count.
      slider({
        label: 'Resolution', min: 36, max: 1200, step: 1, unit: 'dpi',
        title: 'Dots per inch of paper. Raising it keeps the print size and gives the file '
          + 'more pixels — a finer PNG, with every mark drawn larger in pixels',
        get: () => pending.dpi,
        set: (v) => {
          const dpi = Math.round(v);
          const k = dpi / pending.dpi;
          pending.dpi = dpi;
          const w = pending.width * k;
          const ht = pending.height * k;
          const fit = Math.min(1, MAX_PX / Math.max(w, ht));
          pending.width = clampPx(w * fit);
          pending.height = clampPx(ht * fit);
          refresh();
        },
      }),
      raw(h('div', { class: 'size-actions' },
        h('span', { class: 'ctl-label' }, 'Scale'),
        button('½×', () => scaleBy(0.5), 'sm', 'Half the pixels on the same sheet — a lighter file'),
        button('2×', () => scaleBy(2), 'sm', 'Twice the pixels on the same sheet — the same print, '
          + 'exported with twice the detail'),
      )),
      readout(() => {
        const c = this.store.get().canvas;
        const w = Math.round(pending.width);
        const ht = Math.round(pending.height);
        const u = physical();
        const d = u === 'in' ? 2 : 0;
        const size = `${toLen(w, pending.dpi).toFixed(d)} × ${toLen(ht, pending.dpi).toFixed(d)} ${u} at ${Math.round(pending.dpi)} dpi`;
        const pxChange = c.width !== w ? ` (${c.width} → ${w} px wide)` : '';
        return dirty() ? `${size}${pxChange} — press Apply` : `${w} × ${ht} px · ${size}`;
      }),
      // Every length in the panel is written in this. The engine is unaffected —
      // it works in canvas pixels whatever this says.
      select<'mm' | 'in' | '%' | 'px'>({
        label: 'Show lengths in',
        title: 'How dot sizes, spacings and blur are written in the panel. Changes nothing '
          + 'about the picture or the export',
        options: [
          { value: 'mm', label: 'Millimetres' },
          { value: 'in', label: 'Inches' },
          { value: '%', label: 'Per cent of the short edge' },
          { value: 'px', label: 'Canvas pixels' },
        ],
        get: () => this.store.get().canvas.units,
        set: (v) => this.store.updateCanvas({ units: v }),
      }),
      colorControl({
        label: 'Background', interaction: this.interaction,
        get: () => this.store.get().canvas.background,
        set: (v) => this.store.updateCanvas({ background: v }),
      }),
    ];

    const sec = section('Document', controls, true, [apply],
      'The sheet everything is drawn on. Pixels are how detailed the file is, millimetres how big '
      + 'the print is, and resolution links the two. To upscale \u2014 a finer PNG of the same '
      + 'print \u2014 press 2\u00d7 or raise the resolution: the dots stay the same, each drawn with '
      + 'more pixels. Typing a bigger size in millimetres makes a bigger print instead. Nothing '
      + 'changes until you press Apply. \u201cShow lengths in\u201d only changes how sizes are '
      + 'written in the panel, never the picture.');
    refresh = (): void => {
      apply.disabled = !dirty();
      apply.classList.toggle('pending', dirty());
      for (const c of controls) c.sync();
    };

    // An undo, a preset or an opened image resizes the document without going
    // through these controls. Re-stage from the project when that happens, or
    // Apply would sit lit up offering to undo a change the user never made.
    const key = (): string => {
      const c = store.get().canvas;
      return `${c.width}x${c.height}@${c.dpi}`;
    };
    let seen = key();
    return {
      el: sec.el,
      sync() {
        const now = key();
        if (now !== seen) {
          seen = now;
          const c = store.get().canvas;
          pending.width = c.width;
          pending.height = c.height;
          pending.dpi = c.dpi;
        }
        refresh();
      },
    };
  }

  // -- viewport ------------------------------------------------------------

  /** Waiting for a tap on the picture to sample, or null. */
  private picking: ((c: [number, number, number, number]) => void) | null = null;

  /**
   * Arm the eyedropper. The next press on the picture samples the photo — not
   * the drawing — under it, averaged over a few pixels so a single noisy pixel
   * does not decide the colour. Esc, or a press off the picture, cancels.
   */
  pickColour(done: (c: [number, number, number, number]) => void): void {
    if (!this.engine.sourceImage || !this.dropZone.hidden) {
      this.notify('Open a picture first, then pick a colour from it', true);
      return;
    }
    this.picking = done;
    this.canvas.classList.add('picking');
    this.notify('Tap the picture on the colour you want \u2014 Esc cancels');
  }

  private endPicking(): void {
    this.picking = null;
    this.canvas.classList.remove('picking');
  }

  private samplePhoto(clientX: number, clientY: number): [number, number, number, number] | null {
    const src = this.engine.sourceImage;
    if (!src) return null;
    const r = this.pictureRect();
    const box = this.stage.getBoundingClientRect();
    const u = (clientX - box.left - r.x) / r.w;
    const v = (clientY - box.top - r.y) / r.h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const cx = Math.min(src.width - 1, Math.floor(u * src.width));
    const cy = Math.min(src.height - 1, Math.floor(v * src.height));
    let rr = 0, gg = 0, bb = 0, n = 0;
    for (let y = Math.max(0, cy - 2); y <= Math.min(src.height - 1, cy + 2); y++) {
      for (let x = Math.max(0, cx - 2); x <= Math.min(src.width - 1, cx + 2); x++) {
        const o = (y * src.width + x) * 4;
        rr += src.rgba[o]; gg += src.rgba[o + 1]; bb += src.rgba[o + 2]; n += 1;
      }
    }
    return [rr / n / 255, gg / n / 255, bb / n / 255, 1];
  }

  private bindViewport(): void {
    // The eyedropper goes first and swallows the press, so picking a colour
    // never also pans the view.
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.picking) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const done = this.picking;
      const c = this.samplePhoto(e.clientX, e.clientY);
      this.endPicking();
      if (c) {
        done(c);
        this.notify('Colour picked');
      } else {
        this.notify('That was off the picture \u2014 nothing picked');
      }
    });

    // Every pointer on the canvas, by id. One pans; two pinch — zooming by the
    // change in their spread and panning by the travel of their midpoint, so
    // the point between your fingers stays under your fingers.
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; midX: number; midY: number } | null = null;

    const spread = (): { dist: number; midX: number; midY: number } => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.canvas.setPointerCapture(e.pointerId);
      pinch = pointers.size === 2 ? spread() : null;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pinch && pointers.size === 2) {
        const now = spread();
        const v = this.engine.getViewport();
        this.engine.setViewport({ panX: v.panX + now.midX - pinch.midX, panY: v.panY + now.midY - pinch.midY });
        if (pinch.dist > 0) this.zoomAbout(now.midX, now.midY, v.zoom * (now.dist / pinch.dist));
        pinch = now;
      } else if (pointers.size === 1) {
        const v = this.engine.getViewport();
        this.engine.setViewport({ panX: v.panX + dx, panY: v.panY + dy });
      } else {
        return;
      }
      this.fitted = false;
      this.store.requestRedraw();
    });
    const stop = (e: PointerEvent): void => {
      pointers.delete(e.pointerId);
      this.canvas.releasePointerCapture?.(e.pointerId);
      // Lifting one finger of a pinch leaves the other panning from where it is.
      pinch = null;
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
    this.canvas.addEventListener('dblclick', () => this.fitToWindow());

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = this.engine.getViewport();
      this.zoomAbout(e.clientX, e.clientY, v.zoom * Math.exp(-e.deltaY * 0.0015));
      this.fitted = false;
      this.store.requestRedraw();
    }, { passive: false });

    // Rotating a phone, or a window resize, keeps a fitted view fitted. A view
    // you have framed by hand is left exactly where you put it.
    window.addEventListener('resize', () => {
      if (this.fitted) this.fitToWindow();
      else this.store.requestRedraw();
    });
  }

  /**
   * Zoom about a point on screen. Anchoring to the canvas centre instead means
   * the detail you were looking at slides off screen as you zoom into it, which
   * is what makes a zoomed-in view impossible to relate to the whole image.
   */
  private zoomAbout(clientX: number, clientY: number, target: number): void {
    const v = this.engine.getViewport();
    const zoom = Math.min(8, Math.max(0.05, target));
    const { width, height } = this.store.get().canvas;
    const rect = this.canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const px = (cx - v.panX - (rect.width - width * v.zoom) / 2) / v.zoom;
    const py = (cy - v.panY - (rect.height - height * v.zoom) / 2) / v.zoom;
    this.engine.setViewport({
      zoom,
      panX: cx - (rect.width - width * zoom) / 2 - px * zoom,
      panY: cy - (rect.height - height * zoom) / 2 - py * zoom,
    });
  }

  /** Whether the view is still the one `fitToWindow` chose. */
  private fitted = true;

  private fitToWindow(): void {
    const { width, height } = this.store.get().canvas;
    const rect = this.canvas.getBoundingClientRect();
    // A smaller margin on a small screen, where 48px is a sixth of the width.
    const margin = Math.min(48, Math.min(rect.width, rect.height) * 0.06);
    const zoom = Math.min((rect.width - margin) / width, (rect.height - margin) / height);
    this.engine.setViewport({ zoom: Math.max(0.05, zoom), panX: 0, panY: 0 });
    this.fitted = true;
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
      } else if (meta && (e.key === ']' || e.key === '[')) {
        // The compositing-tool convention for raising and lowering a layer, and
        // the one way to reorder the stack that needs neither aim nor a pointer.
        e.preventDefault();
        this.layers.nudge(e.key === ']' ? 1 : -1);
      } else if (e.key === '0') {
        this.fitToWindow();
      } else if (e.key === 'Escape' && this.picking) {
        this.endPicking();
        this.notify('Picking cancelled');
      }
    });
  }

  // -- files ---------------------------------------------------------------

  private async openImage(): Promise<void> {
    const extensions = await supportedImageExtensions();
    const picked = await openFile([{ name: 'Image', extensions }]);
    if (picked) await this.loadImage(picked);
  }

  /**
   * The stage takes a dropped image at any time — onto the empty drop zone, or
   * onto a drawing in progress to swap the picture under it. Shapes have their
   * own drop target in the Shape section, which catches its drops first.
   */
  private splitHandle = h('div', { class: 'split-handle', hidden: '' }, h('span', { class: 'split-grip' }));
  private compare = this.buildCompare();
  private stage = h('div', { class: 'stage' },
    this.canvas, this.splitHandle, this.dropZone, this.progressBar, this.hud, this.toast);

  private progressKey = '';
  private updateProgress(): void {
    const p = this.engine.progress;
    const key = p ? `${p.done}/${p.total}` : '';
    if (key === this.progressKey) return;
    this.progressKey = key;
    this.progressBar.hidden = !p;
    if (!p) return;
    // At least a sliver, so the bar is visibly there from the first frame.
    this.progressFill.style.width = `${Math.max(4, (p.done / Math.max(1, p.total)) * 100)}%`;
    this.progressLabel.textContent = p.total > 1 ? `Drawing layer ${Math.min(p.done + 1, p.total)} of ${p.total}\u2026` : 'Drawing\u2026';
  }

  /**
   * On an upright phone the toolbar is one row that scrolls sideways, which
   * would hide the view switch off-screen most of the time. So there it moves
   * to a slim row of its own under the toolbar; everywhere else it sits beside
   * Fit. The query is the stylesheet's stacked-layout one.
   */
  private compareRow = h('div', { class: 'compare-row' });
  private stacked = window.matchMedia('(max-width: 760px) and (min-height: 501px), (orientation: portrait) and (max-width: 1100px)');

  private placeCompare(): void {
    const el = this.compare.el;
    if (this.stacked.matches) {
      if (el.parentElement !== this.compareRow) this.compareRow.append(el);
    } else if (el.parentElement === this.compareRow) {
      this.toolbarAnchor?.after(el);
    }
  }
  private toolbarAnchor: Element | null = null;

  /**
   * Compare the drawing with the photo it came from, on screen only.
   *
   * A view, not a setting: nothing here is saved, undoable or exported, which is
   * the point — you can look at the original as much as you like without any of
   * it ending up in a file. The engine draws it in its screen pass, which the
   * exporters never use.
   */
  private buildCompare(): { el: HTMLElement; sync(): void } {
    const views = [
      ['drawing', 'Drawing', 'Show the drawing'],
      ['original', 'Original', 'Show the photo it was made from'],
      ['split', 'Split', 'Photo on the left, drawing on the right \u2014 drag the divider'],
      ['inks', 'Inks', 'The picture in just the print\u2019s inks, flat \u2014 or in its own eight colours when there is no print yet'],
    ] as const;
    const buttons = views.map(([v, label, title]) => {
      const b = button(label, () => {
        this.engine.setPreview({ view: v });
        sync();
      }, 'sm', title);
      return [v, b] as const;
    });
    const under = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '0' }) as HTMLInputElement;
    const underRow = h('label', { class: 'ctl compare-under', title: 'Let the photo show faintly through the paper under the dots' },
      h('span', { class: 'ctl-label' }, 'Under'), under);
    under.addEventListener('input', () => {
      this.engine.setPreview({ under: Number(under.value) / 100 });
      under.style.setProperty('--fill', `${under.value}%`);
    });
    const el = h('div', { class: 'compare' },
      h('div', { class: 'tool-group' }, ...buttons.map(([, b]) => b)),
      underRow,
    );
    const sync = (): void => {
      const p = this.engine.getPreview();
      for (const [v, b] of buttons) b.classList.toggle('on', p.view === v);
      underRow.hidden = p.view === 'original' || p.view === 'inks';
      this.splitHandle.hidden = p.view !== 'split';
    };
    // Synced once the engine exists — see the constructor.
    return { el, sync };
  }

  /**
   * What the Inks view reduces the photo to: the print in hand, with its
   * paper and its way of dividing the picture — or, with no print, the
   * picture's own eight colours, found by the same clustering as "Sample the
   * colours".
   */
  private previewInksKey = '';
  private autoInks: { pic: unknown; colours: [number, number, number][] } | null = null;
  private syncPreviewInks(): void {
    const a = this.inks?.active();
    const pic = this.engine.sourceImage;
    let spec: PreviewInks | undefined;
    if (a) {
      const list = this.inks.inks(a.id);
      const f = list[0]?.prefilter;
      const ranges = !!f?.nearestRanges && list.every((l) => l.prefilter.nearestBand);
      const bg = this.store.get().canvas.background;
      spec = {
        colours: list.map((l) => { const c = l.prefilter.ink ?? l.color.color; return [c[0], c[1], c[2]]; }),
        mode: ranges ? 'ranges' : f?.nearestByTone ? 'tone' : 'colour',
        bands: ranges ? list.map((l) => l.prefilter.nearestBand!) : undefined,
        paper: f?.nearestPaper || ranges ? [bg[0], bg[1], bg[2]] : null,
      };
    } else if (pic) {
      if (this.autoInks?.pic !== pic) {
        this.autoInks = { pic, colours: extractPalette(pic, 8, null).map((c) => [c[0], c[1], c[2]] as [number, number, number]) };
      }
      spec = { colours: this.autoInks.colours, mode: 'colour', paper: null };
    }
    const key = JSON.stringify(spec ?? null);
    if (key === this.previewInksKey) return;
    this.previewInksKey = key;
    this.engine.setPreview({ inks: spec });
  }

  /** Where the picture sits on screen, in CSS pixels relative to the stage. */
  private pictureRect(): { x: number; y: number; w: number; h: number } {
    const { width, height } = this.store.get().canvas;
    const v = this.engine.getViewport();
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const w = width * v.zoom;
    const hh = height * v.zoom;
    return { x: v.panX + (cw - w) / 2, y: v.panY + (ch - hh) / 2, w, h: hh };
  }

  private bindSplit(): void {
    const handle = this.splitHandle;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        const r = this.pictureRect();
        const box = this.stage.getBoundingClientRect();
        const t = (ev.clientX - box.left - r.x) / Math.max(1, r.w);
        this.engine.setPreview({ split: Math.min(1, Math.max(0, t)) });
      };
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  /** Keep the divider on the picture as it is panned, zoomed and dragged. */
  private placeSplit(): void {
    const hasPicture = this.dropZone.hidden;
    this.compare.el.hidden = !hasPicture;
    this.compareRow.hidden = !hasPicture || this.compare.el.parentElement !== this.compareRow;
    if (this.splitHandle.hidden || !hasPicture) return;
    const r = this.pictureRect();
    const split = this.engine.getPreview().split;
    const top = Math.max(0, r.y);
    const bottom = Math.min(this.canvas.clientHeight, r.y + r.h);
    this.splitHandle.style.left = `${r.x + split * r.w}px`;
    this.splitHandle.style.top = `${top}px`;
    this.splitHandle.style.height = `${Math.max(0, bottom - top)}px`;
  }

  private bindDrop(): void {
    const stage = this.stage;
    const isFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    stage.addEventListener('dragover', (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      stage.classList.add('dropping');
    });
    stage.addEventListener('dragleave', (e) => {
      if (e.target === stage || !stage.contains(e.relatedTarget as Node)) stage.classList.remove('dropping');
    });
    stage.addEventListener('drop', (e) => {
      stage.classList.remove('dropping');
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      e.preventDefault();
      void file.arrayBuffer().then((buf) => this.loadImage({ name: file.name, bytes: new Uint8Array(buf) }));
    });
  }

  private async loadImage(picked: PickedFile): Promise<void> {
    try {
      // TIFF and friends have no web-view decoder; fall back to the Rust one,
      // which is only present in the desktop shell.
      const src = /\.tiff?$/i.test(picked.name) && picked.path
        ? toSource(await decodeNative(picked.path))
        : await decodeImage(picked.bytes);
      this.engine.expectHeavy();
      this.engine.setSource(src);
      this.dropZone.hidden = true;
      this.syncPreviewInks();
      // Take the image's *shape*, not its pixel count.
      //
      // Adopting the source dimensions outright, as this used to, meant the
      // document's physical size floated with whatever you opened: a 4000px
      // photograph became a thirteen-inch sheet at 300 dpi and a 1200px one
      // became four. Layer lengths are relative now (`core/scale.ts`), so the
      // drawing would survive that — but the print would not, and neither would
      // the halftone lineature, which is ruled against the paper. Holding the
      // long edge keeps the sheet the size you set it to.
      //
      // No detail is lost by this: the density map samples the source at its own
      // resolution regardless, so the canvas only decides how large the output
      // raster is — and Document still sets that to whatever you want.
      const c = this.store.get().canvas;
      const long = Math.max(c.width, c.height);
      const aspect = src.width / src.height;
      const width = aspect >= 1 ? long : Math.round(long * aspect);
      const height = aspect >= 1 ? Math.round(long / aspect) : long;
      this.store.updateCanvas({ width, height });
      this.fitToWindow();
      this.notify(
        `Loaded ${picked.name} (${src.width}×${src.height}) into a ` +
        `${width}×${height} document — ${formatLength(width, { ...c, width, height })} × ` +
        `${formatLength(height, { ...c, width, height })}`,
      );
    } catch (err) {
      this.notify(`Could not open ${picked.name}: ${(err as Error).message}`, true);
    }
  }

  private async doExport(kind: 'png' | 'svg' | 'pdf'): Promise<void> {
    const project = this.store.get();
    try {
      this.engine.prepareForExport();
      if (kind === 'png') {
        // 1:1. A canvas pixel is already 1/dpi of an inch, so the document's own
        // pixel dimensions *are* its print resolution — scaling by dpi/96 on top
        // of that, as this used to, made every export 3.125x too big at 300 dpi.
        const scale = 1;
        this.notify('Rendering PNG…');
        const blob = await exportPNG(this.engine, project, scale, (done, total) =>
          this.notify(`Rendering PNG… tile ${done}/${total}`));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await saveFile(bytes, 'stipple.png', [{ name: 'PNG', extensions: ['png'] }]);
        const { width: pw, height: ph, dpi } = project.canvas;
        this.notify(`Exported PNG at ${pw}×${ph} — ${(pw / dpi).toFixed(1)}×${(ph / dpi).toFixed(1)} in at ${dpi} dpi`);
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

  /**
   * Separate into films.
   *
   * The confirm is not ceremony: this writes a folder of files, and a stack
   * whose layers are not each a single ink will silently contribute nothing to
   * any plate. Showing the screens it found, by name, is the cheapest way to
   * catch that before you take the films to the exposure unit.
   */
  private async doExportPlates(): Promise<void> {
    const project = this.store.get();
    try {
      this.engine.prepareForExport();
      // Ask first, then build. The plan knows the screens and their names
      // without generating a byte of SVG, so cancelling costs nothing.
      const plan = planPlates(project, 'stipple');
      if (plan.files.length === 0) {
        this.notify(plan.warnings[0] ?? 'Nothing to separate.', true);
        return;
      }

      const summary = plan.files.map((name, i) => `  ${i + 1}. ${name}`).join('\n');
      const ok = confirm(
        `${plan.files.length} screen${plan.files.length === 1 ? '' : 's'} to burn, plus a colour proof:\n\n` +
        `${summary}\n\n${plan.warnings.length ? `${plan.warnings.join('\n')}\n\n` : ''}` +
        `Each film is black on white with registration marks in the margin.\n\nWrite the files?`,
      );
      if (!ok) return;

      const { files, warnings } = exportPlates(this.engine, project, { baseName: 'stipple' });
      const plates = files.filter((f) => !f.name.endsWith('-proof.svg'));
      const { dir, written, failed } = await saveFiles(files);
      if (dir === null) return;
      if (failed.length) {
        this.notify(`Wrote ${written.length} of ${files.length} files; ${failed[0].name} failed: ${failed[0].error}`, true);
        return;
      }
      this.notify(`Exported ${plates.length} plate${plates.length === 1 ? '' : 's'} and a proof`, warnings.length > 0);
    } catch (err) {
      this.notify(`Plate export failed: ${(err as Error).message}`, true);
    }
  }

  private async saveProject(): Promise<void> {
    // In a browser the file goes through the download flow, which names it by
    // its type: a bare `.stipple` comes out as `.stipple.txt` on iOS and is then
    // greyed out by the picker that should load it. As JSON it stays JSON.
    const name = isTauri() ? 'untitled.stipple' : 'untitled.stipple.json';
    await saveFile(JSON.stringify(this.store.get(), null, 2), name,
      [{ name: 'Stipple project', extensions: ['stipple', 'json'] }]);
    this.notify('Project saved');
  }

  private async loadProject(): Promise<void> {
    const picked = await openFile([{ name: 'Stipple project', extensions: ['stipple', 'json'] }], '');
    if (!picked) return;
    try {
      let project: Project;
      try {
        project = JSON.parse(new TextDecoder().decode(picked.bytes)) as Project;
      } catch {
        throw new Error(`${picked.name} is not a Stipple project`);
      }
      if (!project || !Array.isArray(project.layers) || !project.canvas) {
        throw new Error(`${picked.name} is not a Stipple project`);
      }
      // Version 1 files are converted on load (`normaliseProject`); anything
      // newer than this build knows was made by a later version of the app.
      if (![1, 2, 3].includes(project.version)) {
        throw new Error(`${picked.name} was saved by a newer version of Stipple`);
      }
      // Built-ins are not stored per-project by identity, so make sure a project
      // saved before a built-in existed still resolves every shape reference.
      const ids = new Set(project.shapes.map((s) => s.id));
      project.shapes = [...BUILTIN_SHAPES.filter((s) => !ids.has(s.id)), ...project.shapes];

      this.engine.expectHeavy();
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
    this.updateProgress();
    this.placeSplit();
    requestAnimationFrame(this.loop);
  };

  /**
   * Discrete chips rather than one run-on string: the numbers change at very
   * different rates, and separating them stops a jittering frame time from
   * shifting the point count sideways every frame.
   */
  private hudKey = '';
  private updateHUD(): void {
    const s = this.engine.stats;
    const avg = this.frameTimes.length
      ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
      : 0;
    const chips: [string, string][] = [
      ['points', s.points.toLocaleString()],
      ['layers', String(s.layers)],
      ['generate', `${s.generateMs.toFixed(1)} ms`],
      ['draw', `${s.renderMs.toFixed(1)} ms`],
      ['update', `${avg.toFixed(1)} ms`],
      ['zoom', `${Math.round(this.engine.getViewport().zoom * 100)}%`],
    ];
    // The loop runs every frame and `engine.render()` returns immediately when
    // nothing is dirty — but rebuilding these nodes anyway meant an idle app
    // still churned eighteen elements sixty times a second. On an idle frame no
    // value has moved (the frame-time average only shifts when work was done),
    // so the comparison holds and the DOM is left alone.
    const key = chips.map(([, v]) => v).join('|');
    if (key === this.hudKey) return;
    this.hudKey = key;

    this.hud.replaceChildren(...chips.map(([k, v]) =>
      h('span', { class: 'hud-chip' }, h('span', { class: 'hud-key' }, k), v)));
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

/** A small white image: a sheet with nothing on it, so no layer finds anything to draw. */
function blankSource(): ImageSource {
  const width = 16;
  const height = 16;
  return { width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(255) };
}

/** The app's mark — the icon's sphere, as a halftone that still reads at toolbar size. */
function brandMark(): HTMLElement {
  const el = h('span', { class: 'brand-mark', 'aria-hidden': 'true' });
  el.innerHTML = markSvg;
  return el;
}
