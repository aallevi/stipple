import { buildInkSet, extractPalette, inkShares, oklab, toneRamp } from '../core/color';
import { defaultLayer, uid } from '../core/defaults';
import { groupMembers, groupSpan } from '../core/groups';
import type { Store } from '../core/store';
import type { Layer, LayerGroup, RGBA } from '../core/types';
import { inkName } from '../export/plates';
import type { ImageSource } from '../image/density';
import {
  button, group, h, hint, paletteControl, raw, readout, section, select, slider, toggle,
  type Control, type Interaction,
} from './controls';
import { ANGLES, buildColourLayers, buildSeparation, INK_SETS, isNeutral, SEPARATIONS, undercolorFor } from './separations';

/** How a print group's layers share the picture. */
export type PrintKind = 'spot' | 'plates';

/**
 * Inks & plates: the print, as one panel.
 *
 * A screenprint is a set of inks, and in this app a set of inks is a group of
 * layers, one per ink. This panel is where that set is made and edited — which
 * inks, how many, how they share the picture — so that the Layers panel is
 * only about structure and each layer's Colour section only about its own ink.
 *
 * It works on the *print group* in hand: the selected group, or the group of
 * the selected layer, when its layers are inks. There are two kinds, and a
 * group can be switched between them without losing its inks:
 *
 *   - spot colours: each layer owns the part of the picture closest to its ink
 *     (`nearest`), so the screens sit side by side and never overprint;
 *   - overprinting plates: each layer measures how much of its ink the picture
 *     needs (`ink`), so the inks print over each other and mix, as process
 *     printing does.
 *
 * Making a group from a layer that is not in one turns that layer into the
 * group, in place. Making one while a print group is in hand adds a second
 * group beside it — spot colours *and* a set of plates, for instance — rather
 * than replacing anything.
 */
export class InksPanel {
  readonly el = h('div', { class: 'inks-panel' });
  private controls: Control[] = [];
  private builtFor = '';
  private collapsed = false;

  constructor(
    private store: Store,
    private interaction: Interaction,
    private opts: {
      getSource(): ImageSource | null;
      pickColour(done: (c: RGBA) => void): void;
      /** What the layer panel has selected. */
      selection(): { layer: string | null; group: string | null };
      selectGroup(id: string): void;
      exportPlates(): void;
      expectHeavy(): void;
      notify(message: string, isError?: boolean): void;
    },
  ) {}

  /** The print group in hand, if any, and its kind. */
  active(): { id: string; kind: PrintKind } | null {
    const sel = this.opts.selection();
    const gid = sel.group ?? (sel.layer ? this.store.layer(sel.layer)?.groupId : undefined);
    if (!gid) return null;
    const inks = this.inks(gid);
    if (!inks.length) return null;
    return { id: gid, kind: inks.some((l) => l.prefilter.channel === 'nearest') ? 'spot' : 'plates' };
  }

  /** A group's ink layers, top of the stack first — the order the layer list shows. */
  inks(gid: string): Layer[] {
    return groupMembers(this.store.get(), gid)
      .filter((l) => l.prefilter.channel === 'nearest' || l.prefilter.channel === 'ink')
      .reverse();
  }

  update(): void {
    const a = this.active();
    const g = a ? this.store.group(a.id) : undefined;
    const ranges = a ? !!this.inks(a.id)[0]?.prefilter.nearestRanges : false;
    const key = a ? `${a.id}:${a.kind}:${ranges ? 'ranges' : ''}` : 'none';
    if (key !== this.builtFor) {
      this.collapsed = (this.el.firstElementChild as HTMLElement | null)?.classList.contains('collapsed') ?? false;
      this.build(a, g);
      this.builtFor = key;
    }
    for (const c of this.controls) c.sync();
  }

