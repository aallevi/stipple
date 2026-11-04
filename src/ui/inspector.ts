import { buildInkSet, extractPalette, inkShares, toneRamp } from '../core/color';
import { defaultDistribution, defaultRotation, defaultSize, uid } from '../core/defaults';
import { unitPx } from '../core/scale';
import type { Store } from '../core/store';
import {
  BLEND_MODES, type BlendMode, type DistributionAlgo, type HalftoneParams,
  type JitteredParams, type Layer, type RGBA, type VoronoiParams,
} from '../core/types';
import {
  button, colorControl, group, h, hint, paletteControl, raw, rangeControl, readout, section,
  select, slider, toggle, when, type Control, type Interaction,
} from './controls';
import { inkName } from '../export/plates';
import { buildColourLayers, INK_SETS } from './separations';
import { shapeParamControls } from './shapeparams';
import { formatSpan, lengthSlider } from './units';

/**
 * The stochastic screen's range, in dots across the short edge of the picture.
 *
 * The top is where the point budget runs out rather than a taste judgement: a
 * square document at 2,000 across is four million candidate sites, which is the
 * per-layer ceiling in `pipeline/engine.ts`. The bottom is coarse enough to
 * count the marks. Neither end has anything to do with how many pixels the
 * document happens to be, which is the point.
 */
const MIN_DENSITY = 8;
const MAX_DENSITY = 2000;

/**
 * Parameter panel for the selected layer.
 *
 * Rebuilt only when the layer, its algorithm, its colour mode or its shape kind
 * changes; every other update is a `sync()` that pushes current values into
 * existing inputs. That keeps focus and scroll position stable while you drag a
 * slider, and means an undo does not tear down the panel you are working in.
 *
 * Sections run in signal-flow order, top to bottom: what the layer reads, how
 * that is graded and measured, which tones it keeps, where the dots go, what a
 * dot looks like, how big, which way round, what colour, where the layer sits,
 * and finally how it composites onto the layers below. A control only ever
 * affects the sections beneath it. The refinement stages (Image adjust, Tone
 * mask, Transform) start collapsed.
 */
export class Inspector {
  readonly el = h('div', { class: 'inspector' });
  private controls: Control[] = [];
  private builtFor = '';

  constructor(
    private store: Store,
    private interaction: Interaction,
    /** The shape library, hosted inside the Shape section it drives. */
    private shapeLibrary: { el: HTMLElement; importBtn: HTMLElement; duplicateBtn: HTMLElement },
    private voronoiAvailable: boolean,
    /** The photograph, for proposing a palette from what is actually in it. */
    private getSource: () => { width: number; height: number; rgba: Uint8ClampedArray } | null = () => null,
    /**
     * Arm the canvas eyedropper: the next tap on the picture samples the photo
     * there and hands the colour back. For the colours automatic sampling
     * averages away — a small red detail in a mostly brown picture.
     */
    private pickColour: (done: (c: RGBA) => void) => void = () => {},
    /** Select a group in the layer panel, after this panel has made one. */
    private selectGroup: (groupId: string) => void = () => {},
  ) {}

  /** Rebuild if the layer identity or an option that changes the form did. */
  update(layerId: string | null): void {
    const layer = layerId ? this.store.layer(layerId) : undefined;
    if (!layer) {
      this.el.replaceChildren(h('p', { class: 'empty' }, 'Select a layer to edit it.'));
      this.builtFor = '';
      this.controls = [];
      return;
    }
    // The shape's kind decides which geometry sliders exist, and a line's style
    // decides whether they are labelled as arms or as segments — both have to be
    // in the key, but nothing else about the shape, or every drag would tear
    // down the slider under the cursor.
    const shape = this.store.get().shapes.find((s) => s.id === layer.shapeId);
    const shapeForm = shape ? `${shape.kind}/${shape.kind === 'line' ? shape.style : ''}` : 'none';
    // Only things that change which controls *exist* belong here. The ink count
    // and the paper toggle used to be in this key, which meant dragging the Inks
    // slider rebuilt the section on its first step and threw away the slider the
    // pointer was holding — the control could not be moved past one notch.
    // Those now hide and show themselves through `when`.
    // Every length slider is built against one unit, one resolution and one
    // document size — lengths are stored as fractions of the short edge, so the
    // document's dimensions are part of the conversion whatever unit is on
    // display, not only for `%`. All three go in the key.
    const canvas = this.store.get().canvas;
    const key = [layer.id, layer.distribution.algo, layer.color.mode, layer.shapeId,
      shapeForm, layer.prefilter.channel ?? 'luma', canvas.units, canvas.dpi,
      `${canvas.width}x${canvas.height}`].join(':');
    if (key !== this.builtFor) {
      this.build(layer);
      this.builtFor = key;
    }
    for (const c of this.controls) c.sync();
  }

