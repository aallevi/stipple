import type { ColorParams, Layer } from '../core/types';
import { POINT_STRIDE } from '../dist/types';
import { SDF_SPREAD, TILE, type AtlasSlot } from '../shape/atlas';
import { createProgram, type GL, type Program } from './context';

/**
 * Instanced point renderer: one draw call per layer, however many points.
 *
 * The vertex shader derives size, rotation and colour from the per-point
 * invariants (tone, gradient, random) plus layer uniforms. Nothing in the buffer
 * changes when you drag a size or colour slider — only uniforms — so a 1M-point
 * layer re-renders in about a millisecond.
 */

const MAX_PALETTE = 8;

const POINT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;  // unit quad, -0.5..0.5
layout(location = 1) in vec2 aPos;     // canvas px
layout(location = 2) in float aTone;
layout(location = 3) in float aGrad;
layout(location = 4) in float aRand;

uniform mat3 uView;        // canvas px -> clip
uniform vec2 uCanvas;
uniform vec4 uAtlasUV;     // xy = tile origin, zw = tile extent

uniform float uSizeMin;
uniform float uSizeMax;
uniform float uSizeFromTone;
uniform float uSizeGamma;
uniform bool  uSizeInvert;
uniform float uSizeJitter;

uniform float uRotBase;
uniform float uRotRandom;
uniform float uRotFollow;

uniform int   uColorMode;  // 0 solid, 1 adaptive, 2 image, 3 multicolor
uniform vec4  uColor;
uniform float uHueA;
uniform float uHueB;
uniform float uSaturation;
uniform float uLightness;
uniform vec4  uPalette[${MAX_PALETTE}];
uniform int   uPaletteCount;
uniform float uColorJitter;
uniform float uAlpha;
uniform sampler2D uImage;

out vec2 vUV;
out vec4 vColor;
out float vSize;

vec3 hsl2rgb(float h, float s, float l) {
  vec3 k = mod(vec3(0.0, 8.0, 4.0) + h * 12.0, 12.0);
  float a = s * min(l, 1.0 - l);
  return l - a * clamp(min(k - 3.0, 9.0 - k), -1.0, 1.0);
}

void main() {
  // Ink runs 1 at the dark end unless inverted; this is the value every derived
  // property keys off.
  float ink = uSizeInvert ? aTone : 1.0 - aTone;

  // Area-true halftones need the diameter to follow sqrt(ink); see SizeParams.
  float t = uSizeGamma == 1.0 ? ink : pow(max(ink, 0.0), uSizeGamma);
  float toned = mix(uSizeMin, uSizeMax, t);
  float size = mix(uSizeMax, toned, uSizeFromTone);
  float jr = fract(aRand * 7919.13);
  size *= 1.0 + (jr - 0.5) * 2.0 * uSizeJitter;
  size = max(size, 0.0);

  // Following the gradient means aligning to the *contour*, which is
  // perpendicular to it — that is what makes line shapes flow around forms.
  float rot = uRotBase
            + aRand * 6.28318530718 * uRotRandom
            + (aGrad + 1.57079632679) * uRotFollow;

  // Sub-pixel points would flicker and thin out; draw them at one pixel and
  // carry the lost area in alpha so overall ink density stays correct.
  float drawSize = max(size, 1.0);
  vSize = size;

  float c = cos(rot);
  float s = sin(rot);
  vec2 local = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c) * drawSize;
  vec3 clip = uView * vec3(aPos + local, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  vUV = uAtlasUV.xy + (aCorner + 0.5) * uAtlasUV.zw;

  vec3 rgb;
  if (uColorMode == 1) {
    float h = mix(uHueA, uHueB, aTone) / 360.0;
    rgb = hsl2rgb(fract(h), uSaturation, uLightness);
  } else if (uColorMode == 2) {
    rgb = texture(uImage, aPos / uCanvas).rgb;
  } else if (uColorMode == 3 && uPaletteCount > 0) {
    int idx = int(aRand * float(uPaletteCount));
    idx = clamp(idx, 0, uPaletteCount - 1);
    rgb = uPalette[idx].rgb;
  } else {
    rgb = uColor.rgb;
  }

  float wobble = 1.0 + (fract(aRand * 5099.7) - 0.5) * 2.0 * uColorJitter;
  rgb = clamp(rgb * wobble, 0.0, 1.0);
  vColor = vec4(rgb, uAlpha * uColor.a);
}
`;

const POINT_FS = `#version 300 es
precision highp float;

