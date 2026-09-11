import type { Project } from '../core/types';
import { POINT_STRIDE } from '../dist/types';
import type { Engine } from '../pipeline/engine';
import { evaluatePoint, inkSetFor, shapeGeometry, type ShapeGeometry } from './geometry';

/**
 * Vector PDF export, written directly.
 *
 * Each shape becomes a Form XObject drawn once and invoked per point with a
 * transform — the PDF analogue of the `<use>` trick in the SVG exporter, and the
 * reason a 100k-point stipple stays a few megabytes instead of a few hundred.
 * Fill colour is set in the graphics state *outside* the XObject, so a single
 * form serves every colour in the layer.
 *
 * Raster shapes are the one thing that cannot be a form; those layers fall back
 * to filled circles, and the caller is told.
 */

/**
 * Points per canvas pixel.
 *
 * A canvas pixel is 1/dpi of an inch — that is what the document panel says and
 * what the halftone generator assumes when it turns a lineature into a cell
 * size. This used to be the CSS constant 72/96, which quietly made every PDF
 * 3.125x too big at the default 300 dpi and turned a 45 lpi separation into a
 * 14 lpi one. There is only one convention now, and it is this.
 */
const ptPerPx = (dpi: number): number => 72 / Math.max(1, dpi);

export type PDFResult = { bytes: Uint8Array; warnings: string[] };

export function exportPDF(engine: Engine, project: Project): PDFResult {
  engine.prepareForExport();
  const warnings: string[] = [];
  const { width, height, background } = project.canvas;
  const PT_PER_PX = ptPerPx(project.canvas.dpi);
  const pw = width * PT_PER_PX;
  const ph = height * PT_PER_PX;

  const forms = new Map<string, { name: string; content: string }>();
  const content: string[] = [];
  const sampleColor = (x: number, y: number): [number, number, number] =>
    engine.sampleSourceColor(x, y);
  // Distinct opacities become distinct ExtGState entries. Scoped to this export
  // so repeated exports cannot accumulate stale states.
  //
  // PDF has no per-operation alpha, so the value has to be the layer's opacity
  // *and* the mark's own — `color.alpha` times the colour's alpha channel, which
  // is what the shader and the SVG exporter both apply. Setting only the layer's,
  // as this used to, exported a half-transparent layer fully opaque.
  const gsValues: number[] = [];
  const gsIndex = (opacity: number): number => {
    const rounded = Math.round(opacity * 100) / 100;
    let i = gsValues.indexOf(rounded);
    if (i < 0) {
      i = gsValues.length;
      gsValues.push(rounded);
    }
    return i;
  };

  // Background
  content.push(`${f(background[0])} ${f(background[1])} ${f(background[2])} rg`);
  content.push(`0 0 ${f(pw)} ${f(ph)} re f`);

  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const points = engine.pointsFor(layer.id);
    const def = project.shapes.find((s) => s.id === layer.shapeId);
    if (!points || !def || points.count === 0) continue;

    let geo = shapeGeometry(def);
    if (geo.kind === 'image') {
      warnings.push(`"${def.name}" is a raster shape; layer "${layer.name}" exported as circles.`);
      geo = { kind: 'circle', r: 0.42 };
    }

    if (!forms.has(def.id)) {
      const name = `Fm${forms.size}`;
      forms.set(def.id, { name, content: formContent(geo) });
    }
    const form = forms.get(def.id)!;
    const inks = inkSetFor(layer);

    content.push('q');

    const d = points.data;
    let lastColor = '';
    let lastGS = '';
    for (let i = 0; i < points.count; i++) {
      const o = i * POINT_STRIDE;
      const p = evaluatePoint(layer, d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], sampleColor, inks);
      if (p.size <= 0.01 || p.alpha <= 0.001) continue;

      // Only emit a colour or alpha operator when it actually changes — for a
      // solid-colour layer that is once for the whole layer rather than once per
      // point. `q`/`Q` bracket the layer, so both reset with it.
      const col = `${f(p.rgb[0])} ${f(p.rgb[1])} ${f(p.rgb[2])} rg`;
      if (col !== lastColor) {
        content.push(col);
        lastColor = col;
      }
      const opacity = p.alpha * layer.opacity;
      const gs = opacity < 1 ? `/GS${gsIndex(opacity)} gs` : '';
      if (gs !== lastGS) {
        if (gs) content.push(gs);
        lastGS = gs;
      }

      const s = p.size * PT_PER_PX;
      const c = Math.cos(p.rotation) * s;
      const sn = Math.sin(p.rotation) * s;
      const x = p.x * PT_PER_PX;
      // PDF's origin is bottom-left; the canvas model is top-left.
      const y = ph - p.y * PT_PER_PX;
      content.push(`q ${f(c)} ${f(sn)} ${f(-sn)} ${f(c)} ${f(x)} ${f(y)} cm /${form.name} Do Q`);
    }
    content.push('Q');
  }

  return { bytes: assemble(pw, ph, content.join('\n'), forms, gsValues), warnings };
}