  private build(layer: Layer): void {
    const id = layer.id;
    const s = this.store;
    const ia = this.interaction;
    const L = (): Layer => s.layer(id)!;
    const size = defaultSize();
    const rot = defaultRotation();

    const sections: Control[] = [
      section('Source', [
        select<'source' | 'below'>({
          label: 'Reads from',
          title: 'Sample the photo, or the composite of everything stacked underneath',
          options: [
            { value: 'source', label: 'Source image' },
            { value: 'below', label: 'Layers below' },
          ],
          get: () => L().input,
          set: (v) => s.editLayer(id, { input: v }),
        }),
      ], false, [], 'Where this layer looks to decide where its dots go. Source image is your photo. Layers below is the finished drawing of every layer under this one, so this layer can follow the ink already laid down \u2014 blur it a little in Image adjust and the dots below turn into smooth tone to draw over.'),

      section('Image adjust', [
        slider({
          label: 'Brightness', min: -1, max: 1, step: 0.01, interaction: ia, reset: 0,
          get: () => L().prefilter.brightness,
          set: (v) => s.editLayerField(id, 'prefilter', { brightness: v }),
        }),
        slider({
          label: 'Contrast', min: -1, max: 1, step: 0.01, interaction: ia, reset: 0,
          get: () => L().prefilter.contrast,
          set: (v) => s.editLayerField(id, 'prefilter', { contrast: v }),
        }),
        slider({
          label: 'Gamma', min: 0.1, max: 4, step: 0.01, interaction: ia, reset: 1,
          get: () => L().prefilter.gamma,
          set: (v) => s.editLayerField(id, 'prefilter', { gamma: v }),
        }),
        lengthSlider({
          label: 'Blur', min: 0, max: 0.1, interaction: ia, reset: 0,
          canvas: this.store.get().canvas,
          title: 'Softens what this layer measures, as a fraction of the picture — '
            + 'so a blur that turns the dots below into tone keeps doing that at any size',
          get: () => L().prefilter.blur,
          set: (v) => s.editLayerField(id, 'prefilter', { blur: v }),
        }),
        slider({
          label: 'Sharpen', min: 0, max: 1, step: 0.01, interaction: ia, reset: 0,
          get: () => L().prefilter.sharpen,
          set: (v) => s.editLayerField(id, 'prefilter', { sharpen: v }),
        }),
        toggle({
          label: 'Invert image',
          get: () => L().prefilter.invert,
          set: (v) => s.editLayerField(id, 'prefilter', { invert: v }),
        }),
      ], true),

      section('Measure', [
        select<'luma' | 'ink' | 'flat' | 'nearest'>({
          label: 'Responds to',
          title: 'Overall tone, the coverage of one ink, the closest colour, or nothing at all',
          options: [
            { value: 'luma', label: 'Overall tone' },
            { value: 'ink', label: 'One ink (makes this layer a plate)' },
            { value: 'nearest', label: 'Closest colour (one region of a colour group)' },
            { value: 'flat', label: 'Nothing (even dots)' },
          ],
          get: () => L().prefilter.channel ?? 'luma',
          set: (v) => s.editLayerField(id, 'prefilter', { channel: v }),
        }),
        ...(layer.prefilter.channel === 'ink' ? [
          colorControl({
            label: 'Which ink', interaction: ia,
            get: () => L().prefilter.ink ?? [0, 0, 0, 1],
            set: (v) => s.editLayerField(id, 'prefilter', { ink: v }),
          }),
          slider({
            label: 'Undercolour', min: 0, max: 1, step: 0.01, interaction: ia, reset: 1,
            title: 'How much of the neutral component to leave to a black plate. '
              + '1 keeps total ink coverage printable; 0 is a naive separation',
            get: () => L().prefilter.undercolor ?? 0,
            set: (v) => s.editLayerField(id, 'prefilter', { undercolor: v }),
          }),
          raw(button('Match the dot colour to this ink', () => {
            const c = L().prefilter.ink ?? [0, 0, 0, 1];
            s.editLayerField(id, 'color', { mode: 'solid', color: c });
          }, 'sm wide')),
        ] : layer.prefilter.channel === 'nearest' ? this.nearestControls(id) : layer.prefilter.channel === 'flat' ? [
          hint('Dots land evenly everywhere. Lightness comes from the ink each one takes, '
            + 'which is what a spot-ink layer wants.'),
        ] : [hint('This layer reads overall tone. Switch to an ink to make it one plate of a separation.')]),
      ], layer.prefilter.channel !== 'ink' && layer.prefilter.channel !== 'nearest', [], 'What this layer responds to in what it reads, which decides where its dots go. Overall tone: dots where it is dark. One ink: dots where the picture needs that ink, as one plate of an overprinting separation. Closest colour: dots only where the picture is closer to this layer\u2019s colour than to any other colour in its group, so the colours of a group fit together like a puzzle and never print on top of each other. Nothing: dots evenly everywhere.'),

      section('Tone mask', [
        rangeControl({
          label: 'Keep tones', interaction: ia,
          title: 'Dots are placed only where the source tone falls inside this window',
          get: () => L().mask.toneRange,
          set: (v) => s.editLayerField(id, 'mask', { toneRange: v }),
        }),
        slider({
          label: 'Feather', min: 0, max: 0.5, step: 0.01, interaction: ia, reset: 0,
          title: 'Softens the edges of the tone window',
          get: () => L().mask.feather,
          set: (v) => s.editLayerField(id, 'mask', { feather: v }),
        }),
        toggle({
          label: 'Invert mask',
          get: () => L().mask.invert,
          set: (v) => s.editLayerField(id, 'mask', { invert: v }),
        }),
      ], true),

      section('Distribution', this.distributionControls(id)),

      // The picker sits at the top of the section whose sliders reshape whatever
      // it selects, so choosing a shape and tuning it is one movement.
      section('Shape', [
        raw(this.shapeLibrary.el),
        ...shapeParamControls(s, ia, layer.shapeId, () => L().size.max, () => this.store.get().canvas),
      ], false, [this.shapeLibrary.duplicateBtn, this.shapeLibrary.importBtn]),

      section('Size', [
        lengthSlider({
          // A range in fractions of the picture, not in pixels: 0 to a twelfth
          // of the short edge is a hairline to a mark you could count from
          // across the room, and it is that on any document.
          label: 'Size', min: 0, max: 0.08, interaction: ia,
          canvas: this.store.get().canvas, reset: size.max,
          title: 'The overall mark size — what a dot in the shadows measures across',
          get: () => L().size.max,
          set: (v) => {
            // Scale the whole ramp: the spread is what the user set, so moving
            // the master must not quietly change how much tone matters.
            const spread = toneSpread(L());
            s.editLayerField(id, 'size', { max: v, min: v * (1 - spread), fromTone: 1 });
          },
        }),
        slider({
          label: 'Tone spread', min: 0, max: 1, step: 0.01, interaction: ia, reset: 1,
          title: 'How much smaller the quiet end of the range gets. 0 draws every mark at Size',
          info: 'How much the dots shrink in the light parts. At 0 every dot is the full Size, so '
            + 'only the number of dots carries the picture. At 1 dots in the lightest parts shrink '
            + 'to nothing, so size carries it too. The line underneath shows the smallest and '
            + 'largest dot you get.',
          get: () => toneSpread(L()),
          set: (v) => {
            const max = L().size.max;
            s.editLayerField(id, 'size', { min: max * (1 - v), fromTone: 1 });
          },
        }),
        readout(() => {
          const l = L();
          const c = this.store.get().canvas;
          const lo = lightEndSize(l);
          const [a, b] = l.size.invert ? ['darks', 'lights'] : ['lights', 'darks'];
          return `${a} ${formatSpan(lo, c)} → ${b} ${formatSpan(l.size.max, c)}`;
        }),
        slider({
          label: 'Tone response', min: 0.3, max: 2, step: 0.05, interaction: ia, reset: 1,
          info: 'The curve between the small and the large dots. At 1 a dot\u2019s width follows '
            + 'the darkness evenly, which looks right for a drawing. At 0.5 its area does instead, '
            + 'which is what a halftone needs so a 50% grey prints as 50% ink. Below that the '
            + 'mid-tones get heavier, above it lighter.',
          title: '1 makes the mark\u2019s width track tone, which suits a drawing. '
            + '0.5 makes its area track tone, which is what a halftone needs to print '
            + 'a 50% grey as 50% grey',
          get: () => L().size.gamma ?? 1,
          set: (v) => s.editLayerField(id, 'size', { gamma: v }),
        }),
        slider({
          label: 'Size jitter', min: 0, max: 1, step: 0.01, interaction: ia, reset: size.jitter,
          title: 'Random size variation per mark',
          get: () => L().size.jitter,
          set: (v) => s.editLayerField(id, 'size', { jitter: v }),
        }),
        toggle({
          label: 'Swap light / dark',
          title: 'Put the big marks in the highlights instead of the shadows',
          get: () => L().size.invert,
          set: (v) => s.editLayerField(id, 'size', { invert: v }),
        }),
      ]),

      section('Rotation', [
        slider({
          label: 'Angle', min: -180, max: 180, step: 1, interaction: ia, unit: '°', reset: rot.base,
          title: 'Turns every dot by the same amount',
          get: () => L().rotation.base,
          set: (v) => s.editLayerField(id, 'rotation', { base: v }),
        }),
        slider({
          label: 'Randomness', min: 0, max: 1, step: 0.01, interaction: ia, reset: rot.random,
          title: 'Random turn per dot, up to a full revolution at 1',
          get: () => L().rotation.random,
          set: (v) => s.editLayerField(id, 'rotation', { random: v }),
        }),
        slider({
          label: 'Follow contours', min: 0, max: 1, step: 0.01, interaction: ia,
          reset: rot.followGradient,
          title: 'Aligns dots to the image contours — most visible with line shapes',
          get: () => L().rotation.followGradient,
          set: (v) => s.editLayerField(id, 'rotation', { followGradient: v }),
        }),
      ]),

      section('Colour', this.colorControls(id), false, [], 'The ink each dot prints with. Solid is one ink for the whole layer. Spot inks turns the layer into a group with one layer per ink: each draws only where the picture is closest to its colour, so the screens fit together without printing on top of each other, and each ink can have its own shape and size. Pick colours from the picture for details the automatic sampling misses.'),

      section('Transform', [
        slider({
          label: 'Scale', min: 0.1, max: 4, step: 0.01, interaction: ia, unit: '×', reset: 1,
          get: () => L().transform.scale,
          set: (v) => s.editLayerField(id, 'transform', { scale: v }),
        }),
        slider({
          label: 'Rotate', min: -180, max: 180, step: 1, interaction: ia, unit: '°', reset: 0,
          get: () => L().transform.rotate,
          set: (v) => s.editLayerField(id, 'transform', { rotate: v }),
        }),
        // Half the picture each way, whatever size the picture is — a nudge
        // that shifted a layer by a quarter of a small document used to shift it
        // by a twentieth of a big one.
        lengthSlider({
          label: 'Offset X', min: -0.5, max: 0.5, interaction: ia, reset: 0,
          canvas: this.store.get().canvas,
          get: () => L().transform.offsetX,
          set: (v) => s.editLayerField(id, 'transform', { offsetX: v }),
        }),
        lengthSlider({
          label: 'Offset Y', min: -0.5, max: 0.5, interaction: ia, reset: 0,
          canvas: this.store.get().canvas,
          get: () => L().transform.offsetY,
          set: (v) => s.editLayerField(id, 'transform', { offsetY: v }),
        }),
        toggle({
          label: 'Flip horizontally',
          get: () => L().transform.flipX,
          set: (v) => s.editLayerField(id, 'transform', { flipX: v }),
        }),
        toggle({
          label: 'Flip vertically',
          get: () => L().transform.flipY,
          set: (v) => s.editLayerField(id, 'transform', { flipY: v }),
        }),
      ], true),

      section('Blend', [
        select<BlendMode>({
          label: 'Blend mode',
          options: BLEND_MODES.map((m) => ({ value: m, label: cap(m) })),
          get: () => L().blend,
          set: (v) => s.editLayer(id, { blend: v }),
        }),
        slider({
          label: 'Layer opacity', min: 0, max: 1, step: 0.01, interaction: ia, reset: 1,
          get: () => L().opacity,
          set: (v) => s.editLayer(id, { opacity: v }),
        }),
      ], false, [], 'How this layer lands on the layers below it. Multiply darkens like real ink over ink, which is what plates use. Opacity fades the whole layer.'),
    ];

    this.controls = sections;
    this.el.replaceChildren(...sections.map((c) => c.el));
  }

