# Chat ao vivo (acesso pago, R$ 5) — contrato

Serviço separado do coletor e do CDN: `apuracao/chat/` (FastAPI + WebSocket), porta 8001 em dev.
Base pública configurável no frontend por `VITE_CHAT_BASE` (padrão `/chat`, proxy em dev).

Fluxo: **pagar R$ 5 (PIX ou cartão) → receber token de acesso → conectar no WebSocket.**
O pagamento é único (não é assinatura). Quem paga ganha uma **conta** (e-mail) e fica logado
(token com validade de 1 ano, `CHAT_JWT_DIAS`): é a mesma conta que, depois da apuração, acessa a
plataforma de dados (docs/PLATAFORMA.md).

## Endpoints HTTP

### `POST /chat/checkout`
Body: `{ "apelido": "Maria", "email": "maria@exemplo.com", "retorno": "https://site/…" }`
Resposta: `{ "url": "https://checkout.stripe.com/…", "ref": "cs_…" }`

- `apelido`: 2–24 caracteres, letras/números/espaço/`_`; é validado e normalizado no servidor.
- `email`: obrigatório; cria (ou reaproveita) a **conta** quando o pagamento confirma. No Stripe vai
  como `customer_email` e o e-mail confirmado volta em `customer_details.email` no webhook.
- O cliente redireciona o navegador para `url`. Ao concluir, o provedor volta para
  `retorno?chat_ref=<ref>`.
- Em desenvolvimento (`CHAT_PAGAMENTO=dev`) a `url` já é o próprio `retorno?chat_ref=…`, sem cobrar.

### `GET /chat/acesso?ref=<ref>`
Resposta `200`: `{ "token": "<jwt>", "apelido": "Maria", "email": "maria@exemplo.com", "expira_em": "2027-10-25T…", "autor": "…" }`
Resposta `402`: `{ "detail": "pagamento pendente" }` (PIX ainda não compensou; o cliente pode
tentar de novo a cada 3 s). `404` ref desconhecida. `410` sessão de pagamento expirada (recomeçar).

O cliente guarda `token` em `localStorage` (`chat_token`) e `apelido`.

### `GET /chat/eu`
Cabeçalho `Authorization: Bearer <jwt>`. `200 { "apelido", "expira_em" }` ou `401`. Permite ao
cliente distinguir "token inválido" de "servidor fora" sem abrir WebSocket.

### `GET /chat/estado`
`{ "online": 1234, "aberto": true, "preco_centavos": 500, "mensagens_total": 98765 }`
Público, cacheável por 5 s. Serve para mostrar "1.234 pessoas no chat" no paywall.

### `GET /chat/previa?sala=geral`
Público, cacheável por 5 s. Últimas 20 mensagens da sala **sem precisar de token**, para o
paywall mostrar o chat ao vivo desfocado ao fundo:
`{ "sala": "geral", "online": 1234, "mensagens": [ { "apelido": "Maria", "texto": "…", "t": "…", "tipo": "msg" } ] }`

### `POST /chat/webhook/stripe`
Webhook do Stripe (`checkout.session.completed`, `checkout.session.async_payment_succeeded`
para PIX). Marca o pagamento como `pago`.

## WebSocket `GET /chat/ws?token=<jwt>`

Fecha com código `4401` (após o `accept`, para o navegador ver o código) se o token for
inválido/expirado, `4429` se excedeu o limite. Todos os frames são **texto** JSON.

Mensagens **servidor → cliente** (JSON, uma por frame):
```json
{ "tipo": "historico", "mensagens": [ …até 50 itens do tipo "msg"… ] }
{ "tipo": "msg", "id": "01J…", "apelido": "Maria", "texto": "Vai virar!", "t": "2026-10-25T19:02:11-03:00", "eu": false }
{ "tipo": "sistema", "texto": "Flavio Bolsonaro 50,4% × Lula 49,6% — 71,2% das seções", "t": "…" }
{ "tipo": "presenca", "online": 1234 }
{ "tipo": "erro", "codigo": "rate_limit" | "repetida" | "texto_invalido" | "bloqueado", "texto": "…" }
{ "tipo": "pong" }
```
Os itens de `historico` também trazem `eu` (true nas mensagens do próprio usuário).

**Entrega em lotes (escala)**: fora do `historico`, mensagens e avisos de sistema chegam
agrupados a cada ~300 ms em `{ "tipo": "lote", "itens": [ …msg | sistema… ] }`, um frame por
pessoa serializado uma vez. Cada `msg` traz `"autor": "<10 hex>"` (código estável do usuário,
não revela o id); `/chat/acesso` e `/chat/eu` devolvem o `autor` do próprio usuário, e o
cliente marca como "minha" a mensagem cujo `autor` é igual ao seu. Teto por sala: 15
mensagens/s; acima disso o remetente recebe `{ "tipo": "erro", "codigo": "lotado" }`.

Mensagens **cliente → servidor**:
```json
{ "tipo": "msg", "texto": "Vai virar!" }
{ "tipo": "ping" }
```

Regras: texto 1–280 caracteres, sem URLs (removidas), 1 mensagem a cada 2 s por usuário,
filtro de palavras (`data/ref/chat-bloqueio.txt`, uma por linha), mensagens de `sistema` geradas
pelo servidor quando o placar muda (lê `br.json` publicado).

Escala: 1 processo atende ~10k conexões; vários processos compartilham mensagens via Redis
pub/sub (`CHAT_REDIS_URL`). Sem Redis, funciona em memória (1 processo, dev).

