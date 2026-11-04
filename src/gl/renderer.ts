import { buildInkSet } from '../core/color';
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
/** Inks plus bare paper, which is matched like an ink but never drawn. */
const MAX_SPOT = MAX_PALETTE + 1;

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
// Target pixels per canvas pixel. Sizes arrive in target pixels — that is the
// unit the one-pixel floor below has to be in — but the quad is built in canvas
// space and uView scales it again, so it is divided back out there. Without
// that, every mark was this factor squared too large whenever the target was
// not 1:1 with the canvas: fatter dots in the zoomed preview than in the file.
uniform float uPxPerCanvas;
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

// Spot inks, pre-converted on the CPU so the shader only has to transform the
// one pixel it sampled. See src/core/color.ts — this is its mirror.
uniform vec3  uSpotLab[${MAX_SPOT}];
uniform vec3  uSpotLin[${MAX_SPOT}];
uniform int   uSpotInks;
uniform int   uSpotCount;
uniform float uSpotMixing;
uniform float uSpotChroma;   // 1 match on colour, 0 match on lightness alone

out vec2 vUV;
out vec4 vColor;
out float vSize;

vec3 hsl2rgb(float h, float s, float l) {
  vec3 k = mod(vec3(0.0, 8.0, 4.0) + h * 12.0, 12.0);
  float a = s * min(l, 1.0 - l);
  return l - a * clamp(min(k - 3.0, 9.0 - k), -1.0, 1.0);
}

/*
 * The dither's per-dot draw.
 *
 * A bit mix rather than fract(rand * someBigPrime): the fract trick loses
 * resolution at highp and the CPU computes it in double, so preview and plate
 * would disagree about a thin band of dots. Integer mixing is identical on
 * both sides, which matters here because the result is a hard classification
 * and not a shade.
 */
float spotHash(float r) {
  uint h = floatBitsToUint(r) ^ 0x9E3779B9u;
  h ^= h >> 16; h *= 0x7FEB352Du;
  h ^= h >> 15; h *= 0x846CA68Bu;
  h ^= h >> 16;
  return float(h >> 8) * (1.0 / 16777216.0);
}

vec3 srgbToLinear3(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

vec3 toOklab(vec3 lin) {
  // max() before the cube root: pow() of a negative is undefined, and a colour
  // just outside the gamut would poison the whole comparison with NaN.
  float l = pow(max(dot(lin, vec3(0.4122214708, 0.5363325363, 0.0514459929)), 0.0), 1.0 / 3.0);
  float m = pow(max(dot(lin, vec3(0.2119034982, 0.6806995451, 0.1073969566)), 0.0), 1.0 / 3.0);
  float s = pow(max(dot(lin, vec3(0.0883024619, 0.2817188376, 0.6299787005)), 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}

/*
 * Which ink this dot prints with. Oklab picks the nearest; linear light decides
 * how far a second ink would carry it, because dots side by side average in
 * light. uSpotMixing scales that second ink's share, so 0 posterises and 1
 * scatters. Keep in step with assignInk in src/core/color.ts.
 */
int spotInk(vec3 rgb, float rnd) {
  vec3 lin = srgbToLinear3(rgb);
  vec3 lab = toOklab(lin);

  int a = 0;
  float best = 1e9;
  for (int i = 0; i < ${MAX_SPOT}; i++) {
    if (i >= uSpotCount) break;
    // Zeroing the a and b axes makes this "closest in lightness", which is what
    // turns a dark-to-light palette into tonal bands instead of hue scatter.
    vec3 d = (lab - uSpotLab[i]) * vec3(1.0, uSpotChroma, uSpotChroma);
    float dd = dot(d, d);
    if (dd < best) { best = dd; a = i; }
  }
  if (uSpotCount == 1 || uSpotMixing <= 0.0) return a;

  vec3 base = uSpotLin[a];
  vec3 v = lin - base;
  float bestRes = dot(v, v);
  int partner = a;
  float t = 0.0;
  for (int i = 0; i < ${MAX_SPOT}; i++) {
    if (i >= uSpotCount) break;
    if (i == a) continue;
    vec3 e = uSpotLin[i] - base;
    float ee = dot(e, e);
    if (ee < 1e-8) continue;
    float u = clamp(dot(v, e) / ee, 0.0, 1.0);
    vec3 r = v - e * u;
    float res = dot(r, r);
    if (res < bestRes - 1e-9) { bestRes = res; partner = i; t = u; }
  }
  return spotHash(rnd) < t * uSpotMixing ? partner : a;
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
  vec2 local = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c) * (drawSize / uPxPerCanvas);
  vec3 clip = uView * vec3(aPos + local, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  vUV = uAtlasUV.xy + (aCorner + 0.5) * uAtlasUV.zw;

  vec3 rgb;
  bool drop = false;
  if (uColorMode == 1) {
    float h = mix(uHueA, uHueB, aTone) / 360.0;
    rgb = hsl2rgb(fract(h), uSaturation, uLightness);
  } else if (uColorMode == 2) {
    rgb = texture(uImage, aPos / uCanvas).rgb;
  } else if (uColorMode == 3 && uPaletteCount > 0) {
    int idx = int(aRand * float(uPaletteCount));
    idx = clamp(idx, 0, uPaletteCount - 1);
    rgb = uPalette[idx].rgb;
  } else if (uColorMode == 4 && uSpotCount > 0) {
    int ink = spotInk(texture(uImage, aPos / uCanvas).rgb, aRand);
    // Past the last ink is bare paper: the dot is not printed at all, which is
    // how the highlights of a three-ink poster stay unscreened.
    drop = ink >= uSpotInks;
    rgb = drop ? vec3(1.0) : uPalette[ink].rgb;
  } else {
    rgb = uColor.rgb;
  }

  // Spot mode opts out of the wobble: a dot that drifts off its ink would be
  // printed from a screen whose colour the proof never showed.
  if (uColorMode != 4) {
    float wobble = 1.0 + (fract(aRand * 5099.7) - 0.5) * 2.0 * uColorJitter;
    rgb = clamp(rgb * wobble, 0.0, 1.0);
  }
  vColor = vec4(rgb, uAlpha * uColor.a);

  // Collapse the whole quad outside clip space rather than drawing it invisible,
  // so a dropped dot costs no fragments.
  if (drop) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
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
    gl.uniform1f(u.uPxPerCanvas!, Math.max(1e-6, opts.sizeScale));
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
    const mode = c.mode === 'solid' ? 0
      : c.mode === 'adaptive' ? 1
      : c.mode === 'image' ? 2
      : c.mode === 'spot' ? 4
      : 3;
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

    if (c.mode === 'spot') {
      // Converting the palette here rather than in the shader is the whole
      // reason spot mode stays as cheap as any other: per instance the GPU does
      // one sRGB-to-Oklab transform, not one per candidate ink.
      const set = buildInkSet(c.palette, c.paper ?? null, MAX_PALETTE);
      const lab = new Float32Array(MAX_SPOT * 3);
      const lin = new Float32Array(MAX_SPOT * 3);
      lab.set(set.lab);
      lin.set(set.lin);
      gl.uniform3fv(u.uSpotLab!, lab);
      gl.uniform3fv(u.uSpotLin!, lin);
      gl.uniform1i(u.uSpotInks!, set.inkCount);
      gl.uniform1i(u.uSpotCount!, set.count);
      gl.uniform1f(u.uSpotMixing!, c.mixing);
      gl.uniform1f(u.uSpotChroma!, c.matchBy === 'tone' ? 0 : 1);
    }
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
