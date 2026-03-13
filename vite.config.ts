import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'widget-entry.js'),
      name: 'MoodboardGrid',
      formats: ['iife'],
    },
    rollupOptions: {
      output: {
        entryFileNames: 'moodboard-grid.js',
        assetFileNames(assetInfo) {
          if (assetInfo.name?.endsWith('.css')) {
            return 'moodboard-grid.css';
          }

          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
