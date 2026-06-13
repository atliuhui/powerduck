import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Bundles the webview UI. The extension host code is compiled separately
// by tsc (see tsconfig.extension.json).
export default defineConfig({
  root: resolve(__dirname, 'src/webview'),
  base: './',
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: resolve(__dirname, 'src/webview/index.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
});
