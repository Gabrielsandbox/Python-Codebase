"""Leva o lake (Parquet) para produção sem rodar o ETL pesado no servidor.

Dois caminhos, usados em ordem por `garantir()`:

1. **Sincronizar** de um espelho público (R2 atrás da Cloudflare): `manifest.json` lista cada
   arquivo com tamanho e hash; só o que falta ou mudou é baixado. Não precisa de credencial.
2. **ETL local** (`APURACAO_ACERVO_ETL=1`): baixa os ZIPs do TSE e converte, ano a ano, apagando
   o bruto em seguida (volume pequeno). Com credenciais S3, publica o resultado no espelho para
   os próximos boots/réplicas.

`publicar()` é o inverso: sobe `parquet/` + manifesto para o bucket (`APURACAO_S3_*`), sob o
prefixo `historico/`.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
from collections.abc import Callable
from pathlib import Path

import httpx

from historico import PARQUET_DIR, RAW_DIR

PREFIXO_ESPELHO = "historico"
URL_ESPELHO_PADRAO = "https://dados.apuracaoaovivo.com/historico"
TABELAS_ACERVO = ("consulta_cand", "votacao_candidato_munzona", "detalhe_votacao_munzona")
Log = Callable[[str], None]


def _sha1(p: Path) -> str:
    h = hashlib.sha1()
    with p.open("rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()


def manifesto_local() -> dict:
    """{"gerado_em": epoch, "arquivos": [{"caminho": "tabela/ano=/turno=/part.parquet", "bytes", "sha1"}]}"""
    arquivos = []
    for p in sorted(PARQUET_DIR.rglob("*.parquet")):
        rel = p.relative_to(PARQUET_DIR).as_posix()
        arquivos.append({"caminho": rel, "bytes": p.stat().st_size, "sha1": _sha1(p)})
    return {"gerado_em": int(time.time()), "arquivos": arquivos}


def publicar(log: Log = print) -> int:
    """Sobe parquet/ e manifest.json para o bucket S3 configurado (APURACAO_S3_*). Retorna nº de arquivos."""
    from apuracao.storage import S3Storage, from_env

    st = from_env()
    if not isinstance(st, S3Storage):
        raise SystemExit(
            "defina APURACAO_S3_BUCKET/APURACAO_S3_ENDPOINT/AWS_* para publicar o acervo"
        )
    man = manifesto_local()
    if not man["arquivos"]:
        raise SystemExit(f"nenhum parquet em {PARQUET_DIR}")
    for a in man["arquivos"]:
        p = PARQUET_DIR / a["caminho"]
        log(f"↑ {a['caminho']} ({a['bytes'] / 1e6:.1f} MB)")
        st.write_bytes(
            f"{PREFIXO_ESPELHO}/parquet/{a['caminho']}",
            p.read_bytes(),
            content_type="application/vnd.apache.parquet",
            max_age=3600,
        )
    st.write_bytes(
        f"{PREFIXO_ESPELHO}/manifest.json",
        json.dumps(man, ensure_ascii=False).encode(),
        content_type="application/json",
        max_age=60,
    )
    log(f"manifesto com {len(man['arquivos'])} arquivos publicado")
    return len(man["arquivos"])


def sincronizar(url_base: str | None = None, log: Log = print) -> int:
    """Baixa do espelho público o que falta/mudou. Retorna nº de arquivos baixados (0 se já em dia).
    Levanta httpx.HTTPError se o espelho não responder."""
    base = (url_base or os.environ.get("APURACAO_ACERVO_URL") or URL_ESPELHO_PADRAO).rstrip("/")
    with httpx.Client(timeout=120, follow_redirects=True) as c:
        r = c.get(f"{base}/manifest.json")
        r.raise_for_status()
        man = r.json()
        baixados = 0
        for a in man.get("arquivos", []):
            destino = PARQUET_DIR / a["caminho"]
            if (
                destino.exists()
                and destino.stat().st_size == a["bytes"]
                and _sha1(destino) == a["sha1"]
            ):
                continue
            destino.parent.mkdir(parents=True, exist_ok=True)
            tmp = destino.with_suffix(".baixando")
            log(f"↓ {a['caminho']} ({a['bytes'] / 1e6:.1f} MB)")
            with c.stream("GET", f"{base}/parquet/{a['caminho']}") as resp, tmp.open("wb") as f:
                resp.raise_for_status()
                for bloco in resp.iter_bytes(1 << 20):
                    f.write(bloco)
            if _sha1(tmp) != a["sha1"]:
                tmp.unlink(missing_ok=True)
                raise RuntimeError(f"hash diferente ao baixar {a['caminho']}")
            tmp.replace(destino)
            baixados += 1
    return baixados


def anos_faltando(anos: list[int]) -> list[int]:
    from historico.consulta import particoes_disponiveis

    tem = {a for a, _ in particoes_disponiveis("votacao_candidato_munzona")}
    return [a for a in anos if a not in tem]


def etl_ano(ano: int, log: Log = print, memoria: str | None = None) -> None:
    """Baixa + converte as três tabelas do acervo para `ano`, apagando o ZIP de cada uma ao fim."""
    from historico.download import baixar_tabela
    from historico.etl import executar_etl

    for tabela in TABELAS_ACERVO:
        log(f"[{ano}] baixando {tabela}…")
        _, res = baixar_tabela(ano, tabela)
        log(f"[{ano}] convertendo {tabela}…")
        r = executar_etl(ano, tabela, zip_path=res.caminho, memoria=memoria)
        log(f"[{ano}] {tabela}: {r.linhas:,} linhas em {r.segundos:.0f}s")
        res.caminho.unlink(missing_ok=True)
    shutil.rmtree(RAW_DIR / "_tmp", ignore_errors=True)


def garantir(anos: list[int], log: Log = print) -> None:
    """Deixa o lake pronto para `anos`: espelho → ETL (se APURACAO_ACERVO_ETL=1) → publica."""
    try:
        n = sincronizar(log=log)
        log(f"acervo: espelho sincronizado ({n} arquivo(s) novo(s))")
    except Exception as e:  # noqa: BLE001 — sem espelho ainda é normal no primeiro boot
        log(f"acervo: espelho indisponível ({e.__class__.__name__}: {e})")
    faltam = anos_faltando(anos)
    if not faltam:
        log("acervo: todos os anos presentes")
        return
    if os.environ.get("APURACAO_ACERVO_ETL") != "1":
        log(f"acervo: faltam {faltam}; defina APURACAO_ACERVO_ETL=1 para rodar o ETL aqui")
        return
    for ano in faltam:
        etl_ano(ano, log=log, memoria=os.environ.get("APURACAO_ACERVO_MEMORIA"))
    if os.environ.get("APURACAO_S3_BUCKET"):
        try:
            publicar(log=log)
        except Exception as e:  # noqa: BLE001
            log(f"acervo: falha ao publicar no espelho ({e})")


def garantir_em_segundo_plano(log: Log = print) -> threading.Thread | None:
    """Lê APURACAO_ACERVO_ANOS (ex.: "2018,2022") e prepara o lake numa thread, sem travar o boot."""
    bruto = os.environ.get("APURACAO_ACERVO_ANOS", "").strip()
    if not bruto:
        return None
    anos = [int(a) for a in bruto.replace(";", ",").split(",") if a.strip()]
    t = threading.Thread(target=garantir, args=(anos, log), name="acervo-garantir", daemon=True)
    t.start()
    return t
