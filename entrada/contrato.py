"""Contrato de métricas: registro por quadro e leitura/escrita em CSV.

As colunas, a ordem e as casas decimais vêm de contratos/metricas.v1.json, o
mesmo arquivo lido pela demo no navegador.
"""

import csv
import json
from dataclasses import dataclass, fields
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CAMINHO_CONTRATO = RAIZ / "contratos" / "metricas.v1.json"


def carregar_contrato(caminho: Path = CAMINHO_CONTRATO) -> dict:
    return json.loads(Path(caminho).read_text(encoding="utf-8"))


@dataclass
class RegistroMetricas:
    t_ms: int
    quadro: int
    rosto_visivel: bool
    ear_esq: float | None = None
    ear_dir: float | None = None
    abertura_boca: float | None = None
    yaw: float | None = None
    pitch: float | None = None
    roll: float | None = None
    confianca: float = 0.0
    atraso_ms: float | None = None


def _formatar(valor, coluna: dict) -> str:
    if valor is None:
        return ""
    if coluna["tipo"] == "booleano":
        return "1" if valor else "0"
    if coluna["tipo"] == "inteiro":
        return str(int(valor))
    return f"{valor:.{coluna['casas']}f}"


def _interpretar(texto: str, coluna: dict):
    if texto == "":
        return None
    if coluna["tipo"] == "booleano":
        return texto == "1"
    if coluna["tipo"] == "inteiro":
        return int(texto)
    return float(texto)


class EscritorMetricas:
    """Grava registros em CSV no formato do contrato, um por linha."""

    def __init__(self, caminho, contrato: dict | None = None):
        self.contrato = contrato or carregar_contrato()
        self.colunas = self.contrato["colunas"]
        nomes = [c["nome"] for c in self.colunas]
        campos = [f.name for f in fields(RegistroMetricas)]
        if nomes != campos:
            raise ValueError(f"Contrato e RegistroMetricas divergem: {nomes} != {campos}")
        Path(caminho).parent.mkdir(parents=True, exist_ok=True)
        self._arquivo = open(caminho, "w", newline="", encoding="utf-8")
        self._csv = csv.writer(self._arquivo)
        self._csv.writerow(nomes)

    def escrever(self, registro: RegistroMetricas) -> None:
        self._csv.writerow(
            _formatar(getattr(registro, c["nome"]), c) for c in self.colunas
        )

    def fechar(self) -> None:
        self._arquivo.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.fechar()


def ler_metricas(caminho, contrato: dict | None = None) -> list[RegistroMetricas]:
    contrato = contrato or carregar_contrato()
    colunas = {c["nome"]: c for c in contrato["colunas"]}
    with open(caminho, newline="", encoding="utf-8") as arquivo:
        leitor = csv.DictReader(arquivo)
        if leitor.fieldnames != list(colunas):
            raise ValueError(f"Cabeçalho fora do contrato: {leitor.fieldnames}")
        return [
            RegistroMetricas(**{n: _interpretar(v, colunas[n]) for n, v in linha.items()})
            for linha in leitor
        ]
