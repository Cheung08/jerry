import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        // Exclude backend runtime data files and CSV data folders from triggering Vite frontend reloads
        ignored: [
          '**/data_ftp/**',
          '**/data_cache.json',
          '**/config.json',
          '**/uploads/**',
          '**/*.csv',
          '**/*.tmp',
        ],
      },
    },
  };
});
