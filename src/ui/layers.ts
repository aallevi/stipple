import { defaultLayer, uid } from '../core/defaults';
import type { Store } from '../core/store';
import type { Layer } from '../core/types';
import { button, h } from './controls';
import { buildSeparation, SEPARATIONS } from './separations';

/**
 * The layer stack.
 *
 * Rendered top-first, the way every compositing tool shows it, while the project
 * stores bottom-first — the index flip lives here so nothing else has to think
 * about it.
 */
export class LayersPanel {
  readonly el = h('div', { class: 'layers' });
  private list = h('div', { class: 'layer-list' });
  selected: string | null = null;

  constructor(private store: Store, private onSelect: (id: string) => void) {
    this.el.append(
      h('div', { class: 'panel-head' },
        h('span', {}, 'Layers'),
        h('div', { class: 'panel-actions' },
          button('+', () => this.add(), 'icon', 'Add a layer'),
          button('⧉', () => this.duplicate(), 'icon', 'Duplicate the selected layer'),
          button('−', () => this.remove(), 'icon', 'Delete the selected layer'),
        ),
      ),
      this.separateMenu(),
      this.list,
    );
  }

  /**
   * Replace the stack with one layer per ink.
   *
   * This is a whole-stack operation rather than a per-layer setting because a
   * separation only means anything as a set: the plates have to agree on their
   * screen angles and on which one carries the neutrals, and choosing that ink
   * by ink is how you end up with a moiré.
   */
  private separateMenu(): HTMLElement {
    const sel = h('select', { class: 'separate-select' }) as HTMLSelectElement;
    sel.append(h('option', { value: '' }, 'Separate into inks…'));
    for (const [key, kind] of Object.entries(SEPARATIONS)) {
      sel.append(h('option', { value: key }, kind.label));
    }
    sel.addEventListener('change', () => {
      const kind = SEPARATIONS[sel.value];
      sel.value = '';
      if (!kind) return;
      const project = this.store.get();
      if (project.layers.length > 1 || project.layers[0]?.prefilter.channel === 'ink') {
        if (!confirm(`Replace the current ${project.layers.length}-layer stack with ` +
          `${kind.inks.length} ink plates?`)) return;
      }
      this.store.replaceLayers(buildSeparation(kind, project.canvas));
      this.render();
      this.select(this.store.get().layers[this.store.get().layers.length - 1].id);
    });
    return h('div', { class: 'separate-row' }, sel);
  }

  add(): void {
    const layers = this.store.get().layers;
    const layer = defaultLayer(`Stipple ${layers.length + 1}`);
    this.store.addLayer(layer);
    this.select(layer.id);
  }

  duplicate(): void {
    if (!this.selected) return;
    const src = this.store.layer(this.selected);
    if (!src) return;
    // Structured clone keeps nested params independent; a shallow copy would
    // leave the two layers sharing prefilter and colour objects.
    const copy: Layer = { ...JSON.parse(JSON.stringify(src)), id: uid('layer'), name: `${src.name} copy` };
    const idx = this.store.get().layers.findIndex((l) => l.id === src.id);
    this.store.addLayer(copy, idx + 1);
    this.select(copy.id);
  }

  remove(): void {
    if (!this.selected) return;
    const layers = this.store.get().layers;
    if (layers.length <= 1) return;
    const idx = layers.findIndex((l) => l.id === this.selected);
    this.store.removeLayer(this.selected);
    const next = this.store.get().layers[Math.min(idx, this.store.get().layers.length - 1)];
    this.select(next?.id ?? null);
  }

  select(id: string | null): void {
    this.selected = id;
    if (id) this.onSelect(id);
    this.render();
  }

  render(): void {
    const layers = this.store.get().layers;
    if (this.selected && !layers.some((l) => l.id === this.selected)) {
      this.selected = layers[layers.length - 1]?.id ?? null;
      if (this.selected) this.onSelect(this.selected);
    }

    const rows = [...layers].reverse().map((layer) => {
      const visible = h('button', {
        class: `vis${layer.visible ? '' : ' off'}`,
        type: 'button',
        title: layer.visible ? 'Hide layer' : 'Show layer',
      }, layer.visible ? '●' : '○');
      visible.addEventListener('click', (e) => {
        e.stopPropagation();
        this.store.updateLayer(layer.id, { visible: !layer.visible });
        this.render();
      });

      const name = h('input', { class: 'layer-name', value: layer.name }) as HTMLInputElement;
      name.value = layer.name;
      name.addEventListener('change', () => this.store.updateLayer(layer.id, { name: name.value }));
      name.addEventListener('click', (e) => e.stopPropagation());

      const row = h('div', {
        class: `layer-row${layer.id === this.selected ? ' selected' : ''}`,
        draggable: 'true',
        'data-id': layer.id,
      },
        visible,
        name,
        h('span', { class: 'layer-meta' },
          `${algoLabel(layer.distribution.algo)}${layer.input === 'below' ? ' · below' : ''}`),
      );
      row.addEventListener('click', () => this.select(layer.id));

      row.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', layer.id);
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop-target');
        const dragged = e.dataTransfer?.getData('text/plain');
        if (!dragged || dragged === layer.id) return;
        // The visual list is reversed, so dropping onto a row means taking that
        // row's position in project order.
        const target = this.store.get().layers.findIndex((l) => l.id === layer.id);
        this.store.moveLayer(dragged, target);
        this.render();
      });

      return row;
    });

    this.list.replaceChildren(...rows);
  }
}

function algoLabel(algo: string): string {
  return algo === 'jittered' ? 'Stochastic' : algo === 'voronoi' ? 'Voronoi' : 'Halftone';
}
