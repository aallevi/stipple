import { unitPx } from '../core/scale';
import type { CanvasSettings } from '../core/types';
import { slider, type Control, type Interaction } from './controls';

/**
 * Lengths, in units a person can hold in their head.
 *
 * The project stores every layer length as a fraction of the document's short
 * edge (`core/scale.ts`), which is the right thing to *keep* — it is the only
 * form that survives a resize — and a hopeless thing to read: nobody judges a
 * dot by "0.004". So the panel writes those fractions in millimetres, inches or
 * per cent, and converts here, in one place. Nothing downstream of the panel
 * knows this module exists.
 *
 * The canvas's own width and height stay a count of pixels, and `formatLength`
 * is what writes those; layer lengths go through `formatSpan` and
 * `lengthSlider`.
 */

const MM_PER_INCH = 25.4;

export type Unit = CanvasSettings['units'];

/** Canvas pixels per one of the chosen unit. */
export function pxPerUnit(canvas: CanvasSettings): number {
  switch (canvas.units) {
    case 'mm': return Math.max(1, canvas.dpi) / MM_PER_INCH;
    case 'in': return Math.max(1, canvas.dpi);
    // Of the *short* edge, so a tall crop and a wide one agree about what 1%
    // means; against the long edge the same number would read differently
    // depending on which way up the picture is. This is the document unit
    // itself, so `%` is the one display unit that needs no conversion at all.
    case '%': return unitPx(canvas) / 100;
    default: return 1;
  }
}

export function fromPx(px: number, canvas: CanvasSettings): number {
  return px / pxPerUnit(canvas);
}

export function toPx(v: number, canvas: CanvasSettings): number {
  return v * pxPerUnit(canvas);
}

export function unitLabel(canvas: CanvasSettings): string {
  return canvas.units === 'in' ? 'in' : canvas.units;
}

/**
 * A sensible step for the unit, given how far the slider travels.
 *
 * Picked from the range rather than fixed per unit, because the same document
 * hosts a 0–3 mm dot size and a 0–90 mm spacing, and one step cannot serve both
 * without either juddering or offering false precision.
 */
function stepFor(span: number): number {
  if (span <= 2) return 0.001;
  if (span <= 20) return 0.01;
  if (span <= 200) return 0.1;
  return 1;
}

/**
 * How many decimals a unit is worth writing to.
 *
 * Fixed per unit rather than derived from the value: a readout that says
 * "lights 0.051 mm → darks 0.34 mm" has written one number to three places and
 * the other to two, and the eye reads that as a difference in kind rather than
 * as the same quantity twice.
 */
function decimalsFor(canvas: CanvasSettings): number {
  switch (canvas.units) {
    case 'in': return 3;
    case 'mm': return 2;
    case '%': return 2;
    default: return 1;
  }
}

export function formatLength(px: number, canvas: CanvasSettings): string {
  return `${fromPx(px, canvas).toFixed(decimalsFor(canvas))} ${unitLabel(canvas)}`;
}

/** Display units per one document unit — see `core/scale.ts`. */
function perDoc(canvas: CanvasSettings): number {
  return unitPx(canvas) / pxPerUnit(canvas);
}

/**
 * The same as `formatLength`, for a length stored relative to the document.
 *
 * Every length a layer carries is one of these, so this is what the panel's
 * readouts speak; `formatLength` is left for the canvas's own dimensions, which
 * really are a count of pixels.
 */
export function formatSpan(doc: number, canvas: CanvasSettings): string {
  return formatLength(doc * unitPx(canvas), canvas);
}

/**
 * A slider over a length stored relative to the document, shown in the
 * document's unit.
 *
 * `min`/`max`/`get`/`set`/`reset` are all in document units — fractions of the
 * canvas short edge, the way layers store every length (see `core/scale.ts`).
 * That is what gives a big picture the same freedom of movement as a small one:
 * the range is a proportion of the picture, so a slider that reaches a coarse
 * mark on a postcard reaches an equally coarse one on a poster, instead of
 * topping out at a hairline because the pixel count went up.
 *
 * The control is built against one unit and one resolution, so the inspector
 * has to rebuild when either changes — both are in its key.
 */
export function lengthSlider(opts: {
  label: string;
  /** Range in document units — fractions of the canvas short edge. */
  min: number;
  max: number;
  canvas: CanvasSettings;
  get(): number;
  set(v: number): void;
  interaction?: Interaction;
  /** In document units, like `get`/`set`. */
  reset?: number;
  title?: string;
}): Control {
  const { canvas } = opts;
  const per = perDoc(canvas);
  const min = opts.min * per;
  const max = opts.max * per;
  // The slider may need finer steps than the readout shows — a 5 mm range wants
  // hundredths — but never coarser, or typing a number into the field would
  // round to something the readout then contradicts.
  const step = Math.min(stepFor(max - min), 10 ** -decimalsFor(canvas));
  const unit = unitLabel(canvas);

  return slider({
    label: opts.label,
    min: Math.round(min / step) * step,
    max: Math.round(max / step) * step,
    step,
    unit,
    interaction: opts.interaction,
    reset: opts.reset === undefined ? undefined : opts.reset * per,
    title: opts.title ? `${opts.title}\nMeasured in ${unit}; change the unit in Document` : undefined,
    get: () => opts.get() * per,
    set: (v) => opts.set(v / per),
  });
}
