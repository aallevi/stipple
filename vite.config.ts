import { defineConfig } from 'vite';

// Tauri expects a fixed port and hides vite's own error overlay noise.
export default defineConfig({
  clearScreen: false,
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
  worker: { format: 'es' },
});
