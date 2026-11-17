import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.GROKBOT_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // IPv4 explicitly: Node resolves `localhost` to ::1 first, and Docker Desktop forwards
    // host.docker.internal to 127.0.0.1, so the GPU sidecar's HTTPS front door (:8444 → vite) could
    // not reach a vite bound to ::1. Browsers opening http://localhost:5173 fall back to IPv4.
    host: '127.0.0.1',
    proxy: {
      '/api': { target: API, changeOrigin: false, ws: true },
    },
  },
  // `vite preview` serves the production build; without the same proxy the bundle has no API.
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false, ws: true },
    },
  },
  // noVNC uses top-level await, so target ES2022+.
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
