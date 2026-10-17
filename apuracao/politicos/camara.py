"""Mandato dos deputados federais em exercício a partir dos arquivos em massa da Câmara.

Presença: sessões deliberativas do plenário encerradas, contadas a partir da primeira presença
do deputado na legislatura (a Câmara não publica o período de exercício nesses arquivos, e um
suplente que assumiu em 2025 não pode ser cobrado por 2023). Ausências justificadas (licença,
missão oficial) não aparecem nos dados abertos e contam como ausência; o texto da página diz isso.
"""
from __future__ import annotations

import json
import zipfile
from collections import Counter, defaultdict

import orjson

from politicos import ANOS, ANOS_VOTOS, INICIO_LEGISLATURA, RAW_DIR
from politicos.texto import data_iso, valor_br

TIPOS_PROPOSICAO = {
    "PEC": "Proposta de emenda à Constituição",
    "PLP": "Projeto de lei complementar",
    "PL": "Projeto de lei",
    "PDL": "Projeto de decreto legislativo",
    "PRC": "Projeto de resolução",
}
MAX_PROPOSICOES = 120
MAX_VOTOS = 40


def _dados(nome: str) -> list[dict]:
    return orjson.loads((RAW_DIR / nome).read_bytes())["dados"]


def deputados_atuais() -> dict[int, dict]:
    """id -> detalhe da API (CPF, nome civil, nascimento, último status, redes)."""
    atuais = orjson.loads((RAW_DIR / "camara" / "deputados-atuais.json").read_bytes())["dados"]
    out = {}
    for d in atuais:
        det = orjson.loads((RAW_DIR / "camara" / "dep" / f"{d['id']}.json").read_bytes())["dados"]
        out[d["id"]] = det
    return out


def _presenca(ids: set[int]) -> dict[int, dict]:
    sessoes: dict[int, str] = {}  # idEvento -> data
    for ano in ANOS:
        for e in _dados(f"eventos-{ano}.json"):
            dia = e["dataHoraInicio"][:10]
            # janeiro de 2023 ainda é a legislatura anterior
            if e["descricaoTipo"] == "Sessão Deliberativa" and e["situacao"] == "Encerrada" and dia >= INICIO_LEGISLATURA:
                sessoes[e["id"]] = dia
    presente: dict[int, set[int]] = defaultdict(set)
    primeira: dict[int, str] = {}
    for ano in ANOS:
        for p in _dados(f"eventosPresencaDeputados-{ano}.json"):
            dep = p["idDeputado"]
            if dep not in ids:
                continue
            dia = p["dataHoraInicio"][:10]
            if dia < INICIO_LEGISLATURA:
                continue
            if dep not in primeira or dia < primeira[dep]:
                primeira[dep] = dia
            if p["idEvento"] in sessoes:
                presente[dep].add(p["idEvento"])

    out = {}
    for dep in ids:
        if dep not in primeira:
            continue
        por_ano: dict[int, list[int]] = {a: [0, 0] for a in ANOS}
        linha = []
        for ev, dia in sorted(sessoes.items(), key=lambda x: x[1]):
            if dia < primeira[dep]:
                continue
            a = por_ano[int(dia[:4])]
            a[0] += 1
            a[1] += ev in presente[dep]
            linha.append("p" if ev in presente[dep] else "a")
        anos = [{"ano": a, "sessoes": s, "presente": p} for a, (s, p) in por_ano.items() if s]
        out[dep] = {
            "desde": primeira[dep],
            "sessoes": sum(x["sessoes"] for x in anos),
            "presente": sum(x["presente"] for x in anos),
            "por_ano": anos,
            # uma letra por sessão, em ordem cronológica: p = presente, a = ausente
            "linha": "".join(linha),
        }
    return out


def _proposicoes(ids: set[int]) -> dict[int, dict]:
    papel: dict[int, dict[int, str]] = defaultdict(dict)  # dep -> idProposicao -> autor|coautor
    for ano in ANOS:
        for a in _dados(f"proposicoesAutores-{ano}.json"):
            dep = a.get("idDeputadoAutor")
            if dep in ids:
                papel[dep][a["idProposicao"]] = "autor" if str(a["ordemAssinatura"]) == "1" else "coautor"
    precisa = {p for m in papel.values() for p in m}
    info: dict[int, dict] = {}
    for ano in ANOS:
        for p in _dados(f"proposicoes-{ano}.json"):
            if p["id"] in precisa and p["siglaTipo"] in TIPOS_PROPOSICAO:
                st = p.get("ultimoStatus") or {}
                info[p["id"]] = {
                    "sigla": p["siglaTipo"],
                    "numero": p["numero"],
                    "ano": p["ano"],
                    "ementa": (p.get("ementa") or "").strip(),
                    "data": data_iso(p.get("dataApresentacao") or ""),
                    "situacao": (st.get("descricaoSituacao") or "").strip(),
                    "url": f"https://www.camara.leg.br/propostas-legislativas/{p['id']}",
                }
    out = {}
    for dep, props in papel.items():
        conta: dict[str, Counter] = {"autor": Counter(), "coautor": Counter()}
        lista = []
        for pid, pap in props.items():
            if pid not in info:
                continue
            i = info[pid]
            conta[pap][i["sigla"]] += 1
            # a lista mostra o que o deputado assinou primeiro e as PECs que apoiou
            if pap == "autor" or i["sigla"] == "PEC":
                lista.append({**i, "papel": pap})
        lista.sort(key=lambda x: (x["data"] or "", x["numero"]), reverse=True)
        out[dep] = {
            "autor": dict(conta["autor"]),
            "coautor": dict(conta["coautor"]),
            "lista": lista[:MAX_PROPOSICOES],
        }
    return out


