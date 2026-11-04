import { resolveLayer, unitPx } from '../core/scale';
import { Dirty, type Change, type Store } from '../core/store';
import type { Layer, Project } from '../core/types';
import { generateHalftone } from '../dist/halftone';
import { generateJittered } from '../dist/jittered';
import { generateVoronoi, VoronoiGPU } from '../dist/voronoi';
import type { GenContext, PointBuffer } from '../dist/types';
import { Compositor, DEFAULT_PREVIEW, type PreviewView } from '../gl/composite';
import { createContext, createFullscreenQuad, RenderTarget, type GL } from '../gl/context';
import { makeView, PointRenderer, type PointBatch } from '../gl/renderer';
import { DensityMap, type ImageSource } from '../image/density';
import { ShapeAtlas } from '../shape/atlas';

export type Viewport = { zoom: number; panX: number; panY: number };

export type Stats = {
  points: number;
  layers: number;
  generateMs: number;
  renderMs: number;
  /** Layers whose points were regenerated on the last update. */
  regenerated: number;
};

type LayerCache = {
  batch: PointBatch;
  density: DensityMap | null;
  densityKey: string;
  points: PointBuffer | null;
  pointsKey: string;
};

/** Hard ceiling per layer so a mistyped density cannot allocate unbounded memory. */
const MAX_POINTS_PER_LAYER = 4_000_000;
/** Largest internal render target edge; above this, memory cost outweighs detail. */
const MAX_RENDER_EDGE = 4096;
/** Point budget fraction used while a control is actively being dragged. */
const INTERACTIVE_QUALITY = 0.3;

/**
 * Owns every GPU resource and every cache, and decides what actually needs
 * recomputing when the project changes.
 *
 * The invalidation contract lives in `Store.Dirty`; this class is the half that
 * honours it. The payoff is concentrated in `sync()`: a colour edit walks the
 * layer list, finds nothing above `Dirty.Composite`, and goes straight to a
 * redraw without touching a single point.
 */
export class Engine {
  readonly gl: GL;
  readonly floatRender: boolean;
  readonly floatBlend: boolean;
  private atlas: ShapeAtlas;
  private renderer: PointRenderer;
  private compositor: Compositor;
  private quad: WebGLVertexArrayObject;
  private voronoi: VoronoiGPU | null;

  private caches = new Map<string, LayerCache>();
  private source: ImageSource | null = null;
  private sourceTex: WebGLTexture | null = null;
  private sourceId = 0;
  private shapeBitmaps = new Map<string, ImageBitmap>();

  private accum: RenderTarget | null = null;
  private scratch: RenderTarget | null = null;
  private layerTarget: RenderTarget | null = null;
  private renderW = 0;
  private renderH = 0;

  /** Background the `below` readbacks were composited over, to spot a change. */
  private belowGround = '';
  private viewport: Viewport = { zoom: 1, panX: 0, panY: 0 };
  private interactive = false;
  private needsRender = true;
  /**
   * The canvas-space composite is out of date. Separate from `needsRender`
   * because most redraws are a pan or a zoom, which change only how the
   * composite is shown — and recomposing every layer for those was the bulk of
   * what the preview cost.
   */
  private stackDirty = true;
  /** The composite was skipped while zoomed in (see `render`) and must be rebuilt before it is shown. */
  private baseStale = false;

  private markStack(): void {
    this.stackDirty = true;
    this.needsRender = true;
  }
  private lastQuality = 1;

  stats: Stats = { points: 0, layers: 0, generateMs: 0, renderMs: 0, regenerated: 0 };

  constructor(private canvas: HTMLCanvasElement, private store: Store) {
    const { gl, floatRender, floatBlend } = createContext(canvas);
    this.gl = gl;
    this.floatRender = floatRender;
    this.floatBlend = floatBlend;
    this.quad = createFullscreenQuad(gl);
    this.atlas = new ShapeAtlas(gl);
    this.renderer = new PointRenderer(gl);
    this.compositor = new Compositor(gl, this.quad);
    // Without float render targets and float blending the relaxation cannot run;
    // the layer then falls back to unrelaxed importance sampling, which still
    // reads as a stipple, just a less evenly spaced one.
    this.voronoi = floatRender && floatBlend ? new VoronoiGPU(gl) : null;

    this.atlas.sync(store.get().shapes, this.shapeBitmaps);
    this.belowGround = store.get().canvas.background.join(',');
    for (const layer of store.get().layers) this.cacheFor(layer.id);
  }

