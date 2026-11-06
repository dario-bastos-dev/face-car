// MediaPipe Face Landmarker num Web Worker (script clássico), fora da thread da animação.
//
// Na thread da página, cada quadro custava de 60 a 85 ms e travava a 2D e a 3D. Aqui a página só
// copia o quadro da câmera (createImageBitmap, ~0,3 ms) e o transfere; o worker devolve os pontos do
// rosto. O quadro do modelo CNN é capturado à parte, em cnn.js.
//
// Mensagens recebidas:
//   { tipo: "iniciar", bundle, wasm, modelo, opcoes }
//   { tipo: "quadro", id, bmp }
// Mensagens enviadas:
//   { tipo: "pronto", delegate } | { tipo: "erro", erro, id? }
//   { tipo: "resultado", id, faceLandmarks, matrizes }

let landmarker = null, ultimoTs = 0;

// O pacote do MediaPipe é publicado como ESM e como CommonJS; um worker clássico não importa ESM e o
// CDN serve o .cjs com um tipo que o importScripts recusa, então o código é lido e avaliado aqui.
function carregarBundle(url) {
  const x = new XMLHttpRequest();
  x.open("GET", url, false); x.send();
  if (x.status !== 200) throw new Error(`MediaPipe: HTTP ${x.status}`);
  const module = { exports: {} };
  new Function("module", "exports", x.responseText)(module, module.exports);
  return module.exports;
}

async function iniciar({ bundle, wasm, modelo, opcoes }) {
  const { FaceLandmarker, FilesetResolver } = carregarBundle(bundle);
  const arquivos = await FilesetResolver.forVisionTasks(wasm);
  const com = (delegate) => ({ ...opcoes, baseOptions: { modelAssetPath: modelo, delegate } });
  let delegate = "GPU";
  try { landmarker = await FaceLandmarker.createFromOptions(arquivos, com("GPU")); }
  catch { delegate = "CPU"; landmarker = await FaceLandmarker.createFromOptions(arquivos, com("CPU")); }
  postMessage({ tipo: "pronto", delegate });
}

function quadro({ id, bmp }) {
  try {
    // o MediaPipe exige marcas estritamente crescentes, inclusive entre sessões do scanner
    ultimoTs = Math.max(ultimoTs + 1, Math.round(performance.now()));
    const r = landmarker.detectForVideo(bmp, ultimoTs);
    postMessage({ tipo: "resultado", id, faceLandmarks: r.faceLandmarks, matrizes: r.facialTransformationMatrixes ?? [] });
  } catch (e) {
    postMessage({ tipo: "erro", id, erro: String(e?.message || e) });
  } finally {
    bmp.close();
  }
}

onmessage = (e) => {
  if (e.data.tipo === "iniciar") iniciar(e.data).catch((er) => postMessage({ tipo: "erro", erro: String(er?.message || er) }));
  else if (e.data.tipo === "quadro") quadro(e.data);
};
