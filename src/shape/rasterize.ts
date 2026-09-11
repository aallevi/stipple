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

/**
 * Half the width a shape may occupy inside its cell, in unit-box terms.
 *
 * Every shape is drawn to this radius, so a layer's `size` in pixels means the
 * same thing whichever stamp is selected: the mark spans `size * (1 - SHAPE_PAD)`
 * across. Nothing may exceed it — the cell is one atlas tile, and geometry past
 * the edge is not clipped gracefully, it is simply gone.
 */
export const SHAPE_R = 0.5 * (1 - SHAPE_PAD);

/** A line shape reduced to its centreline, in a unit box centred on the origin. */
export type LineSkeleton = {
  /** One polyline per stroke — spokes emit many runs, a chain emits one. */
  runs: [number, number][][];
  /** Stroke width, in the same unit-box terms as `runs`. */
  strokeWidth: number;
  /** Round the joints of a chain instead of cornering them. */
  smooth: boolean;
};

/**
 * The one definition of a line shape's geometry.
 *
 * `length` names the mark's **overall** extent, caps included, and `thickness`
 * is a fraction of that same extent rather than of the cell. Two things follow,
 * and both are what make the sliders predictable:
 *
 *   - the mark always spans exactly `size * (1 - SHAPE_PAD) * length` pixels, so
 *     thickening a line grows it inward instead of pushing it past the tile edge
 *     and having the ends silently cut off;
 *   - thickness is scale-free, so it reads as the line's weight — the same 0.2
 *     looks like the same line whether the layer draws at 3px or at 30px.
 *
 * The centreline is therefore shortened by half a stroke at each end, which is
 * exactly what the round caps put back. At `thickness` 1 the centreline collapses
 * to a point and the stamp degenerates into a dot of the full extent, which is
 * the correct limit for a round-capped stroke.
 *
 * Both the rasteriser below and the vector exporter call this, so a mark in the
 * preview and the same mark in an SVG cannot disagree.
 */
export function lineSkeleton(def: Extract<ShapeDef, { kind: 'line' }>): LineSkeleton {
  const rng = mulberry32(def.seed);
  const extent = 2 * SHAPE_R * def.length;
  const strokeWidth = extent * def.thickness;
  const reach = Math.max(0, (extent - strokeWidth) / 2);

  if (def.style === 'radial') {
    // Spokes around the centre — cross, asterisk, burst. Each arm is its own run
    // so the joint at the centre stays a joint rather than a corner.
    const runs: [number, number][][] = [];
    for (let i = 0; i < def.segments * 2; i++) {
      const a = (i / (def.segments * 2)) * Math.PI * 2;
      const l = reach * (1 - def.warp * rng());
      runs.push([[0, 0], [Math.cos(a) * l, Math.sin(a) * l]]);
    }
    return { runs, strokeWidth, smooth: false };
  }

  // Linear and rounded both walk a horizontal chain of segments; `rounded`
  // smooths the joints with quadratic curves instead of corners.
  const pts: [number, number][] = [];
  for (let i = 0; i <= def.segments; i++) {
    const t = i / def.segments;
    pts.push([(t - 0.5) * 2 * reach, (rng() - 0.5) * 2 * reach * def.warp]);
  }
  return { runs: [pts], strokeWidth, smooth: def.style === 'rounded' };
}

function polygonPath(def: Extract<ShapeDef, { kind: 'polygon' }>, size: number): Path2D {
  const p = new Path2D();
  const rng = mulberry32(def.seed);
  const cx = size / 2;
  const cy = size / 2;
  const r = SHAPE_R * size;
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

/** Walk a skeleton into a Path2D placed in a `size` x `size` cell. */
function linePath(def: Extract<ShapeDef, { kind: 'line' }>, size: number): Path2D {
  const { runs, smooth } = lineSkeleton(def);
  const p = new Path2D();
  const px = (v: number): number => size / 2 + v * size;

  for (const pts of runs) {
    p.moveTo(px(pts[0][0]), px(pts[0][1]));
    if (smooth && pts.length > 2) {
      for (let i = 1; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[i + 1];
        p.quadraticCurveTo(px(x0), px(y0), px((x0 + x1) / 2), px((y0 + y1) / 2));
      }
      const last = pts[pts.length - 1];
      p.lineTo(px(last[0]), px(last[1]));
    } else {
      for (let i = 1; i < pts.length; i++) p.lineTo(px(pts[i][0]), px(pts[i][1]));
    }
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
      p.arc(size / 2, size / 2, SHAPE_R * size, 0, Math.PI * 2);
      ctx.fill(p);
      break;
    }
    case 'polygon':
      ctx.fill(polygonPath(def, size));
      break;
    case 'line': {
      // The floor keeps a hairline from vanishing in the 128px atlas tile; the
      // fragment shader carries thin marks in alpha, not in geometry.
      ctx.lineWidth = Math.max(1, lineSkeleton(def).strokeWidth * size);
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
