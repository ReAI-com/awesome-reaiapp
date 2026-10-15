import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Independent multi-page preview bundle; existing build/Host entry points stay intact.
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 4188, strictPort: true },
  build: {
    outDir: '../../.artifacts/employee-versions/dist', emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries([
        ['home', 'index.html'], ['generic', 'design/paradigm-v2.html'],
        ['showcase', 'showcase.html'], ['restaurant', 'design/restaurant-v2.1.html'],
        ['template', 'preview.html'],
      ].map(([name, path]) => [name, fileURLToPath(new URL(path, import.meta.url))])),
    },
  },
});
