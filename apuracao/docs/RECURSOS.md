# Contratos dos recursos da noite (caminho, ritmo, compartilhar, telão, alertas, fonte, chat+)

Complementa `SCHEMA.md`, `CHAT.md` e `ALERTAS.md`. Todos os arquivos ficam em `/{prefixo}/`
(ex.: `/6258/1/`), gerados pelo coletor a cada ciclo rápido (10 s) quando algo mudou.

## 1. `caminho.json` — caminho para a vitória (aritmética, não projeção)

Estimativa dos votos **válidos** que ainda faltam, município a município: seções que faltam ×
(válidos ÷ seções totais) do **1º turno** do mesmo município (`base`). Quem lidera, quanto o
outro precisaria dos votos que faltam para empatar, e onde estão esses votos.

```json
{
  "schema": 1,
  "atualizado_em": "2026-10-25T19:31:05-03:00",
  "base": { "eleicao": "6257", "descricao": "comparecimento e votos válidos do 1º turno de 2026" },
  "cands": ["280002542548", "280002551544"],
  "restante": { "votos_est": 11234567, "secoes": 123456, "pct_secoes": 24.7, "municipios_abertos": 2130 },
  "necessario": { "280002542548": 56.3, "280002551544": 43.7 },
  "definido_matematicamente": null,
  "por_regiao": {
    "Nordeste": { "votos_est": 6500000, "secoes": 70000, "pct_secoes_restantes": 30.1, "base_pct": [66.2, 33.8] }
  },
  "por_uf": {
    "BA": { "votos_est": 2100000, "secoes": 21000, "pct_secoes_restantes": 41.0, "base_pct": [69.9, 30.1] }
  },
  "maiores_abertos": [
    { "ibge": "2927408", "nome": "Salvador", "uf": "BA", "votos_est": 450000, "pct_secoes": 38.2, "base_pct": [70.1, 29.9] }
  ]
}
```

- `necessario[c]` = percentual dos votos válidos restantes que `c` precisa para **empatar** com o
  líder (`> 100` → impossível; o líder recebe o complemento). Com 2 candidatos: `x = (a − b + R) / 2`,
  `necessario[b] = 100·x/R`, onde `a` lidera, `R` = `restante.votos_est`.
- `definido_matematicamente` = id do líder quando `margem_votos > restante.votos_est` (ainda
  assim só o TSE "define": o campo `definido` de `br.json` continua mandando no selo "Eleito").
- `base_pct` = divisão dos votos do 1º turno **só entre os dois finalistas**, na ordem de `cands`.
  É contexto ("onde faltam votos e como essa região votou"), nunca uma previsão.
- `maiores_abertos`: até 15 municípios com mais votos estimados restantes.
- Antes de a totalização começar: `restante.pct_secoes = 100`, `necessario` com `50.0` nos dois.

## 2. `ritmo.json` — velocidade da apuração

```json
{
  "schema": 1,
  "atualizado_em": "…",
  "secoes_por_min": 812.4,
  "votos_por_min": 230000,
  "janela_min": 10,
  "amostras": 9,
  "eta_90": "2026-10-25T20:12:00-03:00",
  "eta_100": "2026-10-25T20:41:00-03:00",
  "inicio": "2026-10-25T17:03:12-03:00",
  "fase": "aguardando" | "acelerando" | "ritmo" | "cauda" | "concluida"
}
```

Calculado da linha do tempo nacional (últimos 10 min de pontos). `eta_*` = `null` quando
`secoes_por_min` < 1 ou há menos de 3 amostras. É extrapolação da **velocidade de contagem**,
nunca do resultado. `fase`: `cauda` quando ≥ 95% das seções (o fim é sempre mais lento).

## 3. Compartilhamento (meu município, WhatsApp, imagem)

- `og/placar.png` (1200×630) e `og/uf/{SIGLA}.png`: imagem do placar gerada pelo coletor a cada
  mudança (Pillow). Use em `og:image`/`twitter:image` e no botão "compartilhar".
- O card de município é desenhado **no navegador** (canvas 1080×1080) a partir de `mun.json`;
  "compartilhar" usa `navigator.share` com o arquivo quando houver suporte, senão abre
  `https://wa.me/?text=…` com o texto: `"{Município}-{UF}: {A} 51,2% × {B} 48,8% ({pct}% das seções). Acompanhe: {url}#m={ibge}"`.
- Deep link: `#m=<ibge>` abre o município; `#uf=<SIGLA>` abre o estado. `#telao` abre o modo telão.
- Geolocalização: o navegador pede permissão só ao tocar em "usar minha localização"; o município
  é o de centróide mais próximo (centróides calculados no cliente com `d3-geo` a partir da malha).

## 4. `fonte` — confira na fonte

- `meta.json` ganha `"fonte": { "catalogo": ".../comum/config/ele-c.json", "br": ".../dados/br/br-c0001-e006258-u.json", "uf": ".../dados/{uf}/{uf}-c0001-e006258-u.json", "municipio": ".../dados/{uf}/{uf}{tse}-c0001-e006258-u.json" }`
  (`{uf}` minúsculo, `{tse}` = código TSE de 5 dígitos, em `ref/municipios.json`).
- `br.json` e cada entrada de `uf.json` ganham `"fonte": "<url>"` já resolvida.
- Na interface, cada bloco de números tem um link discreto "fonte: TSE ↗" para o JSON
  oficial correspondente, e o rodapé explica: "Reexibimos o arquivo oficial. Abra e compare."

## 5. Modo telão

`#telao` (ou botão "Telão" no cabeçalho): tela cheia, fundo escuro, placar gigante, mapa por UF,
rodapé com `ritmo` e "caminho", carrossel automático dos estados a cada 12 s (com o resultado
da UF), sem chat, sem scroll. `Esc` sai. Pensado para bar, redação e sala de aula.

## 6. Chat: salas, reações e termômetro — ver `CHAT.md` (seção "Extensões")

## 7. Alertas — ver `ALERTAS.md`
