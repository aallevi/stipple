import type {
  ColorParams, DistributionAlgo, DistributionParams, JitteredParams, Layer, LayerMask,
  HalftoneParams, Prefilter, Project, RotationParams, ShapeDef, SizeParams, Transform,
} from './types';
import { unitPx } from './scale';

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export const BUILTIN_SHAPES: ShapeDef[] = [
  { kind: 'circle', id: 'circle', name: 'Circle' },
  { kind: 'polygon', id: 'triangle', name: 'Triangle', vertices: 3, warp: 0, innerRadius: 1, seed: 1 },
  { kind: 'polygon', id: 'square', name: 'Square', vertices: 4, warp: 0, innerRadius: 1, seed: 1 },
  { kind: 'polygon', id: 'hexagon', name: 'Hexagon', vertices: 6, warp: 0, innerRadius: 1, seed: 1 },
  { kind: 'polygon', id: 'star', name: 'Star', vertices: 5, warp: 0, innerRadius: 0.45, seed: 1 },
  // `thickness` is a fraction of the mark's own extent, so these read as line
  // weights: a dash is about a seventh as thick as it is long, a burst arm a
  // thirteenth. See `lineSkeleton` for why that is the useful way round.
  { kind: 'line', id: 'dash', name: 'Dash', style: 'linear', length: 0.9, segments: 1, thickness: 0.15, warp: 0, seed: 1 },
  { kind: 'line', id: 'cross', name: 'Cross', style: 'radial', length: 0.9, segments: 2, thickness: 0.12, warp: 0, seed: 1 },
  { kind: 'line', id: 'burst', name: 'Burst', style: 'radial', length: 0.95, segments: 6, thickness: 0.075, warp: 0, seed: 1 },
  { kind: 'line', id: 'squiggle', name: 'Squiggle', style: 'rounded', length: 0.9, segments: 4, thickness: 0.13, warp: 0.55, seed: 7 },
];

export function defaultPrefilter(): Prefilter {
  return {
    brightness: 0, contrast: 0, gamma: 1, blur: 0, sharpen: 0, invert: false,
    channel: 'luma', ink: [0, 0, 0, 1], undercolor: 1,
  };
}

export function defaultMask(): LayerMask {
  return { toneRange: [0, 1], feather: 0, invert: false };
}

export function defaultSize(): SizeParams {
  // Fractions of the short edge: 0.4 % and 0.06 % of the picture, which is the
  // 4 px and 0.6 px these used to be on the 1024 px document they were dialled
  // in on, and now the same mark on any document.
  return { min: 0.0006, max: 0.004, fromTone: 1, gamma: 1, invert: false, jitter: 0 };
}

export function defaultRotation(): RotationParams {
  return { base: 0, random: 0, followGradient: 0 };
}

export function defaultColor(): ColorParams {
  return {
    mode: 'solid',
    color: [0, 0, 0, 1],
    hueA: 210, hueB: 40, saturation: 0.6, lightness: 0.5,
    palette: [[0.85, 0.2, 0.25, 1], [0.15, 0.4, 0.75, 1], [0.95, 0.75, 0.15, 1]],
    paper: [1, 1, 1, 1],
    matchBy: 'colour',
    mixing: 1,
    jitter: 0,
    alpha: 1,
  };
}

export function defaultTransform(): Transform {
  return { scale: 1, rotate: 0, offsetX: 0, offsetY: 0, flipX: false, flipY: false };
}

export function defaultDistribution(algo: DistributionAlgo): DistributionParams {
  switch (algo) {
    case 'jittered':
      return {
        algo: 'jittered', density: 256, phases: 12, jitter: 0.85,
        overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 1,
      };
    case 'voronoi':
      return {
        algo: 'voronoi', points: 20000, iterations: 16, gamma: 1.6,
        toneRange: [0, 1], invertDensity: false, seed: 1,
      };
    case 'halftone':
      return {
        // 40 lpi on the default 1024px sheet at 300 dpi.
        algo: 'halftone', cells: 136, angle: 45, lattice: 'square',
        toneRange: [0, 1], invertDensity: false,
      };
  }
}

