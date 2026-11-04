/**
 * Minimal DOM control kit.
 *
 * Deliberately not a framework: the whole UI is a few dozen controls bound to a
 * plain object, and a virtual DOM would sit between the slider and the render
 * loop for no benefit. Each control owns its element and exposes `sync()` so the
 * panel can push new values in after an undo or a preset load.
 */

export type Control = { el: HTMLElement; sync(): void };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

/** Signals the engine to drop to preview quality while a control is dragged. */
export type Interaction = {
  begin(): void;
  end(): void;
};

/** Wraps a bare element so it can sit in a `section` alongside real controls. */
export function raw(el: HTMLElement): Control {
  return { el, sync() {} };
}

export function hint(text: string): Control {
  return raw(h('p', { class: 'hint' }, text));
}

/**
 * A line of derived text, recomputed on every `sync`.
 *
 * Most sliders in this app are fractions of something else, and a bare "0.15"
 * does not say what it is a fraction of. Pairing the relative control with the
 * absolute value it resolves to is what makes the two legible together.
 */
export function readout(get: () => string): Control {
  const value = h('span', {});
  return {
    el: h('div', { class: 'ctl-readout' }, value),
    sync() { value.textContent = get(); },
  };
}

/** A labelled divider inside a section, for grouping related controls. */
export function group(title: string): Control {
  return raw(h('div', { class: 'ctl-group' }, title));
}

/**
 * Drags in flight, and the one window listener that ends them.
 *
 * A drag has to be ended by a `pointerup` anywhere, not just on the control, or
 * releasing outside the window leaves the engine pinned to preview quality for
 * the rest of the session. But one window listener *per control* leaks: the
 * inspector rebuilds its whole panel whenever the layer, unit or resolution
 * changes, and the listeners of the panel it threw away stay registered. So
 * there is a single listener here, and controls come and go from this set.
 */
const activeDrags = new Set<() => void>();
let windowEndBound = false;

function bindWindowEnd(): void {
  if (windowEndBound) return;
  windowEndBound = true;
  window.addEventListener('pointerup', () => {
    for (const end of [...activeDrags]) end();
  });
}

/** Hold the engine in preview quality for the whole of a drag. */
function bindDrag(el: HTMLElement, ia: Interaction | undefined): void {
  if (!ia) return;
  let active = false;
  const end = (): void => {
    if (!active) return;
    active = false;
    activeDrags.delete(end);
    ia.end();
  };
  const begin = (): void => {
    if (active) return;
    active = true;
    activeDrags.add(end);
    ia.begin();
  };
  el.addEventListener('pointerdown', begin);
  // A keyboard nudge never produces a pointer event, so it ends on its own keyup.
  el.addEventListener('keydown', begin);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keyup', end);
  el.addEventListener('blur', end);
  bindWindowEnd();
}

/** Paints the filled portion of a range track up to its current value. */
function paintTrack(input: HTMLInputElement, min: number, max: number, v: number): void {
  const t = max > min ? (v - min) / (max - min) : 0;
  input.style.setProperty('--fill', `${Math.min(1, Math.max(0, t)) * 100}%`);
}

/**
 * Track positions a logarithmic slider is divided into.
 *
 * The range input has to carry integers for the browser to step cleanly, so a
 * log control maps its value onto this many notches and back. A thousand is
 * finer than the track is wide on any screen, which is the only thing that
 * matters — the number field is how you type an exact value.
 */
const LOG_NOTCHES = 1000;

