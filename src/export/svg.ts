import type { Layer, Project, ShapeDef } from '../core/types';
import { POINT_STRIDE } from '../dist/types';
import type { Engine } from '../pipeline/engine';
import { cssColor, evaluatePoint, inkSetFor, rgbaCss, shapeGeometry } from './geometry';

/**
 * Vector export.
 *
 * Each shape is emitted once into `<defs>` and referenced per point with
 * `<use>`, which keeps the file roughly an order of magnitude smaller than
 * inlining geometry and lets an editor treat the stipple as instances of one
 * symbol. Layers become groups, named as they are in the app.
 *
 * Above `WARN_POINTS` the file gets genuinely unwieldy in most editors — the
 * caller is expected to have surfaced `estimatePoints` to the user first.
 */
export const WARN_POINTS = 250_000;

/**
 * Restrict an export to one printing plate.
 *
 * A plate is not a layer — a single spot-ink layer holds every colour at once
 * and only splits when each dot is asked which ink it took. So the filter has
 * to work at two granularities, and `route` is what says which applies to a
 * given layer. See `src/export/plates.ts` for how the routing is decided.
 */
export type PlateFilter = {
  index: number;
  route(layer: Layer): number | 'per-point';
};

export type ExportOptions = {
  /** Keep only what belongs to one plate. Omit for the whole stack. */
  plate?: PlateFilter;
  /** Film output: solid black on white, no blend modes, no partial opacity. */
  mono?: boolean;
  /** Blank border in canvas px, which the registration marks live in. */
  margin?: number;
  /** Caption printed in the margin. */
  label?: string;
  /**
   * Per-point ink indices for spot layers, keyed by layer id, from
   * `assignPlates`. Supplying it skips the per-dot ink solve — which is the same
   * answer on every plate — and is what keeps a separation linear in points
   * rather than in points times plates.
   */
  inkIndex?: Map<string, Int16Array>;
};

export function estimatePoints(engine: Engine, project: Project): number {
  let n = 0;
  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    n += engine.pointsFor(layer.id)?.count ?? 0;
  }
  return n;
}

export function exportSVG(engine: Engine, project: Project, opts: ExportOptions = {}): string {
  engine.prepareForExport();
  const { width, height, background } = project.canvas;
  const plate = opts.plate;
  const mono = opts.mono ?? false;
  const m = opts.margin ?? 0;
  const shapesUsed = new Map<string, ShapeDef>();
  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const def = project.shapes.find((s) => s.id === layer.shapeId);
    if (def) shapesUsed.set(def.id, def);
  }

  // Physical units on the root, user units in the viewBox.
  //
  // A bare `width="1024"` is 1024 CSS px, which an editor reads as 10.67in — but
  // a canvas pixel here is 1/dpi of an inch, so the same document is 3.41in at
  // 300 dpi. Stating the size in inches is what makes the file open at the size
  // the document panel promised, and keeps a screen ruled at 45 lpi actually 45
  // lines to the inch.
  const inches = (px: number): string => (px / Math.max(1, project.canvas.dpi)).toFixed(4);
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${inches(width + 2 * m)}in" height="${inches(height + 2 * m)}in" ` +
    `viewBox="${-m} ${-m} ${width + 2 * m} ${height + 2 * m}">`,
  );
  // A film positive is read as ink where it is black, so the ground has to be
  // paper-white regardless of what the document is set to.
  const ground = mono ? '#ffffff' : rgbaCss(background);
  out.push(`<rect x="${-m}" y="${-m}" width="${width + 2 * m}" height="${height + 2 * m}" fill="${ground}"/>`);

  out.push('<defs>');
  for (const def of shapesUsed.values()) {
    const g = shapeGeometry(def);
    out.push(`<g id="sh_${def.id}">`);
    switch (g.kind) {
      case 'circle':
        out.push(`<circle cx="0" cy="0" r="${g.r}"/>`);
        break;
      case 'fill':
        out.push(`<path d="${g.d}" fill-rule="${g.fillRule}"/>`);
        break;
      case 'stroke':
        // `fill:none` is set here so the per-instance `stroke` on <use> is the
        // only paint that varies; stroke-width is in unit space and therefore
        // scales with the instance transform, matching the SDF render.
        out.push(
          `<path d="${g.d}" fill="none" stroke-width="${g.width}" ` +
          `stroke-linecap="round" stroke-linejoin="round"/>`,
        );
        break;
      case 'image':
        out.push(`<image href="${g.href}" x="-0.5" y="-0.5" width="1" height="1" preserveAspectRatio="xMidYMid meet"/>`);
        break;
    }
    out.push('</g>');
  }
  out.push('</defs>');

  const sampleColor = (x: number, y: number): [number, number, number] =>
    engine.sampleSourceColor(x, y);

  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const route = plate ? plate.route(layer) : 'all';
    if (route !== 'all' && route !== 'per-point' && route !== plate!.index) continue;
    const points = engine.pointsFor(layer.id);
    const def = project.shapes.find((s) => s.id === layer.shapeId);
    if (!points || !def || points.count === 0) continue;
    const geo = shapeGeometry(def);
    const paintAttr = geo.kind === 'stroke' ? 'stroke' : 'fill';
    const inks = inkSetFor(layer);
    const preset = opts.inkIndex?.get(layer.id);

    const t = layer.transform;
    const cx = width / 2;
    const cy = height / 2;
    const layerTransform =
      `translate(${cx + t.offsetX} ${cy + t.offsetY}) rotate(${t.rotate}) ` +
      `scale(${t.scale * (t.flipX ? -1 : 1)} ${t.scale * (t.flipY ? -1 : 1)}) translate(${-cx} ${-cy})`;

    // A plate carries one ink laid down at full strength; opacity and blending
    // are qualities of the stack, and a screen has neither.
    const groupPaint = mono
      ? ''
      : ` opacity="${layer.opacity}" style="mix-blend-mode:${svgBlend(layer.blend)}"`;
    out.push(
      `<g id="${escapeAttr(layer.id)}" data-name="${escapeAttr(layer.name)}" ` +
      `transform="${layerTransform}"${groupPaint}>`,
    );

    const d = points.data;
    for (let i = 0; i < points.count; i++) {
      const o = i * POINT_STRIDE;
      const p = evaluatePoint(
        layer, d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], sampleColor, inks, preset?.[i],
      );
      if (p.size <= 0.01 || p.alpha <= 0.001) continue;
      if (route === 'per-point' && p.ink !== plate!.index) continue;
      const deg = (p.rotation * 180) / Math.PI;
      const rot = Math.abs(deg) > 0.01 ? ` rotate(${round(deg)})` : '';
      const paint = mono ? '#000000' : cssColor(p.rgb);
      const alpha = !mono && p.alpha < 0.999 ? ` ${paintAttr}-opacity="${round(p.alpha)}"` : '';
      out.push(
        `<use xlink:href="#sh_${def.id}" transform="translate(${round(p.x)} ${round(p.y)})${rot} ` +
        `scale(${round(p.size)})" ${paintAttr}="${paint}"${alpha}/>`,
      );
    }
    out.push('</g>');
  }

  if (m > 0) out.push(registrationSVG(width, height, m, opts.label ?? ''));

  out.push('</svg>');
  return out.join('\n');
}

