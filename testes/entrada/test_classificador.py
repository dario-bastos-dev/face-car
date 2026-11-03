import numpy as np
import pytest

from entrada.classificador import ClassificadorSonolencia, Resultado, formatar, preparar
from entrada.contexto import RAIZ

CLASSES = ["sonolento", "alerta"]


class ModeloFalso:
    """Imita um modelo Keras: guarda a entrada e devolve probabilidades fixas."""

    input_shape = (None, 96, 96, 3)
    output_shape = (None, 2)

    def __init__(self, probabilidades=(0.2, 0.8)):
        self.probabilidades = np.array([probabilidades], dtype="float32")
        self.recebido = None

    def __call__(self, x, training=False):
        assert training is False
        self.recebido = np.asarray(x)
        return self.probabilidades


def test_preparar_redimensiona_o_quadro_inteiro_e_converte_para_rgb():
    quadro = np.zeros((480, 640, 3), np.uint8)
    quadro[..., 0] = 255  # azul em BGR
    x = preparar(quadro, 96)
    assert x.shape == (1, 96, 96, 3) and x.dtype == np.float32
    assert (x[0, ..., 2] == 255).all() and (x[0, ..., 0] == 0).all()  # azul no canal B do RGB


def test_preparar_mantem_os_valores_de_0_a_255():
    # O próprio modelo normaliza (camada Rescaling); a entrada vai em pixels.
    quadro = np.full((50, 70, 3), 200, np.uint8)
    assert preparar(quadro, 96).max() == pytest.approx(200)


def test_classificar_devolve_a_classe_mais_provavel():
    modelo = ModeloFalso((0.2, 0.8))
    c = ClassificadorSonolencia(CLASSES, modelo=modelo)
    r = c.classificar(np.zeros((480, 640, 3), np.uint8))
    assert r.classe == "alerta"
    assert r.probabilidades == pytest.approx({"sonolento": 0.2, "alerta": 0.8})
    assert modelo.recebido.shape == (1, 96, 96, 3)


def test_classes_precisam_bater_com_a_saida_do_modelo():
    with pytest.raises(ValueError, match="2 saídas"):
        ClassificadorSonolencia(["a", "b", "c"], modelo=ModeloFalso())


def test_formatar_em_portugues():
    r = Resultado("sonolento", {"sonolento": 0.9134, "alerta": 0.0866})
    assert formatar(r) == "sonolento 91,3%  (alerta 8,7%)"


MODELO_REAL = RAIZ / "cnn_sonolencia.keras"


@pytest.mark.skipif(not MODELO_REAL.exists(), reason="cnn_sonolencia.keras não está na raiz")
def test_modelo_real_carrega_e_preve():
    c = ClassificadorSonolencia.carregar(MODELO_REAL, CLASSES)
    r = c.classificar(np.full((480, 640, 3), 128, np.uint8))
    assert r.classe in CLASSES
    assert sum(r.probabilidades.values()) == pytest.approx(1, abs=1e-4)