def _votos(ids: set[int]) -> dict[int, dict]:
    votacoes: dict[str, dict] = {}
    for ano in ANOS_VOTOS:
        for v in _dados(f"votacoes-{ano}.json"):
            if v["siglaOrgao"] == "PLEN":
                votacoes[v["id"]] = {
                    "data": v["data"],
                    "descricao": (v.get("descricao") or "").strip(),
                    "aprovada": v.get("aprovacao") == 1,
                }
        for vp in _dados(f"votacoesProposicoes-{ano}.json"):
            alvo = votacoes.get(vp["idVotacao"])
            pr = vp.get("proposicao_") or {}
            if alvo is not None and "proposicao" not in alvo and pr.get("titulo"):
                alvo["proposicao"] = pr["titulo"]
                alvo["ementa"] = (pr.get("ementa") or "").strip()
                alvo["url"] = f"https://www.camara.leg.br/propostas-legislativas/{pr['id']}"

    por_dep: dict[int, list[dict]] = defaultdict(list)
    for ano in ANOS_VOTOS:
        for v in _dados(f"votacoesVotos-{ano}.json"):
            alvo = votacoes.get(v["idVotacao"])
            if alvo is None:
                continue
            dep = int(v["deputado_"]["id"])
            if dep in ids:
                por_dep[dep].append({**alvo, "voto": v["voto"], "quando": v["dataHoraVoto"]})
    out = {}
    for dep, lista in por_dep.items():
        lista.sort(key=lambda x: x["quando"], reverse=True)
        for x in lista:
            del x["quando"]
        out[dep] = {
            "total": len(lista),
            "por_voto": dict(Counter(x["voto"] for x in lista).most_common()),
            "lista": lista[:MAX_VOTOS],
        }
    return out


def _despesas(cpf_para_id: dict[str, int]) -> dict[int, dict]:
    por_ano: dict[int, Counter] = defaultdict(Counter)
    por_cat: dict[int, Counter] = defaultdict(Counter)
    por_forn: dict[int, Counter] = defaultdict(Counter)
    ultima: dict[int, str] = {}
    for ano in ANOS:
        with zipfile.ZipFile(RAW_DIR / f"Ano-{ano}.json.zip") as z:
            dados = json.load(z.open(f"Ano-{ano}.json"))["dados"]
        for d in dados:
            dep = cpf_para_id.get(d.get("cpf") or "")
            if dep is None:
                continue
            valor = valor_br(str(d.get("valorLiquido") or "0"))
            por_ano[dep][d["ano"]] += valor
            por_cat[dep][" ".join(d["descricao"].replace(" ,", ", ").split()).rstrip(".").capitalize()] += valor
            por_forn[dep][(d.get("fornecedor") or "").strip()] += valor
            dia = data_iso(d.get("dataEmissao") or "")
            if dia and dia > ultima.get(dep, ""):
                ultima[dep] = dia
    return {
        dep: {
            "total": round(sum(anos.values()), 2),
            "por_ano": [{"ano": a, "total": round(v, 2)} for a, v in sorted(anos.items())],
            "por_categoria": [{"categoria": c, "total": round(v, 2)} for c, v in por_cat[dep].most_common()],
            "fornecedores": [{"nome": f, "total": round(v, 2)} for f, v in por_forn[dep].most_common(5) if f],
            "ultima": ultima.get(dep),
        }
        for dep, anos in por_ano.items()
    }


def mandatos() -> dict[int, dict]:
    """id do deputado -> bloco ``mandato`` do contrato (sem as chaves de cruzamento)."""
    deps = deputados_atuais()
    ids = set(deps)
    presenca = _presenca(ids)
    props = _proposicoes(ids)
    votos = _votos(ids)
    despesas = _despesas({d["cpf"]: i for i, d in deps.items() if d.get("cpf")})
    out = {}
    for i, d in deps.items():
        st = d["ultimoStatus"]
        out[i] = {
            "casa": "camara",
            "cargo": "Deputado federal" if d.get("sexo") != "F" else "Deputada federal",
            "nome": st.get("nomeEleitoral") or st["nome"],
            "partido": st["siglaPartido"],
            "uf": st["siglaUf"],
            "foto": st.get("urlFoto"),
            "condicao": st.get("condicaoEleitoral"),
            "url": f"https://www.camara.leg.br/deputados/{i}",
            "email": (st.get("gabinete") or {}).get("email") or st.get("email"),
            "redes": d.get("redeSocial") or [],
            "presenca": presenca.get(i),
            "proposicoes": props.get(i, {"autor": {}, "coautor": {}, "lista": []}),
            "votos": votos.get(i, {"total": 0, "por_voto": {}, "lista": []}),
            "despesas": despesas.get(i),
            "_cpf": d.get("cpf") or "",
            "_nome_civil": d.get("nomeCivil") or "",
            "_nascimento": d.get("dataNascimento"),
        }
    return out
