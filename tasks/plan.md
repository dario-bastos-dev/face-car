# Plano: correções da revisão do extrator de métricas

Origem: revisão de código de 29/10/2026 sobre `entrada/`, `demo-navegador/` e `scripts/`.

## T1 · Alinhar quadros e marcas de tempo entre Python e navegador
- [x] `extrair_navegador.mjs` lê o fps do vídeo com `ffprobe` quando `--fps` não é passado, e falha com mensagem clara se não conseguir.
- [x] Python e JS calculam `t_ms` com o mesmo arredondamento (metade para cima).
- [x] `comparar` alerta, e a linha de comando sai com código 1, quando os números de quadros diferem ou o `t_ms` de um quadro comum diverge.
- [x] Vídeo a 25 fps volta a dar 100% de concordância de rosto.

## T2 · `t_ms` e `atraso_ms` da webcam no navegador seguem o contrato
- [x] `t_ms` vem do instante de captura (`metadata.captureTime`, ou o `now` do callback quando não houver).
- [x] `atraso_ms` mede da captura até o resultado.
- [x] `t_ms` começa na captura do primeiro quadro, e a captura nunca é posterior ao callback.

## T3 · Servidor local robusto
- [ ] URL malformada responde 400 sem derrubar o processo.
- [ ] `Range` com sufixo (`bytes=-N`) e fim além do tamanho são tratados ou recusados com 416.

## T4 · Falha da página encerra a extração automática
- [ ] Erro em `app.js` marca a página; `extrair_navegador.mjs` falha logo com a mensagem.

## T5 · Webcam liberada pela própria thread de captura
- [ ] `release()` só acontece depois que a leitura terminou.

## T6 · Testes da linha de comando
- [ ] `python -m entrada video` e `comparar` cobertos por testes que rodam por padrão.

## T7 · Detalhes
- [x] Sobreposição não quebra sem matriz de pose.
- [ ] `CalculadoraMetricas` recebe os índices por argumento (núcleo sem leitura de disco).
- [ ] Rever `requires-python` e permitir rodar `gerar_casos.py` sem `PYTHONPATH`.

## T8 · Sugestões da segunda revisão
- [ ] Paridade a 25 fps é pulada, e não falha, quando falta `retrato25.mp4`.
- [ ] `comparar` sem quadros em comum vira ALERTA com código 1, sem traceback.
- [ ] `test_comparar.py` usa `pytest.approx` direto, sem o auxiliar `pytest_approx`.
- [ ] README avisa que `preparar.sh` vem antes do `pytest`.
- [ ] Registrar os números corretos da paridade: pitch tem média de 0,125° a 30 fps, e não abaixo de 0,1° como diz o commit f75d9ca.
