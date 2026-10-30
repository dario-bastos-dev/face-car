"""Quando capturar e onde gravar os recortes do rosto."""

import re
from pathlib import Path

import cv2

NOME_VALIDO = re.compile(r"^[A-Za-z0-9_-]+$")


def nome_seguro(texto: str) -> str:
    """Troca por _ tudo que não seja letra ASCII, dígito, ponto, _ ou -."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", texto)


class Agendador:
    """Libera uma captura a cada intervalo_ms, contado a partir da última feita.

    Quadros sem rosto não consomem a vez: a captura acontece no primeiro quadro
    com rosto depois que o intervalo passou.
    """

    def __init__(self, intervalo_ms: int):
        self.intervalo_ms = intervalo_ms
        self._proxima = None

    def pronto(self, t_ms: int) -> bool:
        return self._proxima is None or t_ms >= self._proxima

    def registrar(self, t_ms: int) -> None:
        self._proxima = t_ms + self.intervalo_ms


class GravadorImagens:
    """Grava os recortes em <raiz>/<rotulo>/<pessoa>_<origem>_<t_ms>ms.jpg.

    Uma pasta por rótulo é o formato que as bibliotecas de treino de imagens
    leem direto; a pessoa no nome do arquivo permite separar treino e teste por
    pessoa. Rótulo e pessoa só aceitam letras, dígitos, _ e -, para não virarem
    caminhos fora da raiz.
    """

    def __init__(self, raiz, rotulo: str, pessoa: str, origem: str, qualidade: int = 95):
        for campo, valor in (("rótulo", rotulo), ("pessoa", pessoa)):
            if not NOME_VALIDO.match(valor):
                raise ValueError(f"{campo} inválido: {valor!r} (use letras, dígitos, _ ou -)")
        self.pasta = Path(raiz) / rotulo
        self.prefixo = f"{pessoa}_{nome_seguro(origem)}"
        self.qualidade = qualidade
        self.total = 0

    def salvar(self, imagem, t_ms: int) -> Path:
        self.pasta.mkdir(parents=True, exist_ok=True)
        caminho = self.pasta / f"{self.prefixo}_{t_ms:09d}ms.jpg"
        if not cv2.imwrite(str(caminho), imagem, [cv2.IMWRITE_JPEG_QUALITY, self.qualidade]):
            raise OSError(f"Não foi possível gravar {caminho}")
        self.total += 1
        return caminho
