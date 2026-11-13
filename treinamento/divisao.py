"""Grupos da divisão treino/validação/teste do notebook de treino (treinamento/modelo.ipynb).

A divisão é por pessoa: quem está no teste nunca foi visto no treino, e a nota mede o modelo
com gente nova. Uma classe com pessoas de menos para isso (o bocejo, só com as 2 pessoas das
fotos próprias) não dá para dividir por pessoa. Nesse caso, as fotos dessas pessoas viram
blocos de fotos seguidas, e isso vale para TODAS as classes delas, não só para a classe com
poucas pessoas.

O motivo veio do primeiro treino do FaceCar_CNN_V3, em que só o bocejo virou blocos. A pessoa 1
apareceu no treino só bocejando e, no teste, alerta e sonolenta. O modelo aprendeu "camiseta
amarela = bocejo" e chamou de bocejo todas as fotos dela, com acerto de 13,6% no teste.
`pessoas_com_classe_que_o_treino_nao_viu` acusa esse tipo de divisão.
"""

import numpy as np


def agrupar(caminhos, rotulos, pessoas, nomes, minimo: int, por_bloco: int):
    """(grupos, pessoas em blocos): o grupo de cada item para a divisão.

    Quem aparece numa classe com menos de `minimo` pessoas fica em blocos de `por_bloco`
    fotos seguidas (em ordem de nome), separados por classe: "proprio1/alerta/bloco03".
    Todo o resto fica agrupado pela pessoa.
    """
    caminhos, rotulos = np.asarray(caminhos), np.asarray(rotulos)
    pessoas = np.asarray(pessoas, dtype=object)
    em_blocos = set()
    for indice in range(len(nomes)):
        da_classe = set(pessoas[rotulos == indice])
        if 0 < len(da_classe) < minimo:
            em_blocos |= da_classe
    grupos = pessoas.copy()
    for quem in sorted(em_blocos):
        for indice, nome in enumerate(nomes):
            dela = np.flatnonzero((pessoas == quem) & (rotulos == indice))
            for k, i in enumerate(dela[np.argsort(caminhos[dela], kind="stable")]):
                grupos[i] = f"{quem}/{nome}/bloco{k // por_bloco:02d}"
    return grupos, sorted(em_blocos)


def pessoas_com_classe_que_o_treino_nao_viu(conjuntos: dict, pessoas, rotulos, nomes) -> list:
    """Pessoas que estão no treino, mas aparecem em outro conjunto com uma classe que o treino
    não tem delas.

    Nesse caso, a rede pode acertar a classe pelo jeito da pessoa (roupa, fundo), e a nota do
    teste fica sem sentido. Uma pessoa que não está no treino não é problema: é exatamente o
    teste com gente nova.
    """
    pessoas, rotulos = np.asarray(pessoas, dtype=object), np.asarray(rotulos)
    treino = conjuntos["treino"]
    no_treino = {}
    for p, r in zip(pessoas[treino], rotulos[treino]):
        no_treino.setdefault(p, set()).add(r)
    problemas = []
    for nome, idx in conjuntos.items():
        if nome == "treino":
            continue
        onde = "na validação" if nome == "validação" else f"no {nome}"
        vistos = set()
        for p, r in zip(pessoas[idx], rotulos[idx]):
            if p in no_treino and r not in no_treino[p] and (p, r) not in vistos:
                vistos.add((p, r))
                problemas.append(f"{p}: '{nomes[r]}' {onde}, mas no treino só "
                                 f"{[nomes[c] for c in sorted(no_treino[p])]}")
    return problemas
