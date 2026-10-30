"""Estimativa de sonolência a partir de métricas, independente de câmera."""

from .config import carregar_config
from .nucleo import estimar

__all__ = ["carregar_config", "estimar"]
