# `historico/` — acervo histórico de resultados eleitorais (TSE)

ETL dos **dados abertos do TSE** (CKAN em `dadosabertos.tse.jus.br`, arquivos no CDN
`cdn.tse.jus.br/estatistica/sead/odsele/`) para um *lake* Parquet consultável com DuckDB.
É a fundação da "biblioteca de dados" (metade 2 do produto); a apuração em tempo real
(metade 1) vive em `apuracao/`.

Pilha: Python ≥ 3.11, `duckdb`, `httpx`, `typer`, `rich`. **Sem pandas.**

```bash
cd apuracao
uv pip install --system -e ".[historico]"
python -m historico --help
```

## Layout em disco

```
data/historico/
├── catalogo/                       # cache do JSON do CKAN (package_show), TTL 6 h
│   └── resultados-2022.json
├── raw/                            # DADOS BRUTOS NÃO CONFIÁVEIS (ZIP/CSV do TSE)
│   ├── 2022/votacao_candidato_munzona_2022.zip
│   ├── 2022/detalhe_votacao_munzona_2022.zip
│   └── _tmp/                       # CSVs extraídos durante o ETL (apagados ao fim)
└── parquet/                        # lake normalizado
    ├── votacao_candidato_munzona/
    │   ├── ano=2022/turno=1/part.parquet
    │   ├── ano=2022/turno=1/_meta.json      # linhas, zip de origem, csvs lidos, versão
    │   └── ano=2022/turno=2/part.parquet
    └── detalhe_votacao_munzona/
        └── ano=2022/turno=1/part.parquet
```

* Partição Hive `ano=/turno=`: o DuckDB lê com
  `read_parquet('.../ano=*/turno=*/*.parquet', hive_partitioning=true, union_by_name=true)`
  e as colunas `ano` e `turno` vêm do caminho (não estão dentro do arquivo).
* Tudo sob `data/historico/` está no `.gitignore`. A raiz pode ser movida com
  `APURACAO_HISTORICO_DIR=/outro/disco`.
* Segurança: o conteúdo de `raw/` nunca é importado nem executado — só lido como CSV pelo
  DuckDB. Não rode interpretadores com `cwd` dentro de `raw/`.

## Tabelas

| chave (`--tabela`)           | conteúdo                                                   | ZIP/ano      |
|------------------------------|------------------------------------------------------------|--------------|
| `votacao_candidato_munzona`  | votos por candidato × município × zona (**principal**)     | 20–640 MB    |
| `detalhe_votacao_munzona`    | aptos, comparecimento, abstenção, brancos, nulos, seções   | 1–5 MB       |
| `votacao_partido_munzona`    | votos de legenda por partido × município × zona            | pequeno      |
| `votacao_secao`              | votos por seção eleitoral — **um ZIP por UF**, fora de escopo (`--uf`) | SP 2022: 900 MB |
| `detalhe_votacao_secao`      | detalhe por seção — fora de escopo                          | grande       |

Só as duas primeiras têm esquema garantido (ver abaixo); as demais passam pelo caminho
genérico (todas as colunas tipadas por prefixo).

## Comandos

```bash
# 1) o que existe no CKAN para um ano (o CKAN do TSE NÃO informa tamanho; --tamanhos faz HEAD no CDN)
python -m historico catalogo 2022 --so-conhecidas --tamanhos
python -m historico catalogo 2024 --sufixo boletim-de-urna        # resultados-2024-boletim-de-urna

# 2) baixar (idempotente: pula se o tamanho bate com o Content-Length; retoma .part via Range)
python -m historico baixar 2022 --tabela votacao_candidato_munzona --max-mb 700
python -m historico baixar 2022 --tabela detalhe_votacao_munzona  --max-mb 50

# 3) CSV -> Parquet particionado
python -m historico etl 2022 --tabela votacao_candidato_munzona --threads 4 --memoria 6GB
python -m historico etl 2022 --tabela detalhe_votacao_munzona

# 2+3 em um passo
python -m historico pipeline 2022 --tabela votacao_candidato_munzona --max-mb 700

# 4) consultas
python -m historico particoes
python -m historico consulta municipio 2024 1 Prefeito --ibge 3550308 --limite 5
python -m historico consulta serie 3550308 11 --top 3
python -m historico consulta detalhe 2024 1 11 --ibge 3550308 --json
python -m historico consulta sql "select ano, turno, count(*) from votacao_candidato_munzona group by all"
```

Em Python:

```python
from historico.consulta import resultado_por_municipio, serie_historica_municipio, detalhe_municipio, conectar
linhas = resultado_por_municipio(2024, 1, "Prefeito", cd_ibge="3550308")      # list[dict]
rel    = resultado_por_municipio(2024, 1, 11, uf="SP", como_relacao=True)     # duckdb relation
con    = conectar()   # views: votacao_candidato_munzona, detalhe_votacao_munzona, ...
```

Códigos de cargo (`CD_CARGO`): 1 Presidente, 3 Governador, 5 Senador, 6 Dep. Federal,
7 Dep. Estadual, 8 Dep. Distrital, 11 Prefeito, 13 Vereador (`consulta.CARGOS`).

