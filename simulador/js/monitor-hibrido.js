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
    this.ultimoValidoMs = null;
  }

  // Perdas curtas do rosto (até perda_rosto_tolerancia_ms, padrão 1 s: a cabeça caindo de sono, um
  // quadro ruim) não zeram um fechamento em andamento: emEspera indica que ele continua contando se
  // o rosto voltar com os olhos ainda fechados. Perdas maiores reiniciam.
  registrar(tMs, rostoVisivel, ear) {
    if (!rostoVisivel || ear == null || !Number.isFinite(ear)) {
      const tolerancia = this.lim.perda_rosto_tolerancia_ms ?? 1000;
      const emEspera = this.desdeMs != null && this.ultimoValidoMs != null && tMs - this.ultimoValidoMs <= tolerancia;
      if (!emEspera) this.reiniciar();
      return { valido: false, olhosFechados: null, fechamentoContinuoMs: null, alerta: emEspera && this.alertou,
        emEspera, eventos: [] };
    }
    this.ultimoValidoMs = tMs;

    const fechados = ear < this.lim.ear_olho_fechado;
    if (!fechados) {
      const eventos = this.alertou ? ["olhos reabertos"] : [];
      this.reiniciar();
      this.ultimoValidoMs = tMs;
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
