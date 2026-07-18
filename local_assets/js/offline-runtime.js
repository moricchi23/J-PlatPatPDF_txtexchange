(() => {
'use strict';

const blobUrls = new Map();
const decodedPdfAssets = new Map();

function decodeBase64(value) {
  if (typeof value !== 'string' || !value) throw new Error('ローカル資産データがありません。');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function scriptBlobUrl(key, base64, suffix = '') {
  if (!blobUrls.has(key)) {
    const bytes = decodeBase64(base64);
    blobUrls.set(key, URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' })) + suffix);
  }
  return blobUrls.get(key);
}

function tesseractWorkerBlobUrl() {
  const key = 'tesseract-worker-with-tessdata';
  if (!blobUrls.has(key)) {
    const languageTable = JSON.stringify({
      jpn: window.__OFFLINE_TESSDATA_JPN__,
      eng: window.__OFFLINE_TESSDATA_ENG__
    });
    const bootstrap = `(() => {
  'use strict';
  const OFFLINE_TESSDATA = ${languageTable};
  function decode(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  self.fetch = async input => {
    const url = typeof input === 'string' ? input : String(input?.url || input || '');
    const prefix = 'offline-tessdata://local/';
    const suffix = '.traineddata.gz';
    if (!url.startsWith(prefix) || !url.endsWith(suffix)) {
      throw new TypeError('外部通信を遮断しました: ' + url);
    }
    const code = url.slice(prefix.length, -suffix.length);
    if (code !== 'jpn' && code !== 'eng') {
      throw new TypeError('許可されていないOCR言語です: ' + code);
    }
    const encoded = OFFLINE_TESSDATA[code];
    if (!encoded) return new Response(null, { status: 404 });
    return new Response(decode(encoded), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  };
})();
`;
    const coreBytes = decodeBase64(window.__OFFLINE_RUNTIME_BINARIES__.tesseractCore);
    const workerBytes = decodeBase64(window.__OFFLINE_RUNTIME_BINARIES__.tesseractWorker);
    blobUrls.set(key, URL.createObjectURL(new Blob([
      bootstrap,
      '\n/* Tesseract Core: same Worker blob for file:// compatibility */\n',
      coreBytes,
      '\n',
      workerBytes
    ], { type: 'text/javascript' })));
  }
  return blobUrls.get(key);
}

function pdfAsset(group, name) {
  const key = group + ':' + name;
  if (!decodedPdfAssets.has(key)) {
    const table = window.__OFFLINE_PDF_SUPPORT__?.[group];
    const encoded = table?.[name];
    if (!encoded) throw new Error('PDF補助データがありません: ' + name);
    decodedPdfAssets.set(key, decodeBase64(encoded));
  }
  return decodedPdfAssets.get(key);
}

class CMapReaderFactory {
  async fetch({ name }) {
    return {
      cMapData: pdfAsset('cmaps', name),
      compressionType: window.pdfjsLib.CMapCompressionType.BINARY
    };
  }
}

class StandardFontDataFactory {
  async fetch({ filename }) {
    return pdfAsset('fonts', filename);
  }
}

window.OfflineRuntime = Object.freeze({
  getPdfWorkerUrl() {
    return scriptBlobUrl('pdf-worker', window.__OFFLINE_RUNTIME_BINARIES__.pdfWorker);
  },
  getTesseractWorkerUrl() {
    return tesseractWorkerBlobUrl();
  },
  CMapReaderFactory,
  StandardFontDataFactory
});
})();
