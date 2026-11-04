import { oklab } from '../core/color';
import { BLEND_MODES, type BlendMode } from '../core/types';
import { createProgram, FULLSCREEN_VS, type GL, type Program } from './context';

/**
 * Layer compositing.
 *
 * Layers render into their own premultiplied target, then get blended onto the
 * accumulator here. Doing it as a shader pass rather than with fixed-function
 * blending is what buys the non-separable modes (overlay, difference) and keeps
 * per-layer opacity exact.
 */

const COMPOSITE_FS = `#version 300 es
precision highp float;

uniform sampler2D uBase;   // premultiplied
uniform sampler2D uLayer;  // premultiplied
uniform int uMode;
uniform float uOpacity;

in vec2 vUV;
out vec4 outColor;

vec3 blend(int mode, vec3 b, vec3 s) {
  if (mode == 1) return b * s;                              // multiply
  if (mode == 2) return b + s - b * s;                      // screen
  if (mode == 3) return mix(2.0 * b * s,                    // overlay
                            1.0 - 2.0 * (1.0 - b) * (1.0 - s),
                            step(0.5, b));
  if (mode == 4) return min(b, s);                          // darken
  if (mode == 5) return max(b, s);                          // lighten
  if (mode == 6) return abs(b - s);                         // difference
  if (mode == 7) return min(b + s, vec3(1.0));              // add
  return s;                                                 // normal
}

void main() {
  vec4 base = texture(uBase, vUV);
  vec4 layer = texture(uLayer, vUV);

  float as = layer.a * uOpacity;
  float ab = base.a;
  // Blend maths is defined on straight colour, so un-premultiply, blend, and
  // premultiply again on the way out.
  vec3 cs = layer.a > 0.0 ? layer.rgb / layer.a : vec3(0.0);
  vec3 cb = ab > 0.0 ? base.rgb / ab : vec3(0.0);

  vec3 mixed = mix(cs, blend(uMode, cb, cs), ab);
  float ar = as + ab * (1.0 - as);
  vec3 cr = ar > 0.0 ? (as * mixed + ab * (1.0 - as) * cb) / ar : vec3(0.0);

  outColor = vec4(cr * ar, ar);
}
`;

/**
 * Draws a premultiplied texture to screen over the project background.
 *
 * The destination rectangle is a uniform rather than a `gl.viewport` call: a
 * zoomed-in canvas easily asks for a viewport wider than `MAX_VIEWPORT_DIMS`
 * (8192 on some drivers, 16384 on most), and drivers silently clamp it, which
 * lands the image at the wrong size in the wrong place. Transforming the quad
 * has no such ceiling, and it places the image at sub-pixel precision so panning
 * and zooming stay smooth instead of snapping to whole pixels.
 */
