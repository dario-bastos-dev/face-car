"""Sensor de pressão FSR402 lido pela serial, e a junção dele com o modelo de imagens.

O sensor chega por um microcontrolador (por exemplo, um Arduino com
Serial.println(analogRead(A0))), um número por linha, a 115200 baud. Pressão abaixo do limiar
(400) é sinal de sonolência, como a mão que afrouxa no volante; 400 ou mais é
sinal de alerta. Como na cabeça baixa, só a pressão baixa por muito tempo (15 s
seguidos) conta: soltar a mão por pouco tempo, para trocar a marcha, é normal. A junção
parte da probabilidade média de "sonolento" do modelo e soma um bônus para o volante
frouxo e outro para a cabeça baixa.
"""

import re
import threading
from collections import deque

from entrada.contexto import numero

# Limite de bytes por linha: com bytes soltos sem '\n' (velocidade errada, ruído), um
# readline() sem limite esperaria a quebra de linha para sempre e o sensor ficaria mudo.
TAMANHO_MAX_LINHA = 32


def ler_pressao(linha) -> int | None:
    """Primeiro número inteiro da linha (bytes ou texto), ou None se não houver."""
    if isinstance(linha, bytes):
        linha = linha.decode("ascii", errors="ignore")
    achado = re.search(r"\d+", linha)
    return int(achado.group()) if achado else None


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
            self._serial.readline(TAMANHO_MAX_LINHA)
            while self._rodando:
                valor = ler_pressao(self._serial.readline(TAMANHO_MAX_LINHA))
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


def _duracao(ms: float) -> str:
    return f"{numero(ms / 1000, '.2f')} s"


class PressaoBaixa:
    """Acompanha há quanto tempo a pressão no volante está abaixo do limiar, sem interrupção.

    Recebe as leituras (t_ms, valor) do sensor e usa cada uma só uma vez. Avisa quando a
    pressão fica baixa por `alerta_ms` e de novo quando o volante volta a ser apertado.
    """

    def __init__(self, limiar: int, alerta_ms: int):
        self.limiar = limiar
        self.alerta_ms = alerta_ms
        self.reiniciar()

    def reiniciar(self, t_ms: int = -1) -> None:
        """Esquece a contagem e as leituras até `t_ms` (motorista fora da câmera, sensor mudo)."""
        self._baixa_desde = None
        self._alertou = False
        self._ultima_t = t_ms

    def atualizar(self, leituras, t_ms: int) -> tuple[int | None, list]:
        """(há quantos ms a pressão está baixa, ou None; eventos) até o instante `t_ms`."""
        eventos = []
        for t, valor in leituras:
            if t <= self._ultima_t:
                continue   # já contada no quadro anterior
            self._ultima_t = t
            if valor < self.limiar:
                if self._baixa_desde is None:
                    self._baixa_desde = t
            elif self._baixa_desde is not None:
                if self._alertou:
                    eventos.append(f"volante apertado de novo após {_duracao(t - self._baixa_desde)}")
                self._baixa_desde = None
                self._alertou = False
        if self._baixa_desde is None:
            return None, eventos
        duracao = max(0, t_ms - self._baixa_desde)
        if not self._alertou and duracao >= self.alerta_ms:
            self._alertou = True
            eventos.append(f"pressão no volante abaixo de {self.limiar} há mais de "
                           f"{numero(self.alerta_ms / 1000, 'g')} s")
        return duracao, eventos

    def prolongada(self, duracao: int | None) -> bool:
        return duracao is not None and duracao >= self.alerta_ms


class Fusao:
    """Índice de sonolência de 0 a 1 a partir do modelo, do volante e da cabeça, com alerta.

    O índice é a probabilidade média de "sonolento" do modelo, mais `bonus_volante_frouxo`
    com a pressão baixa por muito tempo e `bonus_cabeca_baixa` com a cabeça baixa por
    muito tempo; não passa de 1. O alerta começa quando o índice chega a `limiar_alerta` e
    só termina abaixo de `limiar_fim_alerta`, para não ficar ligando e desligando perto do
    limiar.
    """

    def __init__(self, limiar_alerta: float, limiar_fim_alerta: float,
                 bonus_volante_frouxo: float = 0.0, bonus_cabeca_baixa: float = 0.0):
        self.limiar_alerta = limiar_alerta
        self.limiar_fim_alerta = limiar_fim_alerta
        self.bonus_volante_frouxo = bonus_volante_frouxo
        self.bonus_cabeca_baixa = bonus_cabeca_baixa
        self.em_alerta = False
        self.indice = None

    def bonus(self, volante_frouxo: bool = False, cabeca_baixa: bool = False) -> tuple[float, float]:
        """(bônus do volante, bônus da cabeça) aplicados nesse caso."""
        return (self.bonus_volante_frouxo if volante_frouxo else 0.0,
                self.bonus_cabeca_baixa if cabeca_baixa else 0.0)

    def atualizar(self, p_sono_modelo: float, volante_frouxo: bool = False,
                  cabeca_baixa: bool = False):
        """(índice, eventos de alerta) deste quadro."""
        volante, cabeca = self.bonus(volante_frouxo, cabeca_baixa)
        indice = min(1.0, p_sono_modelo + volante + cabeca)
        self.indice = indice
        eventos = []
        if not self.em_alerta and indice >= self.limiar_alerta:
            self.em_alerta = True
            motivos = [f"modelo {numero(p_sono_modelo, '.2f')}"]
            if volante:
                motivos.append(f"volante frouxo +{numero(volante, '.2f')}")
            if cabeca:
                motivos.append(f"cabeça baixa +{numero(cabeca, '.2f')}")
            eventos.append(f"ALERTA de sonolência (índice {numero(indice, '.2f')}: "
                           f"{', '.join(motivos)})")
        elif self.em_alerta and indice < self.limiar_fim_alerta:
            self.em_alerta = False
            eventos.append(f"fim do alerta de sonolência (índice {numero(indice, '.2f')})")
        return indice, eventos

    def pausar(self) -> None:
        """Motorista fora da câmera: sem análise nem alerta; ao voltar, avalia do zero."""
        self.em_alerta = False
        self.indice = None
