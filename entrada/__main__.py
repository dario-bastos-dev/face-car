"""Captura recortes do rosto completo do motorista para modelos de imagem.

    uv run python -m entrada webcam --rotulo alerta --pessoa p01 [--camera rgb|ir|todas] [--mostrar]
    uv run python -m entrada video <seu-video.mp4> --rotulo sonolento --pessoa p07 [--camera ir]

Os recortes vão para <saida>/<camera>/<rotulo>/<pessoa>_<origem>_<t_ms>ms.jpg e ficam
só neste computador.
"""

import argparse
import sys
import time
from contextlib import ExitStack
from pathlib import Path

import cv2

from entrada.captura import Agendador, GravadorImagens
from entrada.contexto import CAMINHO_CONFIG, RAIZ, carregar_config, carregar_pontos_rosto
from entrada.mapa import desenhar_mapa
from entrada.recorte import caixa_do_rosto, recortar

JANELA = "captura (q para sair)"


class Capturador:
    """Detecta o rosto em cada quadro e grava um recorte dele a cada intervalo."""

    def __init__(self, config: dict, detector, gravador: GravadorImagens, intervalo_ms: int):
        self.recorte = config["recorte"]
        self.pontos_rosto = carregar_pontos_rosto()
        self.detector = detector
        self.gravador = gravador
        self.agendador = Agendador(intervalo_ms)

    def processar(self, quadro, t_ms: int):
        """Devolve o rosto (ou None), a caixa do recorte e se o quadro virou captura.

        O recorte sai do quadro antes de qualquer desenho na janela.
        """
        rosto = self.detector.detectar(quadro, t_ms)
        if rosto is None:
            return None, None, False
        caixa = caixa_do_rosto(rosto.pontos, self.recorte["margem"])
        if not self.agendador.pronto(t_ms):
            return rosto, caixa, False
        self.gravador.salvar(recortar(quadro, caixa, self.recorte["tamanho"]), t_ms)
        self.agendador.registrar(t_ms)
        return rosto, caixa, True


def desenhar(quadro, caixa, capturou: bool, total: int, rosto=None, pontos_rosto=None):
    """Mostra o mapeamento do rosto, o quadrado do recorte e as capturas feitas."""
    linhas = [f"capturas: {total}" if caixa is not None else f"capturas: {total}  (sem rosto)"]
    if rosto is not None:
        linhas += desenhar_mapa(quadro, rosto.pontos, rosto.matriz, pontos_rosto)
    if caixa is not None:
        metade = caixa.lado / 2
        p0 = (int(caixa.cx - metade), int(caixa.cy - metade))
        p1 = (int(caixa.cx + metade), int(caixa.cy + metade))
        cor, espessura = ((0, 255, 0), 4) if capturou else ((0, 200, 255), 1)
        cv2.rectangle(quadro, p0, p1, cor, espessura)
    cv2.rectangle(quadro, (0, 0), (260, 10 + 22 * len(linhas)), (0, 0, 0), -1)
    for n, texto in enumerate(linhas):
        cv2.putText(quadro, texto, (8, 24 + 22 * n), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (255, 255, 255), 1, cv2.LINE_AA)
    return quadro


def _gravador(args, config, camera: str, origem: str) -> GravadorImagens:
    pasta = Path(args.saida) if args.saida else RAIZ / config["captura"]["pasta"]
    return GravadorImagens(pasta, camera, args.rotulo, args.pessoa, origem,
                           config["recorte"]["qualidade_jpeg"])


def _capturar(args, config: dict, gravadores: dict, quadros) -> int:
    """Laço comum aos dois comandos, para uma ou várias câmeras.

    `quadros` entrega (camera, quadro, t_ms); cada câmera tem o próprio detector,
    porque o MediaPipe acompanha o rosto de um quadro para o seguinte. Termina
    quando os quadros acabam, com q numa janela ou com Ctrl+C.
    """
    from entrada.detector import DetectorRosto

    intervalo = args.intervalo_ms or config["captura"]["intervalo_ms"]
    with ExitStack() as pilha:
        capturadores = {
            camera: Capturador(config, pilha.enter_context(DetectorRosto(config)), gravador,
                               intervalo)
            for camera, gravador in gravadores.items()
        }
        try:
            for camera, quadro, t_ms in quadros:
                capturador = capturadores[camera]
                rosto, caixa, capturou = capturador.processar(quadro, t_ms)
                if args.mostrar:
                    imagem = desenhar(quadro, caixa, capturou, gravadores[camera].total, rosto,
                                      capturador.pontos_rosto)
                    cv2.imshow(f"{camera} - {JANELA}", imagem)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        break
        except KeyboardInterrupt:
            pass
        finally:
            if args.mostrar:
                cv2.destroyAllWindows()
    for camera, gravador in gravadores.items():
        print(f"{camera}: {gravador.total} recortes gravados em {gravador.pasta}")
    return 0


