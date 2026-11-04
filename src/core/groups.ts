import type { Layer, LayerGroup, Project } from './types';

/**
 * Keep every group one unbroken run of the stack, and drop what no longer
 * makes sense.
 *
 * Groups are not a tree here: a layer carries the id of the group it is in,
 * and the stack stays flat. That keeps rendering, undo, saving and every
 * exporter exactly as they were — none of them need to know groups exist. The
 * price is that a move can leave a group in two pieces, so after any change to
 * the stack this decides what that meant: the longest piece is the group, and
 * the layers stranded outside it have left it. Empty groups disappear, and so
 * do memberships of groups that do not exist.
 *
 * Mutates and returns `project`.
 */
export function tidyGroups(project: Project): Project {
  const groups = project.groups ?? [];
  const known = new Set(groups.map((g) => g.id));
  const layers = project.layers;
  for (const l of layers) if (l.groupId && !known.has(l.groupId)) delete l.groupId;

  for (const g of groups) {
    // Runs of consecutive members, as [start, end] inclusive.
    const runs: [number, number][] = [];
    layers.forEach((l, i) => {
      if (l.groupId !== g.id) return;
      const last = runs[runs.length - 1];
      if (last && last[1] === i - 1) last[1] = i;
      else runs.push([i, i]);
    });
    if (runs.length <= 1) continue;
    let keep = runs[0];
    for (const r of runs) if (r[1] - r[0] > keep[1] - keep[0]) keep = r;
    layers.forEach((l, i) => {
      if (l.groupId === g.id && (i < keep[0] || i > keep[1])) delete l.groupId;
    });
  }

  project.groups = groups.filter((g) => layers.some((l) => l.groupId === g.id));
  return project;
}

/** The layers of a group, bottom first, as the stack stores them. */
export function groupMembers(project: Project, groupId: string): Layer[] {
  return project.layers.filter((l) => l.groupId === groupId);
}

/** Where a group sits: the indices of its first and last layer. */
export function groupSpan(project: Project, groupId: string): [number, number] | null {
  const first = project.layers.findIndex((l) => l.groupId === groupId);
  if (first < 0) return null;
  let last = first;
  while (last + 1 < project.layers.length && project.layers[last + 1].groupId === groupId) last += 1;
  return [first, last];
}

export function findGroup(project: Project, groupId: string | undefined): LayerGroup | undefined {
  return groupId ? project.groups?.find((g) => g.id === groupId) : undefined;
}
