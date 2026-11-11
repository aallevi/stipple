import { defaultLayer, uid } from '../core/defaults';
import { groupMembers, groupSpan } from '../core/groups';
import type { Store } from '../core/store';
import type { Layer, LayerGroup } from '../core/types';
import { button, h } from './controls';

/**
 * The layer stack, with groups.
 *
 * Rendered top-first, the way every compositing tool shows it, while the project
 * stores bottom-first — the index flip lives here so nothing else has to think
 * about it.
 *
 * A group is a folder row above its layers. Selecting the folder edits all of
 * its layers at once (the store fans the edit out, sparing what makes each one
 * that colour); selecting a layer inside edits only that layer. That is the
 * whole of "edit together or alone" — there is no separate switch for it.
 */
export class LayersPanel {
  readonly el = h('div', { class: 'layers' });
  private list = h('div', { class: 'layer-list' });
  /** The line showing where a dragged row would land. */
  private marker = h('div', { class: 'layer-drop-marker' });
  /** The layer the inspector shows. With a group selected, its top layer. */
  selected: string | null = null;
  /** The selected group, when it is the folder rather than a layer that is selected. */
  selectedGroup: string | null = null;
  /**
   * Layers picked together with ⌘- or shift-click. Two or more of them act as
   * one selection: the inspector shows `selected`, edits reach them all, and
   * they can be grouped or deleted at once. Empty for a single selection.
   */
  private picked = new Set<string>();
  /** Where a shift-click range starts. */
  private anchor: string | null = null;
  /** Says, while a group is selected, that edits reach all of it. */
  private groupNote = h('p', { class: 'link-note', hidden: '' });
  constructor(
    private store: Store,
    private onSelect: (id: string) => void,
  ) {
    this.el.append(
      h('div', { class: 'panel-head' },
        h('span', {}, 'Layers'),
        h('div', { class: 'panel-actions' },
          button('↑', () => this.nudge(1), 'icon', 'Move the selected layer or group up the stack (⌘])'),
          button('↓', () => this.nudge(-1), 'icon', 'Move the selected layer or group down the stack (⌘[)'),
          button('+', () => this.add(), 'icon', 'Add a layer'),
          button('⧉', () => this.duplicate(), 'icon', 'Duplicate the selected layer or group'),
          button('⊞', () => this.groupPicked(), 'icon', 'Group the selected layers (⌘G) — ⌘-click or shift-click to select several'),
          button('−', () => this.remove(), 'icon', 'Delete the selected layers or group'),
        ),
      ),
      this.list,
      h('div', { class: 'link-row' }, this.groupNote),
    );
    this.list.append(this.marker);
  }