  /**
   * Closest-colour measuring: this layer's colour, the softness of its borders,
   * what happens inside its region, and a way to add a colour the automatic
   * sampling missed. Its competitors are its group — see `Engine.withCompetitors`.
   */
  private nearestControls(id: string): Control[] {
    const s = this.store;
    const L = (): Layer => s.layer(id)!;
    return [
      readout(() => (L().groupId
        ? `Dots go where the picture is closest to ${inkName(L().prefilter.ink ?? L().color.color)}. The inks are set in the Colour section.`
        : 'Alone, so it owns the whole picture: set Colour \u2192 Spot inks to share it with other inks.')),
      select<'even' | 'tone'>({
        label: 'Inside the region',
        title: 'Fill an ink\u2019s region evenly, like a flat screenprint, or put more dots where it is darker',
        options: [
          { value: 'even', label: 'Even fill' },
          { value: 'tone', label: 'Follows the darkness' },
        ],
        get: () => (L().prefilter.nearestTone ? 'tone' : 'even'),
        set: (v) => s.editLayerField(id, 'prefilter', { nearestTone: v === 'tone' }),
      }),
    ];
  }

  /**
   * A picked colour joins the group as a layer of its own, a copy of the
   * selected one in everything but its colour. A layer not yet in a group
   * gets one, so there is something for the colours to compete within.
   */
  private addColourLayer(id: string, c: RGBA, picked = true): void {
    const s = this.store;
    const src = s.layer(id);
    if (!src) return;
    const project = s.get();
    const copy: Layer = JSON.parse(JSON.stringify(src));
    copy.id = uid('layer');
    copy.name = inkName(c);
    copy.prefilter = { ...copy.prefilter, channel: 'nearest', ink: c, nearestPicked: picked };
    copy.color = { ...copy.color, mode: 'solid', color: c };
    copy.distribution = { ...copy.distribution, seed: Math.floor(Math.random() * 9000) + 1 } as Layer['distribution'];
    if (src.groupId) {
      const top = project.layers.reduce((t, l, i) => (l.groupId === src.groupId ? i : t), -1);
      copy.groupId = src.groupId;
      s.addLayer(copy, top + 1);
    } else {
      const at = project.layers.findIndex((l) => l.id === id);
      delete copy.groupId;
      s.addLayer(copy, at + 1);
      const gid = uid('group');
      s.createGroup({ id: gid, name: 'Spot colours', collapsed: false }, [id, copy.id]);
      this.selectGroup(gid);
    }
  }

