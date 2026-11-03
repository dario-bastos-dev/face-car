"""Quando capturar e onde gravar os recortes do rosto."""

import re
from collections import deque
from pathlib import Path

import cv2

NOME_VALIDO = re.compile(r"^[A-Za-z0-9_-]+$")
# Nome que GravadorImagens dá às fotos: <pessoa>_<origem>_<t_ms com 9 dígitos>ms.jpg.
NOME_FOTO = re.compile(r"^[A-Za-z0-9_-]+_.+_\d{9}ms\.jpg$")


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


def _validar(campo: str, valor: str) -> None:
    if not NOME_VALIDO.match(valor):
        raise ValueError(f"{campo} inválido: {valor!r} (use letras, dígitos, _ ou -)")


class RetencaoImagens:
    """Mantém no máximo `limite` fotos sob a raiz, somando câmeras e rótulos.

    Ao chegar no limite, apaga a foto mais antiga antes de gravar a nova. Conta
    também as fotos de sessões anteriores, da mais velha para a mais nova pela data
    do arquivo. Só considera, e só apaga, arquivos em <raiz>/<camera>/<rotulo>/ com
    o nome que GravadorImagens gera; qualquer outro arquivo fica intocado.
    """

    def __init__(self, raiz, limite: int):
        if limite < 1:
            raise ValueError(f"limite de fotos inválido: {limite} (use 1 ou mais)")
        self.limite = limite
        raiz = Path(raiz)
        existentes = [p for p in raiz.glob("*/*/*.jpg") if NOME_FOTO.match(p.name)]
        existentes.sort(key=lambda p: (p.stat().st_mtime, p.name))
        self._fotos = deque(existentes)
        self.apagadas = 0

    def abrir_vaga(self, caminho: Path) -> None:
        """Prepara a gravação de `caminho`, apagando as mais antigas se preciso."""
        if caminho in self._fotos:  # vai ser sobrescrita: não ocupa vaga nova
            self._fotos.remove(caminho)
        while len(self._fotos) >= self.limite:
            self._fotos.popleft().unlink(missing_ok=True)
            self.apagadas += 1

    def registrar(self, caminho: Path) -> None:
        self._fotos.append(caminho)


class GravadorImagens:
    """Grava em <raiz>/<camera>/<rotulo>/<pessoa>_<origem>_<t_ms>ms.jpg.

    Uma pasta por rótulo, dentro de cada câmera, é o formato que as bibliotecas
    de treino de imagens leem direto; a pessoa no nome do arquivo permite
    separar treino e teste por pessoa. Câmera, rótulo e pessoa só aceitam
    letras, dígitos, _ e -, para não virarem caminhos fora da raiz.
    """

    def __init__(self, raiz, camera: str, rotulo: str, pessoa: str, origem: str,
                 qualidade: int = 95, retencao: RetencaoImagens | None = None):
        for campo, valor in (("câmera", camera), ("rótulo", rotulo), ("pessoa", pessoa)):
            _validar(campo, valor)
        self.pasta = Path(raiz) / camera / rotulo
        self.prefixo = f"{pessoa}_{nome_seguro(origem)}"
        self.qualidade = qualidade
        self.retencao = retencao
        self.total = 0

    def salvar(self, imagem, t_ms: int) -> Path:
        self.pasta.mkdir(parents=True, exist_ok=True)
        caminho = self.pasta / f"{self.prefixo}_{t_ms:09d}ms.jpg"
        if self.retencao is not None:
            self.retencao.abrir_vaga(caminho)
        if not cv2.imwrite(str(caminho), imagem, [cv2.IMWRITE_JPEG_QUALITY, self.qualidade]):
            raise OSError(f"Não foi possível gravar {caminho}")
        if self.retencao is not None:
            self.retencao.registrar(caminho)
        self.total += 1
        return caminho