## Variáveis de ambiente

```
CHAT_PAGAMENTO=dev|stripe
CHAT_PRECO_CENTAVOS=500
CHAT_JWT_SECRET=<segredo longo>
CHAT_DB=data/chat.sqlite
CHAT_REDIS_URL=redis://localhost:6379/0   (opcional)
CHAT_DADOS_BASE=http://127.0.0.1:8000/dados   (de onde ler ativo.json/br.json p/ mensagens de sistema)
STRIPE_SECRET_KEY=sk_…
STRIPE_WEBHOOK_SECRET=whsec_…
```

## Pacote de R$ 5
O pagamento único libera **chat ao vivo + modo telão**. O token do chat é a prova de compra:
o telão só abre com token válido (`GET /chat/eu` → 200); sem token, o botão "Telão" abre o
paywall com o texto "Chat ao vivo + modo telão por R$ 5".

## Frontend — comportamento

- Painel de chat: coluna à direita no desktop (≥1100 px), *bottom sheet* no celular com um
  botão flutuante "Chat ao vivo · 1.234 online".
- Sem token: *paywall* com preço, o que inclui ("chat ao vivo durante toda a apuração"),
  campo de apelido, botão "Pagar R$ 5 e entrar" → `POST /chat/checkout` → redirect.
- Ao voltar com `?chat_ref=` na URL: chama `GET /chat/acesso` (repete a cada 3 s enquanto 402,
  mostrando "aguardando confirmação do PIX…"), guarda o token, limpa o parâmetro da URL.
- Com token: conecta no WS, mostra histórico, mensagens (as minhas alinhadas à direita),
  mensagens de sistema em destaque discreto, contador de online, estado da conexão
  (reconnect com backoff), input com contador de caracteres e Enter para enviar.
- Token expirado/inválido (4401): apaga o token e volta ao paywall.

## Extensões: salas por estado, reações e termômetro

### Salas
- WebSocket: `GET /chat/ws?token=<jwt>&sala=geral` (padrão) ou `&sala=SP` (sigla de UF em
  maiúsculas; `ZZ` = exterior). Sala inválida → `4400`.
- Cada `msg` e cada item de `historico` traz `"sala": "SP"`. Histórico e presença são por sala.
- `GET /chat/estado` passa a incluir `"salas": { "geral": 1234, "SP": 210, … }` (só salas com gente).
- Trocar de sala = fechar e reconectar com outro `sala` (o cliente mantém o token).

### Reações (explosão)
- Cliente → servidor: `{ "tipo": "reacao", "valor": "🔥" }`. Valores aceitos: `🔥 👏 😱 😂 🇧🇷`
  e `torcida:<id do candidato>` (ids de `meta.cands`). Limite: 5 reações/s por usuário (excesso é
  ignorado em silêncio).
- Servidor → clientes da sala, a cada 2 s quando houver algo:
  `{ "tipo": "reacoes", "janela_s": 2, "contagem": { "🔥": 12, "torcida:280002551544": 30 } }`.
  O cliente anima uma "explosão" proporcional à contagem (emojis subindo), estilo Twitch.

### Termômetro da torcida
- Servidor → clientes da sala, a cada 5 s:
  `{ "tipo": "termometro", "janela_min": 5, "torcida": { "280002542548": 1234, "280002551544": 987 }, "total": 2221 }`.
  Soma das reações `torcida:*` dos últimos 5 minutos na sala. O cliente mostra uma barra dividida
  com as cores dos candidatos e o texto "torcida do chat nos últimos 5 min". Não é pesquisa nem
  previsão: é só quem está no chat.
- Com Redis, contagens de reações são agregadas por processo e publicadas no canal da sala; o
  termômetro usa `INCRBY` em chaves por minuto (`chat:torcida:<sala>:<cand>:<minuto>`, TTL 6 min).

## Conta: quem paga fica logado

- Uma conta por e-mail (`usuarios`), criada na confirmação do pagamento; o pagamento guarda
  `email` e `usuario_id`. Comprar de novo com o mesmo e-mail reaproveita a conta (o apelido passa a
  ser o escolhido agora). O `sub` do token é o id da conta (`u_…`); tokens antigos com `sub` = ref
  continuam válidos.
- `GET /chat/eu` passa a devolver `email`.
- **Login por link (sem senha)**:
  - `POST /conta/login` body `{ "email", "retorno" }` → `{ "ok": true }` sempre (não revela se o
    e-mail existe). Se existe conta, envia um e-mail (Resend, `RESEND_API_KEY`/`EMAIL_DE`) com
    `retorno?login=<token>`; o token é de uso único e vale 30 min (`logins`, só o hash no banco).
    Em `CHAT_PAGAMENTO=dev` sem e-mail configurado, a resposta traz `link` para testar o fluxo.
  - `GET /conta/entrar?token=` → mesma resposta de `/chat/acesso` (`token`, `apelido`, `email`,
    `autor`), ou `410` se o link é inválido, já usado ou vencido.
- Frontend: campo de e-mail obrigatório no paywall; link "Já pagou? Entrar com o e-mail" abre um
  formulário que chama `/conta/login`; `?login=<token>` na URL é trocado por sessão ao carregar.
- Segurança: o token fica em `localStorage` (risco aceito para o chat; a plataforma deve migrar para
  cookie `httpOnly` com sessão no servidor). O link de login nunca é logado em produção.
