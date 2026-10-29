from entrada.__main__ import main
from entrada.comparar import comparar
from entrada.contrato import EscritorMetricas, RegistroMetricas


def gravar(caminho, registros):
    with EscritorMetricas(caminho) as escritor:
        for r in registros:
            escritor.escrever(r)
    return caminho


def sequencia(n, passo_ms=40, ear=0.3):
    return [RegistroMetricas(i * passo_ms, i, True, ear, ear, 0.1, 1.0, 2.0, 3.0, 0.9, 5.0)
            for i in range(n)]


def test_arquivos_alinhados_nao_geram_alerta(tmp_path):
    a = gravar(tmp_path / "a.csv", sequencia(5))
    b = gravar(tmp_path / "b.csv", sequencia(5, ear=0.31))
    r = comparar(a, b)
    assert r["alertas"] == []
    assert r["diferencas"]["ear_esq"]["max"] == pytest_approx(0.01)
    assert main(["comparar", str(a), str(b)]) == 0


def test_numero_de_quadros_diferente_gera_alerta(tmp_path):
    a = gravar(tmp_path / "a.csv", sequencia(5))
    b = gravar(tmp_path / "b.csv", sequencia(7))
    r = comparar(a, b)
    assert any("quadros" in alerta for alerta in r["alertas"])
    assert main(["comparar", str(a), str(b)]) == 1


def test_marca_de_tempo_divergente_gera_alerta(tmp_path):
    # Mesmo número de quadros, mas fps diferente: os índices não são os mesmos instantes.
    a = gravar(tmp_path / "a.csv", sequencia(5, passo_ms=40))
    b = gravar(tmp_path / "b.csv", sequencia(5, passo_ms=33))
    r = comparar(a, b)
    assert any("t_ms" in alerta for alerta in r["alertas"])
    assert main(["comparar", str(a), str(b)]) == 1


def pytest_approx(valor):
    import pytest
    return pytest.approx(valor, abs=1e-4)