  private build(a: { id: string; kind: PrintKind } | null, g: LayerGroup | undefined): void {
    // Making a print is always the first thing here and always the same menu,
    // whatever is selected; the line under it says what it will do this time.
    const body: Control[] = [this.makeMenu(), readout(() => this.makeWillDo())];
    if (a) body.push(group('The print in hand'), ...this.groupControls(a.id, a.kind, g));
    else body.push(hint('No print selected. Spot colours sit side by side, each ink owning part of the '
      + 'picture; overprinting plates print over each other and mix.'));
    body.push(raw(button('Export plates…', () => this.opts.exportPlates(), 'sm wide',
      'One black-on-white film per ink, plus a colour proof, with registration marks')));

    const sec = section('Inks & plates', body, this.collapsed, [],
      'The inks of your print and the screens they become. Each ink is a layer of a group, so '
      + 'you can select the group to change every ink at once or one layer to change one ink. '
      + 'Spot colours give each ink the part of the picture closest to it, so screens sit side '
      + 'by side; overprinting plates let the inks print over each other and mix. Export plates '
      + 'writes one film per ink.');
    this.controls = [sec];
    this.el.replaceChildren(sec.el);
  }

  // -- making a print ------------------------------------------------------

  /** What "New print" will do with the current selection, in words. */
  private makeWillDo(): string {
    const sel = this.opts.selection();
    const l = sel.layer ? this.store.layer(sel.layer) : undefined;
    if (!l) return 'Adds a print group at the top of the stack.';
    if (!l.groupId) return `Turns “${l.name}” into the print, every ink a copy of it.`;
    const g = this.store.group(l.groupId);
    return `Adds a new print group above “${g?.name ?? 'this group'}” — nothing is replaced.`;
  }

  private makeMenu(): Control {
    const sel = h('select', { class: 'make-print-select' }) as HTMLSelectElement;
    sel.append(h('option', { value: '' }, 'New print…'));
    const spot = h('optgroup', { label: 'Spot colours, side by side — from the picture' });
    for (let n = 2; n <= 8; n++) spot.append(h('option', { value: `spot:${n}` }, `${n} colours`));
    const plates = h('optgroup', { label: 'Overprinting plates, inks that mix' });
    for (const [key, kind] of Object.entries(SEPARATIONS)) plates.append(h('option', { value: `plates:${key}` }, kind.label));
    sel.append(spot, plates);
    sel.addEventListener('change', () => {
      const v = sel.value;
      sel.value = '';
      if (v.startsWith('spot:')) this.make('spot', Number(v.slice(5)));
      else if (v.startsWith('plates:')) this.make('plates', v.slice(7));
    });
    return raw(h('div', { class: 'ink-set-row' }, sel));
  }

  /**
   * Make a print group from the selected layer. A layer not in a group
   * becomes the group, in place, every ink a copy of it; otherwise the new
   * group goes above the group in hand and nothing is replaced.
   */
  make(kind: PrintKind, spec: number | string, fromLayer?: string): void {
    const s = this.store;
    const project = s.get();
    const sel = this.opts.selection();
    const srcId = fromLayer ?? sel.layer;
    const src = srcId ? s.layer(srcId) : undefined;
    const group: LayerGroup = { id: uid('group'), name: '', collapsed: false };

    let layers: Layer[];
    if (kind === 'spot') {
      const pic = this.opts.getSource();
      const paper = project.canvas.background;
      let colours: RGBA[] = src?.color.mode === 'spot' && src.color.palette.length ? src.color.palette : [];
      if (!colours.length && pic) colours = extractPalette(pic, Number(spec), paper);
      if (!colours.length) colours = INK_SETS.earth.inks.slice(0, Number(spec));
      const template: Layer | undefined = src ? JSON.parse(JSON.stringify(src)) : undefined;
      if (template) {
        template.color = { ...template.color, mode: 'solid' };
        if (src!.color.mode === 'spot') {
          template.prefilter = {
            ...template.prefilter,
            nearestPaper: src!.color.paper != null,
            nearestMix: Math.min(1, 0.15 * (1 + src!.color.mixing)),
            nearestByTone: src!.color.matchBy === 'tone',
          };
        }
      }
      const pinned = src?.color.pinned ?? [];
      group.name = 'Spot colours';
      layers = buildColourLayers(colours, group.id, template, colours.map((c) => pinned.some((p) => same(p, c))));
    } else {
      const set = SEPARATIONS[String(spec)];
      if (!set) return;
      group.name = set.label.replace(/\s*\(.*\)$/, '');
      layers = buildSeparation(set, project.canvas).map((l) => ({ ...l, groupId: group.id }));
    }

    this.opts.expectHeavy();
    if (src && !src.groupId) {
      s.replaceLayerWithGroup(src.id, layers, group);
    } else {
      // Beside what is there, never in place of it: above the group in hand,
      // or at the top of the stack.
      const span = src?.groupId ? groupSpan(project, src.groupId) : null;
      s.insertGroup(layers, group, span ? span[1] + 1 : project.layers.length);
    }
    this.opts.selectGroup(group.id);
  }

