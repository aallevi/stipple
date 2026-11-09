import type { HalftoneParams, Layer } from './types';

/**
 * Screen angles, absolute or relative to another screen.
 *
 * A halftone's `angle` is absolute — degrees from horizontal — unless its
 * `angleFrom` names another halftone layer, in which case it is an offset from
 * wherever that screen is. Turn the reference and every screen that follows it
 * turns too, keeping exactly the angles between them; that is how a set of
 * plates is aligned as a set, and still lets any one plate sit at an exact
 * absolute angle when it has to.
 */

const halftone = (l: Layer | undefined): HalftoneParams | null =>
  l && l.distribution.algo === 'halftone' ? l.distribution : null;

/** Where a screen actually points, in degrees from horizontal, following its chain of references. */
export function screenAngle(layer: Layer, layers: readonly Layer[]): number {
  let total = 0;
  let cur: Layer | undefined = layer;
  const seen = new Set<string>();
  while (cur) {
    const d = halftone(cur);
    if (!d) break;
    total += d.angle;
    // A reference that has gone, or stopped being a halftone, or loops back on
    // itself, ends the chain: the offset is then read as absolute.
    if (!d.angleFrom || seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = layers.find((l) => l.id === d.angleFrom);
    if (cur && seen.has(cur.id)) break;
  }
  return total;
}

/**
 * The angle after which a lattice looks the same again: a square grid turned
 * 90° is the same grid, a hexagonal one turned 60°, a line screen turned 180°.
 */
export function screenPeriod(lattice: HalftoneParams['lattice']): number {
  return lattice === 'hex' ? 60 : lattice === 'line' ? 180 : 90;
}

/** `a` folded into one period, as the smallest equivalent angle in [0, period). */
export function foldAngle(a: number, period: number): number {
  const r = a % period;
  return Math.abs(r) < 1e-9 ? 0 : r < 0 ? r + period : r;
}

/** How far apart two screens of one lattice really are: the difference folded into (-period/2, period/2]. */
export function angleBetween(a: number, b: number, period: number): number {
  let d = foldAngle(a - b, period);
  if (d > period / 2) d -= period;
  return d;
}

/** Whether `layerId` may follow `refId`: another halftone, and not one that already follows it. */
export function canFollow(layers: readonly Layer[], layerId: string, refId: string): boolean {
  if (layerId === refId) return false;
  let cur = layers.find((l) => l.id === refId);
  const seen = new Set<string>();
  while (cur) {
    const d = halftone(cur);
    if (!d) return cur.id === refId ? false : true;
    if (cur.id === layerId) return false;
    if (!d.angleFrom || seen.has(cur.id)) return true;
    seen.add(cur.id);
    cur = layers.find((l) => l.id === d.angleFrom);
  }
  return true;
}

/**
 * Before `goneId` leaves the stack, every screen that follows it is made to
 * follow what it followed instead — with the offsets added up — so nothing
 * moves when a reference is deleted.
 */
export function releaseFollowers(layers: Layer[], goneId: string): void {
  const gone = layers.find((l) => l.id === goneId);
  const g = halftone(gone);
  for (let i = 0; i < layers.length; i++) {
    const d = halftone(layers[i]);
    if (!d || d.angleFrom !== goneId) continue;
    const angle = g ? d.angle + g.angle : d.angle;
    layers[i] = { ...layers[i], distribution: { ...d, angle, angleFrom: g?.angleFrom ?? undefined } };
  }
}
