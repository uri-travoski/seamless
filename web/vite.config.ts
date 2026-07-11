import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = 'http://localhost:4900';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5900,
    proxy: {
      '/api': { target, ws: true },
      '/jmap': { target },
      '/t': { target },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
