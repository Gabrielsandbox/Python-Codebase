import { defineConfig } from 'vite';

// `/geo` e `/ref` vivem em web/public e são servidos pelo Vite (dev) ou copiados
// para dist/ (build). `/dados` é proxy para o servidor FastAPI local em dev;
// em produção o app lê direto do CDN via VITE_DADOS_BASE. `/chat` (HTTP + WebSocket)
// é proxy para o serviço de chat (apuracao/chat, porta 8001); em produção use
// VITE_CHAT_BASE ou um proxy reverso no mesmo domínio.
const proxy = {
  '/dados': { target: 'http://127.0.0.1:8000', changeOrigin: true },
  '/chat': { target: 'http://127.0.0.1:8001', changeOrigin: true, ws: true },
  '/alertas': { target: 'http://127.0.0.1:8002', changeOrigin: true },
  '/conta': { target: 'http://127.0.0.1:8001', changeOrigin: true },
  '/espera': { target: 'http://127.0.0.1:8001', changeOrigin: true },
};

export default defineConfig({
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      // duas páginas: o app (index.html) e a lista de espera (espera.html); scripts/pos-build.mjs troca
      // as duas de lugar quando VITE_ESPERA=1
      input: { index: 'index.html', espera: 'espera.html' },
      output: {
        manualChunks: {
          geo: ['d3-geo', 'topojson-client'],
        },
      },
    },
  },
});
