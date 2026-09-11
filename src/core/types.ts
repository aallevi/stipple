/**
 * Project model.
 *
 * Everything the engine renders is derived from a `Project`. It is plain JSON —
 * no class instances, no cycles — so save/load is `JSON.stringify` and undo is a
 * structural clone. Anything expensive (decoded pixels, GL buffers, SDF atlases)
 * lives in caches keyed by the ids below, never in here.
 */

export type RGBA = [number, number, number, number]; // 0..1

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'difference'
  | 'add';

export const BLEND_MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'add',
];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Built-in shapes are generated procedurally; imported ones carry their source. */
export type ShapeDef =
  | { kind: 'circle'; id: string; name: string }
  | {
      kind: 'polygon';
      id: string;
      name: string;
      vertices: number;   // 3..24
      warp: number;       // 0..1 random radial displacement per vertex
      innerRadius: number; // 1 = convex polygon, <1 = star
      seed: number;
    }
  | {
      kind: 'line';
      id: string;
      name: string;
      style: 'linear' | 'radial' | 'rounded';
      length: number;     // 0..1 relative to the shape cell
      segments: number;   // 1..24
      thickness: number;  // 0..1
      warp: number;
      seed: number;
    }
  | {
      /** Imported .svg — `paths` are normalised into a unit box for rendering,
       *  and kept verbatim so vector export can emit real geometry. */
      kind: 'svg';
      id: string;
      name: string;
      paths: string[];      // path `d` strings, already transformed to a unit box
      viewBox: [number, number, number, number];
      fillRule: 'nonzero' | 'evenodd';
    }
  | {
      /** Imported raster with alpha. `data` is a base64 data URL so projects stay
       *  self-contained; the SDF is derived from the alpha channel. */
      kind: 'raster';
      id: string;
      name: string;
      data: string;
      width: number;
      height: number;
    };

export type ShapeKind = ShapeDef['kind'];

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

export type JitteredParams = {
  algo: 'jittered';
  /** Distance between candidate sites, in canvas px. Lower = more points. */
  spacing: number;
  /** Number of discrete brightness bands. Higher = smoother tonal fidelity. */
  phases: number;
  /** 0 = perfect grid, 1 = fully random within the cell. */
  jitter: number;
  /** Extra passes offset by half a cell — the reference tool's "overpaint". */
  overpaint: number;
  /** Tones outside this window place no points at all. */
  toneRange: [number, number];
  /** Place points in the dark regions (false) or the light ones (true). */
  invertDensity: boolean;
  seed: number;
};

export type VoronoiParams = {
  algo: 'voronoi';
  /** Initial site count, refined by Lloyd relaxation. */
  points: number;
  /** Relaxation iterations. ~20 is visually converged for most images. */
  iterations: number;
  /** Density exponent: >1 pushes points harder into the dark areas. */
  gamma: number;
  toneRange: [number, number];
  invertDensity: boolean;
  seed: number;
};

export type HalftoneParams = {
  algo: 'halftone';
  /** Lines per inch of the screen. */
  lineature: number;
  /** Screen rotation in degrees. */
  angle: number;
  /** Grid geometry. */
  lattice: 'square' | 'hex' | 'line';
  toneRange: [number, number];
  invertDensity: boolean;
};

export type DistributionParams = JitteredParams | VoronoiParams | HalftoneParams;
export type DistributionAlgo = DistributionParams['algo'];

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export type Prefilter = {
  brightness: number; // -1..1
  contrast: number;   // -1..1
  gamma: number;      // 0.1..4
  blur: number;       // px
  sharpen: number;    // 0..1
  invert: boolean;
};

export type LayerMask = {
  /** Only place points where the source tone falls inside this window. */
  toneRange: [number, number];
  /** Softens the tone window edges. */
  feather: number;
  invert: boolean;
};

export type SizeParams = {
  min: number;          // px, at the light end of the tone range
  max: number;          // px, at the dark end of the tone range
  /** 0 = every point is `max`, 1 = size fully tracks tone. */
  fromTone: number;
  /** Flip which end of the tone range gets the big points. */
  invert: boolean;
  /** Random size variation, 0..1. */
  jitter: number;
};

export type RotationParams = {
  base: number;      // degrees
  /** Random rotation per point, 0..1 of a full turn. */
  random: number;
  /** Rotate to face the image gradient — makes line shapes follow contours. */
  followGradient: number;
};

export type ColorParams = {
  mode: 'solid' | 'adaptive' | 'image' | 'multicolor';
  /** `solid` */
  color: RGBA;
  /** `adaptive`: hue ramp driven by tone. */
  hueA: number;
  hueB: number;
  saturation: number;
  lightness: number;
  /** `multicolor`: random pick from this set. */
  palette: RGBA[];
  /** Random per-point value/alpha wobble, applies to every mode. */
  jitter: number;
  alpha: number;
};

export type Transform = {
  scale: number;
  rotate: number;   // degrees
  offsetX: number;
  offsetY: number;
  flipX: boolean;
  flipY: boolean;
};

export type Layer = {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  /** `source` samples density from the photo; `below` samples the composited
   *  render of every layer beneath it — that is what makes stacking recursive. */
  input: 'source' | 'below';
  prefilter: Prefilter;
  mask: LayerMask;
  distribution: DistributionParams;
  shapeId: string;
  size: SizeParams;
  rotation: RotationParams;
  color: ColorParams;
  transform: Transform;
};

export type CanvasSettings = {
  width: number;
  height: number;
  dpi: number;
  background: RGBA;
};

export type Project = {
  version: 1;
  canvas: CanvasSettings;
  shapes: ShapeDef[];
  layers: Layer[];   // index 0 renders first (bottom)
};
