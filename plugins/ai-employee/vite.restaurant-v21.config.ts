import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  server: { host: '127.0.0.1', port: 4188, strictPort: true },
  build: {
    outDir: '../../.artifacts/restaurant-v21/dist', emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./design/restaurant-v2.1.html', import.meta.url)) },
  },
});
