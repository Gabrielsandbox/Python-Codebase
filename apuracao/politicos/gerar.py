"""Cruza mandato (Câmara/Senado) com candidatura 2026 (TSE) e publica o contrato estático.

Saída em OUT_DIR (docs/POLITICOS.md):
  indice.json   todos os nomes pesquisáveis, em linhas compactas
  p/{id}.json   ficha de cada político
  planos/       plano de governo (presidente e governador): PDF oficial + {id}.json (texto)

Cruzamento: CPF quando a fonte publica (Câmara e TSE); senão nome civil + data de nascimento.
CPF e nome de cruzamento nunca saem nos arquivos públicos.
"""
from __future__ import annotations

import logging
import os
import shutil
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import orjson

from politicos import OUT_DIR, camara, planos, senado, tse
from politicos.texto import chave

log = logging.getLogger(__name__)

SCHEMA = 1
MAX_BENS = 12
CAMPOS_INDICE = ["id", "nome", "cargo", "uf", "partido", "numero", "situacao", "mandato"]
FONTE_TSE = {"nome": "TSE, candidaturas 2026", "url": "https://dadosabertos.tse.jus.br/dataset/candidatos-2026"}
FONTE_CAMARA = {"nome": "Câmara dos Deputados, dados abertos", "url": "https://dadosabertos.camara.leg.br/"}
FONTE_SENADO = {"nome": "Senado Federal, dados abertos", "url": "https://www12.senado.leg.br/dados-abertos"}
FONTE_PLANO = {"nome": "TSE, propostas de governo 2026", "url": "https://dadosabertos.tse.jus.br/dataset/candidatos-2026"}


def _candidatura(c: tse.Candidatura) -> dict:
    return {
        "ano": 2026,
        "cargo": c.cargo,
        "cargo_nome": tse.CARGOS[c.cargo],
        "uf": c.uf,
        "numero": c.numero,
        "partido": c.partido,
        "partido_nome": c.partido_nome,
        "coligacao": c.coligacao,
        "composicao": c.composicao,
        "situacao": c.situacao,
        "segundo_turno": c.turno2,
        "ocupacao": c.ocupacao,
        "instrucao": c.instrucao,
        "genero": c.genero,
        "nascimento": c.nascimento,
        "bens": {"total": c.bens_total, "quantidade": len(c.bens), "maiores": c.bens[:MAX_BENS]},
    }


def _publico(m: dict) -> dict:
    return {k: v for k, v in m.items() if not k.startswith("_")}


def _gravar(caminho: Path, obj: object) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    tmp = caminho.with_suffix(".tmp")
    tmp.write_bytes(orjson.dumps(obj))
    os.replace(tmp, caminho)


def cruzar(cands: dict[str, tse.Candidatura], mandatos: list[tuple[str, dict]]) -> dict[str, str]:
    """Liga cada mandato ("d123"/"s456") a um SQ_CANDIDATO de 2026, quando ele concorreu."""
    por_cpf = {c.cpf: sq for sq, c in cands.items() if c.cpf}
    por_nome = {(chave(c.nome_civil), c.nascimento): sq for sq, c in cands.items()}
    ligados = {}
    for mid, m in mandatos:
        sq = por_cpf.get(m["_cpf"]) if m["_cpf"] else None
        sq = sq or por_nome.get((chave(m["_nome_civil"]), m["_nascimento"]))
        if sq:
            ligados[mid] = sq
    return ligados


