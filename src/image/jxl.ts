/**
 * JPEG XL, in and out.
 *
 * The desktop app's web view (WebKit, macOS 14 and later) decodes JXL itself,
 * alpha and colour profile included, and that is always tried first: it is
 * native code and costs nothing to load. Chrome and Firefox do not, and neither
 * does WebKit on an older Mac, so they fall back to libjxl compiled to wasm.
 * The codec is imported only when one of those actually happens — nobody who
 * never opens a JXL downloads it.
 *
 * Pixels come back unpremultiplied (`ImageData`), the same as a PNG's, so a
 * cut-out keeps clean edges.
 */

import type { EncodeOptions } from '@jsquash/jxl/meta.js';

/** A bare codestream (`FF 0A`) or the ISO-BMFF container (`....JXL `). */
export function isJXL(b: Uint8Array): boolean {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0x0a) return true;
  return b.length >= 12
    && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0x0c
    && b[4] === 0x4a && b[5] === 0x58 && b[6] === 0x4c && b[7] === 0x20;
}

/** Decode with libjxl in wasm. Straight (unpremultiplied) 8-bit RGBA. */
export async function decodeJXL(bytes: Uint8Array): Promise<ImageData> {
  const { default: decode } = await import('@jsquash/jxl/decode.js');
  try {
    return await decode(bytes.slice().buffer as ArrayBuffer);
  } catch {
    throw new Error('That JPEG XL file could not be decoded.');
  }
}

/**
 * Lossless JXL from straight RGBA.
 *
 * Effort 5 rather than libjxl's 7: on flat, traced artwork the file is within
 * a few percent, and it finishes in a fraction of the time. The single-threaded
 * build is called directly: the threaded ones need a cross-origin isolated
 * page, which a GitHub Pages site is not, and the package's own picker drags in
 * a feature test that neither Vite nor Safari 16 can parse.
 */
let encoder: Promise<{ encode(d: BufferSource, w: number, h: number, o: EncodeOptions): Uint8Array | null }> | null = null;

export async function encodeJXL(img: ImageData): Promise<Uint8Array> {
  encoder ??= import('@jsquash/jxl/codec/enc/jxl_enc.js').then((m) => m.default({ noInitialRun: true }));
  const { defaultOptions } = await import('@jsquash/jxl/meta.js');
  const module = await encoder;
  const out = module.encode(img.data, img.width, img.height, {
    ...defaultOptions,
    lossless: true,
    quality: 100,
    lossyModular: false,
    lossyPalette: false,
    effort: 5,
  });
  if (!out) throw new Error('JPEG XL encoding failed');
  return out.slice();
}
