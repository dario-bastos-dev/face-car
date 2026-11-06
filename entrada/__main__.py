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
from dataclasses import dataclass, field

import cv2

from entrada.classificador import (ClassificadorSonolencia, MediaTemporal, Resultado, formatar,
                                   formatar_classe, formatar_saida)
from entrada.contexto import CAMINHO_CONFIG, RAIZ, carregar_config, carregar_pontos_rosto, numero
from entrada.pressao import Fusao, PressaoBaixa, SensorPressao
from entrada.rosto import EstadoRosto, LimiaresRosto, MonitorRosto, desenhar_mapa, formatar_estado

JANELA = "analise (q para sair)"


@dataclass
class Analise:
    """O que se sabe de um quadro: o resultado dele, a média da janela, o rosto e o sensor.

    Sem o motorista na câmera (`visivel` falso), não há resultado, média nem índice.
    """

    resultado: Resultado | None          # saída do modelo neste quadro
    resumo: Resultado | None             # média das probabilidades na janela
    qps: float                           # quadros por segundo na janela
    rosto: object | None                 # Rosto do detector, para o mapeamento
    estado: EstadoRosto | None           # olhos, boca, cabeça e eventos da geometria
    mostrar_resumo: bool                 # hora de mostrar a média no terminal
    visivel: bool = True                 # motorista na câmera
    indice: float | None = None          # índice de sonolência (modelo, volante e cabeça)
    pressao_baixa_ms: int | None = None  # há quanto tempo a pressão está abaixo do limiar
    pressao: int | None = None           # última leitura do sensor na janela
    em_alerta: bool = False              # alerta de sonolência ativo
    eventos: list = field(default_factory=list)  # visibilidade, volante e alertas
    bonus_cabeca: float = 0.0            # somado ao índice pela cabeça baixa prolongada
    bonus_volante: float = 0.0           # somado ao índice pela pressão baixa prolongada


class Analisador:
    """Analisa os quadros de uma câmera: modelo, rosto, sensor de pressão e alerta.

    O detector de rosto decide se o motorista está na câmera; sem ele no quadro, o
    modelo não é chamado, o sensor é ignorado e nenhum alerta é gerado. Com ele, o
    modelo recebe o quadro inteiro, e a fusão parte da média do modelo e soma um bônus se
    a pressão no volante estiver baixa há muito tempo e outro se a cabeça estiver. Sem
    detector (testes), todo quadro conta como visível.
    """

    def __init__(self, classificador, detector=None, janela_ms: int = 2000,
                 intervalo_terminal_ms: int = 1000, monitor: MonitorRosto | None = None,
                 sensor: SensorPressao | None = None, fusao: Fusao | None = None,
                 pressao_baixa: PressaoBaixa | None = None):
        self.classificador = classificador
        self.detector = detector
        self.monitor = monitor
        self.sensor = sensor
        self.fusao = fusao
        self.pressao_baixa = pressao_baixa
        self.janela_ms = janela_ms
        self.media = MediaTemporal(janela_ms)
        self.intervalo_terminal_ms = intervalo_terminal_ms
        self._ultimo_resumo = None
        self._visivel = None

    def processar(self, quadro, t_ms: int) -> Analise:
        """Analisa um quadro. A imagem do modelo sai antes de qualquer desenho na janela."""
        rosto = self.detector.detectar(quadro, t_ms) if self.detector is not None else None
        visivel = self.detector is None or rosto is not None
        estado = self.monitor.atualizar(t_ms, rosto) if self.monitor is not None else None
        mostrar_resumo = (self._ultimo_resumo is None
                          or t_ms - self._ultimo_resumo >= self.intervalo_terminal_ms)
        if mostrar_resumo:
            self._ultimo_resumo = t_ms
        eventos = self._mudanca_de_visibilidade(visivel)
        if not visivel:
            if self.pressao_baixa is not None:
                self.pressao_baixa.reiniciar(t_ms)   # o volante só conta com o motorista à vista
            return Analise(None, None, 0.0, None, estado, mostrar_resumo, visivel=False,
                           eventos=eventos)

        resultado = self.classificador.classificar(quadro)
        self.media.adicionar(t_ms, resultado)
        resumo, qps = self.media.resumo()
        pressao = baixa_ms = None
        if self.sensor is not None:
            leituras = self.sensor.leituras_desde(t_ms - self.janela_ms)
            pressao = leituras[-1][1] if leituras else None
            if self.pressao_baixa is not None:
                if leituras:
                    baixa_ms, eventos_volante = self.pressao_baixa.atualizar(leituras, t_ms)
                    eventos += eventos_volante
                else:
                    self.pressao_baixa.reiniciar(t_ms)   # sensor mudo: não dá para saber
        indice, em_alerta, bonus_volante, bonus_cabeca = None, False, 0.0, 0.0
        if self.fusao is not None:
            frouxo = self.pressao_baixa is not None and self.pressao_baixa.prolongada(baixa_ms)
            cabeca_baixa = estado is not None and estado.cabeca_baixa_prolongada
            indice, alertas = self.fusao.atualizar(resumo.probabilidades.get("sonolento", 0.0),
                                                   frouxo, cabeca_baixa)
            eventos += alertas
            em_alerta = self.fusao.em_alerta
            bonus_volante, bonus_cabeca = self.fusao.bonus(frouxo, cabeca_baixa)
        return Analise(resultado, resumo, qps, rosto, estado, mostrar_resumo, True, indice,
                       baixa_ms, pressao, em_alerta, eventos, bonus_cabeca, bonus_volante)

    def _mudanca_de_visibilidade(self, visivel: bool) -> list:
        """Eventos quando o motorista sai ou volta; ao sair, o alerta é suspenso."""
        anterior, self._visivel = self._visivel, visivel
        if visivel == anterior:
            return []
        if not visivel:
            if self.fusao is not None:
                self.fusao.pausar()
            return ["motorista não visível: análise pausada"]
        return ["motorista visível: análise retomada"] if anterior is False else []


