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
      /** The mark's whole extent, caps included, as a fraction of the cell. */
      length: number;     // 0..1
      segments: number;   // 1..24
      /** Stroke width as a fraction of that extent, so it reads as line weight. */
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
  /**
   * Candidate sites across the short edge of the document. Higher = more dots.
   *
   * A count rather than a spacing, and relative to the picture rather than to
   * the canvas pixel grid, because that is the quantity that survives a change
   * of document size: "eight hundred dots across" is the same drawing on a
   * thumbnail and on a poster, where "four pixels apart" is two different ones.
   * `GenContext.unit` turns it back into a spacing at generation time.
   */
  density: number;
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
  /**
   * Initial site count, refined by Lloyd relaxation. Already scale-free — a
   * count of dots is a count of dots whatever size the document is.
   */
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
  /**
   * Screen cells across the short edge of the picture.
   *
   * Relative, like every other length a layer carries, so a halftone keeps its
   * proportions whatever the document is resized to: the cells, the dots in
   * them and the paper between stay the same fraction of the picture. This used
   * to be lines per inch of paper, which made the screen the one thing that did
   * not scale with the drawing — enlarge the sheet and more, relatively smaller
   * cells appeared under dots that had not shrunk with them. The panel still
   * writes the lines-per-inch reading beside it, at the current print size.
   */
  cells: number;
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
  /** Radius as a fraction of the canvas short edge — see `core/scale.ts`. */
  blur: number;
  sharpen: number;    // 0..1
  invert: boolean;
  /**
   * What this layer measures. `luma` is overall tone — the default, and what a
   * single-colour stipple wants. `ink` measures how much of one specific ink the
   * image asks for at each pixel, which is what turns a stack of layers into a
   * set of printable separations.
   *
   * `flat` measures nothing: every pixel reads as fully inked, so the dots land
   * at even density across the whole canvas. That is what a spot-ink layer
   * wants, because there lightness is carried by *which* ink each dot takes —
   * paper included. Leave the density tracking tone as well and the image is
   * darkened twice over, once by having fewer dots and again by their colour.
   *
   * Absent in projects saved before separations existed; treated as `luma`.
   */
  channel?: 'luma' | 'ink' | 'flat' | 'nearest';
  /** For `ink`: the ink being separated, as it prints. For `nearest`: this layer's colour. */
  ink?: RGBA;
  /**
   * For `ink`: how much of the neutral component to leave to a black plate.
   * 1 is full grey-component replacement — the chromatic inks carry only colour,
   * which is what keeps total ink coverage printable. 0 is a naive separation.
   */
  undercolor?: number;
  /**
   * For `nearest`: how soft the borders between colours are. 0 is a hard edge
   * (every pixel belongs to exactly one colour); higher shares the pixels near a
   * border between their two closest colours, so the edge dithers.
   */
  nearestMix?: number;
  /** For `nearest`: dots follow the picture's darkness inside the region (true) or fill it evenly. */
  nearestTone?: boolean;
  /** For `nearest`: the paper competes as a colour, and where it wins nothing prints. */
  nearestPaper?: boolean;
  /**
   * For `nearest`, filled in by the engine at render time and never stored: the
   * colours this layer competes with — every closest-colour layer in its group,
   * itself included — and the paper. Derived rather than saved so a group can
   * never disagree with itself about what its colours are.
   */
  nearestSet?: RGBA[];
  nearestPaperColor?: RGBA | null;
};

export type LayerMask = {
  /** Only place points where the source tone falls inside this window. */
  toneRange: [number, number];
  /** Softens the tone window edges. */
  feather: number;
  invert: boolean;
};