def publicar_planos(lidos: dict[str, list[planos.Parte]], agora: str) -> dict[str, dict]:
    """Grava planos/{arquivo}.pdf e planos/{sq}.json; devolve o resumo que entra na ficha."""
    pasta = OUT_DIR / "planos"
    if pasta.exists():
        shutil.rmtree(pasta)
    pasta.mkdir(parents=True)
    resumos = {}
    for sq, partes in lidos.items():
        docs = []
        for parte in partes:
            with zipfile.ZipFile(parte.zip) as z, z.open(parte.membro) as origem, (pasta / parte.nome).open("wb") as destino:
                shutil.copyfileobj(origem, destino)
            docs.append({
                "pdf": f"planos/{parte.nome}", "bytes": parte.bytes,
                "paginas": parte.doc.paginas, "titulos": parte.doc.titulos,
            })
        _gravar(pasta / f"{sq}.json", {
            "schema": SCHEMA, "id": sq, "documentos": docs, "atualizado_em": agora, "fonte": FONTE_PLANO,
        })
        resumos[sq] = {
            "json": f"planos/{sq}.json",
            "partes": [{"pdf": d["pdf"], "paginas": len(d["paginas"]), "bytes": d["bytes"]} for d in docs],
            "paginas": sum(len(d["paginas"]) for d in docs),
            "bytes": sum(d["bytes"] for d in docs),
        }
    return resumos


def gerar() -> None:
    agora = datetime.now(UTC).isoformat(timespec="seconds")
    cands = tse.carregar_candidaturas()
    log.info("TSE: %d candidaturas", len(cands))
    mandatos = [(f"d{i}", m) for i, m in camara.mandatos().items()]
    log.info("Câmara: %d deputados", len(mandatos))
    mandatos += [(f"s{c}", m) for c, m in senado.mandatos().items()]
    log.info("Senado: %d senadores", len(mandatos) - sum(1 for m, _ in mandatos if m[0] == "d"))
    ligados = cruzar(cands, mandatos)
    log.info("cruzamento: %d de %d parlamentares concorreram em 2026", len(ligados), len(mandatos))
    lidos = {sq: partes for sq, partes in planos.carregar().items() if sq in cands}
    resumo_plano = publicar_planos(lidos, agora)
    log.info("planos de governo: %d", len(resumo_plano))

    mandato_de = {ligados.get(mid, mid): m for mid, m in mandatos}
    fichas: dict[str, dict] = {}
    for sq, c in cands.items():
        m = mandato_de.get(sq)
        fichas[sq] = {
            "schema": SCHEMA,
            "id": sq,
            "nome": c.nome_urna,
            "nome_civil": c.nome_civil,
            "foto": m["foto"] if m else None,
            "candidatura": _candidatura(c) | {"plano": resumo_plano.get(sq)},
            "mandato": _publico(m) if m else None,
        }
    for mid, m in mandatos:
        if mid in ligados:
            continue
        fichas[mid] = {
            "schema": SCHEMA,
            "id": mid,
            "nome": m["nome"],
            "nome_civil": m["_nome_civil"].title(),
            "foto": m["foto"],
            "candidatura": None,
            "mandato": _publico(m),
        }

    indice = []
    for f in fichas.values():
        c, m = f["candidatura"], f["mandato"]
        f["atualizado_em"] = agora
        f["fontes"] = ([FONTE_TSE] if c else []) + ([FONTE_PLANO] if c and c["plano"] else []) + (
            [FONTE_CAMARA if m["casa"] == "camara" else FONTE_SENADO] if m else []
        )
        indice.append([
            f["id"],
            f["nome"],
            c["cargo"] if c else "",
            c["uf"] if c else m["uf"],
            c["partido"] if c else m["partido"],
            c["numero"] if c else "",
            c["situacao"] if c else "",
            ("d" if m["casa"] == "camara" else "s") if m else "",
        ])
    indice.sort(key=lambda r: (r[2] or "9", chave(r[1])))

    p_dir = OUT_DIR / "p"
    if p_dir.exists():
        shutil.rmtree(p_dir)
    for f in fichas.values():
        _gravar(p_dir / f"{f['id']}.json", f)
    _gravar(OUT_DIR / "indice.json", {
        "schema": SCHEMA,
        "gerado_em": agora,
        "cargos": tse.CARGOS,
        "campos": CAMPOS_INDICE,
        "itens": indice,
    })
    log.info("publicado em %s: %d fichas, indice.json %.0f KB", OUT_DIR, len(fichas),
             (OUT_DIR / "indice.json").stat().st_size / 1024)
