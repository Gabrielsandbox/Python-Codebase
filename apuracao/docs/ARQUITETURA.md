# Arquitetura, decisões e roadmap

Data de referência: 06/10/2026. 1º turno realizado em 04/10 (Flávio Bolsonaro 47,03% × Lula
45,16%); **2º turno em 25/10/2026**, faltam 19 dias. Este documento é o plano de engenharia e de
produto; `SCHEMA.md` é o contrato de dados.

## 1. O que descobrimos da fonte (TSE) — fatos verificados

| Item | Valor observado |
|---|---|
| Catálogo de eleições | `oficial/comum/config/ele-c.json` — pleito **3220** (ele2026) |
| 1º turno Presidente | eleição **6257** (dados completos já disponíveis, usados no desenvolvimento) |
| 2º turno Presidente | eleição **6258** (ainda 404 — o TSE publica o diretório perto do dia) |
| Governador 1º/2º turno | 6259 / 6260 (mesmo formato; cargo 3) |
| Arquivo nacional | `ele2026/{ele}/dados/br/br-c0001-e00{ele}-u.json` (~9 KB) |
| Arquivo por UF / município | `dados/{uf}/{uf}-...-u.json` e `dados/{uf}/{uf}{codTSE}-...-u.json` |
| Lista de municípios | `config/mun-e00{ele}-cm.json` com código TSE **e** código IBGE (`cdi`) |
| Total de arquivos por ciclo | 1 + 28 (27 UFs + exterior) + 5.757 municípios ≈ **5.800** |
| Cabeçalhos do CDN (Akamai) | `cache-control: max-age≈57`, `ETag`, `Last-Modified`, `x-ratelimit-limit: 2000;w=1` |
| Medição real | ciclo completo de 5.757 municípios em **40 s** a 150 req/s, 0 erros |
| Dados históricos | `dadosabertos.tse.jus.br` (CKAN) — `resultados-1994` … `resultados-2026`, CSVs zipados |
| Malha | IBGE `servicodados.ibge.gov.br/api/v3/malhas` — `codarea` casa com `cdi` do TSE |

Consequências diretas:
- Não existe "dado da urna" individual em tempo real (os boletins de urna só saem depois no
  dados abertos); o que existe em tempo real é a **totalização por município/UF/BR**, atualizada
  pelo TSE a cada ~1 min. Nosso produto reexibe exatamente isso, sem projeções.
- Polling mais rápido que 60 s por arquivo é inútil (cache do CDN). BR+UF a cada 10 s custa 29
  requisições; municípios a cada 60 s custam ~5.800. Total ≈ **100 req/s**, 5% do limite do TSE.
- O código IBGE vem de graça no config do TSE → o join com a malha é trivial e sem tabela externa.

## 2. Arquitetura

```
                 ┌──────────────────────────── plano de controle ─────────────────────────────┐
 TSE CDN ──────► │ coletor (1 VM pequena, 2 réplicas ativo/passivo)                            │
 ~100 req/s      │  camada rápida 10 s: br + 28 UF → br.json, uf.json, uf/XX.json, timeline/*  │
                 │  camada municipal 60 s: 5.757 mun → mun.json                                │
                 │  raw/ : todo JSON que mudou, por idg  (matéria-prima do acervo)             │
                 └───────────────┬───────────────────────────────────────────────────────────┘
                                 │ PUT (S3 API) com Cache-Control curto
                                 ▼
                      bucket R2/S3 ("dados.<domínio>")  ◄──── CDN Cloudflare (cache 10–30 s, SWR)
                                 ▲                                      ▲
                 frontend estático (web/dist em Cloudflare Pages)       │  polling 10 s / 60 s
                                                                        │
                                                       milhões de navegadores no dia 25/10
```

**Por que estático + CDN e não WebSocket/SSE?** Com 1 origem de verdade que muda a cada ~60 s,
o CDN entrega o mesmo arquivo para todo mundo. Um Worker/servidor com milhões de conexões
abertas é caro, frágil e desnecessário. Polling de arquivos cacheados com `ETag` custa ~0 para
nós (Cloudflare não cobra egress em R2/Pages) e degrada graciosamente: se o coletor cair, o
público continua vendo o último snapshot com o banner "atualizado há X s" ficando amarelo.

**Tamanhos** (medidos com os dados do 1º turno, 12 candidatos): `br.json` 1,2 KB; `uf.json`
26 KB; `mun.json` 486 KB (192 KB gzip) — no 2º turno, com 2 candidatos, ~250 KB (≈90 KB gzip).
Malha municipal 1,18 MB (310 KB gzip), carregada 1 vez e cacheada por 1 ano.

**Resiliência no dia**:
- 2 coletores (ex.: Railway + 1 VPS) — o passivo só assume se `status.json` ficar >90 s sem
  atualizar (checa o próprio bucket). Escrita idempotente, então até dois ativos não quebram nada.
- Antes de 17h o TSE devolve 404; o coletor publica `aguardando_totalizacao: true` e segue.
- Pico esperado: 17h–21h. Cloudflare absorve; nosso custo variável é ~0.
- Observabilidade: `status.json` público é o próprio health check (um `curl` externo com alerta
  no Telegram/Slack se `ultima_coleta` envelhecer).

## 3. Frontend (web/)

Vite + TypeScript + d3-geo/topojson. Mobile-first (a maioria do Brasil vai abrir no celular).
Mapa por UF (padrão) com cor do líder e intensidade pela margem; toque na UF → zoom e
municípios; toggle "Municípios" nacional; placar com barra, % de seções totalizadas, votos,
abstenção, brancos/nulos; tabela de UFs; linha do tempo da totalização. Dark mode. Sem
fontes/bibliotecas pesadas. Veja `web/README.md`.

