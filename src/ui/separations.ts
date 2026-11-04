import { defaultLayer } from '../core/defaults';
import { unitPx } from '../core/scale';
import type { Layer, Project, RGBA } from '../core/types';
import { inkName } from '../export/plates';

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
};

/**
 * Every separation is halftone plates, one per ink.
 *
 * There used to be stippled variants of most of these. They were worse prints —
 * a stochastic screen ruled to the same fineness reads as noise next to a
 * halftone, and plates with independent random dots clump where they coincide
 * — and they were never needed as presets: each plate is an ordinary layer, so
 * switching one to Stochastic or Voronoi afterwards is one menu away, with the
 * ink, the measuring and the multiply blend all kept.
 *
 * So the list is ink sets, not screen-and-ink combinations, and any palette
 * worth printing by hand belongs in it.
 */
export const SEPARATIONS: Record<string, SeparationKind> = {
  cmyk: {
    label: 'CMYK (4 plates)',
    inks: [
      { name: 'Cyan', color: CYAN },
      { name: 'Magenta', color: MAGENTA },
      { name: 'Yellow', color: YELLOW },
      { name: 'Black', color: BLACK },
    ],
  },
  cmy: {
    label: 'CMY, no black (3 plates)',
    inks: [
      { name: 'Cyan', color: CYAN },
      { name: 'Magenta', color: MAGENTA },
      { name: 'Yellow', color: YELLOW },
    ],
  },
  rgb: {
    label: 'Red, green, blue (3 plates)',
    inks: [
      { name: 'Red', color: [0.85, 0.12, 0.14, 1] },
      { name: 'Green', color: [0.0, 0.62, 0.31, 1] },
      { name: 'Blue', color: [0.11, 0.25, 0.68, 1] },
    ],
  },
  riso: {
    label: 'Risograph · pink, blue, yellow (3 plates)',
    inks: [
      { name: 'Fluoro pink', color: [1.0, 0.28, 0.56, 1] },
      { name: 'Blue', color: [0.0, 0.47, 0.84, 1] },
      { name: 'Yellow', color: [1.0, 0.9, 0.0, 1] },
    ],
  },
  earth: {
    label: 'Earth · brown, tan, ochre (3 plates)',
    inks: [
      { name: 'Brown', color: [0.32, 0.18, 0.11, 1] },
      { name: 'Tan', color: [0.66, 0.45, 0.28, 1] },
      { name: 'Ochre', color: [0.89, 0.72, 0.35, 1] },
    ],
  },
  tritone: {
    label: 'Tritone · ochre, teal, black (3 plates)',
    inks: [
      { name: 'Ochre', color: [0.85, 0.6, 0.15, 1] },
      { name: 'Teal', color: [0.0, 0.45, 0.48, 1] },
      { name: 'Black', color: BLACK },
    ],
  },
  duotone: {
    label: 'Duotone · warm red, black (2 plates)',
    inks: [
      { name: 'Warm red', color: [0.89, 0.25, 0.2, 1] },
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
  // 45 lines per inch at the size the document is now, written down as cells
  // across it — from here on the screen scales with the picture like
  // everything else does.
  const cells = Math.max(4, Math.round((45 * unitPx(canvas)) / Math.max(1, canvas.dpi)));

  return kind.inks.map((ink, i) => {
    const layer = defaultLayer(ink.name, 'halftone');
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
    layer.distribution = {
      algo: 'halftone', cells, angle: ANGLES[i % ANGLES.length],
      lattice: 'square', toneRange: [0, 1], invertDensity: false,
    };
    // gamma 0.5 makes ink *area* track coverage, which is the whole point of a
    // halftone: with a linear ramp a 50% grey prints at about 68%.
    // A circle inscribed in its cell covers only 79% of it, so a halftone dot
    // has to overfill the cell to reach solid; corner to corner is sqrt(2) of
    // a cell, and a cell is 1/cells of the short edge.
    layer.size = { ...layer.size, min: 0, max: Math.SQRT2 / cells, fromTone: 1, gamma: 0.5, jitter: 0 };
    return layer;
  });
}

/** A plate whose ink is close enough to neutral to carry the greys. */
function isNeutral(c: RGBA): boolean {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 0.12
    && Math.max(c[0], c[1], c[2]) < 0.35;
}

/**
 * One stipple layer per colour, each drawing only the part of the picture that
 * is closest to its own colour.
 *
 * The third way to a set of screens, between the two that already existed.
 * Spot inks choose a colour per dot but share one layer, so every colour has
 * the same shape and pattern; ink plates give each ink its own layer but
 * measure the way process inks overprint, which muddies a palette that was
 * never meant to mix. Here every layer uses the closest-colour measure against
 * its siblings, so the regions fit together without overlapping and each one is
 * a layer of its own — shape, size, density and screen free to differ.
 *
 * `colours` are the inks, picked or found; the caller puts the result in a group,
 * which is what gives the layers their set of competitors.
 */
export function buildColourLayers(colours: RGBA[], groupId: string): Layer[] {
  return colours.map((c, i) => {
    const layer = defaultLayer(inkName(c), 'jittered');
    layer.groupId = groupId;
    layer.blend = 'multiply';
    layer.prefilter = {
      ...layer.prefilter,
      channel: 'nearest',
      ink: c,
      nearestMix: 0.15,
      nearestTone: false,
      nearestPaper: true,
    };
    layer.color = { ...layer.color, mode: 'solid', color: c };
    // Different seeds, or neighbouring regions would put their dots on the
    // same lattice and the borders would read as seams.
    layer.distribution = { ...layer.distribution, seed: 1 + i * 137 } as Layer['distribution'];
    return layer;
  });
}
