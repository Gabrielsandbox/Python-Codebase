// Com VITE_ESPERA=1 (no ambiente ou em .env.production), a página de espera vira a raiz do site
// e o app fica em /ao-vivo (endereço de teste). Sem a variável, index.html é o app e a lista de
// espera fica em /espera.
import { existsSync, readFileSync, renameSync } from 'node:fs';
const raiz = new URL('../', import.meta.url).pathname;
const dist = raiz + 'dist/';
let espera = process.env.VITE_ESPERA;
if (espera === undefined && existsSync(raiz + '.env.production')) {
  const m = readFileSync(raiz + '.env.production', 'utf8').match(/^VITE_ESPERA=(.*)$/m);
  espera = m?.[1]?.trim();
}
if (espera === '1' && existsSync(dist + 'espera.html')) {
  renameSync(dist + 'index.html', dist + 'ao-vivo.html');
  renameSync(dist + 'espera.html', dist + 'index.html');
  console.log('modo espera: / = lista de espera · /ao-vivo = apuração');
} else {
  console.log('modo normal: / = apuração · /espera = lista de espera');
}
