"""Imagem de compartilhamento do placar (1200×630) com Pillow (docs/RECURSOS.md §3)."""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONTES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]
FONTES_REG = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]


def _font(tam: int, bold: bool = True) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for p in FONTES if bold else FONTES_REG:
        if Path(p).exists():
            return ImageFont.truetype(p, tam)
    return ImageFont.load_default()


def _hex(c: str) -> tuple[int, int, int]:
    c = c.lstrip("#")
    return tuple(int(c[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def _br(n: int) -> str:
    return f"{n:,}".replace(",", ".")


def _pct(p: float) -> str:
    return f"{p:.2f}".replace(".", ",") + "%"


def _titulo(nome: str) -> str:
    minus = {"de", "da", "do", "dos", "das", "e"}
    return " ".join(p if p in minus else p.capitalize() for p in nome.lower().split())


def desenhar_placar(
    meta: dict, bloco: dict, *, nome_local: str = "Brasil", site: str = ""
) -> bytes:
    """``bloco`` = br.json ou uma entrada de uf.json (campos v/pct/secoes/...)."""
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), (17, 17, 19))
    d = ImageDraw.Draw(img)
    cands = bloco.get("cands") or meta["cands"]
    pcts = bloco.get("pct") or [0.0] * len(cands)
    votos = bloco.get("v") or [0] * len(cands)
    ordem = sorted(range(len(cands)), key=lambda i: -pcts[i])[:2]
    cores = [_hex(meta["candidatos"].get(cands[i], {}).get("cor", "#888888")) for i in ordem]
    nomes = [_titulo(meta["candidatos"].get(cands[i], {}).get("nome", "")) for i in ordem]

    # cabeçalho
    turno = f"{meta.get('turno', 2)}º turno"
    d.text(
        (60, 44),
        f"Apuração {meta.get('data_eleicao', '')[:4]} · {turno} · {meta.get('cargo_nome', '')}",
        font=_font(28, False),
        fill=(190, 190, 195),
    )
    d.text((60, 86), nome_local, font=_font(56), fill=(246, 245, 241))
    sec = bloco.get("secoes", {})
    d.text(
        (60, 160),
        f"{_pct(sec.get('pct', 0)).replace('%', '')}% das seções totalizadas",
        font=_font(30, False),
        fill=(190, 190, 195),
    )

    # candidatos
    y = 230
    for k, i in enumerate(ordem):
        x = 60 if k == 0 else 640
        d.rounded_rectangle((x, y, x + 500, y + 190), radius=18, fill=(28, 28, 32))
        d.rectangle((x, y, x + 12, y + 190), fill=cores[k])
        d.text((x + 36, y + 22), nomes[k], font=_font(36), fill=(246, 245, 241))
        d.text((x + 36, y + 72), _pct(pcts[i]), font=_font(72), fill=cores[k])
        d.text(
            (x + 36, y + 150), f"{_br(votos[i])} votos", font=_font(24, False), fill=(190, 190, 195)
        )

    # barra
    total = sum(pcts[i] for i in ordem) or 1
    bx0, bx1, by = 60, W - 60, 460
    w0 = int((bx1 - bx0) * pcts[ordem[0]] / total)
    d.rounded_rectangle((bx0, by, bx1, by + 28), radius=14, fill=cores[1])
    d.rounded_rectangle((bx0, by, bx0 + w0, by + 28), radius=14, fill=cores[0])
    margem = abs(pcts[ordem[0]] - pcts[ordem[1]])
    vencedor = bloco.get("vencedor") if bloco.get("definido") else None
    if vencedor and vencedor in cands:
        frase = f"✓ {_titulo(meta['candidatos'][vencedor]['nome'])} eleito(a) por {_pct(margem).replace('%', ' p.p.')}"
    else:
        frase = f"{nomes[0]} lidera por {_pct(margem).replace('%', ' p.p.')}"
    d.text((60, 506), frase, font=_font(28, False), fill=(246, 245, 241))
    if meta.get("simulacao"):
        f = _font(64)
        tw = d.textlength("SIMULAÇÃO · NÃO É RESULTADO", font=f)
        d.text(((W - tw) / 2, 20), "SIMULAÇÃO · NÃO É RESULTADO", font=f, fill=(230, 60, 60))

    # rodapé
    d.line((60, 570, W - 60, 570), fill=(60, 60, 66), width=2)
    d.text(
        (60, 584),
        f"Fonte: TSE · dados oficiais, sem projeções · {bloco.get('atualizado_em', '')[11:16]}",
        font=_font(22, False),
        fill=(150, 150, 158),
    )
    if site:
        f = _font(22)
        tw = d.textlength(site, font=f)
        d.text((W - 60 - tw, 584), site, font=f, fill=(246, 245, 241))

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def desenhar_aguardando(
    *, data_eleicao: str = "", turno: int = 2, site: str = "", simulacao: bool = False
) -> bytes:
    """Imagem de compartilhamento antes de existir resultado (site no ar, apuração não começou).

    Mesmo visual do placar, para o link já ter prévia no WhatsApp antes do dia.
    """
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), (17, 17, 19))
    d = ImageDraw.Draw(img)
    ano = data_eleicao[:4]
    d.text(
        (60, 44),
        f"Apuração {ano} · {turno}º turno · Presidente".strip(),
        font=_font(28, False),
        fill=(190, 190, 195),
    )
    d.text((60, 86), "Brasil", font=_font(56), fill=(246, 245, 241))
    d.rounded_rectangle((60, 200, W - 60, 440), radius=18, fill=(28, 28, 32))
    d.text((96, 236), "Aguardando o início da apuração", font=_font(44), fill=(246, 245, 241))
    if len(data_eleicao) >= 10:
        a, m, dia = data_eleicao[:4], int(data_eleicao[5:7]), int(data_eleicao[8:10])
        meses = [
            "janeiro",
            "fevereiro",
            "março",
            "abril",
            "maio",
            "junho",
            "julho",
            "agosto",
            "setembro",
            "outubro",
            "novembro",
            "dezembro",
        ]
        quando = f"{dia} de {meses[m - 1]} de {a}, a partir das 17h (Brasília)"
    else:
        quando = "no dia da eleição, a partir das 17h (Brasília)"
    d.text((96, 304), quando, font=_font(30, False), fill=(190, 190, 195))
    d.text(
        (96, 360),
        "Mapa por município, caminho para a vitória, chat ao vivo e alertas",
        font=_font(26, False),
        fill=(150, 150, 158),
    )
    if simulacao:
        f = _font(64)
        tw = d.textlength("SIMULAÇÃO · NÃO É RESULTADO", font=f)
        d.text(((W - tw) / 2, 20), "SIMULAÇÃO · NÃO É RESULTADO", font=f, fill=(230, 60, 60))
    d.line((60, 570, W - 60, 570), fill=(60, 60, 66), width=2)
    d.text(
        (60, 584),
        "Fonte: TSE · dados oficiais, sem projeções",
        font=_font(22, False),
        fill=(150, 150, 158),
    )
    if site:
        f = _font(22)
        tw = d.textlength(site, font=f)
        d.text((W - 60 - tw, 584), site, font=f, fill=(246, 245, 241))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
