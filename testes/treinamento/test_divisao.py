"""Grupos da divisão treino/validação/teste do notebook de treino (treinamento/divisao.py).

O primeiro treino do V3 errou por isto: a pessoa 1 só aparecia bocejando no treino e caiu
alerta e sonolenta no teste; o modelo aprendeu "camiseta amarela = bocejo".
"""

import numpy as np
import pytest

from treinamento.divisao import agrupar, pessoas_com_classe_que_o_treino_nao_viu

NOMES = ["alerta", "sonolento", "bocejo"]


def dataset(itens):
    """itens: (pessoa, classe, quantidade) → caminhos, rótulos e pessoas, como no notebook."""
    caminhos, rotulos, pessoas = [], [], []
    for pessoa, classe, n in itens:
        for k in range(n):
            caminhos.append(f"{classe}/{pessoa}_{classe}_{k:04d}.jpg")
            rotulos.append(NOMES.index(classe))
            pessoas.append(pessoa)
    return np.array(caminhos), np.array(rotulos), np.array(pessoas, dtype=object)


ITENS = ([(f"rldd{i:02d}", c, 6) for i in range(1, 11) for c in ("alerta", "sonolento")]
         + [(p, c, 40) for p in ("proprio1", "proprio2") for c in NOMES])


def test_pessoa_de_classe_com_poucas_pessoas_vira_blocos_em_todas_as_classes():
    caminhos, rotulos, pessoas = dataset(ITENS)
    grupos, em_blocos = agrupar(caminhos, rotulos, pessoas, NOMES, minimo=7, por_bloco=15)
    assert em_blocos == ["proprio1", "proprio2"]
    da_proprio1 = {g for g, p in zip(grupos, pessoas) if p == "proprio1"}
    assert da_proprio1 == {f"proprio1/{c}/bloco{b:02d}" for c in NOMES for b in range(3)}  # 40 = 15+15+10
    assert {g for g, p in zip(grupos, pessoas) if p == "rldd03"} == {"rldd03"}   # vídeo: por pessoa


def test_blocos_sao_de_fotos_seguidas():
    caminhos, rotulos, pessoas = dataset(ITENS)
    grupos, _ = agrupar(caminhos, rotulos, pessoas, NOMES, minimo=7, por_bloco=15)
    bloco0 = sorted(c for c, g in zip(caminhos, grupos) if g == "proprio2/bocejo/bloco00")
    assert bloco0 == [f"bocejo/proprio2_bocejo_{k:04d}.jpg" for k in range(15)]


def test_com_pessoas_suficientes_nada_vira_bloco():
    caminhos, rotulos, pessoas = dataset([(f"p{i}", c, 3) for i in range(8) for c in NOMES])
    grupos, em_blocos = agrupar(caminhos, rotulos, pessoas, NOMES, minimo=7, por_bloco=15)
    assert em_blocos == [] and list(grupos) == list(pessoas)


def test_acusa_pessoa_que_so_aparece_no_treino_com_outra_classe():
    # O caso do V3: proprio1 só bocejando no treino, alerta no teste.
    caminhos, rotulos, pessoas = dataset([("proprio1", "bocejo", 3), ("proprio1", "alerta", 3),
                                          ("rldd01", "alerta", 3), ("rldd02", "alerta", 3)])
    treino = np.array([0, 1, 2, 6, 7, 8])
    teste = np.array([3, 4, 5, 9, 10, 11])
    problemas = pessoas_com_classe_que_o_treino_nao_viu(
        {"treino": treino, "teste": teste}, pessoas, rotulos, NOMES)
    assert problemas == ["proprio1: 'alerta' no teste, mas no treino só ['bocejo']"]


def test_pessoa_ausente_do_treino_e_o_que_se_quer():
    # rldd02 nunca vista no treino: é a avaliação honesta, não um problema.
    caminhos, rotulos, pessoas = dataset([("rldd01", "alerta", 2), ("rldd02", "alerta", 2)])
    problemas = pessoas_com_classe_que_o_treino_nao_viu(
        {"treino": np.array([0, 1]), "teste": np.array([2, 3])}, pessoas, rotulos, NOMES)
    assert problemas == []


def test_divisao_dos_blocos_nao_deixa_classe_sem_treino():
    # Com a pessoa em blocos em todas as classes, a divisão do notebook não repete o erro do V3.
    from sklearn.model_selection import StratifiedGroupKFold

    caminhos, rotulos, pessoas = dataset(ITENS)
    grupos, _ = agrupar(caminhos, rotulos, pessoas, NOMES, minimo=7, por_bloco=15)
    todos = np.arange(len(caminhos))
    fica, teste = next(StratifiedGroupKFold(7, shuffle=True, random_state=42)
                       .split(todos, rotulos, grupos))
    assert pessoas_com_classe_que_o_treino_nao_viu(
        {"treino": todos[fica], "teste": todos[teste]}, pessoas, rotulos, NOMES) == []
