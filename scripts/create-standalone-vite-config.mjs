import { resolve } from 'node:path';

/**
 * @param {string} packageDir
 * @returns {import('vite').UserConfig}
 */
export function createStandaloneViteConfig(packageDir) {
  return {
    root: resolve(packageDir, 'src'),
    base: './',
    publicDir: false,
    build: {
      outDir: resolve(packageDir, 'dist'),
      emptyOutDir: true,
      sourcemap: true,
      target: 'es2020',
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: resolve(packageDir, 'src/index.html'),
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
  };
}
