import type { ShapeDef } from '../core/types';
import { uid } from '../core/defaults';

/**
 * Turning a user's file into a stamp.
 *
 * Imported shapes are deliberately not a special case downstream: both branches
 * produce a `ShapeDef` that the atlas rasterises and distance-transforms exactly
 * like a built-in circle, so an imported logo supports every size, rotation and
 * colour mode with no extra code.
 */

/** SVG geometry is flattened to this tolerance, in unit-box coordinates. */
const FLATTEN_TOLERANCE = 0.0015;

export async function importShape(name: string, bytes: Uint8Array): Promise<{
  def: ShapeDef;
  bitmap?: ImageBitmap;
}> {
  const label = name.replace(/\.[^.]+$/, '');
  if (/\.svg$/i.test(name) || looksLikeSVG(bytes)) {
    return { def: importSVG(label, new TextDecoder().decode(bytes)) };
  }
  return importRaster(label, bytes);
}

function looksLikeSVG(b: Uint8Array): boolean {
  const head = new TextDecoder().decode(b.slice(0, 256)).trimStart();
  return head.startsWith('<?xml') || head.startsWith('<svg');
}

/**
 * Flatten an SVG into unit-box polygon paths.
 *
 * Rather than parse path data and resolve nested `transform` attributes by hand,
 * the document is laid out off-screen and each geometry element is sampled with
 * `getPointAtLength`, then mapped through its own CTM. That gets nested groups,
 * arbitrary transforms, `<use>`, and every primitive element correct for free.
 * The cost is that curves become polylines — at the 128px resolution the distance
 * field is built at, the difference is not resolvable, and the flattened paths
 * are still true vector geometry on export.
 */
export function importSVG(name: string, text: string): ShapeDef {
  const holder = document.createElement('div');
  holder.setAttribute('style', 'position:absolute;left:-99999px;top:0;width:1000px;height:1000px');
  holder.innerHTML = text;
  const svg = holder.querySelector('svg');
  if (!svg) throw new Error('No <svg> element found in that file.');
  svg.setAttribute('width', '1000');
  svg.setAttribute('height', '1000');
  document.body.appendChild(holder);

  try {
    const elements = Array.from(
      svg.querySelectorAll<SVGGeometryElement>('path,circle,ellipse,rect,polygon,polyline,line'),
    ).filter((el) => typeof el.getTotalLength === 'function');
    if (!elements.length) throw new Error('That SVG contains no drawable geometry.');

    const rings: [number, number][][] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const el of elements) {
      if (el.getAttribute('fill') === 'none' && !el.getAttribute('stroke')) continue;
      const ctm = el.getCTM();
      const len = el.getTotalLength();
      if (!len) continue;

      // Sample density scales with path length so a long outline is not
      // under-sampled and a tiny one does not cost thousands of points.
      const steps = Math.min(4000, Math.max(24, Math.ceil(len / 1.5)));
      const ring: [number, number][] = [];
      for (let i = 0; i <= steps; i++) {
        const p = el.getPointAtLength((i / steps) * len);
        let x = p.x;
        let y = p.y;
        if (ctm) {
          x = ctm.a * p.x + ctm.c * p.y + ctm.e;
          y = ctm.b * p.x + ctm.d * p.y + ctm.f;
        }
        ring.push([x, y]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      rings.push(ring);
    }

    if (!rings.length || !isFinite(minX)) throw new Error('That SVG contains no drawable geometry.');

    // Normalise into a unit box, centred, aspect preserved — so every imported
    // shape drops into an atlas tile the same way a built-in does.
    const w = Math.max(maxX - minX, 1e-6);
    const h = Math.max(maxY - minY, 1e-6);
    const s = 1 / Math.max(w, h);
    const ox = (1 - w * s) / 2;
    const oy = (1 - h * s) / 2;

    const paths = rings.map((ring) => {
      const simplified = simplify(ring.map(([x, y]) => [(x - minX) * s + ox, (y - minY) * s + oy] as [number, number]), FLATTEN_TOLERANCE);
      const parts = simplified.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x)},${round(y)}`);
      return `${parts.join('')}Z`;
    });

    const fillRule = (svg.querySelector('[fill-rule]')?.getAttribute('fill-rule') === 'evenodd')
      ? 'evenodd' as const
      : 'nonzero' as const;

    return { kind: 'svg', id: uid('shape'), name, paths, viewBox: [0, 0, 1, 1], fillRule };
  } finally {
    holder.remove();
  }
}

async function importRaster(name: string, bytes: Uint8Array): Promise<{ def: ShapeDef; bitmap: ImageBitmap }> {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer]);
  const bitmap = await createImageBitmap(blob);
  const data = await blobToDataURL(blob);
  const def: ShapeDef = {
    kind: 'raster',
    id: uid('shape'),
    name,
    data,
    width: bitmap.width,
    height: bitmap.height,
  };
  return { def, bitmap };
}

/** Rebuild the bitmap for a raster shape loaded from a saved project. */
export async function rasterBitmap(def: Extract<ShapeDef, { kind: 'raster' }>): Promise<ImageBitmap> {
  const res = await fetch(def.data);
  return createImageBitmap(await res.blob());
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Ramer-Douglas-Peucker, iterative so a 4000-point ring cannot blow the stack.
 *
 * Exported for testing: the closed-ring case below is subtle enough to be worth
 * pinning down directly.
 */
export function simplify(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length < 3) return points;
  const last = points.length - 1;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[last] = 1;

  const stack: [number, number][] = [];
  // A closed ring starts and ends at the same point, which makes the initial
  // chord zero-length — every interior point then measures as zero distance from
  // it and the whole outline collapses to two points. Anchoring on the vertex
  // farthest from the start splits the ring into two open arcs first.
  const closed = Math.hypot(points[last][0] - points[0][0], points[last][1] - points[0][1]) < 1e-9;
  if (closed) {
    let far = 0;
    let farD = -1;
    for (let i = 1; i < last; i++) {
      const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far === 0) return [points[0], points[last]];
    keep[far] = 1;
    stack.push([0, far], [far, last]);
  } else {
    stack.push([0, last]);
  }

  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const [x1, y1] = points[lo];
    const [x2, y2] = points[hi];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const denom = Math.hypot(dx, dy) || 1e-9;

    let worst = -1;
    let worstIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = points[i];
      const d = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / denom;
      if (d > worst) {
        worst = d;
        worstIdx = i;
      }
    }
    if (worst > tolerance && worstIdx > 0) {
      keep[worstIdx] = 1;
      stack.push([lo, worstIdx], [worstIdx, hi]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}