  // -- editing the print in hand ---------------------------------------------

  private groupControls(gid: string, kind: PrintKind, g: LayerGroup | undefined): Control[] {
    const s = this.store;
    const ia = this.interaction;
    const inks = (): Layer[] => this.inks(gid);
    const first = (): Layer | undefined => inks()[0];
    const paper = (): RGBA => s.get().canvas.background;

    const setAll = (patch: Partial<Layer['prefilter']>, key: string): void =>
      s.batch(key, () => { for (const l of inks()) s.updateLayerField(l.id, 'prefilter', patch); });

    const recolour = (l: Layer, c: RGBA): void => {
      s.updateLayerField(l.id, 'prefilter', { ink: c });
      s.updateLayerField(l.id, 'color', { mode: 'solid', color: c });
      s.updateLayer(l.id, { name: inkName(c) });
    };

    /** Give the group these inks, in list order, growing or shrinking it to fit. */
    const setColours = (colours: RGBA[], key: string, extra: Partial<Layer['prefilter']> = {}): void => {
      if (!colours.length) return;
      s.batch(key, () => {
        let list = inks();
        // Fewer inks: drop from the top, keeping the colours picked by hand longest.
        while (list.length > colours.length) {
          const drop = [...list].reverse().find((l) => !l.prefilter.nearestPicked) ?? list[list.length - 1];
          s.removeLayer(drop.id);
          list = inks();
        }
        list.forEach((l, i) => recolour(l, colours[i]));
        for (let i = list.length; i < colours.length; i++) this.addInk(gid, colours[i], false);
        // New inks, new answer to who carries the greys (see `undercolorFor`).
        if (first()?.prefilter.channel === 'ink') {
          for (const l of inks()) s.updateLayerField(l.id, 'prefilter', { undercolor: undercolorFor(inkOf(l), colours) });
        }
        if (Object.keys(extra).length) for (const l of inks()) s.updateLayerField(l.id, 'prefilter', extra);
        if (first()?.prefilter.nearestRanges) this.resetBands(gid);
      });
    };

    /** Re-sample, keeping hand-picked inks and filling the rest from the picture. */
    const resample = (n: number, byTone: boolean, key: string, detail = false): void => {
      const pic = this.opts.getSource();
      if (!pic) return this.opts.notify('Open a picture first', true);
      const list = inks();
      const picked = list.filter((l) => l.prefilter.nearestPicked).map((l) => l.prefilter.ink!);
      const auto = Math.max(0, n - picked.length);
      const sampled = auto ? (byTone ? toneRamp(pic, auto + picked.length, paper()) : extractPalette(pic, auto + picked.length, paper(), 20000, detail)) : [];
      const found = sampled.filter((c) => !picked.some((q) => near(q, c))).slice(0, auto);
      const colours: RGBA[] = [];
      let f = 0;
      for (const l of list.slice(0, n)) colours.push(l.prefilter.nearestPicked ? l.prefilter.ink! : (found[f++] ?? l.prefilter.ink!));
      while (colours.length < n && f < found.length) colours.push(found[f++]);
      setColours(colours, key, kind === 'spot' ? (byTone ? { nearestByTone: true, nearestMix: 0 } : { nearestByTone: false }) : {});
    };

    let sharesKey = '';
    let sharesText = '';
    const shares = (): string => {
      const pic = this.opts.getSource();
      if (!pic) return 'Open a picture to see how the inks divide it.';
      const list = inks().map((l) => l.prefilter.ink ?? l.color.color);
      const f = first();
      const leave = !!f?.prefilter.nearestPaper;
      const byTone = !!f?.prefilter.nearestByTone;
      const ranges = !!f?.prefilter.nearestRanges;
      const bands = inks().map((l) => l.prefilter.nearestBand ?? [0, 0]);
      const key = `${JSON.stringify(list)}|${leave}|${byTone}|${ranges}|${JSON.stringify(bands)}|${JSON.stringify(paper())}`;
      if (key === sharesKey) return sharesText;
      if (ranges) {
        const hist = lightnessHistogram(pic);
        const total = hist.reduce((a, b) => a + b, 0) || 1;
        const share = (lo: number, hi: number): number => {
          let n = 0;
          hist.forEach((c, i) => { const L = (i + 0.5) / hist.length; if (L >= lo && L < hi) n += c; });
          return n / total;
        };
        const parts = inks().map((l) => `${inkName(l.prefilter.ink ?? l.color.color)} ${Math.round(share(...(l.prefilter.nearestBand ?? [0, 0])) * 100)}%`);
        const top = Math.max(0, ...bands.map((b) => b[1]));
        if (top < 1) parts.push(`paper ${Math.round(share(top, 1.01) * 100)}%`);
        sharesKey = key;
        sharesText = parts.join(' \u00b7 ');
        return sharesText;
      }
      const split = inkShares(pic, buildInkSet(list, leave ? paper() : null), 0, byTone);
      sharesKey = key;
      sharesText = split.map((v, i) => `${i < list.length ? inkName(list[i]) : 'paper'} ${Math.round(v * 100)}%`).join(' · ');
      return sharesText;
    };

    const setSelect = h('select', { class: 'ink-set-select' }) as HTMLSelectElement;
    setSelect.append(h('option', { value: '' }, 'Load an ink set…'));
    for (const [key, set] of Object.entries(INK_SETS)) setSelect.append(h('option', { value: key }, set.label));
    setSelect.addEventListener('change', () => {
      const set = INK_SETS[setSelect.value];
      setSelect.value = '';
      if (set) setColours(set.inks.map((c) => [...c] as RGBA), 'ink-set', kind === 'spot' ? { nearestPaper: set.paper != null } : {});
    });

    const controls: Control[] = [
      readout(() => `${g?.name ?? 'Print'} · ${inks().length} ink${inks().length === 1 ? '' : 's'}`),
      select<PrintKind>({
        label: 'Inks print',
        title: 'Side by side, each ink owning part of the picture; or over each other, mixing on the paper',
        options: [
          { value: 'spot', label: 'Side by side (spot colours)' },
          { value: 'plates', label: 'Over each other (overprinting plates)' },
        ],
        get: () => kind,
        set: (v) => { if (v !== kind) this.convert(gid, v); },
      }),
      slider({
        label: 'Inks', min: 1, max: 8, step: 1, interaction: ia,
        title: 'How many screens you are willing to print — one layer each',
        get: () => inks().length,
        set: (v) => {
          const n = Math.round(v);
          const cur = inks();
          if (n === cur.length) return;
          if (n < cur.length) return setColours(cur.slice(0, n).map((l) => l.prefilter.ink!), 'ink-count');
          const pic = this.opts.getSource();
          const next: RGBA[] = cur.map((l) => l.prefilter.ink!);
          const found = pic ? extractPalette(pic, n, paper()) : [];
          for (const c of found) { if (next.length >= n) break; if (!next.some((q) => near(q, c))) next.push(c); }
          for (const c of found) { if (next.length >= n) break; if (!next.some((q) => same(q, c))) next.push(c); }
          while (next.length < n) next.push([0, 0, 0, 1]);
          setColours(next, 'ink-count');
        },
      }),
      paletteControl({
        label: 'Palette', interaction: ia,
        names: () => inks().map((l) => l.name),
        current: () => {
          const sel = this.opts.selection();
          return sel.group ? -1 : inks().findIndex((l) => l.id === sel.layer);
        },
        remove: (i) => {
          const l = inks()[i];
          if (!l || inks().length <= 1) return;
          s.batch(`remove-ink:${l.id}`, () => {
            s.removeLayer(l.id);
            if (first()?.prefilter.nearestRanges) this.resetBands(gid);
          });
        },
        get: () => inks().map((l) => (l.prefilter.ink ?? l.color.color) as [number, number, number, number]),
        set: (v) => {
          const list = inks();
          s.batch('palette', () => v.forEach((c, i) => {
            const l = list[i];
            if (l && !same(c, l.prefilter.ink ?? l.color.color)) recolour(l, c);
          }));
        },
      }),
    ];
    if (kind === 'spot') controls.push(readout(shares));

    controls.push(
      group('Choosing the inks'),
      raw(button('Sample the colours', () => resample(inks().length, false, 'extract'), 'sm',
        'Find the colours the picture is made of, by area. Inks you picked by hand are kept')),
      raw(button('Sample, favouring details', () => resample(inks().length, false, 'extract-detail', true), 'sm',
        'Find the colours, giving rare ones more weight, so a small distinct detail can win an ink of its own')),
    );
    if (kind === 'spot') {
      controls.push(raw(button('Posterise the tones', () => resample(inks().length, true, 'posterise'), 'sm',
        'A dark-to-light ramp from the picture, matched on lightness with hard borders')));
    }
    controls.push(
      raw(button('Pick a colour from the picture', () => this.opts.pickColour((c) => this.addInk(gid, c, true)), 'sm',
        'Tap the picture on a colour the print is missing — a small detail the sampling averaged away. '
        + 'It becomes an ink of its own, and stays when you sample again')),
      raw(h('div', { class: 'ink-set-row' }, setSelect)),
    );

    if (kind === 'spot') {
      controls.push(
        group('How the inks share the picture'),
        select<'colour' | 'tone' | 'ranges'>({
          label: 'Divide by',
          title: 'How the picture is shared out: each pixel to the ink closest in colour, closest in lightness, '
            + 'or by tone ranges you set on the histogram',
          options: [
            { value: 'colour', label: 'Closest colour' },
            { value: 'tone', label: 'Closest lightness' },
            { value: 'ranges', label: 'Tone ranges (histogram)' },
          ],
          get: () => (first()?.prefilter.nearestRanges ? 'ranges' : first()?.prefilter.nearestByTone ? 'tone' : 'colour'),
          set: (v) => s.batch('divide-by', () => {
            for (const l of inks()) s.updateLayerField(l.id, 'prefilter', { nearestRanges: v === 'ranges', nearestByTone: v === 'tone' });
            if (v === 'ranges') this.resetBands(gid);
          }),
        }),
        ...(first()?.prefilter.nearestRanges ? [this.toneRanges(gid)] : []),
        slider({
          label: 'Soft borders', min: 0, max: 1, step: 0.01, interaction: ia, reset: 0.15,
          title: '0 is a hard edge between inks; higher dithers the pixels near a border between their two closest inks',
          get: () => first()?.prefilter.nearestMix ?? 0,
          set: (v) => setAll({ nearestMix: v }, 'soft-borders'),
        }),
        select<'even' | 'tone'>({
          label: 'Inside each ink',
          title: 'Fill each ink’s area evenly, like a flat screenprint, or put more dots where it is darker',
          options: [
            { value: 'even', label: 'Even fill' },
            { value: 'tone', label: 'Follows the darkness' },
          ],
          get: () => (first()?.prefilter.nearestTone ? 'tone' : 'even'),
          set: (v) => setAll({ nearestTone: v === 'tone' }, 'inside'),
        }),
        toggle({
          label: 'Leave paper',
          title: 'The paper competes as an ink, and where it is closest nothing prints — highlights stay bare stock',
          get: () => !!first()?.prefilter.nearestPaper,
          set: (v) => s.batch('leave-paper', () => {
            for (const l of inks()) s.updateLayerField(l.id, 'prefilter', { nearestPaper: v });
            if (first()?.prefilter.nearestRanges) this.resetBands(gid);
          }),
        }),
      );
    } else {
      controls.push(
        group('How the plates overprint'),
        hint('Each plate measures how much of its ink the picture needs, and the inks multiply on '
          + 'the paper. The last near-black plate carries the greys, so total ink stays printable.'),
      );
    }
    return controls;
  }

