# Políticos — "Depois do voto" (contrato de dados)

Página pública e gratuita (`web/politicos.html`) para procurar qualquer candidato de 2026 pelo
nome ou número de urna e ver, de quem tem mandato no Congresso, presença, votos, propostas e
gastos. O perfil para salvar e acompanhar políticos (pago, junto com o chat) vem depois e usa os
mesmos arquivos.

## Pipeline

```bash
python -m politicos baixar   # fontes -> data/politicos/raw/ (~1,2 GB, idempotente)
python -m politicos gerar    # -> data/latest/politicos/ (indice.json + p/{id}.json), ~25 s
python -m politicos tudo     # os dois; rodar 1x por dia (a Câmara regenera os arquivos de madrugada)
```

Saída em `POLITICOS_OUT_DIR` (padrão `$APURACAO_DATA_DIR/politicos`, ou seja,
`data/latest/politicos`). Em dev a API serve em `/dados/politicos/*`; em produção vai para o
mesmo bucket/CDN dos snapshots, prefixo `politicos/`. O frontend lê `${VITE_DADOS_BASE}/politicos`.

| Fonte | O que vem | Como |
|---|---|---|
| Câmara, arquivos em massa | presença em eventos, sessões, proposições e autores (2023–2026), votações nominais e votos (2025–2026), cota parlamentar | `dadosabertos.camara.leg.br/arquivos`, `camara.leg.br/cotas` |
| Câmara, API | deputados em exercício + detalhe (CPF, nome civil, nascimento) | 514 chamadas, em cache |
| Senado, API | senadores em exercício, detalhe, votações nominais desde 02/2023, autorias | 1 + 3×81 chamadas, em cache |
| Senado, CEAPS | reembolsos 2023–2026 (CSV latin-1) | `senado.leg.br/transparencia/LAI/verba` |
| TSE | candidaturas 2026 e bens declarados | `consulta_cand_2026.zip`, `bem_candidato_2026.zip` |
| TSE | plano de governo de quem concorre a presidente (PDF) | `proposta_governo_2026_BR.zip` (18 MB, 14 PDFs); leitura com `pypdf` (extra `politicos`) |

**Cruzamento** mandato × candidatura: CPF (Câmara e TSE publicam); senão nome civil + data de
nascimento (Senado). CPF e nome de cruzamento nunca saem nos arquivos públicos. Em out/2026:
538 de 594 parlamentares concorreram; os 56 restantes são senadores com mandato até 2031 e
deputados que não concorreram ou foram só vice/suplente.

## `indice.json`

```json
{ "schema": 1, "gerado_em": "2026-10-17T22:52:47+00:00",
  "cargos": {"1": "Presidente", "3": "Governador", "5": "Senador", "6": "Deputado federal", "7": "Deputado estadual", "8": "Deputado distrital"},
  "campos": ["id", "nome", "cargo", "uf", "partido", "numero", "situacao", "mandato"],
  "itens": [["280002542548", "Lula", "1", "BR", "PT", "13", "2turno", ""], ["s6335", "Damares Alves", "", "DF", "REPUBLICANOS", "", "", "s"]] }
```

- `id`: `SQ_CANDIDATO` do TSE; quem tem mandato e não concorreu vira `d{idCâmara}` / `s{códigoSenado}`.
- `cargo`: código do TSE ou `""` (não concorreu). Vices e suplentes de senador ficam de fora.
- `situacao`: `eleito` | `2turno` | `nao_eleito` | `suplente` | `""` (sem resultado: indeferida, renúncia).
- `mandato`: `d` (Câmara) | `s` (Senado) | `""`.
- ~20 mil linhas, 1,4 MB (350 KB gzip). A busca é toda no navegador.

## `p/{id}.json`