  /**
   * Move the selection one place through the stack. `+1` is up — towards the
   * top of the panel, which is the *end* of the project array. A layer stepping
   * into a group joins it and stepping out leaves it; a group steps past the
   * whole layer or group next to it.
   */
  nudge(delta: number): void {
    if (this.selectedGroup) {
      this.store.nudgeGroup(this.selectedGroup, delta);
      this.render();
      return;
    }
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

  add(): void {
    const layers = this.store.get().layers;
    const layer = defaultLayer(`Stipple ${layers.length + 1}`);
    this.store.addLayer(layer);
    this.select(layer.id);
  }

  duplicate(): void {
    const project = this.store.get();
    if (this.selectedGroup) {
      const span = groupSpan(project, this.selectedGroup);
      const g = this.store.group(this.selectedGroup);
      if (!span || !g) return;
      const copy: LayerGroup = { id: uid('group'), name: `${g.name} copy`, collapsed: false };
      const layers = groupMembers(project, g.id).map((l) => ({ ...clone(l), id: uid('layer'), groupId: copy.id }));
      const next = [...project.layers.slice(0, span[1] + 1), ...layers, ...project.layers.slice(span[1] + 1)];
      this.store.replaceLayers(next, [...(project.groups ?? []), copy]);
      this.selectGroup(copy.id);
      return;
    }
    if (!this.selected) return;
    const src = this.store.layer(this.selected);
    if (!src) return;
    const copy: Layer = { ...clone(src), id: uid('layer'), name: `${src.name} copy` };
    const idx = project.layers.findIndex((l) => l.id === src.id);
    this.store.addLayer(copy, idx + 1);
    this.select(copy.id);
  }

  remove(): void {
    const layers = this.store.get().layers;
    if (this.picked.size > 1) {
      const ids = [...this.picked];
      if (ids.length >= layers.length) return;
      if (!confirm(`Delete these ${ids.length} layers?`)) return;
      const idx = layers.findIndex((l) => l.id === this.selected);
      this.store.removeLayers(ids);
      const left = this.store.get().layers;
      this.select(left[Math.min(Math.max(0, idx - ids.length + 1), left.length - 1)]?.id ?? null);
      return;
    }
    if (this.selectedGroup) {
      const g = this.store.group(this.selectedGroup);
      const n = groupMembers(this.store.get(), this.selectedGroup).length;
      if (!g || n >= layers.length) return;
      if (!confirm(`Delete the group “${g.name}” and its ${n} layers?`)) return;
      this.store.removeGroup(g.id);
      this.select(this.store.get().layers[this.store.get().layers.length - 1]?.id ?? null);
      return;
    }
    if (!this.selected || layers.length <= 1) return;
    const idx = layers.findIndex((l) => l.id === this.selected);
    this.store.removeLayer(this.selected);
    const next = this.store.get().layers[Math.min(idx, this.store.get().layers.length - 1)];
    this.select(next?.id ?? null);
  }

  /** Put the picked layers into a new group, closing up any gaps between them. */
  groupPicked(): void {
    const ids = this.picked.size > 1 ? [...this.picked] : [];
    if (!ids.length) return;
    const group: LayerGroup = { id: uid('group'), name: `Group ${(this.store.get().groups?.length ?? 0) + 1}`, collapsed: false };
    this.store.groupLayers(ids, group);
    this.selectGroup(group.id);
  }

  /**
   * A click on a layer row, read the way a file list reads it: plain picks
   * one, ⌘ adds or removes one, shift takes the run from the last one picked.
   */
  private clickLayer(id: string, e: MouseEvent): void {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta && !e.shiftKey) return this.select(id);
    if (!this.picked.size) {
      // Start from what is selected now: a layer, or every layer of a group.
      if (this.selectedGroup) for (const l of groupMembers(this.store.get(), this.selectedGroup)) this.picked.add(l.id);
      else if (this.selected) this.picked.add(this.selected);
    }
    if (e.shiftKey && this.anchor) {
      const shown = [...this.list.querySelectorAll<HTMLElement>('.layer-row[data-id]')].map((r) => r.dataset.id!);
      const a = shown.indexOf(this.anchor);
      const b = shown.indexOf(id);
      if (a >= 0 && b >= 0) for (const x of shown.slice(Math.min(a, b), Math.max(a, b) + 1)) this.picked.add(x);
      else this.picked.add(id);
    } else if (this.picked.has(id) && this.picked.size > 1) {
      this.picked.delete(id);
      if (this.selected === id) id = [...this.picked][this.picked.size - 1];
    } else {
      this.picked.add(id);
      this.anchor = id;
    }
    if (this.picked.size < 2) return this.select([...this.picked][0] ?? id);
    holdScroll(this.list, () => {
      this.selectedGroup = null;
      this.selected = id;
      this.onSelect(id);
      this.render();
    });
  }

