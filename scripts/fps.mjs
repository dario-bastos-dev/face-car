// Taxa de quadros de um vídeo pelo ffprobe. O navegador não expõe o fps, e o
// extrator em Python usa o do próprio arquivo; os dois precisam do mesmo valor
// para que o índice de cada quadro aponte para o mesmo instante.
import { execFileSync } from "node:child_process";

// "30000/1001" → 29.97…; "25" → 25. Falha se a taxa for nula ou ilegível.
export function interpretarTaxa(texto) {
  const [num, den = "1"] = String(texto).split("/");
  const fps = Number(num) / Number(den);
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`fps inválido: "${texto}"`);
  return fps;
}

// Usa avg_frame_rate e, se vier vazia, r_frame_rate, como o OpenCV.
export function fpsDoVideo(caminho) {
  let saida;
  try {
    saida = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json", caminho,
    ], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (erro) {
    throw new Error(`Não foi possível ler o fps de ${caminho} com o ffprobe; ` +
      `passe --fps. (${erro.stderr?.toString().trim() || erro.message})`);
  }
  const fluxo = JSON.parse(saida).streams?.[0];
  if (!fluxo) throw new Error(`Sem faixa de vídeo para ler o fps em ${caminho}; passe --fps.`);
  try {
    return interpretarTaxa(fluxo.avg_frame_rate);
  } catch {
    return interpretarTaxa(fluxo.r_frame_rate);
  }
}
