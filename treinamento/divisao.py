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


def mover_para_o_treino(conjuntos: dict, pessoas, rotulos, nomes):
    """(conjuntos, movidos): as imagens que fariam `pessoas_com_classe_que_o_treino_nao_viu`
    reclamar voltam para o treino.

    Só acontece com quem está em blocos (fotos próprias e gravações), quando todos os blocos de
    uma classe dela caem fora do treino. Mover é melhor do que recusar a divisão: na validação
    cruzada, cada dobra sorteia blocos diferentes.
    """
    pessoas, rotulos = np.asarray(pessoas, dtype=object), np.asarray(rotulos)
    treino = conjuntos["treino"]
    no_treino = {(p, r) for p, r in zip(pessoas[treino], rotulos[treino])}
    com_treino = set(pessoas[treino])
    novos, movidos, extra = {}, [], []
    for nome, idx in conjuntos.items():
        if nome == "treino":
            continue
        sai = np.array([pessoas[i] in com_treino and (pessoas[i], rotulos[i]) not in no_treino
                        for i in idx], dtype=bool)
        for p, r in sorted({(pessoas[i], rotulos[i]) for i in idx[sai]}):
            n = int(np.sum((pessoas[idx[sai]] == p) & (rotulos[idx[sai]] == r)))
            onde = "da validação" if nome == "validação" else f"do {nome}"
            movidos.append(f"{p}/{nomes[r]}: {n} imagens {onde} foram para o treino")
        novos[nome] = idx[~sai]
        extra.append(idx[sai])
    novos["treino"] = np.concatenate([treino, *extra]).astype(treino.dtype)
    return {nome: novos[nome] for nome in conjuntos}, movidos


def limitar_por_pessoa(indices, pessoas, rotulos, caminhos, nomes, maximo: dict | None):
    """Os `indices` com no máximo `maximo[classe]` imagens de cada pessoa em cada classe.

    Ficam imagens espaçadas por igual, em ordem de nome (ao longo do vídeo), e não um trecho só.
    Classe fora de `maximo` não tem teto. Sem isso, uma pessoa com 250 quadros sonolentos pesa
    4 vezes mais que outra com 60, e a rede aprende a reconhecê-la.
    """
    indices = np.asarray(indices)
    if not maximo:
        return indices
    pessoas, rotulos = np.asarray(pessoas, dtype=object), np.asarray(rotulos)
    caminhos = np.asarray(caminhos)
    ficam = []
    for p, r in sorted({(pessoas[i], rotulos[i]) for i in indices}):
        dela = indices[(pessoas[indices] == p) & (rotulos[indices] == r)]
        dela = dela[np.argsort(caminhos[dela], kind="stable")]
        teto = maximo.get(nomes[r])
        if teto and len(dela) > teto:
            dela = dela[np.linspace(0, len(dela) - 1, teto).round().astype(int)]
        ficam.append(dela)
    return np.sort(np.concatenate(ficam)) if ficam else indices[:0]
