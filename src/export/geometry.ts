import type { ColorParams, Layer, RGBA, ShapeDef } from '../core/types';
import { assignInk, buildInkSet, type InkSet } from '../core/color';
import { mulberry32 } from '../core/rng';
import { POINT_STRIDE } from '../dist/types';
import { lineSkeleton, SHAPE_PAD, SHAPE_R } from '../shape/rasterize';

/**
 * The CPU mirror of the point vertex shader.
 *
 * Vector export has to reproduce exactly what the GPU drew, so the size,
 * rotation and colour rules live here once and both `svg.ts` and `pdf.ts` use
 * them. If the shader's derivation ever changes, this is the one other place
 * that must change with it — better than two independent copies drifting apart.
 */

export type EvaluatedPoint = {
  x: number;
  y: number;
  size: number;
  /** Radians. */
  rotation: number;
  rgb: [number, number, number];
  alpha: number;
  /**
   * Which plate this mark belongs to, for `spot` layers — an index into the
   * layer's palette. `-1` on every other mode, where the mark is not tied to a
   * single screen. Paper comes back as `-1` with `alpha` zeroed, so the
   * ordinary exporters skip it without knowing spot mode exists.
   */
  ink: number;
};

/** The layer's inks, converted once. Pass it per layer, never per point. */
export function inkSetFor(layer: Layer): InkSet | null {
  const c = layer.color;
  if (c.mode !== 'spot' || c.palette.length === 0) return null;
  return buildInkSet(c.palette, c.paper ?? null);
}

/**
 * Which ink every point of a spot layer takes, computed once.
 *
 * Splitting a stack into films runs the exporter once per screen, and each run
 * used to ask every dot again which ink it was — an Oklab conversion and a
 * two-ink solve per dot, per plate, for an answer that cannot change between
 * them. Doing it once here and handing the result to `evaluatePoint` makes the
 * separation linear in points rather than in points times plates.
 *
 * Entries are indices into the ink set; anything at or past `inkCount` is bare
 * paper. Returns null for a layer that does not print from a palette.
 */
export function assignPlates(
  layer: Layer,
  points: { data: Float32Array; count: number },
  sampleImage: (x: number, y: number) => [number, number, number],
  inks: InkSet | null,
): Int16Array | null {
  if (layer.color.mode !== 'spot' || !inks) return null;
  const out = new Int16Array(points.count);
  const d = points.data;
  const byTone = layer.color.matchBy === 'tone';
  const mixing = layer.color.mixing;
  for (let i = 0; i < points.count; i++) {
    const o = i * POINT_STRIDE;
    const [r, g, b] = sampleImage(d[o], d[o + 1]);
    out[i] = assignInk(inks, r, g, b, mixing, d[o + 4], byTone);
  }
  return out;
}

export function evaluatePoint(
  layer: Layer,
  x: number,
  y: number,
  tone: number,
  grad: number,
  rand: number,
  sampleImage?: (x: number, y: number) => [number, number, number],
  inks?: InkSet | null,
  /** A precomputed ink index from `assignPlates`, to skip the per-dot solve. */
  presetInk?: number,
): EvaluatedPoint {
  const s = layer.size;
  const ink = s.invert ? tone : 1 - tone;
  const t = (s.gamma ?? 1) === 1 ? ink : Math.pow(Math.max(0, ink), s.gamma ?? 1);
  const toned = s.min + (s.max - s.min) * t;
  let size = s.max + (toned - s.max) * s.fromTone;
  const jr = fract(rand * 7919.13);
  size *= 1 + (jr - 0.5) * 2 * s.jitter;
  size = Math.max(size, 0);

  const r = layer.rotation;
  const rotation =
    (r.base * Math.PI) / 180 +
    rand * Math.PI * 2 * r.random +
    (grad + Math.PI / 2) * r.followGradient;

  let plate = -1;
  let alpha = layer.color.alpha * layer.color.color[3];
  if (layer.color.mode === 'spot' && inks) {
    let idx = presetInk;
    if (idx === undefined && sampleImage) {
      const [sr, sg, sb] = sampleImage(x, y);
      idx = assignInk(inks, sr, sg, sb, layer.color.mixing, rand, layer.color.matchBy === 'tone');
    }
    if (idx !== undefined) {
      if (idx >= inks.inkCount) alpha = 0; // bare paper: nothing is printed here
      else plate = idx;
    }
  }

  return {
    x, y, size, rotation,
    rgb: evaluateColor(layer.color, tone, rand, x, y, sampleImage, plate),
    alpha,
    ink: plate,
  };
}