  /** ⌘-click on a folder row: add or remove all of its layers. */
  private clickGroup(gid: string, e: MouseEvent): void {
    if (!(e.metaKey || e.ctrlKey || e.shiftKey)) return this.selectGroup(gid);
    const members = groupMembers(this.store.get(), gid);
    if (!members.length) return;
    if (!this.picked.size) {
      if (this.selectedGroup) for (const l of groupMembers(this.store.get(), this.selectedGroup)) this.picked.add(l.id);
      else if (this.selected) this.picked.add(this.selected);
    }
    const all = members.every((l) => this.picked.has(l.id));
    for (const l of members) all ? this.picked.delete(l.id) : this.picked.add(l.id);
    if (this.picked.size < 2) return this.select([...this.picked][0] ?? members[members.length - 1].id);
    const keep = this.picked.has(this.selected ?? '') ? this.selected! : [...this.picked][this.picked.size - 1];
    holdScroll(this.list, () => {
      this.selectedGroup = null;
      this.selected = keep;
      this.onSelect(keep);
      this.render();
    });
  }

  select(id: string | null): void {
    holdScroll(this.list, () => {
      this.picked.clear();
      this.anchor = id;
      this.selected = id;
      this.selectedGroup = null;
      this.store.scope = null;
      if (id) this.onSelect(id);
      this.render();
    });
  }

  /**
   * Select a group as a whole. The inspector shows its top layer, and every
   * edit made there reaches all of the group's layers.
   */
  selectGroup(id: string): void {
    const members = groupMembers(this.store.get(), id);
    if (!members.length) return this.select(null);
    holdScroll(this.list, () => {
      this.picked.clear();
      this.selectedGroup = id;
      this.selected = members[members.length - 1].id;
      this.store.scope = members.map((l) => l.id);
      this.onSelect(this.selected);
      this.render();
    });
  }

  render(): void {
    holdScroll(this.list, () => this.build());
  }

  private build(): void {
    const project = this.store.get();
    const layers = project.layers;

    // Keep the selection meaningful across undo, deletes and moves.
    if (this.selectedGroup && !groupMembers(project, this.selectedGroup).length) this.selectedGroup = null;
    if (this.selectedGroup) {
      const members = groupMembers(project, this.selectedGroup);
      this.store.scope = members.map((l) => l.id);
      if (!members.some((l) => l.id === this.selected)) {
        this.selected = members[members.length - 1].id;
        this.onSelect(this.selected);
      }
    } else {
      for (const id of [...this.picked]) if (!layers.some((l) => l.id === id)) this.picked.delete(id);
      if (this.picked.size < 2) this.picked.clear();
      this.store.scope = this.picked.size ? [...this.picked] : null;
    }
    if (this.selected && !layers.some((l) => l.id === this.selected)) {
      this.selected = layers[layers.length - 1]?.id ?? null;
      if (this.selected) this.onSelect(this.selected);
    }

    const g = this.selectedGroup ? this.store.group(this.selectedGroup) : undefined;
    const many = this.picked.size;
    this.groupNote.hidden = !g && !many;
    this.groupNote.parentElement?.toggleAttribute('hidden', !g && !many);
    if (many) {
      this.groupNote.textContent = `${many} layers selected — edits reach all of them, each keeping its own `
        + 'colour, screen angle and seed. ⌘G groups them; − deletes them.';
    } else if (g) {
      const n = groupMembers(project, g.id).length;
      this.groupNote.textContent = `Editing all ${n} layers of “${g.name}” together — each keeps its own `
        + 'colour, screen angle and seed. Select one layer to change it alone.';
    }

    const rows: HTMLElement[] = [];
    const headed = new Set<string>();
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const group = layer.groupId ? this.store.group(layer.groupId) : undefined;
      if (group && !headed.has(group.id)) {
        headed.add(group.id);
        rows.push(this.groupRow(group));
      }
      if (group?.collapsed) continue;
      rows.push(this.layerRow(layer, i, !!group));
    }