def _quadros_das_webcams(fontes: dict, segundos):
    """(camera, quadro, t_ms) das webcams, alternando entre elas.

    Segue enquanto alguma estiver ativa e o tempo não acabar.
    """
    fim = time.monotonic() + segundos if segundos else None
    while any(f.ativa for f in fontes.values()) and (fim is None or time.monotonic() < fim):
        entregou = False
        for camera, fonte in fontes.items():
            item = fonte.ler(timeout=0)
            if item is not None:
                entregou = True
                quadro, t_ms, _ = item
                yield camera, quadro, t_ms
        if not entregou:
            time.sleep(0.005)


def escolher_cameras(pedidas, cameras: dict, padrao: str, interativo: bool, ler=input) -> list:
    """Câmeras a usar: as pedidas em --camera, a escolha no menu ou a padrão.

    "todas" seleciona todas. No menu, Enter escolhe a padrão; sem terminal
    interativo, a padrão é usada sem perguntar.
    """
    nomes = list(cameras)
    if pedidas:
        if "todas" in pedidas:
            return nomes
        for nome in pedidas:
            if nome not in cameras:
                raise ValueError(f"câmera desconhecida: {nome} (configuradas: {', '.join(nomes)})")
        return list(dict.fromkeys(pedidas))
    if not interativo:
        return [padrao]

    opcoes = [[nome] for nome in nomes] + [nomes]
    print("Qual câmera usar?")
    for n, nome in enumerate(nomes, 1):
        marca = "  (padrão)" if nome == padrao else ""
        print(f"  {n}) {nome} - {cameras[nome].get('descricao', '')}{marca}")
    print(f"  {len(opcoes)}) todas")
    while True:
        try:
            resposta = ler(f"Escolha [1-{len(opcoes)}, Enter = {padrao}]: ").strip().lower()
        except EOFError:
            raise ValueError("nenhuma câmera escolhida") from None
        if resposta == "":
            return [padrao]
        if resposta == "todas":
            return nomes
        if resposta in cameras:
            return [resposta]
        if resposta.isdigit() and 1 <= int(resposta) <= len(opcoes):
            return opcoes[int(resposta) - 1]
        print(f"opção inválida: {resposta!r}")


def cmd_video(args) -> int:
    from entrada.fontes import FonteArquivo

    config = carregar_config(args.config)
    camera = args.camera or "rgb"
    gravador = _gravador(args, config, camera, Path(args.video).name)
    with FonteArquivo(args.video) as fonte:
        print(f"{args.video}: {fonte.total} quadros a {fonte.fps:.2f} fps")
        quadros = ((camera, quadro, t_ms) for quadro, t_ms, _ in fonte)
        return _capturar(args, config, {camera: gravador}, quadros)


def cmd_webcam(args) -> int:
    from entrada.fontes import FonteWebcam

    config = carregar_config(args.config)
    cameras = {c["nome"]: c for c in config["cameras"]}
    escolhidas = escolher_cameras(args.camera, cameras, config["camera_padrao"],
                                  interativo=sys.stdin.isatty())
    origem = time.strftime("webcam-%Y%m%d-%H%M%S")
    gravadores = {nome: _gravador(args, config, nome, origem) for nome in escolhidas}
    t0 = time.monotonic()  # relógio comum: as marcas de tempo das câmeras se comparam
    with ExitStack() as pilha:
        fontes = {
            nome: pilha.enter_context(FonteWebcam(
                cameras[nome]["dispositivo"], cameras[nome]["largura"], cameras[nome]["altura"],
                t0=t0))
            for nome in escolhidas
        }
        print(f"Capturando de {', '.join(escolhidas)}. Pressione q numa janela ou Ctrl+C.")
        return _capturar(args, config, gravadores, _quadros_das_webcams(fontes, args.segundos))


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
    p.add_argument("--camera", help="câmera que gravou o vídeo; vira a pasta (padrão: rgb)")
    comuns(p)
    p.set_defaults(func=cmd_video)

    p = sub.add_parser("webcam", help="capturar recortes das webcams da configuração")
    p.add_argument("--camera", action="append",
                   help="câmera da configuração (repetível) ou 'todas'; sem esta opção, "
                        "pergunta no terminal")
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
