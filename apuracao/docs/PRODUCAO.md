# Colocando em produção — passo a passo

Arquitetura de produção (ver `ARQUITETURA.md`): o público lê arquivos estáticos de um CDN; os
serviços com estado (coletor, chat, alertas, API do acervo) rodam em containers pequenos.

```
Cloudflare Pages  ──  site (web/dist)            https://<dominio>
Cloudflare R2     ──  snapshots do coletor       https://dados.<dominio>   (CDN, cache 10–30 s)
Railway (ou Fly)  ──  coletor, chat, alertas, api https://chat.<dominio>  (WebSocket + HTTP)
Railway Redis     ──  chat com vários processos
Stripe            ──  PIX + cartão (webhook → chat)
Telegram          ──  bot de alertas (webhook → alertas)
```

Tempo estimado: 1 tarde para o deploy, mais o tempo de aprovação das contas (Stripe e domínio).

## 0. Antes de tudo (contas)

- [ ] **Domínio** registrado e com DNS na Cloudflare (plano grátis basta).
- [ ] **Cloudflare**: conta com R2 ativado (precisa de cartão, mas a franquia grátis cobre).
- [ ] **Railway** (ou Fly.io): conta com plano pago (Hobby, US$ 5/mês) para ter domínio próprio e Redis.
- [ ] **Stripe Brasil**: conta ativada. Atenção: no Brasil o Stripe exige **CNPJ** para
  operar em modo *live*; com CPF só funciona o modo de teste. Se você não tem CNPJ, a
  alternativa é Mercado Pago ou Asaas (aceitam CPF): é uma classe de ~40 linhas em
  `chat/pagamentos.py`, a interface já está pronta.
- [ ] **Stripe → Settings → Payment methods**: ativar **Pix** (além de cartão). Sem isso o
  Checkout mostra só cartão.
- [ ] **Telegram**: criar o bot no @BotFather (`/newbot`), guardar o token e o nome.

## 1. Segredos (gere uma vez, guarde num cofre)

```bash
python -c "import secrets; print('CHAT_JWT_SECRET=' + secrets.token_urlsafe(48))"
python -m alertas gerar-vapid          # VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY
```

Variáveis por serviço (todas em `.env.example`):

| Serviço | Variáveis |
|---|---|
| coletor | `APURACAO_S3_BUCKET`, `APURACAO_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=auto`, `APURACAO_SITE_URL` |
| chat | `CHAT_PAGAMENTO=stripe`, `CHAT_JWT_SECRET`, `STRIPE_SECRET_KEY` (sk_live), `STRIPE_WEBHOOK_SECRET`, `CHAT_REDIS_URL`, `CHAT_DADOS_BASE=https://dados.<dominio>`, `CHAT_CORS=https://<dominio>` |
| alertas | `ALERTAS_DADOS_BASE=https://dados.<dominio>`, `APURACAO_SITE_URL`, `VAPID_*`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NOME`, `TELEGRAM_POLLING=0`, `ALERTAS_DEV=0` |
| site (build) | `VITE_DADOS_BASE=https://dados.<dominio>`, `VITE_CHAT_BASE=https://chat.<dominio>/chat`, `VITE_ALERTAS_BASE=https://chat.<dominio>/alertas` |

## 2. Cloudflare R2 (snapshots)

1. R2 → Create bucket `apuracao-dados` (região automática).
2. Bucket → Settings → **Custom domain** → `dados.<dominio>` (isso liga o CDN e o cache).
3. Bucket → Settings → **CORS policy**:
   ```json
   [{"AllowedOrigins": ["https://<dominio>"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600}]
   ```
4. R2 → Manage API tokens → token **Object Read & Write** restrito ao bucket → anote
   `Access Key ID`, `Secret Access Key` e o endpoint `https://<account_id>.r2.cloudflarestorage.com`.
5. Cloudflare → Caching → Cache Rules: para `dados.<dominio>/*`, "Eligible for cache" e
   "Respect origin TTL" (o coletor já manda `Cache-Control` certo por arquivo).
6. Teste local escrevendo no bucket:
   ```bash
   APURACAO_S3_BUCKET=apuracao-dados APURACAO_S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=auto \
   apuracao snapshot --eleicao 6257 --turno 1 --no-raw
   curl -I https://dados.<dominio>/ativo.json      # 200 + cache-control
   ```

## 3. Railway (coletor, chat, alertas, api)

Um projeto, uma imagem (`apuracao/Dockerfile`), quatro serviços. Em cada serviço: Settings →
Source = este repositório, **Root Directory = `apuracao`**, Builder = Dockerfile, e
**Start Command** diferente:

| Serviço | Start command | Porta | Domínio |
|---|---|---|---|
| coletor | `apuracao coletar --ano 2026 --turno 2` | nenhuma | nenhum |
| chat | `python -m chat` | 8001 | `chat.<dominio>` |
| alertas | `python -m alertas` | 8002 | `chat.<dominio>` com path `/alertas`* |
| api (acervo) | `apuracao servir --port 8000` | 8000 | `api.<dominio>` (fase 2) |

