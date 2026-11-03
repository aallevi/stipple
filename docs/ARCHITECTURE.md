# Stipple — architecture

How the engine is put together, and how it is tested. For using the app, see the
[guide](GUIDE.md).

## How it works

```
source image ─┐
              ├─► density map ──► distribution ──► point buffer ──┐
layers below ─┘   (prefilter,      (jittered /      (x, y, tone,  │
                   gradient,        voronoi /        gradient,    │
                   mip chain)       halftone)        random)      │
                                                                  ▼
                                        shape atlas (SDF) ──► instanced draw ──► layer FBO
                                                                                     │
                                                            blend mode + opacity ────┤
                                                                                     ▼
                                                                              composited stack
```

**The dirty graph** (`src/core/store.ts`, `src/pipeline/engine.ts`). Every mutation
declares how much it invalidates, derived from which fields it touches:

| Edit | Invalidates |
|---|---|
| colour, size, rotation, opacity, blend, shape | the draw only |
| density, algorithm, tone mask | that layer's points |
| prefilter, input source | that layer's density map, then its points |
| source image, canvas size | everything |

A change also cascades *upward* to any layer above it that reads from below, and never
downward. Layers cache their density map, point buffer and GPU batch independently.

**Weighted Voronoi on the GPU** (`src/dist/voronoi.ts`). The textbook implementation
rebuilds a Delaunay triangulation on the CPU every Lloyd iteration and stalls somewhere
around twenty thousand points. Here each iteration is a fixed handful of draw calls:
splat the sites into a grid, jump-flood until every pixel knows its nearest site (that
*is* the Voronoi diagram), additively scatter every grid pixel into its site's
accumulator to sum weighted centroids, then divide. Nothing returns to the CPU until the
last iteration. Sites are seeded by importance sampling the ink, so the relaxation budget
goes into refining rather than migrating points out of the highlights.

**Signed distance fields** (`src/shape/sdf.ts`, `src/shape/atlas.ts`). Shapes are
rasterised once, converted to an SDF by an 8SSEDT sweep, and packed into a single R8
atlas. The fragment shader antialiases from the distance with a threshold that scales
with the drawn size, so a 2px dot on screen and the same dot at 400px in a 300dpi export
are both correct with no regeneration. Sub-pixel points are drawn at one pixel with
alpha carrying the lost area, which keeps dense stipples from thinning out.

**Tiled export** (`src/export/png.ts`). Because point buffers are in canvas space, a 4x
export changes only the view matrix and a size uniform. Tiles are 2048² regardless of
output size, so print resolution does not need a proportionally large render target.

---

## Verification

```bash
npm run typecheck
npm test             # unit tests, no browser needed
npm run verify       # end-to-end checks in headless Chromium
```

`npm test` covers the DOM-free half: the distance transform against exact Euclidean
distances, distribution determinism and tonal response, the prefilter ordering, the
store's invalidation levels and history coalescing, and the CPU mirror of the point
shader that vector export relies on.

`npm run verify` needs `npm run dev` running in another terminal (it drives a debug handle that only dev builds expose). It drives a real
browser through every preset, checks each one actually puts ink on the canvas, imports
an SVG and a PNG as shapes and confirms both render and reach the vector export, proves
a `Reads from → Layers below` layer differs from the same layer reading the source,
round-trips all three export formats, and asserts the dirty graph does no work it should
not. Screenshots and sample exports land in `artifacts/`.

Two notes on what those numbers mean. Headless Chromium rasterises through SwiftShader,
so wall-clock draw timings from `verify` are software-rasteriser figures and are not
reported as GPU performance. Point generation is CPU work and is reported: a
240,000-point stack builds in around 45ms.

---

## Layout

```
src/
  core/       project model, store with dirty levels, undo, seeded RNG
  image/      decode, density map (prefilter, gradient, mips, CDF), test card
  dist/       point generators: jittered, voronoi (GPU), halftone
  shape/      SDF generation, atlas, rasteriser, SVG/raster import
  gl/         context helpers, instanced point renderer, compositor
  pipeline/   engine — owns GPU resources and every cache
  export/     png (tiled), svg, pdf, and the shared shader mirror
  ui/         panels, controls, shape parameters, presets
src-tauri/    desktop shell; Rust decodes TIFF, which web views cannot
```
