"""Analisa em tempo real o estado do motorista com o modelo de imagens.

    uv run python -m entrada webcam [--camera rgb|ir|todas] [--sem-janela] [--segundos 60]
    uv run python -m entrada video <seu-video.mp4> [--mostrar]
    uv run python -m entrada metricas video|webcam ...   (métricas em CSV para as Partes 2 e 3)

Cada quadro vai, na memória, para o modelo Keras da configuração (cnn_sonolencia.keras);
nada é gravado. O terminal mostra, em cada quadro, o que o modelo devolve e o estado dos
olhos, da boca e da cabeça (pela geometria do rosto); avisa piscadas, olhos fechados e
bocejos; e, uma vez por segundo, mostra a média dos últimos segundos (--sem-log mostra só
os eventos e a média).
"""

import argparse
import os
import sys
import time
from contextlib import ExitStack
from dataclasses import dataclass

import cv2

from entrada.classificador import (ClassificadorSonolencia, MediaTemporal, Resultado, formatar,
                                   formatar_classe, formatar_saida)
from entrada.contexto import CAMINHO_CONFIG, RAIZ, carregar_config, carregar_pontos_rosto
from entrada.estado_rosto import EstadoRosto, LimiaresRosto, MonitorRosto, formatar_estado
from entrada.formato import numero
from entrada.mapa import desenhar_mapa

JANELA = "analise (q para sair)"


@dataclass
class Analise:
    """O que se sabe de um quadro: o resultado dele, a média da janela e o rosto."""

    resultado: Resultado                 # saída do modelo neste quadro
    resumo: Resultado                    # média das probabilidades na janela
    qps: float                           # quadros por segundo na janela
    rosto: object | None                 # Rosto do detector, para o mapeamento
    estado: EstadoRosto | None           # olhos, boca, cabeça e eventos
    mostrar_resumo: bool                 # hora de mostrar a média no terminal


class Analisador:
    """Classifica todo quadro e resume os resultados de uma câmera.

    O modelo recebe o quadro inteiro. O detector de rosto e o monitor, opcionais,
    acompanham olhos, boca e cabeça pela geometria do rosto e alimentam o mapeamento.
    """

    def __init__(self, classificador, detector=None, janela_ms: int = 2000,
                 intervalo_terminal_ms: int = 1000, monitor: MonitorRosto | None = None):
        self.classificador = classificador
        self.detector = detector
        self.monitor = monitor
        self.media = MediaTemporal(janela_ms)
        self.intervalo_terminal_ms = intervalo_terminal_ms
        self._ultimo_resumo = None

    def processar(self, quadro, t_ms: int) -> Analise:
        """Analisa um quadro. A imagem do modelo sai antes de qualquer desenho na janela."""
        resultado = self.classificador.classificar(quadro)
        self.media.adicionar(t_ms, resultado)
        resumo, qps = self.media.resumo()
        rosto = self.detector.detectar(quadro, t_ms) if self.detector is not None else None
        estado = self.monitor.atualizar(t_ms, rosto) if self.monitor is not None else None
        mostrar_resumo = (self._ultimo_resumo is None
                          or t_ms - self._ultimo_resumo >= self.intervalo_terminal_ms)
        if mostrar_resumo:
            self._ultimo_resumo = t_ms
        return Analise(resultado, resumo, qps, rosto, estado, mostrar_resumo)


def desenhar(quadro, resumo, rosto=None, pontos_rosto=None, estado=None):
    """Mostra o resultado do modelo, o estado dos olhos e da boca e o mapeamento do rosto."""
    linhas = [f"modelo: {formatar_classe(resumo)}" if resumo else "modelo: ..."]
    if estado is not None and estado.olhos is not None:
        linhas += [f"olhos: {estado.olhos}", f"boca: {estado.boca}"]
    if rosto is not None:
        linhas += desenhar_mapa(quadro, rosto.pontos, rosto.matriz, pontos_rosto)
    cv2.rectangle(quadro, (0, 0), (280, 10 + 22 * len(linhas)), (0, 0, 0), -1)
    for n, texto in enumerate(linhas):
        cv2.putText(quadro, texto, (8, 24 + 22 * n), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (255, 255, 255), 1, cv2.LINE_AA)
    return quadro


