// Ponto de entrada da Parte 4 no navegador: aplica o modelo treinado em
// treinamento/treinar.py (StandardScaler + LogisticRegression) exportado para JSON
// por treinamento/exportar_modelo.py em modelos/modelo_sonolencia.json:
//
//   { "versao": 1, "tipo": "regressao_logistica",
//     "atributos": ["ear", "perclos", "boca"],
//     "media": [...], "escala": [...], "coeficientes": [...], "intercepto": n }
//
// Sem esse arquivo, carregarModelo devolve null e a página mostra "ainda não treinado".
// A probabilidade é exibida no painel; ela ainda não comanda a política da Parte 2.

const numeros = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === "number" && Number.isFinite(x));

export async function carregarModelo(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const m = await r.json();
    const n = m.atributos?.length;
    if (m.versao !== 1 || m.tipo !== "regressao_logistica" || !n
      || !numeros(m.media, n) || !numeros(m.escala, n) || !numeros(m.coeficientes, n) || !Number.isFinite(m.intercepto)) {
      console.warn("modelo_sonolencia.json em formato inesperado; ignorado");
      return null;
    }
    return m;
  } catch { return null; }
}

// Atributos da janela atual, nos mesmos nomes do treino:
// ear = média dos dois olhos nas amostras válidas; perclos = do estimador; boca = média.
export function atributosDaJanela(historico, estimativa, janelaMs) {
  const fim = estimativa?.t_ms ?? historico.at(-1)?.t_ms ?? 0;
  let ear = 0, boca = 0, n = 0;
  for (const r of historico) {
    if (r.t_ms < fim - janelaMs || !r.rosto_visivel || r.ear_esq == null || r.ear_dir == null || r.abertura_boca == null) continue;
    ear += (r.ear_esq + r.ear_dir) / 2; boca += r.abertura_boca; n++;
  }
  if (!n || estimativa?.perclos == null) return null;
  return { ear: ear / n, perclos: estimativa.perclos, boca: boca / n };
}

export function preverModelo(modelo, historico, estimativa, janelaMs = 30000) {
  if (!modelo) return null;
  const x = atributosDaJanela(historico, estimativa, janelaMs);
  if (!x) return null;
  let z = modelo.intercepto;
  modelo.atributos.forEach((nome, i) => { z += modelo.coeficientes[i] * ((x[nome] - modelo.media[i]) / (modelo.escala[i] || 1)); });
  return 1 / (1 + Math.exp(-z));
}