export function defaultLayer(name = 'Stipple', algo: DistributionAlgo = 'jittered'): Layer {
  return {
    id: uid('layer'),
    name,
    visible: true,
    opacity: 1,
    blend: 'normal',
    input: 'source',
    prefilter: defaultPrefilter(),
    mask: defaultMask(),
    distribution: defaultDistribution(algo),
    shapeId: 'circle',
    size: defaultSize(),
    rotation: defaultRotation(),
    color: defaultColor(),
    transform: defaultTransform(),
  };
}

/**
 * Fill in fields a project predates.
 *
 * Projects are plain JSON on disk with no migration step, so every field added
 * after version 1 arrives as `undefined` from an older file. Most of those
 * reach a shader uniform, where `undefined` becomes NaN and the failure is
 * silent — a comparison against NaN is simply always false, so the feature
 * quietly does nothing rather than erroring. Normalising on the way in is much
 * cheaper than defending at every read.
 */
export function normaliseProject(project: Project): Project {
  const dc = defaultColor();
  if (project.canvas && !project.canvas.units) project.canvas.units = 'mm';
  for (const layer of project.layers ?? []) {
    const c = layer.color;
    if (c) {
      if (c.paper === undefined) c.paper = c.mode === 'spot' ? dc.paper : null;
      if (typeof c.mixing !== 'number' || !Number.isFinite(c.mixing)) c.mixing = dc.mixing;
      if (c.matchBy !== 'colour' && c.matchBy !== 'tone') c.matchBy = dc.matchBy;
      if (!Array.isArray(c.palette)) c.palette = dc.palette.map((x) => [...x] as typeof x);
    }
    if (layer.prefilter && layer.prefilter.channel === undefined) layer.prefilter.channel = 'luma';
  }
  if ((project.version ?? 1) < 2) toRelativeLengths(project);
  if ((project.version ?? 1) < 3) toRelativeScreens(project);
  project.version = 3;
  return project;
}

/**
 * Version 2 → 3: a halftone's lines per inch become cells across the short
 * edge, at the size and resolution the file was saved with — so it reopens
 * with exactly the screen it was left with, and from then on scales with it.
 */
function toRelativeScreens(project: Project): void {
  const canvas = project.canvas ?? { width: 1024, height: 1024, dpi: 300 } as Project['canvas'];
  const inches = unitPx(canvas) / Math.max(1, canvas.dpi);
  for (const layer of project.layers ?? []) {
    const d = layer.distribution as HalftoneParams & { lineature?: number };
    if (d?.algo === 'halftone' && typeof d.lineature === 'number') {
      d.cells = Math.max(1, Math.round(d.lineature * inches));
      delete d.lineature;
    }
  }
}

/**
 * Version 1 → 2: canvas pixels become fractions of the short edge.
 *
 * This cannot be done field by field at the point of use, the way the additions
 * above are, because there is nothing about the number `4` that says whether it
 * means four pixels or four times the width of the picture. The version is the
 * only thing that distinguishes them, so the conversion has to happen exactly
 * once, on the way in, for the whole file.
 *
 * The divisor is the short edge the file was *saved* with, so a project reopens
 * looking exactly as it was left; every later resize then carries it along.
 */
function toRelativeLengths(project: Project): void {
  const unit = unitPx(project.canvas ?? { width: 1024, height: 1024 } as Project['canvas']);
  for (const layer of project.layers ?? []) {
    if (layer.size) {
      layer.size.min /= unit;
      layer.size.max /= unit;
    }
    if (layer.prefilter) layer.prefilter.blur /= unit;
    if (layer.transform) {
      layer.transform.offsetX /= unit;
      layer.transform.offsetY /= unit;
    }
    // A stochastic screen also flips from a spacing to a dot count, which is the
    // same reciprocal the generator would have applied anyway.
    const d = layer.distribution as JitteredParams & { spacing?: number };
    if (d?.algo === 'jittered' && typeof d.spacing === 'number') {
      d.density = unit / Math.max(0.5, d.spacing);
      delete d.spacing;
    }
  }
}

export function defaultProject(width = 1024, height = 1024): Project {
  return {
    version: 3,
    canvas: { width, height, dpi: 300, background: [1, 1, 1, 1], units: 'mm' },
    shapes: BUILTIN_SHAPES.map((s) => ({ ...s })),
    layers: [defaultLayer('Stipple 1')],
  };
}