def janela_ativa(args, ambiente=os.environ) -> bool:
    """Se a janela deve abrir: sempre na webcam (salvo --sem-janela), no vídeo só com --mostrar.

    Sem tela gráfica (por exemplo, por SSH), o Qt do OpenCV aborta o processo ao abrir
    uma janela; nesse caso a análise segue sem ela.
    """
    quer = args.mostrar if args.comando == "video" else not args.sem_janela
    if quer and not (ambiente.get("DISPLAY") or ambiente.get("WAYLAND_DISPLAY")):
        print("aviso: sem tela (DISPLAY ou WAYLAND_DISPLAY); analisando sem janela",
              file=sys.stderr)
        return False
    return quer


def _carregar_classificador(config: dict) -> ClassificadorSonolencia:
    cfg = config["classificador"]
    caminho = RAIZ / cfg["modelo"]
    if not caminho.is_file():
        raise FileNotFoundError(f"modelo não encontrado: {caminho} (o .keras fica fora do git; "
                                f"coloque-o na raiz do projeto)")
    print(f"Carregando o modelo {caminho.name}...")
    return ClassificadorSonolencia.carregar(caminho, cfg["classes"])


def _segundos(t_ms: int, casas: int = 1) -> str:
    return f"{numero(t_ms / 1000, f'{5 + casas}.{casas}f')} s"


def _linhas_do_terminal(camera: str, t_ms: int, analise: Analise, sem_log: bool,
                        janela_s: str) -> list[str]:
    """Linhas de um quadro: a saída do modelo e o rosto (salvo --sem-log), os eventos e,
    uma vez por segundo, a média."""
    instante = f"[{camera} {_segundos(t_ms, 3)}]"
    linhas = []
    if not sem_log:
        rosto = f" | {formatar_estado(analise.estado)}" if analise.estado is not None else ""
        linhas.append(f"{instante} {formatar_saida(analise.resultado)}{rosto}")
    if analise.estado is not None:
        linhas += [f"{instante} evento: {evento}" for evento in analise.estado.eventos]
    if analise.mostrar_resumo:
        taxa = f"  · {numero(analise.qps, '.0f')} q/s" if analise.qps else ""
        linhas.append(f"[{camera} {_segundos(t_ms)}] média {janela_s} s: "
                      f"{formatar(analise.resumo)}{taxa}")
    return linhas


def _analisar(args, config: dict, classificador, cameras: list, quadros) -> int:
    """Laço comum aos dois comandos, para uma ou várias câmeras.

    `quadros` entrega (camera, quadro, t_ms). Cada câmera tem a própria média e, com
    janela, o próprio detector, porque o MediaPipe acompanha o rosto de um quadro para
    o seguinte. Termina quando os quadros acabam, com q numa janela ou com Ctrl+C.
    """
    from entrada.detector import DetectorRosto

    mostrar = janela_ativa(args)
    cfg = config["classificador"]
    limiares = LimiaresRosto(**config["rosto"])
    janela_s = numero(cfg["janela_ms"] / 1000, "g")
    pontos_rosto = carregar_pontos_rosto()
    with ExitStack() as pilha:
        analisadores = {
            camera: Analisador(classificador, pilha.enter_context(DetectorRosto(config)),
                               cfg["janela_ms"], cfg["intervalo_terminal_ms"],
                               MonitorRosto(limiares, pontos_rosto))
            for camera in cameras
        }
        try:
            for camera, quadro, t_ms in quadros:
                analise = analisadores[camera].processar(quadro, t_ms)
                linhas = _linhas_do_terminal(camera, t_ms, analise, args.sem_log, janela_s)
                if linhas:
                    print("\n".join(linhas), flush=True)
                if mostrar:
                    imagem = desenhar(quadro, analise.resumo, analise.rosto, pontos_rosto,
                                      analise.estado)
                    cv2.imshow(f"{camera} - {JANELA}", imagem)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        break
        except KeyboardInterrupt:
            pass
        finally:
            if mostrar:
                cv2.destroyAllWindows()
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
    # O vídeo abre antes do modelo: um caminho errado falha na hora, sem esperar o TensorFlow.
    with FonteArquivo(args.video) as fonte:
        print(f"{args.video}: {fonte.total} quadros a {fonte.fps:.2f} fps")
        classificador = _carregar_classificador(config)
        quadros = ((camera, quadro, t_ms) for quadro, t_ms, _ in fonte)
        return _analisar(args, config, classificador, [camera], quadros)