export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
  interaction?: Interaction;
  /** Shown after the number field — "px", "°", "lpi". */
  unit?: string;
  /** Double-clicking the label snaps back to this. */
  reset?: number;
  title?: string;
  /** A short explanation behind an ⓘ beside the label, for a phone that has no tooltips. */
  info?: string;
  /**
   * `log` spaces the track by ratio rather than by difference.
   *
   * For a quantity that spans decades — a dot count from a dozen to a couple of
   * thousand — a linear track spends nine tenths of its length in the range you
   * never want and gives the useful end two pixels. On a log track every part of
   * it moves the value by the same *proportion*, so the fine end is as
   * adjustable as the coarse one. Ignored unless `min` is above zero.
   */
  curve?: 'linear' | 'log';
}): Control {
  const log = opts.curve === 'log' && opts.min > 0 && opts.max > opts.min;
  const ratio = log ? Math.log(opts.max / opts.min) : 0;
  const toPos = (v: number): number =>
    log ? Math.round((Math.log(Math.max(opts.min, v) / opts.min) / ratio) * LOG_NOTCHES) : v;
  const fromPos = (t: number): number => {
    if (!log) return t;
    const v = opts.min * Math.exp((t / LOG_NOTCHES) * ratio);
    // Snap to the caller's step so a dot count stays a whole number of dots.
    return opts.step > 0 ? Math.round(v / opts.step) * opts.step : v;
  };

  const input = h('input', {
    type: 'range',
    min: String(log ? 0 : opts.min),
    max: String(log ? LOG_NOTCHES : opts.max),
    step: String(log ? 1 : opts.step),
  }) as HTMLInputElement;
  const num = h('input', { type: 'number', class: 'num', step: String(opts.step) }) as HTMLInputElement;
  const tip = opts.title ?? opts.label;
  const name = h('span', { class: 'ctl-label', title: tip }, opts.label);
  const field = h('div', { class: `ctl-num${opts.unit ? ' has-unit' : ''}` }, num);
  if (opts.unit) field.append(h('span', { class: 'unit' }, opts.unit));

  const row = h('div', { class: 'ctl' }, name, input, field);
  const el = opts.info ? withInfo(row, name, opts.label, opts.info) : row;

  const show = (v: number): void => {
    input.value = String(toPos(v));
    num.value = fmt(v, opts.step);
    paintTrack(input, log ? 0 : opts.min, log ? LOG_NOTCHES : opts.max, toPos(v));
  };

  const push = (v: number): void => {
    const clamped = Math.min(opts.max, Math.max(opts.min, Number.isFinite(v) ? v : opts.min));
    opts.set(clamped);
    show(clamped);
  };

  input.addEventListener('input', () => push(fromPos(parseFloat(input.value))));
  num.addEventListener('change', () => push(parseFloat(num.value)));

  if (opts.reset !== undefined) {
    name.classList.add('resettable');
    name.title = `${tip}\nDouble-click to reset`;
    name.addEventListener('dblclick', () => push(opts.reset!));
  }

  bindDrag(input, opts.interaction);

  return {
    el,
    sync() {
      show(opts.get());
    },
  };
}

function fmt(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : String(step).split('.')[1]?.length ?? 2;
  return v.toFixed(decimals);
}

export function select<T extends string>(opts: {
  label: string;
  options: { value: T; label: string }[];
  get(): T;
  set(v: T): void;
  title?: string;
}): Control {
  const sel = h('select') as HTMLSelectElement;
  for (const o of opts.options) sel.append(h('option', { value: o.value }, o.label));
  sel.addEventListener('change', () => opts.set(sel.value as T));
  return {
    el: h('div', { class: 'ctl ctl-select' },
      h('span', { class: 'ctl-label', title: opts.title ?? opts.label }, opts.label),
      h('div', { class: 'select-wrap' }, sel),
    ),
    sync() {
      sel.value = opts.get();
    },
  };
}

export function toggle(opts: {
  label: string;
  get(): boolean;
  set(v: boolean): void;
  title?: string;
}): Control {
  const input = h('input', { type: 'checkbox', class: 'switch-input' }) as HTMLInputElement;
  input.addEventListener('change', () => opts.set(input.checked));
  return {
    el: h('label', { class: 'ctl ctl-toggle', title: opts.title ?? opts.label },
      h('span', { class: 'ctl-label' }, opts.label),
      h('span', { class: 'switch' }, input, h('span', { class: 'switch-track' })),
    ),
    sync() {
      input.checked = opts.get();
    },
  };
}

export function colorControl(opts: {
  label: string;
  get(): [number, number, number, number];
  set(v: [number, number, number, number]): void;
  interaction?: Interaction;
}): Control {
  const swatch = h('input', { type: 'color', class: 'swatch' }) as HTMLInputElement;
  const alpha = h('input', { type: 'range', min: '0', max: '1', step: '0.01', class: 'alpha' }) as HTMLInputElement;
  const readout = h('span', { class: 'readout' });

  const emit = (): void => {
    const [r, g, b] = hexToRGB(swatch.value);
    const a = parseFloat(alpha.value);
    opts.set([r, g, b, a]);
    paintTrack(alpha, 0, 1, a);
    readout.textContent = `${swatch.value.toUpperCase()} · ${Math.round(a * 100)}%`;
  };
  swatch.addEventListener('input', emit);
  alpha.addEventListener('input', emit);
  bindDrag(swatch, opts.interaction);
  bindDrag(alpha, opts.interaction);

  return {
    el: h('div', { class: 'ctl ctl-color' },
      h('span', { class: 'ctl-label', title: opts.label }, opts.label),
      h('div', { class: 'color-pair' }, swatch, alpha),
      readout,
    ),
    sync() {
      const c = opts.get();
      swatch.value = rgbToHex(c[0], c[1], c[2]);
      alpha.value = String(c[3]);
      paintTrack(alpha, 0, 1, c[3]);
      readout.textContent = `${swatch.value.toUpperCase()} · ${Math.round(c[3] * 100)}%`;
    },
  };
}

