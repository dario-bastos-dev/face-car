"""Linha de comando: erros esperados viram mensagem curta, sem traceback."""

from entrada.__main__ import main


def test_video_inexistente_da_mensagem_clara(tmp_path, capsys):
    ausente = tmp_path / "nao-existe.mp4"
    assert main(["video", str(ausente)]) == 2
    erro = capsys.readouterr().err
    assert "não encontrado" in erro and str(ausente) in erro
    assert "Traceback" not in erro


def test_arquivo_que_nao_e_video_da_mensagem_clara(tmp_path, capsys):
    falso = tmp_path / "texto.mp4"
    falso.write_text("isto não é um vídeo")
    assert main(["video", str(falso)]) == 2
    assert "Não foi possível abrir o vídeo" in capsys.readouterr().err
