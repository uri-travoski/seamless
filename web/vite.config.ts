import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// override to point the dev UI at a second server (e.g. a restore drill on another port)
const target = process.env.SEAMLESS_API ?? 'http://localhost:4900';

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
