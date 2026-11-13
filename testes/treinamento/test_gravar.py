"""Gravação guiada de vídeos de treino (treinamento/gravar.py), sem câmera."""

import re

import pytest

from treinamento import gravar

REGEX_PESSOA = r"^([^_]+)_"   # a do notebook de treino


def test_destino_por_classe_com_a_pessoa_no_comeco_do_nome(tmp_path):
    arquivo = gravar.destino(tmp_path, "voce1", "oculos", "sonolento")
    assert arquivo == tmp_path / "sonolento" / "gravacoes" / "voce1_oculos_sonolento.mp4"
    assert re.search(REGEX_PESSOA, arquivo.name).group(1) == "voce1"


@pytest.mark.parametrize("nome", ["voce_1", "Você", "", "a b"])
def test_nome_invalido_e_recusado(nome):
    with pytest.raises(ValueError):
        gravar.validar_nome(nome, "pessoa")


def test_instrucao_segue_o_ciclo():
    ciclo = [("FECHE OS OLHOS", 6), ("Abra devagar", 4)]
    assert gravar.instrucao(ciclo, 0)[0] == "FECHE OS OLHOS"
    assert gravar.instrucao(ciclo, 7) == ("Abra devagar", pytest.approx(3))
    assert gravar.instrucao(ciclo, 10.5)[0] == "FECHE OS OLHOS"   # recomeça


def test_roteiro_cobre_as_tres_classes_do_modelo():
    from entrada.contexto import carregar_config

    assert [c for c, _, _ in gravar.ROTEIRO] == carregar_config()["classificador"]["classes"]


def test_nao_sobrescreve_sem_pedir(tmp_path, capsys):
    arquivo = gravar.destino(tmp_path, "voce1", "oculos", "alerta")
    arquivo.parent.mkdir(parents=True)
    arquivo.write_bytes(b"x")
    assert gravar.main(["--pessoa", "voce1", "--variante", "oculos", "--dataset", str(tmp_path)]) == 2
    assert "--substituir" in capsys.readouterr().err
    assert arquivo.read_bytes() == b"x"
