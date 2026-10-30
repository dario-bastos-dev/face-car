# Demonstração da Parte 2

Todos os dados desta pasta são **sintéticos**, preparados para exercitar a lógica.
Não são gravações de motoristas nem avaliação de desempenho em pessoas.

- `metricas.csv`: 65 segundos, amostras a cada 100 ms; olhos fechados entre 6 e 18 s,
  rosto ausente entre 43 e 45 s e interrupção dos dados após 65 s.
- `sinais.jsonl`: 268 mensagens geradas pela configuração padrão, sem respostas.
- `respostas.json`: resposta do motorista aos 12 s, para testar a renovação do prazo.
- `calibracao-alerta.csv` e `validacao-calibracao.json`: dados sintéticos separados
  para demonstrar o critério de adoção de uma calibração.

Na raiz do projeto, depois de instalar as dependências:

```bash
python -m estimador replay exemplos/parte2/metricas.csv -o saidas/sinais.jsonl --diagnostico saidas/diagnostico.jsonl
python -m estimador replay exemplos/parte2/metricas.csv --respostas exemplos/parte2/respostas.json -o saidas/sinais-com-resposta.jsonl
python -m estimador calibrar exemplos/parte2/calibracao-alerta.csv exemplos/parte2/validacao-calibracao.json -o saidas/config-calibrada.json --relatorio saidas/calibracao.json
```

O último comando demonstra uma melhora construída no exemplo; a configuração
padrão não é alterada. Use `--config saidas/config-calibrada.json` explicitamente
se quiser executar um replay com essa configuração de demonstração.

Transições esperadas do primeiro comando, sem resposta:

| Tempo (s) | Estado |
| --- | --- |
| 0.0 | DEGRADADO |
| 3.3 | NORMAL |
| 8.1 | ATENCAO |
| 9.7 | ALERTA |
| 14.7 | INTERVENCAO |
| 29.7 | ATENCAO |
| 43.0 | DEGRADADO |
| 47.0 | NORMAL |
| 65.3 | DEGRADADO |

O heartbeat continua durante a cauda de 1 segundo após a última métrica.
