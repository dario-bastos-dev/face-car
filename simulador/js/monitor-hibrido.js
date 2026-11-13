// Monitor adicional de fechamento prolongado dos olhos.
//
// Este módulo não calcula o índice, não altera a política de alertas e não
// combina probabilidades da CNN com EAR. Ele apenas transforma o EAR já
// calculado pelo MediaPipe em uma evidência temporal separada, usando os
// mesmos limites existentes em config/analise.json.

export class MonitorHibrido {
  constructor(limiares) {
    this.lim = limiares;
    this.reiniciar();
  }

  reiniciar() {
    this.desdeMs = null;
    this.alertou = false;
  }

  registrar(tMs, rostoVisivel, ear) {
    if (!rostoVisivel || ear == null || !Number.isFinite(ear)) {
      this.reiniciar();
      return { valido: false, olhosFechados: null, fechamentoContinuoMs: null, alerta: false, eventos: [] };
    }

    const fechados = ear < this.lim.ear_olho_fechado;
    if (!fechados) {
      const eventos = this.alertou ? ["olhos reabertos"] : [];
      this.reiniciar();
      return { valido: true, olhosFechados: false, fechamentoContinuoMs: 0, alerta: false, eventos };
    }

    this.desdeMs ??= tMs;
    const duracao = Math.max(0, tMs - this.desdeMs);
    const eventos = [];
    if (!this.alertou && duracao >= this.lim.olhos_fechados_alerta_ms) {
      this.alertou = true;
      eventos.push("olhos fechados por período prolongado");
    }
    return { valido: true, olhosFechados: true, fechamentoContinuoMs: duracao,
      alerta: this.alertou, eventos };
  }
}
