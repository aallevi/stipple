import type { RGBA } from './types';

/**
 * Colour maths for spot-ink printing.
 *
 * A screenprint has no continuous tone and no arbitrary colour: there are N
 * screens, and every mark is made with exactly one of them. So the question
 * this module answers is the only one that matters for that process — *which
 * ink does this dot get?* — and it has to answer it identically on the GPU
 * (`src/gl/renderer.ts`, for the preview) and on the CPU (`src/export/*`, for
 * the plates), or the proof would not match the print.
 *
 * Two colour spaces appear here, deliberately:
 *
 *   Oklab decides which ink is *closest*, because that is a question about
 *   perception and Euclidean distance in sRGB is a poor answer to it.
 *
 *   Linear light decides how to *mix* two inks, because dots printed side by
 *   side average in light, not in perception. Interpolating in Oklab would
 *   put the transition in the wrong place.
 */

/** Inks plus, optionally, bare paper — precomputed in both working spaces. */
export type InkSet = {
  /** Oklab, for nearest-ink search. */
  lab: Float32Array;
  /** Linear light RGB, for two-ink mixing. */
  lin: Float32Array;
  /** How many entries are real inks; anything at or past this is paper. */
  inkCount: number;
  /** Total entries, `inkCount` or `inkCount + 1`. */
  count: number;
};

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB 0..1 to Oklab. Björn Ottosson's matrices, unchanged. */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  // Clamped before the cube root to match the shader, which has to use
  // `pow(max(x, 0), 1/3)` because `pow` of a negative is undefined there.
  // `Math.cbrt` would happily return a negative and quietly disagree.
  const l = Math.cbrt(Math.max(0, 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B));
  const m = Math.cbrt(Math.max(0, 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B));
  const s = Math.cbrt(Math.max(0, 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B));
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/**
 * Pack a palette for repeated lookups.
 *
 * The conversions are done once here rather than per dot, which is what keeps
 * the vertex shader down to one `pow` chain per instance instead of thirty:
 * the shader receives these arrays as uniforms and only has to convert the
 * pixel it sampled.
 */
export function buildInkSet(palette: RGBA[], paper: RGBA | null, max = 8): InkSet {
  const inks = palette.slice(0, max);
  const all = paper ? [...inks, paper] : inks;
  const lab = new Float32Array(all.length * 3);
  const lin = new Float32Array(all.length * 3);
  all.forEach((c, i) => {
    const [L, A, B] = oklab(c[0], c[1], c[2]);
    lab[i * 3] = L; lab[i * 3 + 1] = A; lab[i * 3 + 2] = B;
    lin[i * 3] = srgbToLinear(c[0]);
    lin[i * 3 + 1] = srgbToLinear(c[1]);
    lin[i * 3 + 2] = srgbToLinear(c[2]);
  });
  return { lab, lin, inkCount: inks.length, count: all.length };
}

/**
 * Which ink this dot prints with.
 *
 * Step one picks the perceptually nearest ink, which on its own is a posterise:
 * flat areas of unmixed colour, exactly what you want for a three-ink poster.
 *
 * Step two asks whether a *second* ink, dithered against the first, would
 * reconstruct the colour better — the classic two-ink solve, `t` being how far
 * along the line between them the target sits. Scaling `t` by `mixing` is the
 * whole control: at 0 the second ink never wins and the print stays posterised;
 * at 1 the dots scatter in the proportion that reproduces the original colour,
 * which with process inks is a scatter separation.
 *
 * Returns an index into the ink set; `>= set.inkCount` means bare paper, so the
 * caller draws nothing and the stock shows through.
 */
