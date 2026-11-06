// MediaPipe Face Landmarker num Web Worker (script clássico), fora da thread da animação.
//
// Na thread da página, cada quadro custava de 60 a 85 ms e travava a 2D e a 3D. Aqui a página só
// copia o quadro da câmera (createImageBitmap, ~0,3 ms) e o transfere; o worker devolve os pontos do
// rosto e, quando pedido, o mesmo quadro reduzido em RGB para o modelo CNN.
//
// Mensagens recebidas:
//   { tipo: "iniciar", bundle, wasm, modelo, opcoes }
//   { tipo: "quadro", id, bmp, cnn }   cnn = tamanho de entrada do CNN, ou 0 se não precisa agora
// Mensagens enviadas:
//   { tipo: "pronto", delegate } | { tipo: "erro", erro, id? }
//   { tipo: "resultado", id, faceLandmarks, matrizes, cnn }   cnn = ArrayBuffer (8 bytes livres + RGB)

let landmarker = null, ultimoTs = 0, tela = null, ctx = null;

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

// Quadro inteiro (sem espelhar) reduzido a tamanho x tamanho, em RGB, depois de 8 bytes livres
// para a marca de tempo que a página escreve antes de mandar ao servidor.
function quadroCnn(bmp, S) {
  if (!tela || tela.width !== S) { tela = new OffscreenCanvas(S, S); ctx = tela.getContext("2d", { willReadFrequently: true }); }
  ctx.drawImage(bmp, 0, 0, S, S);
  const rgba = ctx.getImageData(0, 0, S, S).data, buf = new ArrayBuffer(8 + S * S * 3), rgb = new Uint8Array(buf, 8);
  for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2]; }
  return buf;
}

function quadro({ id, bmp, cnn }) {
  try {
    // o MediaPipe exige marcas estritamente crescentes, inclusive entre sessões do scanner
    ultimoTs = Math.max(ultimoTs + 1, Math.round(performance.now()));
    const r = landmarker.detectForVideo(bmp, ultimoTs);
    const buf = cnn ? quadroCnn(bmp, cnn) : null;
    postMessage({ tipo: "resultado", id, faceLandmarks: r.faceLandmarks, matrizes: r.facialTransformationMatrixes ?? [], cnn: buf },
      buf ? [buf] : []);
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