  /** Add one ink to a print group, as a copy of its top ink in everything but colour. */
  addInk(gid: string, c: RGBA, picked: boolean): void {
    const s = this.store;
    const list = this.inks(gid);
    const template = list[0];
    const project = s.get();
    const copy: Layer = template ? JSON.parse(JSON.stringify(template)) : defaultLayer(inkName(c));
    copy.id = uid('layer');
    copy.name = inkName(c);
    copy.groupId = gid;
    const plates = template?.prefilter.channel === 'ink';
    copy.prefilter = {
      ...copy.prefilter,
      channel: plates ? 'ink' : 'nearest',
      ink: c,
      nearestPicked: picked,
      undercolor: plates ? undercolorFor(c, [...list.map(inkOf), c]) : copy.prefilter.undercolor,
    };
    copy.color = { ...copy.color, mode: 'solid', color: c };
    const d = copy.distribution as Layer['distribution'] & { angle?: number; seed?: number };
    if (plates && d.algo === 'halftone') {
      // A new plate needs a screen angle of its own, or it beats against one already there.
      const used = new Set(list.map((l) => (l.distribution as { angle?: number }).angle));
      d.angle = ANGLES.find((a) => !used.has(a)) ?? (d.angle ?? 0) + 7.5;
    }
    if ('seed' in d) d.seed = Math.floor(Math.random() * 9000) + 1;
    const span = groupSpan(project, gid);
    s.batch(`add-ink:${copy.id}`, () => {
      s.addLayer(copy, span ? span[1] + 1 : project.layers.length);
      // The first key plate in a set: now the colour plates can hand it the greys.
      if (plates && isNeutral(c) && !list.some((l) => isNeutral(inkOf(l)))) {
        for (const l of list) s.updateLayerField(l.id, 'prefilter', { undercolor: undercolorFor(inkOf(l), [c]) });
      }
      if (copy.prefilter.nearestRanges) this.resetBands(gid);
    });
  }

