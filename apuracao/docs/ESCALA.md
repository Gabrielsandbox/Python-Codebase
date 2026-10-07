# Escala: 1 milhão de pessoas no dia

Premissas: 1 milhão de visitantes únicos no dia 25/10, pico entre 18h e 21h com até
**250 mil pessoas simultâneas** (25% do total ao mesmo tempo, que é agressivo), 1% pagando o
chat (10 mil), 30% delas conectadas ao mesmo tempo (3 mil) — e um cenário pessimista de
10 mil no chat ao mesmo tempo.

## 1. Site e dados (CDN) — pronto, com uma ressalva de plano

Cada navegador faz ~33 requisições por minuto (br/uf/status/caminho/ritmo a cada 10 s,
timeline a cada 30 s, municípios a cada 60 s), todas com `ETag`; como o TSE muda os
números uma vez por minuto, a maioria volta como `304` sem corpo.

| | por pessoa | 250 mil simultâneas |
|---|---|---|
| requisições | 0,55/s | **~140 mil/s** |
| banda (gzip, com 304) | ~2 KB/s | **~4 Gbps** |
| 4 horas de pico | ~29 MB | **~7 TB** |

Cloudflare serve isso de cache (todos pedem os mesmos ~10 arquivos; taxa de acerto > 99,9%),
e o R2 na origem recebe algumas centenas de requisições por minuto. Nossa origem (coletor,
Railway) **não está no caminho** de ninguém.

Ressalva: o plano grátis da Cloudflare é "sem limite", mas 7 TB numa noite de arquivos JSON
chama atenção. **Use o plano Pro (US$ 20/mês)** no mês da eleição. Não há custo por tráfego
de saída no R2 nem no Pages.

O que **não** pode acontecer: o site apontar para `apuracao servir` (a API local de
desenvolvimento). Em produção `VITE_DADOS_BASE` aponta para `https://dados.<dominio>`.

## 2. Chat — pronto para 10 mil simultâneos com 3–4 réplicas

O custo de um chat é `pessoas na sala × mensagens por segundo`. Duas medidas resolvem isso:

1. **Entrega em lotes**: a cada 300 ms cada sala recebe um único frame com todas as
   mensagens novas, serializado uma vez. O custo por pessoa vira ~3 frames/s, qualquer que
   seja o volume de mensagens.
2. **Teto por sala**: 15 mensagens/s por sala (modo lento). Acima disso a mensagem volta com
   "sala muito movimentada" e a sala continua legível. Com 10 mil pessoas, 15 msg/s já é
   mais do que dá para ler.

Medido nesta máquina (1 processo Python, sem Redis, clientes no mesmo host):

| clientes | msgs/s | entregas/s | latência p50 | p95 |
|---|---|---|---|---|
| 1.500 | 10 | 6.500 | 155 ms | 1,5 s |
| 3.000 | 20 | 10.600 | 0,8 s | 4 s |
| 4.500 (3 processos cliente) | 21 | 31.000 | 0,4 s | 4,8 s |

Antes dos lotes, 3.000 clientes a 20 msg/s davam 8,5 s de p50. O p95 alto vem dos picos de
conexão simultânea no teste (todos entram no mesmo segundo); na vida real as entradas se
espalham. Regra prática: **até ~3.000 pessoas por processo**. Para 10 mil simultâneas,
4 réplicas de `python -m chat` (1 vCPU / 512 MB cada) atrás do Redis. O Railway distribui as
conexões; o Redis replica mensagens, presença e reações entre elas.

Pagamento: 10 mil checkouts numa noite é tráfego trivial para o Stripe e para o `/chat/acesso`.

Ainda falta (produto): moderador humano com acesso à tabela `bloqueados`.

## 3. Alertas — pronto; use o canal do Telegram

- **Web Push**: envio paralelo com 64 threads: 200 mil inscrições em ~2–3 minutos por marco.
- **Telegram individual**: a API aceita ~30 mensagens/s por bot → 10 mil inscritos levam
  6 minutos por marco. Por isso o serviço também posta num **canal público**
  (`TELEGRAM_CANAL=@seu_canal`): um post alcança todo mundo na hora, sem limite. Divulgue o
  canal, não o bot, como "receba os alertas".

## 4. Coletor — independente da audiência

O coletor faz ~100 requisições/s ao TSE, não importa quantas pessoas estejam no site. Risco
dele é outro (TSE fora do ar, formato mudar) e está no `RUNBOOK.md`.

## 5. Teste de carga antes do dia (D-7)

- Site/CDN: com `k6`, 20 mil requisições/s contra `https://dados.<dominio>/<prefixo>/br.json`
  por 5 minutos; esperado: 100% de acertos de cache, latência < 50 ms, origem R2 sem picos.
- Chat: `python scripts/bench_chat.py <N> <msgs/s> <segundos>` contra o serviço em produção
  (modo dev desligado? use um ambiente de ensaio com `CHAT_PAGAMENTO=dev`), 3 processos de
  1.500 clientes cada; esperado p50 < 1 s. Depois escale as réplicas no Railway.
- Alertas: 1 marco de teste (`POST /alertas/teste` com `ALERTAS_DEV=1` no ensaio) com
  algumas centenas de inscrições reais da equipe.

## 6. Resumo

| Componente | 250 mil simultâneos | o que fazer |
|---|---|---|
| Site + dados | pronto | Cloudflare Pro no mês; conferir cache hit no painel |
| Chat (10 mil) | pronto | 4 réplicas + Redis no Railway; teste D-7 |
| Alertas | pronto | canal do Telegram; chaves VAPID |
| Pagamento | pronto | CNPJ no Stripe (ou Mercado Pago) |
| Coletor | pronto | coletor reserva em outro provedor (runbook) |