const PRESENT_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform vec4 uRect;   // xy = origin in clip space, zw = size in clip space
out vec2 vUV;
void main() {
  vec2 unit = aPos * 0.5 + 0.5;
  vUV = unit;
  gl_Position = vec4(uRect.xy + unit * uRect.zw, 0.0, 1.0);
}
`;

const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uSource;
// Where the picture sits inside uTex: the whole of it for the canvas-space
// composite, a sub-rectangle for the screen-sized detail pass.
uniform vec4 uTexRect;
uniform vec4 uBackground;
// Preview-only comparison, all of it here in the screen pass and nowhere on the
// export path: 0 = the drawing, 1 = the original photo, 2 = split at uSplit.
uniform int uView;
uniform float uSplit;      // 0..1 across the picture
uniform float uLine;       // divider half-width, in picture UV
uniform float uUnder;      // 0..1, the photo shown through the paper
// The Inks view: the photo with every pixel given its closest ink, flat.
uniform int uInkCount;
uniform vec3 uInk[9];
uniform vec3 uInkLab[9];
uniform vec2 uBand[9];
uniform int uInkMode;      // 0 closest colour, 1 closest lightness, 2 tone ranges
uniform vec3 uPaperRGB;
in vec2 vUV;
out vec4 outColor;

float toLinear(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
vec3 oklab(vec3 c) {
  vec3 l = vec3(toLinear(c.r), toLinear(c.g), toLinear(c.b));
  float L = pow(max(0.4122214708 * l.r + 0.5363325363 * l.g + 0.0514459929 * l.b, 0.0), 1.0 / 3.0);
  float M = pow(max(0.2119034982 * l.r + 0.6806995451 * l.g + 0.1073969566 * l.b, 0.0), 1.0 / 3.0);
  float S = pow(max(0.0883024619 * l.r + 0.2817188376 * l.g + 0.6299787005 * l.b, 0.0), 1.0 / 3.0);
  return vec3(0.2104542553 * L + 0.7936177850 * M - 0.0040720468 * S,
              1.9779984951 * L - 2.4285922050 * M + 0.4505937099 * S,
              0.0259040371 * L + 0.7827717662 * M - 0.8086757660 * S);
}
vec3 inksOf(vec3 photo) {
  vec3 p = oklab(photo);
  if (uInkMode == 2) {
    for (int i = 0; i < 9; i++) {
      if (i >= uInkCount) break;
      if (p.x >= uBand[i].x && p.x < uBand[i].y) return uInk[i];
    }
    return uPaperRGB;
  }
  float k = uInkMode == 1 ? 0.0 : 1.0;
  float best = 1e9;
  vec3 c = uPaperRGB;
  for (int i = 0; i < 9; i++) {
    if (i >= uInkCount) break;
    vec3 d = p - uInkLab[i];
    float e = d.x * d.x + k * (d.y * d.y + d.z * d.z);
    if (e < best) { best = e; c = uInk[i]; }
  }
  return c;
}

void main() {
  // The shared geometry is an oversized triangle, so everything past the
  // destination rectangle has to drop out; leaving it to CLAMP_TO_EDGE would
  // smear the border pixels across the rest of the view.
  if (any(lessThan(vUV, vec2(0.0))) || any(greaterThan(vUV, vec2(1.0)))) discard;
  vec4 c = texture(uTex, uTexRect.xy + vUV * uTexRect.zw);
  // The source is uploaded top row first, the stack is rendered bottom-up.
  vec3 photo = texture(uSource, vec2(vUV.x, 1.0 - vUV.y)).rgb;
  vec3 bg = uBackground.rgb * uBackground.a;
  float bgA = uBackground.a;
  if (uUnder > 0.0) {
    // The photo seen through the paper, under the ink: a guide for judging
    // where the marks sit, as a tracing would be.
    bg = mix(bg, photo, uUnder);
    bgA = mix(bgA, 1.0, uUnder);
  }
  vec4 drawing = vec4(c.rgb + bg * (1.0 - c.a), c.a + bgA * (1.0 - c.a));
  vec4 original = vec4(photo, 1.0);
  if (uView == 3) {
    outColor = vec4(inksOf(photo), 1.0);
  } else if (uView == 1) {
    outColor = original;
  } else if (uView == 2) {
    float d = vUV.x - uSplit;
    if (abs(d) < uLine) outColor = vec4(1.0, 0.608, 0.129, 1.0);
    else outColor = d < 0.0 ? original : drawing;
  } else {
    outColor = drawing;
  }
}
`;

/**
 * The inks the Inks view reduces the photo to: colours with an optional paper
 * as the last candidate, matched by colour, by lightness, or by tone ranges.
 */
export type PreviewInks = {
  colours: [number, number, number][];
  mode: 'colour' | 'tone' | 'ranges';
  bands?: [number, number][];
  paper: [number, number, number] | null;
};

/** How the screen shows the picture. Never reaches an export. */
export type PreviewView = {
  view: 'drawing' | 'original' | 'split' | 'inks';
  inks?: PreviewInks;
  /** Divider position, 0..1 across the picture. */
  split: number;
  /** 0..1: how much of the photo shows through the paper under the drawing. */
  under: number;
};

