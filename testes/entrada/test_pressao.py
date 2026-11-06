"""Sensor de pressão FSR402 pela serial e junção com o modelo de imagens, sem hardware.

A porta virtual loop:// do pyserial devolve o que for escrito nela, como um Arduino.
"""

import time

import pytest

from entrada.pressao import Fusao, PressaoBaixa, SensorPressao, ler_pressao


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


PARAMS = dict(limiar_alerta=0.6, limiar_fim_alerta=0.4, bonus_volante_frouxo=0.3,
              bonus_cabeca_baixa=0.3)


def test_fusao_soma_os_bonus_ao_modelo():
    fusao = Fusao(**PARAMS)
    assert fusao.atualizar(0.2) == (pytest.approx(0.2), [])
    assert fusao.atualizar(0.2, volante_frouxo=True)[0] == pytest.approx(0.5)
    assert fusao.atualizar(0.2, cabeca_baixa=True)[0] == pytest.approx(0.5)
    indice, eventos = fusao.atualizar(0.2, volante_frouxo=True, cabeca_baixa=True)
    assert indice == pytest.approx(0.8)   # volante frouxo e cabeça baixa: alerta mesmo com o modelo em 0,2
    assert eventos == ["ALERTA de sonolência (índice 0,80: modelo 0,20, volante frouxo +0,30, "
                       "cabeça baixa +0,30)"]


def test_fusao_volante_frouxo_com_o_modelo_em_duvida_alerta():
    fusao = Fusao(**PARAMS)
    indice, eventos = fusao.atualizar(0.3, volante_frouxo=True)
    assert indice == pytest.approx(0.6)
    assert eventos == ["ALERTA de sonolência (índice 0,60: modelo 0,30, volante frouxo +0,30)"]


def test_fusao_sem_bonus_usa_so_o_modelo_e_nao_passa_de_1():
    assert Fusao(**PARAMS).atualizar(0.3) == (pytest.approx(0.3), [])
    assert Fusao(**PARAMS).atualizar(0.95, True, True)[0] == pytest.approx(1.0)


def test_fusao_tem_histerese():
    fusao = Fusao(**PARAMS)
    sequencia = [0.9, 0.5, 0.43, 0.12, 0.5]
    eventos = [e for m in sequencia for e in fusao.atualizar(m)[1]]
    # entra a 0,9; segue a 0,50 e 0,43 (acima de 0,4); sai a 0,12; não volta a 0,50
    assert [e.split(" (")[0] for e in eventos] == ["ALERTA de sonolência", "fim do alerta de sonolência"]
    assert fusao.em_alerta is False


def test_fusao_pausada_nao_gera_alerta_e_recomeca():
    fusao = Fusao(**PARAMS)
    fusao.atualizar(0.9)
    assert fusao.em_alerta
    fusao.pausar()   # motorista saiu da câmera: nenhum alerta, nem de fim
    assert fusao.em_alerta is False
    _, eventos = fusao.atualizar(0.9)
    assert eventos[0].startswith("ALERTA")   # ao voltar, avalia do zero


def test_configuracao_do_sensor_e_da_fusao():
    from entrada.contexto import carregar_config
    config = carregar_config()
    assert config["sensor"]["limiar_sonolencia"] == 400
    assert config["sensor"]["pressao_baixa_alerta_ms"] == 15000
    Fusao(**config["fusao"])


# ---- pressão baixa por muito tempo -----------------------------------------

def leituras(inicio, fim, valor, passo=50):
    return [(t, valor) for t in range(inicio, fim, passo)]


def test_pressao_baixa_por_pouco_tempo_nao_conta():
    baixa = PressaoBaixa(limiar=400, alerta_ms=15000)
    duracao, eventos = baixa.atualizar(leituras(0, 5000, 100), 5000)   # 5 s com a mão solta
    assert duracao == 5000 and eventos == [] and not baixa.prolongada(duracao)
    duracao, eventos = baixa.atualizar(leituras(5000, 6000, 800), 6000)  # apertou de novo
    assert duracao is None and eventos == []


def test_pressao_baixa_por_15_s_avisa_e_ao_apertar_de_novo():
    baixa = PressaoBaixa(limiar=400, alerta_ms=15000)
    eventos = []
    for segundo in range(0, 17):   # um quadro por segundo, com as leituras desse segundo
        duracao, ev = baixa.atualizar(leituras(segundo * 1000, (segundo + 1) * 1000, 120),
                                      (segundo + 1) * 1000)
        eventos += [(segundo + 1, e) for e in ev]
    assert baixa.prolongada(duracao) and duracao == 17000
    _, ev = baixa.atualizar([(17000, 120), (17300, 650)], 17300)
    eventos += [(17.3, e) for e in ev]
    assert eventos == [(15, "pressão no volante abaixo de 400 há mais de 15 s"),
                       (17.3, "volante apertado de novo após 17,30 s")]


def test_um_aperto_no_meio_recomeca_a_contagem():
    baixa = PressaoBaixa(limiar=400, alerta_ms=15000)
    baixa.atualizar(leituras(0, 10000, 100) + [(10000, 400)], 10000)   # 400 já é alerta
    duracao, _ = baixa.atualizar(leituras(10050, 20000, 100), 20000)
    assert duracao == 9950 and not baixa.prolongada(duracao)


def test_leituras_repetidas_contam_uma_vez_e_reiniciar_esquece():
    baixa = PressaoBaixa(limiar=400, alerta_ms=1000)
    janela = leituras(0, 2000, 100)
    baixa.atualizar(janela, 2000)
    assert baixa.atualizar(janela, 2000)[1] == []                # mesma janela: sem aviso repetido
    baixa.reiniciar(2000)
    assert baixa.atualizar(janela, 2500) == (None, [])           # leituras antigas são ignoradas


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
