import type { Project, ShapeDef } from '../core/types';
import { POINT_STRIDE } from '../dist/types';
import type { Engine } from '../pipeline/engine';
import { cssColor, evaluatePoint, rgbaCss, shapeGeometry } from './geometry';

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

export function estimatePoints(engine: Engine, project: Project): number {
  let n = 0;
  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    n += engine.pointsFor(layer.id)?.count ?? 0;
  }
  return n;
}

export function exportSVG(engine: Engine, project: Project): string {
  engine.prepareForExport();
  const { width, height, background } = project.canvas;
  const shapesUsed = new Map<string, ShapeDef>();
  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const def = project.shapes.find((s) => s.id === layer.shapeId);
    if (def) shapesUsed.set(def.id, def);
  }

  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  out.push(`<rect width="${width}" height="${height}" fill="${rgbaCss(background)}"/>`);

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
    const points = engine.pointsFor(layer.id);
    const def = project.shapes.find((s) => s.id === layer.shapeId);
    if (!points || !def || points.count === 0) continue;
    const geo = shapeGeometry(def);
    const paintAttr = geo.kind === 'stroke' ? 'stroke' : 'fill';

    const t = layer.transform;
    const cx = width / 2;
    const cy = height / 2;
    const layerTransform =
      `translate(${cx + t.offsetX} ${cy + t.offsetY}) rotate(${t.rotate}) ` +
      `scale(${t.scale * (t.flipX ? -1 : 1)} ${t.scale * (t.flipY ? -1 : 1)}) translate(${-cx} ${-cy})`;

    out.push(
      `<g id="${escapeAttr(layer.id)}" data-name="${escapeAttr(layer.name)}" ` +
      `transform="${layerTransform}" opacity="${layer.opacity}" ` +
      `style="mix-blend-mode:${svgBlend(layer.blend)}">`,
    );

    const d = points.data;
    for (let i = 0; i < points.count; i++) {
      const o = i * POINT_STRIDE;
      const p = evaluatePoint(layer, d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], sampleColor);
      if (p.size <= 0.01 || p.alpha <= 0.001) continue;
      const deg = (p.rotation * 180) / Math.PI;
      const rot = Math.abs(deg) > 0.01 ? ` rotate(${round(deg)})` : '';
      const alpha = p.alpha < 0.999 ? ` ${paintAttr}-opacity="${round(p.alpha)}"` : '';
      out.push(
        `<use xlink:href="#sh_${def.id}" transform="translate(${round(p.x)} ${round(p.y)})${rot} ` +
        `scale(${round(p.size)})" ${paintAttr}="${cssColor(p.rgb)}"${alpha}/>`,
      );
    }
    out.push('</g>');
  }

  out.push('</svg>');
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
