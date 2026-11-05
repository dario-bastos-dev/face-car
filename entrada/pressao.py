"""Sensor de pressão FSR402 lido pela serial, e a junção dele com o modelo de imagens.

O sensor chega por um microcontrolador (por exemplo, um Arduino com
Serial.println(analogRead(A0))), um número por linha. Pressão abaixo do limiar
(400) é sinal de sonolência, como a mão que afrouxa no volante; 400 ou mais é
sinal de alerta. A junção pondera a probabilidade média de "sonolento" do modelo
com a fração de leituras baixas do sensor na mesma janela de tempo.
"""

import re
import threading
from collections import deque

from entrada.contexto import numero


def ler_pressao(linha) -> int | None:
    """Primeiro número inteiro da linha (bytes ou texto), ou None se não houver."""
    if isinstance(linha, bytes):
        linha = linha.decode("ascii", errors="ignore")
    achado = re.search(r"\d+", linha)
    return int(achado.group()) if achado else None


def fracao_abaixo(valores, limiar: int) -> float | None:
    """Fração das leituras abaixo do limiar, ou None sem leituras."""
    valores = list(valores)
    if not valores:
        return None
    return sum(v < limiar for v in valores) / len(valores)


class SensorPressao:
    """Lê a serial numa thread e guarda as leituras recentes com o instante de cada uma.

    `relogio_ms` deve ser o mesmo relógio das câmeras, para as leituras se compararem
    com o t_ms dos quadros. Linhas sem número são ignoradas. Se a porta cair (cabo
    desconectado), a thread para e `ativo` vira False; a análise segue sem o sensor.
    """

    def __init__(self, porta: str, baud: int, relogio_ms, abrir=None, max_leituras: int = 2000):
        if abrir is None:
            import serial
            abrir = serial.serial_for_url
        self._serial = abrir(porta, baud, timeout=0.1)   # SerialException é um OSError
        # O que chegou antes de abrir é antigo: um Arduino envia desde que liga.
        self._serial.reset_input_buffer()
        self._relogio_ms = relogio_ms
        self._leituras = deque(maxlen=max_leituras)
        self._trava = threading.Lock()
        self._rodando = True
        self._thread = threading.Thread(target=self._ler, name="sensor-pressao", daemon=True)
        self._thread.start()

    def _ler(self) -> None:
        # Só esta thread usa a porta, inclusive para fechá-la, como na webcam.
        try:
            # A 1ª linha pode ter começado antes da limpeza do buffer e vir pela metade
            # ("0" de um "800"), o que seria uma falsa pressão baixa: é descartada.
            self._serial.readline()
            while self._rodando:
                valor = ler_pressao(self._serial.readline())
                if valor is not None:
                    with self._trava:
                        self._leituras.append((int(self._relogio_ms()), valor))
        except OSError:
            pass   # porta caiu: o sensor fica inativo
        finally:
            self._rodando = False
            self._serial.close()

    def leituras_desde(self, t_ms: int) -> list:
        """(t_ms, valor) das leituras a partir do instante dado."""
        with self._trava:
            return [(t, v) for t, v in self._leituras if t >= t_ms]

    @property
    def ultima(self):
        with self._trava:
            return self._leituras[-1] if self._leituras else None

    @property
    def ativo(self) -> bool:
        return self._rodando

    def fechar(self, timeout: float = 1.0) -> None:
        self._rodando = False
        self._thread.join(timeout=timeout)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.fechar()


class Fusao:
    """Índice de sonolência de 0 a 1 a partir do modelo e do sensor, com alerta e histerese.

    O índice é a média ponderada da probabilidade de "sonolento" do modelo e da fração
    de leituras baixas do sensor; sem sensor, é só o modelo. O alerta começa quando o
    índice chega a `limiar_alerta` e só termina abaixo de `limiar_fim_alerta`, para não
    ficar ligando e desligando perto do limiar.
    """

    def __init__(self, peso_modelo: float, peso_sensor: float, limiar_alerta: float,
                 limiar_fim_alerta: float):
        self.peso_modelo = peso_modelo
        self.peso_sensor = peso_sensor
        self.limiar_alerta = limiar_alerta
        self.limiar_fim_alerta = limiar_fim_alerta
        self.em_alerta = False
        self.indice = None

    def atualizar(self, p_sono_modelo: float, fracao_sensor: float | None):
        """(índice, eventos de alerta) deste quadro."""
        if fracao_sensor is None:
            indice = p_sono_modelo
        else:
            indice = ((self.peso_modelo * p_sono_modelo + self.peso_sensor * fracao_sensor)
                      / (self.peso_modelo + self.peso_sensor))
        self.indice = indice
        eventos = []
        if not self.em_alerta and indice >= self.limiar_alerta:
            self.em_alerta = True
            volante = "" if fracao_sensor is None else f", volante {numero(fracao_sensor, '.2f')}"
            eventos.append(f"ALERTA de sonolência (índice {numero(indice, '.2f')}: "
                           f"modelo {numero(p_sono_modelo, '.2f')}{volante})")
        elif self.em_alerta and indice < self.limiar_fim_alerta:
            self.em_alerta = False
            eventos.append(f"fim do alerta de sonolência (índice {numero(indice, '.2f')})")
        return indice, eventos

    def pausar(self) -> None:
        """Motorista fora da câmera: sem análise nem alerta; ao voltar, avalia do zero."""
        self.em_alerta = False
        self.indice = None
