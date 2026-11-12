"""Organiza treinamento/dataset nas pastas de classe que o notebook de treino lê.

Como os dados chegaram:

    Fold*_part*/NN/0.mov         UTA-RLDD, pessoa NN: 0 = alerta, 5 = pouco alerta, 10 = sonolento
    data_set_propio/<grupo>/<pasta>/foto_NNNN.jpg   fotos próprias de duas pessoas

Como ficam (o nome começa pela pessoa, para o treino separar treino e teste por pessoa):

    alerta/rldd/rldd01_0.mov                  alerta/proprio/proprio1_acordado_0001.jpg
    sonolento/rldd/rldd01_10.MOV              sonolento/proprio/proprio1_olhos_fechados_0001.jpg
    bocejo/proprio/proprio1_bocejo_0004.jpg
    _fora_do_treino/pouco_alerta/rldd/rldd01_5.mov    (fica de fora: ver PASTA_POUCO_ALERTA)
    _fora_do_treino/duvidosas/proprio1_bocejo_0001.jpg (fica de fora: ver DUVIDOSAS)

Nada é apagado: os arquivos só mudam de pasta e de nome, e cada mudança fica em
organizacao.csv, dentro do dataset, para poder desfazer.

    uv run python treinamento/organizar_dataset.py              # só mostra o plano
    uv run python treinamento/organizar_dataset.py --aplicar    # move os arquivos
    uv run python treinamento/organizar_dataset.py --desfazer   # devolve tudo ao lugar de origem
"""

import argparse
import csv
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

DATASET = Path(__file__).resolve().parent / "dataset"
REGISTRO = "organizacao.csv"
FORA = "_fora_do_treino"
PASTAS_ORGANIZADAS = {"alerta", "sonolento", "bocejo", FORA}

# UTA-RLDD (Real-Life Drowsiness Dataset): cada pessoa gravou um vídeo em cada estado.
# O "5" (pouco alerta) fica fora do treino: num quadro isolado ele é quase igual ao alerta,
# e misturá-lo a qualquer uma das classes só ensinaria rótulos errados à rede.
RLDD = re.compile(r"^Fold\d+_part\d+/(\d+)/((0|5|10)(?:_\d+)?)\.(\w+)$")
CLASSE_RLDD = {"0": "alerta", "10": "sonolento"}
PASTA_POUCO_ALERTA = f"{FORA}/pouco_alerta"

# Fotos próprias: pasta de origem → (classe, nome no arquivo, 1ª foto da pessoa 2).
# As fotos estão em sequência: a pessoa 1 (camiseta amarela) vem primeiro e a pessoa 2
# (camiseta preta) depois. As fronteiras foram achadas pela cor da camiseta e conferidas
# uma a uma.
PROPRIO = re.compile(r"^data_set_propio/(\w+/\w+)/foto_(\d+)\.jpg$", re.IGNORECASE)
PASTAS_PROPRIAS = {
    "1_estado/acordado": ("alerta", "acordado", 207),
    "1_estado/sonolento": ("sonolento", "sonolento", 201),
    "2_olhos/olhos_abertos": ("alerta", "olhos_abertos", None),   # só a pessoa 1
    "2_olhos/olhos_fechados": ("sonolento", "olhos_fechados", 129),
    "3_bocejo/com_bocejo": ("bocejo", "bocejo", 157),
}

# Fotos cujo rosto contradiz a pasta, achadas com o MediaPipe (EAR dos olhos e abertura da
# boca, as mesmas medidas da análise) e conferidas uma a uma:
# - acordado: boca escancarada como num bocejo (14-17, 37, 38, 58, 59) ou piscando (177, 192, 242);
# - olhos_abertos: olhos fechados ou olhando para baixo;
# - olhos_fechados: olhos abertos (a 150, de cabeça baixa, continua: cabeça caída é sono);
# - com_bocejo: boca ainda fechada, no começo ou no fim do bocejo.
DUVIDOSAS = {
    "1_estado/acordado": {14, 15, 16, 17, 37, 38, 58, 59, 177, 192, 242},
    "2_olhos/olhos_abertos": {30, 35, 63, 94, 108},
    "2_olhos/olhos_fechados": {1, 61, 122},
    "3_bocejo/com_bocejo": {1, 2, 3, 60, 67, 68, 97, 99, 122, 141, 157, 172, 173, 185, 189},
}


@dataclass(frozen=True)
class Movimento:
    origem: Path
    destino: Path
    motivo: str


def _destino_rldd(achou) -> tuple[str, str]:
    pessoa, nome, estado, extensao = achou.groups()
    arquivo = f"rldd{int(pessoa):02d}_{nome}.{extensao}"
    if estado == "5":
        return f"{PASTA_POUCO_ALERTA}/rldd/{arquivo}", "RLDD pouco alerta: fora do treino"
    return f"{CLASSE_RLDD[estado]}/rldd/{arquivo}", f"RLDD {estado} → {CLASSE_RLDD[estado]}"


