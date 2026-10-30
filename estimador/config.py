"""Leitura e validação dos parâmetros compartilhados com JavaScript."""

import json
import math
from pathlib import Path

PADRAO = Path(__file__).resolve().parent.parent / "config" / "estimador.json"


def numero(valor):
    return (isinstance(valor, (int, float)) and not isinstance(valor, bool)
            and (isinstance(valor, int) or math.isfinite(valor)))


def validar_config(config):
    if not isinstance(config, dict):
        raise ValueError("Configuração deve ser um objeto")
    def limite(obj, chave, minimo, maximo, estrito=False):
        v = obj.get(chave)
        if not numero(v) or v > maximo or (v <= minimo if estrito else v < minimo):
            raise ValueError(f"Parâmetro inválido: {chave}")

    limite(config, "janela_s", 0, 86400, True)
    janela = config["janela_s"] * 1000
    for nome in ("max_intervalo_ms", "min_evidencia_ms", "saturacao_fechamento_ms"):
        limite(config, nome, 0, janela, True)
    limite(config, "max_atraso_ms", 0, 86400000)
    limite(config, "min_fechamento_ms", 0, janela)
    limite(config, "confianca_rastreio_minima", 0, 1)
    olhos = config.get("olhos", {})
    if not isinstance(olhos, dict):
        raise ValueError("olhos deve ser um objeto")
    for lado in ("esq", "dir"):
        limite(olhos, f"ear_fechado_{lado}", 0, 1)
        limite(olhos, f"ear_aberto_{lado}", olhos[f"ear_fechado_{lado}"], 1, True)
    limite(olhos, "fechamento_limiar", 0, 1, True)
    return config


def carregar_config(caminho=PADRAO):
    return validar_config(json.loads(Path(caminho).read_text(encoding="utf-8-sig")))