export function assignInk(
  set: InkSet,
  r: number, g: number, b: number,
  mixing: number,
  rand: number,
  /** Compare lightness only, ignoring hue — the posterise. */
  byTone = false,
): number {
  const n = set.count;
  if (n === 0) return 0;

  const [tl, ta, tb] = oklab(r, g, b);
  // Dropping the a and b axes turns the search into "which ink is closest in
  // lightness", so a palette running dark to light reads the photograph as
  // tonal bands instead of scattering it across whichever inks happen to share
  // its hues. With three earth inks that is the difference between a poster and
  // a mess.
  const ca = byTone ? 0 : 1;
  let a = 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const dl = tl - set.lab[i * 3];
    const da = (ta - set.lab[i * 3 + 1]) * ca;
    const db = (tb - set.lab[i * 3 + 2]) * ca;
    const d = dl * dl + da * da + db * db;
    if (d < best) { best = d; a = i; }
  }
  if (n === 1 || mixing <= 0) return a;

  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const ar = set.lin[a * 3], ag = set.lin[a * 3 + 1], ab = set.lin[a * 3 + 2];
  const vr = lr - ar, vg = lg - ag, vb = lb - ab;

  // The residual to beat is what the nearest ink manages on its own.
  let bestRes = vr * vr + vg * vg + vb * vb;
  let partner = a;
  let t = 0;

  for (let i = 0; i < n; i++) {
    if (i === a) continue;
    // The partner search stays in linear light whichever way the nearest ink was
    // chosen: how two inks average when their dots sit side by side is a fact
    // about light, not about how the match was made.
    const er = set.lin[i * 3] - ar, eg = set.lin[i * 3 + 1] - ag, eb = set.lin[i * 3 + 2] - ab;
    const ee = er * er + eg * eg + eb * eb;
    // Two inks at the same point define no line to mix along.
    if (ee < 1e-8) continue;
    // Clamped, so a target beyond either end mixes to that end rather than
    // extrapolating into a colour neither ink can make.
    let u = (vr * er + vg * eg + vb * eb) / ee;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const rr = vr - er * u, rg = vg - eg * u, rb = vb - eb * u;
    const res = rr * rr + rg * rg + rb * rb;
    if (res < bestRes - 1e-9) { bestRes = res; partner = i; t = u; }
  }

  return spotHash(rand) < t * mixing ? partner : a;
}

const HASH_F32 = new Float32Array(1);
const HASH_U32 = new Uint32Array(HASH_F32.buffer);

/**
 * The per-dot draw for the dither. Mirrors `spotHash` in the point shader.
 *
 * Integer bit mixing rather than `fract(rand * someBigPrime)`: the shader works
 * in 32-bit floats and this runs in 64, so the fract trick would put preview
 * and plate on opposite sides of the threshold for a thin band of dots. Here
 * the result is a hard classification — which screen a mark is printed from —
 * so the two have to agree exactly, not approximately.
 *
 * It is also decorrelated from the size jitter and the colour wobble, which key
 * off the same `rand`; sharing a stream would tie ink choice to dot size and
 * put a texture in the separation that is not in the image.
 */
export function spotHash(rand: number): number {
  HASH_F32[0] = rand;
  let h = (HASH_U32[0] ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h >>> 8) / 16777216;
}

/** Oklab back to sRGB 0..1, clamped into gamut. */
export function oklabToSrgb(L: number, A: number, B: number): [number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const clamp = (v: number): number => Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, v)))));
  return [clamp(r), clamp(g), clamp(b)];
}

/**
 * Propose a palette by clustering what is actually in the photograph.
 *
 * k-means in Oklab, so the inks come out spaced by how different they *look*
 * rather than by how far apart their numbers happen to be — cluster an ordinary
 * portrait in sRGB and you get four browns. Seeded throughout, so the same
 * image and the same ink count always propose the same inks; an ink the user
 * has since edited by hand is not silently replaced by a different one.
 *
 * Pixels already close to the paper are left out: the stock is not an ink, and
 * letting a white background claim a screen wastes a quarter of a four-colour
 * job.
 */
