import type { CurvePoint, Levels } from '../core/types';
import {
  IDENTITY, NEUTRAL_LEVELS, addCurvePoint, gammaToPosition, levelsFn, monotoneSpline,
  moveCurvePoint, positionToGamma, removeCurvePoint,
} from '../image/curves';
import { h, type Control, type Interaction } from './controls';

/**
 * The curve editor, and the two-handle tone window drawn over a histogram.
 *
 * Both came over from Contour. The curve editor gained an output rail and an
 * output histogram on the way: the input levels ride a rail under the x axis
 * as there, the output levels a rail beside the y axis, and the tones the
 * layer finally measures lie along that side as faint bars — so the curve is
 * drawn between the two distributions it turns one into the other.
 */

export type Channel = 'tone' | 'r' | 'g' | 'b';
const CHANNELS: Channel[] = ['tone', 'r', 'g', 'b'];
const CHANNEL_NAME: Record<Channel, string> = { tone: 'Tone', r: 'R', g: 'G', b: 'B' };
const CHANNEL_INK: Record<Channel, string> = { tone: '#111', r: '#b3261e', g: '#2e7d32', b: '#1f5fbf' };

/** Theme colours, read from the stylesheet so the canvases match the chrome. */
function palette(): { field: string; line: string; text: string; faint: string; accent: string } {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string, d: string): string => cs.getPropertyValue(k).trim() || d;
  return {
    field: v('--field', '#d6d6d6'), line: v('--line', '#7d7d7d'), text: v('--text', '#111'),
    faint: v('--text-faint', '#4f4f4f'), accent: v('--accent', '#ff9b21'),
  };
}

const dpr = (): number => Math.min(3, window.devicePixelRatio || 1);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const b255 = (v: number): string => String(Math.round(clamp01(v) * 255));

/** Drags on a canvas hold the engine in preview quality, like a slider's do. */
function holdWhileDragging(canvas: HTMLCanvasElement, ia: Interaction | undefined): () => void {
  let active = false;
  const end = (): void => { if (active) { active = false; ia?.end(); } };
  canvas.addEventListener('lostpointercapture', end);
  canvas.addEventListener('pointercancel', end);
  return () => { if (!active) { active = true; ia?.begin(); } };
}

// -- curve editor ------------------------------------------------------------

export type CurveEditorOptions = {
  get(ch: Channel): CurvePoint[];
  set(ch: Channel, points: CurvePoint[]): void;
  levels: { get(): Levels; set(patch: Partial<Levels>): void };
  /** Tones going into levels, and what the layer measures in the end; null before the first build. */
  tones(): { in: Uint32Array; out: Uint32Array } | null;
  /** The picture's red, green and blue, for the colour tabs. */
  channels(): [Uint32Array, Uint32Array, Uint32Array] | null;
  interaction?: Interaction;
};

/** Width of the rails, in CSS pixels: input levels below the plot, output levels to its left. */
const RAIL = 14;

