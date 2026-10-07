# Contrato de dados — snapshots publicados

Todos os arquivos abaixo são JSON estáticos, gerados pelo coletor a partir dos JSONs oficiais
do TSE (`resultados.tse.jus.br`) e publicados em um bucket/CDN. **O frontend só lê estes
arquivos; nunca fala com o TSE diretamente.** Todos têm `schema: 1`.

Caminho base: `/{eleicao}/{cargo}/` (ex.: `/6258/1/` = 2º turno 2026, Presidente).
Para o 1º turno 2026 (dados reais já disponíveis para desenvolvimento): `/6257/1/`.

Convenções:
- Percentuais são `number` já em 0–100 com 2 casas (ex.: `47.03`).
- Inteiros são `number` (não string, ao contrário do TSE).
- `atualizado_em` é ISO-8601 com fuso `-03:00` (horário de Brasília), derivado de `dg`+`hg` do TSE.
- Códigos de município são **IBGE de 7 dígitos** (campo `cdi` do TSE), que casam com a malha do IBGE.
  O código TSE de 5 dígitos aparece como `tse`.
- `cands` lista a ordem de candidatos usada em todos os arrays `v` (votos por candidato).

---

## `meta.json` — metadados da eleição e candidatos

```json
{
  "schema": 1,
  "eleicao": "6257",
  "pleito": "3220",
  "ciclo": "ele2026",
  "turno": 1,
  "cargo": "1",
  "cargo_nome": "Presidente",
  "data_eleicao": "2026-10-04",
  "atualizado_em": "2026-10-05T12:51:47-03:00",
  "cands": ["280002551544", "280002542548", "280002551932"],
  "candidatos": {
    "280002551544": {
      "numero": "22",
      "nome": "FLAVIO BOLSONARO",
      "nome_completo": "FLAVIO NANTES BOLSONARO",
      "partido": "PL",
      "coligacao": "PL",
      "vice": "ALFREDO GASPAR",
      "cor": "#1d4ed8",
      "foto": null
    }
  }
}
```

`cor` vem de `data/ref/cores.json` (por sigla de partido ou `n:<número>`); candidatos sem entrada
recebem uma paleta neutra de reserva, sem repetição. Basta editar o JSON e reiniciar o coletor.

## `br.json` — totais nacionais (também usado para cada UF em `uf/{sigla}.json`)

```json
{
  "schema": 1,
  "nivel": "br",
  "codigo": "br",
  "nome": "Brasil",
  "atualizado_em": "2026-10-05T12:51:47-03:00",
  "secoes": { "total": 499248, "totalizadas": 499248, "pct": 100.0 },
  "eleitorado": {
    "aptos": 158745502,
    "comparecimento": 125275835,
    "abstencao": 33469244,
    "pct_comparecimento": 78.92,
    "pct_abstencao": 21.08
  },
  "votos": {
    "total": 125275835,
    "validos": 119300788,
    "brancos": 2300798,
    "nulos": 3674249,
    "pct_validos": 95.23,
    "pct_brancos": 1.84,
    "pct_nulos": 2.93
  },
  "cands": ["280002551544", "280002542548"],
  "v": [56104503, 53879538],
  "pct": [47.03, 45.16],
  "lider": "280002551544",
  "margem_votos": 2224965,
  "margem_pct": 1.87,
  "situacao": { "280002551544": "2º turno", "280002542548": "2º turno" },
  "definido": false,
  "vencedor": null
}
```

- `pct` é sobre votos válidos (critério oficial).
- `definido` = `true` quando o TSE marca algum candidato como eleito (`e: "s"` e `st` = "Eleito");
  `vencedor` traz o id desse candidato (ou `null`).
- `situacao` traz o texto `st` do TSE por candidato ("Eleito", "2º turno", "Não eleito", ...).

## `uf.json` — todas as UFs em um arquivo (27 + ZZ exterior)

```json
{
  "schema": 1,
  "atualizado_em": "...",
  "cands": ["280002551544", "280002542548"],
  "ufs": {
    "SP": { "nome": "São Paulo", "ibge": "35", "secoes": {...}, "eleitorado": {...}, "votos": {...},
            "v": [...], "pct": [...], "lider": "...", "margem_pct": 12.3 },
    "ZZ": { "nome": "Exterior", "ibge": null, ... }
  }
}
```

Cada entrada tem os mesmos campos de `br.json` exceto `schema`/`atualizado_em`/`cands` (herdados).

## `mun.json` — todos os municípios, formato colunar compacto

```json
{
  "schema": 1,
  "atualizado_em": "...",
  "cands": ["280002551544", "280002542548"],
  "campos": ["ibge", "uf", "secoes_total", "secoes_totalizadas", "aptos",
             "comparecimento", "validos", "brancos", "nulos", "v"],
  "linhas": [
    ["3550308", "SP", 24115, 24115, 9306262, 7280000, 6900000, 150000, 230000, [3100000, 3800000]],
    ...
  ]
}
```

- Uma linha por município (5.570 + municípios do exterior com `uf: "ZZ"` e `ibge` sintético
  `99`+código TSE, igual a `ref/municipios.json`; sem geometria, ignorar no mapa).
- `v` é array alinhado a `cands`.
- Alvo de tamanho: < 400 KB bruto, < 100 KB gzip.
- O frontend calcula líder, margem e percentuais localmente.

## `timeline/br.json` — evolução da totalização (série temporal)

```json
{
  "schema": 1,
  "cands": ["280002551544", "280002542548"],
  "ultimo_idg": "2837531",
  "pontos": [
    { "t": "2026-10-25T17:05:12-03:00", "secoes_pct": 1.2, "v": [120000, 98000], "pct": [52.1, 42.5] },
    ...
  ]
}
```

Um ponto por coleta em que `idg` (id de geração do TSE) mudou. Mesmo formato em `timeline/uf/{sigla}.json`.

## `status.json` — saúde do coletor (para o banner "atualizado há X s")

```json
{
  "schema": 1,
  "ultima_coleta": "2026-10-25T20:31:10-03:00",
  "ultima_mudanca": "2026-10-25T20:31:05-03:00",
  "fonte_idg": "2837531",
  "ciclo_ms": 8421,
  "erros_ciclo": 0,
  "municipios_coletados": 5757
}
```

---

## Referências estáticas (não mudam no dia)

- `ref/municipios.json`: `{ "3550308": { "tse": "71072", "uf": "SP", "nome": "SÃO PAULO", "capital": true } }`
- `ref/ufs.json`: `{ "SP": { "nome": "São Paulo", "ibge": "35", "regiao": "Sudeste" } }`
- `geo/br-uf.topo.json` e `geo/br-mun.topo.json`: TopoJSON com `properties.id` = código IBGE
  (2 dígitos para UF, 7 para município), `properties.nome`, e para municípios `properties.uf`.
