import type { ShapeDef } from '../core/types';
import type { GL } from '../gl/context';
import { rasterizeShape } from './rasterize';
import { encodeSDF, signedDistanceField } from './sdf';

/**
 * One texture holding every shape in the project as a signed distance field.
 *
 * A single R8 atlas means the renderer binds one texture and issues one draw
 * call per layer no matter which shape it uses, and swapping a layer's shape is
 * a uniform change rather than a resource swap.
 */

export const TILE = 128;
export const ATLAS_TILES = 16;               // 16x16 tiles
export const ATLAS_SIZE = TILE * ATLAS_TILES; // 2048px
/** Distance in tile-pixels encoded across the full 0..255 range. */
export const SDF_SPREAD = TILE * 0.12;

export type AtlasSlot = {
  /** Tile rect in 0..1 texture coordinates. */
  uv: [number, number, number, number];
  index: number;
};

export class ShapeAtlas {
  private texture: WebGLTexture;
  private slots = new Map<string, AtlasSlot>();
  /** Signature of the ShapeDef each slot was built from, to skip rebuilds. */
  private signatures = new Map<string, string>();
  private nextIndex = 0;

  constructor(private gl: GL) {
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, ATLAS_SIZE, ATLAS_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  get(shapeId: string): AtlasSlot | undefined {
    return this.slots.get(shapeId);
  }

  bind(unit: number): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
  }

  /**
   * Bring the atlas in line with the project's shape list.
   *
   * Only shapes whose definition actually changed are re-rasterised, so editing
   * one polygon's vertex count does not rebuild the other twenty tiles.
   */
  sync(shapes: ShapeDef[], bitmaps: Map<string, ImageBitmap>): void {
    for (const def of shapes) {
      const sig = JSON.stringify(def);
      if (this.signatures.get(def.id) === sig) continue;

      let slot = this.slots.get(def.id);
      if (!slot) {
        if (this.nextIndex >= ATLAS_TILES * ATLAS_TILES) {
          console.warn(`Shape atlas full (${ATLAS_TILES * ATLAS_TILES} tiles); skipping "${def.name}".`);
          continue;
        }
        slot = { index: this.nextIndex++, uv: [0, 0, 0, 0] };
        const tx = slot.index % ATLAS_TILES;
        const ty = Math.floor(slot.index / ATLAS_TILES);
        const s = TILE / ATLAS_SIZE;
        slot.uv = [tx * s, ty * s, s, s];
        this.slots.set(def.id, slot);
      }

      this.upload(slot, def, bitmaps.get(def.id));
      this.signatures.set(def.id, sig);
    }

    // Shapes deleted from the project keep their slot; reclaiming tiles would
    // invalidate every other slot's index for no practical gain at 256 tiles.
    const live = new Set(shapes.map((s) => s.id));
    for (const id of [...this.signatures.keys()]) {
      if (!live.has(id)) this.signatures.delete(id);
    }
  }

  private upload(slot: AtlasSlot, def: ShapeDef, bitmap?: ImageBitmap): void {
    const alpha = rasterizeShape(def, TILE, bitmap);
    const field = signedDistanceField(alpha, TILE, TILE);
    const data = encodeSDF(field, SDF_SPREAD);

    const { gl } = this;
    const tx = (slot.index % ATLAS_TILES) * TILE;
    const ty = Math.floor(slot.index / ATLAS_TILES) * TILE;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, tx, ty, TILE, TILE, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
