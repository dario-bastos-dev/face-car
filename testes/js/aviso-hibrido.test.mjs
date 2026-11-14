import test from "node:test";
import assert from "node:assert/strict";
import { conectarAvisoHibrido, TEXTO_AVISO } from "../../simulador/js/aviso-hibrido.js";

test("aviso usa evento existente, recupera e não interfere em erros da câmera", () => {
  const handlers = {};
  const aviso = { hidden: true, textContent: "" };
  conectarAvisoHibrido({ on: (nome, fn) => { handlers[nome] = fn; } }, aviso);
  const alerta = { valido: true, olhosFechados: true, alerta: true };
  handlers.monitorHibrido(alerta);
  assert.equal(aviso.hidden, false);
  assert.equal(aviso.textContent, TEXTO_AVISO);
  handlers.monitorHibrido(alerta);
  handlers.monitorHibrido({ valido: true, olhosFechados: false, alerta: false });
  assert.equal(aviso.hidden, true);
  handlers.monitorHibrido(alerta);
  handlers.monitorHibrido({ valido: false });
  assert.equal(aviso.hidden, true);
  handlers.monitorHibrido(alerta);
  handlers.cameraOff();
  assert.equal(aviso.hidden, true);
  aviso.hidden = false;
  aviso.textContent = "Erro da câmera";
  handlers.monitorHibrido(alerta);
  handlers.monitorHibrido({ valido: false });
  assert.equal(aviso.textContent, "Erro da câmera");
  assert.equal(aviso.hidden, false);
});