export function extractPalette(
  src: { width: number; height: number; rgba: Uint8ClampedArray | Uint8Array },
  k: number,
  paper: RGBA | null = null,
  sampleTarget = 20000,
): RGBA[] {
  const total = src.width * src.height;
  const stride = Math.max(1, Math.floor(total / sampleTarget));
  const paperLab = paper ? oklab(paper[0], paper[1], paper[2]) : null;

  const pts: number[] = [];
  for (let i = 0; i < total; i += stride) {
    const o = i * 4;
    if (src.rgba[o + 3] < 8) continue;
    const lab = oklab(src.rgba[o] / 255, src.rgba[o + 1] / 255, src.rgba[o + 2] / 255);
    if (paperLab) {
      const d = (lab[0] - paperLab[0]) ** 2 + (lab[1] - paperLab[1]) ** 2 + (lab[2] - paperLab[2]) ** 2;
      if (d < 0.0036) continue; // within ~0.06 of the stock; the paper prints this
    }
    pts.push(lab[0], lab[1], lab[2]);
  }

  const n = pts.length / 3;
  const want = Math.max(1, Math.min(k, n));
  if (n === 0) return [];

  // k-means++ seeding: each new centre is drawn in proportion to how badly the
  // centres so far cover it, which is what stops two inks landing on the same
  // dominant colour and leaving a whole hue unprintable.
  const rnd = mulberryish(0x9e3779b9);
  const cen = new Float64Array(want * 3);
  const first = Math.floor(rnd() * n);
  cen[0] = pts[first * 3]; cen[1] = pts[first * 3 + 1]; cen[2] = pts[first * 3 + 2];
  const d2 = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < want; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dl = pts[i * 3] - cen[(c - 1) * 3];
      const da = pts[i * 3 + 1] - cen[(c - 1) * 3 + 1];
      const db = pts[i * 3 + 2] - cen[(c - 1) * 3 + 2];
      const d = dl * dl + da * da + db * db;
      if (d < d2[i]) d2[i] = d;
      sum += d2[i];
    }
    let target = rnd() * sum;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= d2[i];
      if (target <= 0) { pick = i; break; }
    }
    cen[c * 3] = pts[pick * 3]; cen[c * 3 + 1] = pts[pick * 3 + 1]; cen[c * 3 + 2] = pts[pick * 3 + 2];
  }

  const sums = new Float64Array(want * 3);
  const counts = new Int32Array(want);
  for (let iter = 0; iter < 14; iter++) {
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      let bi = 0;
      for (let c = 0; c < want; c++) {
        const dl = pts[i * 3] - cen[c * 3];
        const da = pts[i * 3 + 1] - cen[c * 3 + 1];
        const db = pts[i * 3 + 2] - cen[c * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < best) { best = d; bi = c; }
      }
      sums[bi * 3] += pts[i * 3];
      sums[bi * 3 + 1] += pts[i * 3 + 1];
      sums[bi * 3 + 2] += pts[i * 3 + 2];
      counts[bi] += 1;
    }
    for (let c = 0; c < want; c++) {
      if (counts[c] === 0) continue;
      cen[c * 3] = sums[c * 3] / counts[c];
      cen[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
      cen[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
    }
  }

  // Darkest first: the heaviest ink is the one printed last and the one a
  // printer thinks of as the key, so it reads naturally at the bottom of a list.
  const order = [...Array(want).keys()].filter((c) => counts[c] > 0);
  order.sort((a, b) => cen[a * 3] - cen[b * 3]);
  return order.map((c) => {
    const [r, g, b] = oklabToSrgb(cen[c * 3], cen[c * 3 + 1], cen[c * 3 + 2]);
    return [r, g, b, 1] as RGBA;
  });
}

