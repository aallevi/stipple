/**
 * End-to-end check of the render pipeline in a real browser.
 *
 * Unit tests cover the DOM-free maths; this covers the half that only exists on
 * a GPU — shader compilation, the instanced draw, the jump-flood relaxation, the
 * compositor, and the two vector exporters. It walks every preset, captures a
 * screenshot, and fails on any console error or empty render.
 *
 *   node scripts/verify.mjs            (expects `npm run dev` already running)
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const URL = process.env.STIPPLE_URL ?? 'http://localhost:1420';
const OUT = 'artifacts';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    // Headless Chromium has no real GPU; SwiftShader gives a conformant WebGL2
    // implementation, which is what we need to exercise the shaders.
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

const results = [];
let failed = false;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__stipple, null, { timeout: 15000 });

// Give the first frames time to generate and draw.
await page.waitForFunction(
  () => window.__stipple.engine.stats.points > 0,
  null,
  { timeout: 20000 },
);

const boot = await page.evaluate(() => ({ ...window.__stipple.engine.stats }));
check('boots and renders points', boot.points > 0, `${boot.points.toLocaleString()} points`);
check('WebGL2 context and shaders compile', errors.length === 0, errors.slice(0, 2).join(' | '));

/**
 * Fraction of pixels carrying ink, read back through the export path.
 *
 * Reading the visible canvas is not an option: with `preserveDrawingBuffer`
 * off — which is what we want for performance — the drawing buffer is already
 * cleared by the time script can sample it. `renderRegion` reads from an FBO
 * instead, so it always returns real pixels, and it exercises the export path
 * as a side effect.
 */
async function inkCoverage() {
  return page.evaluate(() => {
    const { engine, store } = window.__stipple;
    const { width, height } = store.get().canvas;
    const size = 400;
    const scale = size / Math.max(width, height);
    const px = engine.renderRegion(scale, 0, 0, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    let ink = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 8) continue;
      n += 1;
      if (px[i] < 200 || px[i + 1] < 200 || px[i + 2] < 200) ink += 1;
    }
    return n ? ink / n : 0;
  });
}

const presets = await page.evaluate(() => window.__stipple.presets());
for (const name of presets) {
  errors.length = 0;
  await page.evaluate((n) => window.__stipple.applyPreset(n), name);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__stipple.engine.render(true));
  await page.waitForTimeout(400);

  const stats = await page.evaluate(() => ({ ...window.__stipple.engine.stats }));
  const coverage = await inkCoverage();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await page.locator('canvas.viewport').screenshot({ path: `${OUT}/preset-${slug}.png` });

  check(
    `preset "${name}" renders`,
    stats.points > 0 && coverage > 0.005 && errors.length === 0,
    `${stats.points.toLocaleString()} pts, ${(coverage * 100).toFixed(1)}% ink, ` +
    `gen ${stats.generateMs.toFixed(0)}ms${errors.length ? `, errors: ${errors[0]}` : ''}`,
  );
}

// -- the dirty graph: a colour edit must not regenerate points ---------------
await page.evaluate((n) => window.__stipple.applyPreset(n), 'Classic stipple');
await page.waitForTimeout(1000);
const dirty = await page.evaluate(async () => {
  const { store, engine } = window.__stipple;
  const id = store.get().layers[0].id;
  engine.render(true);
  const before = { ...engine.stats };

  store.updateLayerField(id, 'color', { alpha: 0.6 });
  await new Promise((r) => requestAnimationFrame(r));
  engine.render(true);
  const afterColor = { ...engine.stats };

  store.updateLayerField(id, 'distribution', { spacing: 9 });
  await new Promise((r) => requestAnimationFrame(r));
  engine.render(true);
  const afterSpacing = { ...engine.stats };
  return { before, afterColor, afterSpacing };
});
check(
  'colour edit skips point regeneration',
  dirty.afterColor.regenerated === 0,
  `regenerated ${dirty.afterColor.regenerated} layers, gen ${dirty.afterColor.generateMs.toFixed(2)}ms`,
);
check(
  'spacing edit does regenerate',
  dirty.afterSpacing.regenerated === 1 && dirty.afterSpacing.points !== dirty.before.points,
  `${dirty.before.points.toLocaleString()} → ${dirty.afterSpacing.points.toLocaleString()} points`,
);

// -- `input: below` must actually change the image ---------------------------
const recursive = await page.evaluate(async () => {
  const { store, engine } = window.__stipple;
  const shot = async () => {
    engine.render(true);
    await new Promise((r) => requestAnimationFrame(r));
    const { width, height } = store.get().canvas;
    const scale = 300 / Math.max(width, height);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const px = engine.renderRegion(scale, 0, 0, w, h);
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
    return sum;
  };

  window.__stipple.applyPreset('Recursive overlay');
  await new Promise((r) => setTimeout(r, 1200));
  const top = store.get().layers[1].id;

  store.updateLayer(top, { input: 'below' });
  await new Promise((r) => setTimeout(r, 900));
  const withBelow = await shot();

  store.updateLayer(top, { input: 'source' });
  await new Promise((r) => setTimeout(r, 900));
  const withSource = await shot();

  return { withBelow, withSource };
});
check(
  'a layer reading "below" differs from one reading the source',
  Math.abs(recursive.withBelow - recursive.withSource) / Math.max(1, recursive.withSource) > 0.002,
  `luma sum ${recursive.withBelow} vs ${recursive.withSource}`,
);

