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
    version: 1,
    canvas: { width, height, dpi: 300, background: bg, units: 'mm' },
    shapes: [],
    layers,
  };
}

function tune(layer: Layer, patch: Partial<Layer>): Layer {
  return { ...layer, ...patch };
}

export const PRESETS: Preset[] = [
  {
    name: 'Classic stipple',
    build: (w, h) => {
      const l = defaultLayer('Stipple');
      return project(w, h, [tune(l, {
        distribution: { ...l.distribution, algo: 'jittered', spacing: 3, phases: 24, jitter: 1, overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 1 },
        size: { min: 0.5, max: 1.9, fromTone: 1, invert: false, jitter: 0.2 },
      })]);
    },
  },
  {
    name: 'Voronoi drawing',
    build: (w, h) => {
      const l = defaultLayer('Voronoi', 'voronoi');
      return project(w, h, [tune(l, {
        distribution: { algo: 'voronoi', points: 40000, iterations: 24, gamma: 1.8, toneRange: [0, 1], invertDensity: false, seed: 3 },
        size: { min: 1, max: 2.6, fromTone: 0.6, invert: false, jitter: 0.15 },
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
          distribution: { algo: 'halftone', lineature: 34, angle, lattice: 'square', toneRange: [0, 1], invertDensity: false },
          size: { min: 0, max: 9, fromTone: 1, invert: false, jitter: 0 },
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
        distribution: { algo: 'jittered', spacing: 5, phases: 16, jitter: 0.9, overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 5 },
        size: { min: 2, max: 9, fromTone: 0.7, invert: false, jitter: 0.3 },
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
          distribution: { algo: 'jittered', spacing: 3.5, phases: 16, jitter: 1, overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 1 },
          size: { min: 0.8, max: 3.4, fromTone: 1, invert: false, jitter: 0.1 },
        }),
        tune(over, {
          input: 'below',
          blend: 'multiply',
          shapeId: 'star',
          distribution: { algo: 'jittered', spacing: 9, phases: 8, jitter: 1, overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 42 },
          size: { min: 5, max: 18, fromTone: 1, invert: false, jitter: 0.4 },
          rotation: { base: 0, random: 1, followGradient: 0 },
          color: { ...over.color, mode: 'solid', color: [0.82, 0.14, 0.08, 1], alpha: 0.9 },
          // Blur turns the dots beneath into continuous tone; the negative
          // brightness re-centres that tone (which sits up near white) so the
          // contrast gain has something to expand.
          prefilter: { ...over.prefilter, blur: 14, brightness: -0.24, contrast: 0.3 },
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
          distribution: { algo: 'jittered', spacing: 6, phases: 10, jitter: 1, overpaint: 1, toneRange: [0, 1], invertDensity: false, seed: 11 },
          size: { min: 3, max: 11, fromTone: 0.8, invert: false, jitter: 0.5 },
          rotation: { base: 0, random: 0.3, followGradient: 0.7 },
        }),
        tune(light, {
          shapeId: 'circle',
          mask: { toneRange: [0.45, 1], feather: 0.15, invert: false },
          distribution: { algo: 'jittered', spacing: 3, phases: 20, jitter: 1, overpaint: 0, toneRange: [0, 1], invertDensity: false, seed: 12 },
          size: { min: 0.4, max: 1.6, fromTone: 1, invert: false, jitter: 0.2 },
        }),
      ]);
    },
  },
  {
    name: 'Colour sampled',
    build: (w, h) => {
      const l = defaultLayer('Sampled');
      return project(w, h, [tune(l, {
        distribution: { algo: 'jittered', spacing: 4, phases: 32, jitter: 1, overpaint: 1, toneRange: [0, 1], invertDensity: false, seed: 7 },
        size: { min: 1.5, max: 6, fromTone: 0.5, invert: false, jitter: 0.25 },
        color: { ...l.color, mode: 'image', jitter: 0.08 },
      })], [0.06, 0.06, 0.08, 1]);
    },
  },
];
