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



# --- limite de fotos -----------------------------------------------------------

import os

from entrada.captura import RetencaoImagens


def foto():
    return np.full((16, 16, 3), 100, np.uint8)


def jpgs(raiz):
    return sorted(p.relative_to(raiz).as_posix() for p in raiz.rglob("*.jpg"))


def test_ao_chegar_no_limite_apaga_a_mais_antiga(tmp_path):
    retencao = RetencaoImagens(tmp_path, limite=3)
    g = GravadorImagens(tmp_path, "rgb", "alerta", "p01", "s", retencao=retencao)
    for t in range(5):
        g.salvar(foto(), t * 1000)
    assert jpgs(tmp_path) == [f"rgb/alerta/p01_s_00000{t}000ms.jpg" for t in (2, 3, 4)]
    assert retencao.apagadas == 2


def test_limite_vale_para_todas_as_cameras_juntas(tmp_path):
    retencao = RetencaoImagens(tmp_path, limite=4)
    rgb = GravadorImagens(tmp_path, "rgb", "alerta", "p01", "s", retencao=retencao)
    ir = GravadorImagens(tmp_path, "ir", "alerta", "p01", "s", retencao=retencao)
    for t in range(4):
        rgb.salvar(foto(), t * 1000)
        ir.salvar(foto(), t * 1000 + 500)
    assert len(jpgs(tmp_path)) == 4
    assert jpgs(tmp_path)[0] == "ir/alerta/p01_s_000002500ms.jpg"  # as 4 mais novas


def test_fotos_de_sessoes_anteriores_entram_na_conta(tmp_path):
    antigas = tmp_path / "rgb" / "sonolento"
    antigas.mkdir(parents=True)
    for n in range(3):
        caminho = antigas / f"p02_antiga_00000000{n}ms.jpg"
        caminho.write_bytes(b"x")
        os.utime(caminho, (1_000_000 + n, 1_000_000 + n))  # mais velhas que as novas
    retencao = RetencaoImagens(tmp_path, limite=3)
    GravadorImagens(tmp_path, "rgb", "alerta", "p01", "s", retencao=retencao).salvar(foto(), 0)
    assert jpgs(tmp_path) == ["rgb/alerta/p01_s_000000000ms.jpg",
                              "rgb/sonolento/p02_antiga_000000001ms.jpg",
                              "rgb/sonolento/p02_antiga_000000002ms.jpg"]


def test_nunca_apaga_arquivos_que_a_captura_nao_gerou(tmp_path):
    pasta = tmp_path / "rgb" / "alerta"
    pasta.mkdir(parents=True)
    estranhos = [pasta / "minha_foto.jpg", pasta / "notas.txt", tmp_path / "solta.jpg"]
    for p in estranhos:
        p.write_bytes(b"x")
        os.utime(p, (1_000, 1_000))
    retencao = RetencaoImagens(tmp_path, limite=1)
    g = GravadorImagens(tmp_path, "rgb", "alerta", "p01", "s", retencao=retencao)
    for t in range(3):
        g.salvar(foto(), t)
    assert all(p.exists() for p in estranhos)
    assert len([p for p in pasta.glob("p01_*.jpg")]) == 1


def test_regravar_o_mesmo_arquivo_nao_apaga_outro(tmp_path):
    retencao = RetencaoImagens(tmp_path, limite=2)
    g = GravadorImagens(tmp_path, "rgb", "alerta", "p01", "s", retencao=retencao)
    g.salvar(foto(), 0)
    g.salvar(foto(), 1000)
    g.salvar(foto(), 1000)  # mesmo nome (ex.: o mesmo vídeo processado de novo)
    assert len(jpgs(tmp_path)) == 2 and retencao.apagadas == 0


def test_limite_precisa_ser_positivo(tmp_path):
    with pytest.raises(ValueError):
        RetencaoImagens(tmp_path, limite=0)