/**
 * A row of ink swatches.
 *
 * Eight stacked colour rows would push everything else off the panel, and a
 * palette is read as a set anyway — you judge inks against each other, not one
 * at a time. So they sit on one line, in print order, at a size big enough to
 * hit.
 */
export function paletteControl(opts: {
  label: string;
  get(): [number, number, number, number][];
  set(v: [number, number, number, number][]): void;
  title?: string;
  interaction?: Interaction;
}): Control {
  const row = h('div', { class: 'palette-row' });
  let inputs: HTMLInputElement[] = [];

  const rebuild = (n: number): void => {
    inputs = [];
    for (let i = 0; i < n; i++) {
      const sw = h('input', { type: 'color', class: 'swatch ink' }) as HTMLInputElement;
      sw.title = `Ink ${i + 1}`;
      sw.addEventListener('input', () => {
        const next = opts.get().slice();
        const [r, g, b] = hexToRGB(sw.value);
        next[i] = [r, g, b, 1];
        opts.set(next);
      });
      bindDrag(sw, opts.interaction);
      inputs.push(sw);
    }
    row.replaceChildren(...inputs);
  };

  return {
    el: h('div', { class: 'ctl ctl-palette' },
      h('span', { class: 'ctl-label', title: opts.title ?? opts.label }, opts.label),
      row,
    ),
    sync() {
      const p = opts.get();
      if (inputs.length !== p.length) rebuild(p.length);
      p.forEach((c, i) => { inputs[i].value = rgbToHex(c[0], c[1], c[2]); });
    },
  };
}

/**
 * A two-handle window over 0..1, used for tone ranges.
 *
 * Both handles ride one track with the selected span highlighted, so the control
 * reads as a window rather than as two unrelated sliders. The inputs are
 * pointer-transparent except for their thumbs, which is what lets them overlap.
 */
export function rangeControl(opts: {
  label: string;
  get(): [number, number];
  set(v: [number, number]): void;
  interaction?: Interaction;
  title?: string;
}): Control {
  const mk = (cls: string): HTMLInputElement =>
    h('input', { type: 'range', min: '0', max: '1', step: '0.01', class: cls }) as HTMLInputElement;
  const lo = mk('dual-lo');
  const hi = mk('dual-hi');
  const fill = h('span', { class: 'dual-fill' });
  const readout = h('span', { class: 'readout' });

  const paint = (a: number, b: number): void => {
    fill.style.left = `${a * 100}%`;
    fill.style.right = `${(1 - b) * 100}%`;
    readout.textContent = `${a.toFixed(2)} – ${b.toFixed(2)}`;
  };

  const emit = (): void => {
    // Keep the handles ordered rather than letting them cross, which would
    // silently produce an empty window.
    let a = parseFloat(lo.value);
    let b = parseFloat(hi.value);
    if (a > b) [a, b] = [b, a];
    opts.set([a, b]);
    paint(a, b);
  };
  lo.addEventListener('input', emit);
  hi.addEventListener('input', emit);
  bindDrag(lo, opts.interaction);
  bindDrag(hi, opts.interaction);

  return {
    el: h('div', { class: 'ctl ctl-range' },
      h('span', { class: 'ctl-label', title: opts.title ?? opts.label }, opts.label),
      h('div', { class: 'dual' }, h('span', { class: 'dual-track' }), fill, lo, hi),
      readout,
    ),
    sync() {
      const [a, b] = opts.get();
      lo.value = String(a);
      hi.value = String(b);
      paint(a, b);
    },
  };
}

/**
 * Show a control only when a condition holds, without rebuilding the panel.
 *
 * The alternative — putting the condition in the inspector's rebuild key — tears
 * down and recreates every control in the section whenever it flips, which kills
 * whatever drag or colour picker was open at the time. Toggling `hidden` on one
 * element does not.
 */
export function when(cond: () => boolean, inner: Control): Control {
  return {
    el: inner.el,
    sync() {
      const on = cond();
      inner.el.hidden = !on;
      if (on) inner.sync();
    },
  };
}

