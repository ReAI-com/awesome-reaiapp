import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  server: { host: '127.0.0.1', port: 4188, strictPort: true },
  build: {
    outDir: '../../.artifacts/employee-ui/dist', emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./showcase.html', import.meta.url)) },
  },
});
