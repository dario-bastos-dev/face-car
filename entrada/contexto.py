"""Caminhos do projeto e leitura da configuração."""

import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CAMINHO_CONFIG = RAIZ / "config" / "captura.json"


def carregar_config(caminho=CAMINHO_CONFIG) -> dict:
    return json.loads(Path(caminho).read_text(encoding="utf-8"))
