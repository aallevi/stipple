import { defineConfig } from 'vite';

// Tauri expects a fixed port and hides vite's own error overlay noise.
export default defineConfig({
  clearScreen: false,
  // Relative asset paths, so the built `dist/` works from any folder or URL
  // prefix, not only the root of a server.
  base: './',
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    sourcemap: true,
  },
  preview: { port: 4173 },
  worker: { format: 'es' },
});
