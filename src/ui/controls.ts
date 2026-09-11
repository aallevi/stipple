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
}): Control {
  const input = h('input', {
    type: 'range',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
  }) as HTMLInputElement;
  const num = h('input', { type: 'number', class: 'num', step: String(opts.step) }) as HTMLInputElement;
  const tip = opts.title ?? opts.label;
  const name = h('span', { class: 'ctl-label', title: tip }, opts.label);
  const field = h('div', { class: `ctl-num${opts.unit ? ' has-unit' : ''}` }, num);
  if (opts.unit) field.append(h('span', { class: 'unit' }, opts.unit));

  const row = h('div', { class: 'ctl' }, name, input, field);

  const push = (v: number): void => {
    const clamped = Math.min(opts.max, Math.max(opts.min, Number.isFinite(v) ? v : opts.min));
    opts.set(clamped);
    input.value = String(clamped);
    num.value = fmt(clamped, opts.step);
    paintTrack(input, opts.min, opts.max, clamped);
  };

  input.addEventListener('input', () => push(parseFloat(input.value)));
  num.addEventListener('change', () => push(parseFloat(num.value)));

  if (opts.reset !== undefined) {
    name.classList.add('resettable');
    name.title = `${tip}\nDouble-click to reset`;
    name.addEventListener('dblclick', () => push(opts.reset!));
  }

  bindDrag(input, opts.interaction);

  return {
    el: row,
    sync() {
      const v = opts.get();
      input.value = String(v);
      num.value = fmt(v, opts.step);
      paintTrack(input, opts.min, opts.max, v);
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
): Control {
  const body = h('div', { class: 'section-body' }, ...controls.map((c) => c.el));
  // The header is a row rather than one big button so it can carry its own
  // actions — a button inside a button is not valid markup and swallows clicks.
  const toggleBtn = h('button', { class: 'section-toggle', type: 'button' },
    h('span', { class: 'chev' }), title);
  const head = h('div', { class: 'section-head' }, toggleBtn);
  if (actions.length) head.append(h('div', { class: 'section-actions' }, ...actions));

  const el = h('div', { class: `section${collapsed ? ' collapsed' : ''}` }, head, body);
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
