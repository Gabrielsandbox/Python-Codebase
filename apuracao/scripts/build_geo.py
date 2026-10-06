#!/usr/bin/env python3
"""Gera as referências geográficas estáticas do mapa de apuração.

Saídas (ver docs/SCHEMA.md, seção "Referências estáticas"):

  web/public/geo/br-uf.topo.json   TopoJSON, objeto "uf",  27 geometrias
                                   properties: {id: IBGE 2 dígitos, nome}
  web/public/geo/br-mun.topo.json  TopoJSON, objeto "mun", 5570 geometrias
                                   properties: {id: IBGE 7 dígitos, nome, uf}
  data/ref/municipios.json         {"3550308": {"tse": "71072", "uf": "SP",
                                     "nome": "São Paulo", "capital": true}, ...}
                                   Inclui os municípios do exterior (uf "ZZ"),
                                   que não têm código IBGE no TSE (`cdi` vazio):
                                   recebem a chave sintética "99" + código TSE
                                   (7 dígitos, começando em 99 — ver SCHEMA.md).
  data/ref/ufs.json                {"SP": {"nome": "São Paulo", "ibge": "35",
                                     "regiao": "Sudeste"}, ..., "ZZ": {...}}
  web/public/ref/{municipios,ufs}.json  cópias dos dois anteriores.

Fontes:
  * Malhas IBGE (API de malhas v3, qualidade mínima, GeoJSON) — baixadas para
    ``--cache-dir`` (padrão: data/raw/geo, ignorado pelo git) e reutilizadas
    se já existirem. Conteúdo baixado é tratado como dado não confiável:
    só é lido com ``json``; nenhum interpretador roda de dentro desse diretório.
  * Tabela de municípios do TSE (``data/ref/tse-municipios-2026.json``), que
    fornece código TSE, código IBGE, nome e flag de capital.

Pipeline da malha municipal (ferramentas de referência do TopoJSON, em Node):

  geo2topo  mun=<geojson limpo>                 -> topologia bruta (arcos compartilhados)
  toposimplify -s <steradianos>                 -> Visvalingam esférico, sem -f
  (python) restaura arcos originais dos municípios cuja área colapsou
           (< 60% da original ou anel com < 3 pontos distintos), para que
           municípios pequenos continuem visíveis e renderizáveis
  topoquantize <q>                              -> quantização (delta-encoding)

A malha de UF só é quantizada (geo2topo -q), sem simplificação.

Dependências: Python 3.11+ (somente stdlib) e Node 22 com ``npx``. Por padrão o
script invoca, com versões fixas::

    npx --yes --package topojson-server@3.0.1   geo2topo ...
    npx --yes --package topojson-simplify@3.0.3 toposimplify ...
    npx --yes --package topojson-client@3.1.0   topoquantize ... / topo2geo ...

Alternativamente instale-os uma vez e aponte ``--node-bin``::

    npm install --prefix /algum/dir topojson-server@3.0.1 topojson-simplify@3.0.3 topojson-client@3.1.0
    python3 scripts/build_geo.py --node-bin /algum/dir/node_modules/.bin

Uso (a partir de qualquer diretório)::

    python3 apuracao/scripts/build_geo.py [--cache-dir DIR] [--simplify 2e-6] [--quantize 3e4]
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import sys
import urllib.request
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent  # .../apuracao

IBGE_API = "https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR"
URL_UF = f"{IBGE_API}?formato=application/vnd.geo+json&qualidade=minima&intrarregiao=UF"
URL_MUN = f"{IBGE_API}?formato=application/vnd.geo+json&qualidade=minima&intrarregiao=municipio"

NODE_TOOLS = {
    "geo2topo": "topojson-server@3.0.1",
    "toposimplify": "topojson-simplify@3.0.3",
    "topoquantize": "topojson-client@3.1.0",
    "topo2geo": "topojson-client@3.1.0",
}

# sigla -> (nome, código IBGE, região)
UFS: dict[str, tuple[str, str, str]] = {
    "AC": ("Acre", "12", "Norte"),
    "AL": ("Alagoas", "27", "Nordeste"),
    "AP": ("Amapá", "16", "Norte"),
    "AM": ("Amazonas", "13", "Norte"),
    "BA": ("Bahia", "29", "Nordeste"),
    "CE": ("Ceará", "23", "Nordeste"),
    "DF": ("Distrito Federal", "53", "Centro-Oeste"),
    "ES": ("Espírito Santo", "32", "Sudeste"),
    "GO": ("Goiás", "52", "Centro-Oeste"),
    "MA": ("Maranhão", "21", "Nordeste"),
    "MT": ("Mato Grosso", "51", "Centro-Oeste"),
    "MS": ("Mato Grosso do Sul", "50", "Centro-Oeste"),
    "MG": ("Minas Gerais", "31", "Sudeste"),
    "PA": ("Pará", "15", "Norte"),
    "PB": ("Paraíba", "25", "Nordeste"),
    "PR": ("Paraná", "41", "Sul"),
    "PE": ("Pernambuco", "26", "Nordeste"),
    "PI": ("Piauí", "22", "Nordeste"),
    "RJ": ("Rio de Janeiro", "33", "Sudeste"),
    "RN": ("Rio Grande do Norte", "24", "Nordeste"),
    "RS": ("Rio Grande do Sul", "43", "Sul"),
    "RO": ("Rondônia", "11", "Norte"),
    "RR": ("Roraima", "14", "Norte"),
    "SC": ("Santa Catarina", "42", "Sul"),
    "SE": ("Sergipe", "28", "Nordeste"),
    "SP": ("São Paulo", "35", "Sudeste"),
    "TO": ("Tocantins", "17", "Norte"),
}
IBGE_TO_UF = {ibge: sigla for sigla, (_, ibge, _) in UFS.items()}

# Palavras que ficam em minúsculas no meio do nome.
LOWER_WORDS = {"de", "da", "do", "dos", "das", "e", "em", "na", "no", "nas", "nos"}
ROMAN = {"II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII", "XIII", "XIV", "XV"}


# --------------------------------------------------------------------------- nomes
def _cap(word: str) -> str:
    return word[:1].upper() + word[1:].lower() if word else word


def title_case(name: str) -> str:
    """'OLHO D'ÁGUA DAS FLORES' -> "Olho d'Água das Flores"; 'PIO XII' -> 'Pio XII'."""
    out: list[str] = []
    for i, token in enumerate(name.strip().split()):
        low = token.lower()
        if i > 0 and low in LOWER_WORDS:
            out.append(low)
            continue
        if token.upper() in ROMAN:
            out.append(token.upper())
            continue
        # hifens: Xique-Xique, Dix-Sept, Kingston-Jamaica
        parts = []
        for part in token.split("-"):
            # apóstrofo: D'ÁGUA -> d'Água, SANT'ANA -> Sant'Ana
            if "'" in part:
                pre, _, post = part.partition("'")
                pre = pre.lower() if len(pre) == 1 else _cap(pre)
                parts.append(f"{pre}'{_cap(post)}")
            else:
                parts.append(_cap(part))
        out.append("-".join(parts))
    return " ".join(out)