export function section(
  title: string,
  controls: Control[],
  collapsed = false,
  actions: HTMLElement[] = [],
  /**
   * What the section is for, in a sentence or three, behind an ⓘ in its header.
   * A tooltip would do on a desktop, but a phone has no hover, and the sections
   * that need explaining are exactly the ones whose names do not say enough.
   */
  info?: string,
): Control {
  const body = h('div', { class: 'section-body' }, ...controls.map((c) => c.el));
  // The header is a row rather than one big button so it can carry its own
  // actions — a button inside a button is not valid markup and swallows clicks.
  const toggleBtn = h('button', { class: 'section-toggle', type: 'button' },
    h('span', { class: 'chev' }), title);
  const head = h('div', { class: 'section-head' }, toggleBtn);
  const el = h('div', { class: `section${collapsed ? ' collapsed' : ''}` }, head, body);

  const tools: HTMLElement[] = [...actions];
  if (info) {
    const note = h('p', { class: 'section-info', hidden: '' }, info);
    const infoBtn = h('button', {
      class: 'info-btn', type: 'button', title: `What is ${title}?`, 'aria-expanded': 'false',
    }, 'i');
    infoBtn.addEventListener('click', () => {
      const show = note.hidden;
      note.hidden = !show;
      infoBtn.classList.toggle('on', show);
      infoBtn.setAttribute('aria-expanded', String(show));
      // Asking what a folded section is for should also show you the section.
      if (show) el.classList.remove('collapsed');
    });
    body.prepend(note);
    tools.unshift(infoBtn);
  }
  if (tools.length) head.append(h('div', { class: 'section-actions' }, ...tools));

  toggleBtn.addEventListener('click', () => el.classList.toggle('collapsed'));
  return {
    el,
    sync() {
      for (const c of controls) c.sync();
    },
  };
}

export function button(label: string, onClick: () => void, cls = '', title?: string): HTMLButtonElement {
  const b = h('button', { class: `btn ${cls}`.trim(), type: 'button' }, label) as HTMLButtonElement;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

export function hexToRGB(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Sliders under a finger, for touch screens.
 *
 * A native range input takes a touch on its track as "jump here", so on a phone
 * — where the sidebar is wall-to-wall sliders — every attempt to scroll the panel
 * lands on one and silently changes a setting on the way. Under a coarse pointer
 * the stylesheet makes range inputs pointer-transparent and this takes over:
 * a gesture that goes vertical first is left to the browser and scrolls, and one
 * that goes sideways first drags the slider *relative to where it was*, a full
 * track width for the full range. A tap does nothing, as on iOS. The rest of the
 * kit never knows: the input receives the same input and change events a mouse
 * drag would produce, and the same pointerdown/up that hold preview quality.
 */
export function installTouchSliders(root: HTMLElement): void {
  const coarse = window.matchMedia('(pointer: coarse)');
  const SLOP = 8;

  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !coarse.matches) return;
    const row = (e.target as HTMLElement).closest('.ctl');
    const ranges = row ? [...row.querySelectorAll<HTMLInputElement>('input[type=range]')] : [];
    if (!ranges.length) return;
    const track = ranges[0].getBoundingClientRect();
    // The label and the number field keep their own behaviour.
    if (e.clientX < track.left - SLOP || e.clientX > track.right + SLOP) return;

    const id = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let input: HTMLInputElement | null = null;
    let start = 0;

    const range = (el: HTMLInputElement): { min: number; max: number; step: number } => ({
      min: parseFloat(el.min) || 0,
      max: parseFloat(el.max) || 100,
      step: parseFloat(el.step) || 0,
    });

    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== id) return;
      const dx = ev.clientX - x0;
      if (!input) {
        if (Math.abs(ev.clientY - y0) > SLOP) return finish();
        if (Math.abs(dx) <= SLOP) return;
        // Two handles on one track: take the one nearer where the finger came down.
        input = ranges.reduce((best, el) => {
          const r = range(el);
          const at = (el: HTMLInputElement): number =>
            track.left + ((parseFloat(el.value) - r.min) / (r.max - r.min || 1)) * track.width;
          return Math.abs(at(el) - x0) < Math.abs(at(best) - x0) ? el : best;
        });
        start = parseFloat(input.value);
        input.dispatchEvent(new PointerEvent('pointerdown'));
      }
      const r = range(input);
      let v = start + (dx / Math.max(1, track.width)) * (r.max - r.min);
      if (r.step > 0) v = r.min + Math.round((v - r.min) / r.step) * r.step;
      v = Math.min(r.max, Math.max(r.min, v));
      if (String(v) !== input.value) {
        input.value = String(v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };

    const finish = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!input) return;
      input.dispatchEvent(new PointerEvent('pointerup'));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input = null;
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId === id) finish();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/**
 * Give one control an ⓘ beside its label and a note under it, the same as a
 * section's. Returns the wrapper to use in place of `row`.
 */
function withInfo(row: HTMLElement, label: HTMLElement, title: string, text: string): HTMLElement {
  const note = h('p', { class: 'section-info ctl-info', hidden: '' }, text);
  const btn = h('button', { class: 'info-btn', type: 'button', title: `What is ${title}?`, 'aria-expanded': 'false' }, 'i');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const show = note.hidden;
    note.hidden = !show;
    btn.classList.toggle('on', show);
    btn.setAttribute('aria-expanded', String(show));
  });
  // Take the label's place first, then adopt it — a wrapper built around the
  // label would already contain it and could not stand in for it.
  const wrap = h('span', { class: 'ctl-label-wrap' });
  label.replaceWith(wrap);
  wrap.append(label, btn);
  return h('div', { class: 'ctl-stack' }, row, note);
}
