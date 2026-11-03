import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from estimador import carregar_config, estimar
from estimador.__main__ import ler_csv, main
from estimador.mensagens import emitir, estado_emissor_inicial
from estimador.politica import estado_inicial, transicionar
from estimador.replay import reproduzir

RAIZ = Path(__file__).resolve().parents[2]


def comparar(a, b):
    if isinstance(a, dict):
        assert a.keys() == b.keys()
        for k in a:
            comparar(a[k], b[k])
    elif isinstance(a, list):
        assert len(a) == len(b)
        for x, y in zip(a, b):
            comparar(x, y)
    elif isinstance(a, (int, float)) and not isinstance(a, bool):
        assert a == pytest.approx(b, abs=1e-9, rel=1e-12)
    else:
        assert a == b


def test_paridade_completa_python_javascript():
    if not shutil.which("node"):
        pytest.skip("Node necessário para a paridade entre linguagens")
    cfg = carregar_config()
    metricas = ler_csv(RAIZ / "exemplos/parte2/metricas.csv")
    consultas = [{"t_ms": t} for t in range(0, 66001, 100)]
    casos = [{"metricas": metricas, "consultas": consultas},
             {"metricas": metricas, "consultas": [dict(c, resposta_motorista=c["t_ms"] == 12000)
                                                   for c in consultas]}]
    rng = random.Random(2026)
    aleatorias = []
    t = 0
    for _ in range(150):
        aleatorias.append({"t_ms": t, "rosto_visivel": rng.random() > .1,
            "ear_esq": rng.choice([.05, .1, .3, None]), "ear_dir": rng.choice([.05, .3]),
            "confianca": rng.choice([0, .4, .7, 1]), "atraso_ms": rng.choice([0, 600])})
        t += rng.choice([40, 100, 250, 500])
    casos.append({"metricas": aleatorias, "consultas": [{"t_ms": t} for t in range(0, t+1000, 100)]})
    proc = subprocess.run(["node", "scripts/paridade_estimador.mjs"], cwd=RAIZ,
        input=json.dumps({"config": cfg, "casos": casos}), capture_output=True, text=True, check=True)
    esperado = []
    for caso in casos:
        estado, emissor = estado_inicial(), estado_emissor_inicial("teste")
        saida = []
        for q in caso["consultas"]:
            agora = q["t_ms"]
            e = estimar([m for m in caso["metricas"] if m["t_ms"] <= agora], cfg, agora)
            estado = transicionar(estado, e, agora, cfg, q.get("resposta_motorista", False))
            emissor, mensagens = emitir(emissor, estado, e, agora, cfg)
            saida.append({"estimativa": e, "estado": estado, "mensagens": mensagens})
        esperado.append(saida)
    comparar(esperado, json.loads(proc.stdout))


def test_replay_limitado_equivale_historico_completo():
    cfg = carregar_config()
    metricas = ler_csv(RAIZ / "exemplos/parte2/metricas.csv")
    for registro in reproduzir(metricas, cfg):
        t = registro["estimativa"]["t_ms"]
        comparar(registro["estimativa"], estimar([m for m in metricas if m["t_ms"] <= t], cfg, t))


def test_replay_todos_estados_e_heartbeat_sem_camera():
    registros = list(reproduzir(ler_csv(RAIZ / "exemplos/parte2/metricas.csv"), carregar_config()))
    assert {r["estado"]["nome"] for r in registros} == {
        "NORMAL", "ATENCAO", "ALERTA", "INTERVENCAO", "DEGRADADO"}
    assert registros[-1]["estado"]["nome"] == "DEGRADADO"
    sinais = [m for r in registros for m in r["mensagens"]]
    assert [m["seq"] for m in sinais] == list(range(1, len(sinais)+1))
    assert any(m["tipo"] == "heartbeat" and m["ts"] > 65000 for m in sinais)
    assert all(m["acao"] != "desacelerar_simulado" for m in sinais if m["estado"] == "DEGRADADO")


def test_cli_replay(tmp_path):
    destino = tmp_path / "sinais.jsonl"
    proc = subprocess.run([sys.executable, "-m", "estimador", "replay",
        "exemplos/parte2/metricas.csv", "-o", str(destino)], cwd=RAIZ,
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert len([json.loads(l) for l in destino.read_text().splitlines()]) > 100


def test_cli_nao_sobrescreve_entrada(tmp_path):
    entrada = tmp_path / "metricas.csv"
    entrada.write_text("original", encoding="utf-8")
    assert main(["replay", str(entrada), "-o", str(entrada)]) == 2
    assert entrada.read_text() == "original"


def test_cli_entrada_invalida_preserva_saida(tmp_path):
    saida = tmp_path / "sinais.jsonl"
    saida.write_text("original", encoding="utf-8")
    assert main(["replay", str(RAIZ / "exemplos/parte2/metricas.csv"),
                 "--passo-ms", "0", "-o", str(saida)]) == 2
    assert saida.read_text() == "original"