def desenhar(quadro, resumo, rosto=None, pontos_rosto=None, estado=None, analise=None):
    """Mostra o resultado do modelo, o índice, o sensor, olhos, boca e o mapeamento do rosto.

    O texto da janela fica sem acentos: as fontes do OpenCV não os desenham.
    """
    if analise is not None and not analise.visivel:
        linhas = ["motorista nao visivel: sem analise"]
    else:
        linhas = [f"modelo: {formatar_classe(resumo)}" if resumo else "modelo: ..."]
    if analise is not None and analise.indice is not None:
        linhas.append(("ALERTA: SONOLENCIA" if analise.em_alerta else "estado: alerta")
                      + f"  (indice {numero(analise.indice, '.2f')})")
    if analise is not None and analise.pressao is not None:
        linhas.append(f"volante: {analise.pressao}")
    if analise is not None and analise.bonus_volante:
        linhas.append(f"volante frouxo: +{numero(analise.bonus_volante, '.2f')}")
    if analise is not None and analise.bonus_cabeca:
        linhas.append(f"cabeca baixa: +{numero(analise.bonus_cabeca, '.2f')}")
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
    """Linhas de um quadro: a saída do modelo, o rosto e o volante (salvo --sem-log), os
    eventos e, uma vez por segundo, a média e o índice de sonolência."""
    instante = f"[{camera} {_segundos(t_ms, 3)}]"
    segundo = f"[{camera} {_segundos(t_ms)}]"
    linhas = []
    if not sem_log:
        if not analise.visivel:
            linhas.append(f"{instante} motorista não visível: sem análise")
        else:
            rosto = f" | {formatar_estado(analise.estado)}" if analise.estado is not None else ""
            volante = ""
            if analise.pressao is not None:
                baixa = analise.pressao_baixa_ms
                tempo = f" (baixo há {baixa // 1000} s)" if baixa is not None and baixa >= 1000 else ""
                volante = f" | volante {analise.pressao}{tempo}"
            linhas.append(f"{instante} {formatar_saida(analise.resultado)}{rosto}{volante}")
    if analise.estado is not None:
        linhas += [f"{instante} evento: {evento}" for evento in analise.estado.eventos]
    linhas += [f"{instante} evento: {evento}" for evento in analise.eventos]
    if analise.mostrar_resumo:
        if not analise.visivel:
            linhas.append(f"{segundo} motorista não visível: análise pausada")
            return linhas
        taxa = f"  · {numero(analise.qps, '.0f')} q/s" if analise.qps else ""
        linhas.append(f"{segundo} média {janela_s} s: {formatar(analise.resumo)}{taxa}")
        if analise.indice is not None:
            p_sono = analise.resumo.probabilidades.get("sonolento", 0.0)
            volante = (f" · volante frouxo +{numero(analise.bonus_volante, '.2f')}"
                       if analise.bonus_volante else "")
            cabeca = (f" · cabeça baixa +{numero(analise.bonus_cabeca, '.2f')}"
                      if analise.bonus_cabeca else "")
            estado = "SONOLÊNCIA" if analise.em_alerta else "alerta"
            linhas.append(f"{segundo} índice de sonolência {numero(analise.indice, '.2f')} "
                          f"(modelo {numero(p_sono, '.2f')}{volante}{cabeca}) → {estado}")
    return linhas


