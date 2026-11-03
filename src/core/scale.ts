import type { CanvasSettings, Layer, Project } from './types';

/**
 * The document unit, and the one place relative lengths become pixels.
 *
 * Every length a layer carries — mark size, blur radius, transform offset — is
 * stored as a fraction of the canvas's *short edge* rather than as a count of
 * canvas pixels. That is what makes a project mean the same thing at any
 * document size: resizing the document, or opening a photograph of a different
 * shape, rescales the whole drawing bodily instead of leaving every mark the
 * same number of pixels across a picture that got bigger underneath it.
 *
 * The short edge, not the long one or the diagonal, so a portrait crop and a
 * landscape one agree about what a given fraction means. It is the same
 * convention `units.ts` already writes its `%` readout in, so "0.004" here and
 * "0.4 %" in the panel are the same number.
 *
 * Distributions are the exception and take the unit directly (`GenContext.unit`)
 * rather than arriving pre-resolved: a dot *count* is not a length, and turning
 * one into a spacing is the generator's own business.
 */
export function unitPx(canvas: CanvasSettings): number {
  return Math.max(1, Math.min(canvas.width, canvas.height));
}

/**
 * A copy of `layer` with every relative length multiplied out to canvas pixels.
 *
 * Resolving to a whole layer rather than at each read means everything
 * downstream of this call — the vertex shader's uniforms, the CPU mirror in
 * `export/geometry.ts`, the density map's blur — keeps working in canvas pixels
 * and never learns that storage is relative. There is exactly one conversion,
 * and it is here.
 *
 * The copy is shallow per field and cheap: a handful of numbers per layer, once
 * per layer per render, against a pass that touches millions of points.
 */
export function resolveLayer(layer: Layer, unit: number): Layer {
  return {
    ...layer,
    prefilter: { ...layer.prefilter, blur: layer.prefilter.blur * unit },
    size: { ...layer.size, min: layer.size.min * unit, max: layer.size.max * unit },
    transform: {
      ...layer.transform,
      offsetX: layer.transform.offsetX * unit,
      offsetY: layer.transform.offsetY * unit,
    },
  };
}

/** Every layer of a project resolved at once, for the exporters. */
export function resolvedLayers(project: Project): Layer[] {
  const unit = unitPx(project.canvas);
  return project.layers.map((l) => resolveLayer(l, unit));
}
