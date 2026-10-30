"""Captura recortes do rosto do motorista para treinar um modelo de imagens.

    uv run python -m entrada video <seu-video.mp4> --rotulo alerta --pessoa p01 [--mostrar]
    uv run python -m entrada webcam --rotulo sonolento --pessoa p01 [--mostrar] [--segundos 60]

Os recortes vão para <saida>/<rotulo>/<pessoa>_<origem>_<t_ms>ms.jpg e ficam só
neste computador.
"""

import argparse
import sys
import time
from pathlib import Path

import cv2

from entrada.captura import Agendador, GravadorImagens
from entrada.contexto import CAMINHO_CONFIG, RAIZ, carregar_config
from entrada.recorte import caixa_do_rosto, recortar

JANELA = "captura do rosto (q para sair)"


class Capturador:
    """Detecta o rosto em cada quadro e grava um recorte a cada intervalo."""

    def __init__(self, config: dict, detector, gravador: GravadorImagens, intervalo_ms: int):
        self.recorte = config["recorte"]
        self.detector = detector
        self.gravador = gravador
        self.agendador = Agendador(intervalo_ms)

    def processar(self, quadro, t_ms: int):
        """Devolve a caixa do rosto (ou None) e se o quadro virou captura."""
        pontos = self.detector.detectar(quadro, t_ms)
        if pontos is None:
            return None, False
        caixa = caixa_do_rosto(pontos, self.recorte["margem"])
        if not self.agendador.pronto(t_ms):
            return caixa, False
        self.gravador.salvar(recortar(quadro, caixa, self.recorte["tamanho"]), t_ms)
        self.agendador.registrar(t_ms)
        return caixa, True


def desenhar(quadro, caixa, capturou: bool, total: int):
    """Mostra a região que vira recorte e quantas capturas já foram gravadas."""
    if caixa is not None:
        metade = caixa.lado / 2
        p0 = (int(caixa.cx - metade), int(caixa.cy - metade))
        p1 = (int(caixa.cx + metade), int(caixa.cy + metade))
        cor, espessura = ((0, 255, 0), 4) if capturou else ((0, 200, 255), 1)
        cv2.rectangle(quadro, p0, p1, cor, espessura)
    texto = f"capturas: {total}" if caixa is not None else f"capturas: {total}  (sem rosto)"
    cv2.rectangle(quadro, (0, 0), (260, 30), (0, 0, 0), -1)
    cv2.putText(quadro, texto, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1,
                cv2.LINE_AA)
    return quadro


def _gravador(args, config, origem) -> GravadorImagens:
    pasta = Path(args.saida) if args.saida else RAIZ / config["captura"]["pasta"]
    return GravadorImagens(pasta, args.rotulo, args.pessoa, origem,
                           config["recorte"]["qualidade_jpeg"])


def _mostrar(quadro, caixa, capturou, total) -> bool:
    """Atualiza a janela; devolve False quando o usuário aperta q."""
    cv2.imshow(JANELA, desenhar(quadro, caixa, capturou, total))
    return cv2.waitKey(1) & 0xFF != ord("q")


def cmd_video(args) -> int:
    from entrada.detector import DetectorRosto
    from entrada.fontes import FonteArquivo

    config = carregar_config(args.config)
    gravador = _gravador(args, config, Path(args.video).name)
    intervalo = args.intervalo_ms or config["captura"]["intervalo_ms"]
    with FonteArquivo(args.video) as fonte, DetectorRosto(config) as detector:
        print(f"{args.video}: {fonte.total} quadros a {fonte.fps:.2f} fps")
        capturador = Capturador(config, detector, gravador, intervalo)
        for quadro, t_ms, _ in fonte:
            caixa, capturou = capturador.processar(quadro, t_ms)
            if args.mostrar and not _mostrar(quadro, caixa, capturou, gravador.total):
                break
    if args.mostrar:
        cv2.destroyAllWindows()
    print(f"{gravador.total} recortes gravados em {gravador.pasta}")
    return 0


def cmd_webcam(args) -> int:
    from entrada.detector import DetectorRosto
    from entrada.fontes import FonteWebcam

    config = carregar_config(args.config)
    cam = config["webcam"]
    gravador = _gravador(args, config, time.strftime("webcam-%Y%m%d-%H%M%S"))
    intervalo = args.intervalo_ms or config["captura"]["intervalo_ms"]
    dispositivo = args.dispositivo if args.dispositivo is not None else cam["dispositivo"]
    with FonteWebcam(dispositivo, cam["largura"], cam["altura"]) as fonte, \
            DetectorRosto(config) as detector:
        capturador = Capturador(config, detector, gravador, intervalo)
        fim = time.monotonic() + args.segundos if args.segundos else None
        print("Capturando. Pressione q na janela ou Ctrl+C para parar.")
        try:
            while fonte.ativa and (fim is None or time.monotonic() < fim):
                item = fonte.ler(timeout=1.0)
                if item is None:
                    continue
                quadro, t_ms, _ = item
                caixa, capturou = capturador.processar(quadro, t_ms)
                if args.mostrar and not _mostrar(quadro.copy(), caixa, capturou, gravador.total):
                    break
        except KeyboardInterrupt:
            pass
    if args.mostrar:
        cv2.destroyAllWindows()
    print(f"{gravador.total} recortes gravados em {gravador.pasta}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m entrada", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=CAMINHO_CONFIG, help="arquivo de configuração")
    sub = parser.add_subparsers(dest="comando", required=True)

    def comuns(p):
        p.add_argument("--rotulo", default="sem_rotulo",
                       help="classe das imagens, vira a pasta (ex.: alerta, sonolento)")
        p.add_argument("--pessoa", default="anonimo",
                       help="identificador da pessoa, vai no nome do arquivo (ex.: p01)")
        p.add_argument("--saida", help="pasta raiz dos recortes (padrão: config)")
        p.add_argument("--intervalo-ms", type=int, help="tempo entre capturas (padrão: config)")
        p.add_argument("--mostrar", action="store_true", help="mostrar a imagem com o recorte")

    p = sub.add_parser("video", help="capturar recortes de um arquivo de vídeo")
    p.add_argument("video")
    comuns(p)
    p.set_defaults(func=cmd_video)

    p = sub.add_parser("webcam", help="capturar recortes da webcam")
    p.add_argument("--dispositivo", type=int, help="índice da câmera (padrão: config)")
    p.add_argument("--segundos", type=float, help="parar depois deste tempo")
    comuns(p)
    p.set_defaults(func=cmd_webcam)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (OSError, ValueError) as erro:
        # Arquivo ausente, vídeo ilegível, câmera indisponível ou nome inválido:
        # problemas de uso, que não precisam de traceback.
        print(f"erro: {erro}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
