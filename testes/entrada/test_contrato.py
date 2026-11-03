from dataclasses import fields

import pytest

from entrada.contrato import (RAIZ, EscritorMetricas, RegistroMetricas, carregar_contrato,
                              ler_metricas)


def test_contrato_e_registro_tem_os_mesmos_campos():
    nomes = [c["nome"] for c in carregar_contrato()["colunas"]]
    assert nomes == [f.name for f in fields(RegistroMetricas)]


def test_exemplo_do_contrato_e_valido():
    registros = ler_metricas(RAIZ / "contratos" / "metricas.exemplo.csv")
    assert len(registros) == 4
    assert registros[3].rosto_visivel is False and registros[3].ear_esq is None


def test_ida_e_volta(tmp_path):
    caminho = tmp_path / "m.csv"
    originais = [
        RegistroMetricas(0, 0, True, 0.31234, 0.29, 0.05, -3.456, 5.0, 1.0, 0.9876, 12.34),
        RegistroMetricas(33, 1, False, confianca=0.0, atraso_ms=3.0),
    ]
    with EscritorMetricas(caminho) as escritor:
        for r in originais:
            escritor.escrever(r)
    lidos = ler_metricas(caminho)
    assert lidos[0].ear_esq == pytest.approx(0.3123)
    assert lidos[0].yaw == pytest.approx(-3.46)
    assert lidos[0].confianca == pytest.approx(0.988)
    assert lidos[1] == RegistroMetricas(33, 1, False, confianca=0.0, atraso_ms=3.0)
