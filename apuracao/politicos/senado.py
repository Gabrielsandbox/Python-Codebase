"""Mandato dos senadores em exercício (API do Senado + CEAPS).

O Senado registra a situação de cada senador em toda votação nominal, inclusive a ausência e o
motivo dela. Por isso a "presença" do senador é a participação nas votações nominais, separando
ausência justificada (licença, missão, atividade parlamentar) de não comparecimento.
"""
from __future__ import annotations

import csv
from collections import Counter, defaultdict

import orjson

from politicos import ANOS, INICIO_LEGISLATURA, RAW_DIR
from politicos.texto import chave, data_iso, valor_br

PRESENTE = {"Sim", "Não", "Abstenção", "Votou", "P-NRV", "Presidente (art. 51 RISF)"}
JUSTIFICADA = {"AP", "LS", "MIS", "LP", "LAP"}
SEM_JUSTIFICATIVA = {"NCom"}
TIPOS_PROPOSICAO = {"PEC", "PL", "PLS", "PLP", "PDL", "PRS"}
MAX_PROPOSICOES = 120
MAX_VOTOS = 40


def _json(*partes: str):
    return orjson.loads(RAW_DIR.joinpath("senado", *partes).read_bytes())


def _https(url: str | None) -> str | None:
    return url.replace("http://", "https://", 1) if url else url


def _despesas(nomes: dict[str, str]) -> dict[str, dict]:
    """``nomes``: chave(NomeParlamentar) -> código. O CSV identifica o senador só pelo nome."""
    por_ano: dict[str, Counter] = defaultdict(Counter)
    por_cat: dict[str, Counter] = defaultdict(Counter)
    por_forn: dict[str, Counter] = defaultdict(Counter)
    ultima: dict[str, str] = {}
    for ano in ANOS:
        with (RAW_DIR / f"despesa_ceaps_{ano}.csv").open(encoding="latin-1", newline="") as f:
            next(f)  # "ULTIMA ATUALIZACAO";"…"
            for r in csv.DictReader(f, delimiter=";"):
                cod = nomes.get(chave(r["SENADOR"]))
                if cod is None:
                    continue
                valor = valor_br(r["VALOR_REEMBOLSADO"])
                por_ano[cod][int(r["ANO"])] += valor
                cat = r["TIPO_DESPESA"].split(",")[0].strip().rstrip(".")
                por_cat[cod][cat] += valor
                por_forn[cod][r["FORNECEDOR"].strip()] += valor
                dia = data_iso(r["DATA"])
                if dia and dia > ultima.get(cod, "") and dia[:4] == r["ANO"]:
                    ultima[cod] = dia
    return {
        cod: {
            "total": round(sum(anos.values()), 2),
            "por_ano": [{"ano": a, "total": round(v, 2)} for a, v in sorted(anos.items())],
            "por_categoria": [{"categoria": c, "total": round(v, 2)} for c, v in por_cat[cod].most_common()],
            "fornecedores": [{"nome": f, "total": round(v, 2)} for f, v in por_forn[cod].most_common(5) if f],
            "ultima": ultima.get(cod),
        }
        for cod, anos in por_ano.items()
    }


def _votos(cod: str) -> tuple[dict | None, dict]:
    votacoes = _json(cod, "votos.json")
    lista = []
    conta = Counter()
    for v in votacoes:
        meu = next((x for x in v.get("votos", []) if str(x.get("codigoParlamentar")) == cod), None)
        if meu is None:
            continue
        sigla = meu["siglaVotoParlamentar"]
        conta[
            "presente" if sigla in PRESENTE
            else "justificada" if sigla in JUSTIFICADA
            else "sem_justificativa" if sigla in SEM_JUSTIFICATIVA
            else "outros"
        ] += 1
        lista.append({
            "data": v["dataSessao"],
            "proposicao": v.get("identificacao"),
            "ementa": (v.get("ementa") or "").strip(),
            "descricao": (v.get("descricaoVotacao") or "").strip(),
            "aprovada": v.get("resultadoVotacao") == "A",
            "voto": sigla,
            "url": f"https://www25.senado.leg.br/web/atividade/materias/-/materia/{v['codigoMateria']}"
            if v.get("codigoMateria") else None,
            "_seq": v.get("sequencialVotacao") or 0,
        })
    lista.sort(key=lambda x: (x["data"], x["_seq"]), reverse=True)
    por_ano: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    for x in lista:
        a = por_ano[int(x["data"][:4])]
        a[0] += 1
        a[1] += x["voto"] in PRESENTE
    for x in lista:
        del x["_seq"]
    total = sum(conta.values())
    presenca = {
        "desde": lista[-1]["data"] if lista else None,
        "votacoes": total,
        **{k: conta.get(k, 0) for k in ("presente", "justificada", "sem_justificativa", "outros")},
        "por_ano": [{"ano": a, "votacoes": t, "presente": p} for a, (t, p) in sorted(por_ano.items())],
        # uma letra por votação, em ordem cronológica: p presente, j justificada, a sem justificativa
        "linha": "".join(
            "p" if x["voto"] in PRESENTE else "j" if x["voto"] in JUSTIFICADA else "a" if x["voto"] in SEM_JUSTIFICATIVA else "o"
            for x in reversed(lista)
        ),
    } if total else None
    votos = {
        "total": len(lista),
        "por_voto": dict(Counter(x["voto"] for x in lista).most_common()),
        "lista": [x for x in lista if x["voto"] in PRESENTE or x["voto"] in SEM_JUSTIFICATIVA][:MAX_VOTOS],
    }
    return presenca, votos


