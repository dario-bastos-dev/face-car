"""Validação cruzada por pessoa (treinamento/validacao_cruzada.py), sem treinar nada."""

import json

import pytest

from treinamento import validacao_cruzada as vc


def test_valores_entram_no_fim_da_celula_de_configuracao():
    notebook = {"cells": [{"cell_type": "markdown", "source": ["# t"]},
                          {"cell_type": "code", "source": ["DOBRA = None\n", "SALVAR_MODELO = True"]},
                          {"cell_type": "code", "source": ["print(DOBRA)"]}]}
    novo = vc.sobrescrever_config(notebook, {"DOBRA": 2, "SALVAR_MODELO": False, "PASTA_SAIDA": "/x"})
    config = "".join(novo["cells"][1]["source"])
    escopo = {}
    exec(config, escopo)
    assert (escopo["DOBRA"], escopo["SALVAR_MODELO"], escopo["PASTA_SAIDA"]) == (2, False, "/x")
    assert novo["cells"][2] == notebook["cells"][2]
    assert "".join(notebook["cells"][1]["source"]) == "DOBRA = None\nSALVAR_MODELO = True"   # original intacto


def test_perfis_comparaveis():
    # o perfil do V6 desliga exatamente o que o V7 acrescentou
    assert vc.PERFIS["generico"] == {}
    assert set(vc.PERFIS["v6"]) == {"MAX_POR_PESSOA_CLASSE", "FRACAO_LIBERADA", "DROPOUT",
                                    "DECAIMENTO_PESOS", "AUMENTO_FORTE"}


def dobra(acuracia, recall_alarme, falso):
    return {"pessoas_novas": {"acuracia": acuracia, "recall": {"alerta": 0.9, "sonolento": acuracia - 0.1}},
            "alarme_30_pessoas_novas": {"recall_sonolento": recall_alarme, "falso_alarme_alerta": falso}}


def test_resumo_da_media_e_o_desvio_das_dobras():
    resumo = vc.resumir([dobra(0.70, 0.8, 0.1), dobra(0.80, 0.9, 0.2), dobra(0.90, 1.0, 0.3)])
    acuracia = resumo["acuracia_pessoas_novas"]
    assert acuracia["media"] == pytest.approx(0.8) and acuracia["desvio"] == pytest.approx(0.0816, abs=1e-4)
    assert acuracia["dobras"] == [0.7, 0.8, 0.9]
    assert resumo["recall_sonolento"]["media"] == pytest.approx(0.7)
    assert resumo["alarme_30_recall_sonolento"]["media"] == pytest.approx(0.9)
    assert resumo["alarme_30_falso_alarme"]["media"] == pytest.approx(0.2)


def test_dobra_ja_feita_nao_roda_de_novo(tmp_path, monkeypatch):
    feita = tmp_path / "generico" / "dobra1"
    feita.mkdir(parents=True)
    (feita / "metricas_teste.json").write_text(json.dumps(dobra(0.8, 0.9, 0.1)))
    rodadas = []
    monkeypatch.setattr(vc, "_executar", lambda notebook, pasta: rodadas.append(pasta.name) or
                        (pasta / "metricas_teste.json").write_text(json.dumps(dobra(0.7, 0.8, 0.1))))
    resumo = vc.rodar("generico", dobras=3, saida=tmp_path, notebook={"cells": [{"cell_type": "code", "source": [""]}]})
    assert rodadas == ["dobra0", "dobra2"]
    assert resumo["acuracia_pessoas_novas"]["dobras"] == [0.7, 0.8, 0.7]