  /**
   * Algorithm first, then its own parameters, then the two settings every
   * algorithm shares and the seed — so the shared tail stays in the same place
   * no matter which algorithm is selected.
   */
  private distributionControls(id: string): Control[] {
    const s = this.store;
    const ia = this.interaction;
    const L = (): Layer => s.layer(id)!;

    const algoSelect = select<DistributionAlgo>({
      label: 'Algorithm',
      options: [
        { value: 'jittered', label: 'Stochastic (jittered grid)' },
        { value: 'voronoi', label: `Weighted Voronoi${this.voronoiAvailable ? '' : ' (unavailable)'}` },
        { value: 'halftone', label: 'Halftone screen' },
      ],
      get: () => L().distribution.algo,
      set: (v) => {
        if (v === L().distribution.algo) return;
        s.editLayer(id, { distribution: defaultDistribution(v) });
      },
    });

    const seed = (): Control => slider({
      label: 'Seed', min: 1, max: 9999, step: 1,
      title: 'Re-rolls the randomness without changing any other setting',
      get: () => (L().distribution as JitteredParams).seed,
      set: (v) => s.editLayerField(id, 'distribution', { seed: Math.round(v) } as never),
    });

    const tail = (withSeed: boolean): Control[] => [
      rangeControl({
        label: 'Tone range', interaction: ia,
        title: 'Tones outside this window get no dots at all',
        get: () => L().distribution.toneRange,
        set: (v) => s.editLayerField(id, 'distribution', { toneRange: v } as never),
      }),
      toggle({
        label: 'Stipple the lights',
        title: 'Place dots in the highlights instead of the shadows',
        get: () => L().distribution.invertDensity,
        set: (v) => s.editLayerField(id, 'distribution', { invertDensity: v } as never),
      }),
      ...(withSeed ? [seed()] : []),
    ];

    const algo = L().distribution.algo;
    if (algo === 'jittered') {
      const d = (): JitteredParams => L().distribution as JitteredParams;
      return [
        algoSelect,
        slider({
          // A count across the picture, on a log track: proportional, so it
          // means the same on a thumbnail and a poster, and wide enough that
          // both a dozen marks and two thousand are one drag away.
          label: 'Density', min: MIN_DENSITY, max: MAX_DENSITY, step: 1,
          curve: 'log', interaction: ia, reset: 256,
          title: 'How many dots fit across the short edge of the picture. '
            + 'A proportion of the image, not a distance in pixels, so it survives '
            + 'a resize and does not depend on the resolution you opened',
          get: () => d().density,
          set: (v) => s.editLayerField(id, 'distribution', { density: Math.round(v) } as never),
        }),
        readout(() => {
          const c = this.store.get().canvas;
          const n = Math.max(1, d().density);
          const u = unitPx(c);
          const cols = Math.round((n * c.width) / u);
          const rows = Math.round((n * c.height) / u);
          return `${formatSpan(1 / n, c)} apart · ${cols.toLocaleString()} × `
            + `${rows.toLocaleString()} candidate sites`;
        }),
        slider({
          label: 'Tone steps', min: 1, max: 64, step: 1, interaction: ia, reset: 12,
          title: 'Number of discrete tone bands; higher is smoother',
          get: () => d().phases,
          set: (v) => s.editLayerField(id, 'distribution', { phases: v } as never),
        }),
        slider({
          label: 'Position jitter', min: 0, max: 1, step: 0.01, interaction: ia, reset: 0.85,
          title: '0 is a perfect grid, 1 scatters each dot anywhere in its cell',
          get: () => d().jitter,
          set: (v) => s.editLayerField(id, 'distribution', { jitter: v } as never),
        }),
        slider({
          label: 'Overpaint', min: 0, max: 4, step: 1, interaction: ia, reset: 0,
          title: 'Extra offset passes layered over the first',
          get: () => d().overpaint,
          set: (v) => s.editLayerField(id, 'distribution', { overpaint: v } as never),
        }),
        ...tail(true),
      ];
    }

    if (algo === 'voronoi') {
      const d = (): VoronoiParams => L().distribution as VoronoiParams;
      return [
        algoSelect,
        slider({
          // Already scale-free — a count of dots is a count of dots — but it was
          // on a linear track that spent most of its length above 100,000 and
          // could not be set to 800 at all. Log, and up to where the relaxation
          // stops being worth waiting for.
          label: 'Dot count', min: 100, max: 1_000_000, step: 10,
          curve: 'log', interaction: ia, reset: 20000,
          title: 'How many dots the relaxation starts with. Independent of the '
            + 'document size, so this is the same drawing at any resolution',
          get: () => d().points,
          set: (v) => s.editLayerField(id, 'distribution', { points: Math.round(v) } as never),
        }),
        slider({
          label: 'Relaxation', min: 0, max: 60, step: 1, interaction: ia, reset: 16,
          title: 'Lloyd iterations — higher is more evenly spaced',
          get: () => d().iterations,
          set: (v) => s.editLayerField(id, 'distribution', { iterations: v } as never),
        }),
        slider({
          label: 'Density curve', min: 0.5, max: 4, step: 0.05, interaction: ia, reset: 1.6,
          title: 'Above 1 pushes dots harder into the shadows',
          get: () => d().gamma,
          set: (v) => s.editLayerField(id, 'distribution', { gamma: v } as never),
        }),
        ...tail(true),
      ];
    }

    const d = (): HalftoneParams => L().distribution as HalftoneParams;
    return [
      algoSelect,
      slider({
        label: 'Screen', min: 4, max: 2000, step: 1,
        curve: 'log', interaction: ia, reset: 136,
        title: 'Halftone cells across the short edge of the picture. Fewer cells, bigger '
          + 'dots. Relative to the picture, so resizing the document keeps the screen in '
          + 'proportion; the lines-per-inch reading below follows the print size',
        get: () => d().cells,
        set: (v) => s.editLayerField(id, 'distribution', { cells: v } as never),
      }),
      readout(() => {
        const c = this.store.get().canvas;
        const cells = Math.max(1, d().cells);
        const lpi = (cells * Math.max(1, c.dpi)) / unitPx(c);
        return `${cells.toLocaleString()} cells across · ${formatSpan(1 / cells, c)} each · `
          + `${lpi < 10 ? lpi.toFixed(1) : Math.round(lpi)} lpi at this print size`;
      }),
      slider({
        label: 'Screen angle', min: -180, max: 180, step: 0.5, interaction: ia, unit: '°', reset: 45,
        get: () => d().angle,
        set: (v) => s.editLayerField(id, 'distribution', { angle: v } as never),
      }),
      select<'square' | 'hex' | 'line'>({
        label: 'Lattice',
        options: [
          { value: 'square', label: 'Square' },
          { value: 'hex', label: 'Hexagonal' },
          { value: 'line', label: 'Line screen' },
        ],
        get: () => d().lattice,
        set: (v) => s.editLayerField(id, 'distribution', { lattice: v } as never),
      }),
      // A halftone screen is deterministic, so there is no seed to offer.
      ...tail(false),
    ];
  }

