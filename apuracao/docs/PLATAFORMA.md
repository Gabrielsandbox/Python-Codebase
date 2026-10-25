# Da apuração à plataforma de dados políticos

O site da apuração é a aquisição: 1 milhão de pessoas numa noite, e quem paga R$ 5 pelo chat
cria uma conta. Depois do 2º turno, essa base vira o primeiro público de uma plataforma de
análise de dados de política (Brasil primeiro, depois outros países).

## O que já existe hoje

| Peça | Onde | Serve para |
|---|---|---|
| Conta por e-mail, sessão de 1 ano, login por link | `chat/contas.py`, `/conta/*` | identidade única: chat agora, plataforma depois |
| Pagamento único (Stripe, Pix e cartão) | `chat/pagamentos.py` | primeiro cliente pagante; `usuarios.origem = apuracao-2026` |
| ETL dos dados abertos do TSE → Parquet | `historico/` | acervo histórico (1998→2026) consultável |
| API do acervo com chave | `apuracao/api` (`/api/v1/historico/*`) | acesso programático |
| Snapshots da apuração (JSON) | bucket R2 | o 2º turno de 2026 entra no acervo no dia seguinte |
| **Acervo público (fase 1)** | `/acervo` no site, `historico/acervo.py`, `/api/v1/acervo/*` | eleições passadas, histórico de candidatos, pesquisas |

## Acervo, fase 1 (o que o site já faz)

Página `/acervo` (`web/acervo.html`, `web/src/acervo/`), três abas com o estado nos parâmetros
do hash (toda tela é compartilhável):

- **Eleições** (`#eleicoes?ano=&cargo=&turno=&uf=`): vencedor/mais votado, participação (aptos,
  comparecimento, abstenção, brancos, nulos), barras por candidato na cor do partido com tabela
  completa, e para presidente o quadro "quem venceu em cada estado" (clique leva ao recorte por UF).
  Eleições municipais ficam de fora até existir filtro por município.
- **Candidatos** (`#candidatos?q=`, perfil em `#candidato=<sq>:<ano>`): busca por nome de urna ou
  nome completo (sem acento), com filtros de ano/cargo/UF; o perfil junta todas as candidaturas da
  pessoa (chave `nm_candidato + dt_nascimento`, o TSE não dá id estável sem CPF) com partido,
  coligação, votos e resultado, mais ocupação, instrução e idade.
- **Pesquisas** (`#pesquisas?e=ano:cargo:uf&turno=&cenario=`): linhas por candidato (um ponto por
  divulgação, tooltip com instituto e margem), tiles com a última de cada um e tabela com registro
  no TSE. Alimentada por CSV (`apuracao historico pesquisas-importar arquivo.csv`), colunas:
  `instituto,data_divulgacao,data_inicio,data_fim,ano_eleicao,turno,cargo,uf,cenario,candidato,
  partido,percentual,amostra,margem,registro_tse,fonte_url`. Enquanto não há CSV importado a aba
  mostra o aviso "em breve". Fonte estruturada ainda em aberto: o TSE publica o registro das
  pesquisas (PesqEle) mas não os resultados; Poder360/Base dos Dados exigem API ou BigQuery.

Dados no lake por ano (`data/historico/parquet/`): `consulta_cand` (candidaturas, sem CPF,
e-mail, título e nº de processo), `votacao_candidato_munzona` (votos por município/zona) e
`detalhe_votacao_munzona` (aptos, comparecimento, brancos, nulos). Hoje: 2018 e 2022 completos
(2024 só votos; candidatos municipais entram quando houver filtro por município). Acrescentar um
ano: `apuracao historico acervo-preparar --anos 2014` com `APURACAO_ACERVO_ETL=1`.

Produção: a API lê o lake de `APURACAO_HISTORICO_DIR` (volume). No boot, com
`APURACAO_ACERVO_ANOS=2018,2022`, `historico/sync.py` sincroniza do espelho público
(`https://dados.apuracaoaovivo.com/historico/manifest.json`), roda o ETL para o que faltar se
`APURACAO_ACERVO_ETL=1` e publica no espelho se tiver credencial S3 (`acervo-publicar`).
Paleta: partidos sem cor em `data/ref/cores.json` aparecem em cinza neutro; PSOL e NOVO têm tons
mais escuros só nos gráficos (contraste), e o nome/sigla ao lado da marca carrega a identidade.

## Próximos passos (depois de 25/10)

1. **Área logada** (`conta.apuracaoaovivo.com` ou `/conta`): a mesma sessão do chat; mostra o que a
   pessoa tem (chat 2026, acervo), e-mail, sair de todos os aparelhos.
2. **Chaves de API por conta**: `APURACAO_API_KEYS` (lista fixa) vira tabela `chaves(usuario_id,
   chave_hash, criada_em, revogada_em)`; a API do acervo valida pela tabela.
3. **Assinatura mensal** (Stripe Billing, Pix recorrente ainda não existe: cartão): planos
   Pessoal / Jornalista / Equipe; webhook `customer.subscription.*` marca `assinaturas(usuario_id,
   plano, ativa_ate)`. O produto do R$ 5 vira "crédito" de boas-vindas (ex.: 1 mês do plano Pessoal).
4. **Banco**: SQLite do chat → Postgres (Railway) antes de abrir a plataforma; o chat continua com
   SQLite+Redis até lá (ou migra junto, é só a camada `chat/db.py`).
5. **Sessão**: trocar `localStorage` por cookie `httpOnly` + tabela de sessões (revogação).
6. **Dados**: filtro por município (eleições municipais 2020/2024 no acervo), anos anteriores a 2018,
   fonte estruturada de pesquisas, e, além do TSE, carregar Câmara/Senado (votações, emendas), IBGE (perfil dos municípios),
   e eleições de outros países (IFES/IDEA, OpenElections nos EUA). Cada fonte vira uma partição
   Parquet com o mesmo contrato do `historico/`.
7. **Produto de análise**: consultas prontas (mapa comparativo entre eleições, virada por município,
   correlação com indicadores), exportação CSV/Parquet, e um notebook público por eleição.

## Regras que valem desde já

- O e-mail do pagamento é o identificador da conta; nunca trocar sem confirmação por link.
- Nada de senha. Login por link no e-mail (e, mais tarde, passkeys).
- Tudo que a pessoa comprou fica gravado em `pagamentos`/`assinaturas` com `usuario_id`.
