"""Replay CSV e avaliação opcional de calibração, sem MediaPipe ou câmera."""

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from entrada.contrato import ler_metricas
from .config import PADRAO, carregar_config


def ler_csv(caminho):
    return [asdict(m) for m in ler_metricas(caminho)]


def gravar_json(caminho, conteudo):
    caminho = Path(caminho)
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(conteudo, ensure_ascii=False, indent=2, allow_nan=False)
                       + "\n", encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="comando", required=True)
    replay = sub.add_parser("replay", help="CSV da Parte 1 -> sinais JSONL para Parte 3")
    replay.add_argument("metricas")
    replay.add_argument("--config", default=PADRAO)
    replay.add_argument("-o", "--saida", required=True)
    replay.add_argument("--diagnostico", help="JSONL com estimativas e estados em cada tick")
    replay.add_argument("--respostas", help="JSON com lista de timestamps (ms) das respostas")
    replay.add_argument("--sessao", default="replay")
    replay.add_argument("--passo-ms", type=int, default=100)
    replay.add_argument("--cauda-ms", type=int, default=1000)
    calib = sub.add_parser("calibrar", help="avaliar calibração alerta em casos separados")
    calib.add_argument("alerta", help="CSV de motorista confirmado alerta")
    calib.add_argument("validacao", help="JSON com casos e perclos_esperado independente")
    calib.add_argument("--config", default=PADRAO)
    calib.add_argument("-o", "--saida", required=True, help="config adotada (ou original)")
    calib.add_argument("--relatorio", required=True)
    args = parser.parse_args(argv)
    try:
        config = carregar_config(args.config)
        saidas = [Path(args.saida).resolve()]
        entradas = [Path(args.config).resolve()]
        if args.comando == "calibrar":
            saidas.append(Path(args.relatorio).resolve())
            entradas += [Path(args.alerta).resolve(), Path(args.validacao).resolve()]
        else:
            entradas.append(Path(args.metricas).resolve())
            if args.diagnostico:
                saidas.append(Path(args.diagnostico).resolve())
            if args.respostas:
                entradas.append(Path(args.respostas).resolve())
        if len(set(saidas)) != len(saidas) or set(saidas) & set(entradas):
            raise ValueError("Arquivos de entrada e saída devem ser distintos")
        if args.comando == "calibrar":
            from .calibracao import avaliar_calibracao
            casos = json.loads(Path(args.validacao).read_text(encoding="utf-8-sig"))
            resultado = avaliar_calibracao(ler_csv(args.alerta), casos, config)
            gravar_json(args.saida, resultado["config"])
            gravar_json(args.relatorio, resultado)
            print(f"Calibração adotada: {resultado['adotada']}. Relatório: {args.relatorio}")
            return 0
        from contextlib import ExitStack
        from .replay import reproduzir
        metricas = ler_csv(args.metricas)
        respostas = (json.loads(Path(args.respostas).read_text(encoding="utf-8-sig"))
                     if args.respostas else [])
        registros = reproduzir(metricas, config, passo_ms=args.passo_ms,
                               cauda_ms=args.cauda_ms, respostas=respostas,
                               sessao=args.sessao)
        # Valida a entrada e os parâmetros antes de abrir/truncar saídas.
        from itertools import chain
        primeiro = next(registros)
        n = 0
        with ExitStack() as stack:
            Path(args.saida).parent.mkdir(parents=True, exist_ok=True)
            arquivo = stack.enter_context(open(args.saida, "w", encoding="utf-8"))
            diagnostico = None
            if args.diagnostico:
                Path(args.diagnostico).parent.mkdir(parents=True, exist_ok=True)
                diagnostico = stack.enter_context(open(args.diagnostico, "w", encoding="utf-8"))
            for registro in chain([primeiro], registros):
                for mensagem in registro["mensagens"]:
                    arquivo.write(json.dumps(mensagem, ensure_ascii=False, allow_nan=False) + "\n")
                    n += 1
                if diagnostico:
                    diagnostico.write(json.dumps(registro, ensure_ascii=False, allow_nan=False) + "\n")
        print(f"{n} mensagens em {args.saida}")
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f"Erro: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