# --------------------------------------------------------------------------- download
def download(url: str, dest: Path) -> None:
    print(f"  baixando {url}\n        -> {dest}")
    req = urllib.request.Request(url, headers={"User-Agent": "apuracao-build-geo/1.0",
                                               "Accept-Encoding": "gzip, identity"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = resp.read()
        enc = (resp.headers.get("Content-Encoding") or "").lower()
    if enc == "gzip" or data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    elif enc == "deflate":
        data = zlib.decompress(data)
    # valida que é JSON antes de gravar (falha cedo em caso de HTML de erro)
    json.loads(data)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)


def ensure_mesh(url: str, dest: Path, force: bool) -> dict:
    if force or not dest.exists():
        download(url, dest)
    else:
        print(f"  usando cache {dest} ({dest.stat().st_size:,} bytes)")
    with dest.open("rb") as fh:
        data = json.load(fh)
    if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
        raise SystemExit(f"{dest}: não é uma FeatureCollection GeoJSON")
    return data


# --------------------------------------------------------------------------- node
class Node:
    def __init__(self, node_bin: Path | None, cwd: Path):
        self.node_bin = node_bin
        self.cwd = cwd

    def run(self, tool: str, *args: str, stdin: bytes | None = None) -> bytes:
        if self.node_bin:
            cmd = [str(self.node_bin / tool), *args]
        else:
            cmd = ["npx", "--yes", "--package", NODE_TOOLS[tool], tool, *args]
        res = subprocess.run(cmd, input=stdin, cwd=self.cwd, capture_output=True, check=False)
        if res.returncode != 0:
            sys.stderr.write(res.stderr.decode(errors="replace"))
            raise SystemExit(f"falha ao executar {' '.join(cmd)}")
        return res.stdout


# --------------------------------------------------------------------------- topologia
def _ring_points(arcs: list, ring: list[int]) -> list:
    pts: list = []
    for i in ring:
        a = arcs[~i][::-1] if i < 0 else arcs[i]
        pts.extend(a if not pts else a[1:])
    return pts


def _area(pts: list) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))) / 2


