import type { ImageSource } from './density';

/** Longest edge kept for the density map. Beyond this the extra detail does not
 *  survive stippling, and the memory and CPU cost of the prefilter chain does. */
export const MAX_SOURCE_EDGE = 4096;

/**
 * Decode image bytes into raw RGBA.
 *
 * Everything downstream works on `ImageSource`, so this is the only place that
 * knows about blobs, bitmaps or canvases.
 */
export async function decodeImage(bytes: Uint8Array, mime?: string): Promise<ImageSource> {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime ?? sniffMime(bytes) });
  const bitmap = await createImageBitmap(blob);
  try {
    return bitmapToSource(bitmap);
  } finally {
    bitmap.close();
  }
}

export function bitmapToSource(bitmap: ImageBitmap): ImageSource {
  const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = (canvas as OffscreenCanvas).getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, rgba: data.data };
}

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b[0] === 0x3c || (b[0] === 0xef && b[3] === 0x3c)) return 'image/svg+xml';
  return 'application/octet-stream';
}