  /**
   * Lay the tone ranges out from the inks themselves: darkest ink at the
   * bottom, each boundary halfway between two inks' lightness — which is
   * exactly what "closest lightness" would do — and, with paper left, a last
   * boundary halfway to the paper. A starting point for dragging, not a rule.
   */
  resetBands(gid: string): void {
    const s = this.store;
    const list = this.inks(gid).map((l) => ({ l, L: oklab(...rgb(l.prefilter.ink ?? l.color.color))[0] }))
      .sort((a, b) => a.L - b.L);
    if (!list.length) return;
    const paperL = oklab(...rgb(s.get().canvas.background))[0];
    const leave = !!list[0].l.prefilter.nearestPaper;
    s.batch(`bands:${gid}`, () => list.forEach((e, i) => {
      const lo = i === 0 ? 0 : (list[i - 1].L + e.L) / 2;
      const hi = i === list.length - 1 ? (leave ? Math.min(0.995, (e.L + paperL) / 2) : 1) : (e.L + list[i + 1].L) / 2;
      s.updateLayerField(e.l.id, 'prefilter', { nearestBand: [lo, hi] });
    }));
  }

  /**
   * The picture's lightness as a histogram, with each ink's range under it in
   * its own colour and a handle on every boundary. Dragging a handle moves
   * where one ink stops and the next begins — the paper too, when it is left.
   */
  private toneRanges(gid: string): Control {
    const s = this.store;
    const canvas = h('canvas', { class: 'histo-canvas', height: '88' }) as HTMLCanvasElement;
    const el = h('div', { class: 'histo' }, canvas);
    const inksByBand = (): Layer[] => this.inks(gid).filter((l) => l.prefilter.nearestBand)
      .sort((a, b) => a.prefilter.nearestBand![0] - b.prefilter.nearestBand![0]);
    /** Boundaries left to right: between each pair of inks, then ink-to-paper if there is paper. */
    const boundaries = (): number[] => {
      const list = inksByBand();
      const out = list.slice(0, -1).map((l) => l.prefilter.nearestBand![1]);
      const top = list[list.length - 1]?.prefilter.nearestBand![1] ?? 1;
      if (top < 1) out.push(top);
      return out;
    };

    const draw = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const H = Math.round(88 * dpr);
      if (canvas.width !== W) canvas.width = W;
      canvas.height = H;
      const g = canvas.getContext('2d')!;
      g.clearRect(0, 0, W, H);
      const strip = 14 * dpr;
      const plot = H - strip - 2 * dpr;
      // Ink ranges, as a strip in each ink's colour; the paper's range left bare.
      g.fillStyle = '#f4f4f0';
      g.fillRect(0, plot + 2 * dpr, W, strip);
      for (const l of inksByBand()) {
        const [lo, hi] = l.prefilter.nearestBand!;
        const c = l.prefilter.ink ?? l.color.color;
        g.fillStyle = `rgb(${c[0] * 255},${c[1] * 255},${c[2] * 255})`;
        g.fillRect(lo * W, plot + 2 * dpr, (hi - lo) * W, strip);
      }
      // The picture's lightness, on a square-root scale so a small detail's
      // tones still show beside the large areas'.
      const pic = this.opts.getSource();
      if (pic) {
        const hist = lightnessHistogram(pic);
        const max = Math.sqrt(Math.max(...hist, 1));
        const bw = W / hist.length;
        g.fillStyle = '#3a3a3a';
        hist.forEach((c, i) => {
          const bh = (Math.sqrt(c) / max) * (plot - 2 * dpr);
          g.fillRect(i * bw, plot - bh, Math.max(1, bw - dpr), bh);
        });
      }
      // Handles.
      for (const b of boundaries()) {
        const x = Math.round(b * W);
        g.fillStyle = '#111';
        g.fillRect(x - dpr, 0, 2 * dpr, H);
        g.fillStyle = '#ff9b21';
        g.fillRect(x - 4 * dpr, plot + 2 * dpr, 8 * dpr, strip);
        g.strokeStyle = '#111';
        g.lineWidth = dpr;
        g.strokeRect(x - 4 * dpr, plot + 2 * dpr, 8 * dpr, strip);
      }
    };