## 4. Acervo histórico — o produto por assinatura (historico/)

**Tese**: no dia 25/10 teremos (se o tráfego vier) a maior audiência que esse projeto jamais
terá. O que vendemos depois precisa (a) já existir no dia, (b) ser demonstrável em 1 clique a
partir da própria página da apuração e (c) ter algo que o TSE não oferece pronto.

O que o acervo oferece:
1. **Resultados 1994–2026 normalizados** (município × zona × candidato, comparecimento,
   brancos/nulos) em Parquet, consultáveis via API e via SQL (DuckDB), com códigos IBGE
   resolvidos e esquema único entre anos — o TSE entrega 30+ zips com cabeçalhos que mudam.
2. **Linha do tempo da totalização** de 2026 município a município (`data/raw/`), que o TSE
   não publica depois do dia — dado inédito para jornalismo de dados e ciência política.
3. **Comparações prontas**: swing 2022→2026 por município, mapas exportáveis, séries por
   município/UF/cargo, boletins de urna por seção (fase 2).
4. **API com chave** (`/api/v1/historico/*`, já esboçada) + downloads em CSV/Parquet + um
   "explorador" web com SQL e mapa.

Pricing sugerido (a validar): Grátis = apuração ao vivo + 3 consultas/dia; **Pesquisador R$ 29/mês**
(API, downloads, séries); **Redação/Empresa R$ 290/mês** (limites altos, uso comercial, suporte).
Pagamentos no Brasil: **PIX + cartão** via Stripe (já opera PIX no BR) ou Asaas/Pagar.me se quiser
boleto. Cobrança em BRL, nota fiscal via integração (ex.: eNotas/NFE.io). LGPD: só e-mail e
dados de cobrança; política de privacidade e termo de uso simples.

## 5. Infra e custos (ordem de grandeza)

| Componente | Opção recomendada | Custo/mês |
|---|---|---|
| Coletor (2x) | Railway ou Fly.io (1 vCPU/512 MB) + 1 VPS barato | US$ 10–20 |
| Bucket + CDN + site | Cloudflare R2 + Pages (egress grátis) | US$ 0–5 |
| Acervo (Parquet) | R2 (~20–50 GB com seções) | US$ 1–2 |
| API do acervo | 1 container FastAPI + DuckDB (Railway) | US$ 10 |
| Auth + billing | Supabase Auth + Stripe | % das vendas |
| Domínio | `.com.br` | ~R$ 40/ano |

Mesmo com milhões de visitantes no dia 25, o custo do pico fica próximo de zero por causa do
desenho estático.

## 6. Roadmap até 25/10 (19 dias)

**Semana 1 (até 12/10) — MVP ao vivo publicado**
- [x] Coletor + parser + publisher + testes (dados reais do 1º turno).
- [x] Malha TopoJSON + tabelas de referência.
- [ ] Frontend v1 (mapa UF/município, placar, tabela, timeline) — em andamento.
- [ ] Deploy: bucket R2 + Pages + coletor no Railway, domínio, `ativo.json` apontando para 6257
  como "ensaio" público (mostra o 1º turno enquanto o 2º não começa).
- [ ] Monitor externo do `status.json` + alerta.

**Semana 2 (até 19/10) — acervo mínimo vendável**
- [ ] Backfill 2018/2022/2026 (município×zona) em Parquet; API com chave; página `/acervo`
  com demo (ex.: "seu município em 2018/2022/2026") e CTA de assinatura.
- [ ] Stripe (PIX + cartão), Supabase Auth, emissão de chave de API no painel.
- [ ] Ensaio geral de carga: `coletar` rodando 24h contra 6257, k6 contra o CDN.

**Semana 3 (20–25/10) — endurecimento**
- [ ] Coletor passivo em segundo provedor; runbook do dia; página de status.
- [ ] Verificar quando o TSE publica `ele2026/6258/config` e `dados/` (o coletor já faz
  fallback para a lista de municípios do 1º turno).
- [ ] SEO/compartilhamento (OG image dinâmica do placar), PWA leve, acessibilidade.

**Pós-eleição**: backfill 1994–2016, boletins de urna por seção, explorador SQL, exportação de
mapas, planos anuais, API pública para redações.

## 7. Riscos e mitigação

- **TSE muda o formato/URLs** → parser tolerante, testes com fixtures reais, `apuracao eleicoes`
  para redescobrir códigos; checagem diária automatizada do diretório 6258.
- **TSE bloqueia nosso IP** → ficamos a 5% do limite, com `User-Agent` identificado e GET
  condicional; coletor passivo em outro provedor/IP.
- **Pico de tráfego** → nada dinâmico no caminho do público; CDN com `stale-while-revalidate`.
- **Percepção de parcialidade** → paleta neutra, ordem por número de urna, sem projeções, fonte
  e horário do TSE sempre visíveis, metodologia pública.
- **Legal** → dados públicos e oficiais; não é pesquisa eleitoral (sem registro necessário);
  marca/nome do produto não pode sugerir vínculo com TSE/Justiça Eleitoral.

## 8. Decisões em aberto (precisam do dono do produto)

1. Nome e domínio do produto.
2. Provedor de pagamento: Stripe (simples, PIX+cartão) vs. Asaas/Pagar.me (boleto, mais BR).
3. Hospedagem do coletor: Railway (conector já disponível nesta sessão) vs. VPS própria.
4. Mostrar também Governador (2º turno em ~10 UFs) na v1 ou só Presidente?
5. Preço e planos do acervo; se quer plano para redações/API comercial desde o dia 1.
6. Repositório: manter dentro de `Python-Codebase/apuracao` ou mover para um repositório próprio
   (recomendado antes do deploy, por causa de CI/CD e segredos).
