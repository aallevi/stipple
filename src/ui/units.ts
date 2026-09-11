import type { CanvasSettings } from '../core/types';
import { slider, type Control, type Interaction } from './controls';

/**
 * Lengths, in units a person can hold in their head.
 *
 * The engine measures everything in canvas pixels, and it should: they are the
 * grid the point buffers and the atlas live on. But a canvas pixel is a bad
 * thing to *design* in, because it is not a fixed quantity. Open a bigger
 * photograph and the document grows to match it, so a 4 px dot that read as a
 * coarse stipple on one image reads as a fine one on the next, and none of the
 * numbers you tuned carry over.
 *
 * So the sliders are labelled in something stable and converted here, in one
 * place. Nothing downstream of the panel knows this module exists.
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
    // depending on which way up the picture is.
    case '%': return Math.max(1, Math.min(canvas.width, canvas.height)) / 100;
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

/**
 * A slider whose value is stored in canvas pixels and shown in the document's
 * unit. `minPx`/`maxPx` are the range in pixels; everything the user sees is
 * converted.
 *
 * The control is built against one unit and one resolution, so the inspector
 * has to rebuild when either changes — both are in its key.
 */
export function lengthSlider(opts: {
  label: string;
  minPx: number;
  maxPx: number;
  canvas: CanvasSettings;
  get(): number;
  set(v: number): void;
  interaction?: Interaction;
  /** In canvas pixels, like `get`/`set`. */
  reset?: number;
  title?: string;
}): Control {
  const { canvas } = opts;
  const per = pxPerUnit(canvas);
  const min = opts.minPx / per;
  const max = opts.maxPx / per;
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
    reset: opts.reset === undefined ? undefined : opts.reset / per,
    title: opts.title ? `${opts.title}\nMeasured in ${unit}; change the unit in Document` : undefined,
    get: () => opts.get() / per,
    set: (v) => opts.set(v * per),
  });
}
