import { defaultLayer } from '../core/defaults';
import type { Layer, Project } from '../core/types';

/**
 * Starting points that show what the stack can do.
 *
 * Each is a whole layer stack rather than a single-layer setting, because the
 * interesting behaviour here is compositional — several screens at different
 * angles, or a layer reading the render beneath it.
 */
export type Preset = {
  name: string;
  build(width: number, height: number): Project;
};

function project(width: number, height: number, layers: Layer[], bg: [number, number, number, number] = [1, 1, 1, 1]): Project {
  return {
    version: 2,
    canvas: { width, height, dpi: 300, background: bg, units: 'mm' },
    shapes: [],
    layers,
  };
}

function tune(layer: Layer, patch: Partial<Layer>): Layer {
  return { ...layer, ...patch };
}

/**
 * The document these presets were dialled in on, in pixels.
 *
 * Layer lengths are stored as fractions of the short edge now (`core/scale.ts`),
 * which is what makes a preset land the same way on any image — but the numbers
 * below were chosen by eye against a 1024 px square, and "0.00186" says nothing
 * about what it looked like. So they stay written as the pixels they were and
 * are divided here, once, where the reference is stated out loud.
 */
const REF = 1024;
/** What `n` px meant on that document, as a fraction of the picture. */
const px = (n: number): number => n / REF;
/** What a spacing of `n` px meant, as dots across the picture. */
const across = (n: number): number => Math.round(REF / n);

export const PRESETS: Preset[] = [
  {
    name: 'Classic stipple',
    build: (w, h) => {
      const l = defaultLayer('Stipple');
      return project(w, h, [tune(l, {
        distribution: { ...l.distribution, algo: 'jittered', density: across(3), phases: 24, jitter: 1, overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 1 },
        size: { min: px(0.5), max: px(1.9), fromTone: 1, invert: false, jitter: 0.2 },
      })]);
    },
  },
  {
    name: 'Voronoi drawing',
    build: (w, h) => {
      const l = defaultLayer('Voronoi', 'voronoi');
      return project(w, h, [tune(l, {
        distribution: { algo: 'voronoi', points: 40000, iterations: 24, gamma: 1.8, toneRange: [0, 1], invertDensity: false, seed: 3 },
        size: { min: px(1), max: px(2.6), fromTone: 0.6, invert: false, jitter: 0.15 },
      })]);
    },
  },
  {
    name: 'Three-angle screens',
    build: (w, h) => {
      // The classic separation trick: identical screens rotated 30° apart so the
      // dots interleave into a rosette instead of stacking into moiré.
      const angles = [15, 45, 75];
      const colors: [number, number, number, number][] = [
        [0.02, 0.66, 0.86, 1],
        [0.9, 0.14, 0.5, 1],
        [0.98, 0.83, 0.1, 1],
      ];
      const layers = angles.map((angle, i) => {
        const l = defaultLayer(`Screen ${angle}°`, 'halftone');
        return tune(l, {
          blend: 'multiply',
          distribution: { algo: 'halftone', cells: Math.max(4, Math.round((34 * Math.min(w, h)) / 300)), angle, lattice: 'square', toneRange: [0, 1], invertDensity: false },
          size: { min: px(0), max: px(9), fromTone: 1, invert: false, jitter: 0 },
          color: { ...l.color, mode: 'solid', color: colors[i], alpha: 1 },
        });
      });
      return project(w, h, layers);
    },
  },
  {
    name: 'Contour lines',
    build: (w, h) => {
      const l = defaultLayer('Contours');
      return project(w, h, [tune(l, {
        shapeId: 'dash',
        distribution: { algo: 'jittered', density: across(5), phases: 16, jitter: 0.9, overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 5 },
        size: { min: px(2), max: px(9), fromTone: 0.7, invert: false, jitter: 0.3 },
        rotation: { base: 0, random: 0.05, followGradient: 1 },
      })]);
    },
  },
  {
    name: 'Recursive overlay',
    build: (w, h) => {
      // The second layer reads the *render* of the first rather than the photo,
      // so it lands exactly where the first laid down ink — no mask needed, the
      // ink itself is the mask.
      //
      // The base has to be dense enough to read as tone, and the overlay's blur
      // is what turns that scatter of dots back into a continuous field it can
      // sample. Without the blur it would only see individual dots and gaps.
      const base = defaultLayer('Base stipple');
      const over = defaultLayer('Reads below');
      return project(w, h, [
        tune(base, {
          distribution: { algo: 'jittered', density: across(3.5), phases: 16, jitter: 1, overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 1 },
          size: { min: px(0.8), max: px(3.4), fromTone: 1, invert: false, jitter: 0.1 },
        }),
        tune(over, {
          input: 'below',
          blend: 'multiply',
          shapeId: 'star',
          distribution: { algo: 'jittered', density: across(9), phases: 8, jitter: 1, overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 42 },
          size: { min: px(5), max: px(18), fromTone: 1, invert: false, jitter: 0.4 },
          rotation: { base: 0, random: 1, followGradient: 0 },
          color: { ...over.color, mode: 'solid', color: [0.82, 0.14, 0.08, 1], alpha: 0.9 },
          // Blur turns the dots beneath into continuous tone; the negative
          // brightness re-centres that tone (which sits up near white) so the
          // contrast gain has something to expand.
          prefilter: { ...over.prefilter, blur: px(14), brightness: -0.24, contrast: 0.3 },
        }),
      ]);
    },
  },
  {
    name: 'Shadow & highlight',
    build: (w, h) => {
      // Two tone-masked layers with different shapes, which is the cheapest way
      // to get a hand-drawn feel: coarse marks in the shadows, fine in the light.
      const dark = defaultLayer('Shadows');
      const light = defaultLayer('Highlights');
      return project(w, h, [
        tune(dark, {
          shapeId: 'squiggle',
          mask: { toneRange: [0, 0.55], feather: 0.15, invert: false },
          distribution: { algo: 'jittered', density: across(6), phases: 10, jitter: 1, overpaint: 1, toneRange: [0, 1], invertDensity: false, seed: 11 },
          size: { min: px(3), max: px(11), fromTone: 0.8, invert: false, jitter: 0.5 },
          rotation: { base: 0, random: 0.3, followGradient: 0.7 },
        }),
        tune(light, {
          shapeId: 'circle',
          mask: { toneRange: [0.45, 1], feather: 0.15, invert: false },
          distribution: { algo: 'jittered', density: across(3), phases: 20, jitter: 1, overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 12 },
          size: { min: px(0.4), max: px(1.6), fromTone: 1, invert: false, jitter: 0.2 },
        }),
      ]);
    },
  },
  {
    name: 'Colour sampled',
    build: (w, h) => {
      const l = defaultLayer('Sampled');
      return project(w, h, [tune(l, {
        distribution: { algo: 'jittered', density: across(4), phases: 32, jitter: 1, overpaint: 1, toneRange: [0, 1], invertDensity: false, seed: 7 },
        size: { min: px(1.5), max: px(6), fromTone: 0.5, invert: false, jitter: 0.25 },
        color: { ...l.color, mode: 'image', jitter: 0.08 },
      })], [0.06, 0.06, 0.08, 1]);
    },
  },
];
