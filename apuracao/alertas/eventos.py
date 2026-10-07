"""Detecção dos marcos da apuração a partir de br.json / caminho.json (lógica pura, testável)."""

from __future__ import annotations

from dataclasses import dataclass, field

MARCOS = [25, 50, 75, 90, 99, 100]


@dataclass(slots=True)
class Evento:
    chave: str  # única por noite: "inicio", "marcos-50", "virada-<idg>", "definido", "matematica"
    tipo: str  # inicio | marcos | virada | definido | matematica
    titulo: str
    corpo: str


@dataclass
class EstadoAlertas:
    """O que já foi anunciado. Persistido pelo serviço (SQLite)."""

    iniciado: bool = False
    marcos: set[int] = field(default_factory=set)
    lider: str | None = None
    definido: bool = False
    matematica: str | None = None


def _titulo(nome: str) -> str:
    minus = {"de", "da", "do", "dos", "das", "e"}
    return " ".join(p if p in minus else p.capitalize() for p in (nome or "").lower().split())


def _pct(p: float) -> str:
    return f"{p:.1f}".replace(".", ",") + "%"


def placar_texto(meta: dict, br: dict) -> str:
    cands = br.get("cands") or []
    pcts = br.get("pct") or []
    pares = sorted(zip(cands, pcts, strict=False), key=lambda x: -x[1])[:2]
    nomes = meta.get("candidatos") or {}
    return " × ".join(f"{_titulo(nomes.get(c, {}).get('nome', c))} {_pct(p)}" for c, p in pares)


def detectar(estado: EstadoAlertas, meta: dict, br: dict, caminho: dict | None) -> list[Evento]:
    """Compara o snapshot atual com o estado e devolve os eventos novos (atualiza ``estado``)."""
    out: list[Evento] = []
    sec = br.get("secoes") or {}
    pct = float(sec.get("pct") or 0)
    tot = int(sec.get("totalizadas") or 0)
    placar = placar_texto(meta, br)
    nomes = meta.get("candidatos") or {}
    turno = f"{meta.get('turno', 2)}º turno"

    if not estado.iniciado and tot > 0:
        estado.iniciado = True
        out.append(
            Evento(
                "inicio",
                "inicio",
                "Começou a apuração",
                f"Começou a totalização do {turno}. {placar}.",
            )
        )

    for m in MARCOS:
        if pct >= m and m not in estado.marcos and tot > 0:
            estado.marcos.add(m)
            if m == 100:
                out.append(
                    Evento(
                        "marcos-100",
                        "marcos",
                        "100% das seções",
                        f"Totalização concluída: {placar}.",
                    )
                )
            else:
                out.append(
                    Evento(
                        f"marcos-{m}",
                        "marcos",
                        f"{m}% das seções",
                        f"{m}% das seções totalizadas: {placar}.",
                    )
                )

    lider = br.get("lider")
    if lider and tot > 0:
        if estado.lider and lider != estado.lider:
            nome = _titulo(nomes.get(lider, {}).get("nome", lider))
            out.append(
                Evento(
                    f"virada-{br.get('atualizado_em', '')}",
                    "virada",
                    "Virou!",
                    f"{nome} passa a liderar: {placar} ({_pct(pct)} das seções).",
                )
            )
        estado.lider = lider

    if br.get("definido") and not estado.definido:
        estado.definido = True
        v = br.get("vencedor")
        nome = _titulo(nomes.get(v, {}).get("nome", v or ""))
        out.append(
            Evento("definido", "definido", "Definido pelo TSE", f"{nome} eleito(a). {placar}.")
        )

    mat = (caminho or {}).get("definido_matematicamente")
    if mat and mat != estado.matematica and not br.get("definido"):
        estado.matematica = mat
        nome = _titulo(nomes.get(mat, {}).get("nome", mat))
        rest = (caminho or {}).get("restante", {}).get("votos_est", 0)
        out.append(
            Evento(
                "matematica",
                "matematica",
                "Matematicamente definido",
                f"{nome} lidera por mais votos do que os ≈{rest:,} estimados restantes. Aguardando o TSE.".replace(
                    ",", "."
                ),
            )
        )
    return out
