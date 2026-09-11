/**
 * Thin WebGL2 helpers. No framework, no scene graph — the renderer only ever
 * draws instanced quads and full-screen passes, so this is all the abstraction
 * that earns its keep.
 */

export type GL = WebGL2RenderingContext;

export class GLError extends Error {}

export type ContextInfo = { gl: GL; floatRender: boolean; floatBlend: boolean };

export function createContext(canvas: HTMLCanvasElement): ContextInfo {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false, // shapes are antialiased analytically from the SDF
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new GLError('WebGL2 is not available.');

  // The Voronoi relaxation needs both: float render targets to hold site
  // coordinates at usable precision, and float *blending* to sum weighted
  // centroids additively. WebGL2 gates the second behind its own extension, and
  // without it the accumulation pass silently contributes nothing — so the
  // engine checks for both before offering the algorithm at all.
  const floatRender = !!gl.getExtension('EXT_color_buffer_float');
  const floatBlend = !!gl.getExtension('EXT_float_blend');
  gl.getExtension('OES_texture_float_linear');

  return { gl, floatRender, floatBlend };
}

function compile(gl: GL, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    gl.deleteShader(sh);
    throw new GLError(`Shader compile failed (${label}):\n${log}`);
  }
  return sh;
}

export type Program = {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  attribs: Record<string, number>;
};

export function createProgram(gl: GL, vsSrc: string, fsSrc: string, label = 'program'): Program {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, `${label}.vert`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, `${label}.frag`);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '';
    gl.deleteProgram(program);
    throw new GLError(`Program link failed (${label}):\n${log}`);
  }

  // Cache locations up front — `getUniformLocation` during a draw loop is a
  // surprisingly common source of frame-time noise.
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  const nU = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < nU; i++) {
    const info = gl.getActiveUniform(program, i)!;
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  const attribs: Record<string, number> = {};
  const nA = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < nA; i++) {
    const info = gl.getActiveAttrib(program, i)!;
    attribs[info.name] = gl.getAttribLocation(program, info.name);
  }
  return { program, uniforms, attribs };
}

/** A colour-only render target. */
export class RenderTarget {
  readonly fbo: WebGLFramebuffer;
  readonly texture: WebGLTexture;
  readonly levels: number;

  constructor(
    private gl: GL,
    public width: number,
    public height: number,
    internalFormat: number = gl.RGBA8,
    filter: number = gl.LINEAR,
    /** Allocate a mip chain, for targets that get displayed below 1:1. */
    mipmap = false,
  ) {
    this.levels = mipmap ? 1 + Math.floor(Math.log2(Math.max(width, height))) : 1;
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, this.levels, internalFormat, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new GLError(`Incomplete framebuffer (0x${status.toString(16)}) at ${width}x${height}`);
    }
  }

  bind(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }

  /**
   * Rebuild the mip chain and pick the filter for a given on-screen size.
   *
   * Sampling a stipple render below 1:1 with plain LINEAR point-samples between
   * the dots: the marks alias into grain and the overall tone drifts. Averaging
   * down through mips is what makes a zoomed-out preview read as the printed
   * image rather than as noise.
   */
  setDisplayScale(scale: number): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (scale < 1 && this.levels > 1) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
  }

  clear(r = 0, g = 0, b = 0, a = 0): void {
    const { gl } = this;
    this.bind();
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.fbo);
    this.gl.deleteTexture(this.texture);
  }
}

/** Shared unit quad used by every full-screen pass. */
export function createFullscreenQuad(gl: GL): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  const buf = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;
