import type { VoronoiParams } from '../core/types';
import { mulberry32 } from '../core/rng';
import { createFullscreenQuad, createProgram, FULLSCREEN_VS, RenderTarget, type GL, type Program } from '../gl/context';
import { allocPoints, inkAt, type GenContext, type PointBuffer } from './types';

/**
 * Weighted Voronoi stippling (Secord 2002) with Lloyd relaxation run entirely
 * on the GPU.
 *
 * The usual implementation builds a Delaunay triangulation on the CPU each
 * iteration and falls over somewhere around 20k points. Here every iteration is
 * a fixed ~13 draw calls regardless of point count:
 *
 *   1. seed    — splat sites into a grid as (position, index)
 *   2. flood   — a handful of jump-flooding passes, giving every pixel its
 *                nearest site; this *is* the Voronoi diagram, no triangulation
 *   3. scatter — one additive point per grid pixel into a per-site accumulator,
 *                summing (w·x, w·y, w, n) where w is local ink
 *   4. update  — divide to get each cell's weighted centroid, which becomes the
 *                site's new position
 *
 * Every step reads its input from a texture and writes to a texture, so an
 * iteration never travels back through the CPU — the one readback happens after
 * the last iteration. That is what lets 100k points relax at the same cost per
 * iteration as 5k.
 */

const SEED_VS = `#version 300 es
precision highp float;
uniform sampler2D uSites;
uniform int uSiteDim;
out vec3 vSite;

void main() {
  // Positions are read straight out of the site texture rather than a vertex
  // buffer, so an iteration never has to travel back through the CPU.
  int i = gl_VertexID;
  vec4 site = texelFetch(uSites, ivec2(i % uSiteDim, i / uSiteDim), 0);
  vSite = vec3(site.xy, float(i));
  gl_Position = vec4(site.xy * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const SEED_FS = `#version 300 es
precision highp float;
in vec3 vSite;
out vec4 outColor;
void main() { outColor = vec4(vSite, 1.0); }
`;

const FLOOD_FS = `#version 300 es
precision highp float;
uniform sampler2D uJFA;
uniform vec2 uTexel;
uniform float uStep;
in vec2 vUV;
out vec4 outColor;

void main() {
  vec4 best = texture(uJFA, vUV);
  // An unseeded texel carries w = 0; give it an unreachable distance so any real
  // candidate wins.
  float bestD = best.w > 0.5 ? distance(best.xy, vUV) : 1e9;

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 uv = vUV + vec2(float(dx), float(dy)) * uStep * uTexel;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
      vec4 c = texture(uJFA, uv);
      if (c.w < 0.5) continue;
      float d = distance(c.xy, vUV);
      if (d < bestD) { bestD = d; best = c; }
    }
  }
  outColor = best;
}
`;

/** One additive point per grid pixel, routed to its owning site's accumulator. */
const SCATTER_VS = `#version 300 es
precision highp float;
uniform sampler2D uJFA;
uniform sampler2D uDensity;
uniform int uGrid;
uniform int uSiteDim;
uniform float uGamma;
uniform bool uInvert;
uniform vec2 uToneRange;
out vec4 vAccum;

