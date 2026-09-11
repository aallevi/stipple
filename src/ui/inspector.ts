import { defaultDistribution, defaultRotation, defaultSize } from '../core/defaults';
import type { Store } from '../core/store';
import {
  BLEND_MODES, type BlendMode, type DistributionAlgo, type HalftoneParams,
  type JitteredParams, type Layer, type VoronoiParams,
} from '../core/types';
import {
  button, colorControl, h, hint, raw, rangeControl, readout, section, select, slider, toggle,
  type Control, type Interaction,
} from './controls';
import { shapeParamControls } from './shapeparams';

/**
 * Parameter panel for the selected layer.
 *
 * Rebuilt only when the layer, its algorithm, its colour mode or its shape kind
 * changes; every other update is a `sync()` that pushes current values into
 * existing inputs. That keeps focus and scroll position stable while you drag a
 * slider, and means an undo does not tear down the panel you are working in.
 *
 * Section order follows the order you actually work in: what the layer is, where
 * the dots go, what a dot looks like, how big, which way round, what colour —
 * then the three refinement sections, collapsed until wanted.
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
    const key = [layer.id, layer.distribution.algo, layer.color.mode, layer.shapeId,
      shapeForm, layer.prefilter.channel ?? 'luma'].join(':');
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
      section('Layer', [
        select<'source' | 'below'>({
          label: 'Reads from',
          title: 'Sample the photo, or the composite of everything stacked underneath',
          options: [
            { value: 'source', label: 'Source image' },
            { value: 'below', label: 'Layers below' },
          ],
          get: () => L().input,
          set: (v) => s.updateLayer(id, { input: v }),
        }),
        select<BlendMode>({
          label: 'Blend mode',
          options: BLEND_MODES.map((m) => ({ value: m, label: cap(m) })),
          get: () => L().blend,
          set: (v) => s.updateLayer(id, { blend: v }),
        }),
        slider({
          label: 'Layer opacity', min: 0, max: 1, step: 0.01, interaction: ia, reset: 1,
          get: () => L().opacity,
          set: (v) => s.updateLayer(id, { opacity: v }),
        }),
      ]),

      section('Distribution', this.distributionControls(id)),

      // The picker sits at the top of the section whose sliders reshape whatever
      // it selects, so choosing a shape and tuning it is one movement.
      section('Shape', [
        raw(this.shapeLibrary.el),
        ...shapeParamControls(s, ia, layer.shapeId, () => L().size.max),
      ], false, [this.shapeLibrary.duplicateBtn, this.shapeLibrary.importBtn]),

      section('Size', [
        slider({
          label: 'Size', min: 0, max: 60, step: 0.1, interaction: ia,
          unit: 'px', reset: size.max,
          title: 'The overall mark size — what a dot in the shadows measures across',
          get: () => L().size.max,
          set: (v) => {
            // Scale the whole ramp: the spread is what the user set, so moving
            // the master must not quietly change how much tone matters.
            const spread = toneSpread(L());
            s.updateLayerField(id, 'size', { max: v, min: v * (1 - spread), fromTone: 1 });
          },
        }),
        slider({
          label: 'Tone spread', min: 0, max: 1, step: 0.01, interaction: ia, reset: 1,
          title: 'How much smaller the quiet end of the range gets. 0 draws every mark at Size',
          get: () => toneSpread(L()),
          set: (v) => {
            const max = L().size.max;
            s.updateLayerField(id, 'size', { min: max * (1 - v), fromTone: 1 });
          },
        }),
        readout(() => {
          const l = L();
          const lo = lightEndSize(l);
          const [a, b] = l.size.invert ? ['darks', 'lights'] : ['lights', 'darks'];
          return `${a} ${lo.toFixed(1)} px \u2192 ${b} ${l.size.max.toFixed(1)} px`;
        }),
        slider({
          label: 'Tone response', min: 0.3, max: 2, step: 0.05, interaction: ia, reset: 1,
          title: '1 makes the mark\u2019s width track tone, which suits a drawing. '
            + '0.5 makes its area track tone, which is what a halftone needs to print '
            + 'a 50% grey as 50% grey',
          get: () => L().size.gamma ?? 1,
          set: (v) => s.updateLayerField(id, 'size', { gamma: v }),
        }),
        slider({
          label: 'Size jitter', min: 0, max: 1, step: 0.01, interaction: ia, reset: size.jitter,
          title: 'Random size variation per mark',
          get: () => L().size.jitter,
          set: (v) => s.updateLayerField(id, 'size', { jitter: v }),
        }),
        toggle({
          label: 'Swap light / dark',
          title: 'Put the big marks in the highlights instead of the shadows',
          get: () => L().size.invert,
          set: (v) => s.updateLayerField(id, 'size', { invert: v }),
        }),
      ]),

      section('Rotation', [
        slider({
          label: 'Angle', min: -180, max: 180, step: 1, interaction: ia, unit: '°', reset: rot.base,
          title: 'Turns every dot by the same amount',
          get: () => L().rotation.base,
          set: (v) => s.updateLayerField(id, 'rotation', { base: v }),
        }),
        slider({
          label: 'Randomness', min: 0, max: 1, step: 0.01, interaction: ia, reset: rot.random,
          title: 'Random turn per dot, up to a full revolution at 1',
          get: () => L().rotation.random,
          set: (v) => s.updateLayerField(id, 'rotation', { random: v }),
        }),
        slider({
          label: 'Follow contours', min: 0, max: 1, step: 0.01, interaction: ia,
          reset: rot.followGradient,
          title: 'Aligns dots to the image contours — most visible with line shapes',
          get: () => L().rotation.followGradient,
          set: (v) => s.updateLayerField(id, 'rotation', { followGradient: v }),
        }),
      ]),

      section('Colour', this.colorControls(id)),

      section('Tone mask', [
        rangeControl({
          label: 'Keep tones', interaction: ia,
          title: 'Dots are placed only where the source tone falls inside this window',
          get: () => L().mask.toneRange,
          set: (v) => s.updateLayerField(id, 'mask', { toneRange: v }),
        }),
        slider({
          label: 'Feather', min: 0, max: 0.5, step: 0.01, interaction: ia, reset: 0,
          title: 'Softens the edges of the tone window',
          get: () => L().mask.feather,
          set: (v) => s.updateLayerField(id, 'mask', { feather: v }),
        }),
        toggle({
          label: 'Invert mask',
          get: () => L().mask.invert,
          set: (v) => s.updateLayerField(id, 'mask', { invert: v }),
        }),
      ], true),

      section('Ink', [
        select<'luma' | 'ink'>({
          label: 'Measures',
          title: 'Overall tone, or the coverage of one ink — the basis of a separation',
          options: [
            { value: 'luma', label: 'Overall tone' },
            { value: 'ink', label: 'One ink (separation)' },
          ],
          get: () => L().prefilter.channel ?? 'luma',
          set: (v) => s.updateLayerField(id, 'prefilter', { channel: v }),
        }),
        ...(layer.prefilter.channel === 'ink' ? [
          colorControl({
            label: 'Ink', interaction: ia,
            get: () => L().prefilter.ink ?? [0, 0, 0, 1],
            set: (v) => s.updateLayerField(id, 'prefilter', { ink: v }),
          }),
          slider({
            label: 'Undercolour', min: 0, max: 1, step: 0.01, interaction: ia, reset: 1,
            title: 'How much of the neutral component to leave to a black plate. '
              + '1 keeps total ink coverage printable; 0 is a naive separation',
            get: () => L().prefilter.undercolor ?? 0,
            set: (v) => s.updateLayerField(id, 'prefilter', { undercolor: v }),
          }),
          raw(button('Match the dot colour to this ink', () => {
            const c = L().prefilter.ink ?? [0, 0, 0, 1];
            s.updateLayerField(id, 'color', { mode: 'solid', color: c });
          }, 'sm wide')),
        ] : [hint('This layer reads overall tone. Switch to an ink to make it one plate of a separation.')]),
      ], layer.prefilter.channel !== 'ink'),

      section('Image adjust', [
        slider({
          label: 'Brightness', min: -1, max: 1, step: 0.01, interaction: ia, reset: 0,
          get: () => L().prefilter.brightness,
          set: (v) => s.updateLayerField(id, 'prefilter', { brightness: v }),
        }),
        slider({
          label: 'Contrast', min: -1, max: 1, step: 0.01, interaction: ia, reset: 0,
          get: () => L().prefilter.contrast,
          set: (v) => s.updateLayerField(id, 'prefilter', { contrast: v }),
        }),
        slider({
          label: 'Gamma', min: 0.1, max: 4, step: 0.01, interaction: ia, reset: 1,
          get: () => L().prefilter.gamma,
          set: (v) => s.updateLayerField(id, 'prefilter', { gamma: v }),
        }),
        slider({
          label: 'Blur', min: 0, max: 20, step: 0.5, interaction: ia, unit: 'px', reset: 0,
          get: () => L().prefilter.blur,
          set: (v) => s.updateLayerField(id, 'prefilter', { blur: v }),
        }),
        slider({
          label: 'Sharpen', min: 0, max: 1, step: 0.01, interaction: ia, reset: 0,
          get: () => L().prefilter.sharpen,
          set: (v) => s.updateLayerField(id, 'prefilter', { sharpen: v }),
        }),
        toggle({
          label: 'Invert image',
          get: () => L().prefilter.invert,
          set: (v) => s.updateLayerField(id, 'prefilter', { invert: v }),
        }),
      ], true),

      section('Transform', [
        slider({
          label: 'Scale', min: 0.1, max: 4, step: 0.01, interaction: ia, unit: '×', reset: 1,
          get: () => L().transform.scale,
          set: (v) => s.updateLayerField(id, 'transform', { scale: v }),
        }),
        slider({
          label: 'Rotate', min: -180, max: 180, step: 1, interaction: ia, unit: '°', reset: 0,
          get: () => L().transform.rotate,
          set: (v) => s.updateLayerField(id, 'transform', { rotate: v }),
        }),
        slider({
          label: 'Offset X', min: -1000, max: 1000, step: 1, interaction: ia, unit: 'px', reset: 0,
          get: () => L().transform.offsetX,
          set: (v) => s.updateLayerField(id, 'transform', { offsetX: v }),
        }),
        slider({
          label: 'Offset Y', min: -1000, max: 1000, step: 1, interaction: ia, unit: 'px', reset: 0,
          get: () => L().transform.offsetY,
          set: (v) => s.updateLayerField(id, 'transform', { offsetY: v }),
        }),
        toggle({
          label: 'Flip horizontally',
          get: () => L().transform.flipX,
          set: (v) => s.updateLayerField(id, 'transform', { flipX: v }),
        }),
        toggle({
          label: 'Flip vertically',
          get: () => L().transform.flipY,
          set: (v) => s.updateLayerField(id, 'transform', { flipY: v }),
        }),
      ], true),
    ];

    this.controls = sections;
    this.el.replaceChildren(...sections.map((c) => c.el));
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
        s.updateLayer(id, { distribution: defaultDistribution(v) });
      },
    });

    const seed = (): Control => slider({
      label: 'Seed', min: 1, max: 9999, step: 1,
      title: 'Re-rolls the randomness without changing any other setting',
      get: () => (L().distribution as JitteredParams).seed,
      set: (v) => s.updateLayerField(id, 'distribution', { seed: Math.round(v) } as never),
    });

    const tail = (withSeed: boolean): Control[] => [
      rangeControl({
        label: 'Tone range', interaction: ia,
        title: 'Tones outside this window get no dots at all',
        get: () => L().distribution.toneRange,
        set: (v) => s.updateLayerField(id, 'distribution', { toneRange: v } as never),
      }),
      toggle({
        label: 'Stipple the lights',
        title: 'Place dots in the highlights instead of the shadows',
        get: () => L().distribution.invertDensity,
        set: (v) => s.updateLayerField(id, 'distribution', { invertDensity: v } as never),
      }),
      ...(withSeed ? [seed()] : []),
    ];

    const algo = L().distribution.algo;
    if (algo === 'jittered') {
      const d = (): JitteredParams => L().distribution as JitteredParams;
      return [
        algoSelect,
        slider({
          label: 'Spacing', min: 1, max: 40, step: 0.25, interaction: ia, unit: 'px', reset: 4,
          title: 'Distance between candidate dots, in canvas pixels — lower means more dots',
          get: () => d().spacing,
          set: (v) => s.updateLayerField(id, 'distribution', { spacing: v } as never),
        }),
        slider({
          label: 'Tone steps', min: 1, max: 64, step: 1, interaction: ia, reset: 12,
          title: 'Number of discrete tone bands; higher is smoother',
          get: () => d().phases,
          set: (v) => s.updateLayerField(id, 'distribution', { phases: v } as never),
        }),
        slider({
          label: 'Position jitter', min: 0, max: 1, step: 0.01, interaction: ia, reset: 0.85,
          title: '0 is a perfect grid, 1 scatters each dot anywhere in its cell',
          get: () => d().jitter,
          set: (v) => s.updateLayerField(id, 'distribution', { jitter: v } as never),
        }),
        slider({
          label: 'Overpaint', min: 0, max: 4, step: 1, interaction: ia, reset: 0,
          title: 'Extra offset passes layered over the first',
          get: () => d().overpaint,
          set: (v) => s.updateLayerField(id, 'distribution', { overpaint: v } as never),
        }),
        ...tail(true),
      ];
    }

    if (algo === 'voronoi') {
      const d = (): VoronoiParams => L().distribution as VoronoiParams;
      return [
        algoSelect,
        slider({
          label: 'Dot count', min: 500, max: 200000, step: 500, interaction: ia, reset: 20000,
          get: () => d().points,
          set: (v) => s.updateLayerField(id, 'distribution', { points: v } as never),
        }),
        slider({
          label: 'Relaxation', min: 0, max: 60, step: 1, interaction: ia, reset: 16,
          title: 'Lloyd iterations — higher is more evenly spaced',
          get: () => d().iterations,
          set: (v) => s.updateLayerField(id, 'distribution', { iterations: v } as never),
        }),
        slider({
          label: 'Density curve', min: 0.5, max: 4, step: 0.05, interaction: ia, reset: 1.6,
          title: 'Above 1 pushes dots harder into the shadows',
          get: () => d().gamma,
          set: (v) => s.updateLayerField(id, 'distribution', { gamma: v } as never),
        }),
        ...tail(true),
      ];
    }

    const d = (): HalftoneParams => L().distribution as HalftoneParams;
    return [
      algoSelect,
      slider({
        label: 'Lineature', min: 5, max: 200, step: 1, interaction: ia, unit: 'lpi', reset: 40,
        title: 'Lines per inch, relative to the canvas DPI',
        get: () => d().lineature,
        set: (v) => s.updateLayerField(id, 'distribution', { lineature: v } as never),
      }),
      slider({
        label: 'Screen angle', min: -180, max: 180, step: 0.5, interaction: ia, unit: '°', reset: 45,
        get: () => d().angle,
        set: (v) => s.updateLayerField(id, 'distribution', { angle: v } as never),
      }),
      select<'square' | 'hex' | 'line'>({
        label: 'Lattice',
        options: [
          { value: 'square', label: 'Square' },
          { value: 'hex', label: 'Hexagonal' },
          { value: 'line', label: 'Line screen' },
        ],
        get: () => d().lattice,
        set: (v) => s.updateLayerField(id, 'distribution', { lattice: v } as never),
      }),
      // A halftone screen is deterministic, so there is no seed to offer.
      ...tail(false),
    ];
  }

  private colorControls(id: string): Control[] {
    const s = this.store;
    const ia = this.interaction;
    const L = (): Layer => s.layer(id)!;
    const mode = L().color.mode;

    const controls: Control[] = [
      select<'solid' | 'adaptive' | 'image' | 'multicolor'>({
        label: 'Colour mode',
        options: [
          { value: 'solid', label: 'Solid' },
          { value: 'adaptive', label: 'Ramp (hue from tone)' },
          { value: 'image', label: 'Sample the image' },
          { value: 'multicolor', label: 'Random from palette' },
        ],
        get: () => L().color.mode,
        set: (v) => s.updateLayerField(id, 'color', { mode: v }),
      }),
    ];

    if (mode === 'solid') {
      controls.push(colorControl({
        label: 'Ink', interaction: ia,
        get: () => L().color.color,
        set: (v) => s.updateLayerField(id, 'color', { color: v }),
      }));
    }

    if (mode === 'adaptive') {
      controls.push(
        slider({
          label: 'Hue in darks', min: 0, max: 360, step: 1, interaction: ia, unit: '°',
          get: () => L().color.hueA,
          set: (v) => s.updateLayerField(id, 'color', { hueA: v }),
        }),
        slider({
          label: 'Hue in lights', min: 0, max: 360, step: 1, interaction: ia, unit: '°',
          get: () => L().color.hueB,
          set: (v) => s.updateLayerField(id, 'color', { hueB: v }),
        }),
        slider({
          label: 'Saturation', min: 0, max: 1, step: 0.01, interaction: ia,
          get: () => L().color.saturation,
          set: (v) => s.updateLayerField(id, 'color', { saturation: v }),
        }),
        slider({
          label: 'Lightness', min: 0, max: 1, step: 0.01, interaction: ia,
          get: () => L().color.lightness,
          set: (v) => s.updateLayerField(id, 'color', { lightness: v }),
        }),
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
            s.updateLayerField(id, 'color', { palette });
          },
        }));
      }
    }

    controls.push(
      slider({
        label: 'Ink opacity', min: 0, max: 1, step: 0.01, interaction: ia, reset: 1,
        title: 'Per-dot alpha, on top of the layer opacity',
        get: () => L().color.alpha,
        set: (v) => s.updateLayerField(id, 'color', { alpha: v }),
      }),
      slider({
        label: 'Colour jitter', min: 0, max: 1, step: 0.01, interaction: ia, reset: 0,
        title: 'Random value and alpha wobble per dot',
        get: () => L().color.jitter,
        set: (v) => s.updateLayerField(id, 'color', { jitter: v }),
      }),
    );
    return controls;
  }
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