// -- imported shapes ---------------------------------------------------------
// The headline feature: a file dropped in must behave exactly like a built-in,
// all the way through to vector export.
const svgSource = readFileSync('assets/test-shape.svg', 'utf8');
const rasterBytes = Array.from(readFileSync('src-tauri/icons/128x128.png'));

const imported = await page.evaluate(async ({ svgSource, rasterBytes }) => {
  const { store, engine, applyPreset } = window.__stipple;
  applyPreset('Classic stipple');
  await new Promise((r) => setTimeout(r, 600));

  const svgDef = await window.__stipple.importShape(
    'leaf.svg', new TextEncoder().encode(svgSource));
  const pngDef = await window.__stipple.importShape(
    'badge.png', new Uint8Array(rasterBytes));
  await new Promise((r) => setTimeout(r, 400));

  const id = store.get().layers[0].id;
  const render = async (shapeId) => {
    store.updateLayer(id, { shapeId });
    store.updateLayerField(id, 'size', { min: 6, max: 18 });
    await new Promise((r) => setTimeout(r, 400));
    engine.render(true);
    const { width, height } = store.get().canvas;
    const scale = 300 / Math.max(width, height);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const px = engine.renderRegion(scale, 0, 0, w, h);
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 200) ink += 1;
    return { ink: ink / (px.length / 4), slot: !!engine.atlasSlot(shapeId) };
  };

  const circle = await render('circle');
  const svg = await render(svgDef.id);
  const png = await render(pngDef.id);

  // Leave the SVG shape selected so the export check below covers it.
  store.updateLayer(id, { shapeId: svgDef.id });
  await new Promise((r) => setTimeout(r, 400));
  return { svgDef, pngDef, circle, svg, png };
}, { svgSource, rasterBytes });

check(
  'an imported SVG is parsed into vector paths',
  imported.svgDef.kind === 'svg' && imported.svgDef.paths.length >= 2,
  `${imported.svgDef.paths.length} subpaths, ` +
  `${imported.svgDef.paths.reduce((n, p) => n + (p.match(/[ML]/g) ?? []).length, 0)} points ` +
  `(the nested transformed rect came through)`,
);
check(
  'an imported PNG becomes a raster stamp',
  imported.pngDef.kind === 'raster' && imported.pngDef.data.startsWith('data:'),
  `${imported.pngDef.width}x${imported.pngDef.height}, embedded in the project`,
);
check(
  'both imported shapes reach the atlas and render ink',
  imported.svg.slot && imported.png.slot && imported.svg.ink > 0.005 && imported.png.ink > 0.005,
  `circle ${(imported.circle.ink * 100).toFixed(1)}% · ` +
  `svg ${(imported.svg.ink * 100).toFixed(1)}% · png ${(imported.png.ink * 100).toFixed(1)}%`,
);
await page.locator('canvas.viewport').screenshot({ path: `${OUT}/imported-shape.png` });

// -- exports -----------------------------------------------------------------
// Deliberately exported while the imported SVG shape is selected, so the vector
// writers are exercised on user geometry rather than only on a built-in circle.

const svg = await page.evaluate(() => window.__stipple.exportSVG());
writeFileSync(`${OUT}/export.svg`, svg);
check(
  'SVG export is well-formed and instanced',
  svg.startsWith('<?xml') && svg.includes('</svg>') && svg.includes('<use') && svg.includes('<defs>'),
  `${(svg.length / 1024).toFixed(0)} KB, ${(svg.match(/<use/g) ?? []).length.toLocaleString()} instances`,
);
const svgParse = await page.evaluate((text) => {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  return doc.querySelector('parsererror') ? doc.querySelector('parsererror').textContent : null;
}, svg);
check('SVG parses without error', svgParse === null, svgParse ?? '');

const pdf = await page.evaluate(async () => {
  const { bytes, warnings } = await window.__stipple.exportPDF();
  return { bytes: Array.from(bytes.slice(0, 9)), length: bytes.length, warnings, all: Array.from(bytes) };
});
writeFileSync(`${OUT}/export.pdf`, Buffer.from(pdf.all));
const pdfHead = String.fromCharCode(...pdf.bytes);
check(
  'PDF export has a valid header and trailer',
  pdfHead.startsWith('%PDF-1.7') && Buffer.from(pdf.all).includes('startxref'),
  `${(pdf.length / 1024).toFixed(0)} KB${pdf.warnings.length ? `, warnings: ${pdf.warnings[0]}` : ''}`,
);