def _polys(g: dict) -> list:
    if g.get("type") == "Polygon":
        return [g["arcs"]]
    if g.get("type") == "MultiPolygon":
        return g["arcs"]
    return []


def protect_small(raw: dict, simp: dict, name: str, min_ratio: float) -> tuple[int, int]:
    """Restaura, em ``simp``, os arcos originais dos polígonos que colapsaram.

    ``toposimplify`` mantém os índices dos arcos, então os dois arrays são
    alinhados. Devolve (geometrias restauradas, arcos restaurados).
    """
    if len(raw["arcs"]) != len(simp["arcs"]):
        raise SystemExit("arcos desalinhados entre topologia bruta e simplificada")
    restore: set[int] = set()
    n_geoms = 0
    for g in simp["objects"][name]["geometries"]:
        polys = _polys(g)
        raw_area = sum(_area(_ring_points(raw["arcs"], r)) for p in polys for r in p)
        simp_area = sum(_area(_ring_points(simp["arcs"], r)) for p in polys for r in p)
        bad = simp_area < min_ratio * raw_area
        ring_bad: set[int] = set()
        for p in polys:
            for r in p:
                pts = _ring_points(simp["arcs"], r)
                if len({tuple(pt) for pt in pts}) < 3:
                    ring_bad.update(~i if i < 0 else i for i in r)
        if bad:
            n_geoms += 1
            for p in polys:
                for r in p:
                    restore.update(~i if i < 0 else i for i in r)
        elif ring_bad:
            n_geoms += 1
            restore.update(ring_bad)
    for i in restore:
        simp["arcs"][i] = raw["arcs"][i]
    return n_geoms, len(restore)


def decode_arc(topo: dict, i: int) -> list[tuple[float, float]]:
    tr = topo.get("transform")
    a = topo["arcs"][~i] if i < 0 else topo["arcs"][i]
    pts = []
    if tr:
        x = y = 0
        sx, sy = tr["scale"]
        tx, ty = tr["translate"]
        for dx, dy in a:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
    else:
        pts = [tuple(p) for p in a]
    return pts[::-1] if i < 0 else pts


def verify_topology(path: Path, name: str, expected: int, props: tuple[str, ...]) -> None:
    with path.open("rb") as fh:
        topo = json.load(fh)
    if topo.get("type") != "Topology":
        raise SystemExit(f"{path}: não é Topology")
    geoms = topo["objects"][name]["geometries"]
    if len(geoms) != expected:
        raise SystemExit(f"{path}: {len(geoms)} geometrias, esperado {expected}")
    ids = [g["properties"]["id"] for g in geoms]
    if len(set(ids)) != len(ids):
        raise SystemExit(f"{path}: ids duplicados")
    degenerate = []
    for g in geoms:
        if g.get("type") not in ("Polygon", "MultiPolygon"):
            raise SystemExit(f"{path}: geometria {g.get('properties')} sem polígono")
        for k in props:
            if not g["properties"].get(k):
                raise SystemExit(f"{path}: {g['properties']} sem '{k}'")
        total = 0.0
        for p in _polys(g):
            for r in p:
                pts: list = []
                for i in r:
                    seg = decode_arc(topo, i)
                    pts.extend(seg if not pts else seg[1:])
                total += _area(pts)
        if total == 0:
            degenerate.append(g["properties"]["id"])
    if degenerate:
        raise SystemExit(f"{path}: geometrias com área zero: {degenerate}")
    print(f"  ok {path.name}: {len(geoms)} geometrias, {len(topo['arcs'])} arcos, "
          f"{sum(len(a) for a in topo['arcs']):,} pontos, {path.stat().st_size:,} bytes")


def verify_with_node(node: Node, topo_path: Path, name: str, out_geojson: Path, expected: int) -> None:
    """Round-trip com topojson-client (topo2geo) para garantir que o arquivo é legível."""
    node.run("topo2geo", "-i", str(topo_path), f"{name}={out_geojson}")
    with out_geojson.open("rb") as fh:
        gj = json.load(fh)
    n = len(gj["features"])
    if n != expected:
        raise SystemExit(f"topo2geo {topo_path.name}: {n} features, esperado {expected}")
    print(f"  ok topojson-client topo2geo {topo_path.name}: {n} features")


