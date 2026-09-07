import { defaultDistribution } from '../core/defaults';
import type { Store } from '../core/store';
import {
  BLEND_MODES, type BlendMode, type DistributionAlgo, type HalftoneParams,
  type JitteredParams, type Layer, type VoronoiParams,
} from '../core/types';
import {
  colorControl, h, rangeControl, section, select, slider, toggle,
  type Control, type Interaction,
} from './controls';

/**
 * Parameter panel for the selected layer.
 *
 * Rebuilt only when the layer or its algorithm changes; every other update is a
 * `sync()` that pushes current values into existing inputs. That keeps focus and
 * scroll position stable while you drag a slider, and means an undo does not
 * tear down the panel you are working in.
 */
export class Inspector {
  readonly el = h('div', { class: 'inspector' });
  private controls: Control[] = [];
  private builtFor = '';

  constructor(
    private store: Store,
    private interaction: Interaction,
    private shapeOptions: () => { value: string; label: string }[],
    private voronoiAvailable: boolean,
  ) {}

  /** Rebuild if the layer identity or algorithm changed, otherwise just sync. */
  update(layerId: string | null): void {
    const layer = layerId ? this.store.layer(layerId) : undefined;
    if (!layer) {
      this.el.replaceChildren(h('p', { class: 'empty' }, 'Select a layer.'));
      this.builtFor = '';
      this.controls = [];
      return;
    }
    const key = `${layer.id}:${layer.distribution.algo}:${layer.color.mode}`;
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

    const sections: Control[] = [
      section('Layer', [
        select<'source' | 'below'>({
          label: 'Reads from',
          options: [
            { value: 'source', label: 'Source image' },
            { value: 'below', label: 'Layers below' },
          ],
          get: () => L().input,
          set: (v) => s.updateLayer(id, { input: v }),
        }),
        select<BlendMode>({
          label: 'Blend',
          options: BLEND_MODES.map((m) => ({ value: m, label: cap(m) })),
          get: () => L().blend,
          set: (v) => s.updateLayer(id, { blend: v }),
        }),
        slider({
          label: 'Opacity', min: 0, max: 1, step: 0.01, interaction: ia,
          get: () => L().opacity,
          set: (v) => s.updateLayer(id, { opacity: v }),
        }),
      ]),

      section('Distribution', this.distributionControls(id)),

      section('Shape', [
        select({
          label: 'Shape',
          options: this.shapeOptions(),
          get: () => L().shapeId,
          set: (v) => s.updateLayer(id, { shapeId: v }),
        }),
        slider({
          label: 'Size min', min: 0, max: 60, step: 0.1, interaction: ia,
          title: 'Point size at the light end of the tone range',
          get: () => L().size.min,
          set: (v) => s.updateLayerField(id, 'size', { min: v }),
        }),
        slider({
          label: 'Size max', min: 0, max: 60, step: 0.1, interaction: ia,
          title: 'Point size at the dark end of the tone range',
          get: () => L().size.max,
          set: (v) => s.updateLayerField(id, 'size', { max: v }),
        }),
        slider({
          label: 'Size ← tone', min: 0, max: 1, step: 0.01, interaction: ia,
          title: '0 keeps every point at Size max; 1 lets tone drive size fully',
          get: () => L().size.fromTone,
          set: (v) => s.updateLayerField(id, 'size', { fromTone: v }),
        }),
        slider({
          label: 'Size jitter', min: 0, max: 1, step: 0.01, interaction: ia,
          get: () => L().size.jitter,
          set: (v) => s.updateLayerField(id, 'size', { jitter: v }),
        }),
        toggle({
          label: 'Invert size mapping',
          get: () => L().size.invert,
          set: (v) => s.updateLayerField(id, 'size', { invert: v }),
        }),
        slider({
          label: 'Rotation', min: -180, max: 180, step: 1, interaction: ia,
          get: () => L().rotation.base,
          set: (v) => s.updateLayerField(id, 'rotation', { base: v }),
        }),
        slider({
          label: 'Random rotation', min: 0, max: 1, step: 0.01, interaction: ia,
          get: () => L().rotation.random,
          set: (v) => s.updateLayerField(id, 'rotation', { random: v }),
        }),
        slider({
          label: 'Follow contours', min: 0, max: 1, step: 0.01, interaction: ia,
          title: 'Aligns shapes to the image contours — most visible with line shapes',
          get: () => L().rotation.followGradient,
          set: (v) => s.updateLayerField(id, 'rotation', { followGradient: v }),
        }),
      ]),

      section('Colour', this.colorControls(id)),

      section('Tone mask', [
        rangeControl({
          label: 'Tone window', interaction: ia,
          get: () => L().mask.toneRange,
          set: (v) => s.updateLayerField(id, 'mask', { toneRange: v }),
        }),
        slider({
          label: 'Feather', min: 0, max: 0.5, step: 0.01, interaction: ia,
          get: () => L().mask.feather,
          set: (v) => s.updateLayerField(id, 'mask', { feather: v }),
        }),
        toggle({
          label: 'Invert mask',
          get: () => L().mask.invert,
          set: (v) => s.updateLayerField(id, 'mask', { invert: v }),
        }),
      ], true),

      section('Image adjust', [
        slider({
          label: 'Brightness', min: -1, max: 1, step: 0.01, interaction: ia,
          get: () => L().prefilter.brightness,
          set: (v) => s.updateLayerField(id, 'prefilter', { brightness: v }),
        }),
        slider({
          label: 'Contrast', min: -1, max: 1, step: 0.01, interaction: ia,
          get: () => L().prefilter.contrast,
          set: (v) => s.updateLayerField(id, 'prefilter', { contrast: v }),
        }),
        slider({
          label: 'Gamma', min: 0.1, max: 4, step: 0.01, interaction: ia,
          get: () => L().prefilter.gamma,
          set: (v) => s.updateLayerField(id, 'prefilter', { gamma: v }),
        }),
        slider({
          label: 'Blur', min: 0, max: 20, step: 0.5, interaction: ia,
          get: () => L().prefilter.blur,
          set: (v) => s.updateLayerField(id, 'prefilter', { blur: v }),
        }),
        slider({
          label: 'Sharpen', min: 0, max: 1, step: 0.01, interaction: ia,
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
          label: 'Scale', min: 0.1, max: 4, step: 0.01, interaction: ia,
          get: () => L().transform.scale,
          set: (v) => s.updateLayerField(id, 'transform', { scale: v }),
        }),
        slider({
          label: 'Rotate', min: -180, max: 180, step: 1, interaction: ia,
          get: () => L().transform.rotate,
          set: (v) => s.updateLayerField(id, 'transform', { rotate: v }),
        }),
        slider({
          label: 'Offset X', min: -1000, max: 1000, step: 1, interaction: ia,
          get: () => L().transform.offsetX,
          set: (v) => s.updateLayerField(id, 'transform', { offsetX: v }),
        }),
        slider({
          label: 'Offset Y', min: -1000, max: 1000, step: 1, interaction: ia,
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

    const common = (): Control[] => [
      rangeControl({
        label: 'Tone range', interaction: ia,
        get: () => L().distribution.toneRange,
        set: (v) => s.updateLayerField(id, 'distribution', { toneRange: v } as never),
      }),
      toggle({
        label: 'Stipple the highlights instead',
        get: () => L().distribution.invertDensity,
        set: (v) => s.updateLayerField(id, 'distribution', { invertDensity: v } as never),
      }),
    ];

    const algo = L().distribution.algo;
    if (algo === 'jittered') {
      const d = (): JitteredParams => L().distribution as JitteredParams;
      return [
        algoSelect,
        slider({
          label: 'Spacing', min: 1, max: 40, step: 0.25, interaction: ia,
          title: 'Distance between candidate points, in canvas pixels',
          get: () => d().spacing,
          set: (v) => s.updateLayerField(id, 'distribution', { spacing: v } as never),
        }),
        slider({
          label: 'Phases', min: 1, max: 64, step: 1, interaction: ia,
          title: 'Number of discrete tone bands; higher is smoother',
          get: () => d().phases,
          set: (v) => s.updateLayerField(id, 'distribution', { phases: v } as never),
        }),
        slider({
          label: 'Jitter', min: 0, max: 1, step: 0.01, interaction: ia,
          get: () => d().jitter,
          set: (v) => s.updateLayerField(id, 'distribution', { jitter: v } as never),
        }),
        slider({
          label: 'Overpaint', min: 0, max: 4, step: 1, interaction: ia,
          title: 'Extra offset passes layered over the first',
          get: () => d().overpaint,
          set: (v) => s.updateLayerField(id, 'distribution', { overpaint: v } as never),
        }),
        slider({
          label: 'Seed', min: 1, max: 9999, step: 1,
          get: () => d().seed,
          set: (v) => s.updateLayerField(id, 'distribution', { seed: v } as never),
        }),
        ...common(),
      ];
    }

    if (algo === 'voronoi') {
      const d = (): VoronoiParams => L().distribution as VoronoiParams;
      return [
        algoSelect,
        slider({
          label: 'Points', min: 500, max: 200000, step: 500, interaction: ia,
          get: () => d().points,
          set: (v) => s.updateLayerField(id, 'distribution', { points: v } as never),
        }),
        slider({
          label: 'Relaxation', min: 0, max: 60, step: 1, interaction: ia,
          title: 'Lloyd iterations — higher is more evenly spaced',
          get: () => d().iterations,
          set: (v) => s.updateLayerField(id, 'distribution', { iterations: v } as never),
        }),
        slider({
          label: 'Density curve', min: 0.5, max: 4, step: 0.05, interaction: ia,
          title: 'Above 1 pushes points harder into the shadows',
          get: () => d().gamma,
          set: (v) => s.updateLayerField(id, 'distribution', { gamma: v } as never),
        }),
        slider({
          label: 'Seed', min: 1, max: 9999, step: 1,
          get: () => d().seed,
          set: (v) => s.updateLayerField(id, 'distribution', { seed: v } as never),
        }),
        ...common(),
      ];
    }

    const d = (): HalftoneParams => L().distribution as HalftoneParams;
    return [
      algoSelect,
      slider({
        label: 'Lineature', min: 5, max: 200, step: 1, interaction: ia,
        title: 'Lines per inch, relative to the canvas DPI',
        get: () => d().lineature,
        set: (v) => s.updateLayerField(id, 'distribution', { lineature: v } as never),
      }),
      slider({
        label: 'Screen angle', min: -180, max: 180, step: 0.5, interaction: ia,
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
      ...common(),
    ];
  }

  private colorControls(id: string): Control[] {
    const s = this.store;
    const ia = this.interaction;
    const L = (): Layer => s.layer(id)!;
    const mode = L().color.mode;

    const controls: Control[] = [
      select<'solid' | 'adaptive' | 'image' | 'multicolor'>({
        label: 'Mode',
        options: [
          { value: 'solid', label: 'Solid' },
          { value: 'adaptive', label: 'Adaptive (hue ← tone)' },
          { value: 'image', label: 'Sample image' },
          { value: 'multicolor', label: 'Multicolour' },
        ],
        get: () => L().color.mode,
        set: (v) => s.updateLayerField(id, 'color', { mode: v }),
      }),
    ];

    if (mode === 'solid') {
      controls.push(colorControl({
        label: 'Colour', interaction: ia,
        get: () => L().color.color,
        set: (v) => s.updateLayerField(id, 'color', { color: v }),
      }));
    }

    if (mode === 'adaptive') {
      controls.push(
        slider({
          label: 'Hue (dark)', min: 0, max: 360, step: 1, interaction: ia,
          get: () => L().color.hueA,
          set: (v) => s.updateLayerField(id, 'color', { hueA: v }),
        }),
        slider({
          label: 'Hue (light)', min: 0, max: 360, step: 1, interaction: ia,
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
          label: `Palette ${i + 1}`, interaction: ia,
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
        label: 'Opacity', min: 0, max: 1, step: 0.01, interaction: ia,
        get: () => L().color.alpha,
        set: (v) => s.updateLayerField(id, 'color', { alpha: v }),
      }),
      slider({
        label: 'Colour jitter', min: 0, max: 1, step: 0.01, interaction: ia,
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
