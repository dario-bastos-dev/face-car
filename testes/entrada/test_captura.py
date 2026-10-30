import cv2
import numpy as np
import pytest

from entrada.captura import Agendador, GravadorImagens, nome_seguro


def test_agendador_respeita_o_intervalo():
    ag = Agendador(1000)
    assert ag.pronto(0)
    ag.registrar(0)
    assert not ag.pronto(999)
    assert ag.pronto(1000)
    ag.registrar(1533)  # a captura atrasou (sem rosto): o próximo conta a partir dela
    assert not ag.pronto(2500)
    assert ag.pronto(2533)


def test_gravador_salva_jpeg_na_pasta_do_rotulo(tmp_path):
    g = GravadorImagens(tmp_path, camera="ir", rotulo="sonolento", pessoa="p01", origem="video_a")
    img = np.full((224, 224, 3), 128, np.uint8)
    caminho = g.salvar(img, 1533)
    assert caminho == tmp_path / "ir" / "sonolento" / "p01_video_a_000001533ms.jpg"
    lida = cv2.imread(str(caminho))
    assert lida.shape == (224, 224, 3) and abs(int(lida.mean()) - 128) <= 2
    assert g.total == 1


@pytest.mark.parametrize("campo", ["camera", "rotulo", "pessoa"])
@pytest.mark.parametrize("valor", ["../fora", "a/b", "", "com espaço"])
def test_gravador_recusa_nomes_que_viram_caminhos(tmp_path, campo, valor):
    args = dict(camera="rgb", rotulo="alerta", pessoa="p01", origem="x")
    args[campo] = valor
    with pytest.raises(ValueError):
        GravadorImagens(tmp_path, **args)


def test_nome_seguro_limpa_a_origem():
    assert nome_seguro("Vídeo 01 (celular).mp4") == "V_deo_01__celular_.mp4"
    assert nome_seguro("../../x") == ".._.._x"

