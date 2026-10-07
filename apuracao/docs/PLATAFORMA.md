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
6. **Dados**: além do TSE, carregar Câmara/Senado (votações, emendas), IBGE (perfil dos municípios),
   e eleições de outros países (IFES/IDEA, OpenElections nos EUA). Cada fonte vira uma partição
   Parquet com o mesmo contrato do `historico/`.
7. **Produto de análise**: consultas prontas (mapa comparativo entre eleições, virada por município,
   correlação com indicadores), exportação CSV/Parquet, e um notebook público por eleição.

## Regras que valem desde já

- O e-mail do pagamento é o identificador da conta; nunca trocar sem confirmação por link.
- Nada de senha. Login por link no e-mail (e, mais tarde, passkeys).
- Tudo que a pessoa comprou fica gravado em `pagamentos`/`assinaturas` com `usuario_id`.
