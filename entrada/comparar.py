"""Compara dois arquivos de métricas quadro a quadro (por exemplo, Python e navegador)."""

import numpy as np

from entrada.contrato import ler_metricas

COLUNAS_NUMERICAS = ["ear_esq", "ear_dir", "abertura_boca", "yaw", "pitch", "roll", "confianca"]


def comparar(caminho_a, caminho_b) -> dict:
    a = {r.quadro: r for r in ler_metricas(caminho_a)}
    b = {r.quadro: r for r in ler_metricas(caminho_b)}
    comuns = sorted(a.keys() & b.keys())
    if not comuns:
        raise ValueError("Os arquivos não têm quadros em comum")

    # Com fps diferentes, o mesmo índice aponta para instantes diferentes e as
    # diferenças abaixo deixariam de comparar o mesmo quadro.
    alertas = []
    if len(a) != len(b):
        alertas.append(f"número de quadros diferente: {len(a)} e {len(b)}")
    divergentes = [q for q in comuns if a[q].t_ms != b[q].t_ms]
    if divergentes:
        q = divergentes[0]
        alertas.append(f"t_ms diverge em {len(divergentes)} quadros, o primeiro é o {q} "
                       f"({a[q].t_ms} e {b[q].t_ms} ms); confira o fps usado em cada lado")

    concordam = sum(a[q].rosto_visivel == b[q].rosto_visivel for q in comuns)
    ambos = [q for q in comuns if a[q].rosto_visivel and b[q].rosto_visivel]
    colunas = {}
    for nome in COLUNAS_NUMERICAS:
        diffs = np.array([
            abs(getattr(a[q], nome) - getattr(b[q], nome))
            for q in ambos
            if getattr(a[q], nome) is not None and getattr(b[q], nome) is not None
        ])
        if diffs.size:
            colunas[nome] = {
                "media": float(diffs.mean()),
                "p95": float(np.percentile(diffs, 95)),
                "max": float(diffs.max()),
            }
    return {
        "quadros_a": len(a),
        "quadros_b": len(b),
        "quadros_comuns": len(comuns),
        "concordancia_rosto": concordam / len(comuns),
        "quadros_com_rosto_em_ambos": len(ambos),
        "diferencas": colunas,
        "alertas": alertas,
    }


def imprimir(relatorio: dict) -> None:
    print(f"Quadros: A={relatorio['quadros_a']}  B={relatorio['quadros_b']}  "
          f"comuns={relatorio['quadros_comuns']}")
    print(f"Concordância de rosto visível: {relatorio['concordancia_rosto']:.1%}")
    print(f"Quadros com rosto nos dois: {relatorio['quadros_com_rosto_em_ambos']}")
    print(f"{'coluna':<15}{'média':>10}{'p95':>10}{'máx':>10}")
    for nome, d in relatorio["diferencas"].items():
        print(f"{nome:<15}{d['media']:>10.4f}{d['p95']:>10.4f}{d['max']:>10.4f}")
    for alerta in relatorio["alertas"]:
        print(f"ALERTA: {alerta}")
