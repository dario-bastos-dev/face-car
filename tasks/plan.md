# Plano

## Mudança de direção (30/10/2026)

O projeto deixou de extrair métricas em CSV (EAR, abertura da boca, pose) e passou a capturar
recortes do rosto para treinar um modelo de imagens local. Foram removidos o contrato de
métricas, o cálculo, a comparação Python × navegador e a demo do navegador; o histórico está
no git até o commit 35efe13.

Decisões: modelo local a treinar; só o rosto recortado (o maior, para não gravar quem está ao
fundo); uma captura por intervalo fixo; nenhuma métrica gerada.

Das tarefas anteriores, T1 a T5 foram concluídas e T6, T8, T9 e T10 tratavam das métricas ou do
navegador e perderam o sentido.

## Pendentes

### C1 · Câmera configurável (vinda da antiga T11)

- [ ] Resolução, formato (MJPG) e fps da webcam na configuração; medir os q/s em 1280×720.
- [ ] Testar a câmera infravermelha (`--dispositivo 2`) com e sem óculos.

### C2 · Detalhes (vindos da antiga T7)

- [ ] Rever `requires-python` (hoje `<3.13` sem verificação).

### C3 · Atualizar os documentos em `detalhes/`

- [ ] `Contexto.md` e `Arquitetura.md` ainda descrevem métricas e a regra de não gravar vídeo;
      alinhar com a captura de recortes (decisão do autor dos documentos).