def _abrir_sensor(config: dict, relogio_ms) -> SensorPressao | None:
    """O sensor da configuração, ou None com um aviso se a porta não abrir."""
    cfg = config["sensor"]
    try:
        sensor = SensorPressao(cfg["porta"], cfg["baud"], relogio_ms)
    except OSError as erro:
        print(f"aviso: sensor de pressão indisponível em {cfg['porta']} ({erro}); "
              f"analisando só com o modelo", file=sys.stderr)
        return None
    print(f"Sensor de pressão em {cfg['porta']} ({cfg['baud']} baud); abaixo de "
          f"{cfg['limiar_sonolencia']} por "
          f"{numero(cfg['pressao_baixa_alerta_ms'] / 1000, 'g')} s é sinal de sonolência.")
    return sensor


def _analisar(args, config: dict, classificador, cameras: list, quadros, sensor=None) -> int:
    """Laço comum aos dois comandos, para uma ou várias câmeras.

    `quadros` entrega (camera, quadro, t_ms). Cada câmera tem a própria média e, com
    janela, o próprio detector, porque o MediaPipe acompanha o rosto de um quadro para
    o seguinte. Termina quando os quadros acabam, com q numa janela ou com Ctrl+C.
    """
    from entrada.rosto import DetectorRosto

    mostrar = janela_ativa(args)
    cfg = config["classificador"]
    limiares = LimiaresRosto(**config["rosto"])
    janela_s = numero(cfg["janela_ms"] / 1000, "g")
    pontos_rosto = carregar_pontos_rosto()
    with ExitStack() as pilha:
        analisadores = {
            camera: Analisador(classificador, pilha.enter_context(DetectorRosto(config)),
                               cfg["janela_ms"], cfg["intervalo_terminal_ms"],
                               MonitorRosto(limiares, pontos_rosto), sensor,
                               Fusao(**config["fusao"]),
                               PressaoBaixa(config["sensor"]["limiar_sonolencia"],
                                            config["sensor"]["pressao_baixa_alerta_ms"]))
            for camera in cameras
        }
        avisou_sensor = False
        try:
            for camera, quadro, t_ms in quadros:
                if sensor is not None and not sensor.ativo and not avisou_sensor:
                    print("aviso: o sensor de pressão parou (cabo desconectado?); seguindo só "
                          "com o modelo", file=sys.stderr)
                    avisou_sensor = True
                analise = analisadores[camera].processar(quadro, t_ms)
                linhas = _linhas_do_terminal(camera, t_ms, analise, args.sem_log, janela_s)
                if linhas:
                    print("\n".join(linhas), flush=True)
                if mostrar:
                    imagem = desenhar(quadro, analise.resumo, analise.rosto, pontos_rosto,
                                      analise.estado, analise)
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
    t0 = time.monotonic()  # relógio comum: câmeras e sensor se comparam pelo t_ms

    def relogio_ms():
        return (time.monotonic() - t0) * 1000

    if args.porta_sensor:
        config["sensor"]["porta"] = args.porta_sensor
    with ExitStack() as pilha:
        sensor = None if args.sem_sensor else _abrir_sensor(config, relogio_ms)
        if sensor is not None:
            pilha.enter_context(sensor)
        fontes = {
            nome: pilha.enter_context(FonteWebcam(
                cameras[nome]["dispositivo"], cameras[nome]["largura"], cameras[nome]["altura"],
                t0=t0))
            for nome in escolhidas
        }
        print(f"Analisando {', '.join(escolhidas)}. Pressione q numa janela ou Ctrl+C.")
        return _analisar(args, config, classificador, escolhidas,
                         _quadros_das_webcams(fontes, args.segundos), sensor)


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
    p.add_argument("--porta-sensor",
                   help="porta serial do sensor de pressão FSR402 (padrão: config, sensor.porta)")
    p.add_argument("--sem-sensor", action="store_true",
                   help="analisar sem o sensor de pressão, só com o modelo")
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