void main() {
  int px = gl_VertexID % uGrid;
  int py = gl_VertexID / uGrid;
  vec4 cell = texelFetch(uJFA, ivec2(px, py), 0);
  vec2 uv = (vec2(px, py) + 0.5) / float(uGrid);

  float tone = texture(uDensity, uv).r;
  float w = 0.0;
  if (cell.w > 0.5 && tone >= uToneRange.x && tone <= uToneRange.y) {
    float ink = uInvert ? tone : 1.0 - tone;
    w = pow(max(ink, 0.0), uGamma);
  }
  vAccum = vec4(uv * w, w, 1.0);

  int index = int(cell.z + 0.5);
  int sx = index % uSiteDim;
  int sy = index / uSiteDim;
  vec2 target = (vec2(sx, sy) + 0.5) / float(uSiteDim);
  // A zero-weight sample still needs somewhere to land; sending it to its own
  // site with w = 0 keeps the arithmetic clean and costs nothing.
  gl_Position = vec4(target * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const SCATTER_FS = `#version 300 es
precision highp float;
in vec4 vAccum;
out vec4 outColor;
void main() { outColor = vAccum; }
`;

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uAccum;
uniform sampler2D uSites;
in vec2 vUV;
out vec4 outColor;

void main() {
  vec4 acc = texture(uAccum, vUV);
  vec4 old = texture(uSites, vUV);
  // A cell can end up with no ink at all (it drifted into a blown highlight).
  // Leaving the site where it is lets neighbouring cells push it out naturally
  // over the next few iterations, which is stabler than teleporting it.
  vec2 mean = acc.z > 1e-6 ? acc.xy / acc.z : old.xy;
  outColor = vec4(clamp(mean, 0.0, 1.0), old.z, old.w);
}
`;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * GPU resources for the relaxation, kept alive across calls so that dragging the
 * iteration count does not thrash allocations.
 */
export class VoronoiGPU {
  private quad: WebGLVertexArrayObject;
  private seedProg: Program;
  private floodProg: Program;
  private scatterProg: Program;
  private updateProg: Program;
  private emptyVAO: WebGLVertexArrayObject;

  private jfa: [RenderTarget, RenderTarget] | null = null;
  private sites: [RenderTarget, RenderTarget] | null = null;
  private accum: RenderTarget | null = null;
  private densityTex: WebGLTexture | null = null;
  private gridSize = 0;
  private siteDim = 0;

  constructor(private gl: GL) {
    this.quad = createFullscreenQuad(gl);
    this.seedProg = createProgram(gl, SEED_VS, SEED_FS, 'voronoi.seed');
    this.floodProg = createProgram(gl, FULLSCREEN_VS, FLOOD_FS, 'voronoi.flood');
    this.scatterProg = createProgram(gl, SCATTER_VS, SCATTER_FS, 'voronoi.scatter');
    this.updateProg = createProgram(gl, FULLSCREEN_VS, UPDATE_FS, 'voronoi.update');

    this.emptyVAO = gl.createVertexArray()!;
  }

  private ensureTargets(grid: number, siteDim: number): void {
    const { gl } = this;
    if (this.gridSize !== grid) {
      this.jfa?.forEach((t) => t.dispose());
      this.jfa = [
        new RenderTarget(gl, grid, grid, gl.RGBA32F, gl.NEAREST),
        new RenderTarget(gl, grid, grid, gl.RGBA32F, gl.NEAREST),
      ];
      this.gridSize = grid;
    }
    if (this.siteDim !== siteDim) {
      this.sites?.forEach((t) => t.dispose());
      this.accum?.dispose();
      this.sites = [
        new RenderTarget(gl, siteDim, siteDim, gl.RGBA32F, gl.NEAREST),
        new RenderTarget(gl, siteDim, siteDim, gl.RGBA32F, gl.NEAREST),
      ];
      this.accum = new RenderTarget(gl, siteDim, siteDim, gl.RGBA32F, gl.NEAREST);
      this.siteDim = siteDim;
    }
  }

  private uploadDensity(lum: Float32Array, w: number, h: number): void {
    const { gl } = this;
    if (this.densityTex) gl.deleteTexture(this.densityTex);
    this.densityTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.densityTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, w, h);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, lum);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Returns relaxed site positions in grid space (0..1), interleaved xy. */
  relax(p: VoronoiParams, ctx: GenContext, seeds: Float32Array, count: number): Float32Array {
    const { gl } = this;
    // Around 24 grid pixels per Voronoi cell: enough for a stable centroid, and
    // small enough that the flood passes stay cheap. The cap matters — the flood
    // cost is quadratic in the grid edge, so an unbounded grid would make high
    // point counts far slower than the algorithm needs to be.
    const grid = Math.min(1024, Math.max(256, nextPow2(Math.ceil(Math.sqrt(count * 24)))));
    const siteDim = nextPow2(Math.ceil(Math.sqrt(count)));
    this.ensureTargets(grid, siteDim);
    this.uploadDensity(ctx.density.lum, ctx.density.width, ctx.density.height);

    const jfa = this.jfa!;
    const sites = this.sites!;
    const accum = this.accum!;

    // Seed the site texture by rendering the initial positions into it.
    const initial = new Float32Array(siteDim * siteDim * 4);
    for (let i = 0; i < count; i++) {
      initial[i * 4] = seeds[i * 2];
      initial[i * 4 + 1] = seeds[i * 2 + 1];
      initial[i * 4 + 2] = i;
      initial[i * 4 + 3] = 1;
    }
    gl.bindTexture(gl.TEXTURE_2D, sites[0].texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, siteDim, siteDim, gl.RGBA, gl.FLOAT, initial);

    gl.disable(gl.BLEND);
    let src = 0;

    const iterations = Math.max(0, Math.floor(p.iterations));
    for (let iter = 0; iter < iterations; iter++) {
      this.buildDiagram(sites[src], count, grid, siteDim, jfa);
      this.accumulate(jfa[0], accum, grid, siteDim, p);

      // update: accum + old sites -> new sites
      const dst = 1 - src;
      sites[dst].bind();
      gl.useProgram(this.updateProg.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, accum.texture);
      gl.uniform1i(this.updateProg.uniforms.uAccum!, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sites[src].texture);
      gl.uniform1i(this.updateProg.uniforms.uSites!, 1);
      gl.bindVertexArray(this.quad);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = dst;
    }

    const out = new Float32Array(siteDim * siteDim * 4);
    sites[src].bind();
    gl.readPixels(0, 0, siteDim, siteDim, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);

    const result = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      result[i * 2] = out[i * 4];
      result[i * 2 + 1] = out[i * 4 + 1];
    }
    return result;
  }

  /** Splat sites, then jump-flood until every pixel knows its nearest one. */
  private buildDiagram(
    siteTex: RenderTarget,
    count: number,
    grid: number,
    siteDim: number,
    jfa: [RenderTarget, RenderTarget],
  ): void {
    const { gl } = this;

    jfa[0].clear(0, 0, 0, 0);
    gl.useProgram(this.seedProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, siteTex.texture);
    gl.uniform1i(this.seedProg.uniforms.uSites!, 0);
    gl.uniform1i(this.seedProg.uniforms.uSiteDim!, siteDim);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.POINTS, 0, count);

    // Textbook JFA starts at grid/2, which is only necessary when seeds may be
    // an entire grid apart. Here they are dense — mean spacing is
    // grid/sqrt(count) pixels — so starting a few multiples above that spacing
    // is enough to reach every seed, and it cuts the pass count roughly in half
    // for typical point counts.
    const spacing = grid / Math.max(1, Math.sqrt(count));
    const start = Math.min(grid / 2, Math.max(1, nextPow2(Math.ceil(spacing * 4))));

    let read = 0;
    gl.useProgram(this.floodProg.program);
    gl.uniform2f(this.floodProg.uniforms.uTexel!, 1 / grid, 1 / grid);
    gl.bindVertexArray(this.quad);
    for (let step = start; step >= 1; step /= 2) {
      const write = 1 - read;
      jfa[write].bind();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, jfa[read].texture);
      gl.uniform1i(this.floodProg.uniforms.uJFA!, 0);
      gl.uniform1f(this.floodProg.uniforms.uStep!, step);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      read = write;
    }
    // A final step-1 pass cleans up the islands JFA is known to leave behind.
    {
      const write = 1 - read;
      jfa[write].bind();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, jfa[read].texture);
      gl.uniform1i(this.floodProg.uniforms.uJFA!, 0);
      gl.uniform1f(this.floodProg.uniforms.uStep!, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      read = write;
    }

    // Leave the finished diagram in slot 0 so callers need not track parity.
    if (read !== 0) {
      const t = jfa[0];
      jfa[0] = jfa[1];
      jfa[1] = t;
    }
  }

  /** Additive scatter of every grid pixel into its site's accumulator texel. */
  private accumulate(
    jfa: RenderTarget,
    accum: RenderTarget,
    grid: number,
    siteDim: number,
    p: VoronoiParams,
  ): void {
    const { gl } = this;
    accum.clear(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquation(gl.FUNC_ADD);

    gl.useProgram(this.scatterProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, jfa.texture);
    gl.uniform1i(this.scatterProg.uniforms.uJFA!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.densityTex!);
    gl.uniform1i(this.scatterProg.uniforms.uDensity!, 1);
    gl.uniform1i(this.scatterProg.uniforms.uGrid!, grid);
    gl.uniform1i(this.scatterProg.uniforms.uSiteDim!, siteDim);
    gl.uniform1f(this.scatterProg.uniforms.uGamma!, p.gamma);
    gl.uniform1i(this.scatterProg.uniforms.uInvert!, p.invertDensity ? 1 : 0);
    gl.uniform2f(this.scatterProg.uniforms.uToneRange!, p.toneRange[0], p.toneRange[1]);

    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.POINTS, 0, grid * grid);
    gl.disable(gl.BLEND);
  }

  dispose(): void {
    const { gl } = this;
    this.jfa?.forEach((t) => t.dispose());
    this.sites?.forEach((t) => t.dispose());
    this.accum?.dispose();
    if (this.densityTex) gl.deleteTexture(this.densityTex);
    gl.deleteVertexArray(this.emptyVAO);
  }
}

/**
 * Seed sites proportional to ink, then relax.
 *
 * Importance-sampling the seed matters: uniformly seeded sites spend most of the
 * relaxation budget just migrating out of the highlights, so the same iteration
 * count looks markedly worse.
 */
export function generateVoronoi(
  p: VoronoiParams,
  ctx: GenContext,
  gpu: VoronoiGPU | null,
): PointBuffer {
  const { density, width, height, mask } = ctx;
  const target = Math.min(ctx.maxPoints, Math.max(1, Math.floor(p.points * ctx.quality)));
  const rng = mulberry32(p.seed);

  const weight = (lum: number): number => {
    const ink = inkAt(lum, p.invertDensity, p.toneRange, mask);
    return Math.pow(Math.max(ink, 0), p.gamma);
  };
  const { rows, total } = density.buildCDF(weight);
  const grand = total[density.height - 1];

  const seeds = new Float32Array(target * 2);
  if (grand <= 1e-9) {
    // Nothing to stipple — fall back to uniform so the layer is not silently empty.
    for (let i = 0; i < target; i++) {
      seeds[i * 2] = rng();
      seeds[i * 2 + 1] = rng();
    }
  } else {
    for (let i = 0; i < target; i++) {
      const r = rng() * grand;
      const y = lowerBound(total, r, 0, density.height - 1);
      // `rows` restarts its running sum on every row, so the within-row search
      // must use the row's own weight, not the global cumulative position.
      const rowWeight = total[y] - (y > 0 ? total[y - 1] : 0);
      const x = lowerBound(
        rows,
        rng() * rowWeight,
        y * density.width,
        (y + 1) * density.width - 1,
      ) - y * density.width;
      seeds[i * 2] = (x + rng()) / density.width;
      seeds[i * 2 + 1] = (y + rng()) / density.height;
    }
  }

  const relaxed = gpu ? gpu.relax(p, ctx, seeds, target) : seeds;

  const { write } = allocPoints(target);
  const sx = density.width;
  const sy = density.height;
  for (let i = 0; i < target; i++) {
    const u = relaxed[i * 2];
    const v = relaxed[i * 2 + 1];
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) continue;
    const x = u * width;
    const y = v * height;
    const tone = density.sample(u * sx, v * sy);
    if (inkAt(tone, p.invertDensity, p.toneRange, mask) <= 0) continue;
    write.push(x, y, tone, density.gradientAt(u * sx, v * sy), rng());
  }
  return write.finish();
}

/** First index in [lo, hi] whose value is >= target. */
function lowerBound(arr: Float32Array, target: number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (arr[mid] < target) a = mid + 1;
    else b = mid;
  }
  return a;
}