export function curveEditor(o: CurveEditorOptions): Control {
  let channel: Channel = 'tone';
  const tabs = CHANNELS.map((c) => {
    const b = h('button', { class: 'curve-tab', type: 'button' }, CHANNEL_NAME[c]) as HTMLButtonElement;
    b.title = c === 'tone'
      ? 'The measured tone, with the levels on the rails'
      : `The picture’s ${({ r: 'red', g: 'green', b: 'blue' })[c]}, before the layer measures it`;
    b.addEventListener('click', () => { channel = c; selected = -1; sync(); });
    return b;
  });
  const resetCh = h('button', { class: 'btn sm', type: 'button' }, 'Reset') as HTMLButtonElement;
  resetCh.title = 'Straighten this curve (and, on Tone, neutralise the levels)';
  resetCh.addEventListener('click', () => {
    o.set(channel, [...IDENTITY].map((p) => ({ ...p })));
    if (channel === 'tone') o.levels.set({ ...NEUTRAL_LEVELS });
    selected = -1;
    sync();
  });
  const head = h('div', { class: 'curve-head' }, h('div', { class: 'curve-tabs' }, ...tabs), resetCh);

  const canvas = h('canvas', { class: 'curve-canvas', tabindex: '0' }) as HTMLCanvasElement;
  const readout = h('div', { class: 'curve-readout' });
  const el = h('div', { class: 'curve-editor' }, head, canvas, readout);

  let selected = -1;
  let hovered = -1;
  /** The dragged point, re-found by x after every move: the list is re-sorted each time. */
  let dragX = NaN;
  let dragRail: 'black' | 'gamma' | 'white' | 'outBlack' | 'outWhite' | null = null;
  let cursor: CurvePoint | null = null;
  const begin = holdWhileDragging(canvas, o.interaction);

  /** The plot's box in CSS pixels, inside the canvas. */
  const plotBox = (): { x: number; y: number; w: number; h: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: RAIL, y: 0, w: Math.max(1, r.width - RAIL), h: Math.max(1, r.height - RAIL) };
  };
  const local = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toCurve = (e: PointerEvent): CurvePoint => {
    const p = local(e);
    const b = plotBox();
    return { x: clamp01((p.x - b.x) / b.w), y: clamp01(1 - (p.y - b.y) / b.h) };
  };

  /** Nearest handle within reach, measured in screen pixels so the reach never changes with size. */
  const hitPoint = (p: CurvePoint): number => {
    const b = plotBox();
    const pts = o.get(channel);
    let best = -1;
    let bestD = 11 ** 2;
    pts.forEach((q, i) => {
      const d = ((q.x - p.x) * b.w) ** 2 + ((q.y - p.y) * b.h) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  const railHit = (e: PointerEvent): typeof dragRail => {
    if (channel !== 'tone') return null;
    const p = local(e);
    const b = plotBox();
    const l = o.levels.get();
    if (p.y > b.h && p.x >= b.x - 4) {
      const t = (p.x - b.x) / b.w;
      const mid = l.inBlack + (l.inWhite - l.inBlack) * gammaToPosition(l.gamma);
      const cands: [NonNullable<typeof dragRail>, number][] = [['black', l.inBlack], ['gamma', mid], ['white', l.inWhite]];
      return nearestOf(cands, t, 10 / b.w);
    }
    if (p.x < b.x && p.y <= b.h) {
      const t = 1 - p.y / b.h;
      return nearestOf([['outBlack', l.outBlack], ['outWhite', l.outWhite]], t, 10 / b.h);
    }
    return null;
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    const rail = railHit(e);
    if (rail) {
      dragRail = rail;
      begin();
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const lp = local(e);
    if (lp.x < RAIL || lp.y > plotBox().h) return;
    const p = toCurve(e);
    let i = hitPoint(p);
    // Alt-click, right-click or a double-click removes. Dragging a handle off
    // the plot does not: that makes an accidental removal look like a clumsy drag.
    if (e.altKey || e.button === 2 || (e.detail >= 2 && i > 0)) {
      if (i > 0) o.set(channel, removeCurvePoint(o.get(channel), i));
      selected = -1;
      sync();
      return;
    }
    if (i < 0) {
      const next = addCurvePoint(o.get(channel), p);
      o.set(channel, next);
      i = next.findIndex((q) => Math.abs(q.x - p.x) < 1e-6);
    }
    selected = i;
    dragX = o.get(channel)[i]?.x ?? p.x;
    begin();
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    paint();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toCurve(e);
    cursor = p;
    if (dragRail) {
      const l = o.levels.get();
      const b = plotBox();
      const lp = local(e);
      const tx = clamp01((lp.x - b.x) / b.w);
      const ty = clamp01(1 - lp.y / b.h);
      if (dragRail === 'black') o.levels.set({ inBlack: Math.min(tx, l.inWhite - 0.01) });
      else if (dragRail === 'white') o.levels.set({ inWhite: Math.max(tx, l.inBlack + 0.01) });
      else if (dragRail === 'gamma') {
        const span = Math.max(1e-4, l.inWhite - l.inBlack);
        o.levels.set({ gamma: positionToGamma(Math.min(0.98, Math.max(0.02, (tx - l.inBlack) / span))) });
      }
      // The output ends may cross: an inverted output range is a legitimate
      // negative, the way the classic dialog allows it.
      else if (dragRail === 'outBlack') o.levels.set({ outBlack: ty });
      else o.levels.set({ outWhite: ty });
      paint();
      return;
    }
    if (Number.isNaN(dragX)) {
      const next = hitPoint(p);
      if (next !== hovered) { hovered = next; paint(); } else paintReadout();
      canvas.style.cursor = railHit(e) ? 'ew-resize' : next >= 0 ? 'grab' : 'crosshair';
      return;
    }
    const pts = o.get(channel);
    const index = nearestByX(pts, dragX);
    const moved = moveCurvePoint(pts, index, p);
    o.set(channel, moved);
    dragX = moved[index]?.x ?? dragX;
    selected = index;
    paint();
  });

  const release = (): void => { dragX = NaN; dragRail = null; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { cursor = null; hovered = -1; paint(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('keydown', (e) => {
    const pts = o.get(channel);
    if (selected < 0 || selected >= pts.length) return;
    const step = (e.shiftKey ? 10 : 1) / 255;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = step;
    else if (e.key === 'ArrowDown') dy = -step;
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      o.set(channel, removeCurvePoint(pts, selected));
      selected = -1;
      paint();
      return;
    } else if (e.key === 'Tab' && !e.altKey) {
      // Tab walks the handles while one is selected, the way a curves dialog does.
      if (pts.length < 2) return;
      e.preventDefault();
      selected = (selected + (e.shiftKey ? pts.length - 1 : 1)) % pts.length;
      paint();
      return;
    } else return;
    e.preventDefault();
    const cur = pts[selected];
    o.set(channel, moveCurvePoint(pts, selected, { x: cur.x + dx, y: cur.y + dy }));
    paint();
  });

  function paintReadout(): void {
    const pts = o.get(channel);
    const parts: string[] = [];
    if (selected >= 0 && selected < pts.length) {
      const p = pts[selected];
      parts.push(`point ${selected + 1}/${pts.length}: ${b255(p.x)} → ${b255(p.y)}`);
    } else {
      parts.push(`${pts.length} points`);
    }
    if (cursor) {
      const f = monotoneSpline(pts);
      const lv = channel === 'tone' ? levelsFn(o.levels.get()) : (v: number) => v;
      parts.push(`at ${b255(cursor.x)} → ${b255(f(lv(cursor.x)))}`);
    }
    if (channel === 'tone') {
      const l = o.levels.get();
      parts.push(`levels ${b255(l.inBlack)}–${b255(l.inWhite)} γ${l.gamma.toFixed(2)} → ${b255(l.outBlack)}–${b255(l.outWhite)}`);
    }
    readout.textContent = parts.join('  ·  ');
  }

  function paint(): void {
    // A panel that has been thrown away still hears its ResizeObserver once, as
    // it leaves the page — by which time its layer may be gone too.
    if (!canvas.isConnected) return;
    const r = dpr();
    const cssW = canvas.clientWidth || 240;
    const W = Math.round(cssW * r);
    // Square in CSS (aspect-ratio), so the plot inside the two rails is square too.
    const H = Math.round((canvas.clientHeight || cssW) * r);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const g = canvas.getContext('2d');
    if (!g) return;
    const c = palette();
    const rail = RAIL * r;
    const px = rail;
    const pw = W - rail;
    const ph = H - rail;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = c.field;
    g.fillRect(px, 0, pw, ph);

    const tones = o.tones();
    const chans = channel === 'tone' ? null : o.channels();
    const inHist = channel === 'tone' ? tones?.in : chans?.[CHANNELS.indexOf(channel) - 1];

    // The tones going in, on a square-root scale: a linear one is all spike and
    // no shoulder on any real photograph, and the shoulder is what you aim at.
    if (inHist) {
      const peak = Math.sqrt(Math.max(1, ...inHist));
      const bw = pw / inHist.length;
      g.fillStyle = channel === 'tone' ? 'rgba(17,17,17,0.22)' : `${CHANNEL_INK[channel]}40`;
      for (let i = 0; i < inHist.length; i++) {
        const v = (Math.sqrt(inHist[i]) / peak) * ph;
        g.fillRect(px + i * bw, ph - v, Math.ceil(bw), v);
      }
    }
    // The tones coming out, along the output axis. They are what the tone
    // windows below are cut from, so this is the histogram those controls show.
    if (channel === 'tone' && tones) {
      const peak = Math.sqrt(Math.max(1, ...tones.out));
      const bh = ph / tones.out.length;
      const reach = pw * 0.22;
      g.fillStyle = 'rgba(255,155,33,0.38)';
      for (let i = 0; i < tones.out.length; i++) {
        const v = (Math.sqrt(tones.out[i]) / peak) * reach;
        g.fillRect(px, ph - (i + 1) * bh, v, Math.ceil(bh));
      }
    }

    // Quarter grid and the identity diagonal.
    g.strokeStyle = 'rgba(17,17,17,0.12)';
    g.lineWidth = r;
    g.beginPath();
    for (let i = 1; i < 4; i++) {
      g.moveTo(px + (i / 4) * pw, 0); g.lineTo(px + (i / 4) * pw, ph);
      g.moveTo(px, (i / 4) * ph); g.lineTo(W, (i / 4) * ph);
    }
    g.stroke();
    g.strokeStyle = 'rgba(17,17,17,0.25)';
    g.beginPath(); g.moveTo(px, ph); g.lineTo(W, 0); g.stroke();

    const pts = o.get(channel);
    const f = monotoneSpline(pts);
    const plotLine = (fn: (x: number) => number): void => {
      g.beginPath();
      for (let i = 0; i <= 192; i++) {
        const x = i / 192;
        const X = px + x * pw;
        const Y = (1 - clamp01(fn(x))) * ph;
        if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y);
      }
      g.stroke();
    };

    // What the tone actually gets: levels, then this curve. Dashed and behind,
    // because it is a readout rather than something to grab — but without it a
    // gentle curve can be sitting on a levels clip that has thrown half the range away.
    if (channel === 'tone') {
      const lv = levelsFn(o.levels.get());
      g.strokeStyle = 'rgba(17,17,17,0.55)';
      g.lineWidth = 1.2 * r;
      g.setLineDash([4 * r, 3 * r]);
      plotLine((x) => f(lv(x)));
      g.setLineDash([]);
    }
    g.strokeStyle = CHANNEL_INK[channel];
    g.lineWidth = 1.8 * r;
    plotLine(f);

    pts.forEach((p, i) => {
      const on = i === selected;
      g.beginPath();
      g.arc(px + p.x * pw, (1 - p.y) * ph, (on ? 5.5 : i === hovered ? 5 : 4) * r, 0, Math.PI * 2);
      g.fillStyle = on ? c.accent : '#f2f2f2';
      g.fill();
      g.strokeStyle = CHANNEL_INK[channel];
      g.lineWidth = 1.4 * r;
      g.stroke();
    });

    g.strokeStyle = c.line;
    g.lineWidth = r;
    g.strokeRect(px + r / 2, r / 2, pw - r, ph - r);
    paintRails(g, c, r, px, pw, ph, W, H);
    paintReadout();
  }

  function paintRails(
    g: CanvasRenderingContext2D, c: ReturnType<typeof palette>, r: number,
    px: number, pw: number, ph: number, W: number, H: number,
  ): void {
    const on = channel === 'tone';
    const l = on ? o.levels.get() : NEUTRAL_LEVELS;
    const pad = 3 * r;
    g.globalAlpha = on ? 1 : 0.35;
    // Input: black to white, lit only across the range being kept.
    const top = ph + pad;
    const bh = H - top - pad;
    g.fillStyle = 'rgba(17,17,17,0.08)';
    g.fillRect(px, top, pw, bh);
    const gin = g.createLinearGradient(px, 0, W, 0);
    gin.addColorStop(0, '#000'); gin.addColorStop(1, '#fff');
    g.fillStyle = gin;
    g.fillRect(px + l.inBlack * pw, top, Math.max(r, (l.inWhite - l.inBlack) * pw), bh);
    // Output: the same, upright, between where black and white now land.
    const left = pad;
    const lw = px - 2 * pad;
    g.fillStyle = 'rgba(17,17,17,0.08)';
    g.fillRect(left, 0, lw, ph);
    const gout = g.createLinearGradient(0, (1 - l.outBlack) * ph, 0, (1 - l.outWhite) * ph);
    gout.addColorStop(0, '#000'); gout.addColorStop(1, '#fff');
    g.fillStyle = gout;
    const y0 = (1 - Math.max(l.outBlack, l.outWhite)) * ph;
    g.fillRect(left, y0, lw, Math.max(r, Math.abs(l.outWhite - l.outBlack) * ph));
    g.globalAlpha = 1;
    if (!on) return;

    const tri = (x: number, y: number, dir: 'up' | 'right', fill: string): void => {
      const s = 5 * r;
      g.beginPath();
      if (dir === 'up') { g.moveTo(x, y - s); g.lineTo(x + s, y + s); g.lineTo(x - s, y + s); }
      else { g.moveTo(x + s, y); g.lineTo(x - s, y + s); g.lineTo(x - s, y - s); }
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = c.text;
      g.lineWidth = r;
      g.stroke();
    };
    const mid = l.inBlack + (l.inWhite - l.inBlack) * gammaToPosition(l.gamma);
    const cy = top + bh / 2;
    tri(px + l.inBlack * pw, cy, 'up', '#111');
    tri(px + mid * pw, cy, 'up', '#8a8a8a');
    tri(px + l.inWhite * pw, cy, 'up', '#fff');
    const cx = left + lw / 2;
    tri(cx, (1 - l.outBlack) * ph, 'right', '#111');
    tri(cx, (1 - l.outWhite) * ph, 'right', '#fff');
  }

  function sync(): void {
    tabs.forEach((b, i) => b.classList.toggle('on', CHANNELS[i] === channel));
    paint();
  }

  requestAnimationFrame(paint);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => paint()).observe(canvas);
  return { el, sync };
}

function nearestOf<T>(cands: [T, number][], at: number, reach: number): T | null {
  let best: T | null = null;
  let bestD = reach;
  for (const [name, v] of cands) {
    const d = Math.abs(v - at);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

/** The point whose x is closest to `x`, for re-finding a dragged handle after a re-sort. */
function nearestByX(points: readonly CurvePoint[], x: number): number {
  let best = 0;
  let bestD = Infinity;
  points.forEach((p, i) => {
    const d = Math.abs(p.x - x);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// -- histogram window --------------------------------------------------------

export type HistoRangeOptions = {
  label: string;
  title?: string;
  get(): [number, number];
  set(v: [number, number]): void;
  histogram(): Uint32Array | null;
  /** Soft edges inside the window, drawn as ramps — the tone mask's feather. */
  feather?(): number;
  /** The window is what is left out rather than what is kept. */
  inverted?(): boolean;
  interaction?: Interaction;
};

const HISTO_H = 52;

/**
 * Two handles over the layer's own histogram.
 *
 * The plain two-thumb slider this replaces said where the window was, but not
 * what was in it: a range of 0.3–0.7 is everything on one picture and nothing
 * on another. Drawn over the tones the layer actually measures, the handles
 * show which part of the picture they keep. Grab a handle to move one end,
 * the middle to slide the whole window, double-click to open it fully.
 */
export function histoRange(o: HistoRangeOptions): Control {
  const canvas = h('canvas', { class: 'histo-range', tabindex: '0' }) as HTMLCanvasElement;
  const value = h('span', { class: 'readout' });
  const head = h('div', { class: 'histo-range-head' },
    h('span', { class: 'ctl-label', title: o.title ?? o.label }, o.label), value);
  const el = h('div', { class: 'ctl-histo' }, head, canvas);
  if (o.title) canvas.title = `${o.title}\nDrag a handle or the window; double-click to open it fully`;

  let drag: 'lo' | 'hi' | 'both' | null = null;
  let focus: 'lo' | 'hi' = 'lo';
  let grabAt = 0;
  let grabRange: [number, number] = [0, 1];
  const begin = holdWhileDragging(canvas, o.interaction);

  const at = (e: PointerEvent): number => {
    const r = canvas.getBoundingClientRect();
    return clamp01((e.clientX - r.left) / Math.max(1, r.width));
  };
  const put = (a: number, b: number): void => {
    o.set([Math.round(clamp01(a) * 1000) / 1000, Math.round(clamp01(b) * 1000) / 1000]);
    paint();
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    const x = at(e);
    const [lo, hi] = o.get();
    const w = Math.max(1, canvas.getBoundingClientRect().width);
    const dLo = Math.abs(x - lo) * w;
    const dHi = Math.abs(x - hi) * w;
    if (Math.min(dLo, dHi) < 10) {
      // Two handles on top of each other: the direction of the drag decides,
      // so a closed window can always be opened again.
      drag = dLo < dHi || (dLo === dHi && x < lo) ? 'lo' : 'hi';
    } else if (x > lo && x < hi) {
      drag = 'both';
      grabAt = x;
      grabRange = [lo, hi];
    } else {
      // Outside the window: bring the nearer end here.
      drag = x < lo ? 'lo' : 'hi';
      if (drag === 'lo') put(x, hi); else put(lo, x);
    }
    if (drag !== 'both') focus = drag;
    begin();
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const x = at(e);
    if (!drag) {
      const [lo, hi] = o.get();
      const w = Math.max(1, canvas.getBoundingClientRect().width);
      const near = Math.min(Math.abs(x - lo), Math.abs(x - hi)) * w < 10;
      canvas.style.cursor = near ? 'ew-resize' : x > lo && x < hi ? 'grab' : 'pointer';
      return;
    }
    const [lo, hi] = o.get();
    if (drag === 'lo') put(Math.min(x, hi), hi);
    else if (drag === 'hi') put(lo, Math.max(x, lo));
    else {
      const span = grabRange[1] - grabRange[0];
      const a = Math.min(1 - span, Math.max(0, grabRange[0] + x - grabAt));
      put(a, a + span);
    }
  });
  const release = (): void => { drag = null; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('dblclick', () => put(0, 1));
  canvas.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0;
    if (e.key === 'Tab' && !e.altKey && !e.shiftKey && focus === 'lo') { e.preventDefault(); focus = 'hi'; paint(); return; }
    if (!d) return;
    e.preventDefault();
    const [lo, hi] = o.get();
    if (focus === 'lo') put(Math.min(hi, lo + d), hi); else put(lo, Math.max(lo, hi + d));
  });
  canvas.addEventListener('focus', paint);
  canvas.addEventListener('blur', paint);

  function paint(): void {
    if (!canvas.isConnected) return;
    const r = dpr();
    const W = Math.max(1, Math.round((canvas.clientWidth || 240) * r));
    const H = Math.round(HISTO_H * r);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const g = canvas.getContext('2d');
    if (!g) return;
    const c = palette();
    const [lo, hi] = o.get();
    const inv = o.inverted?.() ?? false;
    const feather = Math.max(0, o.feather?.() ?? 0);
    value.textContent = `${b255(lo)} – ${b255(hi)}${inv ? ' (left out)' : ''}`;
    g.clearRect(0, 0, W, H);
    g.fillStyle = c.field;
    g.fillRect(0, 0, W, H);

    const strip = 6 * r;
    const plot = H - strip;
    /** How much of a tone is kept, as the mask works it out. */
    const kept = (t: number): number => {
      let m = feather > 0
        ? Math.min(clamp01((t - lo) / feather), clamp01((hi - t) / feather))
        : t >= lo && t <= hi ? 1 : 0;
      if (inv) m = 1 - m;
      return m;
    };

    const raw = o.histogram();
    // 256 bins in a strip a couple of hundred pixels wide alias into a comb;
    // a bin every few pixels reads as the shape it is.
    const hist = raw ? rebin(raw, Math.max(16, Math.min(raw.length, Math.round(W / (3 * r))))) : null;
    if (hist) {
      const peak = Math.sqrt(Math.max(1, ...hist));
      const bw = W / hist.length;
      for (let i = 0; i < hist.length; i++) {
        const v = (Math.sqrt(hist[i]) / peak) * (plot - 2 * r);
        const k = kept((i + 0.5) / hist.length);
        g.fillStyle = `rgba(17,17,17,${0.16 + 0.64 * k})`;
        g.fillRect(i * bw, plot - v, Math.ceil(bw), v);
      }
    } else {
      g.fillStyle = c.faint;
      g.font = `${10 * r}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText('No picture yet', W / 2, plot / 2 + 4 * r);
    }

    // What is kept, as a strip along the foot, ramps and all.
    const steps = Math.min(W, 256);
    for (let i = 0; i < steps; i++) {
      const k = kept((i + 0.5) / steps);
      if (k <= 0) continue;
      g.fillStyle = c.accent;
      g.globalAlpha = k;
      g.fillRect((i / steps) * W, plot, Math.ceil(W / steps), strip);
    }
    g.globalAlpha = 1;

    const active = document.activeElement === canvas;
    for (const [t, which] of [[lo, 'lo'], [hi, 'hi']] as const) {
      // Kept inside the box at the ends, so a fully open window still shows its handles.
      const x = Math.min(W - 5 * r, Math.max(5 * r, Math.round(t * W)));
      g.fillStyle = c.text;
      g.fillRect(x - r, 0, 2 * r, H);
      g.fillStyle = active && focus === which ? c.accent : '#f2f2f2';
      g.fillRect(x - 4 * r, 0, 8 * r, 9 * r);
      g.strokeStyle = c.text;
      g.lineWidth = r;
      g.strokeRect(x - 4 * r + r / 2, r / 2, 8 * r - r, 9 * r - r);
    }
    g.strokeStyle = c.line;
    g.strokeRect(r / 2, r / 2, W - r, H - r);
  }

  requestAnimationFrame(paint);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => paint()).observe(canvas);
  return { el, sync: paint };
}

/** Sum a histogram into `n` coarser bins. */
function rebin(hist: Uint32Array, n: number): Uint32Array {
  if (n >= hist.length) return hist;
  const out = new Uint32Array(n);
  for (let i = 0; i < hist.length; i++) out[Math.min(n - 1, Math.floor((i * n) / hist.length))] += hist[i];
  return out;
}

const rgbHistograms = new WeakMap<object, [Uint32Array, Uint32Array, Uint32Array]>();

/** The picture's red, green and blue in 256 bins each, sampled and cached per picture. */
export function rgbHistogram(pic: { width: number; height: number; rgba: Uint8ClampedArray } | null)
  : [Uint32Array, Uint32Array, Uint32Array] | null {
  if (!pic) return null;
  const hit = rgbHistograms.get(pic.rgba);
  if (hit) return hit;
  const out: [Uint32Array, Uint32Array, Uint32Array] = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const n = pic.width * pic.height;
  const stride = Math.max(1, Math.floor(n / 250_000));
  for (let i = 0; i < n; i += stride) {
    const o = i * 4;
    if (pic.rgba[o + 3] < 8) continue;
    out[0][pic.rgba[o]]++;
    out[1][pic.rgba[o + 1]]++;
    out[2][pic.rgba[o + 2]]++;
  }
  rgbHistograms.set(pic.rgba, out);
  return out;
}