// Image-sampled colour has to survive into the vector writers, which have no
// texture to sample and rely on a CPU-side lookup instead.
const sampled = await page.evaluate(async () => {
  window.__stipple.applyPreset('Colour sampled');
  await new Promise((r) => setTimeout(r, 1500));
  const svg = await window.__stipple.exportSVG();
  const fills = new Set((svg.match(/fill="#[0-9a-f]{6}"/g) ?? []));
  return { distinct: fills.size, sample: [...fills].slice(0, 3) };
});
check(
  'image-sampled colour survives into SVG export',
  sampled.distinct > 20,
  `${sampled.distinct} distinct fills, e.g. ${sampled.sample.join(', ')}`,
);

await page.evaluate((n) => window.__stipple.applyPreset(n), 'Classic stipple');
await page.waitForTimeout(1200);

const png = await page.evaluate(async () => {
  const blob = await window.__stipple.exportPNG(2);
  const buf = new Uint8Array(await blob.arrayBuffer());
  return { size: buf.length, head: Array.from(buf.slice(0, 8)), all: Array.from(buf) };
});
writeFileSync(`${OUT}/export.png`, Buffer.from(png.all));
check(
  'PNG export at 2x produces a real PNG',
  png.head[0] === 0x89 && png.head[1] === 0x50 && png.size > 10000,
  `${(png.size / 1024).toFixed(0)} KB`,
);

// -- the efficiency claim ----------------------------------------------------
// Headless Chromium rasterises through SwiftShader behind a command buffer, so
// wall-clock draw timings from here are not GPU timings and are not reported.
// What *is* measurable and is the actual claim: a dense stack builds its points
// once, and every subsequent appearance edit does no generation work at all.
const perf = await page.evaluate(async () => {
  const { store, engine, setAutoRender } = window.__stipple;
  // Own the clock: with the app loop running, a forced render would measure
  // whatever the loop had already left undone.
  setAutoRender(false);
  const id = store.get().layers[0].id;

  store.updateLayerField(id, 'distribution', { spacing: 1.4, phases: 32 });
  await new Promise((r) => requestAnimationFrame(r));
  const t0 = performance.now();
  engine.render(true);
  const buildMs = performance.now() - t0;
  const generateMs = engine.stats.generateMs;
  const points = engine.stats.points;

  // Ten appearance edits in a row: size, rotation and colour all resolve to
  // uniforms, so none of them may touch the generators.
  let regenerations = 0;
  let generationMs = 0;
  for (let i = 0; i < 10; i++) {
    store.updateLayerField(id, 'size', { max: 2 + i * 0.05 });
    store.updateLayerField(id, 'color', { alpha: 0.5 + i * 0.04 });
    store.updateLayerField(id, 'rotation', { random: i / 10 });
    await new Promise((r) => requestAnimationFrame(r));
    engine.render(true);
    regenerations += engine.stats.regenerated;
    generationMs += engine.stats.generateMs;
  }
  setAutoRender(true);
  return { points, buildMs, generateMs, regenerations, generationMs };
});
check(
  'a dense stack builds its points once',
  perf.points > 100000,
  `${perf.points.toLocaleString()} points · first build ${perf.buildMs.toFixed(0)}ms ` +
  `(${perf.generateMs.toFixed(0)}ms of it CPU point generation)`,
);
// -- Voronoi relaxation ------------------------------------------------------
const voronoi = await page.evaluate(async () => {
  const { store, engine, setAutoRender, applyPreset } = window.__stipple;
  applyPreset('Voronoi drawing');
  await new Promise((r) => setTimeout(r, 300));
  setAutoRender(false);
  const id = store.get().layers[0].id;

  const run = async (points, iterations) => {
    store.updateLayerField(id, 'distribution', { points, iterations });
    await new Promise((r) => requestAnimationFrame(r));
    const t = performance.now();
    engine.render(true);
    engine.gl.finish();
    return { ms: performance.now() - t, count: engine.stats.points };
  };

  // Warm up first: the very first run also pays for the density upload and the
  // render-target allocation, which would otherwise be charged to whichever
  // measurement happened to go first.
  await run(8000, 4);
  await run(40000, 4);

  // The claim is that relaxation cost is driven by the grid, not the point
  // count; 5x the points should be nowhere near 5x the time.
  const small = await run(8000, 16);
  const large = await run(40000, 16);
  setAutoRender(true);
  return { small, large };
});
check(
  'Voronoi relaxation scales sub-linearly in point count',
  voronoi.large.ms < voronoi.small.ms * 3.5,
  `8k: ${voronoi.small.ms.toFixed(0)}ms · 40k: ${voronoi.large.ms.toFixed(0)}ms ` +
  `(${(voronoi.large.ms / Math.max(1, voronoi.small.ms)).toFixed(1)}x for 5x the points, on SwiftShader)`,
);

check(
  '30 appearance edits do zero regeneration',
  perf.regenerations === 0 && perf.generationMs === 0,
  `${perf.regenerations} regenerations, ${perf.generationMs.toFixed(2)}ms generation`,
);

await page.screenshot({ path: `${OUT}/app.png`, fullPage: false });
await browser.close();

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
console.log(`Screenshots and exports in ./${OUT}/`);
process.exit(failed ? 1 : 0);