def write_json(path: Path, obj, *, one_per_line: bool = False, indent: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if one_per_line:
        lines = [json.dumps(k, ensure_ascii=False) + ":" + json.dumps(v, ensure_ascii=False, separators=(",", ":"))
                 for k, v in obj.items()]
        text = "{\n" + ",\n".join(lines) + "\n}\n"
    else:
        text = json.dumps(obj, ensure_ascii=False, indent=indent,
                          separators=(",", ":") if indent is None else None)
        if indent is not None:
            text += "\n"
    path.write_text(text, encoding="utf-8")


# --------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cache-dir", type=Path, default=PROJECT / "data" / "raw" / "geo",
                    help="diretório para as malhas baixadas do IBGE (dados não confiáveis)")
    ap.add_argument("--tse", type=Path, default=PROJECT / "data" / "ref" / "tse-municipios-2026.json")
    ap.add_argument("--out-geo", type=Path, default=PROJECT / "web" / "public" / "geo")
    ap.add_argument("--out-ref", type=Path, default=PROJECT / "data" / "ref")
    ap.add_argument("--web-ref", type=Path, default=PROJECT / "web" / "public" / "ref")
    ap.add_argument("--simplify", type=float, default=2e-6,
                    help="área mínima (esférica, em steradianos) do Visvalingam para municípios")
    ap.add_argument("--min-ratio", type=float, default=0.6,
                    help="restaura arcos originais de municípios cuja área cair abaixo desta fração")
    ap.add_argument("--quantize", type=float, default=3e4, help="quantização da malha municipal")
    ap.add_argument("--uf-quantize", type=float, default=1e5, help="quantização da malha de UF")
    ap.add_argument("--node-bin", type=Path, default=None,
                    help="diretório node_modules/.bin com geo2topo/toposimplify/topoquantize/topo2geo "
                         "(padrão: npx com versões fixas)")
    ap.add_argument("--force-download", action="store_true")
    args = ap.parse_args()

    cache: Path = args.cache_dir.resolve()
    build = cache / "build"
    build.mkdir(parents=True, exist_ok=True)
    node = Node(args.node_bin.resolve() if args.node_bin else None, cwd=PROJECT)

    # ---- TSE
    print("TSE")
    with args.tse.open("rb") as fh:
        tse = json.load(fh)
    mun_ref: dict[str, dict] = {}
    tse_ufs: set[str] = set()
    for abr in tse["abr"]:
        sigla = abr["cd"].upper()
        tse_ufs.add(sigla)
        for m in abr["mu"]:
            key = m["cdi"] if sigla != "ZZ" else f"99{m['cd']}"
            if not key:
                raise SystemExit(f"município sem código IBGE fora do exterior: {sigla} {m}")
            if key in mun_ref:
                raise SystemExit(f"código IBGE duplicado na tabela TSE: {key}")
            mun_ref[key] = {"tse": m["cd"], "uf": sigla, "nome": title_case(m["nm"]),
                            "capital": m.get("c") == "s"}
    n_zz = sum(1 for v in mun_ref.values() if v["uf"] == "ZZ")
    print(f"  {len(mun_ref)} municípios na tabela TSE ({len(mun_ref) - n_zz} + {n_zz} exterior)")
    missing_uf = (set(UFS) | {"ZZ"}) ^ tse_ufs
    if missing_uf:
        raise SystemExit(f"UFs divergentes entre tabela fixa e TSE: {sorted(missing_uf)}")

    # ---- malhas
    print("Malhas IBGE")
    uf_gj = ensure_mesh(URL_UF, cache / "uf.geojson", args.force_download)
    mun_gj = ensure_mesh(URL_MUN, cache / "mun.geojson", args.force_download)

    # ---- UF
    print("UF")
    feats = []
    for f in uf_gj["features"]:
        code = str(f["properties"]["codarea"])
        sigla = IBGE_TO_UF.get(code)
        if not sigla:
            raise SystemExit(f"UF desconhecida na malha: {code}")
        feats.append({"type": "Feature", "properties": {"id": code, "nome": UFS[sigla][0]},
                      "geometry": f["geometry"]})
    if len(feats) != 27 or len({f["properties"]["id"] for f in feats}) != 27:
        raise SystemExit(f"malha de UF com {len(feats)} features (esperado 27)")
    uf_clean = build / "uf_clean.geojson"
    write_json(uf_clean, {"type": "FeatureCollection", "features": feats})
    uf_topo_bytes = node.run("geo2topo", f"uf={uf_clean}", "-q", f"{args.uf_quantize:g}")
    out_uf = args.out_geo / "br-uf.topo.json"
    out_uf.parent.mkdir(parents=True, exist_ok=True)
    out_uf.write_bytes(uf_topo_bytes)
    verify_topology(out_uf, "uf", 27, ("id", "nome"))
    verify_with_node(node, out_uf, "uf", build / "uf_roundtrip.geojson", 27)

    # ---- municípios
    print("Municípios")
    feats = []
    mesh_codes: set[str] = set()
    not_in_tse: list[str] = []
    for f in mun_gj["features"]:
        code = str(f["properties"]["codarea"])
        mesh_codes.add(code)
        ref = mun_ref.get(code)
        if ref is None:
            not_in_tse.append(code)
            nome, uf = None, IBGE_TO_UF.get(code[:2])
        else:
            nome, uf = ref["nome"], ref["uf"]
        feats.append({"type": "Feature", "properties": {"id": code, "nome": nome, "uf": uf},
                      "geometry": f["geometry"]})
    not_in_mesh = sorted(k for k, v in mun_ref.items() if v["uf"] != "ZZ" and k not in mesh_codes)
    n_mun = len(feats)
    if n_mun != 5570 or len(mesh_codes) != n_mun:
        print(f"  AVISO: malha com {n_mun} municípios (esperado 5570)")
    mun_clean = build / "mun_clean.geojson"
    write_json(mun_clean, {"type": "FeatureCollection", "features": feats})

    raw_path = build / "mun_raw.topo.json"
    raw_path.write_bytes(node.run("geo2topo", f"mun={mun_clean}"))
    simp_path = build / "mun_simp.topo.json"
    simp_path.write_bytes(node.run("toposimplify", "-s", f"{args.simplify:g}", str(raw_path)))
    with raw_path.open("rb") as fh:
        raw = json.load(fh)
    with simp_path.open("rb") as fh:
        simp = json.load(fh)
    n_g, n_a = protect_small(raw, simp, "mun", args.min_ratio)
    print(f"  simplificação -s {args.simplify:g}: {sum(len(a) for a in raw['arcs']):,} -> "
          f"{sum(len(a) for a in simp['arcs']):,} pontos; {n_g} municípios pequenos "
          f"restaurados ({n_a} arcos)")
    prot_path = build / "mun_prot.topo.json"
    write_json(prot_path, simp)
    out_mun = args.out_geo / "br-mun.topo.json"
    out_mun.write_bytes(node.run("topoquantize", f"{args.quantize:g}", str(prot_path)))
    verify_topology(out_mun, "mun", n_mun, ("id", "uf"))
    verify_with_node(node, out_mun, "mun", build / "mun_roundtrip.geojson", n_mun)

    # ---- referências
    print("Referências")
    ufs_out = {sigla: {"nome": nome, "ibge": ibge, "regiao": regiao}
               for sigla, (nome, ibge, regiao) in sorted(UFS.items())}
    ufs_out["ZZ"] = {"nome": "Exterior", "ibge": None, "regiao": None}
    mun_out = dict(sorted(mun_ref.items()))
    write_json(args.out_ref / "municipios.json", mun_out, one_per_line=True)
    write_json(args.out_ref / "ufs.json", ufs_out, indent=2)
    args.web_ref.mkdir(parents=True, exist_ok=True)
    for name in ("municipios.json", "ufs.json"):
        shutil.copyfile(args.out_ref / name, args.web_ref / name)

    # ---- relatório
    print("\nArquivos gerados:")
    for p in (out_uf, out_mun, args.out_ref / "municipios.json", args.out_ref / "ufs.json",
              args.web_ref / "municipios.json", args.web_ref / "ufs.json"):
        shown = p.relative_to(PROJECT) if p.resolve().is_relative_to(PROJECT) else p
        print(f"  {p.stat().st_size:>10,}  {shown}")
    print("\nDivergências malha IBGE x tabela TSE:")
    print(f"  na malha mas não no TSE ({len(not_in_tse)}): {not_in_tse or '-'}")
    print(f"  no TSE mas não na malha ({len(not_in_mesh)}): "
          f"{[(k, mun_ref[k]['uf'], mun_ref[k]['nome']) for k in not_in_mesh] or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
