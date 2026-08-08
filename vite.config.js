import { defineConfig } from 'vite';

export default defineConfig({
  root: 'webapp',
  base: '',
  server: {
    host: true,
    port: 5173
  },
  build: {
    outDir: '../www',
    emptyOutDir: true
  }
});
