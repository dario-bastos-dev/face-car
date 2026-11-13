"""Grava vídeos de treino guiados na webcam: alerta, sonolento e bocejo de uma pessoa.

    uv run python -m treinamento.gravar --pessoa voce1 --variante oculos
    uv run python -m treinamento.gravar --pessoa voce1 --variante sem_oculos

Uma janela mostra a câmera e o que fazer em cada momento ("FECHE OS OLHOS", "BOCEJE"...). São
três tomadas seguidas, cada uma com 5 s para se preparar, e cada uma vira um vídeo em
treinamento/dataset/<classe>/gravacoes/<pessoa>_<variante>_<classe>.mp4, que o notebook de treino
lê como os vídeos do RLDD. Não precisa acertar o tempo: a limpeza dos rótulos
(treinamento/rotulos.py) só aproveita os quadros sonolentos com o olho fechando e os de bocejo
com a boca aberta.

A pessoa é a primeira parte do nome do arquivo (REGEX_PESSOA do notebook): use o mesmo nome em
todas as gravações da mesma pessoa, sem "_". Grave nesta webcam, na posição e na luz em que o
sistema vai rodar: é o que mais aproxima o treino do uso. q interrompe sem salvar a tomada atual.
"""

import argparse
import re
import sys
import time
from pathlib import Path

DATASET = Path(__file__).resolve().parent / "dataset"
PREPARO_S = 5

# (classe, duração em s, ciclo de instruções [(texto, s)]): a instrução do momento sai do ciclo
ROTEIRO = [
    ("alerta", 45, [("Normal, olhando para a tela (pode piscar e falar)", 45)]),
    ("sonolento", 45, [("FECHE OS OLHOS", 6), ("Abra devagar, palpebras pesadas", 4)]),
    ("bocejo", 45, [("BOCEJE", 7), ("Descanse", 5)]),
]


def validar_nome(nome: str, campo: str) -> str:
    if not re.fullmatch(r"[a-z0-9]+", nome or ""):
        raise ValueError(f"{campo} '{nome}': use só letras minúsculas sem acento e números, sem '_'")
    return nome


def destino(dataset: Path, pessoa: str, variante: str, classe: str) -> Path:
    """dataset/<classe>/gravacoes/<pessoa>_<variante>_<classe>.mp4"""
    return Path(dataset) / classe / "gravacoes" / f"{pessoa}_{variante}_{classe}.mp4"


def instrucao(ciclo, t: float) -> tuple[str, float]:
    """(texto, segundos até mudar) no instante `t` da tomada, repetindo o ciclo."""
    periodo = sum(d for _, d in ciclo)
    t = t % periodo
    for texto, duracao in ciclo:
        if t < duracao:
            return texto, duracao - t
        t -= duracao
    return ciclo[-1][0], 0.0


def _gravar(camera, roteiro, destinos):
    import cv2

    for (classe, duracao, ciclo), arquivo in zip(roteiro, destinos):
        inicio, quadros, escritor = time.time(), 0, None
        while True:
            ok, quadro = camera.read()
            if not ok:
                continue
            t = time.time() - inicio
            if t < PREPARO_S:
                texto, resta, gravando = f"Prepare-se: {classe}", PREPARO_S - t, False
                quadros += 1
            elif t < PREPARO_S + duracao:
                if escritor is None:   # quadros por segundo medidos no preparo
                    fps = max(5.0, quadros / PREPARO_S)
                    arquivo.parent.mkdir(parents=True, exist_ok=True)
                    escritor = cv2.VideoWriter(str(arquivo), cv2.VideoWriter_fourcc(*"mp4v"), fps,
                                               (quadro.shape[1], quadro.shape[0]))
                escritor.write(quadro)
                texto, resta = instrucao(ciclo, t - PREPARO_S)
                gravando = True
            else:
                break
            tela = cv2.flip(quadro, 1)   # espelhada só na tela, como num espelho
            cv2.rectangle(tela, (0, 0), (tela.shape[1], 60), (0, 0, 0), -1)
            cv2.putText(tela, f"{texto}  ({resta:.0f} s)", (10, 38), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                        (0, 255, 255), 2)
            if gravando:
                cv2.circle(tela, (tela.shape[1] - 25, 30), 10, (0, 0, 255), -1)
            cv2.imshow("gravacao (q para sair)", tela)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                if escritor is not None:
                    escritor.release()
                    arquivo.unlink(missing_ok=True)
                print("Interrompido: a tomada atual não foi salva.")
                return False
        escritor.release()
        print(f"Salvo: {arquivo}")
    return True


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--pessoa", required=True, help="nome da pessoa, igual em todas as gravações dela")
    parser.add_argument("--variante", default="normal", help="ex.: oculos, sem_oculos → oculos, semoculos")
    parser.add_argument("--camera", help="nome em config/analise.json (padrão: camera_padrao)")
    parser.add_argument("--substituir", action="store_true", help="regrava vídeos que já existem")
    parser.add_argument("--dataset", type=Path, default=DATASET)
    args = parser.parse_args(argv)
    try:
        pessoa = validar_nome(args.pessoa, "pessoa")
        variante = validar_nome(args.variante.replace("_", ""), "variante")
    except ValueError as erro:
        print(erro, file=sys.stderr)
        return 2
    destinos = [destino(args.dataset, pessoa, variante, classe) for classe, _, _ in ROTEIRO]
    existentes = [d for d in destinos if d.exists()]
    if existentes and not args.substituir:
        print(f"Já existem: {[str(d) for d in existentes]}. Use --substituir para regravar.",
              file=sys.stderr)
        return 2

    import cv2

    from entrada.contexto import carregar_config

    config = carregar_config()
    nome = args.camera or config["camera_padrao"]
    cam = next(c for c in config["cameras"] if c["nome"] == nome)
    camera = cv2.VideoCapture(cam["dispositivo"])
    if cam.get("largura"):
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, cam["largura"])
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, cam["altura"])
    if not camera.isOpened():
        print(f"Não consegui abrir a câmera {nome}", file=sys.stderr)
        return 1
    try:
        ok = _gravar(camera, ROTEIRO, destinos)
    finally:
        camera.release()
        cv2.destroyAllWindows()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
