# Apuração 2026 — frontend

Página pública da apuração em tempo real (Vite + TypeScript, sem framework). Mapa
coroplético em Canvas (d3-geo + topojson-client), placar, totais, tabela por UF,
evolução da totalização e chat ao vivo com acesso pago. Lê apenas os JSONs estáticos
descritos em [`../docs/SCHEMA.md`](../docs/SCHEMA.md) e fala com o serviço de chat
descrito em [`../docs/CHAT.md`](../docs/CHAT.md).

## Desenvolvimento

```bash
# 1) servidor de dados local (serve data/latest em /dados, além de /ref e /geo)
cd .. && PYTHONPATH=. python -m apuracao.cli servir --port 8000

# 2) serviço de chat (opcional; sem ele o painel mostra o paywall e avisa que não conectou)
cd .. && PYTHONPATH=. CHAT_PAGAMENTO=dev python -m chat          # porta 8001

# 3) frontend com proxy de /dados (→ 8000) e /chat (HTTP + WebSocket → 8001)
cd web && npm install && npm run dev      # http://localhost:5173
```

`/geo/*` (TopoJSON) e `/ref/*` (municípios/UFs) vivem em `public/` e são servidos
pelo Vite em dev e copiados para `dist/` no build. Gere-os com
`python scripts/build_geo.py`.

## Build

```bash
npm run build      # tsc --noEmit + vite build → dist/
npm run preview    # serve dist/ em http://localhost:4173 (com proxy de /dados)
```

## Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `VITE_DADOS_BASE` | `/dados` | Base dos snapshots (ex.: `https://cdn.exemplo.com.br/dados`). O app lê `${base}/ativo.json` para descobrir o `prefixo` ativo e, a partir dele, `meta/br/uf/mun/status.json` e `timeline/br.json`. |
| `VITE_CHAT_BASE` | `/chat` | Base do serviço de chat (ex.: `https://chat.exemplo.com.br/chat`). O app chama `${base}/estado`, `${base}/checkout`, `${base}/acesso` e abre o WebSocket em `${base}/ws` (`ws://`/`wss://` derivado do protocolo da página). |

Exemplo de build apontando para o CDN:

```bash
VITE_DADOS_BASE=https://cdn.exemplo.com.br/dados npm run build
```

## Indicador "ao vivo" (barra superior)

Os dados do TSE mudam cerca de uma vez por minuto e o app verifica `br/uf/status` a cada
10 s. Para a página parecer viva sem mentir, a barra superior mostra: um ponto que bate a
cada segundo, "verificado há N s" (tempo desde a última verificação bem-sucedida, com
"flip" do número), um anel SVG com a contagem até a próxima verificação (reinicia a cada
ciclo do `Poller`, via `poller.onCiclo`), a hora da última mudança nos dados oficiais
("TSE 19:42:05", de `br.atualizado_em`) e uma barra de 2 px no topo da página que varre
a cada ciclo. Quando uma verificação traz dados novos, o anel pisca em verde, aparece
"novos dados" (anunciado por `aria-live="polite"`) e os números do placar pulsam. Com
`prefers-reduced-motion`, o ponto não bate e o anel/barra avançam em passos de 1 s.

## Chat ao vivo (`src/chat/`)

Implementa o contrato de [`../docs/CHAT.md`](../docs/CHAT.md):

- `client.ts` — HTTP (`estado`, `checkout`, `acesso`), sessão em `localStorage`
  (`chat_token`, `chat_apelido`) e `ChatSocket` (WebSocket com ping a cada 25 s,
  reconexão com backoff exponencial 1 s → 30 s com jitter, aceita frames de texto ou
  binários; `4401` apaga a sessão e volta ao paywall; `4429` espera o backoff máximo).
- `paywall.ts` — preço (de `/chat/estado`, padrão R$ 5), o que inclui, apelido validado no
  cliente (2–24: letras, números, espaço ou `_`), "N pessoas no chat agora".
- `sala.ts` — lista com no máximo 300 mensagens no DOM, autoscroll que respeita quem
  rolou para cima (pílula "↓ novas mensagens"), mensagens próprias à direita, mensagens
  de `sistema` como chip central, compositor com contador 0/280, Enter envia e
  Shift+Enter quebra linha, trava de 1,5 s por envio e toast para `erro`. Texto só via
  `textContent`.
- `index.ts` — casca: coluna fixa à direita no desktop (≥1100 px, recolhível, preferência
  em `localStorage.chat_painel`) e *bottom sheet* no celular (≈70 % do `visualViewport`,
  acompanha o teclado, arraste para baixo ou Esc fecha) aberto pelo botão flutuante
  "Chat ao vivo · N online". Ao voltar do pagamento com `?chat_ref=`, chama
  `/chat/acesso` a cada 3 s enquanto responder 402 ("aguardando confirmação do PIX…"),
  guarda o token e limpa a URL.

Em produção, sirva o serviço de chat no mesmo domínio (proxy reverso em `/chat`) ou
aponte `VITE_CHAT_BASE` para ele (o backend precisa liberar CORS para a origem da página).

## Polling

`br`, `uf` e `status` a cada 10 s; `timeline` a cada 30 s; `mun` a cada 60 s, sempre com
`cache: 'no-cache'` (revalidação por ETag no CDN). O polling pausa quando a aba fica
oculta e retoma imediatamente ao voltar.
