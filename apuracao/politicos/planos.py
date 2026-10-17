"""Plano de governo que cada candidato ao Executivo registra no TSE (PDF, Lei 9.504/97 art. 11).

O PDF oficial é publicado como está (é o que vale) e, ao lado, um JSON com o texto de cada
página e os títulos encontrados, para o sumário e a busca da página. Nada é resumido nem
reescrito: o sumário só aponta títulos que já estão no documento.

Os títulos saem de uma regra única para todos os candidatos, sem ajuste por documento:
  1. se o PDF tem sumário próprio (linhas "Título ........ 12"), valem os itens dele, cada um
     apontando para a página do PDF onde o título aparece (o número impresso pode não bater
     com a página do arquivo: capa, páginas sem número);
  2. senão, títulos pelo estilo:
  - linha de título = linha inteira em fonte maior que o corpo do texto (>= 1,25x) ou toda em
    negrito, curta, com letras;
  - cabeçalho/rodapé que se repete em boa parte do documento não é título; o que se repete em
    poucas páginas (título do capítulo no alto de cada página dele) vale só na primeira;
  - página de sumário do próprio PDF (linhas com "....12") é ignorada;
  - os estilos entram do mais destacado para o menos, até MAX_TITULOS entradas.
O sumário é uma lista simples: a hierarquia de cada PDF não dá para recuperar com segurança.
Os PDFs (dados NÃO confiáveis) só são lidos pelo pypdf; erro em um arquivo não para os outros.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from politicos import RAW_DIR
from politicos.texto import chave

log = logging.getLogger(__name__)

ZIP = "proposta_governo_2026_BR.zip"
# 2026BR280002542548_01.pdf -> SQ_CANDIDATO e parte (o TSE aceita o plano em mais de um arquivo)
_NOME = re.compile(r"(?:^|/)\d{4}[A-Z]{2}(\d+)_(\d+)\.pdf$", re.IGNORECASE)
MAX_TITULOS = 40
MAX_LEN_TITULO = 140
ESCALA_TITULO = 1.25
_NEGRITO = re.compile(r"bold|black|heavy", re.IGNORECASE)
_LINHA_SUMARIO = re.compile(r"(\.\s*){4,}\s*\d*\s*$|…{2,}")
_LETRA = re.compile(r"[^\W\d_]", re.UNICODE)
_ITEM_SUMARIO = re.compile(r"^(.*?)\s*(?:(?:\.\s*){4,}|…{2,})\s*(\d{1,3})?\s*$")
MIN_ITENS_SUMARIO = 3
_GLIFO = re.compile(r"/gid\d|/uni[0-9A-F]{4}|\(cid:\d+\)")  # fonte sem mapa de caracteres
CABECALHO = 0.3  # fração das páginas


@dataclass
class Linha:
    texto: str
    tamanho: float
    negrito: bool


@dataclass
class Documento:
    paginas: list[str]
    titulos: list[dict] = field(default_factory=list)  # {"t": texto, "p": página (1..n)}


def _espacos(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _linhas(pagina) -> list[Linha]:
    """Linhas da página com tamanho efetivo da fonte e se é toda em negrito.

    Alguns PDFs desenham cada trecho duas vezes (sombra/falso negrito): trecho idêntico ao
    anterior na mesma linha é descartado.
    """
    linhas: list[Linha] = []
    trechos: list[tuple[str, float, bool]] = []

    def fecha() -> None:
        texto = _espacos("".join(t for t, _, _ in trechos))
        if texto:
            # tamanho e negrito de quem tem mais caracteres na linha
            peso: Counter[tuple[float, bool]] = Counter()
            for t, tam, neg in trechos:
                peso[(tam, neg)] += len(t.strip())
            (tam, _), _ = peso.most_common(1)[0]
            linhas.append(Linha(texto, tam, all(neg for t, _, neg in trechos if t.strip())))
        trechos.clear()

    def visitante(texto, cm, tm, fonte, tamanho) -> None:
        a = tm[0] * cm[0] + tm[1] * cm[2]
        b = tm[0] * cm[1] + tm[1] * cm[3]
        efetivo = round(float(tamanho or 0) * (a * a + b * b) ** 0.5, 1)
        negrito = bool(fonte and _NEGRITO.search(str(fonte.get("/BaseFont", ""))))
        for i, parte in enumerate(texto.split("\n")):
            if i:
                fecha()
            if parte and not (trechos and trechos[-1][0] == parte):
                trechos.append((parte, efetivo, negrito))

    pagina.extract_text(visitor_text=visitante)
    fecha()
    return linhas


def _texto_pagina(linhas: list[Linha]) -> str:
    # "bem-\nestar" -> "bem-estar"; o resto vira um parágrafo só (a página serve para busca)
    return _espacos(re.sub(r"(\w)- (\w)", r"\1-\2", " ".join(ln.texto for ln in linhas)))


def titulos(paginas: list[list[Linha]]) -> list[dict]:
    return sumario_proprio(paginas) or titulos_por_estilo(paginas)


def _e_sumario(linhas: list[Linha]) -> bool:
    return sum(bool(_LINHA_SUMARIO.search(ln.texto)) for ln in linhas) >= MIN_ITENS_SUMARIO


def sumario_proprio(paginas: list[list[Linha]]) -> list[dict]:
    """Itens do sumário do próprio PDF, cada um com a página do arquivo onde o título aparece."""
    itens: list[tuple[int, str, int | None]] = []  # (página do sumário, título, página impressa)
    for p, linhas in enumerate(paginas, 1):
        if not _e_sumario(linhas):
            continue
        pendente: Linha | None = None  # título que quebrou em duas linhas antes do pontilhado
        for ln in linhas:
            m = _ITEM_SUMARIO.match(ln.texto)
            if m:
                titulo = m.group(1).strip(" .")
                if pendente and (pendente.tamanho, pendente.negrito) == (ln.tamanho, ln.negrito):
                    titulo = f"{pendente.texto} {titulo}"
                if len(_LETRA.findall(titulo)) >= 3:
                    itens.append((p, _espacos(titulo), int(m.group(2)) if m.group(2) else None))
                pendente = None
            else:
                pendente = ln if len(_LETRA.findall(ln.texto)) >= 3 else None
    # índice remissivo (alfabético) logo depois do sumário: as páginas param de crescer
    ultima_impressa = 0
    for i, (_, _, impressa) in enumerate(itens):
        if impressa is not None:
            if impressa < ultima_impressa:
                itens = itens[:i]
                break
            ultima_impressa = impressa
    itens = [x for x in itens if chave(x[1]) not in ("sumario", "indice", "conteudo")]
    if len(itens) < MIN_ITENS_SUMARIO:
        return []

    fim_sumario = max(p for p, _, _ in itens)
    chaves = [[chave(ln.texto) for ln in linhas] for linhas in paginas]

    def onde(titulo: str, depois_de: int) -> int | None:
        k = chave(titulo)[:48]
        for p in range(max(depois_de, fim_sumario) + 1, len(paginas) + 1):
            for c in chaves[p - 1]:
                # título longo pode quebrar em duas linhas no corpo
                if c.startswith(k) or (len(c) >= 12 and k.startswith(c)):
                    return p
        return None

    achados: list[tuple[str, int | None, int | None]] = []
    ultimo = 0
    for _, titulo, impressa in itens:
        p = onde(titulo, ultimo)
        achados.append((titulo, p, impressa))
        ultimo = p or ultimo
    # quem não foi achado no corpo usa a página impressa + a diferença típica do documento
    difs = sorted(p - i for _, p, i in achados if p and i)
    dif = difs[len(difs) // 2] if difs else 0
    out = []
    for titulo, p, impressa in achados:
        p = p or (impressa + dif if impressa else None)
        if p and 1 <= p <= len(paginas):
            out.append({"t": titulo[:MAX_LEN_TITULO], "p": p})
    return out if len(out) >= MIN_ITENS_SUMARIO else []


def titulos_por_estilo(paginas: list[list[Linha]]) -> list[dict]:
    peso: Counter[float] = Counter()
    for linhas in paginas:
        for ln in linhas:
            peso[ln.tamanho] += len(ln.texto)
    if not peso:
        return []
    corpo = peso.most_common(1)[0][0]

    # cabeçalhos e rodapés: mesmo texto (sem números) em boa parte das páginas
    def forma(t: str) -> str:
        return re.sub(r"\d+", "#", t.lower())

    repetidas: Counter[str] = Counter()
    for linhas in paginas:
        repetidas.update({forma(ln.texto) for ln in linhas})
    cabecalho = max(3, CABECALHO * len(paginas))
    vistos: set[str] = set()

    candidatos: list[tuple[int, float, bool, str]] = []  # (página, tamanho, negrito, texto)
    for p, linhas in enumerate(paginas, 1):
        if _e_sumario(linhas):
            continue
        anterior: tuple[int, float, bool, str] | None = None
        for ln in linhas:
            destaque = ln.tamanho >= corpo * ESCALA_TITULO or (ln.negrito and ln.tamanho >= corpo * 0.95)
            letras = len(_LETRA.findall(ln.texto))
            ok = (
                destaque
                and letras >= 3
                and letras >= len(ln.texto.replace(" ", "")) / 2
                and not _GLIFO.search(ln.texto)
                and repetidas[forma(ln.texto)] < cabecalho
                and forma(ln.texto) not in vistos
                and not _LINHA_SUMARIO.search(ln.texto)
            )
            if not ok:
                anterior = None
                continue
            # título em duas ou mais linhas seguidas, mesmo estilo
            if anterior and anterior[1:3] == (ln.tamanho, ln.negrito) and len(anterior[3]) + len(ln.texto) < MAX_LEN_TITULO:
                anterior = (p, ln.tamanho, ln.negrito, f"{anterior[3]} {ln.texto}")
                candidatos[-1] = anterior
            else:
                anterior = (p, ln.tamanho, ln.negrito, ln.texto)
                candidatos.append(anterior)
            if repetidas[forma(ln.texto)] > 1:
                vistos.add(forma(ln.texto))

    candidatos = [c for c in candidatos if len(c[3]) <= MAX_LEN_TITULO and not c[3].isdigit()]
    # estilos do mais destacado para o menos; entra o estilo inteiro ou nada
    por_estilo: dict[tuple[float, bool], int] = defaultdict(int)
    for _, tam, neg, _ in candidatos:
        por_estilo[(tam, neg)] += 1
    escolhidos: list[tuple[float, bool]] = []
    total = 0
    for estilo in sorted(por_estilo, key=lambda e: (-e[0], not e[1])):
        if total + por_estilo[estilo] > MAX_TITULOS:
            break
        escolhidos.append(estilo)
        total += por_estilo[estilo]

    out: list[dict] = []
    for p, tam, neg, texto in candidatos:
        if (tam, neg) not in escolhidos:
            continue
        if out and out[-1]["t"].lower() == texto.lower():
            continue  # o mesmo título repetido na página seguinte
        out.append({"t": texto, "p": p})
    return out


def ler_pdf(dados: bytes) -> Documento:
    from pypdf import PdfReader  # extra opcional "politicos"

    leitor = PdfReader(io.BytesIO(dados))
    paginas: list[list[Linha]] = []
    for pagina in leitor.pages:
        try:
            paginas.append(_linhas(pagina))
        except Exception as e:  # noqa: BLE001 — PDF malformado quebra o pypdf de mil jeitos; a página fica vazia
            log.warning("página ilegível: %s", e)
            paginas.append([])
    return Documento(paginas=[_texto_pagina(ls) for ls in paginas], titulos=titulos(paginas))


def carregar(zip_path: Path | None = None) -> dict[str, list[tuple[str, bytes, Documento]]]:
    """SQ_CANDIDATO -> partes em ordem: (nome do arquivo, PDF, documento lido)."""
    zip_path = zip_path or RAW_DIR / ZIP
    if not zip_path.exists():
        log.warning("%s não encontrado: fichas sem plano de governo", zip_path.name)
        return {}
    logging.getLogger("pypdf").setLevel(logging.ERROR)  # avisos de PDF malformado são esperados
    planos: dict[str, list[tuple[str, bytes, Documento]]] = defaultdict(list)
    with zipfile.ZipFile(zip_path) as z:
        for nome in sorted(z.namelist()):
            m = _NOME.search(nome)
            if not m:
                continue
            sq, parte = m.group(1), m.group(2)
            dados = z.read(nome)
            try:
                doc = ler_pdf(dados)
            except Exception as e:  # noqa: BLE001 — idem: o PDF ainda é publicado
                log.warning("plano de %s ilegível (%s): só o PDF vai para a ficha", sq, e)
                doc = Documento(paginas=[])
            planos[sq].append((f"{sq}_{parte}.pdf", dados, doc))
    return dict(planos)
