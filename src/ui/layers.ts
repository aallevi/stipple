import { defaultLayer, uid } from '../core/defaults';
import type { Store } from '../core/store';
import type { Layer } from '../core/types';
import { button, h } from './controls';
import { buildSeparation, SEPARATIONS } from './separations';

const RESTORE = '__restore';

/**
 * The layer stack.
 *
 * Rendered top-first, the way every compositing tool shows it, while the project
 * stores bottom-first — the index flip lives here so nothing else has to think
 * about it. `slotToIndex` is that flip, and it is the only place the two orders
 * are allowed to meet.
 */
export class LayersPanel {
  readonly el = h('div', { class: 'layers' });
  private list = h('div', { class: 'layer-list' });
  /** The line showing where a dragged row would land. */
  private marker = h('div', { class: 'layer-drop-marker' });
  selected: string | null = null;
  /**
   * The stack as it was before the first separation, so there is a way back
   * that does not depend on undo. Undo gets there too, but only by also
   * unwinding every edit made to the plates since — and nothing on screen
   * says it would work at all.
   */
  private beforeSeparation: Layer[] | null = null;
  private refreshSeparateMenu: () => void = () => {};

  constructor(private store: Store, private onSelect: (id: string) => void) {
    this.el.append(
      h('div', { class: 'panel-head' },
        h('span', {}, 'Layers'),
        h('div', { class: 'panel-actions' },
          button('↑', () => this.nudge(1), 'icon', 'Move the selected layer up the stack (⌘])'),
          button('↓', () => this.nudge(-1), 'icon', 'Move the selected layer down the stack (⌘[)'),
          button('+', () => this.add(), 'icon', 'Add a layer'),
          button('⧉', () => this.duplicate(), 'icon', 'Duplicate the selected layer'),
          button('−', () => this.remove(), 'icon', 'Delete the selected layer'),
        ),
      ),
      this.separateMenu(),
      this.list,
    );
    this.list.append(this.marker);
  }

  /**
   * Move the selected layer one place through the stack. `+1` is up — towards
   * the top of the panel, which is the *end* of the project array.
   */
  nudge(delta: number): void {
    const layers = this.store.get().layers;
    const from = layers.findIndex((l) => l.id === this.selected);
    if (from < 0) return;
    const to = from + delta;
    if (to < 0 || to >= layers.length) return;
    // `moveLayer` takes an insertion point in the list as it stands, so stepping
    // up means naming the slot one past the neighbour being passed.
    this.store.moveLayer(this.selected!, delta > 0 ? to + 1 : to);
    this.render();
  }

  /**
   * The project index an insertion slot in the *displayed* list refers to.
   *
   * Slot `k` means "above the k-th row from the top". The panel runs top-first
   * and the project bottom-first, so the two count in opposite directions and
   * the flip is a subtraction.
   */
  private slotToIndex(slot: number, count: number): number {
    return count - slot;
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
    const options = (): void => {
      sel.replaceChildren(h('option', { value: '' }, 'Separate into inks…'));
      if (this.beforeSeparation) {
        sel.append(h('option', { value: RESTORE },
          `↩ Back to the ${this.beforeSeparation.length}-layer stack from before`));
      }
      for (const [key, kind] of Object.entries(SEPARATIONS)) {
        sel.append(h('option', { value: key }, kind.label));
      }
    };
    this.refreshSeparateMenu = options;
    options();

    sel.addEventListener('change', () => {
      const choice = sel.value;
      sel.value = '';
      if (choice === RESTORE) {
        if (!this.beforeSeparation) return;
        this.store.replaceLayers(this.beforeSeparation);
        this.beforeSeparation = null;
      } else {
        const kind = SEPARATIONS[choice];
        if (!kind) return;
        const project = this.store.get();
        // Keep the first stack only: separating CMYK and then trying duotone
        // should still lead back to the picture you started from, not to the
        // CMYK plates.
        if (!this.beforeSeparation) this.beforeSeparation = structuredClone(project.layers);
        this.store.replaceLayers(buildSeparation(kind, project.canvas));
      }
      options();
      this.render();
      this.select(this.store.get().layers[this.store.get().layers.length - 1].id);
    });
    return h('div', { class: 'separate-row' }, sel);
  }

  /**
   * Drop the remembered pre-separation stack, for when the document is replaced
   * wholesale (a preset, a loaded project) and that stack no longer belongs to it.
   */
  forgetSeparation(): void {
    this.beforeSeparation = null;
    this.refreshSeparateMenu();
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
        'data-id': layer.id,
      },
        h('span', { class: 'layer-grip', title: 'Drag to reorder' }, '⠿'),
        visible,
        name,
        h('span', { class: 'layer-meta' },
          `${algoLabel(layer.distribution.algo)}${layer.input === 'below' ? ' · below' : ''}`),
      );
      row.addEventListener('click', () => this.select(layer.id));
      row.addEventListener('pointerdown', (e) => this.beginDrag(e, layer.id, row));

      return row;
    });

    this.list.replaceChildren(...rows, this.marker);
    this.marker.style.display = 'none';
  }

  /**
   * Reorder by pointer rather than by HTML5 drag-and-drop.
   *
   * The `dragstart`/`drop` pair this replaces never fired in the desktop app at
   * all: the macOS webview hands drag gestures to the native file-drop handler
   * before the page sees them, so the rows were draggable in a browser tab and
   * inert in the shipped build — which is where the stack is actually used.
   * Pointer events have no such owner, so this works in both, and it can show a
   * real insertion line instead of highlighting a row and hoping.
   */
  private beginDrag(e: PointerEvent, id: string, row: HTMLElement): void {
    // The name field has to keep its own click-to-edit and drag-to-select.
    if ((e.target as HTMLElement).closest('input, button')) return;
    if (e.button !== 0) return;

    const startY = e.clientY;
    let dragging = false;
    let slot = -1;

    const move = (ev: PointerEvent): void => {
      if (!dragging) {
        // A few pixels of slop, so a click that wobbles still selects rather
        // than starting a move nobody asked for.
        if (Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
        row.setPointerCapture(ev.pointerId);
        row.classList.add('dragging');
      }
      slot = this.slotAt(ev.clientY);
      this.showMarker(slot);
    };

    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!dragging) return;
      row.releasePointerCapture?.(ev.pointerId);
      row.classList.remove('dragging');
      this.marker.style.display = 'none';
      if (slot >= 0) {
        this.store.moveLayer(id, this.slotToIndex(slot, this.store.get().layers.length));
        this.select(id);
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** Which insertion slot a pointer at `clientY` is nearest. */
  private slotAt(clientY: number): number {
    const rows = [...this.list.querySelectorAll<HTMLElement>('.layer-row')];
    for (let i = 0; i < rows.length; i++) {
      const box = rows[i].getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return i;
    }
    return rows.length;
  }

  /** Park the insertion line at the top edge of the row that slot sits above. */
  private showMarker(slot: number): void {
    const rows = [...this.list.querySelectorAll<HTMLElement>('.layer-row')];
    const listBox = this.list.getBoundingClientRect();
    const edge = slot < rows.length
      ? rows[slot].getBoundingClientRect().top
      : rows[rows.length - 1].getBoundingClientRect().bottom;
    this.marker.style.display = 'block';
    this.marker.style.top = `${edge - listBox.top + this.list.scrollTop}px`;
  }
}

function algoLabel(algo: string): string {
  return algo === 'jittered' ? 'Stochastic' : algo === 'voronoi' ? 'Voronoi' : 'Halftone';
}