  private colorControls(id: string): Control[] {
    const s = this.store;
    const ia = this.interaction;
    const L = (): Layer => s.layer(id)!;
    const inColourGroup = this.isColourGroupLayer(L());
    const mode = inColourGroup ? 'spot' : L().color.mode;

    const controls: Control[] = [
      select<'solid' | 'adaptive' | 'image' | 'multicolor' | 'spot'>({
        label: 'Colour mode',
        options: [
          { value: 'solid', label: 'Solid' },
          { value: 'adaptive', label: 'Ramp (hue from tone)' },
          { value: 'image', label: 'Sample the image' },
          { value: 'multicolor', label: 'Random from palette' },
          { value: 'spot', label: 'Spot inks (one layer per ink, in a group)' },
        ],
        get: () => (this.isColourGroupLayer(L()) ? 'spot' : L().color.mode),
        set: (v) => {
          const member = this.isColourGroupLayer(L());
          if (v === 'spot' && !member) return this.toColourGroup(id);
          if (member && v !== 'spot') {
            // Leaving the spot colours: this layer stops competing for a region
            // and goes back to reading tone, on its own, in whatever mode was chosen.
            s.batch(`leave-spot:${id}`, () => {
              s.updateLayerField(id, 'prefilter', { channel: 'luma' });
              s.updateLayerField(id, 'color', { mode: v });
            });
            return;
          }
          s.editLayerField(id, 'color', { mode: v });
        },
      }),
    ];

    if (inColourGroup) {
      controls.push(
        ...this.colourGroupControls(id),
        slider({
          label: 'Ink opacity', min: 0, max: 1, step: 0.01, interaction: ia, reset: 1,
          title: 'Per-dot alpha, on top of the layer opacity',
          get: () => L().color.alpha,
          set: (v) => s.editLayerField(id, 'color', { alpha: v }),
        }),
      );
      return controls;
    }

    if (mode === 'solid') {
      controls.push(colorControl({
        label: 'Ink', interaction: ia,
        get: () => L().color.color,
        set: (v) => s.editLayerField(id, 'color', { color: v }),
      }));
    }

    if (mode === 'adaptive') {
      controls.push(
        slider({
          label: 'Hue in darks', min: 0, max: 360, step: 1, interaction: ia, unit: '°',
          get: () => L().color.hueA,
          set: (v) => s.editLayerField(id, 'color', { hueA: v }),
        }),
        slider({
          label: 'Hue in lights', min: 0, max: 360, step: 1, interaction: ia, unit: '°',
          get: () => L().color.hueB,
          set: (v) => s.editLayerField(id, 'color', { hueB: v }),
        }),
        slider({
          label: 'Saturation', min: 0, max: 1, step: 0.01, interaction: ia,
          get: () => L().color.saturation,
          set: (v) => s.editLayerField(id, 'color', { saturation: v }),
        }),
        slider({
          label: 'Lightness', min: 0, max: 1, step: 0.01, interaction: ia,
          get: () => L().color.lightness,
          set: (v) => s.editLayerField(id, 'color', { lightness: v }),
        }),
      );
    }

    if (mode === 'spot') {
      // A single-layer spot-ink layer, as projects made before colour groups
      // have. It still prints, but everything spot is a group now: offer the move.
      controls.push(
        hint('This is an older single-layer spot-ink layer: every ink shares one shape and one pattern.'),
        raw(button('Turn into a colour group \u2014 one layer per ink', () => this.toColourGroup(id), 'sm wide primary')),
        ...this.spotControls(id),
      );
    }

    if (mode === 'multicolor') {
      for (let i = 0; i < 3; i++) {
        controls.push(colorControl({
          label: `Ink ${i + 1}`, interaction: ia,
          get: () => L().color.palette[i] ?? [0, 0, 0, 1],
          set: (v) => {
            const palette = [...L().color.palette];
            palette[i] = v;
            s.editLayerField(id, 'color', { palette });
          },
        }));
      }
    }

    controls.push(
      slider({
        label: 'Ink opacity', min: 0, max: 1, step: 0.01, interaction: ia, reset: 1,
        title: 'Per-dot alpha, on top of the layer opacity',
        get: () => L().color.alpha,
        set: (v) => s.editLayerField(id, 'color', { alpha: v }),
      }),
    );
    // Spot mode ignores the wobble on purpose — a dot nudged off its ink would
    // be printed from a screen whose colour the proof never showed — so the
    // slider is not offered there rather than sitting inert.
    if (mode !== 'spot') {
      controls.push(slider({
        label: 'Colour jitter', min: 0, max: 1, step: 0.01, interaction: ia, reset: 0,
        title: 'Random value and alpha wobble per dot',
        get: () => L().color.jitter,
        set: (v) => s.editLayerField(id, 'color', { jitter: v }),
      }));
    }
    return controls;
  }

