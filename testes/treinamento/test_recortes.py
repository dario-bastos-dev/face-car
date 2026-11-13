"""Recorte do rosto nas fotos e quadros de treino (treinamento/recortes.py)."""

import cv2
import numpy as np
import pytest

from entrada.classificador import caixa_do_rosto
from entrada.contexto import RAIZ
from treinamento import recortes

RETRATO = RAIZ / "testes" / "dados" / "retrato.jpg"
MODELO = RAIZ / "modelos" / "face_landmarker.task"
tem_dados = pytest.mark.skipif(not (RETRATO.exists() and MODELO.exists()),
                               reason="rode scripts/preparar.sh")


def test_destino_espelha_o_caminho_dentro_de_treinamento(tmp_path):
    origem = tmp_path / "quadros" / "alerta" / "rldd01_0.mov@2qps" / "q0000001.jpg"
    destino = recortes.destino(origem, tmp_path, tmp_path / "rostos" / "v1")
    assert destino == tmp_path / "rostos" / "v1" / "quadros" / "alerta" / "rldd01_0.mov@2qps" / "q0000001.jpg"


def test_pasta_muda_com_a_regra_do_recorte():
    # outra regra de recorte gera outra pasta, em vez de reaproveitar recortes antigos
    assert recortes.versao() == "fator1.4-max448"


@tem_dados
def test_recorta_o_rosto_e_marca_a_imagem_sem_rosto(tmp_path):
    vazia = tmp_path / "vazia.jpg"
    cv2.imwrite(str(vazia), np.full((240, 320, 3), 90, np.uint8))
    destinos = [tmp_path / "saida" / "retrato.jpg", tmp_path / "saida" / "vazia.jpg"]

    assert recortes.recortar([RETRATO, vazia], destinos, processos=1) == [True, False]

    recorte = cv2.imread(str(destinos[0]))
    assert recorte.shape[0] == recorte.shape[1] <= recortes.LADO_MAXIMO
    assert not destinos[1].exists() and recortes.sem_rosto(destinos[1]).exists()


@tem_dados
def test_recorte_e_o_mesmo_quadrado_da_analise(tmp_path):
    # mesma regra de entrada/classificador.py: o modelo vê no uso o que viu no treino
    imagem = cv2.imread(str(RETRATO))
    pontos = recortes.pontos_do_maior_rosto(imagem)
    x, y, lado = caixa_do_rosto(pontos, imagem.shape[1], imagem.shape[0])
    destino = tmp_path / "r.jpg"
    recortes.recortar([RETRATO], [destino], processos=1)
    esperado = cv2.resize(imagem[y:y + lado, x:x + lado], (min(lado, recortes.LADO_MAXIMO),) * 2,
                          interpolation=cv2.INTER_AREA)
    lido = cv2.imread(str(destino)).astype(int)
    assert lido.shape == esperado.shape and np.abs(lido - esperado).mean() < 3   # só a perda do JPEG


@tem_dados
def test_segunda_vez_usa_os_recortes_salvos(tmp_path):
    copia = tmp_path / "retrato.jpg"
    copia.write_bytes(RETRATO.read_bytes())
    destino = tmp_path / "saida" / "retrato.jpg"
    recortes.recortar([copia], [destino], processos=1)
    copia.unlink()   # sem a origem, só o recorte salvo responde
    assert recortes.recortar([copia], [destino], processos=1) == [True]