    canvas.addEventListener('pointerdown', (e) => {
      const box = canvas.getBoundingClientRect();
      const at = (ev: PointerEvent): number => Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width));
      const bs = boundaries();
      if (!bs.length) return;
      const v0 = at(e);
      let k = 0;
      bs.forEach((b, i) => { if (Math.abs(b - v0) < Math.abs(bs[k] - v0)) k = i; });
      if (Math.abs(bs[k] - v0) * box.width > 18) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        const list = inksByBand();
        const lower = list[k];
        const upper = list[k + 1]; // undefined: the ink-to-paper boundary
        if (!lower) return;
        const min = lower.prefilter.nearestBand![0] + 0.01;
        const max = upper ? upper.prefilter.nearestBand![1] - 0.01 : 0.995;
        const v = Math.min(max, Math.max(min, at(ev)));
        s.batch(`bands-drag:${gid}`, () => {
          s.updateLayerField(lower.id, 'prefilter', { nearestBand: [lower.prefilter.nearestBand![0], v] });
          if (upper) s.updateLayerField(upper.id, 'prefilter', { nearestBand: [v, upper.prefilter.nearestBand![1]] });
        });
      };
      const up = (): void => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
    });

    return { el, sync: draw };
  }

  /** Switch a print group between spot colours and overprinting plates, keeping its inks. */
  convert(gid: string, to: PrintKind): void {
    const s = this.store;
    const list = this.inks(gid);
    s.batch(`convert:${gid}`, () => {
      list.forEach((l) => {
        const ink = l.prefilter.ink ?? l.color.color;
        s.updateLayerField(l.id, 'prefilter', to === 'spot'
          ? { channel: 'nearest', nearestPaper: l.prefilter.nearestPaper ?? true, nearestMix: l.prefilter.nearestMix ?? 0.15 }
          : { channel: 'ink', undercolor: undercolorFor(ink, list.map(inkOf)) });
        s.updateLayer(l.id, { blend: 'multiply' });
      });
    });
  }
}