  get hasSource(): boolean {
    return this.source !== null;
  }

  get voronoiAvailable(): boolean {
    return this.voronoi !== null;
  }

  setSource(src: ImageSource): void {
    const { gl } = this;
    this.source = src;
    this.sourceId += 1;
    if (this.sourceTex) gl.deleteTexture(this.sourceTex);
    this.sourceTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, src.width, src.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, src.width, src.height, gl.RGBA, gl.UNSIGNED_BYTE, src.rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.store.invalidateAll();
  }

  setShapeBitmap(shapeId: string, bitmap: ImageBitmap): void {
    this.shapeBitmaps.set(shapeId, bitmap);
  }

  setViewport(v: Partial<Viewport>): void {
    this.viewport = { ...this.viewport, ...v };
    // A view change never recomposes the drawing: zoomed out, the cached
    // composite is just presented at a new size; zoomed in, the detail pass
    // redraws the visible part from the cached points.
    this.needsRender = true;
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  /**
   * Compare the drawing with the photo, on screen only. Stored here rather
   * than in the project, so it is not saved, not undoable and not exported:
   * it is a way of looking, not part of the work.
   */
  private preview: PreviewView = { ...DEFAULT_PREVIEW };

  setPreview(v: Partial<PreviewView>): void {
    this.preview = { ...this.preview, ...v };
    this.needsRender = true;
  }

  getPreview(): PreviewView {
    return this.preview;
  }

  /**
   * Enter or leave the low-latency path used while a slider is being dragged.
   * Leaving it forces a full-quality regeneration of everything that was thinned.
   */
  setInteractive(on: boolean): void {
    if (this.interactive === on) return;
    this.interactive = on;
    if (!on && this.lastQuality < 1) {
      for (const c of this.caches.values()) c.pointsKey = '';
      this.markStack();
    }
  }

  // -- invalidation --------------------------------------------------------

  /** Apply a store change, recomputing only the tiers that were invalidated. */
  sync(project: Project, change: Change): void {
    if (change.shapes) this.atlas.sync(project.shapes, this.shapeBitmaps);

    if (change.structural) {
      const live = new Set(project.layers.map((l) => l.id));
      for (const [id, cache] of this.caches) {
        if (!live.has(id)) {
          cache.batch.dispose();
          this.caches.delete(id);
        }
      }
      for (const layer of project.layers) this.cacheFor(layer.id);
    }

    if (change.global >= Dirty.Density) {
      for (const cache of this.caches.values()) {
        cache.densityKey = '';
        cache.pointsKey = '';
      }
    }
    for (const [id, level] of change.layers) {
      const cache = this.caches.get(id);
      if (!cache) continue;
      if (level >= Dirty.Density) cache.densityKey = '';
      if (level >= Dirty.Points) cache.pointsKey = '';
    }

    // A `below` layer's density is a readback of the stack under it, and its
    // cache key describes only the layer's own prefilter. `Store.markLayer`
    // cascades every *layer* edit upward, which covers most of it — but two
    // things repaint the stack without touching any layer: editing a shape,
    // which every layer that uses it is drawn from, and changing the background,
    // which the readback is composited over. Neither reaches the cascade, so
    // they are caught here instead.
    const ground = project.canvas.background.join(',');
    if (change.shapes || ground !== this.belowGround) {
      this.belowGround = ground;
      for (const layer of project.layers) {
        if (layer.input !== 'below') continue;
        const cache = this.caches.get(layer.id);
        if (!cache) continue;
        cache.densityKey = '';
        cache.pointsKey = '';
      }
    }

    this.markStack();
  }

  private cacheFor(id: string): LayerCache {
    let c = this.caches.get(id);
    if (!c) {
      c = {
        batch: this.renderer.createBatch(),
        density: null,
        densityKey: '',
        points: null,
        pointsKey: '',
      };
      this.caches.set(id, c);
    }
    return c;
  }

  /**
   * Cache keys are just serialised parameters. Cheap to build (these objects are
   * a handful of numbers) and impossible to get subtly wrong the way a manual
   * list of "which fields matter" would be.
   */
  private densityKeyFor(layer: Layer): string {
    // A `below` layer's input is the render target, whose size tracks the zoom
    // level, so that size belongs in the key.
    const res = layer.input === 'below' ? `${this.renderW}x${this.renderH}` : 'src';
    return `${this.sourceId}|${layer.input}|${res}|${JSON.stringify(layer.prefilter)}`;
  }

  /**
   * A closest-colour layer competes with every closest-colour layer in its
   * group, so what it measures depends on its siblings: give one a new colour
   * and the borders of all the others move. Working the set out here, each
   * render, and putting it on the prefilter means the density key changes for
   * every sibling the moment one changes — nothing has to remember to tell them.
   */
  private withCompetitors(layer: Layer, project: Project): Layer {
    if (layer.prefilter.channel !== 'nearest') return layer;
    const own = layer.prefilter.ink ?? layer.color.color;
    const peers = layer.groupId
      ? project.layers.filter((l) => l.groupId === layer.groupId && l.prefilter.channel === 'nearest')
      : [layer];
    const nearestSet = peers.map((l) => l.prefilter.ink ?? l.color.color);
    return {
      ...layer,
      prefilter: {
        ...layer.prefilter,
        ink: own,
        nearestSet,
        nearestPaperColor: layer.prefilter.nearestPaper ? project.canvas.background : null,
      },
    };
  }

  private pointsKeyFor(layer: Layer, canvasW: number, canvasH: number, quality: number): string {
    // A halftone screen sizes its cell from the document DPI, so DPI is one of
    // its inputs and belongs in its key. No other algorithm reads it, and making
    // them all miss on a DPI change would regenerate millions of points for a
    // number none of them use.
    const dpi = layer.distribution.algo === 'halftone' ? this.store.get().canvas.dpi : 0;
    return `${canvasW}x${canvasH}|${dpi}|${quality}|${JSON.stringify(layer.distribution)}|${JSON.stringify(layer.mask)}`;
  }

  // -- rendering -----------------------------------------------------------

  render(force = false): void {
    if (!this.needsRender && !force) return;
    if (!this.source) {
      this.clearScreen();
      this.needsRender = false;
      return;
    }
    const project = this.store.get();
    const t0 = performance.now();

    const quality = this.interactive ? INTERACTIVE_QUALITY : 1;
    this.lastQuality = quality;

    if (this.ensureTargets(project)) this.stackDirty = true;
    const { gl } = this;

    // Zoomed in past the composite's own resolution, the screen is drawn by the
    // detail pass, so the composite only has to be *right* for the layers that
    // read it back (`below`). If none do, the draws into it are skipped and it
    // is rebuilt the next time it is actually shown.
    const magnifying = this.magnifying(project);
    const needsBase = !magnifying || project.layers.some((l) => l.visible && l.input === 'below');
    if (!this.stackDirty && !force && !(this.baseStale && !magnifying)) {
      this.presentToScreen(project);
      this.needsRender = false;
      return;
    }
    this.stackDirty = false;
    this.baseStale = !needsBase;

    this.accum!.clear(0, 0, 0, 0);
    let base = this.accum!;
    let other = this.scratch!;

    let genMs = 0;
    let regenerated = 0;
    let totalPoints = 0;

    // Layer lengths are stored relative to the document (see `core/scale.ts`);
    // this is the conversion, and everything below it works in canvas pixels.
    const unit = unitPx(project.canvas);

    for (const raw of project.layers) {
      if (!raw.visible || raw.opacity <= 0) continue;
      const layer = this.withCompetitors(resolveLayer(raw, unit), project);
      const cache = this.cacheFor(layer.id);

      // A `below` layer reads the composite underneath it, so its density has to
      // be rebuilt whenever anything below it moved. `Store` already cascaded the
      // dirty flag; here we just honour it by reading back the accumulator.
      const dKey = this.densityKeyFor(layer);
      const needsDensity = cache.densityKey !== dKey || (layer.input === 'below' && !cache.density);
      if (needsDensity) {
        const src = layer.input === 'below' ? this.readbackAsSource(base) : this.source;
        // Spatial filters are specified in canvas pixels; the density map may be
        // at a different resolution (a large photo, or a readback taken at the
        // current render scale), so tell it the ratio.
        const pixelScale = src.width / project.canvas.width;
        cache.density = DensityMap.fromSource(src, layer.prefilter, pixelScale);
        cache.densityKey = dKey;
        cache.pointsKey = '';
      } else if (layer.input === 'below') {
        // Stale-but-valid: the layers below did not change, so the cached
        // readback still describes them.
      }

      const pKey = this.pointsKeyFor(layer, project.canvas.width, project.canvas.height, quality);
      if (cache.pointsKey !== pKey || !cache.points) {
        const g0 = performance.now();
        cache.points = this.generate(layer, cache.density!, project, quality, unit);
        cache.batch.upload(cache.points.data, cache.points.count);
        cache.pointsKey = pKey;
        genMs += performance.now() - g0;
        regenerated += 1;
      }
      totalPoints += cache.points.count;

      const slot = this.atlas.get(layer.shapeId) ?? this.atlas.get('circle');
      if (!slot) continue;
      if (!needsBase) continue;

      const scale = this.renderW / project.canvas.width;
      this.layerTarget!.clear(0, 0, 0, 0);
      this.atlas.bind(0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);

      this.renderer.draw({
        batch: cache.batch,
        layer,
        slot,
        // Internal targets are canvas-space; pan and zoom are applied when
        // presenting, so panning never re-runs the stack.
        view: makeView(
          project.canvas.width, project.canvas.height,
          this.renderW, this.renderH,
          { zoom: scale, panX: 0, panY: 0 },
          layer.transform,
        ),
        canvas: [project.canvas.width, project.canvas.height],
        atlasUnit: 0,
        imageUnit: 1,
        sizeScale: scale,
      });

      other.bind();
      this.compositor.composite(base.texture, this.layerTarget!.texture, layer.blend, layer.opacity);
      const t = base;
      base = other;
      other = t;
    }

    // Whichever target the ping-pong ended on holds the result.
    this.finalTarget = base;
    this.finalTexture = base.texture;
    this.presentToScreen(project);

    this.stats = {
      points: totalPoints,
      layers: project.layers.filter((l) => l.visible).length,
      generateMs: genMs,
      renderMs: performance.now() - t0 - genMs,
      regenerated,
    };
    this.needsRender = false;
  }

  private finalTexture: WebGLTexture | null = null;
  private finalTarget: RenderTarget | null = null;

  /** The composited stack, for export and for the `below` readback. */
  get composedTexture(): WebGLTexture | null {
    return this.finalTexture;
  }

  private generate(
    layer: Layer,
    density: DensityMap,
    project: Project,
    quality: number,
    unit: number,
  ): PointBuffer {
    const ctx: GenContext = {
      density,
      width: project.canvas.width,
      height: project.canvas.height,
      unit,
      mask: layer.mask,
      quality,
      maxPoints: MAX_POINTS_PER_LAYER,
    };
    switch (layer.distribution.algo) {
      case 'jittered':
        return generateJittered(layer.distribution, ctx);
      case 'halftone':
        return generateHalftone(layer.distribution, ctx);
      case 'voronoi':
        return generateVoronoi(layer.distribution, ctx, this.voronoi);
    }
  }

  /**
   * The canvas-space composite, at the document's own resolution.
   *
   * Below 1:1 the sub-pixel clamp in the point shader turns every mark into a
   * one-pixel dab, so a zoomed-out preview drawn at screen size showed an even
   * haze rather than the image the export contains; drawing the picture full
   * size and letting the mip chain average it down is what shows it truly.
   * Above 1:1 this target is not what you see — the detail pass is — so its
   * size no longer follows the zoom at all, and zooming never rebuilds it or
   * invalidates the `below` readbacks taken from it.
   *
   * Returns true when the targets were (re)created.
   */
  private ensureTargets(project: Project): boolean {
    const { gl } = this;
    const edge = Math.max(project.canvas.width, project.canvas.height);
    const clamp = edge > MAX_RENDER_EDGE ? MAX_RENDER_EDGE / edge : 1;
    const w = Math.max(1, Math.round(project.canvas.width * clamp));
    const h = Math.max(1, Math.round(project.canvas.height * clamp));

    if (this.renderW === w && this.renderH === h && this.accum) return false;
    this.accum?.dispose();
    this.scratch?.dispose();
    this.layerTarget?.dispose();
    this.finalTarget = null;
    this.finalTexture = null;
    // The ping-pong means either accumulator can end up being the one presented,
    // so both carry a mip chain; the per-layer target is only ever read 1:1.
    this.accum = new RenderTarget(gl, w, h, gl.RGBA8, gl.LINEAR, true);
    this.scratch = new RenderTarget(gl, w, h, gl.RGBA8, gl.LINEAR, true);
    this.layerTarget = new RenderTarget(gl, w, h);
    this.renderW = w;
    this.renderH = h;
    // The point buffers are canvas-space, so they survive a scale change; only
    // the targets are rebuilt.
    return true;
  }

  /** Device pixels per canvas pixel on screen, and whether that is past the composite's own. */
  private screenScale(project: Project): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return this.viewport.zoom * dpr * (project.canvas.width / Math.max(1, this.renderW || project.canvas.width));
  }

