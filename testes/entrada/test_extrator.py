"""Integração com o MediaPipe sobre o vídeo sintético de scripts/preparar.sh."""

import json

import pytest

from entrada.contrato import RAIZ

VIDEO = RAIZ / "testes" / "dados" / "retrato.mp4"
MODELO = RAIZ / "modelos" / "face_landmarker.task"

pytestmark = pytest.mark.skipif(
    not (VIDEO.exists() and MODELO.exists()),
    reason="rode scripts/preparar.sh para baixar o modelo e gerar o vídeo",
)


@pytest.fixture(scope="module")
def registros():
    from entrada.extrator import ExtratorVideo
    from entrada.fontes import FonteArquivo

    config = json.loads((RAIZ / "config" / "extrator.json").read_text())
    with FonteArquivo(VIDEO) as fonte, ExtratorVideo(config) as extrator:
        return [extrator.processar(q, t, i) for q, t, i in fonte]


def test_um_registro_por_quadro(registros):
    assert [r.quadro for r in registros] == list(range(120))
    assert registros[30].t_ms == 1000


def test_rosto_ausente_na_tela_preta(registros):
    # O vídeo fica preto entre 1 s e 1,5 s (quadros 30 a 45).
    for r in registros[30:46]:
        assert not r.rosto_visivel and r.confianca == 0 and r.ear_esq is None
    assert all(r.rosto_visivel for r in registros[:30] + registros[46:])


def test_metricas_plausiveis(registros):
    for r in (r for r in registros if r.rosto_visivel):
        assert 0.1 < r.ear_esq < 0.45 and 0.1 < r.ear_dir < 0.45
        assert 0 <= r.abertura_boca < 1
        assert 0 <= r.confianca <= 1


def test_confianca_reinicia_ao_reencontrar_o_rosto(registros):
    assert registros[0].confianca == 0.5
    assert registros[46].confianca == 0.5
    assert registros[29].confianca > 0.9  # imagem parada: pontos estáveis


def test_roll_acompanha_a_rotacao(registros):
    # Entre 2 e 4 s a imagem gira 0,35·sin(2π(t-2)/2) rad no sentido horário,
    # máximo horário em t=2,5 s (quadro 75) e anti-horário em t=3,5 s (quadro 105).
    base = registros[10].roll
    assert registros[75].roll - base < -15
    assert registros[105].roll - base > 15


def test_modo_ao_vivo_em_tempo_real():
    """Envia o vídeo a 30 q/s ao modo assíncrono, como faria a webcam."""
    import threading
    import time

    from entrada.extrator import ExtratorAoVivo
    from entrada.fontes import FonteArquivo

    config = json.loads((RAIZ / "config" / "extrator.json").read_text())
    t0 = time.monotonic()
    relogio = lambda: (time.monotonic() - t0) * 1000
    recebidos, trava = [], threading.Lock()

    def ao_registrar(r):
        with trava:
            recebidos.append(r)

    with FonteArquivo(VIDEO) as fonte, ExtratorAoVivo(config, ao_registrar, relogio) as extrator:
        for quadro, _, indice in fonte:
            extrator.enviar(quadro, int(relogio()), indice)
            time.sleep(1 / 30)
        time.sleep(0.5)

    assert 0 < len(recebidos) <= 120
    ts = [r.t_ms for r in recebidos]
    assert ts == sorted(ts) and len(set(ts)) == len(ts)
    assert all(r.quadro >= 0 and r.atraso_ms > 0 for r in recebidos)
    # A tela preta (quadros 30 a 45) continua sem rosto no modo ao vivo.
    assert all(not r.rosto_visivel for r in recebidos if 30 <= r.quadro <= 45)
