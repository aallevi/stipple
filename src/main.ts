import './style.css';
import { App } from './ui/app';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

try {
  const app = new App(root);
  if (import.meta.env.DEV) {
    // A console handle for poking at the engine, and the surface the
    // verification script drives.
    (window as unknown as Record<string, unknown>).__stipple = {
      app,
      ...app.debug,
      exportSVG: async () => (await import('./export/svg')).exportSVG(app.debug.engine, app.debug.store.get()),
      exportPDF: async () => (await import('./export/pdf')).exportPDF(app.debug.engine, app.debug.store.get()),
      exportPNG: async (scale = 1) =>
        (await import('./export/png')).exportPNG(app.debug.engine, app.debug.store.get(), scale),
      exportPlates: async () =>
        (await import('./export/plates')).exportPlates(app.debug.engine, app.debug.store.get(), { baseName: 'verify' }),
      presets: async () => (await import('./ui/presets')).PRESETS.map((p) => p.name),
      importShape: async (name: string, bytes: Uint8Array) => {
        const { importShape } = await import('./shape/import');
        const { def, bitmap } = await importShape(name, bytes);
        if (bitmap) app.debug.engine.setShapeBitmap(def.id, bitmap);
        app.debug.store.updateShapes([...app.debug.store.get().shapes, def]);
        return def;
      },
    };
  }
} catch (err) {
  // A missing WebGL2 context is the one failure worth explaining in plain
  // language rather than leaving as a blank window.
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal';
  box.innerHTML = `<h1>Stipple could not start</h1><p>${(err as Error).message}</p>`;
  root.append(box);
  console.error(err);
}
