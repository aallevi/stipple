import type { Store } from '../core/store';
import type { CanvasSettings, ShapeDef } from '../core/types';
import { SHAPE_PAD } from '../shape/rasterize';
import { hint, readout, select, slider, type Control, type Interaction } from './controls';
import { formatLength } from './units';

/**
 * Geometry controls for whichever shape the selected layer is stamping.
 *
 * These edit the project's own copy of the shape, not a global preset, so a
 * document can carry a six-armed burst and a two-armed cross without the two
 * fighting over one definition. The atlas keys its tiles on the serialised
 * definition, so a drag here re-rasterises exactly one tile and nothing else.
 */
export function shapeParamControls(
  store: Store,
  ia: Interaction,
  shapeId: string,
  /** The layer's dark-end size in px, for resolving the fractions below. */
  sizePx: () => number,
  /** For writing those pixels back out in the document's own unit. */
  canvas: () => CanvasSettings,
): Control[] {
  const def = store.get().shapes.find((s) => s.id === shapeId);
  if (!def) return [hint('This layer points at a shape that is no longer in the library.')];

  // Every shape is drawn to the same radius inside its cell, so this one line
  // converts any of the fractions below into the pixels they actually produce.
  const across = (): number => sizePx() * (1 - SHAPE_PAD);
  const len = (px: number): string => formatLength(px, canvas());

  switch (def.kind) {
    case 'line':
      return [
        ...lineControls(store, ia, def),
        readout(() => {
          const d = store.get().shapes.find((x) => x.id === shapeId) as LineDef | undefined;
          if (!d) return '';
          const extent = across() * d.length;
          return `${len(extent)} long · ${len(extent * d.thickness)} thick, in the darks`;
        }),
      ];
    case 'polygon':
      return [
        ...polygonControls(store, ia, def),
        readout(() => `${len(across())} across, in the darks`),
      ];
    case 'circle':
      return [
        hint('A circle has no geometry to tune. Duplicate a line or polygon shape, or import your own.'),
        readout(() => `${len(across())} across, in the darks`),
      ];
    case 'svg':
      return [hint(`Vector artwork imported from a file — ${def.paths.length} path${def.paths.length === 1 ? '' : 's'}, drawn as-is.`),
        readout(() => `${len(across())} across, in the darks`)];
    case 'raster':
      return [hint(`Bitmap stamp imported from a file — ${def.width}×${def.height}, masked by its alpha channel.`),
        readout(() => `${len(across())} across, in the darks`)];
  }
}


type LineDef = Extract<ShapeDef, { kind: 'line' }>;
type PolygonDef = Extract<ShapeDef, { kind: 'polygon' }>;

function lineControls(store: Store, ia: Interaction, initial: LineDef): Control[] {
  const id = initial.id;
  const d = (): LineDef => store.get().shapes.find((s) => s.id === id) as LineDef;
  const set = (patch: Partial<LineDef>): void => store.updateShape(id, patch);

  // Spokes radiate from the centre, so each "segment" is a pair of opposed arms;
  // a chain lays its segments end to end. Naming the slider for what you get
  // avoids having to explain that difference.
  const radial = initial.style === 'radial';

  return [
    select<LineDef['style']>({
      label: 'Line style',
      title: 'Spokes burst from the centre; a chain runs end to end, straight or smoothed',
      options: [
        { value: 'radial', label: 'Spokes (burst)' },
        { value: 'linear', label: 'Chain (straight)' },
        { value: 'rounded', label: 'Chain (smoothed)' },
      ],
      get: () => d().style,
      set: (v) => set({ style: v }),
    }),
    slider({
      label: radial ? 'Arms' : 'Segments',
      min: 1, max: 24, step: 1, interaction: ia,
      title: radial
        ? 'Number of spoke pairs radiating from the centre'
        : 'Number of straight runs the line is broken into',
      get: () => d().segments,
      set: (v) => set({ segments: Math.round(v) }),
    }),
    slider({
      label: 'Length',
      min: 0.05, max: 1, step: 0.01, interaction: ia,
      reset: 0.9,
      title: 'The mark\u2019s whole extent, caps included, as a fraction of the layer size',
      get: () => d().length,
      set: (v) => set({ length: v }),
    }),
    slider({
      label: 'Thickness',
      min: 0.01, max: 1, step: 0.01, interaction: ia,
      reset: 0.15,
      title: 'Stroke width as a fraction of the mark\u2019s own length, so it reads as line weight at any size',
      get: () => d().thickness,
      set: (v) => set({ thickness: v }),
    }),
    slider({
      label: 'Waviness',
      min: 0, max: 1, step: 0.01, interaction: ia,
      reset: 0,
      title: 'Random displacement per joint — 0 is a clean line, 1 is a scribble',
      get: () => d().warp,
      set: (v) => set({ warp: v }),
    }),
    slider({
      label: 'Shape seed',
      min: 1, max: 9999, step: 1,
      title: 'Re-rolls the random displacement without changing its amount',
      get: () => d().seed,
      set: (v) => set({ seed: Math.round(v) }),
    }),
  ];
}

function polygonControls(store: Store, ia: Interaction, initial: PolygonDef): Control[] {
  const id = initial.id;
  const d = (): PolygonDef => store.get().shapes.find((s) => s.id === id) as PolygonDef;
  const set = (patch: Partial<PolygonDef>): void => store.updateShape(id, patch);

  return [
    slider({
      label: 'Sides',
      min: 3, max: 24, step: 1, interaction: ia,
      get: () => d().vertices,
      set: (v) => set({ vertices: Math.round(v) }),
    }),
    slider({
      label: 'Inner radius',
      min: 0.05, max: 1, step: 0.01, interaction: ia,
      reset: 1,
      title: 'Below 1 pulls every other vertex inward, turning the polygon into a star',
      get: () => d().innerRadius,
      set: (v) => set({ innerRadius: v }),
    }),
    slider({
      label: 'Irregularity',
      min: 0, max: 1, step: 0.01, interaction: ia,
      reset: 0,
      title: 'Random radial displacement per vertex, for a hand-cut edge',
      get: () => d().warp,
      set: (v) => set({ warp: v }),
    }),
    slider({
      label: 'Shape seed',
      min: 1, max: 9999, step: 1,
      title: 'Re-rolls the random displacement without changing its amount',
      get: () => d().seed,
      set: (v) => set({ seed: Math.round(v) }),
    }),
  ];
}
