import type { Project } from '../core/types';
import type { Engine } from '../pipeline/engine';
import { encodeJXL } from '../image/jxl';
import { isTauri } from '../platform';
import { encodeCanvas, renderCanvas, type ExportProgress } from './png';
import { exportSVG } from './svg';

/**
 * The light formats: the same drawing in fewer bytes. Ported from Contour.
 *
 * - Compact SVG is the SVG with every dot's position rounded to a tenth of a
 *   canvas pixel (at 300 dpi, under a hundredth of a millimetre), its size and
 *   turn to three significant figures, a layer's colour said once on the layer
 *   instead of on every dot when the dots all share it, shapes renamed to two
 *   letters, and the space between tags taken out. Still an ordinary SVG.
 * - SVGZ is that, gzipped: the standard compressed SVG, which Illustrator and
 *   Inkscape open directly.
 * - WebP is the drawing as pixels, lossless, so dots keep their edges with no
 *   JPEG smudge, at a fraction of a PNG's size.
 *
 * Contour's compactor rounds path data too. Here the shapes in `<defs>` are
 * drawn in a unit square and scaled up per dot, so a tenth would flatten them;
 * the dots are where Stipple's bytes are, and only the dots are touched.
 */

const tenth = (v: number): string => trim(Math.round(v * 10) / 10);
const sig3 = (v: number): string => trim(Number(v.toPrecision(3)));

/** `0.5` as `.5`, `-0` as `0`: what an SVG number needs and nothing more. */
function trim(v: number): string {
  if (Object.is(v, -0) || v === 0) return '0';
  return String(v).replace(/^(-?)0\./, '$1.');
}

/** Shorten a Stipple SVG without changing what it draws. */
export function compactSVG(svg: string): string {
  // A dot: translate to a tenth, then rotate and scale to three figures — a
  // dot's size is its scale, and a tenth of a pixel is a fifth of a small one.
  let out = svg.replace(/transform="translate\(([-\d.e]+) ([-\d.e]+)\)((?: rotate\([-\d.e]+\))?) scale\(([-\d.e]+)\)"/g,
    (_, x: string, y: string, rot: string, s: string) => {
      // The space between transforms stays: SVG 1.1 requires it, and Illustrator reads 1.1.
      const r = rot ? ` rotate(${sig3(parseFloat(rot.slice(8, -1)))})` : '';
      return `transform="translate(${tenth(+x)} ${tenth(+y)})${r} scale(${sig3(+s)})"`;
    });
  out = out.replace(/(fill|stroke)-opacity="([-\d.e]+)"/g, (_, k: string, v: string) => `${k}-opacity="${sig3(+v)}"`);
  // One colour on the layer rather than on each of its dots, when they agree.
  // A layer group holds only <use>s, so the first </g> after it closes it.
  out = out.replace(/(<g id="[^"]*" data-name="[^"]*"[^>]*)>([\s\S]*?)<\/g>/g, (whole, open: string, body: string) => {
    const paints = body.match(/ (fill|stroke)="#[0-9a-fA-F]{3,6}"/g);
    const uses = body.match(/<use\b/g)?.length ?? 0;
    if (!paints || paints.length !== uses || paints.some((p) => p !== paints[0])) return whole;
    return `${open}${paints[0]}>${body.split(paints[0]).join('')}</g>`;
  });
  // Every dot names its shape, so the shapes get the shortest names there are.
  const ids = [...new Set([...out.matchAll(/id="sh_([^"]+)"/g)].map((m) => m[1]))];
  ids.forEach((id, i) => {
    const short = `s${i.toString(36)}`;
    out = out.split(`id="sh_${id}"`).join(`id="${short}"`).split(`href="#sh_${id}"`).join(`href="#${short}"`);
  });
  // #aabbcc to #abc where it can be.
  out = out.replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/gi, '#$1$2$3');
  return out.replace(/>\s+</g, '><').trim();
}

export function exportCompactSVG(engine: Engine, project: Project): string {
  return compactSVG(exportSVG(engine, project));
}

/** Compact SVG, gzipped. */
export async function exportSVGZ(engine: Engine, project: Project): Promise<Uint8Array> {
  const text = new TextEncoder().encode(exportCompactSVG(engine, project));
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Lossless WebP at the document's pixel size.
 *
 * Chrome and Firefox encode WebP from a canvas; Safari, and so the desktop
 * app's web view, quietly hands back a PNG instead. The desktop app then
 * encodes it natively, and a browser without an encoder says so rather than
 * saving a PNG under a .webp name.
 */
export async function exportWebP(engine: Engine, project: Project, onProgress?: ExportProgress): Promise<Uint8Array> {
  const canvas = await renderCanvas(engine, project, 1, onProgress);
  const blob = await encodeCanvas(canvas, 'image/webp', 1).catch(() => null);
  if (blob && blob.type === 'image/webp') return new Uint8Array(await blob.arrayBuffer());
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { width, height } = canvas;
    const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    const rgba = g.getImageData(0, 0, width, height).data;
    const out = await invoke<ArrayBuffer>('encode_webp', new Uint8Array(rgba.buffer), {
      headers: { 'x-size': `${width} ${height}` },
    });
    return new Uint8Array(out);
  }
  throw new Error('this browser cannot write WebP — try Chrome, Firefox or the desktop app');
}

/**
 * Lossless JPEG XL at the document's pixel size.
 *
 * No browser canvas encodes JXL, so libjxl does it, in wasm, everywhere. The
 * pixels are read back unpremultiplied, so a transparent sheet's soft edges
 * survive the trip rather than darkening.
 */
export async function exportJXL(engine: Engine, project: Project, onProgress?: ExportProgress): Promise<Uint8Array> {
  const canvas = await renderCanvas(engine, project, 1, onProgress);
  const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  return encodeJXL(g.getImageData(0, 0, canvas.width, canvas.height));
}
