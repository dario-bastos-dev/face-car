import numpy as np
import pytest

from entrada.classificador import (ClassificadorSonolencia, MediaTemporal, Resultado, formatar,
                                   formatar_saida, preparar)
from entrada.contexto import RAIZ

CLASSES = ["sonolento", "alerta"]


class ModeloFalso:
    """Imita um modelo Keras: guarda a entrada e devolve probabilidades fixas."""

    input_shape = (None, 96, 96, 3)
    output_shape = (None, 2)

    def __init__(self, probabilidades=(0.2, 0.8)):
        self.probabilidades = np.array([probabilidades], dtype="float32")
        self.recebido = None

    def predict_on_batch(self, x):
        # Em tempo real, predict_on_batch: ~22 ms por quadro contra ~160 ms de modelo(x).
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
def test_modelo_real_carrega_com_as_classes_da_configuracao_e_preve():
    from entrada.contexto import carregar_config

    classes = carregar_config()["classificador"]["classes"]
    c = ClassificadorSonolencia.carregar(MODELO_REAL, classes)   # confere saídas × classes
    r = c.classificar(np.full((480, 640, 3), 128, np.uint8))
    assert r.classe in classes and len(r.saida) == len(classes)
    assert sum(r.probabilidades.values()) == pytest.approx(1, abs=1e-4)


def test_configuracao_segue_a_ordem_de_saida_do_modelo():
    # FaceCar_CNN_V2 devolve, nesta ordem: alerta, sonolência e bocejo. Os nomes
    # "sonolento", "alerta" e "bocejo" são os que o simulador da Parte 3 usa.
    from entrada.contexto import carregar_config

    assert carregar_config()["classificador"]["classes"] == ["alerta", "sonolento", "bocejo"]


class ModeloTresSaidas(ModeloFalso):
    output_shape = (None, 3)


@pytest.mark.parametrize("saida, problema", [
    ((2.1, -0.4, 0.3), "entre 0 e 1"),   # valores brutos, sem softmax
    ((0.2, 0.3, 0.4), "somar 1"),        # soma 0,9
])
def test_saida_que_nao_e_probabilidade_da_erro_claro(saida, problema):
    c = ClassificadorSonolencia(["alerta", "sonolento", "bocejo"], modelo=ModeloTresSaidas(saida))
    with pytest.raises(ValueError, match=problema):
        c.classificar(np.zeros((480, 640, 3), np.uint8))


def test_saida_com_soma_1_e_aceita_com_tolerancia_de_arredondamento():
    c = ClassificadorSonolencia(["alerta", "sonolento", "bocejo"],
                                modelo=ModeloTresSaidas((0.7, 0.2, 0.1000004)))
    r = c.classificar(np.zeros((480, 640, 3), np.uint8))
    assert r.classe == "alerta" and r.saida == pytest.approx([0.7, 0.2, 0.1], abs=1e-5)


def test_formatar_com_tres_classes():
    r = Resultado("bocejo", {"sonolento": 0.05, "alerta": 0.15, "bocejo": 0.8},
                  saida=[0.05, 0.15, 0.8], ms=30)
    assert formatar(r) == "bocejo 80,0%  (sonolento 5,0%, alerta 15,0%)"
    assert formatar_saida(r) == "saída [0,0500 0,1500 0,8000] → bocejo (30 ms)"


def resultado(alerta):
    return Resultado("alerta" if alerta > 0.5 else "sonolento",
                     {"alerta": alerta, "sonolento": 1 - alerta})


def test_media_temporal_usa_so_a_janela_recente():
    media = MediaTemporal(janela_ms=2000)
    media.adicionar(0, resultado(1.0))      # sai da janela quando chega o de 2500 ms
    media.adicionar(1000, resultado(0.2))
    media.adicionar(2500, resultado(0.4))
    resumo, _ = media.resumo()
    assert resumo.classe == "sonolento"
    assert resumo.probabilidades == pytest.approx({"alerta": 0.3, "sonolento": 0.7})


def test_media_temporal_mede_quadros_por_segundo():
    media = MediaTemporal(janela_ms=2000)
    for t in range(0, 1001, 100):           # 11 quadros em 1 s
        media.adicionar(t, resultado(0.9))
    _, qps = media.resumo()
    assert qps == pytest.approx(10)


def test_media_temporal_vazia():
    assert MediaTemporal(janela_ms=2000).resumo() == (None, 0.0)


def test_resultado_guarda_a_saida_bruta_do_modelo_e_o_tempo():
    c = ClassificadorSonolencia(["alerta", "sonolento"], modelo=ModeloFalso((0.8125, 0.1875)))
    r = c.classificar(np.zeros((480, 640, 3), np.uint8))
    assert r.saida == pytest.approx([0.8125, 0.1875])   # exatamente o que o modelo devolveu
    assert r.ms is not None and r.ms >= 0


def test_formatar_saida_mostra_o_vetor_a_classe_e_o_tempo():
    r = Resultado("alerta", {"alerta": 0.98134, "sonolento": 0.01866}, saida=[0.98134, 0.01866], ms=21.6)
    assert formatar_saida(r) == "saída [0,9813 0,0187] → alerta (22 ms)"
