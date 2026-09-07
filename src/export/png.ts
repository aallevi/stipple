import type { Engine } from '../pipeline/engine';
import type { Project } from '../core/types';

/** Kept modest so a huge export never allocates a single enormous GPU target. */
const TILE = 2048;

export type ExportProgress = (done: number, total: number) => void;

/**
 * Raster export at an arbitrary scale, assembled from GPU tiles.
 *
 * Tiling is what makes print resolution practical: a 6000x8000 export never
 * needs a render target bigger than 2048², so it works on modest GPUs and never
 * risks a context loss from an oversized allocation.
 */
export async function exportPNG(
  engine: Engine,
  project: Project,
  scale: number,
  onProgress?: ExportProgress,
): Promise<Blob> {
  engine.prepareForExport();

  const width = Math.max(1, Math.round(project.canvas.width * scale));
  const height = Math.max(1, Math.round(project.canvas.height * scale));

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = (canvas as OffscreenCanvas).getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;

  const cols = Math.ceil(width / TILE);
  const rows = Math.ceil(height / TILE);
  const total = cols * rows;
  let done = 0;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x = tx * TILE;
      const y = ty * TILE;
      const w = Math.min(TILE, width - x);
      const h = Math.min(TILE, height - y);
      const px = engine.renderRegion(scale, x, y, w, h);
      ctx.putImageData(new ImageData(px, w, h), x, y);

      done += 1;
      onProgress?.(done, total);
      // Yield so the progress UI can paint between tiles.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if ('convertToBlob' in canvas) {
    return (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
  }
  return new Promise((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))),
      'image/png',
    );
  });
}
