import type { Layer, Project, RGBA } from '../core/types';
import { oklab } from '../core/color';
import type { Engine } from '../pipeline/engine';
import { assignPlates, inkSetFor } from './geometry';
import { exportSVG, type PlateFilter } from './svg';

/**
 * Splitting a design into the screens it will actually be printed from.
 *
 * A plate is not a layer. A spot-ink layer holds every colour of the print at
 * once and only comes apart when each dot is asked which ink it took; a process
 * separation, by contrast, is already one layer per ink. Both have to end up as
 * the same thing on the exposure table — one black-on-white film per screen —
 * so this module decides, for each layer, whether it belongs to a single plate
 * or has to be split dot by dot, and then drives the exporter once per plate.
 */

export type Plate = { name: string; color: RGBA };

export type PlateSet = {
  plates: Plate[];
  /** Which plate a layer belongs to; `per-point` means split it dot by dot. */
  route(layer: Layer): number | 'per-point';
  warnings: string[];
};

/**
 * Work out what the screens are.
 *
 * Spot layers win when present, because their palette is an explicit statement
 * of "these are my inks". Failing that the stack is assumed to be a process
 * separation, where each solid-coloured layer is already its own plate.
 */
export function collectPlates(project: Project): PlateSet {
  const live = project.layers.filter((l) => l.visible && l.opacity > 0);
  const spot = live.filter((l) => l.color.mode === 'spot' && l.color.palette.length > 0);
  const warnings: string[] = [];

  if (spot.length > 0) {
    const palette = spot[0].color.palette;
    for (const other of spot.slice(1)) {
      if (!samePalette(other.color.palette, palette)) {
        warnings.push(
          `"${other.name}" uses a different set of inks from "${spot[0].name}". ` +
          `Its dots were matched to "${spot[0].name}"'s inks instead — give both layers the same palette to be sure.`,
        );
      }
    }
    const plates = palette.map((c) => ({ name: inkName(c), color: c }));
    const solids = live.filter((l) => l.color.mode === 'solid');
    for (const l of live) {
      if (l.color.mode !== 'spot' && l.color.mode !== 'solid') {
        warnings.push(`"${l.name}" is ${modeLabel(l.color.mode)}, which is not one ink — it was left out of the plates.`);
      }
    }
    const routeOf = new Map<string, number>();
    for (const l of solids) {
      const { index, distance } = nearestPlate(plates, l.color.color);
      routeOf.set(l.id, index);
      // Routing a layer to a plate that is not really its colour is the kind of
      // mistake you only find after the screen is burned, so say so here.
      if (distance > 0.12) {
        warnings.push(
          `"${l.name}" prints in a colour none of the inks match; it was put on the ` +
          `${plates[index]?.name ?? 'first'} plate. Check that is what you want.`,
        );
      }
    }
    return {
      plates,
      warnings,
      route: (l) => (l.color.mode === 'spot' ? 'per-point' : routeOf.get(l.id) ?? -1),
    };
  }

  // No spot layer: treat each distinct solid ink as a plate, which is exactly
  // what "Separate into inks…" leaves behind.
  const plates: Plate[] = [];
  const routeOf = new Map<string, number>();
  for (const l of live) {
    if (l.color.mode !== 'solid') {
      warnings.push(`"${l.name}" is ${modeLabel(l.color.mode)}, which is not one ink — it was left out of the plates.`);
      continue;
    }
    const c = l.color.color;
    let idx = plates.findIndex((p) => sameColor(p.color, c));
    if (idx < 0) {
      idx = plates.length;
      plates.push({ name: l.name || inkName(c), color: c });
    }
    routeOf.set(l.id, idx);
  }
  return { plates, warnings, route: (l) => routeOf.get(l.id) ?? -1 };
}

export type PlateExport = {
  files: { name: string; data: string }[];
  warnings: string[];
};

function baseFrom(name: string | undefined): string {
  return (name ?? 'stipple').replace(/\.[a-z]+$/i, '');
}

function plateFile(base: string, index: number, plate: Plate): string {
  return `${base}-${index + 1}-${slug(plate.name)}.svg`;
}

/**
 * What `exportPlates` would write, without building any of it.
 *
 * The caller has to confirm before a folder of files appears, and confirming
 * needs only the names and the warnings. Generating every film first and then
 * asking — as this used to — built megabytes of SVG that a cancelled dialog
 * threw straight away.
 */
export function planPlates(project: Project, baseName?: string): {
  files: string[];
  warnings: string[];
} {
  const set = collectPlates(project);
  const base = baseFrom(baseName);
  return {
    files: set.plates.map((p, i) => plateFile(base, i, p)),
    warnings: set.warnings,
  };
}

