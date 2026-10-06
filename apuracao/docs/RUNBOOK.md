# Runbook — 25/10/2026 (2º turno)

Horários em Brasília. Urnas fecham às 17h; o TSE começa a totalizar logo depois e a maior
parte dos votos presidenciais costuma estar totalizada entre 19h e 21h.

## D-7 a D-1

- [ ] `apuracao eleicoes --ano 2026` → confirmar que **6258** aparece com turno 2 (até lá o
  coletor deriva o código via `cdt2`, o que já funciona).
- [ ] Verificar diariamente `https://resultados.tse.jus.br/oficial/ele2026/6258/config/mun-e006258-cm.json`
  (hoje 404). Quando existir, o coletor passa a usar a lista do 2º turno automaticamente.
- [ ] Rodar `apuracao coletar --ano 2026 --turno 2` em produção desde D-2: ele publica
  `aguardando_totalizacao: true` e o site mostra o estado "aguardando". Custo: 29 req/10 s.
- [ ] Coletor passivo no 2º provedor pronto (mesmas variáveis, `--intervalo-rapido 15`), parado.
- [ ] `scripts/watchdog.py https://<dados>/ --max-idade 90 --webhook ...` num cron a cada minuto
  em um terceiro lugar (healthchecks.io ou cron de VPS).
- [ ] Teste de carga do CDN com k6 (20k req/s em `br.json`) — deve sair 100% do cache.
- [ ] Ensaio: apontar `ativo.json` para `6257/1` (1º turno, dados completos) e validar o site.
- [ ] Página/OG image, textos legais, link do acervo funcionando, política de privacidade.

## Dia D

| Hora | Ação |
|---|---|
| 08h | Conferir coletor ativo (`status.json` fresco), watchdog verde, bucket com `ativo.json → 6258/1`. |
| 16h30 | Equipe em call. Abrir dashboards do Cloudflare (req/s, cache hit) e logs do coletor. |
| 17h00 | TSE começa a publicar. `aguardando_totalizacao` deve virar `false` em minutos. Se continuar 404 às 17h20, verificar se o diretório `ele2026/6258/dados/` mudou de padrão (ver `apuracao/tse/urls.py`). |
| 17h–21h | Observar `erros_ciclo`, latência do ciclo municipal (deve ficar < 60 s) e `x-ratelimit-remaining` nos logs. Se o TSE começar a devolver 429/503, reduzir `--rate 80` e `--intervalo-mun 90`. |
| Quando `definido: true` | O site mostra "Eleito"; não editar nada à mão. Captura do placar final para redes. |
| Após 100% | Manter coletor 24h (o TSE pode retotalizar seções com problema). Fazer snapshot do `data/raw` para o acervo (`tar` + upload). |

## Incidentes

- **Coletor caiu** (watchdog alerta, `ultima_coleta` > 90 s): subir o passivo. Como as escritas
  são idempotentes, os dois podem rodar juntos sem conflito; depois desligar um.
- **TSE mudou formato**: o parser ignora campos desconhecidos; se algo vital sumir (ex.: `vap`),
  `br.json` fica com zeros. Comparar com o site do TSE e ajustar `parse.py`; os testes com
  fixtures mostram o que quebrou. Sem deploy do frontend — ele só lê o contrato.
- **CDN com cache velho**: purgar `ativo.json` e `*/status.json` no Cloudflare; o resto expira
  em ≤ 30 s sozinho.
- **Pico além do esperado**: nada a fazer na origem; conferir só que o cache hit ratio > 99%.
  Se a Pages/estático cair (improvável), o `web/dist` pode ser servido de qualquer bucket.
- **Suspeita de dado errado**: o site mostra exatamente o `-u.json` do TSE; conferir o arquivo
  bruto em `data/raw/6258/br/<idg>.json` contra `resultados.tse.jus.br`.