    this.list.replaceChildren(...rows, this.marker);
    this.marker.style.display = 'none';
  }

  private groupRow(group: LayerGroup): HTMLElement {
    const project = this.store.get();
    const members = groupMembers(project, group.id);
    const anyVisible = members.some((l) => l.visible);
    const span = groupSpan(project, group.id)!;

    const fold = h('button', {
      class: `group-fold${group.collapsed ? ' folded' : ''}`, type: 'button',
      title: group.collapsed ? 'Show the layers in this group' : 'Fold the group',
    });
    fold.addEventListener('click', (e) => {
      e.stopPropagation();
      this.store.updateGroup(group.id, { collapsed: !group.collapsed });
      this.render();
    });

    const visible = h('button', {
      class: `vis${anyVisible ? '' : ' off'}`, type: 'button',
      title: anyVisible ? 'Hide the group' : 'Show the group',
    }, anyVisible ? '●' : '○');
    visible.addEventListener('click', (e) => {
      e.stopPropagation();
      this.store.setGroupVisible(group.id, !anyVisible);
      this.render();
    });

    const name = h('input', { class: 'layer-name' }) as HTMLInputElement;
    name.value = group.name;
    name.addEventListener('change', () => this.store.updateGroup(group.id, { name: name.value }));
    this.selectThenRename(name, () => this.selectedGroup === group.id, () => this.selectGroup(group.id));

    const ungroup = h('button', { class: 'group-ungroup', type: 'button', title: 'Ungroup — keep the layers, drop the folder' }, '⇱');
    ungroup.addEventListener('click', (e) => {
      e.stopPropagation();
      this.store.ungroup(group.id);
      this.select(this.selected);
    });

    const row = h('div', {
      class: `layer-row group-row${this.selectedGroup === group.id ? ' selected' : ''}`,
      'data-top': String(span[1]), 'data-bottom': String(span[0]), 'data-group': group.id,
    },
      h('span', { class: 'layer-grip', title: 'Drag to move the whole group' }, '⠿'),
      h('span', { class: 'group-lead' }, fold, visible),
      name,
      h('span', { class: 'layer-meta' }, `${members.length} layers`, ungroup),
    );
    row.addEventListener('click', (e) => this.clickGroup(group.id, e));
    row.addEventListener('pointerdown', (e) => this.beginDrag(e, row, { group: group.id }));
    return row;
  }

  private layerRow(layer: Layer, index: number, inGroup: boolean): HTMLElement {
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

    const name = h('input', { class: 'layer-name' }) as HTMLInputElement;
    name.value = layer.name;
    name.addEventListener('change', () => this.store.updateLayer(layer.id, { name: name.value }));
    this.selectThenRename(name, () => layer.id === this.selected && !this.selectedGroup && !this.picked.size, () => this.select(layer.id));

    // A colour layer shows its colour, so a group of them reads as a palette.
    const chip = layer.color.mode === 'solid'
      ? h('span', { class: 'layer-chip', style: `background: ${css(layer.color.color)}` })
      : null;

    const selected = this.picked.size ? this.picked.has(layer.id) : layer.id === this.selected && !this.selectedGroup;
    const row = h('div', {
      class: `layer-row${inGroup ? ' in-group' : ''}${selected ? ' selected' : ''}`,
      'data-top': String(index), 'data-bottom': String(index), 'data-group-of': layer.groupId ?? '',
      'data-id': layer.id,
    },
      h('span', { class: 'layer-grip', title: 'Drag to reorder' }, '⠿'),
      visible,
      name,
      h('span', { class: 'layer-meta' }, ...(chip ? [chip] : []),
        `${algoLabel(layer.distribution.algo)}${layer.input === 'below' ? ' · below' : ''}`),
    );
    row.addEventListener('click', (e) => this.clickLayer(layer.id, e));
    row.addEventListener('pointerdown', (e) => this.beginDrag(e, row, { layer: layer.id }));
    return row;
  }

  /**
   * A row's name is most of the row, so clicking it has to select the row; it
   * renames only once the row is already selected — the way a file's name
   * behaves in a file browser.
   */
  private selectThenRename(name: HTMLInputElement, isSelected: () => boolean, select: () => void): void {
    name.readOnly = !isSelected();
    name.addEventListener('pointerdown', (e) => {
      // With a modifier the row's own click decides (add to the selection).
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        e.preventDefault();
        return;
      }
      if (isSelected()) return;
      e.preventDefault();
      select();
    });
    name.addEventListener('click', (e) => {
      if (isSelected() && !(e.metaKey || e.ctrlKey || e.shiftKey)) e.stopPropagation();
    });
  }

  /**
   * Reorder by pointer rather than by HTML5 drag-and-drop.
   *
   * The `dragstart`/`drop` pair this replaces never fired in the desktop app at
   * all: the macOS webview hands drag gestures to the native file-drop handler
   * before the page sees them. Pointer events have no such owner, so this works
   * in both, and it can show a real insertion line instead of highlighting a row.
   */
  private beginDrag(e: PointerEvent, row: HTMLElement, what: { layer?: string; group?: string }): void {
    // The name field has to keep its own click-to-edit and drag-to-select.
    if ((e.target as HTMLElement).closest('input, button')) return;
    if (e.button !== 0) return;
    // Claim the press. Left to the browser it starts a text selection, which
    // then follows the pointer across every label in the sidebar and drags
    // the sidebar's scroll along with it.
    e.preventDefault();

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
        document.documentElement.classList.add('reordering');
        getSelection()?.removeAllRanges();
      }
      slot = this.slotAt(ev.clientY);
      this.showMarker(slot);
    };

    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('reordering');
      if (!dragging) return;
      row.releasePointerCapture?.(ev.pointerId);
      row.classList.remove('dragging');
      this.marker.style.display = 'none';
      if (slot < 0) return;
      const drop = this.dropAt(slot);
      if (what.group) {
        this.store.moveGroup(what.group, drop.index);
        this.selectGroup(what.group);
      } else if (what.layer) {
        this.store.moveLayer(what.layer, drop.index, drop.into);
        this.select(what.layer);
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /**
   * What dropping into a displayed slot means for the stack.
   *
   * Slot `k` is "above the k-th row from the top". Each row carries the project
   * indices it spans — a single layer, or a whole group for a folder row — so
   * above a row means just after its topmost layer, and below the last row
   * means just before its bottommost. The one slot that needs saying out loud
   * is directly under an open folder's row: that is the top of the group, and
   * a layer dropped there joins it.
   */
  private dropAt(slot: number): { index: number; into: string | null } {
    const rows = [...this.list.querySelectorAll<HTMLElement>('.layer-row')];
    if (!rows.length) return { index: 0, into: null };
    if (slot >= rows.length) return { index: Number(rows[rows.length - 1].dataset.bottom), into: null };
    const row = rows[slot];
    const prev = rows[slot - 1];
    // A drop says exactly where it lands, rather than leaving the store to
    // guess from neighbours: between two of a group's layers, or just under
    // its folder row, is inside it; every other line is outside, including
    // the one just under a group's last layer.
    const inside = row.dataset.groupOf
      && (prev?.dataset.group === row.dataset.groupOf || prev?.dataset.groupOf === row.dataset.groupOf);
    return { index: Number(row.dataset.top) + 1, into: inside ? row.dataset.groupOf! : null };
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

function clone<T>(v: T): T {
  // Structured clone keeps nested params independent; a shallow copy would
  // leave two layers sharing prefilter and colour objects.
  return JSON.parse(JSON.stringify(v)) as T;
}

function css(c: [number, number, number, number]): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

function algoLabel(algo: string): string {
  return algo === 'jittered' ? 'Stochastic' : algo === 'voronoi' ? 'Voronoi' : 'Halftone';
}

/**
 * Run `fn` without moving the sidebar.
 *
 * Selecting a layer rebuilds the list and the inspector under it; while the
 * new nodes go in, the sidebar's content is momentarily a different height and
 * the browser clamps its scroll position to fit. Put back afterwards, the
 * panel stays where it was being read.
 */
export function holdScroll(inside: HTMLElement, fn: () => void): void {
  const scroller = inside.closest<HTMLElement>('.sidebar');
  const top = scroller?.scrollTop ?? 0;
  fn();
  if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
}
