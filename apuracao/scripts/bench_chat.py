"""Teste de carga do chat: python scripts/bench_chat.py <clientes> <msgs/s> <segundos>  (BASE em CHAT_BENCH_BASE)."""

import asyncio
import json
import os
import resource
import sys
import time

import httpx
import websockets

N = int(sys.argv[1])
TAXA = float(sys.argv[2])
DUR = float(sys.argv[3])  # clientes, msgs/s total, segundos
BASE = os.environ.get("CHAT_BENCH_BASE", "http://127.0.0.1:8001")
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))

SEM = asyncio.Semaphore(40)


async def token(cli, i):
    async with SEM:
        r = await cli.post(
            f"{BASE}/chat/checkout", json={"apelido": f"u{i}", "retorno": "https://x/y"}
        )
        ref = r.json()["ref"]
        return (await cli.get(f"{BASE}/chat/acesso", params={"ref": ref})).json()["token"]


lat = []
recebidas = 0
erros = 0


async def cliente(tok, i, envia):
    global recebidas, erros
    try:
        async with websockets.connect(
            f"ws://127.0.0.1:8011/chat/ws?token={tok}", max_queue=4096, open_timeout=30
        ) as ws:
            fim = time.time() + DUR

            async def rx():
                global recebidas
                async for raw in ws:
                    d = json.loads(raw)
                    itens = d.get("itens", []) if d.get("tipo") == "lote" else [d]
                    for it in itens:
                        if it.get("tipo") == "msg":
                            recebidas += 1
                            try:
                                lat.append(time.time() - float(it["texto"]))
                            except ValueError:
                                pass

            t = asyncio.create_task(rx())
            while time.time() < fim:
                if envia:
                    await ws.send(json.dumps({"tipo": "msg", "texto": repr(time.time())}))
                await asyncio.sleep(1.0 / envia if envia else 1)
            t.cancel()
    except Exception:
        erros += 1


async def main():
    async with httpx.AsyncClient(timeout=60, limits=httpx.Limits(max_connections=50)) as cli:
        toks = await asyncio.gather(*(token(cli, i) for i in range(N)))
    remetentes = max(1, int(TAXA * 2.5))  # cada remetente manda a cada 2,5 s (limite 2 s + folga)
    t0 = time.time()
    await asyncio.gather(
        *(cliente(t, i, (1 / 2.5) if i < remetentes else 0) for i, t in enumerate(toks))
    )
    dur = time.time() - t0
    lat.sort()
    p = lambda q: lat[int(q * (len(lat) - 1))] * 1000 if lat else float("nan")
    print(
        f"clientes={N} remetentes={remetentes} msgs/s alvo={TAXA:.0f} | recebidas={recebidas} ({recebidas / dur:,.0f} entregas/s) erros={erros} | latência ms p50={p(0.5):.0f} p95={p(0.95):.0f} p99={p(0.99):.0f} max={p(1):.0f}"
    )


asyncio.run(main())