def _proposicoes(cod: str, nome: str) -> dict:
    conta = {"autor": Counter(), "coautor": Counter()}
    lista = []
    for p in _json(cod, "autorias.json"):
        sigla = (p.get("identificacao") or "").split(" ")[0]
        if sigla not in TIPOS_PROPOSICAO or (p.get("dataApresentacao") or "") < INICIO_LEGISLATURA:
            continue
        # "Senador Fulano (PT/AP), Senador Beltrano…": o primeiro nome da lista é o autor
        primeiro = (p.get("autoria") or "").split(",")[0]
        papel = "autor" if chave(nome) in chave(primeiro) else "coautor"
        conta[papel][sigla] += 1
        if papel == "autor" or sigla == "PEC":
            num, _, ano = (p["identificacao"].split(" ", 1)[1] if " " in p["identificacao"] else "").partition("/")
            lista.append({
                "sigla": sigla,
                "numero": int(num) if num.isdigit() else num,
                "ano": int(ano) if ano.isdigit() else ano,
                "ementa": (p.get("ementa") or "").strip(),
                "data": p.get("dataApresentacao"),
                "situacao": (p.get("situacaoAtual") or "").capitalize(),
                "url": f"https://www25.senado.leg.br/web/atividade/materias/-/materia/{p['codigoMateria']}",
                "papel": papel,
            })
    lista.sort(key=lambda x: x["data"] or "", reverse=True)
    return {"autor": dict(conta["autor"]), "coautor": dict(conta["coautor"]), "lista": lista[:MAX_PROPOSICOES]}


def mandatos() -> dict[str, dict]:
    """código do senador -> bloco ``mandato`` do contrato (sem as chaves de cruzamento)."""
    lista = _json("atuais.json")["ListaParlamentarEmExercicio"]["Parlamentares"]["Parlamentar"]
    nomes: dict[str, str] = {}
    for p in lista:
        ident = p["IdentificacaoParlamentar"]
        # o CSV às vezes usa os dois primeiros nomes civis ("WEVERTON ROCHA" para "Weverton")
        curto = " ".join(chave(ident.get("NomeCompletoParlamentar") or "").split()[:2])
        nomes.setdefault(curto, ident["CodigoParlamentar"])
    for p in lista:
        ident = p["IdentificacaoParlamentar"]
        nomes[chave(ident["NomeParlamentar"])] = ident["CodigoParlamentar"]
    despesas = _despesas(nomes)
    out = {}
    for p in lista:
        ident = p["IdentificacaoParlamentar"]
        cod = ident["CodigoParlamentar"]
        det = _json(cod, "detalhe.json")["DetalheParlamentar"]["Parlamentar"]
        mand = p.get("Mandato") or {}
        presenca, votos = _votos(cod)
        fem = ident.get("SexoParlamentar") == "Feminino"
        out[cod] = {
            "casa": "senado",
            "cargo": "Senadora" if fem else "Senador",
            "nome": ident["NomeParlamentar"],
            "partido": ident.get("SiglaPartidoParlamentar"),
            "uf": ident.get("UfParlamentar"),
            "foto": _https(ident.get("UrlFotoParlamentar")),
            "condicao": mand.get("DescricaoParticipacao"),
            "fim_mandato": ((mand.get("SegundaLegislaturaDoMandato") or {}).get("DataFim")
                            or (mand.get("PrimeiraLegislaturaDoMandato") or {}).get("DataFim")),
            "url": _https(ident.get("UrlPaginaParlamentar")),
            "email": ident.get("EmailParlamentar"),
            "redes": [u for u in [ident.get("UrlPaginaParticular")] if u],
            "presenca": presenca,
            "proposicoes": _proposicoes(cod, ident["NomeParlamentar"]),
            "votos": votos,
            "despesas": despesas.get(cod),
            "_cpf": "",
            "_nome_civil": ident.get("NomeCompletoParlamentar") or "",
            "_nascimento": (det.get("DadosBasicosParlamentar") or {}).get("DataNascimento"),
        }
    return out