```jsonc
{
  "schema": 1, "id": "…", "nome": "Nome de urna", "nome_civil": "…", "foto": "url|null",
  "candidatura": null | {
    "cargo", "cargo_nome", "uf", "numero", "partido", "partido_nome", "coligacao", "composicao",
    "situacao", "segundo_turno", "ocupacao", "instrucao", "genero", "nascimento",
    "bens": { "total", "quantidade", "maiores": [{ "tipo", "descricao", "valor" }] },  // até 12
    "plano": null | { "json": "planos/{id}.json", "pdf": "planos/{id}_01.pdf", "paginas", "bytes" }
  },
  "mandato": null | {
    "casa": "camara|senado", "cargo", "nome", "partido", "uf", "foto", "condicao", "url", "email", "redes",
    "presenca": {                         // Câmara
      "desde", "sessoes", "presente", "por_ano": [{ "ano", "sessoes", "presente" }],
      "linha": "ppap…"                    // 1 letra por sessão deliberativa, em ordem: p | a
    } | {                                 // Senado
      "desde", "votacoes", "presente", "justificada", "sem_justificativa", "outros",
      "por_ano": [{ "ano", "votacoes", "presente" }],
      "linha": "ppjp…"                    // 1 letra por votação nominal: p | j | a | o
    },
    "proposicoes": { "autor": {"PL": 6}, "coautor": {"PEC": 16}, "lista": [{ "sigla", "numero", "ano", "ementa", "data", "situacao", "url", "papel" }] },
    "votos": { "total", "por_voto": {"Sim": 261}, "lista": [{ "data", "proposicao", "ementa", "descricao", "aprovada", "voto", "url" }] },
    "despesas": null | { "total", "por_ano": [...], "por_categoria": [...], "fornecedores": [...], "ultima" }
  },
  "atualizado_em": "…", "fontes": [{ "nome", "url" }]
}
```

## `planos/`

O PDF oficial (`{id}_{parte}.pdf`, como o TSE publica) e `{id}.json`, baixado só quando a ficha abre:

```jsonc
{ "schema": 1, "id": "…", "atualizado_em": "…", "fonte": { "nome", "url" },
  "documentos": [{ "pdf": "planos/{id}_01.pdf", "bytes",
                   "paginas": ["texto da página 1", "…"],          // extraído, um parágrafo por página
                   "titulos": [{ "t": "Saúde", "p": 34 }] }] }     // p = página do arquivo (link #page=p)
```

**Sumário** (regra única para todos, em `politicos/planos.py`): se o PDF tem sumário próprio
(linhas "Título ..... 12"), valem os itens dele, ligados à página do arquivo onde o título aparece
(o número impresso costuma não bater: capa, páginas sem número); um índice remissivo logo depois é
cortado quando os números param de crescer. Sem sumário próprio, títulos pelo estilo (fonte ≥ 1,25×
o corpo ou linha toda em negrito), sem cabeçalhos repetidos, até 40 entradas. Nada é resumido nem
reescrito. **Busca** (no navegador): sem acento e sem caixa, a partir do início da palavra; termo de
até 4 letras (sigla: SUS, INSS) só como palavra inteira.

## Decisões e limites (o texto da página diz cada um)

- **Presença na Câmara**: sessões deliberativas do plenário encerradas, contadas a partir da
  primeira presença do deputado na legislatura (suplente não é cobrado pelo período antes de
  assumir). A Câmara não publica faltas justificadas nos dados abertos: contam como ausência.
- **Presença no Senado**: participação nas votações nominais. O Senado registra o motivo da
  ausência; separamos justificada (licença, missão, atividade parlamentar) de não comparecimento.
- **Votos**: Câmara só 2025–2026 (arquivos de 2023–2024 somam ~300 MB a mais); Senado desde 02/2023.
  Sim e Não não têm cor de "certo/errado" na página.
- **Propostas**: desde 02/2023. A lista mostra o que o parlamentar apresentou como 1º autor e as
  PECs que assinou junto (uma PEC precisa de 1/3 da casa).
- **Plano de governo**: só presidente por enquanto. Governadores usam o mesmo formato
  (`proposta_governo_2026_{UF}.zip`); falta baixar os 27 arquivos. O texto extraído pode trazer
  tabelas e colunas fora de ordem e espaços dentro de palavras ("CUL TURA"); a página avisa que vale o PDF.
- **Fora por enquanto**: Executivo (mandato de presidente e governadores), deputados estaduais e vereadores
  (cada Assembleia publica de um jeito), parlamentares que já saíram, foto de quem não tem mandato.
