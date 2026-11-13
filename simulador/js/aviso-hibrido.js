// Reutiliza o aviso da câmera; não comanda níveis, métricas ou o veículo.
export const TEXTO_AVISO = "ALERTA — OLHOS FECHADOS / POSSÍVEL SONOLÊNCIA";

export function conectarAvisoHibrido(vigia, aviso) {
  let anterior = null;
  const limpar = () => {
    if (anterior && aviso.textContent === TEXTO_AVISO) {
      aviso.textContent = anterior.texto;
      aviso.hidden = anterior.oculto;
    }
    anterior = null;
  };
  vigia.on("monitorHibrido", (leitura) => {
    if (!leitura?.valido || !leitura.olhosFechados || !leitura.alerta) {
      limpar();
      return;
    }
    // Uma falha da câmera tem prioridade; não sobrescrever outro aviso.
    if (!aviso.hidden && aviso.textContent !== TEXTO_AVISO) return;
    anterior ??= { texto: aviso.textContent, oculto: aviso.hidden };
    aviso.textContent = TEXTO_AVISO;
    aviso.hidden = false;
  });
  vigia.on("cameraOff", limpar);
}
