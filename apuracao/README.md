# Apuração BR — apuração em tempo real + acervo histórico de eleições

Aplicação para acompanhar, ao vivo, a totalização dos votos do **2º turno de 2026**
(25/10/2026, Presidente) direto da fonte oficial do TSE, com mapa do Brasil por UF e por
município, e que aproveita o tráfego do dia para lançar um **acervo de dados eleitorais
(1994–2026) por assinatura**.

> Estado atual: coletor, publisher, API e contrato de dados prontos e testados contra os
> dados reais do 1º turno de 2026. Frontend (mapa) em `web/`, acervo em `historico/`.
> Leia `docs/ARQUITETURA.md` para a visão completa, decisões e roadmap.

## Como funciona (resumo)

```
TSE (resultados.tse.jus.br) ──► coletor (Python/asyncio) ──► snapshots JSON compactos ──► bucket + CDN ──► navegador
   ~5.800 arquivos JSON          GET condicional, 150 req/s        br/uf/mun/timeline        Cloudflare        mapa + placar
   cache 60 s, 2000 req/s             2 camadas: 10 s / 60 s         < 500 KB no total        absorve o tráfego   polling 10 s
```

O público **nunca fala com o TSE nem com nosso servidor**: lê arquivos estáticos de um CDN.
É isso que permite atender o Brasil inteiro no dia da apuração com custo e risco mínimos.

## Rodando localmente

```bash
cd apuracao
uv pip install --system -e ".[dev]"          # ou: pip install -e ".[dev]"

# 1) ver as eleições no catálogo do TSE
apuracao eleicoes --ano 2026

# 2) um ciclo completo com dados reais do 1º turno (eleição 6257) → data/latest/
apuracao snapshot --eleicao 6257 --turno 1

# 3) no dia: loop contínuo do 2º turno (6258). Antes do início da totalização tudo é 404,
#    o coletor fica aguardando e publica status "aguardando_totalizacao".
apuracao coletar --ano 2026 --turno 2

# 4) servir snapshots + referências para o frontend em dev
apuracao servir --port 8000
cd web && npm install && npm run dev        # veja web/README.md
```

Testes e lint:

```bash
pytest -q
ruff check apuracao tests
```

## Publicação em produção (bucket + CDN)

Defina as variáveis e o coletor passa a escrever no bucket (API S3: Cloudflare R2, AWS S3, B2):

```bash
export APURACAO_S3_BUCKET=apuracao-dados
export APURACAO_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # R2
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
apuracao coletar --ano 2026 --turno 2
```

Os objetos saem com `Cache-Control: public, max-age=10, stale-while-revalidate=30`
(`mun.json`: 30 s; `meta.json`: 60 s; `status.json`: 5 s). O frontend é estático (`web/dist`).

## Layout

```
apuracao/
  apuracao/            pacote Python
    tse/               urls, cliente HTTP (ETag, rate limit, retry), parser, catálogo
    publish/           gera os snapshots do contrato (docs/SCHEMA.md)
    storage/           LocalStorage (dev) e S3Storage (R2/S3)
    collector.py       loop de 2 camadas (BR+UF / municípios)
    api/app.py         FastAPI: /dados, /ref, /geo (dev) e /api/v1/historico (assinantes)
    cli.py             apuracao eleicoes | snapshot | coletar | servir
  historico/           ETL dos dados abertos do TSE (1994–2026) → Parquet + DuckDB (acervo pago)
  web/                 frontend Vite + TypeScript + d3 (mapa, placar, tabela, linha do tempo)
  scripts/build_geo.py malhas IBGE → TopoJSON (web/public/geo) + tabelas de referência
  docs/                SCHEMA.md (contrato de dados), ARQUITETURA.md (decisões, infra, negócio)
  data/                ref/ (versionado), raw/ latest/ historico/ (gerados, ignorados pelo git)
  tests/               pytest com fixtures reais do TSE
```

## Recursos da noite (contratos em `docs/RECURSOS.md`)

- **Caminho para a vitória** (`caminho.json`): votos válidos estimados que faltam, por região,
  UF e maiores municípios abertos, e o percentual que quem está atrás precisa para empatar.
  Aritmética sobre o comparecimento do 1º turno, não projeção. Precisa da base:
  `apuracao snapshot --eleicao 6257 --turno 1 && apuracao base-1turno --eleicao 6257`.
- **Ritmo** (`ritmo.json`): seções/min, votos/min, ETA de 90% e 100% (velocidade de contagem).
- **Imagens de compartilhamento** (`og/placar.png`, `og/uf/XX.png`): geradas pelo coletor.
- **Confira na fonte**: `meta.fonte` e `fonte` em `br.json`/`uf.json` apontam para o JSON do TSE.
- **Simulador** (ensaio geral, marca tudo como simulação):
  `apuracao simular --origem 6257 --destino 6258 --duracao 90 --velocidade 6`
  reproduz uma noite inteira em 15 minutos reais a partir dos dados do 1º turno.
- **Alertas** (`alertas/`, porta 8002, contrato em `docs/ALERTAS.md`): Web Push (PWA) e bot do
  Telegram nos marcos (início, 25/50/75/90/100%, virada, definido, matematicamente definido).
  `python -m alertas gerar-vapid` cria as chaves; `python -m alertas` sobe o serviço.

## Chat ao vivo (acesso pago, R$ 5)

Serviço separado em `chat/` (contrato em `docs/CHAT.md`): pagamento único via Stripe Checkout
(PIX ou cartão) → token de acesso (JWT, 7 dias) → WebSocket. Moderação básica (URLs removidas,
lista de termos em `data/ref/chat-bloqueio.txt`, 1 mensagem a cada 2 s), histórico das últimas
50 mensagens por sala, contador de presença e mensagens automáticas de sistema quando o placar
muda. Salas "geral" + uma por estado, reações em explosão (🔥 👏 😱 😂 🇧🇷 e torcida por
candidato, 5/s por pessoa) e termômetro da torcida dos últimos 5 minutos.

```bash
# desenvolvimento: sem cobrança (CHAT_PAGAMENTO=dev), 1 processo em memória
CHAT_PAGAMENTO=dev python -m chat                 # porta 8001

# produção: Stripe + Redis (vários processos compartilham mensagens e presença)
CHAT_PAGAMENTO=stripe CHAT_JWT_SECRET=... STRIPE_SECRET_KEY=sk_... STRIPE_WEBHOOK_SECRET=whsec_... \
CHAT_REDIS_URL=redis://localhost:6379/0 python -m chat
```

Webhook do Stripe: `POST /chat/webhook/stripe` (eventos `checkout.session.completed` e
`checkout.session.async_payment_succeeded`). O frontend aponta para o serviço por
`VITE_CHAT_BASE` (padrão `/chat`, com proxy em dev).

## Fonte e uso dos dados

Dados oficiais do Tribunal Superior Eleitoral (resultados.tse.jus.br e dadosabertos.tse.jus.br),
de acesso público. Este projeto apenas **reexibe a totalização oficial**; não faz projeções nem
estimativas de resultado.

## CI

O workflow do GitHub Actions está em `ci/github-workflow-apuracao.yml` (lint + testes Python,
build do frontend). Copie-o para `.github/workflows/` no repositório — o app usado nesta sessão
não tem permissão para criar workflows.
