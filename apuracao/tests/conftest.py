import json
import sys
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent
if str(RAIZ) not in sys.path:
    sys.path.insert(0, str(RAIZ))

FIX = Path(__file__).parent / "fixtures"


def carregar(nome: str) -> dict:
    return json.loads((FIX / nome).read_text(encoding="utf-8"))


@pytest.fixture
def doc_br() -> dict:
    return carregar("br-c0001-e006257-u.json")


@pytest.fixture
def doc_sp() -> dict:
    return carregar("sp-c0001-e006257-u.json")


@pytest.fixture
def doc_mun_sp() -> dict:
    return carregar("sp71072-c0001-e006257-u.json")


@pytest.fixture
def doc_catalogo() -> dict:
    return carregar("ele-c.json")


@pytest.fixture
def doc_municipios() -> dict:
    return carregar("mun-cm-ac-zz.json")
