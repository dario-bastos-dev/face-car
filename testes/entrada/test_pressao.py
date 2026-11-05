"""Sensor de pressão FSR402 pela serial e junção com o modelo de imagens, sem hardware.

A porta virtual loop:// do pyserial devolve o que for escrito nela, como um Arduino.
"""

import time

import pytest

from entrada.pressao import Fusao, SensorPressao, fracao_abaixo, ler_pressao


@pytest.mark.parametrize("linha, esperado", [
    (b"523\r\n", 523),
    (b"398\n", 398),
    (b"FSR: 1023\r\n", 1023),     # aceita texto antes do número
    (b"  0 \r\n", 0),
    (b"\r\n", None),
    (b"sem numero\r\n", None),
    (b"\xff\xfe12\r\n", 12),      # lixo de inicialização da serial
])
def test_ler_pressao(linha, esperado):
    assert ler_pressao(linha) == esperado


def test_fracao_abaixo_do_limiar():
    assert fracao_abaixo([500, 300, 399, 400, 800], limiar=400) == pytest.approx(2 / 5)
    assert fracao_abaixo([], limiar=400) is None


def esperar(condicao, limite=2.0):
    fim = time.monotonic() + limite
    while time.monotonic() < fim and not condicao():
        time.sleep(0.01)
    return condicao()


def test_sensor_le_a_serial_em_segundo_plano():
    import serial

    porta = serial.serial_for_url("loop://", 9600, timeout=0.05)
    relogio = iter(range(0, 10_000, 100))
    with SensorPressao("loop://", 9600, relogio_ms=lambda: next(relogio),
                       abrir=lambda *_a, **_k: porta) as sensor:
        porta.write(b"descartada\r\n523\r\nlixo\r\n398\r\n")
        assert esperar(lambda: len(sensor.leituras_desde(0)) == 2)
        assert [v for _, v in sensor.leituras_desde(0)] == [523, 398]
        assert sensor.ultima[1] == 398
        assert [v for _, v in sensor.leituras_desde(100)] == [398]   # só as recentes


def test_sensor_ausente_da_erro_de_porta():
    with pytest.raises(OSError):
        SensorPressao("/dev/nao_existe_fsr402", 9600, relogio_ms=lambda: 0)


PARAMS = dict(peso_modelo=0.6, peso_sensor=0.4, limiar_alerta=0.6, limiar_fim_alerta=0.4)


def test_fusao_pondera_modelo_e_volante():
    fusao = Fusao(**PARAMS)
    indice, eventos = fusao.atualizar(p_sono_modelo=0.5, fracao_sensor=1.0)
    assert indice == pytest.approx(0.6 * 0.5 + 0.4 * 1.0)
    assert eventos == ["ALERTA de sonolência (índice 0,70: modelo 0,50, volante 1,00)"]


def test_fusao_sem_sensor_usa_so_o_modelo():
    fusao = Fusao(**PARAMS)
    indice, eventos = fusao.atualizar(p_sono_modelo=0.3, fracao_sensor=None)
    assert indice == pytest.approx(0.3) and eventos == []


def test_fusao_tem_histerese():
    fusao = Fusao(**PARAMS)
    sequencia = [(0.9, 1.0), (0.5, 0.5), (0.45, 0.4), (0.2, 0.0), (0.5, 0.5)]
    resultados = [fusao.atualizar(m, s) for m, s in sequencia]
    eventos = [e for _, ev in resultados for e in ev]
    # entra a 0,94; segue a 0,50 e 0,43 (acima de 0,4); sai a 0,12; não volta a 0,50
    assert [e.split(" (")[0] for e in eventos] == ["ALERTA de sonolência", "fim do alerta de sonolência"]
    assert fusao.em_alerta is False


def test_fusao_pausada_nao_gera_alerta_e_recomeca():
    fusao = Fusao(**PARAMS)
    fusao.atualizar(0.9, 1.0)
    assert fusao.em_alerta
    fusao.pausar()   # motorista saiu da câmera: nenhum alerta, nem de fim
    assert fusao.em_alerta is False
    _, eventos = fusao.atualizar(0.9, 1.0)
    assert eventos[0].startswith("ALERTA")   # ao voltar, avalia do zero


def test_configuracao_do_sensor_e_da_fusao():
    from entrada.contexto import carregar_config
    config = carregar_config()
    assert config["sensor"]["limiar_sonolencia"] == 400
    Fusao(**config["fusao"])


def test_leituras_de_antes_de_abrir_a_porta_sao_descartadas():
    # Um Arduino envia desde que liga: o que ficou no buffer antes da análise abrir a porta
    # é antigo e não pode entrar como leitura atual.
    import serial

    porta = serial.serial_for_url("loop://", 9600, timeout=0.05)
    porta.write(b"100\r\n100\r\n100\r\n")          # chegou antes de o sensor abrir
    with SensorPressao("loop://", 9600, relogio_ms=lambda: 0,
                       abrir=lambda *_a, **_k: porta) as sensor:
        # A 1ª linha depois de abrir pode estar pela metade ("0" de um "800") e é descartada.
        porta.write(b"0\r\n700\r\n")
        assert esperar(lambda: len(sensor.leituras_desde(0)) >= 1)
        time.sleep(0.1)
        assert [v for _, v in sensor.leituras_desde(0)] == [700]


def test_lixo_sem_quebra_de_linha_nao_trava_o_sensor():
    # Com a velocidade errada chegam bytes soltos (0xFF) sem '\n'; o readline() sem limite
    # esperaria a quebra de linha para sempre, e o sensor ficaria mudo.
    import serial

    porta = serial.serial_for_url("loop://", 115200, timeout=0.05)
    with SensorPressao("loop://", 115200, relogio_ms=lambda: 0,
                       abrir=lambda *_a, **_k: porta) as sensor:
        porta.write(b"\xff" * 40 + b"523\r\n")
        assert esperar(lambda: len(sensor.leituras_desde(0)) >= 1)
        assert sensor.leituras_desde(0)[0][1] == 523


def test_configuracao_usa_a_velocidade_do_arduino():
    from entrada.contexto import carregar_config
    assert carregar_config()["sensor"]["baud"] == 115200
