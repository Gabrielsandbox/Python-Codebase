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
| `VITE_ALERTAS_BASE` | `/alertas` | Base do serviço de alertas ([`../docs/ALERTAS.md`](../docs/ALERTAS.md)): `${base}/config` e `${base}/inscrever`. Em dev, `/alertas` é proxy para a porta 8002. |

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

### Extensões: salas, reações e termômetro (`salas.ts`, `reacoes.ts`, `termometro.ts`, `chat-ext.css`)

- **Salas por estado** — `<select>` no cabeçalho do chat ("Geral" + 27 UFs + exterior) com o
  online por sala vindo de `/chat/estado.salas` a cada 10 s. Trocar de sala fecha o WebSocket e
  reconecta com `&sala=XX`; a última sala fica em `localStorage.chat_sala`. Um aviso local "Você
  está na sala …" abre o histórico de cada sala. Com um deep link `#uf=SP`, aparece o chip
  "entrar na sala SP" (não troca sozinho). `4400` (sala inválida) volta para a Geral.
- **Reações em explosão** — 🔥 👏 😱 😂 🇧🇷 + um botão de torcida por finalista
  (`store.principais`, cores de `store.paleta`). Cada toque envia `{tipo:"reacao", valor}`
  (limite local de 5/s, igual ao servidor) e solta um emoji próprio na hora; a mensagem
  `reacoes` do servidor vira uma rajada proporcional à contagem (até ~40 por janela, posição e
  duração aleatórias, só `transform`/`opacity`). Com `prefers-reduced-motion` ou aba oculta,
  nada voa: aparecem contadores "🔥 ×12" por 2,4 s.
- **Termômetro da torcida** — mensagem `termometro` → barra dividida com as cores dos
  finalistas no topo do chat, transição suave de largura e a legenda "só quem está no chat,
  nos últimos 5 min"; some quando `total` é 0 ou ao trocar de sala.

## Alertas — Web Push, PWA e Telegram (`src/alertas/`)

Implementa o lado do navegador de [`../docs/ALERTAS.md`](../docs/ALERTAS.md):

- Sino na barra superior (montado em `#topbar .status`; no celular ganha uma 3ª coluna do
  grid) → popover com os eventos (virada, marcos, definição, matematicamente definido,
  início) e "Ativar alertas": `Notification.requestPermission()` → registra `public/sw.js`
  → `pushManager.subscribe` com `vapid_publica` de `GET /alertas/config` →
  `POST /alertas/inscrever`. A inscrição (`id`, `endpoint`, `eventos`) fica em
  `localStorage.alertas_inscricao` e é conferida com `pushManager.getSubscription()` a cada
  abertura. "Salvar escolha" reenvia os eventos; "desativar" faz `DELETE` + `unsubscribe()`.
- Estados mostrados: ativados · bloqueados pelo navegador · não suportado · iPhone/iPad sem
  o site instalado ("Adicionar à Tela de Início"). Link "Receber no Telegram" quando
  `telegram_bot` vem na config.
- `public/sw.js`: `push` → `showNotification(title, {body, tag, icon, data:{url}})`;
  `notificationclick` → foca uma aba do site ou abre `url`; cache-first **só** para
  `/geo/*` e `/ref/*` (nunca `/dados`, `/chat` ou `/alertas`). Em produção o SW é registrado no
  carregamento (PWA instalável); em dev, só ao ativar os alertas.
- `public/manifest.webmanifest` + ícones em `public/icons/` (SVG + PNG 192/512 + maskable).

## Recursos da noite (`src/recursos/`)

Implementa [`../docs/RECURSOS.md`](../docs/RECURSOS.md) §1–5; CSS em `src/recursos.css`,
montagem única por `montarRecursos()` (chamada no `main.ts`). Tudo degrada em silêncio
quando o arquivo ou campo não existe (snapshots antigos).

- `caminho.ts` — painel "Caminho para a vitória" logo abaixo do placar (`caminho.json`,
  10 s): votos que faltam, gauge de "quanto o segundo precisa para empatar" (marca em 50 %
  e no valor; > 100 % = "matematicamente impossível"), barras por região divididas pela
  `base_pct` do 1º turno, maiores municípios abertos, bloco de ritmo e a legenda "não é
  projeção". Estados: antes da totalização (`pct_secoes = 100`), `definido_matematicamente`
  (faixa sóbria "Aguardando o TSE") e concluída (`restante.secoes = 0`).
- `ritmo.ts` — indicador compacto na barra superior ("812 seções/min · 100% ≈ 20h41";
  `cauda` → "reta final, ritmo cai"; some com `aguardando`/`concluida` e no celular) e a
  sparkline de seções/min calculada no cliente a partir de `timeline/br.json`.
- `municipio.ts` — card "Meu município" na coluna ao lado do mapa: busca sem acentos
  ("Nome - UF", setas/Enter), "usar minha localização" (permissão só ao tocar; centróide
  mais próximo via `geoCentroid` da malha municipal, carregada sob demanda), resultado com
  os dois finalistas, margem, comparecimento e "no Brasil", "ver no mapa" (abre o estado e
  realça o município, `Mapa.realcarMun`), "compartilhar" (canvas 1080×1080 →
  `navigator.share` com arquivo, senão `wa.me`) e "copiar link".
- `telao.ts` — modo telão (`#telao` ou botão "Telão"): overlay em tela cheia, tema escuro
  forçado (`data-theme="dark"` + `store.atualizarTema()`, restaurado ao sair), placar
  gigante, segunda instância de `Mapa`, carrossel das UFs a cada 12 s (← → trocam, toque
  no mapa também), rodapé com ritmo + caminho. `Esc`, o botão ou sair da tela cheia fecham.
- `fonte.ts` — links "fonte: TSE ↗" (`meta.fonte` + `fonte` de `br`/`uf`; município pelo
  template com `{uf}` minúsculo e `{tse}` de `ref/municipios.json`) no placar, no painel
  de seleção, na tabela por UF e no card do município; frase no rodapé.
- Deep links (`index.ts`): `#m=<ibge>` abre o município (e o estado no mapa), `#uf=<SIGLA>`
  abre o estado (funciona antes de a malha chegar), `#telao` abre o telão.

## Polling

`br`, `uf`, `status`, `caminho` e `ritmo` a cada 10 s (404 de `caminho`/`ritmo` é
ignorado); `timeline` a cada 30 s; `mun` a cada 60 s, sempre com
`cache: 'no-cache'` (revalidação por ETag no CDN). O polling pausa quando a aba fica
oculta e retoma imediatamente ao voltar.