uniform sampler2D uAtlas;
uniform float uSpread;
uniform float uTile;
uniform float uSoftness;

in vec2 vUV;
in vec4 vColor;
in float vSize;
out vec4 outColor;

void main() {
  // The atlas stores distance in tile pixels, encoded so that > 0.5 is inside.
  float dist = (texture(uAtlas, vUV).r - 0.5) * 2.0 * uSpread;

  // Antialias over half a screen pixel, expressed in tile pixels. Because this
  // scales with the drawn size, the same tile is crisp at 2px and at 400px.
  float drawSize = max(vSize, 1.0);
  float aa = max(0.5 * uTile / drawSize, 0.0001) * (1.0 + uSoftness * 8.0);
  float cov = smoothstep(-aa, aa, dist);

  // Ink conservation for sub-pixel points (see the vertex shader).
  float shrink = min(1.0, vSize * vSize);
  float alpha = cov * vColor.a * shrink;
  if (alpha <= 0.0) discard;

  outColor = vec4(vColor.rgb * alpha, alpha); // premultiplied
}
`;

export type ViewMatrix = Float32Array; // mat3, column-major

/**
 * Per-layer GPU point storage.
 *
 * Each layer keeps its own VAO and buffer so a redraw is pure state-setting —
 * without this, a multi-layer stack would re-upload every point buffer on every
 * frame, which at 1M points per layer is the difference between 1ms and 40ms.
 */
export class PointBatch {
  private buffer: WebGLBuffer;
  readonly vao: WebGLVertexArrayObject;
  private capacity = 0;
  count = 0;

  constructor(private gl: GL, cornerBuf: WebGLBuffer) {
    this.buffer = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const stride = POINT_STRIDE * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const layout: [number, number, number][] = [[1, 2, 0], [2, 1, 8], [3, 1, 12], [4, 1, 16]];
    for (const [loc, size, offset] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  /** Reuses the allocation when the new data fits, avoiding GPU memory churn. */
  upload(data: Float32Array, count: number): void {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (data.length > this.capacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.capacity = data.length;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    }
    this.count = count;
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
  }
}

export class PointRenderer {
  private prog: Program;
  readonly cornerBuf: WebGLBuffer;

  constructor(private gl: GL) {
    this.prog = createProgram(gl, POINT_VS, POINT_FS, 'points');
    this.cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
      gl.STATIC_DRAW,
    );
  }

  createBatch(): PointBatch {
    return new PointBatch(this.gl, this.cornerBuf);
  }

  draw(opts: {
    batch: PointBatch;
    layer: Layer;
    slot: AtlasSlot;
    view: ViewMatrix;
    canvas: [number, number];
    atlasUnit: number;
    imageUnit: number;
    /** Extra multiplier on point size, for rendering above or below 1:1. */
    sizeScale: number;
  }): void {
    const { gl } = this;
    const { layer, slot, batch } = opts;
    if (batch.count === 0) return;

    const u = this.prog.uniforms;
    gl.useProgram(this.prog.program);
    gl.bindVertexArray(batch.vao);

    gl.uniformMatrix3fv(u.uView!, false, opts.view);
    gl.uniform2f(u.uCanvas!, opts.canvas[0], opts.canvas[1]);
    gl.uniform4f(u.uAtlasUV!, slot.uv[0], slot.uv[1], slot.uv[2], slot.uv[3]);

    const s = layer.size;
    gl.uniform1f(u.uSizeMin!, s.min * opts.sizeScale);
    gl.uniform1f(u.uSizeMax!, s.max * opts.sizeScale);
    gl.uniform1f(u.uSizeFromTone!, s.fromTone);
    gl.uniform1f(u.uSizeGamma!, s.gamma ?? 1);
    gl.uniform1i(u.uSizeInvert!, s.invert ? 1 : 0);
    gl.uniform1f(u.uSizeJitter!, s.jitter);

    const r = layer.rotation;
    gl.uniform1f(u.uRotBase!, (r.base * Math.PI) / 180);
    gl.uniform1f(u.uRotRandom!, r.random);
    gl.uniform1f(u.uRotFollow!, r.followGradient);

    this.setColor(layer.color, layer.opacity);

    gl.uniform1i(u.uAtlas!, opts.atlasUnit);
    gl.uniform1i(u.uImage!, opts.imageUnit);
    gl.uniform1f(u.uSpread!, SDF_SPREAD);
    gl.uniform1f(u.uTile!, TILE);
    gl.uniform1f(u.uSoftness!, 0);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  private setColor(c: ColorParams, opacity: number): void {
    const { gl } = this;
    const u = this.prog.uniforms;
    const mode = c.mode === 'solid' ? 0 : c.mode === 'adaptive' ? 1 : c.mode === 'image' ? 2 : 3;
    gl.uniform1i(u.uColorMode!, mode);
    gl.uniform4f(u.uColor!, c.color[0], c.color[1], c.color[2], c.color[3]);
    gl.uniform1f(u.uHueA!, c.hueA);
    gl.uniform1f(u.uHueB!, c.hueB);
    gl.uniform1f(u.uSaturation!, c.saturation);
    gl.uniform1f(u.uLightness!, c.lightness);
    gl.uniform1f(u.uColorJitter!, c.jitter);
    gl.uniform1f(u.uAlpha!, c.alpha * opacity);

    const n = Math.min(MAX_PALETTE, c.palette.length);
    const flat = new Float32Array(MAX_PALETTE * 4);
    for (let i = 0; i < n; i++) flat.set(c.palette[i], i * 4);
    gl.uniform4fv(u.uPalette!, flat);
    gl.uniform1i(u.uPaletteCount!, n);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.cornerBuf);
    this.gl.deleteProgram(this.prog.program);
  }
}

/**
 * Build the canvas-px -> clip-space matrix, folding in the viewport pan/zoom and
 * the layer's own transform. Column-major for `uniformMatrix3fv`.
 */
export function makeView(
  canvasW: number,
  canvasH: number,
  targetW: number,
  targetH: number,
  view: { zoom: number; panX: number; panY: number },
  layer?: { scale: number; rotate: number; offsetX: number; offsetY: number; flipX: boolean; flipY: boolean },
): ViewMatrix {
  // Layer transform, applied about the canvas centre.
  const cx = canvasW / 2;
  const cy = canvasH / 2;
  const sc = layer ? layer.scale : 1;
  const th = layer ? (layer.rotate * Math.PI) / 180 : 0;
  const fx = layer && layer.flipX ? -1 : 1;
  const fy = layer && layer.flipY ? -1 : 1;
  const c = Math.cos(th) * sc;
  const s = Math.sin(th) * sc;

  // p' = R*S*F*(p - centre) + centre + offset
  const a = c * fx;
  const b = s * fx;
  const d = -s * fy;
  const e = c * fy;
  const tx = cx + (layer?.offsetX ?? 0) - (a * cx + d * cy);
  const ty = cy + (layer?.offsetY ?? 0) - (b * cx + e * cy);

  // Then canvas px -> clip, with y flipped so the origin is top-left, and the
  // viewport pan/zoom applied in target-pixel space.
  const z = view.zoom;
  const sx = (2 * z) / targetW;
  const sy = (-2 * z) / targetH;
  const ox = (2 * view.panX) / targetW - 1;
  const oy = 1 - (2 * view.panY) / targetH;

  // Compose: clip = M2 * M1
  const m11 = a * sx;
  const m12 = b * sy;
  const m21 = d * sx;
  const m22 = e * sy;
  const m31 = tx * sx + ox;
  const m32 = ty * sy + oy;

  return new Float32Array([m11, m12, 0, m21, m22, 0, m31, m32, 1]);
}