function formContent(geo: Exclude<ShapeGeometry, { kind: 'image' }>): string {
  if (geo.kind === 'circle') {
    // Four Béziers, the standard circle approximation.
    const r = geo.r;
    const k = r * 0.5522847498;
    return [
      `${f(r)} 0 m`,
      `${f(r)} ${f(k)} ${f(k)} ${f(r)} 0 ${f(r)} c`,
      `${f(-k)} ${f(r)} ${f(-r)} ${f(k)} ${f(-r)} 0 c`,
      `${f(-r)} ${f(-k)} ${f(-k)} ${f(-r)} 0 ${f(-r)} c`,
      `${f(k)} ${f(-r)} ${f(r)} ${f(-k)} ${f(r)} 0 c`,
      'f',
    ].join('\n');
  }
  const ops = pathToPDF(geo.d);
  if (geo.kind === 'stroke') {
    return `${f(geo.width)} w 1 J 1 j\n${ops}\nS`;
  }
  return `${ops}\n${geo.fillRule === 'evenodd' ? 'f*' : 'f'}`;
}

/**
 * Convert the M/L/Q/Z subset our shapes emit into PDF path operators.
 * PDF has no quadratic operator, so quadratics are raised to cubics exactly.
 */
function pathToPDF(d: string): string {
  const out: string[] = [];
  const re = /([MLQZ])([^MLQZ]*)/gi;
  let cx = 0;
  let cy = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const cmd = m[1].toUpperCase();
    const nums = (m[2].match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
    if (cmd === 'M' && nums.length >= 2) {
      cx = nums[0];
      cy = -nums[1]; // flip into PDF's y-up space
      out.push(`${f(cx)} ${f(cy)} m`);
    } else if (cmd === 'L') {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cx = nums[i];
        cy = -nums[i + 1];
        out.push(`${f(cx)} ${f(cy)} l`);
      }
    } else if (cmd === 'Q' && nums.length >= 4) {
      const qx = nums[0];
      const qy = -nums[1];
      const ex = nums[2];
      const ey = -nums[3];
      const c1x = cx + (2 / 3) * (qx - cx);
      const c1y = cy + (2 / 3) * (qy - cy);
      const c2x = ex + (2 / 3) * (qx - ex);
      const c2y = ey + (2 / 3) * (qy - ey);
      out.push(`${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(ex)} ${f(ey)} c`);
      cx = ex;
      cy = ey;
    } else if (cmd === 'Z') {
      out.push('h');
    }
  }
  return out.join('\n');
}

/** Minimal single-page PDF with a correct cross-reference table. */
function assemble(
  pw: number,
  ph: number,
  content: string,
  forms: Map<string, { name: string; content: string }>,
  gsValues: number[],
): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length; // 1-based object numbers
  };

  const formIds = new Map<string, number>();
  for (const [id, form] of forms) {
    const stream = form.content;
    formIds.set(
      id,
      add(
        `<< /Type /XObject /Subtype /Form /BBox [-1 -1 1 1] ` +
        `/Resources << >> /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`,
      ),
    );
  }

  const gsRefs = gsValues.map((v, i) =>
    `/GS${i} << /Type /ExtGState /ca ${f(v)} /CA ${f(v)} >>`).join(' ');
  const xobjects = [...forms.entries()]
    .map(([id, form]) => `/${form.name} ${formIds.get(id)} 0 R`)
    .join(' ');

  const contentId = add(
    `<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream`,
  );
  const pagesIdPlaceholder = objects.length + 2; // page -> pages
  const pageId = add(
    `<< /Type /Page /Parent ${pagesIdPlaceholder} 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] ` +
    `/Resources << /XObject << ${xobjects} >> /ExtGState << ${gsRefs} >> >> ` +
    `/Contents ${contentId} 0 R >>`,
  );
  const pagesId = add(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function f(v: number): string {
  return (Math.round(v * 1000) / 1000).toString();
}