/** A tiny fixed-seed PRNG, so a proposed palette is reproducible. */
function mulberryish(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A palette that runs dark to light, for posterising.
 *
 * Ordinary clustering spreads inks across whatever hues the photograph contains,
 * which is right for a scatter separation and wrong for a poster: three inks
 * chosen that way will not stack into a legible image. Clustering on lightness
 * alone and keeping each band's average colour gives the set a printmaker
 * actually asks for — a dark, a mid and a light that happen to be brown, tan and
 * ochre because that is what the picture is made of.
 *
 * Returned darkest first, which is also the order the screens are printed in.
 */
export function toneRamp(
  src: { width: number; height: number; rgba: Uint8ClampedArray | Uint8Array },
  k: number,
  paper: RGBA | null = null,
  sampleTarget = 20000,
): RGBA[] {
  const total = src.width * src.height;
  const stride = Math.max(1, Math.floor(total / sampleTarget));
  const paperL = paper ? oklab(paper[0], paper[1], paper[2])[0] : null;

  const L: number[] = [];
  const A: number[] = [];
  const B: number[] = [];
  for (let i = 0; i < total; i += stride) {
    const o = i * 4;
    if (src.rgba[o + 3] < 8) continue;
    const lab = oklab(src.rgba[o] / 255, src.rgba[o + 1] / 255, src.rgba[o + 2] / 255);
    // Anything as light as the stock is already printed, by not printing it.
    if (paperL !== null && lab[0] > paperL - 0.06) continue;
    L.push(lab[0]); A.push(lab[1]); B.push(lab[2]);
  }
  const n = L.length;
  if (n === 0) return [];
  const want = Math.max(1, Math.min(k, n));

  // Seed on quantiles rather than at random: lightness is one-dimensional and
  // ordered, so the good answer is known in advance and Lloyd's only refines it.
  const sorted = [...L].sort((a, b) => a - b);
  const cen = Array.from({ length: want }, (_, c) => sorted[Math.floor(((c + 0.5) / want) * (n - 1))]);

  for (let iter = 0; iter < 20; iter++) {
    const sum = new Float64Array(want);
    const count = new Int32Array(want);
    for (let i = 0; i < n; i++) {
      let bi = 0;
      let best = Infinity;
      for (let c = 0; c < want; c++) {
        const d = Math.abs(L[i] - cen[c]);
        if (d < best) { best = d; bi = c; }
      }
      sum[bi] += L[i];
      count[bi] += 1;
    }
    for (let c = 0; c < want; c++) if (count[c] > 0) cen[c] = sum[c] / count[c];
  }

  // Second pass for the colour of each band, so the inks are the picture's own.
  const sl = new Float64Array(want);
  const sa = new Float64Array(want);
  const sb = new Float64Array(want);
  const count = new Int32Array(want);
  for (let i = 0; i < n; i++) {
    let bi = 0;
    let best = Infinity;
    for (let c = 0; c < want; c++) {
      const d = Math.abs(L[i] - cen[c]);
      if (d < best) { best = d; bi = c; }
    }
    sl[bi] += L[i]; sa[bi] += A[i]; sb[bi] += B[i]; count[bi] += 1;
  }

  const out: RGBA[] = [];
  for (let c = 0; c < want; c++) {
    if (count[c] === 0) continue;
    const [r, g, b] = oklabToSrgb(sl[c] / count[c], sa[c] / count[c], sb[c] / count[c]);
    out.push([r, g, b, 1]);
  }
  return out;
}

/**
 * Roughly what share of the picture each screen would carry.
 *
 * "Three screens to burn" is not the number you need when you are deciding
 * whether a palette is worth the ink — how much of the paper each one actually
 * covers is. Sampled off the image rather than off the point field, so it
 * answers a question about the separation and not about the current spacing.
 */
export function inkShares(
  src: { width: number; height: number; rgba: Uint8ClampedArray | Uint8Array },
  set: InkSet,
  mixing: number,
  byTone: boolean,
  samples = 4000,
): number[] {
  const out = new Array(set.count).fill(0);
  const total = src.width * src.height;
  if (total === 0 || set.count === 0) return out;
  const stride = Math.max(1, Math.floor(total / samples));

  let seen = 0;
  for (let i = 0; i < total; i += stride) {
    const o = i * 4;
    if (src.rgba[o + 3] < 8) continue;
    // Walk the random stream rather than fixing it, so a dithered palette shows
    // its true split instead of whatever one arbitrary draw happened to give.
    const rand = (seen % 97) / 97;
    out[assignInk(set, src.rgba[o] / 255, src.rgba[o + 1] / 255, src.rgba[o + 2] / 255, mixing, rand, byTone)] += 1;
    seen += 1;
  }
  return seen === 0 ? out : out.map((v) => v / seen);
}
