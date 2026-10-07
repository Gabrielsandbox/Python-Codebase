# Alertas — Web Push (PWA) e Telegram

Serviço separado em `alertas/` (porta 8002 em dev). Lê `br.json`/`status.json` publicados e
dispara mensagens nos **marcos** da apuração para quem se inscreveu.

## Eventos

| chave | quando | texto (exemplo) |
|---|---|---|
| `inicio` | primeira totalização do dia | "Começou a apuração do 2º turno." |
| `marcos` | 25, 50, 75, 90, 99 e 100% das seções | "50% das seções: Lula 50,8% × Flavio Bolsonaro 49,2%." |
| `virada` | o líder nacional muda | "Virou! Flavio Bolsonaro passa a liderar: 50,1% × 49,9% (61% das seções)." |
| `definido` | `br.json.definido` vira `true` | "Definido: Lula eleito com 51,3%." |
| `matematica` | `caminho.definido_matematicamente` deixa de ser `null` | "Matematicamente definido: …" |

Cada evento é enviado uma única vez (chave de deduplicação persistida em SQLite).

## HTTP

- `GET /alertas/config` → `{ "vapid_publica": "<base64url>", "telegram_bot": "ApuracaoBot" | null, "eventos": ["inicio","marcos","virada","definido","matematica"] }`
- `POST /alertas/inscrever` body: `{ "subscription": <PushSubscription JSON>, "eventos": ["virada","marcos","definido"] }` → `201 { "id": "…" }`
- `DELETE /alertas/inscrever` body: `{ "endpoint": "<subscription.endpoint>" }` → `204`
- `POST /alertas/teste` (só em dev) → envia uma notificação de teste para todas as inscrições.
- `POST /alertas/telegram/webhook` (webhook do bot) e, em dev, *long polling* automático.

## Telegram

Usuário abre `https://t.me/<bot>` e envia `/start` → inscrito em todos os eventos. Comandos:
`/placar` (placar atual), `/so virada` (só virada e definido), `/tudo`, `/parar`.
Variáveis: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NOME`.

## Web Push

Chaves VAPID em `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` (`python -m alertas gerar-vapid` cria),
`VAPID_CLAIMS_EMAIL`. Payload da notificação (JSON):
`{ "title": "Apuração 2026", "body": "…", "url": "https://<site>/", "tag": "marcos-50" }`.
O service worker do site (`web/public/sw.js`) mostra a notificação e abre `url` ao clicar.

## Frontend

- Botão "Ativar alertas" no cabeçalho (sino): pede permissão, registra o SW, assina com a chave
  VAPID, envia a `POST /alertas/inscrever`. Mostra "alertas ativados" e permite escolher eventos.
- Link "Receber no Telegram" → `https://t.me/<bot>` (de `/alertas/config`).
- `manifest.webmanifest` + `sw.js` deixam o site instalável (PWA) e com cache dos estáticos.
- Base configurável: `VITE_ALERTAS_BASE` (padrão `/alertas`, proxy em dev).