  /** A closest-colour layer in a group: one ink of a set of spot colours. */
  private isColourGroupLayer(l: Layer): boolean {
    return l.prefilter.channel === 'nearest' && !!l.groupId;
  }

  /** The colour layers of `id`'s group, top of the stack first — the order the layer list shows. */
  private colourPeers(id: string): Layer[] {
    const g = this.store.layer(id)?.groupId;
    if (!g) return [];
    return this.store.get().layers.filter((l) => l.groupId === g && l.prefilter.channel === 'nearest').reverse();
  }

  /**
   * Turn one layer into a group of spot colours, a layer per ink.
   *
   * The inks are its palette if it already had spot inks, otherwise the
   * picture's own three main colours. Every new layer starts as a copy of
   * this one, so its shape, size and screen carry over.
   */
  private toColourGroup(id: string): void {
    const s = this.store;
    const src = s.layer(id);
    if (!src) return;
    const paper = s.get().canvas.background;
    const pic = this.getSource();
    let colours: RGBA[] = src.color.mode === 'spot' && src.color.palette.length ? src.color.palette : [];
    if (!colours.length && pic) colours = extractPalette(pic, 3, paper);
    if (!colours.length) colours = INK_SETS.earth.inks;
    const template: Layer = JSON.parse(JSON.stringify(src));
    template.color = { ...template.color, mode: 'solid' };
    template.prefilter = {
      ...template.prefilter,
      nearestPaper: src.color.mode === 'spot' ? src.color.paper != null : true,
      nearestMix: src.color.mode === 'spot' ? Math.min(1, 0.15 * (1 + src.color.mixing)) : 0.15,
      nearestByTone: src.color.mode === 'spot' && src.color.matchBy === 'tone',
    };
    const pinned = src.color.pinned ?? [];
    const picked = colours.map((c) => pinned.some((p) => same(p, c)));
    // Groups do not nest: a layer already in one (a CMYK plate, say) becomes
    // ink layers of that same group rather than a folder inside a folder.
    const existing = src.groupId ? s.group(src.groupId) : undefined;
    const group = existing ?? { id: uid('group'), name: 'Spot colours', collapsed: false };
    const layers = buildColourLayers(colours, group.id, template, picked);
    if (existing) {
      s.batch(`to-group:${id}`, () => {
        const at = s.get().layers.findIndex((l) => l.id === id);
        s.removeLayer(id);
        layers.forEach((l, k) => s.addLayer(l, at + k));
      });
    } else {
      s.replaceLayerWithGroup(id, layers, group);
    }
    this.selectGroup(group.id);
  }

