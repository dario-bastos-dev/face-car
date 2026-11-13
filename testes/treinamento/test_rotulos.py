"""Limpeza dos rótulos dos quadros de vídeo (treinamento/rotulos.py).

O UTA-RLDD rotula o vídeo inteiro, mas a pessoa "sonolenta" passa boa parte dele de olhos
abertos: o FaceCar_CNN_V4 aprendeu com esses quadros e pegou só 18% dos sonolentos de gente nova.
"""

import numpy as np
import pytest

from treinamento.rotulos import limpar

NOMES = ["alerta", "sonolento", "bocejo"]


def exemplo(itens):
    """itens: (pessoa, classe, de_video, ear) → arrays como no notebook."""
    pessoas, classes, videos, ears = zip(*itens)
    return (np.array(pessoas, dtype=object), np.array([NOMES.index(c) for c in classes]),
            np.array(videos), np.array(ears, dtype=float))


def test_sonolento_fica_so_com_olho_fechando_em_relacao_ao_alerta_da_pessoa():
    pessoas, rotulos, de_video, ear = exemplo(
        [("a", "alerta", True, 0.30)] * 3 + [("a", "sonolento", True, e) for e in (0.30, 0.24, 0.20, 0.05)])
    manter, _ = limpar(rotulos, pessoas, de_video, ear, NOMES, fracao=0.75)
    # referência 0,30 → corte 0,225: fica 0,20 e 0,05; 0,30 e 0,24 parecem alertas
    assert manter.tolist() == [True] * 3 + [False, False, True, True]


def test_alerta_perde_as_piscadas():
    pessoas, rotulos, de_video, ear = exemplo(
        [("a", "alerta", True, e) for e in (0.30, 0.31, 0.29, 0.10)])
    manter, _ = limpar(rotulos, pessoas, de_video, ear, NOMES, fracao=0.75)
    assert manter.tolist() == [True, True, True, False]


def test_a_referencia_e_de_cada_pessoa():
    # olho naturalmente mais fechado (0,22) não vira sonolento só por ser pequeno
    pessoas, rotulos, de_video, ear = exemplo(
        [("a", "alerta", True, 0.22), ("a", "sonolento", True, 0.21),
         ("b", "alerta", True, 0.36), ("b", "sonolento", True, 0.21)])
    manter, referencia = limpar(rotulos, pessoas, de_video, ear, NOMES, fracao=0.75)
    assert referencia == pytest.approx({"a": 0.22, "b": 0.36})
    assert manter.tolist() == [True, False, True, True]


def test_fotos_e_bocejo_nao_mudam():
    # as fotos próprias já foram conferidas uma a uma (treinamento/organizar_dataset.py)
    pessoas, rotulos, de_video, ear = exemplo(
        [("p", "alerta", False, 0.05), ("p", "sonolento", False, 0.40), ("p", "bocejo", False, 0.30)])
    manter, _ = limpar(rotulos, pessoas, de_video, ear, NOMES, fracao=0.75)
    assert manter.all()


def test_sem_video_alerta_da_pessoa_os_quadros_ficam():
    # sem referência não há como comparar; melhor não descartar às cegas
    pessoas, rotulos, de_video, ear = exemplo([("c", "sonolento", True, 0.30)])
    manter, referencia = limpar(rotulos, pessoas, de_video, ear, NOMES, fracao=0.75)
    assert manter.tolist() == [True] and referencia == {}


def test_quadro_sem_medida_sai():
    pessoas, rotulos, de_video, ear = exemplo(
        [("a", "alerta", True, 0.30), ("a", "sonolento", True, float("nan"))])
    manter, _ = limpar(rotulos, pessoas, de_video, ear, NOMES, fracao=0.75)
    assert manter.tolist() == [True, False]


def test_video_de_bocejo_fica_so_com_a_boca_aberta():
    # gravações guiadas: entre um bocejo e outro a boca está fechada
    pessoas, rotulos, de_video, ear = exemplo(
        [("w", "bocejo", True, 0.3)] * 3 + [("w", "bocejo", False, 0.3)])
    boca = np.array([0.6, 0.1, np.nan, 0.05])
    manter, _ = limpar(rotulos, pessoas, de_video, ear, NOMES, fracao=0.75, boca=boca, boca_aberta=0.4)
    assert manter.tolist() == [True, False, False, True]   # a foto fica como está