function evaluateColor(
  c: ColorParams,
  tone: number,
  rand: number,
  x: number,
  y: number,
  sampleImage?: (x: number, y: number) => [number, number, number],
  ink = -1,
): [number, number, number] {
  let rgb: [number, number, number];
  if (c.mode === 'spot') {
    const p = c.palette[ink] ?? c.paper ?? [1, 1, 1, 1];
    rgb = [p[0], p[1], p[2]];
  } else if (c.mode === 'adaptive') {
    rgb = hsl2rgb(fract((c.hueA + (c.hueB - c.hueA) * tone) / 360), c.saturation, c.lightness);
  } else if (c.mode === 'image' && sampleImage) {
    rgb = sampleImage(x, y);
  } else if (c.mode === 'multicolor' && c.palette.length) {
    const idx = Math.min(c.palette.length - 1, Math.floor(rand * c.palette.length));
    const p = c.palette[idx];
    rgb = [p[0], p[1], p[2]];
  } else {
    rgb = [c.color[0], c.color[1], c.color[2]];
  }
  // Spot mode opts out, exactly as the shader does: a dot nudged off its ink
  // would be printed from a screen whose colour the proof never showed.
  if (c.mode === 'spot') return rgb;
  const wobble = 1 + (fract(rand * 5099.7) - 0.5) * 2 * c.jitter;
  return [clamp01(rgb[0] * wobble), clamp01(rgb[1] * wobble), clamp01(rgb[2] * wobble)];
}

function fract(v: number): number {
  return v - Math.floor(v);
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [f(0), f(8), f(4)];
}

// ---------------------------------------------------------------------------
// Shape geometry in a unit box centred on the origin (-0.5 .. 0.5)
// ---------------------------------------------------------------------------

export type ShapeGeometry =
  | { kind: 'circle'; r: number }
  | { kind: 'fill'; d: string; fillRule: 'nonzero' | 'evenodd' }
  | { kind: 'stroke'; d: string; width: number }
  | { kind: 'image'; href: string };

/**
 * Vector geometry for a shape, matching what `rasterizeShape` draws.
 *
 * Built-ins and imported SVG both come out as real paths, so a stipple exported
 * to SVG or PDF is genuinely resolution-independent — not a traced bitmap.
 */
export function shapeGeometry(def: ShapeDef): ShapeGeometry {
  const R = SHAPE_R;
  switch (def.kind) {
    case 'circle':
      return { kind: 'circle', r: R };

    case 'polygon': {
      const rng = mulberry32(def.seed);
      const star = def.innerRadius < 1;
      const steps = star ? def.vertices * 2 : def.vertices;
      const pts: string[] = [];
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2 - Math.PI / 2;
        const base = star && i % 2 === 1 ? R * def.innerRadius : R;
        const radius = base * (1 - def.warp * rng());
        pts.push(`${i === 0 ? 'M' : 'L'}${n(Math.cos(t) * radius)},${n(Math.sin(t) * radius)}`);
      }
      return { kind: 'fill', d: `${pts.join('')}Z`, fillRule: 'nonzero' };
    }

    case 'line': {
      // Same skeleton the rasteriser strokes, so the vector mark and the
      // preview mark are the same mark rather than two readings of one spec.
      const { runs, strokeWidth, smooth } = lineSkeleton(def);
      let d = '';
      for (const pts of runs) {
        d += `M${n(pts[0][0])},${n(pts[0][1])}`;
        if (smooth && pts.length > 2) {
          for (let i = 1; i < pts.length - 1; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[i + 1];
            d += `Q${n(x0)},${n(y0)} ${n((x0 + x1) / 2)},${n((y0 + y1) / 2)}`;
          }
          const last = pts[pts.length - 1];
          d += `L${n(last[0])},${n(last[1])}`;
        } else {
          for (let i = 1; i < pts.length; i++) d += `L${n(pts[i][0])},${n(pts[i][1])}`;
        }
      }
      return { kind: 'stroke', d, width: strokeWidth };
    }

    case 'svg': {
      // Imported paths are stored in a 0..1 box; recentre them on the origin and
      // apply the same padding the atlas tile uses so vector and raster agree.
      const scale = 1 - SHAPE_PAD;
      const d = def.paths
        .map((p) => transformPath(p, scale, -0.5 * scale, -0.5 * scale))
        .join('');
      return { kind: 'fill', d, fillRule: def.fillRule };
    }

    case 'raster':
      return { kind: 'image', href: def.data };
  }
}

/** Shift and scale a path made only of M/L/Q/Z commands (what we ever emit). */
function transformPath(d: string, scale: number, tx: number, ty: number): string {
  return d.replace(/(-?\d*\.?\d+),(-?\d*\.?\d+)/g, (_, a: string, b: string) =>
    `${n(parseFloat(a) * scale + tx)},${n(parseFloat(b) * scale + ty)}`);
}

function n(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export function cssColor(rgb: [number, number, number]): string {
  const c = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

export function rgbaCss(c: RGBA): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
}
