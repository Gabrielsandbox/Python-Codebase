import { defineConfig } from 'vite';

// `/geo` e `/ref` vivem em web/public e são servidos pelo Vite (dev) ou copiados
// para dist/ (build). `/dados` é proxy para o servidor FastAPI local em dev;
// em produção o app lê direto do CDN via VITE_DADOS_BASE.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/dados': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/dados': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          geo: ['d3-geo', 'topojson-client'],
        },
      },
    },
  },
});