\* Railway dá um domínio por serviço. O mais simples: `chat.<dominio>` → serviço chat e
`alertas.<dominio>` → serviço alertas, e no build do site `VITE_ALERTAS_BASE=https://alertas.<dominio>/alertas`.

- Adicione o plugin **Redis** ao projeto e use a URL interna em `CHAT_REDIS_URL`.
- Volume de 1 GB montado em `/app/data` nos serviços chat e alertas (SQLite de pagamentos e
  inscrições). O coletor não precisa de volume (escreve no R2).
- Réplicas: chat 2+ (Redis cuida do resto); alertas 1; coletor 1 (um segundo coletor em outro
  provedor é o plano B do runbook).
- Health: `GET /chat/estado`, `GET /alertas/config`, `GET /health`.

## 4. Stripe (cobrança do chat + telão)

1. Chaves: Developers → API keys → `sk_live_...` em `STRIPE_SECRET_KEY`.
2. Webhook: Developers → Webhooks → Add endpoint → `https://chat.<dominio>/chat/webhook/stripe`,
   eventos **`checkout.session.completed`** e **`checkout.session.async_payment_succeeded`**
   (o segundo é o que confirma PIX). Copie o `whsec_...` para `STRIPE_WEBHOOK_SECRET`.
3. Teste em modo *test* antes do *live* (chaves `sk_test_`), com o Stripe CLI:
   ```bash
   stripe listen --forward-to https://chat.<dominio>/chat/webhook/stripe
   stripe trigger checkout.session.async_payment_succeeded
   ```
   e um pagamento real de teste: cartão `4242 4242 4242 4242`; PIX de teste é confirmado
   automaticamente pelo Stripe em alguns segundos.
4. O que o código já faz (testado em `tests/test_stripe.py`): Checkout em BRL com
   `allowed_payment_method_types=["card","pix"]`, PIX expira em 30 min, `client_reference_id`
   = nossa referência, assinatura do webhook verificada, PIX só libera quando `payment_status`
   = `paid`, e consulta ativa à sessão caso o cliente volte antes do webhook.
5. Recibo: ative "Email customers for successful payments" no Stripe (Settings → Emails).
   Nota fiscal de serviço é por sua conta (eNotas/NFE.io ou manual).

## 5. Cloudflare Pages (site)

1. Workers & Pages → Create → Pages → conectar o repositório.
2. Build: **Root directory `apuracao/web`**, build command `npm ci && npm run build`,
   output `dist`, Node 22.
3. Environment variables (Production): `VITE_DADOS_BASE`, `VITE_CHAT_BASE`, `VITE_ALERTAS_BASE`.
4. Custom domain `<dominio>` (e `www`). HTTPS automático.
5. Em `web/index.html`, defina a `og:image` pública:
   `https://dados.<dominio>/<prefixo>/og/placar.png` (o coletor regenera a cada mudança).
6. Confira no celular: instalar como app (manifest), ativar alertas (push), abrir o chat.

## 6. Telegram (alertas)

Com o serviço no ar, registre o webhook (uma vez):
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://alertas.<dominio>/alertas/telegram/webhook"
```
Teste: mande `/start` e `/placar` para o bot.

## 7. Vigia e ensaio

- Cron externo a cada minuto (healthchecks.io, cron de um VPS, ou GitHub Actions a cada 5 min):
  `python scripts/watchdog.py https://dados.<dominio> --max-idade 90 --webhook <slack/telegram>`.
- **Ensaio geral (D-7)**: um segundo bucket `apuracao-ensaio` + um deploy de *preview* do Pages
  apontando para ele; rode `APURACAO_S3_BUCKET=apuracao-ensaio apuracao simular --duracao 90
  --velocidade 2` e acompanhe o site, o chat, os alertas e o telão numa noite falsa de 45 min.
  Nunca rode o simulador no bucket de produção: ele troca o `ativo.json`.
- **D-2**: coletor de produção ligado em `--turno 2` (fica "aguardando totalização").
- Dia 25: `RUNBOOK.md`.

## 8. Checklist final

- [ ] `https://<dominio>` abre, mapa carrega, "fonte: TSE" leva ao JSON oficial.
- [ ] `https://dados.<dominio>/ativo.json` responde com `cache-control` e CORS.
- [ ] Pagamento de teste (cartão e PIX) libera chat e telão; webhook aparece no painel do Stripe.
- [ ] Alertas: push no celular e Telegram recebem `POST /alertas/teste`? (só com `ALERTAS_DEV=1`;
  em produção, use o ensaio geral para ver os marcos chegarem).
- [ ] Watchdog alertando quando o coletor para (teste parando o serviço por 2 min).
- [ ] Termos de uso e política de privacidade publicados (LGPD: apelido + dados de cobrança
  ficam no Stripe; nós guardamos apelido, referência e mensagens).
- [ ] Lista de termos bloqueados do chat preenchida; pelo menos um moderador com acesso ao
  SQLite (`bloqueados`).
