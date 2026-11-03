"""As métricas em CSV (Parte 1) continuam disponíveis em `python -m entrada metricas`."""

import pytest

from entrada.__main__ import main
from entrada.contrato import ler_metricas
from entrada.contexto import RAIZ

VIDEO = RAIZ / "testes" / "dados" / "retrato.mp4"
MODELO = RAIZ / "modelos" / "face_landmarker.task"


@pytest.mark.skipif(not (VIDEO.exists() and MODELO.exists()), reason="rode scripts/preparar.sh")
def test_metricas_video_grava_o_csv_do_contrato(tmp_path):
    saida = tmp_path / "metricas.csv"
    assert main(["metricas", "video", str(VIDEO), "-o", str(saida)]) == 0
    registros = ler_metricas(saida)  # o mesmo leitor que o estimador da Parte 2 usa
    assert len(registros) == 120
    assert registros[30].rosto_visivel is False and registros[0].ear_esq is not None


def test_metricas_video_inexistente_da_mensagem_clara(tmp_path, capsys):
    assert main(["metricas", "video", str(tmp_path / "nao.mp4")]) == 2
    assert "não encontrado" in capsys.readouterr().err
