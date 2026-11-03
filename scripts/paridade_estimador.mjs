// Protocolo de teste: recebe um objeto JSON pela entrada padrão e devolve JSON.
// Não lê câmera, não inicia servidor e não consulta relógio real.
import { readFileSync } from "node:fs";
import { estimar } from "../demo-navegador/estimador.js";
import { estadoInicial, transicionar } from "../demo-navegador/politica.js";
import { estadoEmissorInicial, emitir } from "../demo-navegador/mensagens.js";

try {
  const { config, casos } = JSON.parse(readFileSync(0, "utf8"));
  const resultado = casos.map(({ metricas, consultas, sessao = "teste" }) => {
    let estado = estadoInicial();
    let emissor = estadoEmissorInicial(sessao);
    return consultas.map(({ t_ms, resposta_motorista = false }) => {
      const estimativa = estimar(metricas.filter((m) => m.t_ms <= t_ms), config, t_ms);
      estado = transicionar(estado, estimativa, t_ms, config, resposta_motorista);
      let mensagens;
      [emissor, mensagens] = emitir(emissor, estado, estimativa, t_ms, config);
      return { estimativa, estado, mensagens };
    });
  });
  process.stdout.write(JSON.stringify(resultado));
} catch (erro) {
  process.stderr.write(`${erro.message}\n`);
  process.exitCode = 1;
}
