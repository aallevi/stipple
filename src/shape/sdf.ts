/**
 * Signed distance field generation via 8SSEDT (Danielsson's 8-point sequential
 * Euclidean distance transform).
 *
 * Two sweeps over the image, O(n) with a small constant — fast enough to rebuild
 * a 256x256 field for an imported shape in a couple of milliseconds. The result
 * is what lets one atlas tile render crisply at 2px on screen and at 400px in a
 * 300dpi export without regenerating anything.
 *
 * Pure and DOM-free so it can run in a worker and be unit tested in node.
 */

const INF = 1 << 20;

/** Interleaved (dx, dy) offsets from each pixel to its nearest seed. */
type Offsets = Int32Array;

function initGrid(alpha: Uint8ClampedArray | Uint8Array, w: number, h: number, seedInside: boolean): Offsets {
  const g = new Int32Array(w * h * 2);
  for (let i = 0; i < w * h; i++) {
    const inside = alpha[i] >= 128;
    const isSeed = seedInside ? inside : !inside;
    if (isSeed) {
      g[i * 2] = 0;
      g[i * 2 + 1] = 0;
    } else {
      g[i * 2] = INF;
      g[i * 2 + 1] = INF;
    }
  }
  return g;
}

function propagate(g: Offsets, w: number, h: number): void {
  // Compare pixel `i` against neighbour `(x+ox, y+oy)`, whose stored offset must
  // be shifted by (ox, oy) to become an offset from `i`.
  const compare = (i: number, x: number, y: number, ox: number, oy: number): void => {
    const nx = x + ox;
    const ny = y + oy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
    const n = (ny * w + nx) * 2;
    const dx = g[n] + ox;
    const dy = g[n + 1] + oy;
    const d = dx * dx + dy * dy;
    const cx = g[i * 2];
    const cy = g[i * 2 + 1];
    if (d < cx * cx + cy * cy) {
      g[i * 2] = dx;
      g[i * 2 + 1] = dy;
    }
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      compare(i, x, y, -1, 0);
      compare(i, x, y, 0, -1);
      compare(i, x, y, -1, -1);
      compare(i, x, y, 1, -1);
    }
    for (let x = w - 1; x >= 0; x--) compare(y * w + x, x, y, 1, 0);
  }

  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      compare(i, x, y, 1, 0);
      compare(i, x, y, 0, 1);
      compare(i, x, y, 1, 1);
      compare(i, x, y, -1, 1);
    }
    for (let x = 0; x < w; x++) compare(y * w + x, x, y, -1, 0);
  }
}

/**
 * Signed distance in pixels: negative inside the shape, positive outside.
 *
 * Partial alpha at the boundary is used for sub-pixel correction, so a shape
 * rasterised with antialiasing yields a noticeably smoother field than a hard
 * threshold would.
 */
export function signedDistanceField(
  alpha: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
): Float32Array {
  const inner = initGrid(alpha, w, h, true);
  const outer = initGrid(alpha, w, h, false);
  propagate(inner, w, h);
  propagate(outer, w, h);

  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const ix = inner[i * 2];
    const iy = inner[i * 2 + 1];
    const ox = outer[i * 2];
    const oy = outer[i * 2 + 1];
    const dIn = Math.sqrt(ix * ix + iy * iy);
    const dOut = Math.sqrt(ox * ox + oy * oy);
    let d = dIn - dOut;
    // Sub-pixel refinement: an edge pixel that is 30% covered sits ~0.2px inside
    // the true boundary. Only meaningful where the field is already near zero.
    const a = alpha[i] / 255;
    if (a > 0 && a < 1 && Math.abs(d) <= 1.5) d = 0.5 - a;
    out[i] = d;
  }
  return out;
}

/**
 * Pack a signed distance field into 8-bit texture data.
 *
 * `spread` is the distance in pixels that maps to the full 0..255 range; values
 * beyond it clamp. 0.5 is the shape edge. The shader recovers distance as
 * `(v - 0.5) * 2 * spread`, so the same encoding works for every shape.
 */
export function encodeSDF(field: Float32Array, spread: number): Uint8Array {
  const out = new Uint8Array(field.length);
  const inv = 1 / (2 * spread);
  for (let i = 0; i < field.length; i++) {
    const v = 0.5 - field[i] * inv; // inside (negative) -> bright
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
  }
  return out;
}
