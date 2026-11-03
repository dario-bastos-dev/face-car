"""Caminhos do projeto e leitura da configuração."""

import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CAMINHO_CONFIG = RAIZ / "config" / "analise.json"


def carregar_config(caminho=CAMINHO_CONFIG) -> dict:
    return json.loads(Path(caminho).read_text(encoding="utf-8"))


def carregar_pontos_rosto() -> dict:
    """Índices dos pontos do MediaPipe usados nos recortes de olhos e boca."""
    return json.loads((RAIZ / "entrada" / "pontos_rosto.json").read_text(encoding="utf-8"))
