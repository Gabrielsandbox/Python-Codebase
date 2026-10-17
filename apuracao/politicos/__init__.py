"""politicos — ficha pública de cada político: mandato (Câmara/Senado) + candidatura 2026 (TSE).

Camadas:
  baixar  -> arquivos em massa da Câmara, API do Senado e ZIPs do TSE para data/politicos/raw/
  camara  -> presença em plenário, proposições de autoria, votos nominais e cota parlamentar
  senado  -> participação em votações nominais, autorias e CEAPS
  tse     -> candidaturas de 2026 e bens declarados
  gerar   -> cruza tudo e publica indice.json + p/{id}.json (contrato em docs/POLITICOS.md)

Como o resto do projeto, o resultado é estático: o público lê arquivos de um CDN e nunca fala
com a Câmara, o Senado ou o TSE (a API de deputados da Câmara cai com frequência).
"""
from __future__ import annotations

import os
from pathlib import Path

RAIZ = Path(os.environ.get("APURACAO_RAIZ", Path(__file__).resolve().parent.parent))
RAW_DIR = Path(os.environ.get("POLITICOS_RAW_DIR", RAIZ / "data" / "politicos" / "raw"))
# Publicado ao lado dos snapshots da apuração (mesmo bucket/CDN, prefixo politicos/).
OUT_DIR = Path(
    os.environ.get("POLITICOS_OUT_DIR", Path(os.environ.get("APURACAO_DATA_DIR", RAIZ / "data" / "latest")) / "politicos")
)

# Legislatura 57 (fev/2023 a jan/2027): é a janela de todos os números de mandato.
LEGISLATURA = 57
INICIO_LEGISLATURA = "2023-02-01"
ANOS = (2023, 2024, 2025, 2026)
ANOS_VOTOS = (2025, 2026)