## Backfill 1994–2026 (um comando por ano)

```bash
for ano in 1994 1996 1998 2000 2002 2004 2006 2008 2010 2012 2014 2016 2018 2020 2022 2024 2026; do
  python -m historico pipeline $ano --tabela votacao_candidato_munzona --max-mb 1000 || echo "FALHOU $ano"
  python -m historico pipeline $ano --tabela detalhe_votacao_munzona   --max-mb 50   || echo "FALHOU $ano"
done
```

* Datasets `resultados-YYYY` existem de 1933 a 2026 no CKAN, mas os ZIPs `*_munzona_YYYY.zip`
  no formato atual começam em **1994** (antes disso só há agregados/relatórios).
* **2026**: em 06/10/2026 o CKAN `resultados-2026` lista apenas 28 PDFs ("Relatório de
  Totalização"). Mesmo assim `votacao_candidato_munzona_2026.zip` **já existe no CDN**
  (316 MB, 1º turno). `recurso_da_tabela()` cai para a URL canônica do CDN quando o CKAN
  não lista o recurso, então `pipeline 2026` funciona; `detalhe_votacao_munzona_2026.zip`
  ainda retorna 404 (o comando falha com exit 4 e é só repetir depois).
* Rode o ano de novo após o 2º turno: o TSE **regera o mesmo ZIP** (mesma URL) com os dois
  turnos; como o tamanho muda, o `baixar` detecta e rebaixa; o `etl` sobrescreve as
  partições `turno=1` e `turno=2`.
* Eleições suplementares ficam em datasets próprios (`resultados-eleicoes-suplementares-2024`,
  `resultados-2020-suplementares`) e **não** trazem `*_munzona` — só BU/correspondências.

### Tamanhos (ZIP no CDN, `votacao_candidato_munzona`; CSV `_BRASIL` descompactado; Parquet estimado)

| ano  | ZIP     | CSV     | ano  | ZIP     | CSV     |
|------|---------|---------|------|---------|---------|
| 1994 | 42 MB   | 440 MB  | 2012 | 58 MB   | ~450 MB |
| 1996 | 19 MB   | ~150 MB | 2014 | 494 MB  | 3,1 GB  |
| 1998 | 106 MB  | 724 MB  | 2016 | 61 MB   | ~450 MB |
| 2000 | 40 MB   | ~300 MB | 2018 | 395 MB  | 4,0 GB  |
| 2002 | 120 MB  | 753 MB  | 2020 | 58 MB   | 434 MB  |
| 2004 | 41 MB   | ~300 MB | 2022 | 642 MB  | 4,3 GB  |
| 2006 | 131 MB  | 805 MB  | 2024 | 48 MB   | 329 MB  |
| 2008 | 43 MB   | ~300 MB | 2026 | 316 MB (só 1º turno) | 3,2 GB |
| 2010 | 133 MB  | 790 MB  |      |         |         |

* `detalhe_votacao_munzona`: 0,8–4,4 MB por ano (desprezível).
* Total `raw/` para 1994–2026: **≈ 2,7 GB** de ZIP. Parquet (ZSTD) fica em ~35–40 % do ZIP
  (2024: 48 MB → 18 MB; 717 mil linhas), logo o lake completo ≈ **1–1,2 GB**.
* **Disco temporário**: o ETL extrai só `_BRASIL.csv` para `raw/_tmp/` — reserve até
  **~4,5 GB livres** para 2014/2018/2022/2026. O DuckDB também usa `raw/_tmp/duckdb_tmp`
  para *spill*; com `--memoria 4GB` o ano de 2022 cabe em máquinas de 8 GB.
* Tempo: 2024 (329 MB CSV) levou 11 s em 4 threads; estimar ~2–3 min para 2022.

## Normalização (o que o ETL faz com cada coluna)

1. Lê com `read_csv(delim=';', header=true, quote='"', encoding='latin-1', all_varchar=true,
   union_by_name=true)`. O sniffer de tipos é desligado de propósito (ver quirks).
2. Nomes → minúsculas (`QT_VOTOS_NOMINAIS` → `qt_votos_nominais`).
3. Marcadores do TSE `#NE`, `#NE#`, `#NULO`, `#NULO#` e string vazia → `NULL` em **todas** as colunas.
4. Tipagem por prefixo: `qt_*` → BIGINT; `cd_*`/`nr_*` → BIGINT com `-1`, `-3`, `-4` → NULL;
   `dt_*` → DATE (`dd/mm/aaaa`); `hh_*` → TIME; `sq_*`, `sg_ue`, `cd_municipio` → VARCHAR.
   Qualquer outra coluna fica VARCHAR (as colunas brutas são todas preservadas).
5. `cd_municipio` → `LPAD(…, 5, '0')` (código TSE).
6. **Colunas garantidas** (`etl.COLUNAS_GARANTIDAS`): se o ano não traz a coluna, ela é criada
   como NULL tipado, então o esquema do lake é estável de 1994 a 2026.
7. Derivada **`cd_municipio_ibge`** (7 dígitos) via `data/ref/tse-municipios-2026.json`
   (`abr[].mu[].cd` = TSE, `cdi` = IBGE). Municípios extintos/fundidos não casam → NULL
   (o `etl` imprime quantas linhas ficaram sem IBGE). Em 2024: 0 de 717 246.
8. Escreve um `part.parquet` por (ano, turno) com ZSTD + `_meta.json`.

## Quirks de esquema encontrados (e antecipados)

* **Todos os anos foram re-exportados pelo TSE no layout atual** (cabeçalho maiúsculo com
  prefixos `DT_/QT_/CD_`, `;`, aspas, latin-1), inclusive 1994 — não há cabeçalhos
  abreviados antigos nos ZIPs atuais. O que muda é o **conjunto** de colunas:
  * 2002–2014 **não têm** `QT_VOTOS_NOMINAIS_VALIDOS`, `NM_TIPO_DESTINACAO_VOTOS`,
    `NR/NM/SG_FEDERACAO`, `DS_COMPOSICAO_FEDERACAO`, `CD/DS_SITUACAO_JULGAMENTO`,
    `CD/DS_SITUACAO_CASSACAO`, `CD/DS_SITUACAO_(DCONST_)DIPLOMA` (38 colunas vs 49).
    Nesses anos `qt_votos_nominais_validos` é NULL — use `qt_votos_nominais`.
  * 2018 chama `CD_SITUACAO_DIPLOMA`/`DS_SITUACAO_DIPLOMA`; 1994, 1998 e 2020+ chamam
    `CD_SITUACAO_DCONST_DIPLOMA`/`DS_…`. Ambas ficam no Parquet com o nome original.
  * `detalhe_votacao_munzona` tem exatamente as mesmas 47 colunas em todos os anos.
* **`CD_MUNICIPIO` ora vem com aspas (`"01120"`), ora sem (`74330`) no mesmo arquivo.**
  Com sniffer ligado o DuckDB tiparia como inteiro e perderia o zero à esquerda; por isso
  `all_varchar=true` + `LPAD`. Mesmo cuidado com `SG_UE` (é `"BR"`, `"SP"` ou `"01120"`).
* `ANO_ELEICAO` também alterna entre `1998` e `"1998"`; `NR_ZONA = -3` em 1994 (zona
  desconhecida); `SQ_CANDIDATO` tem de 2 (`61`, em 2006) a 14 dígitos (1994) — mantido VARCHAR.
* `CD_ELEICAO` não é comparável entre anos (`1994001`, `200201`, `37`, `143`, `546`, `6259`).
* `TP_ABRANGENCIA`/`SG_UE`: eleição presidencial vem com `TP_ABRANGENCIA='F'`, `SG_UE='BR'`,
  mas `SG_UF` continua sendo a UF real da votação — filtre presidente por `cd_cargo = 1`,
  não por UF.
* **Cada ZIP traz `_{UF}.csv` para cada UF, `_BRASIL.csv` (união de tudo) e, em anos
  gerais, `_BR.csv` (linhas da eleição presidencial).** Ler todos os CSVs duplicaria os
  votos; o ETL lê **só** `_BRASIL.csv` quando existe (todos os anos testados têm).
* **Votos anulados**: em `votacao_candidato_munzona`, `nm_tipo_destinacao_votos` pode ser
  `Válido`, `Anulado` ou `Anulado sub judice`; `qt_votos_nominais` inclui os anulados e
  `qt_votos_nominais_validos` zera-os. Para percentuais oficiais some só `Válido`.
  Ainda assim o total de nominais válidos do `detalhe` (2024, prefeito, 1º turno:
  112 558 775) difere ~0,4 % da soma dos candidatos `Válido` (112 111 755), porque o
  `detalhe` é um retrato da totalização e o `candidato` reflete decisões judiciais
  posteriores. **Não misture as duas tabelas no mesmo denominador.**
* Percentuais em `consulta.py` (`pct_nominais`) usam os votos nominais do município como
  denominador — aproximação razoável para majoritários; para proporcionais o oficial
  inclui votos de legenda (`votacao_partido_munzona`).
* O CKAN do TSE devolve `size: null` em todos os recursos; `Last-Modified` dos ZIPs muda
  com frequência (o TSE regera arquivos antigos: 2022 foi regerado em 04/10/2026), então
  **não** confie em "já baixei" entre meses — o `baixar` compara tamanho; para forçar,
  apague o ZIP.
* Eleição 2026 traz `TP_AGREMIACAO = 'FEDERAÇÃO'` e colunas de federação preenchidas; 2022 já
  tinha as colunas mas quase sempre `#NULO#`.

## Próximos passos sugeridos

* `votacao_secao` (por UF): a estrutura (`TABELAS[...]["por_uf"]`, `--uf`) já existe; falta só
  decidir partição (`ano=/turno=/uf=`) e o orçamento de disco (~0,9 GB só SP 2022).
* `votacao_partido_munzona` para percentuais oficiais em proporcionais.
* Ordenar o Parquet por `sg_uf, cd_municipio` para *row-group pruning* nas consultas por município.
* Materializar agregados (município × cargo × candidato) para servir a API sem ler zonas.
