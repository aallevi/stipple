import type { ImageSource } from './density';

/**
 * A synthetic image so the app is never staring at an empty canvas.
 *
 * Chosen to exercise the things stippling is judged on: a smooth full-range
 * ramp, a hard edge, and a soft radial falloff. If a distribution bands, clips
 * or aliases, it shows up here immediately.
 */
export function testCard(width = 900, height = 900): ImageSource {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const cx = width * 0.42;
  const cy = height * 0.42;
  const r = Math.min(width, height) * 0.34;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Diagonal ramp as the base tone.
      let v = 0.15 + 0.7 * ((x / width) * 0.45 + (y / height) * 0.55);

      // A sphere-ish highlight and terminator over it.
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d < 1) {
        const z = Math.sqrt(1 - d * d);
        const light = Math.max(0, 0.55 * z + 0.45 * (1 - (x - cx) / r) * 0.5);
        v = 0.08 + 0.9 * Math.min(1, light);
      }

      // A hard-edged bar to check for aliasing along a straight boundary.
      if (y > height * 0.78 && y < height * 0.88 && x > width * 0.1 && x < width * 0.9) {
        v = ((x / width) * 6) % 1 < 0.5 ? 0.05 : 0.95;
      }

      const c = Math.round(Math.min(1, Math.max(0, v)) * 255);
      const i = (y * width + x) * 4;
      rgba[i] = c;
      rgba[i + 1] = c;
      rgba[i + 2] = c;
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}
