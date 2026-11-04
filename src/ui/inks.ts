import { buildInkSet, extractPalette, inkShares, toneRamp } from '../core/color';
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
import { ANGLES, buildColourLayers, buildSeparation, INK_SETS, isNeutral, SEPARATIONS } from './separations';

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
    const key = a ? `${a.id}:${a.kind}` : 'none';
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
        if (Object.keys(extra).length) for (const l of inks()) s.updateLayerField(l.id, 'prefilter', extra);
      });
    };

    /** Re-sample, keeping hand-picked inks and filling the rest from the picture. */
    const resample = (n: number, byTone: boolean, key: string): void => {
      const pic = this.opts.getSource();
      if (!pic) return this.opts.notify('Open a picture first', true);
      const list = inks();
      const picked = list.filter((l) => l.prefilter.nearestPicked).map((l) => l.prefilter.ink!);
      const auto = Math.max(0, n - picked.length);
      const sampled = auto ? (byTone ? toneRamp(pic, auto + picked.length, paper()) : extractPalette(pic, auto + picked.length, paper())) : [];
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
      const key = `${JSON.stringify(list)}|${leave}|${byTone}|${JSON.stringify(paper())}`;
      if (key === sharesKey) return sharesText;
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
          if (l && inks().length > 1) s.removeLayer(l.id);
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
        'Find the colours the picture is made of. Inks you picked by hand are kept')),
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
        select<'colour' | 'tone'>({
          label: 'Match on',
          title: 'Whether a pixel goes to the ink closest in colour, or closest in lightness alone',
          options: [
            { value: 'colour', label: 'Colour' },
            { value: 'tone', label: 'Lightness only' },
          ],
          get: () => (first()?.prefilter.nearestByTone ? 'tone' : 'colour'),
          set: (v) => setAll({ nearestByTone: v === 'tone' }, 'match-on'),
        }),
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
          set: (v) => setAll({ nearestPaper: v }, 'leave-paper'),
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
      undercolor: plates ? (isNeutral(c) ? 0 : 1) : copy.prefilter.undercolor,
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
    s.addLayer(copy, span ? span[1] + 1 : project.layers.length);
  }

  /** Switch a print group between spot colours and overprinting plates, keeping its inks. */
  convert(gid: string, to: PrintKind): void {
    const s = this.store;
    const list = this.inks(gid);
    s.batch(`convert:${gid}`, () => {
      list.forEach((l, i) => {
        const ink = l.prefilter.ink ?? l.color.color;
        s.updateLayerField(l.id, 'prefilter', to === 'spot'
          ? { channel: 'nearest', nearestPaper: l.prefilter.nearestPaper ?? true, nearestMix: l.prefilter.nearestMix ?? 0.15 }
          : { channel: 'ink', undercolor: i === 0 && isNeutral(ink) ? 0 : 1 });
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
