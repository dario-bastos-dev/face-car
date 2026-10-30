"""Linha de comando do extrator.

    uv run python -m entrada video caminho.mp4 -o saidas/metricas.csv [--mostrar]
    uv run python -m entrada webcam -o saidas/webcam.csv [--mostrar] [--segundos 30]
    uv run python -m entrada comparar a.csv b.csv
"""

import argparse
import json
import sys
import threading
import time
from pathlib import Path

import cv2

from entrada.contrato import RAIZ, EscritorMetricas, RegistroMetricas

CAMINHO_CONFIG = RAIZ / "config" / "extrator.json"
JANELA = "extrator de metricas (q para sair)"


def carregar_config(caminho=CAMINHO_CONFIG) -> dict:
    return json.loads(Path(caminho).read_text(encoding="utf-8"))


def desenhar(quadro, registro: RegistroMetricas | None, pontos, indices: dict):
    """Sobrepõe pontos dos olhos e da boca e os valores do registro."""
    if pontos is not None:
        destaque = (indices["olho_esquerdo"] + indices["olho_direito"]
                    + [i for par in indices["boca_pares_verticais"] for i in par]
                    + indices["boca_cantos"])
        for i in destaque:
            x, y = pontos[i]
            cv2.circle(quadro, (int(x), int(y)), 2, (0, 255, 0), -1)
    if registro is None:
        return quadro
    if registro.rosto_visivel:
        linhas = [
            f"EAR esq {registro.ear_esq:.3f}  dir {registro.ear_dir:.3f}",
            f"boca {registro.abertura_boca:.3f}",
            f"yaw {registro.yaw:+.1f}  pitch {registro.pitch:+.1f}  roll {registro.roll:+.1f}",
        ]
    else:
        linhas = ["rosto nao detectado"]
    linhas.append(f"confianca {registro.confianca:.2f}  atraso {registro.atraso_ms or 0:.0f} ms")
    for n, texto in enumerate(linhas):
        y = 22 + 22 * n
        cv2.putText(quadro, texto, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 3)
        cv2.putText(quadro, texto, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)
    return quadro


def cmd_video(args) -> int:
    from entrada.extrator import ExtratorVideo
    from entrada.fontes import FonteArquivo
    from entrada.metricas import carregar_pontos

    config = carregar_config(args.config)
    indices = carregar_pontos()
    saida = args.saida or RAIZ / "saidas" / (Path(args.video).stem + ".csv")
    com_rosto = 0
    inicio = time.perf_counter()
    with FonteArquivo(args.video) as fonte, ExtratorVideo(config) as extrator, \
            EscritorMetricas(saida) as escritor:
        print(f"{args.video}: {fonte.total} quadros a {fonte.fps:.2f} fps")
        n = 0
        for quadro, t_ms, indice in fonte:
            registro = extrator.processar(quadro, t_ms, indice)
            escritor.escrever(registro)
            com_rosto += registro.rosto_visivel
            n += 1
            if args.mostrar:
                cv2.imshow(JANELA, desenhar(quadro, registro, extrator.ultimos_pontos, indices))
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    if args.mostrar:
        cv2.destroyAllWindows()
    duracao = time.perf_counter() - inicio
    print(f"{n} quadros em {duracao:.1f} s ({n / duracao:.1f} q/s), "
          f"rosto em {com_rosto} ({com_rosto / max(n, 1):.0%})")
    print(f"Métricas gravadas em {saida}")
    return 0


def cmd_webcam(args) -> int:
    from entrada.extrator import ExtratorAoVivo
    from entrada.fontes import FonteWebcam
    from entrada.metricas import carregar_pontos

    config = carregar_config(args.config)
    cam = config["webcam"]
    indices = carregar_pontos()
    saida = args.saida or RAIZ / "saidas" / time.strftime("webcam-%Y%m%d-%H%M%S.csv")
    ultimo = {"registro": None}
    trava = threading.Lock()
    contagem = {"enviados": 0, "registros": 0}

    with EscritorMetricas(saida) as escritor, \
            FonteWebcam(args.dispositivo if args.dispositivo is not None else cam["dispositivo"],
                        cam["largura"], cam["altura"]) as fonte:

        def ao_registrar(registro):
            with trava:
                escritor.escrever(registro)
                ultimo["registro"] = registro
                contagem["registros"] += 1

        with ExtratorAoVivo(config, ao_registrar, fonte.agora_ms) as extrator:
            fim = time.monotonic() + args.segundos if args.segundos else None
            print("Capturando. Pressione q na janela ou Ctrl+C para parar.")
            try:
                while fonte.ativa and (fim is None or time.monotonic() < fim):
                    item = fonte.ler(timeout=1.0)
                    if item is None:
                        continue
                    quadro, t_ms, indice = item
                    extrator.enviar(quadro, t_ms, indice)
                    contagem["enviados"] += 1
                    if args.mostrar:
                        with trava:
                            registro = ultimo["registro"]
                        cv2.imshow(JANELA, desenhar(quadro.copy(), registro,
                                                    extrator.ultimos_pontos, indices))
                        if cv2.waitKey(1) & 0xFF == ord("q"):
                            break
            except KeyboardInterrupt:
                pass
    if args.mostrar:
        cv2.destroyAllWindows()
    print(f"{contagem['enviados']} quadros enviados, {contagem['registros']} registros "
          f"(os demais foram ignorados pelo MediaPipe enquanto ocupado)")
    print(f"Métricas gravadas em {saida}")
    return 0


def cmd_comparar(args) -> int:
    from entrada.comparar import comparar, imprimir

    relatorio = comparar(args.a, args.b)
    imprimir(relatorio)
    return 1 if relatorio["alertas"] else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m entrada", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=CAMINHO_CONFIG, help="arquivo de configuração")
    sub = parser.add_subparsers(dest="comando", required=True)

    p = sub.add_parser("video", help="extrair métricas de um arquivo de vídeo")
    p.add_argument("video")
    p.add_argument("-o", "--saida", help="CSV de saída (padrão: saidas/<nome>.csv)")
    p.add_argument("--mostrar", action="store_true", help="mostrar o vídeo com as métricas")
    p.set_defaults(func=cmd_video)

    p = sub.add_parser("webcam", help="extrair métricas da webcam, no modo ao vivo")
    p.add_argument("-o", "--saida", help="CSV de saída (padrão: saidas/webcam-<data>.csv)")
    p.add_argument("--dispositivo", type=int, help="índice da câmera (padrão: config)")
    p.add_argument("--segundos", type=float, help="parar depois deste tempo")
    p.add_argument("--mostrar", action="store_true", help="mostrar a câmera com as métricas")
    p.set_defaults(func=cmd_webcam)

    p = sub.add_parser("comparar", help="comparar dois CSVs de métricas quadro a quadro")
    p.add_argument("a")
    p.add_argument("b")
    p.set_defaults(func=cmd_comparar)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (OSError, ValueError) as erro:
        # Arquivo ausente, vídeo ilegível, câmera indisponível ou CSV fora do
        # contrato: problemas de uso, que não precisam de traceback.
        print(f"erro: {erro}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
