"""Organização de treinamento/dataset nas pastas de classe lidas pelo notebook de treino."""

import re

import pytest

from treinamento import organizar_dataset as org

REGEX_PESSOA = r"^([^_]+)_"   # a mesma de treinamento/modelo.ipynb


def criar(raiz, *relativos):
    for relativo in relativos:
        arquivo = raiz / relativo
        arquivo.parent.mkdir(parents=True, exist_ok=True)
        arquivo.write_bytes(relativo.encode())


def destinos(raiz):
    return {m.origem.relative_to(raiz).as_posix(): m.destino.relative_to(raiz).as_posix()
            for m in org.planejar(raiz)}


def test_rldd_vai_para_a_classe_do_numero_do_video(tmp_path):
    criar(tmp_path, "Fold1_part1/01/0.mov", "Fold1_part1/01/10.MOV", "Fold1_part1/01/5.mp4",
          "Fold3_part2/32/10_1.mp4", "Fold3_part2/32/10_2.mp4")
    assert destinos(tmp_path) == {
        "Fold1_part1/01/0.mov": "alerta/rldd/rldd01_0.mov",
        "Fold1_part1/01/10.MOV": "sonolento/rldd/rldd01_10.MOV",
        "Fold1_part1/01/5.mp4": "_fora_do_treino/pouco_alerta/rldd/rldd01_5.mp4",
        "Fold3_part2/32/10_1.mp4": "sonolento/rldd/rldd32_10_1.mp4",
        "Fold3_part2/32/10_2.mp4": "sonolento/rldd/rldd32_10_2.mp4",
    }


def test_fotos_proprias_vao_para_a_classe_com_a_pessoa_no_nome(tmp_path):
    criar(tmp_path, "data_set_propio/1_estado/acordado/foto_0001.jpg",
          "data_set_propio/1_estado/acordado/foto_0207.jpg",
          "data_set_propio/2_olhos/olhos_fechados/foto_0002.jpg",
          "data_set_propio/3_bocejo/com_bocejo/foto_0157.jpg",
          "data_set_propio/3_bocejo/com_bocejo/foto_0158.jpg")
    assert destinos(tmp_path) == {
        "data_set_propio/1_estado/acordado/foto_0001.jpg": "alerta/proprio/proprio1_acordado_0001.jpg",
        "data_set_propio/1_estado/acordado/foto_0207.jpg": "alerta/proprio/proprio2_acordado_0207.jpg",
        "data_set_propio/2_olhos/olhos_fechados/foto_0002.jpg":
            "sonolento/proprio/proprio1_olhos_fechados_0002.jpg",
        # 157 é o começo do bocejo, ainda de boca fechada: rótulo duvidoso
        "data_set_propio/3_bocejo/com_bocejo/foto_0157.jpg":
            "_fora_do_treino/duvidosas/proprio2_bocejo_0157.jpg",
        "data_set_propio/3_bocejo/com_bocejo/foto_0158.jpg": "bocejo/proprio/proprio2_bocejo_0158.jpg",
    }


def test_todo_destino_de_treino_tem_a_pessoa_no_nome(tmp_path):
    criar(tmp_path, "Fold5_part1/49/10_2.mp4", "Fold4_part2/46/0.m4v",
          "data_set_propio/1_estado/sonolento/foto_0260.jpg")
    pessoas = {re.search(REGEX_PESSOA, m.destino.name).group(1) for m in org.planejar(tmp_path)}
    assert pessoas == {"rldd49", "rldd46", "proprio2"}


def test_arquivo_desconhecido_impede_o_plano(tmp_path):
    criar(tmp_path, "Fold1_part1/01/0.mov", "Fold1_part1/01/3.mov", "solto.jpg")
    with pytest.raises(ValueError, match=r"3\.mov.*solto\.jpg|solto\.jpg.*3\.mov"):
        org.planejar(tmp_path)


def test_ja_organizado_nao_gera_movimentos(tmp_path):
    criar(tmp_path, "alerta/rldd/rldd01_0.mov", "bocejo/proprio/proprio1_bocejo_0004.jpg")
    assert org.planejar(tmp_path) == []


def test_aplicar_move_grava_o_registro_e_desfazer_devolve(tmp_path):
    originais = ["Fold1_part1/01/0.mov", "Fold1_part1/01/5.mov",
                 "data_set_propio/3_bocejo/com_bocejo/foto_0004.jpg"]
    criar(tmp_path, *originais)
    (tmp_path / "data_set_propio/3_bocejo/sem_bocejo").mkdir()

    org.aplicar(tmp_path, org.planejar(tmp_path))

    assert (tmp_path / "alerta/rldd/rldd01_0.mov").read_bytes() == b"Fold1_part1/01/0.mov"
    assert (tmp_path / org.REGISTRO).is_file()
    assert not (tmp_path / "Fold1_part1").exists()
    assert not (tmp_path / "data_set_propio").exists()   # pastas vazias somem

    org.desfazer(tmp_path)

    for relativo in originais:
        assert (tmp_path / relativo).read_bytes() == relativo.encode()
    assert not (tmp_path / org.REGISTRO).exists()
    assert not (tmp_path / "alerta").exists()


def test_aplicar_nao_sobrescreve_destino_existente(tmp_path):
    criar(tmp_path, "Fold1_part1/01/0.mov", "alerta/rldd/rldd01_0.mov")
    with pytest.raises(FileExistsError):
        org.aplicar(tmp_path, org.planejar(tmp_path))
    assert (tmp_path / "Fold1_part1/01/0.mov").exists()
