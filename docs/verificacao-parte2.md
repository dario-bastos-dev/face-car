# Verificação da entrega · 29/10/2026

Base: [dario-bastos-dev/face-car](https://github.com/dario-bastos-dev/face-car),
commit `d58db78c9d1d4eb2b2ecd716f826e946217dc84c`.

## Resultados executados

| Verificação | Resultado |
| --- | --- |
| `python -m pytest -q -ra` | 178 aprovados, 8 ignorados, nenhuma falha |
| `npm test` | 51 aprovados, 1 ignorado, nenhuma falha |
| `uv lock --check` | Dependências e lock consistentes |
| Replay do CSV sintético | 268 mensagens, cinco estados exercitados |
| Validação de todas as mensagens do replay pelo JSON Schema | 268 válidas |
| Comando `calibrar` com dados sintéticos separados | Executou; MSE de PERCLOS 0.5 → 0.0; configuração exportada |

Os testes ignorados pertencem à Parte 1: seis testes precisam do vídeo e do modelo
do MediaPipe; dois testes de paridade do extrator precisam da preparação e de
`RODAR_PARIDADE=1`; um teste JavaScript precisa do vídeo e do ffprobe.
Nenhum teste da Parte 2 foi ignorado neste ambiente.

O teste integrado executou o mesmo fluxo de métricas, respostas, estados e mensagens
em Python e Node. Comparou cenário completo com e sem resposta do motorista e
sequência aleatória com semente fixa, usando tolerância numérica de `1e-9`.

## Cobertura funcional

- PERCLOS ponderado por duração, janela recortada e timestamps irregulares.
- Limiar exato de 80%, dois olhos, piscadas breves e fechamento prolongado.
- Aquecimento, perda de rosto, atraso, dados inválidos e expiração.
- Cada transição da tabela, limites de histerese, interrupção de condição e lacunas.
- Prazo de resposta, reconhecimento do motorista e intervenção somente com evidência.
- Sequência global, TTL, heartbeat, renovação de ações e esquema das mensagens.
- Calibração: melhoria, empate, piora, baixa cobertura e dados insuficientes.
- Linha de comando e proteção contra sobrescrever entradas ou truncar saídas ao
  receber parâmetros inválidos.

Também foram corrigidos dois detalhes nos testes existentes da Parte 1: leitura
de CSV com finais de linha Windows e declaração explícita dos pré-requisitos do
teste opcional de ffprobe. O extrator da Parte 1 não foi alterado.

## Limites da verificação

Os resultados são de testes de software e dados sintéticos. Não foram medidos
sensibilidade, falsos alarmes por hora ou atraso de detecção em motoristas reais.
Os limiares são uma baseline experimental e a ação de desaceleração destina-se
somente ao simulador. O trabalho de dados e validação populacional pertence à Parte 4.

A calibração está implementada e testada, mas não foi adotada para um motorista
real. A lógica de decisão e emissão foi portada para JavaScript; a seleção da
calibração continua offline em Python, exportando o mesmo JSON usado no navegador.
