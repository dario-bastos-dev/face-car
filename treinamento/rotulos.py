"""Limpeza dos rótulos dos quadros de vídeo, pela abertura dos olhos.

O UTA-RLDD rotula o vídeo inteiro: "0" = alerta, "10" = sonolento. Mas a pessoa sonolenta passa
boa parte do vídeo de olhos abertos, com cara de alerta. No FaceCar_CNN_V4, treinado com todos os
quadros, a rede pegou só 18% dos sonolentos de gente nova. Num quadro isolado, o que mostra o
sono é o olho fechando, e é isso que fica:

- quadro de vídeo **sonolento**: só se o olho estiver mais fechado que `fracao` da abertura
  normal da pessoa (a mediana do EAR nos quadros do vídeo alerta dela);
- quadro de vídeo **alerta**: sai se o olho estiver abaixo desse mesmo corte (piscadas);
- quadro de vídeo **bocejo** (gravações guiadas, treinamento/gravar.py): só com a boca aberta,
  porque entre um bocejo e outro a boca fica fechada;
- fotos não mudam: as fotos próprias já foram conferidas uma a uma.

A referência é de cada pessoa porque o tamanho do olho varia muito: 0,22 é olho aberto para
uns e meio fechado para outros. A inclinação da cabeça não entra: a câmera muda de lugar entre
os dois vídeos da mesma pessoa, e o ângulo não se compara.
"""

import numpy as np


def limpar(rotulos, pessoas, de_video, ear, nomes, fracao: float = 0.75, boca=None,
           boca_aberta: float = 0.4):
    """(manter, referência por pessoa): que quadros ficam no treino.

    `ear` é a abertura média dos olhos de cada imagem e `boca` a abertura da boca (NaN sem
    medida). Quadro de vídeo sem medida sai; pessoa sem vídeo alerta fica sem referência, e os
    quadros alerta e sonolento dela não mudam. Quadro de vídeo de bocejo fica só com a boca
    acima de `boca_aberta` (rosto.abertura_boca_aberta em config/analise.json).
    """
    rotulos, ear = np.asarray(rotulos), np.asarray(ear, dtype=float)
    pessoas, de_video = np.asarray(pessoas, dtype=object), np.asarray(de_video, dtype=bool)
    alerta, sonolento = nomes.index("alerta"), nomes.index("sonolento")
    base = de_video & (rotulos == alerta) & ~np.isnan(ear)
    referencia = {p: float(np.median(ear[base & (pessoas == p)])) for p in sorted(set(pessoas[base]))}

    manter = np.ones(len(rotulos), dtype=bool)
    for i in np.flatnonzero(de_video & np.isin(rotulos, [alerta, sonolento])):
        if np.isnan(ear[i]):
            manter[i] = False
        elif pessoas[i] in referencia:
            fechando = ear[i] < fracao * referencia[pessoas[i]]
            manter[i] = fechando if rotulos[i] == sonolento else not fechando
    if boca is not None and "bocejo" in nomes:
        boca = np.asarray(boca, dtype=float)
        for i in np.flatnonzero(de_video & (rotulos == nomes.index("bocejo"))):
            manter[i] = not np.isnan(boca[i]) and boca[i] > boca_aberta
    return manter, referencia