def cmd_webcam(args) -> int:
    from entrada.fontes import FonteWebcam

    config = carregar_config(args.config)
    cameras = {c["nome"]: c for c in config["cameras"]}
    escolhidas = escolher_cameras(args.camera, cameras, config["camera_padrao"],
                                  interativo=sys.stdin.isatty())
    # O modelo carrega antes das câmeras: elas não ficam ligadas à toa enquanto ele carrega.
    classificador = _carregar_classificador(config)
    t0 = time.monotonic()  # relógio comum: as marcas de tempo das câmeras se comparam
    with ExitStack() as pilha:
        fontes = {
            nome: pilha.enter_context(FonteWebcam(
                cameras[nome]["dispositivo"], cameras[nome]["largura"], cameras[nome]["altura"],
                t0=t0))
            for nome in escolhidas
        }
        print(f"Analisando {', '.join(escolhidas)}. Pressione q numa janela ou Ctrl+C.")
        return _analisar(args, config, classificador, escolhidas,
                         _quadros_das_webcams(fontes, args.segundos))


def _silenciar_bibliotecas() -> None:
    """Corta o ruído no terminal sem esconder erros do programa.

    O TensorFlow é carregado junto com o MediaPipe e o modelo, e imprime avisos sobre
    GPU e CPU. O OpenCV não traz o plugin Wayland do Qt e avisa a cada janela antes de
    cair para o X11; com DISPLAY disponível, vai direto ao X11. Variáveis já definidas
    pelo usuário são respeitadas.
    """
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
    if os.environ.get("DISPLAY"):
        os.environ.setdefault("QT_QPA_PLATFORM", "xcb")


def main(argv=None) -> int:
    _silenciar_bibliotecas()
    argv = sys.argv[1:] if argv is None else list(argv)
    # Métricas em CSV (contrato metricas.v1) para as Partes 2 e 3: linha de comando própria.
    if argv[:1] == ["metricas"]:
        from entrada import metricas_cli
        return metricas_cli.main(argv[1:])
    if argv[:1] == ["comparar"]:
        from entrada import metricas_cli
        return metricas_cli.main(argv)
    parser = argparse.ArgumentParser(prog="python -m entrada", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=CAMINHO_CONFIG, help="arquivo de configuração")
    sub = parser.add_subparsers(dest="comando", required=True)

    # Só para aparecerem na ajuda: são tratados acima, por entrada/metricas_cli.py.
    sub.add_parser("metricas", add_help=False,
                   help="extrair métricas em CSV (contrato metricas.v1) para as Partes 2 e 3: "
                        "metricas video|webcam ...")
    sub.add_parser("comparar", add_help=False, help="comparar dois CSVs de métricas")

    p = sub.add_parser("video", help="analisar um arquivo de vídeo quadro a quadro")
    p.add_argument("video")
    p.add_argument("--camera", help="nome da câmera que gravou o vídeo, no terminal (padrão: rgb)")
    p.add_argument("--mostrar", action="store_true",
                   help="abrir a janela com o resultado e o mapeamento")
    p.add_argument("--sem-log", action="store_true",
                   help="não mostrar cada quadro, só os eventos e a média")
    p.set_defaults(func=cmd_video)

    p = sub.add_parser("webcam", help="analisar as webcams da configuração em tempo real")
    p.add_argument("--camera", action="append",
                   help="câmera da configuração (repetível) ou 'todas'; sem esta opção, "
                        "pergunta no terminal")
    p.add_argument("--segundos", type=float, help="parar depois deste tempo")
    p.add_argument("--sem-janela", action="store_true", help="analisar sem abrir a janela")
    p.add_argument("--mostrar", action="store_true", help="(a janela já abre por padrão)")
    p.add_argument("--sem-log", action="store_true",
                   help="não mostrar cada quadro, só os eventos e a média")
    p.set_defaults(func=cmd_webcam)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (OSError, ValueError) as erro:
        # Arquivo ausente, vídeo ilegível, câmera indisponível ou modelo ausente:
        # problemas de uso, que não precisam de traceback.
        print(f"erro: {erro}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