export type SizeParams = {
  /**
   * The mark at each end of the tone range, as a fraction of the canvas short
   * edge — see `core/scale.ts`. Relative rather than in pixels so a stipple
   * keeps its proportions when the document is resized.
   */
  min: number;          // at the light end of the tone range
  max: number;          // at the dark end of the tone range
  /** 0 = every point is `max`, 1 = size fully tracks tone. */
  fromTone: number;
  /**
   * Exponent on the tone-to-size ramp. 1 makes *diameter* track tone, which is
   * what a drawing wants; 0.5 makes *area* track it, which is what a halftone
   * needs — ink coverage goes as the square of the dot, so a linear ramp prints
   * a 50% grey at about 68%. Absent in older projects; treated as 1.
   */
  gamma?: number;
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
  mode: 'solid' | 'adaptive' | 'image' | 'multicolor' | 'spot';
  /** `spot`: colours picked from the picture by hand, which re-sampling keeps. */
  pinned?: RGBA[];
  /** `solid` */
  color: RGBA;
  /** `adaptive`: hue ramp driven by tone. */
  hueA: number;
  hueB: number;
  saturation: number;
  lightness: number;
  /** `multicolor`: random pick from this set. `spot`: the inks to print with. */
  palette: RGBA[];
  /**
   * `spot`: bare stock. Matched against like an ink, but never drawn — dots
   * that land on it leave paper showing, which is how a three-ink poster gets
   * its highlights without a fourth screen. `null` prints every dot.
   */
  paper: RGBA | null;
  /**
   * `spot`: what "nearest ink" is measured on.
   *
   * `colour` compares the full colour, which is what a scatter separation wants.
   * `tone` compares lightness only, so a palette ordered dark to light lands as
   * flat tonal bands — the classic posterise, and the reason a photograph does
   * not break into unrelated hues when you only have three earth inks.
   */
  matchBy: 'colour' | 'tone';
  /**
   * `spot`: how far a dot may stray from its nearest ink, 0..1.
   *
   * 0 posterises — every dot takes the closest ink, so areas come out flat and
   * unmixed. 1 dithers between the two inks that best reconstruct the colour,
   * so the eye mixes them; with process inks that is a scatter separation.
   * In between is a partly mixed print.
   */
  mixing: number;
  /** Random per-point value/alpha wobble, applies to every mode. */
  jitter: number;
  alpha: number;
};

export type Transform = {
  scale: number;
  rotate: number;   // degrees
  /** Fractions of the canvas short edge — see `core/scale.ts`. */
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
  /** The group this layer sits in, if any — see `core/groups.ts`. */
  groupId?: string;
};

/**
 * A folder in the layer stack. Its layers are always one unbroken run of the
 * stack (`tidyGroups` keeps them so), which is what lets a group move, hide and
 * be edited as one thing. It holds no settings of its own: selecting it edits
 * its layers together, each keeping what makes it that colour.
 */
export type LayerGroup = {
  id: string;
  name: string;
  collapsed: boolean;
};

export type CanvasSettings = {
  width: number;
  height: number;
  dpi: number;
  background: RGBA;
  /**
   * What lengths are shown in. The engine works in canvas pixels throughout —
   * this only changes how they are written and typed.
   *
   * A canvas pixel is a poor thing to design in, because opening a bigger
   * photograph makes the document bigger and every mark suddenly reads smaller
   * against it. `mm` and `in` are stable as long as the resolution is; `%` of
   * the short edge is stable whatever happens, which is what you want when the
   * same treatment has to work on images of different sizes.
   */
  units: 'mm' | 'in' | '%' | 'px';
};

/**
 * `2` moved every layer length from canvas pixels to fractions of the short
 * edge, and the stochastic screen from a spacing to a dot count. `3` did the
 * same for the halftone screen, from lines per inch to cells across. Older
 * files are converted on load by `normaliseProject`.
 */
export type ProjectVersion = 1 | 2 | 3;

export type Project = {
  version: ProjectVersion;
  canvas: CanvasSettings;
  shapes: ShapeDef[];
  layers: Layer[];   // index 0 renders first (bottom)
  /** Absent in files saved before groups existed. */
  groups?: LayerGroup[];
};
