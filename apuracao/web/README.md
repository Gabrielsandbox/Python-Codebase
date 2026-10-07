# Apuração 2026 — frontend

Página pública da apuração em tempo real (Vite + TypeScript, sem framework). Mapa
coroplético em Canvas (d3-geo + topojson-client), placar, totais, tabela por UF e
evolução da totalização. Lê apenas os JSONs estáticos descritos em
[`../docs/SCHEMA.md`](../docs/SCHEMA.md).

## Desenvolvimento

```bash
# 1) servidor de dados local (serve data/latest em /dados, além de /ref e /geo)
cd .. && PYTHONPATH=. python -m apuracao.cli servir --port 8000

# 2) frontend com proxy de /dados para o FastAPI
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

Exemplo de build apontando para o CDN:

```bash
VITE_DADOS_BASE=https://cdn.exemplo.com.br/dados npm run build
```

## Polling

`br`, `uf` e `status` a cada 10 s; `timeline` a cada 30 s; `mun` a cada 60 s, sempre com
`cache: 'no-cache'` (revalidação por ETag no CDN). O polling pausa quando a aba fica
oculta e retoma imediatamente ao voltar.
