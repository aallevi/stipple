import { defaultLayer } from '../core/defaults';
import type { Layer, Project, RGBA } from '../core/types';

/**
 * Build a printable set of separations from one image.
 *
 * A screenprint is not one picture, it is N single-colour plates that only
 * become the picture once they are stacked. So this produces one layer per ink,
 * each measuring the coverage of *its own* ink (see `inkProjector`) rather than
 * overall tone, each carrying its own screen, and all of them multiplying — the
 * way real ink darkens what is already on the paper.
 *
 * The angles are the classic offsets. Two screens at similar angles beat against
 * each other into a moiré; 30° apart is far enough that the interference lands
 * as a rosette instead, and yellow goes at 0° because it is the weakest ink and
 * shows a pattern least.
 */
const ANGLES = [15, 75, 0, 45, 30, 60, 90, 22.5];

/** Process-ink approximations, chosen so an on-screen multiply reads as the print. */
const CYAN: RGBA = [0.0, 0.67, 0.93, 1];
const MAGENTA: RGBA = [0.93, 0.0, 0.55, 1];
const YELLOW: RGBA = [1.0, 0.94, 0.0, 1];
const BLACK: RGBA = [0.08, 0.08, 0.08, 1];
const WHITE: RGBA = [1, 1, 1, 1];

export type Ink = { name: string; color: RGBA };

export type SeparationKind = {
  /** Shown in the menu. */
  label: string;
  inks: Ink[];
  screen: 'halftone' | 'stochastic';
};

export const SEPARATIONS: Record<string, SeparationKind> = {
  'cmyk-halftone': {
    label: 'CMYK · halftone (4 plates)',
    screen: 'halftone',
    inks: [
      { name: 'Cyan', color: CYAN },
      { name: 'Magenta', color: MAGENTA },
      { name: 'Yellow', color: YELLOW },
      { name: 'Black', color: BLACK },
    ],
  },
  'cmyk-stipple': {
    label: 'CMYK · stipple (4 plates)',
    screen: 'stochastic',
    inks: [
      { name: 'Cyan', color: CYAN },
      { name: 'Magenta', color: MAGENTA },
      { name: 'Yellow', color: YELLOW },
      { name: 'Black', color: BLACK },
    ],
  },
  'cmy-halftone': {
    label: 'CMY · halftone (3 plates)',
    screen: 'halftone',
    inks: [
      { name: 'Cyan', color: CYAN },
      { name: 'Magenta', color: MAGENTA },
      { name: 'Yellow', color: YELLOW },
    ],
  },
  'rgb-stipple': {
    label: 'RGB · stipple (3 plates)',
    screen: 'stochastic',
    inks: [
      { name: 'Red', color: [0.85, 0.12, 0.14, 1] },
      { name: 'Green', color: [0.0, 0.62, 0.31, 1] },
      { name: 'Blue', color: [0.11, 0.25, 0.68, 1] },
    ],
  },
  'duotone': {
    label: 'Duotone · stipple (2 plates)',
    screen: 'stochastic',
    inks: [
      { name: 'Warm red', color: [0.89, 0.25, 0.2, 1] },
      { name: 'Black', color: BLACK },
    ],
  },
  'tritone': {
    label: 'Tritone · stipple (3 plates)',
    screen: 'stochastic',
    inks: [
      { name: 'Ochre', color: [0.85, 0.6, 0.15, 1] },
      { name: 'Teal', color: [0.0, 0.45, 0.48, 1] },
      { name: 'Black', color: BLACK },
    ],
  },
};

/**
 * Ready-made ink sets for the `spot` colour mode.
 *
 * These are the same inks the process separations use, plus the small palettes
 * that get printed by hand: a risograph drawer, a poster tritone. Picking one
 * fills the palette; every swatch stays editable afterwards, because no real
 * ink matches its nominal colour anyway.
 */
export const INK_SETS: Record<string, { label: string; inks: RGBA[]; paper: RGBA | null }> = {
  cmy: { label: 'Process · cyan, magenta, yellow', inks: [CYAN, MAGENTA, YELLOW], paper: WHITE },
  cmyk: { label: 'Process · CMYK', inks: [CYAN, MAGENTA, YELLOW, BLACK], paper: WHITE },
  rgb: { label: 'Red, green, blue', inks: [[0.85, 0.12, 0.14, 1], [0.0, 0.62, 0.31, 1], [0.11, 0.25, 0.68, 1]], paper: WHITE },
  riso: {
    label: 'Risograph · fluoro pink, blue, yellow',
    inks: [[1.0, 0.28, 0.56, 1], [0.0, 0.47, 0.84, 1], [1.0, 0.9, 0.0, 1]],
    paper: [0.98, 0.96, 0.9, 1],
  },
  earth: {
    label: 'Earth · brown, tan, ochre',
    inks: [[0.32, 0.18, 0.11, 1], [0.66, 0.45, 0.28, 1], [0.89, 0.72, 0.35, 1]],
    paper: [0.96, 0.93, 0.85, 1],
  },
  duo: { label: 'Duotone · warm red and black', inks: [[0.89, 0.25, 0.2, 1], BLACK], paper: WHITE },
  mono: { label: 'One ink · black', inks: [BLACK], paper: WHITE },
};

/**
 * One layer per ink, sized to the document so the result is printable as-is.
 *
 * Only the last black-ish plate carries the neutrals: every other ink is built
 * with full grey-component replacement, so a shadow is one dense black plate
 * rather than four plates stacked into a puddle that never dries.
 */
export function buildSeparation(kind: SeparationKind, canvas: Project['canvas']): Layer[] {
  const lineature = 45;
  // A circle inscribed in its cell covers only 79% of it, so a halftone dot has
  // to overfill the cell to reach solid; corner to corner is sqrt(2) across.
  const cell = canvas.dpi / lineature;

  return kind.inks.map((ink, i) => {
    const layer = defaultLayer(ink.name, kind.screen === 'halftone' ? 'halftone' : 'jittered');
    const isKey = i === kind.inks.length - 1 && isNeutral(ink.color);

    layer.blend = 'multiply';
    layer.prefilter = {
      ...layer.prefilter,
      channel: 'ink',
      ink: ink.color,
      // The key plate is the one that *should* carry the greys.
      undercolor: isKey ? 0 : 1,
    };
    layer.color = { ...layer.color, mode: 'solid', color: ink.color };

    if (kind.screen === 'halftone') {
      layer.distribution = {
        algo: 'halftone', lineature, angle: ANGLES[i % ANGLES.length],
        lattice: 'square', toneRange: [0, 1], invertDensity: false,
      };
      // gamma 0.5 makes ink *area* track coverage, which is the whole point of a
      // halftone: with a linear ramp a 50% grey prints at about 68%.
      layer.size = { ...layer.size, min: 0, max: cell * Math.SQRT2, fromTone: 1, gamma: 0.5, jitter: 0 };
    } else {
      layer.distribution = {
        ...layer.distribution,
        // Offsetting the seed per plate keeps two stochastic screens from
        // landing their dots in the same places and clumping.
        seed: 1 + i * 137,
      } as Layer['distribution'];
      layer.size = { ...layer.size, min: 0, max: 3.2, fromTone: 1, gamma: 0.5, jitter: 0.15 };
      layer.rotation = { ...layer.rotation, random: 1 };
    }
    return layer;
  });
}

/** A plate whose ink is close enough to neutral to carry the greys. */
function isNeutral(c: RGBA): boolean {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 0.12
    && Math.max(c[0], c[1], c[2]) < 0.35;
}