  private magnifying(project: Project): boolean {
    return this.screenScale(project) > 1.001;
  }

  // -- detail pass ----------------------------------------------------------

  private detail: { accum: RenderTarget; scratch: RenderTarget; layer: RenderTarget } | null = null;

  /**
   * Draw the visible part of the stack straight at screen resolution.
   *
   * Zoomed in, a composite stretched to fit the screen is a magnified bitmap,
   * and its marks go soft — the preview used to be crisp up to 2x and blurry
   * past it. The marks are vectors (signed-distance shapes, see
   * `shape/atlas.ts`), so the honest way to show them large is to draw them
   * large: the same cached points, the same shader, a view matrix for the
   * screen instead of the canvas. Nothing is regenerated, so this is as cheap
   * as a pan should be, and it is sharp at any zoom.
   */
  private drawDetail(project: Project, w: number, h: number, x: number, y: number, k: number): WebGLTexture {
    const { gl } = this;
    if (!this.detail || this.detail.accum.width !== w || this.detail.accum.height !== h) {
      this.detail?.accum.dispose();
      this.detail?.scratch.dispose();
      this.detail?.layer.dispose();
      this.detail = {
        accum: new RenderTarget(gl, w, h),
        scratch: new RenderTarget(gl, w, h),
        layer: new RenderTarget(gl, w, h),
      };
    }
    const unit = unitPx(project.canvas);
    let base = this.detail.accum;
    let other = this.detail.scratch;
    base.clear(0, 0, 0, 0);
    for (const raw of project.layers) {
      if (!raw.visible || raw.opacity <= 0) continue;
      const cache = this.caches.get(raw.id);
      if (!cache?.points) continue;
      const layer = resolveLayer(raw, unit);
      const slot = this.atlas.get(layer.shapeId) ?? this.atlas.get('circle');
      if (!slot) continue;
      this.detail.layer.clear(0, 0, 0, 0);
      this.atlas.bind(0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
      this.renderer.draw({
        batch: cache.batch,
        layer,
        slot,
        view: makeView(project.canvas.width, project.canvas.height, w, h, { zoom: k, panX: x, panY: y }, layer.transform),
        canvas: [project.canvas.width, project.canvas.height],
        atlasUnit: 0,
        imageUnit: 1,
        sizeScale: k,
      });
      other.bind();
      this.compositor.composite(base.texture, this.detail.layer.texture, layer.blend, layer.opacity);
      const t = base;
      base = other;
      other = t;
    }
    return base.texture;
  }

  /** Pull a render target back to CPU so a `below` layer can sample it. */
  private readbackAsSource(target: RenderTarget): ImageSource {
    const { gl } = this;
    const px = new Uint8ClampedArray(target.width * target.height * 4);
    target.bind();
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Targets are premultiplied against a transparent ground; composite onto the
    // project background so unpainted areas read as background tone rather than
    // black, which would otherwise make every `below` layer flood the canvas.
    const bg = this.store.get().canvas.background;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3] / 255;
      px[i] = Math.round(px[i] + bg[0] * 255 * (1 - a));
      px[i + 1] = Math.round(px[i + 1] + bg[1] * 255 * (1 - a));
      px[i + 2] = Math.round(px[i + 2] + bg[2] * 255 * (1 - a));
      px[i + 3] = 255;
    }
    return { width: target.width, height: target.height, rgba: px };
  }

  private presentToScreen(project: Project): void {
    const { gl, canvas } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // The stack lives in a canvas-space texture; place it under the viewport
    // transform with a scissored blit so panning is free.
    const { zoom, panX, panY } = this.viewport;
    const dw = project.canvas.width * zoom * dpr;
    const dh = project.canvas.height * zoom * dpr;
    const dx = panX * dpr + (w - dw) / 2;
    const dy = panY * dpr + (h - dh) / 2;

    // The placement is carried by the quad, not by `gl.viewport`: a zoomed-in
    // canvas asks for a viewport far wider than the driver's maximum, and a
    // clamped viewport puts the image at the wrong size in the wrong place.
    const rect: [number, number, number, number] = [
      (2 * dx) / w - 1,
      (2 * (h - dy - dh)) / h - 1,
      (2 * dw) / w,
      (2 * dh) / h,
    ];
    const preview = { source: this.sourceTex, view: this.preview, linePx: 1.5 * dpr, widthPx: dw };

    if (dw > this.renderW * 1.001) {
      // Past the composite's resolution: draw what is on screen, at screen
      // resolution, and show it pixel for pixel.
      const tex = this.drawDetail(project, w, h, dx, dy, zoom * dpr);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      this.compositor.present(tex, project.canvas.background, rect, preview,
        [dx / w, (h - dy - dh) / h, dw / w, dh / h]);
      return;
    }

    // Displayed at or below 1:1 the marks have to be averaged down rather than
    // point-sampled, or the preview reads as grain instead of as the image.
    this.finalTarget?.setDisplayScale(dw / this.renderW);
    this.compositor.present(this.finalTexture!, project.canvas.background, rect, preview);

    // Compositing and the `below` readback sample these targets 1:1, so leave
    // the filter where those passes expect it.
    this.finalTarget?.setDisplayScale(1);
  }

  private clearScreen(): void {
    const { gl, canvas } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Render one tile of the stack at an arbitrary scale, for export.
   *
   * Point buffers are stored in canvas space, so exporting at 4x regenerates
   * nothing — only the view matrix and the point-size uniform change. That is
   * what makes a 300dpi export as cheap as a preview redraw, and it is the same
   * property that lets a tile be re-rendered without disturbing any cache.
   *
   * Returns top-down RGBA, already composited over the project background.
   */
  renderRegion(scale: number, tileX: number, tileY: number, tileW: number, tileH: number): Uint8ClampedArray<ArrayBuffer> {
    const { gl } = this;
    const project = this.store.get();

    const unit = unitPx(project.canvas);

    const a = new RenderTarget(gl, tileW, tileH);
    const b = new RenderTarget(gl, tileW, tileH);
    const layerTarget = new RenderTarget(gl, tileW, tileH);
    try {
      a.clear(0, 0, 0, 0);
      let base = a;
      let other = b;

      for (const raw of project.layers) {
        if (!raw.visible || raw.opacity <= 0) continue;
        const cache = this.caches.get(raw.id);
        if (!cache?.points) continue;
        const layer = resolveLayer(raw, unit);

        const slot = this.atlas.get(layer.shapeId) ?? this.atlas.get('circle');
        if (!slot) continue;

        layerTarget.clear(0, 0, 0, 0);
        this.atlas.bind(0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);

        this.renderer.draw({
          batch: cache.batch,
          layer,
          slot,
          view: makeView(
            project.canvas.width, project.canvas.height,
            tileW, tileH,
            { zoom: scale, panX: -tileX, panY: -tileY },
            layer.transform,
          ),
          canvas: [project.canvas.width, project.canvas.height],
          atlasUnit: 0,
          imageUnit: 1,
          sizeScale: scale,
        });

        other.bind();
        this.compositor.composite(base.texture, layerTarget.texture, layer.blend, layer.opacity);
        const t = base;
        base = other;
        other = t;
      }

      // Flatten onto the background in the same pass the screen uses, so the
      // exported file matches the preview exactly.
      other.bind();
      this.compositor.present(base.texture, project.canvas.background);

      const px = new Uint8ClampedArray(tileW * tileH * 4);
      other.bind();
      gl.readPixels(0, 0, tileW, tileH, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return flipRows(px, tileW, tileH);
    } finally {
      a.dispose();
      b.dispose();
      layerTarget.dispose();
      this.needsRender = true;
    }
  }

  /**
   * Make sure every layer's points exist at full quality before exporting.
   *
   * Deliberately not a forced render: every path that can invalidate a cache
   * also sets `needsRender`, so a second call with nothing changed in between is
   * free. That matters for plate export, which runs the exporter once per screen
   * plus a proof — forcing here made a four-ink job redraw the whole stack six
   * times over to arrive at the same pixels.
   */
  prepareForExport(): void {
    this.setInteractive(false);
    this.render();
  }

  /**
   * Source colour at a canvas coordinate, for the `image` colour mode.
   *
   * The GPU samples this from a texture in the vertex shader; vector export has
   * no texture to sample, so it needs the same lookup on the CPU. Without it an
   * image-coloured layer would silently export as flat colour.
   */
  sampleSourceColor(x: number, y: number): [number, number, number] {
    const src = this.source;
    if (!src) return [0, 0, 0];
    const { width, height } = this.store.get().canvas;

    // Bilinear, with GL's half-texel offset, because the texture this mirrors is
    // bound LINEAR. Nearest-neighbour was close enough while colour was a shade,
    // but spot mode turns the sample into a hard choice of screen — half a texel
    // of disagreement there puts a whole rim of dots on a different plate than
    // the preview showed.
    const fx = Math.min(src.width - 1, Math.max(0, (x / width) * src.width - 0.5));
    const fy = Math.min(src.height - 1, Math.max(0, (y / height) * src.height - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;

    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = src.rgba[(y0 * src.width + x0) * 4 + c] * (1 - tx) + src.rgba[(y0 * src.width + x1) * 4 + c] * tx;
      const b = src.rgba[(y1 * src.width + x0) * 4 + c] * (1 - tx) + src.rgba[(y1 * src.width + x1) * 4 + c] * tx;
      out[c] = (a * (1 - ty) + b * ty) / 255;
    }
    return out;
  }

  /** The decoded photograph, for anything that has to look at it on the CPU. */
  get sourceImage(): ImageSource | null {
    return this.source;
  }

  /** Point data for vector export; regenerates at full quality if needed. */
  pointsFor(layerId: string): PointBuffer | null {
    return this.caches.get(layerId)?.points ?? null;
  }

  atlasSlot(shapeId: string) {
    return this.atlas.get(shapeId);
  }

  dispose(): void {
    for (const c of this.caches.values()) c.batch.dispose();
    this.caches.clear();
    this.accum?.dispose();
    this.scratch?.dispose();
    this.layerTarget?.dispose();
    this.detail?.accum.dispose();
    this.detail?.scratch.dispose();
    this.detail?.layer.dispose();
    this.atlas.dispose();
    this.renderer.dispose();
    this.compositor.dispose();
    this.voronoi?.dispose();
    if (this.sourceTex) this.gl.deleteTexture(this.sourceTex);
  }
}

/** `readPixels` returns bottom-up; images everywhere else are top-down. */
function flipRows(px: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(px.length);
  const rowBytes = w * 4;
  for (let y = 0; y < h; y++) {
    out.set(px.subarray((h - 1 - y) * rowBytes, (h - y) * rowBytes), y * rowBytes);
  }
  return out;
}