/**
 * One film per screen, plus a proof.
 *
 * The margin is real estate the artwork never uses, so the registration marks
 * can sit outside the image on every film — a quarter inch at the document's
 * own resolution, which is enough to see and to tape.
 */
export function exportPlates(
  engine: Engine,
  project: Project,
  opts: { baseName?: string; proof?: boolean } = {},
): PlateExport {
  const set = collectPlates(project);
  if (set.plates.length === 0) {
    return { files: [], warnings: ['Nothing to separate: no layer prints in a single ink.'] };
  }

  const base = baseFrom(opts.baseName);
  const margin = Math.round(Math.max(24, project.canvas.dpi * 0.25));
  const files: { name: string; data: string }[] = [];

  // Which ink each dot takes is a property of the dot, not of the plate being
  // written, so it is settled once here and reused by every film and the proof.
  engine.prepareForExport();
  const inkIndex = new Map<string, Int16Array>();
  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const points = engine.pointsFor(layer.id);
    if (!points) continue;
    const assigned = assignPlates(
      layer, points, (x, y) => engine.sampleSourceColor(x, y), inkSetFor(layer),
    );
    if (assigned) inkIndex.set(layer.id, assigned);
  }

  set.plates.forEach((plate, index) => {
    const filter: PlateFilter = { index, route: set.route };
    files.push({
      name: plateFile(base, index, plate),
      data: exportSVG(engine, project, {
        plate: filter,
        mono: true,
        margin,
        inkIndex,
        label: `${base}  ${index + 1}/${set.plates.length}  ${plate.name}`,
      }),
    });
  });

  if (opts.proof !== false) {
    // The proof is the whole stack in colour, with the same marks in the same
    // places — so you can hold it against the films and check that nothing
    // dropped out between the preview and the separation.
    files.push({
      name: `${base}-proof.svg`,
      data: exportSVG(engine, project, {
        margin,
        inkIndex,
        label: `${base}  proof  ${set.plates.length} inks`,
      }),
    });
  }

  return { files, warnings: set.warnings };
}

function samePalette(a: RGBA[], b: RGBA[]): boolean {
  return a.length === b.length && a.every((c, i) => sameColor(c, b[i]));
}

function sameColor(a: RGBA, b: RGBA): boolean {
  return Math.abs(a[0] - b[0]) < 0.004 && Math.abs(a[1] - b[1]) < 0.004 && Math.abs(a[2] - b[2]) < 0.004;
}

function nearestPlate(plates: Plate[], c: RGBA): { index: number; distance: number } {
  const [tl, ta, tb] = oklab(c[0], c[1], c[2]);
  let best = Infinity;
  let index = -1;
  plates.forEach((p, i) => {
    const [l, a, b] = oklab(p.color[0], p.color[1], p.color[2]);
    const d = (tl - l) ** 2 + (ta - a) ** 2 + (tb - b) ** 2;
    if (d < best) { best = d; index = i; }
  });
  return { index, distance: Math.sqrt(best) };
}

function modeLabel(mode: string): string {
  return mode === 'adaptive' ? 'a hue ramp'
    : mode === 'image' ? 'sampled from the image'
    : mode === 'multicolor' ? 'a random palette pick'
    : mode;
}

/**
 * A rough name for an ink, so films are called `poster-2-magenta.svg` rather
 * than `poster-2.svg` and cannot be taped to the wrong screen.
 */
export function inkName(c: RGBA): string {
  const [r, g, b] = [c[0], c[1], c[2]];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma < 0.08) {
    return max > 0.92 ? 'white' : max > 0.7 ? 'light grey' : max > 0.3 ? 'grey' : 'black';
  }
  let h = 0;
  if (max === r) h = ((g - b) / chroma + 6) % 6;
  else if (max === g) h = (b - r) / chroma + 2;
  else h = (r - g) / chroma + 4;
  h *= 60;

  const dark = max < 0.55;
  // Warm, muted and mid-light is the range earth palettes live in, and calling
  // those "orange" makes a three-ink poster read as orange, orange and orange.
  const muted = chroma / max < 0.62;
  if (h >= 15 && h < 70 && muted && !dark) return max < 0.8 ? 'tan' : 'sand';

  if (h < 15 || h >= 345) return dark ? 'maroon' : 'red';
  if (h < 40) return dark ? 'brown' : 'orange';
  if (h < 70) return dark ? 'olive' : 'yellow';
  if (h < 160) return dark ? 'forest' : 'green';
  if (h < 200) return dark ? 'teal' : 'cyan';
  if (h < 255) return dark ? 'navy' : 'blue';
  if (h < 290) return dark ? 'aubergine' : 'violet';
  return dark ? 'plum' : 'magenta';
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ink';
}
