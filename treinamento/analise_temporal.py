"""Estrutura inicial para eventos temporais baseados no contrato do MediaPipe.

Nao gera alerta clinico nem treina modelo. Apenas prepara sinais auditaveis para
uma futura camada de fusao: piscadas, PERCLOS, bocejos e queda de cabeca.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from entrada.contrato import RegistroMetricas


@dataclass(frozen=True)
class ConfigTemporal:
    janela_ms: int = 60_000
    ear_fechado: float = 0.20
    fechamento_min_ms: int = 250
    pitch_queda_graus: float = 12.0
    pitch_velocidade_graus_s: float = 35.0
    pitch_recuperacao_graus: float = 8.0
    abertura_boca_bocejando: float = 0.45


@dataclass(frozen=True)
class EventoTemporal:
    tipo: str
    inicio_ms: int
    fim_ms: int
    confianca: float


def perclos(registros: Iterable[RegistroMetricas], inicio_ms: int, fim_ms: int, config: ConfigTemporal = ConfigTemporal()) -> float | None:
    pontos = [r for r in registros if inicio_ms <= r.t_ms <= fim_ms and r.rosto_visivel and r.ear_esq is not None and r.ear_dir is not None]
    if not pontos or fim_ms <= inicio_ms:
        return None
    fechados = sum((r.ear_esq + r.ear_dir) / 2 <= config.ear_fechado for r in pontos)
    return fechados / len(pontos)


def variacao_pitch(anterior: RegistroMetricas, atual: RegistroMetricas) -> float | None:
    if anterior.pitch is None or atual.pitch is None or atual.t_ms <= anterior.t_ms:
        return None
    return (atual.pitch - anterior.pitch) / ((atual.t_ms - anterior.t_ms) / 1000)


def preparar_sinais(registros: Iterable[RegistroMetricas]) -> list[dict[str, float | int | None]]:
    """Converte registros em pontos para futura máquina de estados temporal."""
    pontos = list(registros)
    saida = []
    for anterior, atual in zip(pontos, pontos[1:]):
        saida.append({"t_ms": atual.t_ms, "ear": None if atual.ear_esq is None or atual.ear_dir is None else (atual.ear_esq + atual.ear_dir) / 2, "boca": atual.abertura_boca, "pitch": atual.pitch, "velocidade_pitch": variacao_pitch(anterior, atual), "confianca": atual.confianca})
    return saida
