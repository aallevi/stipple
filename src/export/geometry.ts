import type { ColorParams, Layer, RGBA, ShapeDef } from '../core/types';
import { mulberry32 } from '../core/rng';
import { SHAPE_PAD } from '../shape/rasterize';

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
};

export function evaluatePoint(
  layer: Layer,
  x: number,
  y: number,
  tone: number,
  grad: number,
  rand: number,
  sampleImage?: (x: number, y: number) => [number, number, number],
): EvaluatedPoint {
  const s = layer.size;
  const ink = s.invert ? tone : 1 - tone;
  const toned = s.min + (s.max - s.min) * ink;
  let size = s.max + (toned - s.max) * s.fromTone;
  const jr = fract(rand * 7919.13);
  size *= 1 + (jr - 0.5) * 2 * s.jitter;
  size = Math.max(size, 0);

  const r = layer.rotation;
  const rotation =
    (r.base * Math.PI) / 180 +
    rand * Math.PI * 2 * r.random +
    (grad + Math.PI / 2) * r.followGradient;

  return {
    x, y, size, rotation,
    rgb: evaluateColor(layer.color, tone, rand, x, y, sampleImage),
    alpha: layer.color.alpha * layer.color.color[3],
  };
}

function evaluateColor(
  c: ColorParams,
  tone: number,
  rand: number,
  x: number,
  y: number,
  sampleImage?: (x: number, y: number) => [number, number, number],
): [number, number, number] {
  let rgb: [number, number, number];
  if (c.mode === 'adaptive') {
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
  const R = 0.5 * (1 - SHAPE_PAD);
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
      const rng = mulberry32(def.seed);
      const len = R * def.length;
      let d = '';
      if (def.style === 'radial') {
        for (let i = 0; i < def.segments * 2; i++) {
          const a = (i / (def.segments * 2)) * Math.PI * 2;
          const l = len * (1 - def.warp * rng());
          d += `M0,0L${n(Math.cos(a) * l)},${n(Math.sin(a) * l)}`;
        }
      } else {
        const pts: [number, number][] = [];
        for (let i = 0; i <= def.segments; i++) {
          const t = i / def.segments;
          pts.push([(t - 0.5) * 2 * len, (rng() - 0.5) * 2 * len * def.warp]);
        }
        d = `M${n(pts[0][0])},${n(pts[0][1])}`;
        if (def.style === 'rounded' && pts.length > 2) {
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
      return { kind: 'stroke', d, width: def.thickness * 0.5 };
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