/**
 * Registration marks, identical on every plate.
 *
 * Four crosshairs on the centre lines plus corner crops, all outside the image
 * so nothing is printed over the artwork. They are drawn in black on every
 * plate including the proof: lining the screens up means laying one film over
 * another and getting the crosses to disappear into each other.
 */
export function registrationSVG(width: number, height: number, m: number, label: string): string {
  const r = m * 0.3;
  const out: string[] = [`<g fill="none" stroke="#000000" stroke-width="${Math.max(0.5, m * 0.035)}">`];

  // Cross-and-circle, broken at the centre. The gap is the point of the mark:
  // with a solid cross, two films in near-register look the same as two in
  // register, because the ink of one hides the misalignment of the other.
  const gapC = r * 0.18;
  const cross = (x: number, y: number): void => {
    out.push(`<circle cx="${round(x)}" cy="${round(y)}" r="${round(r * 0.4)}"/>`);
    out.push(
      `<path d="M${round(x - r)} ${round(y)}H${round(x - gapC)}` +
      `M${round(x + gapC)} ${round(y)}H${round(x + r)}` +
      `M${round(x)} ${round(y - r)}V${round(y - gapC)}` +
      `M${round(x)} ${round(y + gapC)}V${round(y + r)}"/>`,
    );
  };
  cross(width / 2, -m / 2);
  cross(width / 2, height + m / 2);
  cross(-m / 2, height / 2);
  cross(width + m / 2, height / 2);

  // Corner crops: short ticks that stop short of the image edge, so trimming to
  // them never cuts into the artwork.
  const c = m * 0.45;
  const gap = m * 0.2;
  for (const [x, y, sx, sy] of [[0, 0, -1, -1], [width, 0, 1, -1], [0, height, -1, 1], [width, height, 1, 1]] as const) {
    out.push(`<path d="M${round(x + sx * gap)} ${round(y)}H${round(x + sx * (gap + c))}"/>`);
    out.push(`<path d="M${round(x)} ${round(y + sy * gap)}V${round(y + sy * (gap + c))}"/>`);
  }
  out.push('</g>');

  if (label) {
    out.push(
      `<text x="${round(-m / 2)}" y="${round(-m / 2)}" fill="#000000" ` +
      `font-family="monospace" font-size="${round(m * 0.3)}" ` +
      `dominant-baseline="middle">${escapeAttr(label)}</text>`,
    );
  }
  return out.join('\n');
}

/** Our blend modes map onto CSS `mix-blend-mode` one-for-one except `add`. */
function svgBlend(mode: string): string {
  return mode === 'add' ? 'plus-lighter' : mode;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function escapeAttr(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
}
