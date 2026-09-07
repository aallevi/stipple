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

export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
  interaction?: Interaction;
  format?(v: number): string;
  title?: string;
}): Control {
  const input = h('input', {
    type: 'range',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
  }) as HTMLInputElement;
  const num = h('input', { type: 'number', class: 'num', step: String(opts.step) }) as HTMLInputElement;
  const label = h('label', { class: 'ctl' },
    h('span', { class: 'ctl-label', title: opts.title ?? opts.label }, opts.label),
    input,
    num,
  );

  const push = (v: number): void => {
    const clamped = Math.min(opts.max, Math.max(opts.min, v));
    opts.set(clamped);
    input.value = String(clamped);
    num.value = fmt(clamped, opts.step);
  };

  input.addEventListener('input', () => push(parseFloat(input.value)));
  num.addEventListener('change', () => push(parseFloat(num.value)));

  // Dragging holds the engine in preview quality; releasing restores full.
  if (opts.interaction) {
    input.addEventListener('pointerdown', () => opts.interaction!.begin());
    const end = (): void => opts.interaction!.end();
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('blur', end);
  }

  return {
    el: label,
    sync() {
      const v = opts.get();
      input.value = String(v);
      num.value = fmt(v, opts.step);
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
}): Control {
  const sel = h('select') as HTMLSelectElement;
  for (const o of opts.options) sel.append(h('option', { value: o.value }, o.label));
  sel.addEventListener('change', () => opts.set(sel.value as T));
  return {
    el: h('label', { class: 'ctl' }, h('span', { class: 'ctl-label' }, opts.label), sel),
    sync() {
      sel.value = opts.get();
    },
  };
}

export function toggle(opts: { label: string; get(): boolean; set(v: boolean): void }): Control {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.addEventListener('change', () => opts.set(input.checked));
  return {
    el: h('label', { class: 'ctl ctl-toggle' }, input, h('span', {}, opts.label)),
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
  const swatch = h('input', { type: 'color' }) as HTMLInputElement;
  const alpha = h('input', { type: 'range', min: '0', max: '1', step: '0.01', class: 'alpha' }) as HTMLInputElement;

  const emit = (): void => {
    const [r, g, b] = hexToRGB(swatch.value);
    opts.set([r, g, b, parseFloat(alpha.value)]);
  };
  swatch.addEventListener('input', emit);
  alpha.addEventListener('input', emit);
  if (opts.interaction) {
    for (const el of [swatch, alpha]) {
      el.addEventListener('pointerdown', () => opts.interaction!.begin());
      el.addEventListener('pointerup', () => opts.interaction!.end());
    }
  }

  return {
    el: h('label', { class: 'ctl' }, h('span', { class: 'ctl-label' }, opts.label), swatch, alpha),
    sync() {
      const c = opts.get();
      swatch.value = rgbToHex(c[0], c[1], c[2]);
      alpha.value = String(c[3]);
    },
  };
}

/** A two-handle window over 0..1, used for tone ranges. */
export function rangeControl(opts: {
  label: string;
  get(): [number, number];
  set(v: [number, number]): void;
  interaction?: Interaction;
}): Control {
  const lo = h('input', { type: 'range', min: '0', max: '1', step: '0.01' }) as HTMLInputElement;
  const hi = h('input', { type: 'range', min: '0', max: '1', step: '0.01' }) as HTMLInputElement;
  const readout = h('span', { class: 'readout' });

  const emit = (): void => {
    // Keep the handles ordered rather than letting them cross, which would
    // silently produce an empty window.
    let a = parseFloat(lo.value);
    let b = parseFloat(hi.value);
    if (a > b) [a, b] = [b, a];
    opts.set([a, b]);
    readout.textContent = `${a.toFixed(2)} – ${b.toFixed(2)}`;
  };
  lo.addEventListener('input', emit);
  hi.addEventListener('input', emit);
  if (opts.interaction) {
    for (const el of [lo, hi]) {
      el.addEventListener('pointerdown', () => opts.interaction!.begin());
      el.addEventListener('pointerup', () => opts.interaction!.end());
    }
  }

  return {
    el: h('div', { class: 'ctl ctl-range' },
      h('span', { class: 'ctl-label' }, opts.label),
      h('div', { class: 'range-pair' }, lo, hi),
      readout,
    ),
    sync() {
      const [a, b] = opts.get();
      lo.value = String(a);
      hi.value = String(b);
      readout.textContent = `${a.toFixed(2)} – ${b.toFixed(2)}`;
    },
  };
}

export function section(title: string, controls: Control[], collapsed = false): Control {
  const body = h('div', { class: 'section-body' }, ...controls.map((c) => c.el));
  const head = h('button', { class: 'section-head', type: 'button' }, title);
  const el = h('div', { class: `section${collapsed ? ' collapsed' : ''}` }, head, body);
  head.addEventListener('click', () => el.classList.toggle('collapsed'));
  return {
    el,
    sync() {
      for (const c of controls) c.sync();
    },
  };
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `btn ${cls}`.trim(), type: 'button' }, label) as HTMLButtonElement;
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