export const DEFAULT_PREVIEW: PreviewView = { view: 'drawing', split: 0.5, under: 0 };

export class Compositor {
  private compositeProg: Program;
  private presentProg: Program;

  constructor(private gl: GL, private quad: WebGLVertexArrayObject) {
    this.compositeProg = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, 'composite');
    this.presentProg = createProgram(gl, PRESENT_VS, PRESENT_FS, 'present');
  }

  /** Blend `layerTex` onto `baseTex`, writing to the currently bound target. */
  composite(baseTex: WebGLTexture, layerTex: WebGLTexture, mode: BlendMode, opacity: number): void {
    const { gl } = this;
    const u = this.compositeProg.uniforms;
    gl.useProgram(this.compositeProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, baseTex);
    gl.uniform1i(u.uBase!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, layerTex);
    gl.uniform1i(u.uLayer!, 1);
    gl.uniform1i(u.uMode!, Math.max(0, BLEND_MODES.indexOf(mode)));
    gl.uniform1f(u.uOpacity!, opacity);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /**
   * `rect` is the destination in clip space — origin then size. It defaults to
   * the whole target, which is what the export path wants; the screen passes the
   * placed, zoomed canvas rectangle.
   */
  present(
    tex: WebGLTexture,
    background: [number, number, number, number],
    rect: [number, number, number, number] = [-1, -1, 2, 2],
    /**
     * The screen's comparison view. Only `Engine.presentToScreen` passes one;
     * the export path leaves it out and always gets the plain drawing.
     */
    preview?: { source: WebGLTexture | null; view: PreviewView; linePx: number; widthPx: number },
    texRect: [number, number, number, number] = [0, 0, 1, 1],
  ): void {
    const { gl } = this;
    const u = this.presentProg.uniforms;
    gl.useProgram(this.presentProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.uTex!, 0);
    const view = preview?.source ? preview.view : DEFAULT_PREVIEW;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, preview?.source ?? tex);
    gl.uniform1i(u.uSource!, 1);
    gl.uniform1i(u.uView!, view.view === 'original' ? 1 : view.view === 'split' ? 2 : view.view === 'inks' ? 3 : 0);
    const inks = view.inks;
    const cols = inks ? [...inks.colours, ...(inks.paper && inks.mode !== 'ranges' ? [inks.paper] : [])].slice(0, 9) : [];
    const rgb = new Float32Array(27);
    const lab = new Float32Array(27);
    const band = new Float32Array(18);
    cols.forEach((c, i) => {
      rgb.set(c, i * 3);
      lab.set(oklab(c[0], c[1], c[2]), i * 3);
      const b = inks?.bands?.[i];
      if (b) band.set(b, i * 2);
    });
    gl.uniform1i(u.uInkCount!, cols.length);
    gl.uniform3fv(u.uInk!, rgb);
    gl.uniform3fv(u.uInkLab!, lab);
    gl.uniform2fv(u.uBand!, band);
    gl.uniform1i(u.uInkMode!, inks?.mode === 'tone' ? 1 : inks?.mode === 'ranges' ? 2 : 0);
    const pp = inks?.paper ?? [1, 1, 1];
    gl.uniform3f(u.uPaperRGB!, pp[0], pp[1], pp[2]);
    gl.uniform1f(u.uSplit!, view.split);
    gl.uniform1f(u.uLine!, preview ? preview.linePx / Math.max(1, preview.widthPx) : 0);
    gl.uniform1f(u.uUnder!, view.under);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform4f(u.uRect!, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform4f(u.uTexRect!, texRect[0], texRect[1], texRect[2], texRect[3]);
    gl.uniform4f(u.uBackground!, background[0], background[1], background[2], background[3]);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteProgram(this.compositeProg.program);
    this.gl.deleteProgram(this.presentProg.program);
  }
}