function same(a: RGBA, b: RGBA): boolean {
  return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3;
}

/** Two colours close enough to count as the same ink when growing a palette. */
function near(a: RGBA, b: RGBA): boolean {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.12;
}

function rgb(c: RGBA): [number, number, number] {
  return [c[0], c[1], c[2]];
}

const histograms = new WeakMap<object, number[]>();

/** Oklab lightness of the picture in 64 bins, sampled, cached per picture. */
function lightnessHistogram(pic: ImageSource): number[] {
  const hit = histograms.get(pic.rgba);
  if (hit) return hit;
  const bins = new Array<number>(64).fill(0);
  const n = pic.width * pic.height;
  const stride = Math.max(1, Math.floor(n / 40000));
  for (let i = 0; i < n; i += stride) {
    const o = i * 4;
    if (pic.rgba[o + 3] < 8) continue;
    const L = oklab(pic.rgba[o] / 255, pic.rgba[o + 1] / 255, pic.rgba[o + 2] / 255)[0];
    bins[Math.min(63, Math.max(0, Math.floor(L * 64)))] += 1;
  }
  histograms.set(pic.rgba, bins);
  return bins;
}

/** The ink a layer prints with. */
function inkOf(l: Layer): RGBA {
  return l.prefilter.ink ?? l.color.color;
}
