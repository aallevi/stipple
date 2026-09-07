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

/** Draws a premultiplied texture to screen over the project background. */
const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uBackground;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUV);
  vec3 bg = uBackground.rgb * uBackground.a;
  outColor = vec4(c.rgb + bg * (1.0 - c.a), c.a + uBackground.a * (1.0 - c.a));
}
`;

export class Compositor {
  private compositeProg: Program;
  private presentProg: Program;

  constructor(private gl: GL, private quad: WebGLVertexArrayObject) {
    this.compositeProg = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, 'composite');
    this.presentProg = createProgram(gl, FULLSCREEN_VS, PRESENT_FS, 'present');
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

  present(tex: WebGLTexture, background: [number, number, number, number]): void {
    const { gl } = this;
    const u = this.presentProg.uniforms;
    gl.useProgram(this.presentProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.uTex!, 0);
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