def _destino_proprio(achou) -> tuple[str, str] | None:
    pasta, numero = achou.group(1), int(achou.group(2))
    if pasta not in PASTAS_PROPRIAS:
        return None
    classe, nome, inicio_pessoa2 = PASTAS_PROPRIAS[pasta]
    pessoa = 2 if inicio_pessoa2 and numero >= inicio_pessoa2 else 1
    arquivo = f"proprio{pessoa}_{nome}_{numero:04d}.jpg"
    if numero in DUVIDOSAS.get(pasta, ()):
        return f"{FORA}/duvidosas/{arquivo}", f"{pasta}: rosto contradiz o rótulo"
    return f"{classe}/proprio/{arquivo}", f"{pasta} → {classe}"


def planejar(raiz: Path) -> list[Movimento]:
    """Movimentos que deixam `raiz` organizado; erro se houver arquivo que não se sabe onde pôr."""
    raiz = Path(raiz)
    movimentos, desconhecidos = [], []
    for arquivo in sorted(p for p in raiz.rglob("*") if p.is_file()):
        relativo = arquivo.relative_to(raiz).as_posix()
        if relativo == REGISTRO or relativo.split("/")[0] in PASTAS_ORGANIZADAS:
            continue
        destino = None
        if achou := RLDD.match(relativo):
            destino = _destino_rldd(achou)
        elif achou := PROPRIO.match(relativo):
            destino = _destino_proprio(achou)
        if destino is None:
            desconhecidos.append(relativo)
        else:
            movimentos.append(Movimento(arquivo, raiz / destino[0], destino[1]))
    if desconhecidos:
        raise ValueError(f"{len(desconhecidos)} arquivos sem regra de organização: {desconhecidos[:10]}")
    repetidos = [d for d, n in Counter(m.destino for m in movimentos).items() if n > 1]
    if repetidos:
        raise ValueError(f"dois arquivos iriam para o mesmo lugar: {repetidos[:5]}")
    return movimentos


def _apagar_pastas_vazias(raiz: Path, pastas) -> None:
    for pasta in sorted(set(pastas), key=lambda p: len(p.parts), reverse=True):
        while pasta != raiz and pasta.is_dir() and not any(pasta.iterdir()):
            pasta.rmdir()
            pasta = pasta.parent


def aplicar(raiz: Path, movimentos: list[Movimento]) -> None:
    """Move os arquivos (só renomeia, sem copiar) e anota cada um em REGISTRO."""
    raiz = Path(raiz)
    existentes = [m.destino for m in movimentos if m.destino.exists()]
    if existentes:
        raise FileExistsError(f"destinos já existem, nada foi movido: {existentes[:5]}")
    registro = raiz / REGISTRO
    novo = not registro.exists()
    with registro.open("a", newline="", encoding="utf-8") as f:
        escritor = csv.writer(f)
        if novo:
            escritor.writerow(["origem", "destino", "motivo"])
        for m in movimentos:
            m.destino.parent.mkdir(parents=True, exist_ok=True)
            os.rename(m.origem, m.destino)
            escritor.writerow([m.origem.relative_to(raiz).as_posix(),
                               m.destino.relative_to(raiz).as_posix(), m.motivo])
            f.flush()   # se parar no meio, o registro tem tudo o que já foi movido
    # sobram pastas vazias, como data_set_propio/3_bocejo/sem_bocejo
    _apagar_pastas_vazias(raiz, [p for p in raiz.rglob("*") if p.is_dir()
                                 and p.relative_to(raiz).parts[0] not in PASTAS_ORGANIZADAS])


def desfazer(raiz: Path) -> int:
    """Devolve cada arquivo de REGISTRO ao lugar de origem; devolve quantos voltaram."""
    raiz = Path(raiz)
    registro = raiz / REGISTRO
    with registro.open(encoding="utf-8") as f:
        linhas = list(csv.DictReader(f))
    for linha in reversed(linhas):
        origem, destino = raiz / linha["origem"], raiz / linha["destino"]
        origem.parent.mkdir(parents=True, exist_ok=True)
        os.rename(destino, origem)
    registro.unlink()
    _apagar_pastas_vazias(raiz, [(raiz / l["destino"]).parent for l in linhas])
    return len(linhas)


def resumo(movimentos: list[Movimento], raiz: Path) -> str:
    """Quantos arquivos vão para cada pasta, e de quantas pessoas são os de treino."""
    partes = [m.destino.relative_to(raiz).parts for m in movimentos]
    contagem = Counter("/".join(p[:2]) for p in partes)
    pessoas = {p[-1].split("_")[0] for p in partes if p[0] != FORA}
    linhas = [f"{n:>6}  {pasta}" for pasta, n in sorted(contagem.items())]
    return "\n".join(linhas + [f"{len(pessoas):>6}  pessoas nos arquivos de treino"])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    acao = parser.add_mutually_exclusive_group()
    acao.add_argument("--aplicar", action="store_true", help="move os arquivos")
    acao.add_argument("--desfazer", action="store_true", help="devolve os arquivos à origem")
    parser.add_argument("--dataset", type=Path, default=DATASET)
    args = parser.parse_args(argv)

    if args.desfazer:
        print(f"{desfazer(args.dataset)} arquivos devolvidos ao lugar de origem")
        return 0
    movimentos = planejar(args.dataset)
    if not movimentos:
        print("Nada a organizar.")
        return 0
    print(resumo(movimentos, args.dataset))
    if args.aplicar:
        aplicar(args.dataset, movimentos)
        print(f"\n{len(movimentos)} arquivos movidos; registro em {args.dataset / REGISTRO}")
    else:
        print("\nSó o plano. Rode com --aplicar para mover.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