  /**
   * The Colour section of a spot-colour group: the group's inks as one palette.
   *
   * Each swatch *is* a layer of the group, so changing one recolours that
   * layer, and changing the count adds or removes layers. Everything about how
   * the inks divide the picture — matching, borders, paper — belongs to the
   * group, and applies to all of its layers whichever one is selected.
   */
  private colourGroupControls(id: string): Control[] {
    const s = this.store;
    const ia = this.interaction;
    const peers = (): Layer[] => this.colourPeers(id);
    const first = (): Layer => peers()[0] ?? s.layer(id)!;
    const paper = (): RGBA => s.get().canvas.background;

    /** One prefilter patch on every layer of the group, as a single undo step. */
    const setAll = (patch: Partial<Layer['prefilter']>, key: string): void =>
      s.batch(key, () => { for (const l of peers()) s.updateLayerField(l.id, 'prefilter', patch); });

    /** Give the group these colours, in list order, growing or shrinking it to fit. */
    const setColours = (colours: RGBA[], key: string, extra: Partial<Layer['prefilter']> = {}): void => {
      if (!colours.length) return;
      s.batch(key, () => {
        let list = peers();
        // Fewer inks: drop from the top, keeping the colours picked by hand longest.
        while (list.length > colours.length) {
          const drop = [...list].reverse().find((l) => !l.prefilter.nearestPicked) ?? list[list.length - 1];
          s.removeLayer(drop.id);
          list = peers();
        }
        list.forEach((l, i) => {
          s.updateLayerField(l.id, 'prefilter', { ink: colours[i], ...extra });
          s.updateLayerField(l.id, 'color', { mode: 'solid', color: colours[i] });
          s.updateLayer(l.id, { name: inkName(colours[i]) });
        });
        for (let i = list.length; i < colours.length; i++) this.addColourLayer(list[0]?.id ?? id, colours[i], false);
        if (Object.keys(extra).length) for (const l of peers()) s.updateLayerField(l.id, 'prefilter', extra);
      });
    };

    /** Re-sample, keeping hand-picked colours and filling the rest from the picture. */
    const resample = (n: number, byTone: boolean, key: string): void => {
      const pic = this.getSource();
      if (!pic) return;
      const list = peers();
      const picked = list.filter((l) => l.prefilter.nearestPicked).map((l) => l.prefilter.ink!);
      const auto = Math.max(0, n - picked.length);
      // Sample one extra, so a colour you already picked can be skipped without
      // leaving the group a colour short.
      const sampled = auto ? (byTone ? toneRamp(pic, auto + picked.length, paper()) : extractPalette(pic, auto + picked.length, paper())) : [];
      const found = sampled.filter((c) => !picked.some((q) => near(q, c))).slice(0, auto);
      // Picked colours keep their layers; the unpicked ones take the new colours.
      const colours: RGBA[] = [];
      let f = 0;
      for (const l of list.slice(0, n)) colours.push(l.prefilter.nearestPicked ? l.prefilter.ink! : (found[f++] ?? l.prefilter.ink!));
      while (colours.length < n && f < found.length) colours.push(found[f++]);
      setColours(colours, key, byTone ? { nearestByTone: true, nearestMix: 0 } : { nearestByTone: false });
    };

    let sharesKey = '';
    let sharesText = '';
    const shares = (): string => {
      const pic = this.getSource();
      if (!pic) return 'Open an image to see how the inks divide it.';
      const inks = peers().map((l) => l.prefilter.ink ?? l.color.color);
      const leave = !!first().prefilter.nearestPaper;
      const byTone = !!first().prefilter.nearestByTone;
      const key = `${JSON.stringify(inks)}|${leave}|${byTone}|${JSON.stringify(paper())}`;
      if (key === sharesKey) return sharesText;
      const split = inkShares(pic, buildInkSet(inks, leave ? paper() : null), 0, byTone);
      sharesKey = key;
      sharesText = split.map((v, i) => `${i < inks.length ? inkName(inks[i]) : 'paper'} ${Math.round(v * 100)}%`).join(' · ');
      return sharesText;
    };

    const inkSetSelect = h('select', { class: 'ink-set-select' }) as HTMLSelectElement;
    inkSetSelect.append(h('option', { value: '' }, 'Load an ink set…'));
    for (const [key, set] of Object.entries(INK_SETS)) inkSetSelect.append(h('option', { value: key }, set.label));
    inkSetSelect.addEventListener('change', () => {
      const set = INK_SETS[inkSetSelect.value];
      inkSetSelect.value = '';
      if (set) setColours(set.inks.map((c) => [...c] as RGBA), 'ink-set', { nearestPaper: set.paper != null });
    });

    return [
      slider({
        label: 'Inks', min: 1, max: 8, step: 1, interaction: ia,
        title: 'How many screens you are willing to print — one layer each',
        get: () => peers().length,
        set: (v) => {
          const n = Math.round(v);
          const cur = peers();
          if (n === cur.length) return;
          if (n < cur.length) return setColours(cur.slice(0, n).map((l) => l.prefilter.ink!), 'ink-count');
          // Growing adds the colours the picture needs that the group lacks.
          const pic = this.getSource();
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
        names: () => peers().map((l) => l.name),
        remove: (i) => {
          const l = peers()[i];
          if (l && peers().length > 1) s.removeLayer(l.id);
        },
        get: () => peers().map((l) => (l.prefilter.ink ?? l.color.color) as [number, number, number, number]),
        set: (v) => {
          const list = peers();
          s.batch('palette', () => v.forEach((c, i) => {
            const l = list[i];
            if (!l || same(c, l.prefilter.ink ?? l.color.color)) return;
            s.updateLayerField(l.id, 'prefilter', { ink: c });
            s.updateLayerField(l.id, 'color', { mode: 'solid', color: c });
            s.updateLayer(l.id, { name: inkName(c) });
          }));
        },
      }),
      readout(shares),
      group('Choosing the inks'),
      raw(button('Sample the colours', () => resample(peers().length, false, 'extract'), 'sm',
        'Find the colours the picture is made of. Colours you picked by hand are kept')),
      raw(button('Posterise the tones', () => resample(peers().length, true, 'posterise'), 'sm',
        'A dark-to-light ramp from the picture, matched on lightness with hard borders')),
      raw(button('Pick a colour from the picture', () => this.pickColour((c) => this.addColourLayer(id, c, true)), 'sm',
        'Tap the picture on a colour the group is missing — a small detail the sampling averaged away. It becomes a layer, and stays when you sample again')),
      raw(h('div', { class: 'ink-set-row' }, inkSetSelect)),
      group('How the inks share the picture'),
      select<'colour' | 'tone'>({
        label: 'Match on',
        title: 'Whether a pixel goes to the ink closest in colour, or closest in lightness alone',
        options: [
          { value: 'colour', label: 'Colour' },
          { value: 'tone', label: 'Lightness only' },
        ],
        get: () => (first().prefilter.nearestByTone ? 'tone' : 'colour'),
        set: (v) => setAll({ nearestByTone: v === 'tone' }, 'match-on'),
      }),
      slider({
        label: 'Soft borders', min: 0, max: 1, step: 0.01, interaction: ia, reset: 0.15,
        title: '0 is a hard edge between inks; higher dithers the pixels near a border between their two closest inks',
        get: () => first().prefilter.nearestMix ?? 0,
        set: (v) => setAll({ nearestMix: v }, 'soft-borders'),
      }),
      toggle({
        label: 'Leave paper',
        title: 'The paper competes as an ink, and where it is closest nothing prints — highlights stay bare stock',
        get: () => !!first().prefilter.nearestPaper,
        set: (v) => setAll({ nearestPaper: v }, 'leave-paper'),
      }),
    ];
  }

  /**
   * Spot inks: the controls that make a drawing printable by hand.
   *
   * A screenprint is N screens and nothing else, so this section is about
   * choosing those N and deciding how strictly each dot is held to them.
   * `Mixing` is the one that changes the character of the print: at 0 the dots
   * never leave their nearest ink and the result posterises into flat areas of
   * colour; at 1 they scatter between the two inks that reproduce the colour
   * and the eye does the mixing, which with process inks is a scatter
   * separation. Everything between is a partly mixed print.
   */
  private spotControls(id: string): Control[] {
    const s = this.store;
    const ia = this.interaction;
    const L = (): Layer => s.layer(id)!;
    const setC = (patch: Partial<Layer['color']>, key?: string): void =>
      s.editLayerField(id, 'color', patch, key);

    // Estimating the split walks a few thousand pixels, and `sync` runs on every
    // store change, so cache it against the things it actually depends on.
    let sharesKey = '';
    let sharesText = '';
    const shares = (): string => {
      const c = L().color;
      const src = this.getSource();
      if (!src) return 'Open an image to see how the inks divide it.';
      const key = `${JSON.stringify(c.palette)}|${JSON.stringify(c.paper)}|${c.mixing}|${c.matchBy}`;
      if (key === sharesKey) return sharesText;
      const set = buildInkSet(c.palette, c.paper ?? null);
      const split = inkShares(src, set, c.mixing, c.matchBy === 'tone');
      const parts = split.map((v, i) => {
        const name = i >= set.inkCount ? 'paper' : inkName(c.palette[i]);
        return `${name} ${Math.round(v * 100)}%`;
      });
      sharesKey = key;
      sharesText = parts.join(' · ');
      return sharesText;
    };

    const inkSetSelect = h('select', { class: 'ink-set-select' }) as HTMLSelectElement;
    inkSetSelect.append(h('option', { value: '' }, 'Load an ink set…'));
    for (const [key, set] of Object.entries(INK_SETS)) {
      inkSetSelect.append(h('option', { value: key }, set.label));
    }
    inkSetSelect.addEventListener('change', () => {
      const set = INK_SETS[inkSetSelect.value];
      inkSetSelect.value = '';
      if (!set) return;
      setC({ palette: set.inks.map((c) => [...c] as Layer['color']['palette'][number]), paper: set.paper });
    });

    // Three fields, one history key, so this is a single undo rather than three.
    const evenUp = (): void => {
      s.editLayerField(id, 'prefilter', { channel: 'flat' }, 'spot-setup');
      s.editLayerField(id, 'size', { fromTone: 0 }, 'spot-setup');
      s.editLayerField(id, 'color', { jitter: 0 }, 'spot-setup');
    };

    const propose = (mode: 'colour' | 'tone'): void => {
      const src = this.getSource();
      if (!src) return;
      const c = L().color;
      const n = c.palette.length || 3;
      // Picked colours stay; sampling only fills the slots that are left.
      const pinned = (c.pinned ?? []).filter((p) => c.palette.some((q) => same(p, q))).slice(0, n);
      const auto = Math.max(0, n - pinned.length);
      const found = [...pinned, ...(auto ? (mode === 'tone' ? toneRamp(src, auto, c.paper) : extractPalette(src, auto, c.paper)) : [])];
      if (!found.length) return;
      // Posterising is a decision about the whole layer, not just the swatches:
      // a tonal ramp only reads as bands if the dots stop straying between them
      // and the match stops caring about hue.
      if (mode === 'tone') setC({ palette: found, matchBy: 'tone', mixing: 0 }, 'posterise');
      else setC({ palette: found }, 'extract');
    };

    return [
      slider({
        label: 'Inks', min: 1, max: 8, step: 1, interaction: ia,
        title: 'How many screens you are willing to print',
        get: () => L().color.palette.length,
        set: (v) => {
          const cur = L().color.palette;
          const n = Math.round(v);
          if (n === cur.length) return;
          const next = cur.slice(0, n);
          // Growing proposes the extra inks from the image when there is one, so
          // adding a screen lands on a colour the picture needs rather than on
          // black, which you would then have to hunt for by hand.
          const src = this.getSource();
          const c = L().color;
          const found = src
            ? (c.matchBy === 'tone' ? toneRamp(src, n, c.paper) : extractPalette(src, n, c.paper))
            : [];
          while (next.length < n) next.push(found[next.length] ?? [0, 0, 0, 1]);
          setC({ palette: next }, 'ink-count');
        },
      }),
      paletteControl({
        label: 'Palette', interaction: ia,
        title: 'Print order, darkest screen first',
        get: () => L().color.palette as [number, number, number, number][],
        set: (v) => setC({ palette: v }),
      }),
      readout(shares),
      group('Choosing the inks'),
      raw(button('Sample the colours', () => propose('colour'), 'sm',
        'Cluster the photograph and use the colours it is actually made of')),
      raw(button('Posterise the tones', () => propose('tone'), 'sm',
        'Build a dark-to-light ramp from the photograph and hold every dot to it')),
      raw(button('Pick a colour from the picture', () => this.pickColour((picked) => {
        const c = L().color;
        if (c.palette.length >= 8) return;
        setC({ palette: [...c.palette, picked], pinned: [...(c.pinned ?? []), picked] }, 'pick');
      }), 'sm', 'Tap the picture on a colour to add it to the inks. Picked colours are kept when you sample again')),
      raw(h('div', { class: 'ink-set-row' }, inkSetSelect)),

      group('How the dots use them'),
      select<'colour' | 'tone'>({
        label: 'Match on',
        title: 'Whether an ink is chosen by its whole colour or by lightness alone',
        options: [
          { value: 'colour', label: 'Colour' },
          { value: 'tone', label: 'Lightness only' },
        ],
        get: () => L().color.matchBy,
        set: (v) => setC({ matchBy: v }),
      }),
      slider({
        label: 'Mixing', min: 0, max: 1, step: 0.01, interaction: ia, reset: 1,
        title: '0 posterises into flat colour; 1 scatters the dots so the eye mixes them',
        get: () => L().color.mixing,
        set: (v) => setC({ mixing: v }),
      }),
      // A live readout, not a hint: the hint was baked when the section was built
      // and went on describing whatever the slider said at the time.
      readout(() => {
        const m = L().color.mixing;
        return m < 0.02 ? 'Posterised — every dot takes its nearest ink'
          : m > 0.98 ? 'Scattered — two inks dither to rebuild the colour'
          : `Partly mixed — dots stray up to ${Math.round(m * 100)}% of the way to a second ink`;
      }),

      group('Paper'),
      toggle({
        label: 'Leave paper',
        title: 'Highlights print as bare stock instead of taking the palest ink — one screen fewer',
        get: () => L().color.paper !== null,
        set: (v) => setC({ paper: v ? [1, 1, 1, 1] : null }),
      }),
      when(() => L().color.paper !== null, colorControl({
        label: 'Stock', interaction: ia,
        get: () => L().color.paper ?? [1, 1, 1, 1],
        set: (v) => setC({ paper: v }),
      })),

      // Density and dot size both track tone by default, and in spot mode the
      // ink choice does too — so an untouched layer darkens the image three
      // times over. Offer the fix where the problem is visible.
      when(() => !evenCoverage(L()),
        hint('Dots also thin out and shrink in the lights, so the ink lightens them a third '
          + 'time and the print comes out pale. Even it out and let the ink carry it.')),
      when(() => !evenCoverage(L()), raw(button('Set up for even coverage', evenUp, 'sm wide'))),
    ];
  }
}

/** Whether a layer lays its dots down evenly, which is what spot mode wants. */
function evenCoverage(layer: Layer): boolean {
  return layer.prefilter.channel === 'flat' && layer.size.fromTone === 0;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The size the quiet end of the tone range actually renders at.
 *
 * `size.min` is not that number on its own: the shader blends the tone-driven
 * size against a flat `size.max` by `fromTone`, so a layer can reach the same
 * visible ramp through several different triples. Collapsing them here is what
 * lets one "Tone spread" slider stand in for two that were never independent.
 */
function lightEndSize(layer: Layer): number {
  const s = layer.size;
  return s.max + (s.min - s.max) * s.fromTone;
}

/** That ramp as a fraction, which is what the slider edits. */
function toneSpread(layer: Layer): number {
  const max = layer.size.max;
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - lightEndSize(layer) / max));
}

/** Two colours equal to within rounding — for recognising a pinned ink in the palette. */
function same(a: RGBA, b: RGBA): boolean {
  return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3;
}

/** Two colours close enough to count as the same ink when growing a palette. */
function near(a: RGBA, b: RGBA): boolean {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.12;
}
