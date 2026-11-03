"""Gera testes/casos/geometria.json, usado pelos testes em Python e em JavaScript.

Os valores de EAR, boca e pose são analíticos. Os de estabilidade em sequência
com ruído vêm da implementação em Python e servem para garantir que o
JavaScript dê o mesmo resultado (paridade).

    uv run python testes/casos/gerar_casos.py
"""

import json
import math
from pathlib import Path

import numpy as np

from entrada.confianca import Estabilidade, ParametrosConfianca
from entrada.geometria import rotacao

DESTINO = Path(__file__).with_name("geometria.json")


def semelhanca(pontos, angulo, escala, dx, dy):
    c, s = math.cos(angulo), math.sin(angulo)
    m = escala * np.array([[c, -s], [s, c]])
    return (np.asarray(pontos) @ m.T + [dx, dy]).tolist()


def casos_ear():
    aberto = [[0, 0], [3, 2], [7, 2], [10, 0], [7, -2], [3, -2]]
    return [
        {"nome": "aberto", "pontos": aberto, "esperado": 0.4},
        {"nome": "fechado", "pontos": [[0, 0], [3, 0], [7, 0], [10, 0], [7, 0], [3, 0]], "esperado": 0.0},
        {"nome": "girado e ampliado", "pontos": semelhanca(aberto, 0.7, 3.0, 100, 50), "esperado": 0.4},
        {"nome": "largura nula", "pontos": [[5, 0], [5, 1], [5, 2], [5, 0], [5, -1], [5, -2]], "esperado": 0.0},
    ]


def casos_boca():
    return [
        {"nome": "fechada", "pares": [[[2, 0], [2, 0]], [[5, 0], [5, 0]], [[8, 0], [8, 0]]],
         "cantos": [[0, 0], [10, 0]], "esperado": 0.0},
        {"nome": "aberta", "pares": [[[2, 1], [2, -1]], [[5, 2], [5, -2]], [[8, 1], [8, -1]]],
         "cantos": [[0, 0], [10, 0]], "esperado": (2 + 4 + 2) / 3 / 10},
    ]


def casos_pose():
    casos = []
    for yaw, pitch, roll in [(0, 0, 0), (30, 0, 0), (0, -20, 0), (0, 0, 15), (25, 10, -12), (-40, 25, 30)]:
        m = np.eye(4)
        m[:3, :3] = 1.5 * rotacao(yaw, pitch, roll)
        m[:3, 3] = [2.0, -3.0, -40.0]
        casos.append({
            "esperado": {"yaw": yaw, "pitch": pitch, "roll": roll},
            "matriz": m.tolist(),
            "dados_coluna": m.flatten(order="F").tolist(),
        })
    return casos


def casos_estabilidade():
    rng = np.random.default_rng(7)
    base = rng.uniform(0, 100, size=(15, 2))
    ref = 60.0
    parametros = ParametrosConfianca()
    quadros = [
        {"t_ms": 0, "pontos": base},
        {"t_ms": 33, "pontos": np.array(semelhanca(base, 0.05, 1.02, 3, -2))},
        {"t_ms": 67, "pontos": base + rng.normal(0, 1.0, base.shape)},
        {"t_ms": 100, "pontos": base + rng.normal(0, 2.0, base.shape)},
        {"t_ms": 133, "pontos": None},
        {"t_ms": 167, "pontos": base},
        {"t_ms": 900, "pontos": base},
        {"t_ms": 933, "pontos": base + rng.normal(0, 0.5, base.shape)},
    ]
    estab = Estabilidade(parametros)
    saida = []
    for q in quadros:
        pts = q["pontos"]
        conf = estab.atualizar(pts, q["t_ms"], ref if pts is not None else 0.0)
        saida.append({
            "t_ms": q["t_ms"],
            "pontos": None if pts is None else np.asarray(pts).tolist(),
            "esperado": conf,
        })
    return {"parametros": vars(parametros), "distancia_ref": ref, "quadros": saida}


def main():
    casos = {
        "ear": casos_ear(),
        "abertura_boca": casos_boca(),
        "pose": casos_pose(),
        "estabilidade": casos_estabilidade(),
    }
    DESTINO.write_text(json.dumps(casos, indent=1) + "\n", encoding="utf-8")
    print(f"Casos gravados em {DESTINO}")


if __name__ == "__main__":
    main()
