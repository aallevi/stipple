import type { ShapeDef } from '../core/types';
import { mulberry32 } from '../core/rng';

/**
 * Turn a `ShapeDef` into an antialiased alpha mask, ready for `signedDistanceField`.
 *
 * Built-ins are drawn as paths rather than described analytically so that every
 * shape kind — including imported SVG and raster — goes through one code path
 * and lands in the atlas identically. An imported shape is therefore not a
 * special case anywhere downstream.
 */

/** Padding around the shape so the distance field has room to fall off. */
export const SHAPE_PAD = 0.16;

function polygonPath(def: Extract<ShapeDef, { kind: 'polygon' }>, size: number): Path2D {
  const p = new Path2D();
  const rng = mulberry32(def.seed);
  const cx = size / 2;
  const cy = size / 2;
  const r = (size / 2) * (1 - SHAPE_PAD);
  const star = def.innerRadius < 1;
  const steps = star ? def.vertices * 2 : def.vertices;

  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2 - Math.PI / 2;
    const base = star && i % 2 === 1 ? r * def.innerRadius : r;
    // Warp displaces each vertex radially, which is what gives the reference
    // tool's polygons their hand-cut, irregular feel.
    const radius = base * (1 - def.warp * rng());
    const x = cx + Math.cos(t) * radius;
    const y = cy + Math.sin(t) * radius;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

function linePath(def: Extract<ShapeDef, { kind: 'line' }>, size: number): Path2D {
  const p = new Path2D();
  const rng = mulberry32(def.seed);
  const cx = size / 2;
  const cy = size / 2;
  const len = (size / 2) * (1 - SHAPE_PAD) * def.length;

  if (def.style === 'radial') {
    // Segments arranged as spokes around the centre — cross, asterisk, burst.
    for (let i = 0; i < def.segments * 2; i++) {
      const a = (i / (def.segments * 2)) * Math.PI * 2;
      const l = len * (1 - def.warp * rng());
      p.moveTo(cx, cy);
      p.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l);
    }
    return p;
  }

  // Linear and rounded both walk a horizontal chain of segments; `rounded`
  // smooths the joints with quadratic curves instead of corners.
  const pts: [number, number][] = [];
  for (let i = 0; i <= def.segments; i++) {
    const t = i / def.segments;
    const x = cx + (t - 0.5) * 2 * len;
    const y = cy + (rng() - 0.5) * 2 * len * def.warp;
    pts.push([x, y]);
  }

  p.moveTo(pts[0][0], pts[0][1]);
  if (def.style === 'rounded' && pts.length > 2) {
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    p.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  } else {
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  }
  return p;
}

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(size: number): { ctx: Ctx2D; read: () => ImageData } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    return { ctx, read: () => ctx.getImageData(0, 0, size, size) };
  }
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return { ctx, read: () => ctx.getImageData(0, 0, size, size) };
}

/**
 * Render a shape to an alpha mask of `size` x `size`.
 *
 * Raster shapes need their bitmap decoded first; the caller passes it in because
 * decoding is async and this stays synchronous for everything else.
 */
export function rasterizeShape(
  def: ShapeDef,
  size: number,
  bitmap?: ImageBitmap,
): Uint8ClampedArray {
  const { ctx, read } = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';

  switch (def.kind) {
    case 'circle': {
      const p = new Path2D();
      p.arc(size / 2, size / 2, (size / 2) * (1 - SHAPE_PAD), 0, Math.PI * 2);
      ctx.fill(p);
      break;
    }
    case 'polygon':
      ctx.fill(polygonPath(def, size));
      break;
    case 'line': {
      ctx.lineWidth = Math.max(1, def.thickness * size * 0.5);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(linePath(def, size));
      break;
    }
    case 'svg': {
      // The paths were normalised into a unit box at import, so fitting them
      // into the cell is a single uniform scale.
      const inner = size * (1 - SHAPE_PAD);
      ctx.save();
      ctx.translate(size * SHAPE_PAD * 0.5, size * SHAPE_PAD * 0.5);
      ctx.scale(inner, inner);
      for (const d of def.paths) ctx.fill(new Path2D(d), def.fillRule);
      ctx.restore();
      break;
    }
    case 'raster': {
      if (bitmap) {
        const inner = size * (1 - SHAPE_PAD);
        const s = Math.min(inner / bitmap.width, inner / bitmap.height);
        const w = bitmap.width * s;
        const h = bitmap.height * s;
        ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
      }
      break;
    }
  }

  const img = read();
  const alpha = new Uint8ClampedArray(size * size);
  for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3];
  return alpha;
}
