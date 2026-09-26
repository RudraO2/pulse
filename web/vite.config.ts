import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(here, '../src/shared'),
    },
  },
  build: {
    outDir: path.resolve(here, '../dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // Two pages: the dashboard and the phone app (/m).
    rollupOptions: {
      input: {
        main: path.resolve(here, 'index.html'),
        m: path.resolve(here, 'm.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3210', changeOrigin: true },
      '/healthz': { target: 'http://localhost:3210', changeOrigin: true },
    },
  },
})
