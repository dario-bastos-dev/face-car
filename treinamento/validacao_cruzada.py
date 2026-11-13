"""Validação cruzada por pessoa do notebook de treino: uma nota com gente nova que não depende de sorte.

    uv run python -m treinamento.validacao_cruzada --perfil generico   # configuração do notebook
    uv run python -m treinamento.validacao_cruzada --perfil v6         # como o V6, para comparar

Com um teste de 8 pessoas, a nota com gente nova variava 5 a 10 pontos de um treino para outro.
Aqui o notebook roda DOBRAS vezes (3, por padrão). Em cada uma, um terço das pessoas fica no teste,
de modo que cada pessoa cai no teste uma vez, e a média das dobras é a nota. Cada dobra treina o
modelo inteiro (~40 min sem GPU) e não mexe em modelo/. Os resultados ficam em
treinamento/resultados/validacao_cruzada/<perfil>/dobra<k>/; uma dobra já feita não roda de novo,
então dá para interromper e continuar depois.
"""

import argparse
import copy
import json
import statistics
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
NOTEBOOK = RAIZ / "treinamento" / "modelo.ipynb"
SAIDA = RAIZ / "treinamento" / "resultados" / "validacao_cruzada"

# Valores da célula de configuração que mudam em cada perfil (o resto é o do notebook).
PERFIS = {
    "generico": {},   # o notebook como está: contra a decoreba das pessoas (FaceCar_CNN_V7)
    "v6": {"MAX_POR_PESSOA_CLASSE": None, "FRACAO_LIBERADA": 0.4, "DROPOUT": 0.3,
           "DECAIMENTO_PESOS": 0.0, "AUMENTO_FORTE": False},
}


def sobrescrever_config(notebook: dict, valores: dict) -> dict:
    """Cópia do notebook com `valores` atribuídos no fim da primeira célula de código."""
    novo = copy.deepcopy(notebook)
    config = next(c for c in novo["cells"] if c["cell_type"] == "code")
    linhas = "".join(f"{nome} = {valor!r}\n" for nome, valor in valores.items())
    config["source"] = list(config["source"]) + ["\n\n# validacao_cruzada.py\n" + linhas]
    return novo


def _media(valores) -> dict:
    valores = [v for v in valores if v is not None]
    return {"media": round(statistics.mean(valores), 4),
            "desvio": round(statistics.pstdev(valores), 4) if len(valores) > 1 else 0.0,
            "dobras": valores}


def resumir(metricas: list) -> dict:
    """Média e desvio, entre as dobras, das notas das pessoas que a rede nunca viu."""
    novas = [m["pessoas_novas"] for m in metricas]
    alarme = [m["alarme_30_pessoas_novas"] for m in metricas]
    return {
        "acuracia_pessoas_novas": _media([n["acuracia"] for n in novas]),
        "recall_alerta": _media([n["recall"].get("alerta") for n in novas]),
        "recall_sonolento": _media([n["recall"].get("sonolento") for n in novas]),
        "alarme_30_recall_sonolento": _media([a["recall_sonolento"] for a in alarme]),
        "alarme_30_falso_alarme": _media([a["falso_alarme_alerta"] for a in alarme]),
    }


def _executar(notebook: dict, pasta: Path) -> None:
    """Roda o notebook pelo nbconvert, como treinar.sh, de dentro do projeto."""
    copia = pasta / "modelo_dobra.ipynb"
    copia.write_text(json.dumps(notebook, ensure_ascii=False), encoding="utf-8")
    subprocess.run(["uv", "run", "jupyter", "nbconvert", "--to", "notebook", "--execute", str(copia),
                    "--ExecutePreprocessor.timeout=-1", "--ExecutePreprocessor.kernel_name=python3",
                    "--output", "modelo_dobra_executado"], cwd=RAIZ, check=True)


def rodar(perfil: str, dobras: int = 3, saida: Path = SAIDA, notebook: dict | None = None) -> dict:
    """Roda as dobras que faltam do perfil e devolve o resumo de todas."""
    notebook = notebook or json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    metricas = []
    for k in range(dobras):
        pasta = Path(saida) / perfil / f"dobra{k}"
        arquivo = pasta / "metricas_teste.json"
        if not arquivo.exists():
            pasta.mkdir(parents=True, exist_ok=True)
            valores = {**PERFIS[perfil], "DOBRA": k, "DOBRAS": dobras, "SALVAR_MODELO": False,
                       "PASTA_SAIDA": str(pasta)}
            print(f"[{perfil}] dobra {k + 1} de {dobras}...", flush=True)
            _executar(sobrescrever_config(notebook, valores), pasta)
        metricas.append(json.loads(arquivo.read_text(encoding="utf-8")))
    resumo = {"perfil": perfil, "valores": PERFIS[perfil], **resumir(metricas)}
    (Path(saida) / perfil / "resumo.json").write_text(json.dumps(resumo, ensure_ascii=False, indent=2),
                                                      encoding="utf-8")
    return resumo


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--perfil", choices=sorted(PERFIS), default="generico")
    parser.add_argument("--dobras", type=int, default=3)
    args = parser.parse_args(argv)
    resumo = rodar(args.perfil, args.dobras)
    print(f"\n{args.perfil}: pessoas que a rede nunca viu, média (desvio) de {args.dobras} dobras")
    for nome, valor in resumo.items():
        if isinstance(valor, dict) and "media" in valor:
            print(f"  {nome:<28} {valor['media']:.1%} (± {valor['desvio']:.1%})  {valor['dobras']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
