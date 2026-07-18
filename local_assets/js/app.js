(() => {
'use strict';

// -----------------------------------------------------------------------------
// 設定・状態
// -----------------------------------------------------------------------------

const APP_CONFIG = Object.freeze({
  pdfjsVersion: '3.11.174',
  defaultOutputName: 'patent_publication_txt.txt',
  previewLimit: 22000,
  ocrRenderScale: 3.2,
  maxFiRows: 12,
  scriptLoadTimeoutMs: 20000
});

const BIBLIOGRAPHY_FIELDS = Object.freeze([
  '登録番号', '登録日', '発行日', '公開番号', '公開日',
  '出願番号', '出願日', '審査請求日', '発明の名称',
  '識別番号', '出願人', '特許権者', '発明者', '代理人',
  'IPC', 'FI', 'テーマコード', 'Fターム'
]);

const OUTPUT_FIELDS = Object.freeze({
  registered: Object.freeze([
    '登録番号', '登録日', '発行日', '公開番号', '公開日',
    '出願番号', '出願日', '審査請求日', '発明の名称',
    '識別番号', '特許権者', '発明者', '代理人',
    'IPC', 'FI', 'テーマコード', 'Fターム'
  ]),
  published: Object.freeze([
    '公開番号', '公開日', '出願番号', '出願日', '発明の名称',
    '識別番号', '出願人', '発明者', '代理人',
    'IPC', 'FI', 'テーマコード', 'Fターム'
  ])
});

const REQUIRED_BIBLIOGRAPHY_FIELDS = Object.freeze({
  registered: Object.freeze([
    '登録番号', '登録日', '発行日', '出願番号', '出願日',
    '審査請求日', '発明の名称', '特許権者', 'IPC', 'FI'
  ]),
  published: Object.freeze([
    '公開番号', '公開日', '出願番号', '出願日', '発明の名称',
    '出願人', 'IPC', 'FI', 'テーマコード'
  ])
});

const LOCAL_DEPENDENCIES = Object.freeze({
  pdfjs: '3.11.174',
  tesseract: '5.1.1',
  tesseractCore: '5.1.1',
  tessdata: '4.0.0'
});

const els = Object.freeze({
  drop: document.getElementById('dropZone'),
  input: document.getElementById('fileInput'),
  ocrRead: document.getElementById('ocrReadBtn'),
  ocrReadIcon: document.getElementById('ocrReadIcon'),
  ocrReadLabel: document.getElementById('ocrReadLabel'),
  download: document.getElementById('downloadBtn'),
  clear: document.getElementById('clearBtn'),
  fileName: document.getElementById('fileName'),
  log: document.getElementById('log'),
  preview: document.getElementById('preview'),
  summary: document.getElementById('summary'),
  includeBibliography: document.getElementById('includeBibliography'),
  ocrDetails: document.getElementById('ocrDetails'),
  ocrRaw: document.getElementById('ocrRaw'),
  classOcrRaw: document.getElementById('classOcrRaw'),
  ocrImages: document.getElementById('ocrImages')
});

let pdfjsReadyPromise = null;
let tesseractReadyPromise = null;
let ocrWorkerPromise = null;
let currentOcrStage = '';
let lastOcrProgress = -1;
let lastOcrError = '';

let selectedFile = null;
let convertedText = '';
let currentResult = null;
let outputFileName = APP_CONFIG.defaultOutputName;
let isConverting = false;
let conversionQueued = false;
let selectionVersion = 0;

class ConversionSupersededError extends Error {
  constructor() {
    super('新しいPDFが選択されたため、以前の変換を終了しました。');
    this.name = 'ConversionSupersededError';
  }
}

bindEvents();
void ensurePdfJsReady();

// -----------------------------------------------------------------------------
// UI・イベント
// -----------------------------------------------------------------------------

function bindEvents() {
  for (const eventName of ['dragenter', 'dragover']) {
    els.drop.addEventListener(eventName, event => {
      event.preventDefault();
      els.drop.classList.add('dragover');
    });
  }

  for (const eventName of ['dragleave', 'drop']) {
    els.drop.addEventListener(eventName, event => {
      event.preventDefault();
      els.drop.classList.remove('dragover');
    });
  }

  els.drop.addEventListener('drop', event => {
    setFile(event.dataTransfer?.files?.[0]);
  });

  els.input.addEventListener('change', event => {
    setFile(event.target.files?.[0]);
    // 同じPDFを選び直してもchangeが発火するようにリセットする。
    event.target.value = '';
  });

  els.download.addEventListener('click', downloadTxt);
  els.ocrRead.addEventListener('click', runBibliographyOcr);
  els.includeBibliography.addEventListener('change', () => {
    if (!currentResult?.ocrCompleted) return;
    refreshOutputFromState();
    log(
      els.includeBibliography.checked
        ? 'TXT出力を書誌事項付きに切り替えました。'
        : 'TXT出力を本文のみに戻しました。',
      'status-ok'
    );
  });
  els.clear.addEventListener('click', clearApplication);
}

function log(message, type = '') {
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const line = document.createElement('span');
  if (type) line.className = type;
  line.textContent = `[${time}] ${message}`;
  els.log.append(line, document.createTextNode('\n'));
  els.log.scrollTop = els.log.scrollHeight;
}

function setOcrButtonState(state) {
  const states = {
    idle: { icon: '◎', label: '書誌事項OCR読取', title: '書誌事項OCRは未実行です' },
    running: { icon: '…', label: 'OCR読取中…', title: '書誌事項OCRを実行しています' },
    complete: { icon: '✓', label: '書誌事項OCR読取済み', title: '書誌事項OCRは完了しています。押すと再実行します' },
    error: { icon: '↻', label: 'OCR読取を再試行', title: '前回のOCR読取に失敗しました。押すと再試行します' }
  };
  const next = states[state] || states.idle;
  els.ocrRead.dataset.state = state in states ? state : 'idle';
  els.ocrRead.classList.toggle('is-complete', state === 'complete');
  els.ocrRead.classList.toggle('is-error', state === 'error');
  els.ocrReadIcon.textContent = next.icon;
  els.ocrReadLabel.textContent = next.label;
  els.ocrRead.title = next.title;
}

function resetResultView({ clearLog = false } = {}) {
  convertedText = '';
  currentResult = null;
  lastOcrError = '';
  setOcrButtonState('idle');
  els.ocrRead.disabled = true;
  els.download.disabled = true;
  els.includeBibliography.checked = false;
  els.includeBibliography.disabled = true;
  els.preview.value = '';
  els.summary.replaceChildren();
  resetOcrDebug();
  if (clearLog) els.log.textContent = '';
}

function clearApplication() {
  selectionVersion += 1;
  selectedFile = null;
  conversionQueued = false;
  outputFileName = APP_CONFIG.defaultOutputName;
  els.fileName.textContent = 'PDF未選択';
  els.input.value = '';
  resetResultView({ clearLog: true });
}

function isPdfFile(file) {
  return Boolean(file) && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

function setFile(file) {
  if (!isPdfFile(file)) {
    alert('PDFファイルを選択してください。');
    return;
  }

  selectionVersion += 1;
  selectedFile = file;
  outputFileName = `${file.name.replace(/\.pdf$/i, '')}_txt.txt`;
  els.fileName.textContent = file.name;
  resetResultView();

  log(`選択: ${file.name}`);
  log('PDFはブラウザ内でのみ処理されます。');

  if (isConverting) {
    conversionQueued = true;
    log('現在の処理を終了後、選択したPDFの変換を開始します。', 'status-warn');
    return;
  }

  log('OCRを使わず、本文の自動変換を開始します...', 'status-ok');
  queueMicrotask(convertSelectedPdf);
}

function ensureCurrentSelection(version) {
  if (!selectedFile || version !== selectionVersion) {
    throw new ConversionSupersededError();
  }
}

// -----------------------------------------------------------------------------
// 外部ライブラリ読込
// -----------------------------------------------------------------------------

function ensurePdfJsReady() {
  if (window.pdfjsLib && window.OfflineRuntime) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = window.OfflineRuntime.getPdfWorkerUrl();
    return Promise.resolve(true);
  }

  if (!pdfjsReadyPromise) {
    pdfjsReadyPromise = Promise.resolve(false);
    log('ローカル版PDF.jsを読み込めませんでした。フォルダー構成を確認してください。', 'status-bad');
  }
  return pdfjsReadyPromise;
}

// -----------------------------------------------------------------------------
// 変換パイプライン
// -----------------------------------------------------------------------------

async function convertSelectedPdf() {
  if (!selectedFile) return;
  if (isConverting) {
    conversionQueued = true;
    return;
  }

  const file = selectedFile;
  const runVersion = selectionVersion;
  let pdf = null;

  isConverting = true;
  conversionQueued = false;
  resetResultView();

  try {
    const ready = await ensurePdfJsReady();
    if (!ready || !window.pdfjsLib) throw new Error('PDF.jsが読み込まれていません');
    ensureCurrentSelection(runVersion);

    pdf = await loadPdfDocument(file);
    ensureCurrentSelection(runVersion);
    log(`ページ数: ${pdf.numPages}`, 'status-ok');

    const extraction = await extractAllPages(pdf, runVersion);
    if (extraction.itemTotal === 0) {
      throw new Error('PDF内部テキストを取得できませんでした。本文も画像化されたPDFには対応していません。');
    }

    log('本文を整形中...');
    const body = buildBodyText(extraction.pages);
    currentResult = {
      runVersion,
      pageCount: pdf.numPages,
      itemTotal: extraction.itemTotal,
      lineTotal: extraction.lineTotal,
      extraction,
      body,
      bibliography: null,
      ocrSource: {},
      ocrFilledCount: 0,
      ocrCompleted: false
    };
    refreshOutputFromState();
    els.ocrRead.disabled = false;
    log('本文の変換が完了しました。OCRは実行していません。', 'status-ok');
    log('書誌事項が必要な場合は「書誌事項OCR読取」を押してください。');
  } catch (error) {
    if (error instanceof ConversionSupersededError) {
      log(error.message, 'status-warn');
    } else {
      console.error(error);
      log(`エラー: ${error.message || error}`, 'status-bad');
      alert(`変換に失敗しました。\n${error.message || error}`);
    }
  } finally {
    if (pdf?.destroy) {
      try {
        await pdf.destroy();
      } catch (error) {
        console.warn('PDFリソースの解放に失敗しました。', error);
      }
    }

    isConverting = false;
    const shouldRunQueued = conversionQueued && selectedFile && runVersion !== selectionVersion;
    conversionQueued = false;

    if (shouldRunQueued) {
      log('新しく選択されたPDFの変換を開始します...', 'status-ok');
      queueMicrotask(convertSelectedPdf);
    }
  }
}

async function runBibliographyOcr() {
  if (!selectedFile || !currentResult || currentResult.runVersion !== selectionVersion || isConverting) return;

  const file = selectedFile;
  const state = currentResult;
  const runVersion = selectionVersion;
  let pdf = null;

  isConverting = true;
  conversionQueued = false;
  els.ocrRead.disabled = true;
  els.includeBibliography.disabled = true;
  resetOcrDebug();
  setOcrButtonState('running');
  log('書誌事項OCR読取を開始します。', 'status-ocr');

  try {
    const ready = await ensurePdfJsReady();
    if (!ready || !window.pdfjsLib) throw new Error('PDF.jsが読み込まれていません');
    ensureCurrentSelection(runVersion);

    pdf = await loadPdfDocument(file);
    ensureCurrentSelection(runVersion);

    log('書誌事項の内部テキストを確認中...');
    const bibliography = extractBibliography(state.extraction.pages[0]?.lines || []);
    const isOldTwoColumn = state.extraction.twoColumnPages > 0;
    if (isOldTwoColumn) {
      bibliography.__oldTwoColumn = true;
      delete bibliography['テーマコード'];
      delete bibliography['Fターム'];
      log('旧形式の2段組公報を検出しました。テーマコード・Fタームは読取対象外です。', 'status-ok');
    }
    const ocrSource = {};
    const ocrFilledCount = await complementBibliographyWithOcr(
      pdf,
      state.extraction.pages[0],
      bibliography,
      ocrSource,
      runVersion,
      { skipThemeCode: isOldTwoColumn }
    );
    ensureCurrentSelection(runVersion);

    if (lastOcrError) {
      state.ocrCompleted = false;
      els.includeBibliography.checked = false;
      setOcrButtonState('error');
      refreshOutputFromState();
      return;
    }

    // 旧形式公報は1ページ目の書誌欄が画像のため、OCR結果に加えて、
    // 最終頁「フロントページの続き」と2ページ目以降のヘッダーも利用する。
    const supplemented = supplementFromFrontPageContinuation(state.extraction.pages, bibliography);
    if (supplemented) {
      log(`「フロントページの続き」から${supplemented}項目を補完しました。`, 'status-ok');
    }
    supplementBibliographyFromPageHeader(bibliography, state.extraction.pageHeader, ocrSource);
    validateBibliographicNumbers(bibliography);
    reportBibliographyStatus(bibliography);

    state.bibliography = bibliography;
    state.ocrSource = ocrSource;
    state.ocrFilledCount = ocrFilledCount;
    state.ocrCompleted = true;
    els.includeBibliography.checked = true;
    els.includeBibliography.disabled = false;
    setOcrButtonState('complete');
    refreshOutputFromState();
    log('書誌事項OCR読取が完了し、TXT出力へ書誌事項を追加しました。', 'status-ok');
  } catch (error) {
    if (error instanceof ConversionSupersededError) {
      log(error.message, 'status-warn');
    } else {
      console.error(error);
      setOcrButtonState('error');
      log(`書誌事項OCR読取エラー: ${error.message || error}`, 'status-bad');
      alert(`書誌事項OCR読取に失敗しました。\n${error.message || error}`);
    }
  } finally {
    if (pdf?.destroy) {
      try {
        await pdf.destroy();
      } catch (error) {
        console.warn('PDFリソースの解放に失敗しました。', error);
      }
    }

    isConverting = false;
    const shouldRunQueued = conversionQueued && selectedFile && runVersion !== selectionVersion;
    conversionQueued = false;

    if (shouldRunQueued) {
      log('新しく選択されたPDFの変換を開始します...', 'status-ok');
      queueMicrotask(convertSelectedPdf);
    } else if (currentResult === state && runVersion === selectionVersion) {
      els.ocrRead.disabled = false;
      els.includeBibliography.disabled = !state.ocrCompleted;
      els.download.disabled = !convertedText;
    }
  }
}

async function loadPdfDocument(file) {
  const data = await file.arrayBuffer();
  log('PDF読み込み開始...');

  try {
    return await openPdf(data, false);
  } catch (error) {
    log(`Workerあり読み込み失敗: ${error.message || error}`, 'status-warn');
    log('Workerなしで再試行します...');
    return openPdf(data, true);
  }
}

async function extractAllPages(pdf, runVersion) {
  const pages = [];
  let itemTotal = 0;
  let lineTotal = 0;
  let pageHeader = '';
  let twoColumnPages = 0;

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    ensureCurrentSelection(runVersion);
    log(`${pageNo}/${pdf.numPages} ページを抽出中...`);

    const page = await pdf.getPage(pageNo);
    const pageData = await extractPageLines(page, pageNo);
    itemTotal += pageData.rawItemCount;
    lineTotal += pageData.lines.length;
    // 旧形式は1ページ目のヘッダーが画像のため、2ページ目以降のヘッダーで公開番号を補完する。
    if (pageData.header && !pageHeader) pageHeader = pageData.header;
    if (pageData.twoColumn) twoColumnPages += 1;
    pages.push(pageData);

    log(`  items ${pageData.rawItemCount.toLocaleString('ja-JP')} / lines ${pageData.lines.length.toLocaleString('ja-JP')}${pageData.twoColumn ? '（2段組）' : ''}`);
  }

  if (twoColumnPages) {
    log(`2段組レイアウトを検出: ${twoColumnPages}ページ（左段→右段の順に読み取り）`, 'status-ok');
  }

  return { pages, itemTotal, lineTotal, pageHeader, twoColumnPages };
}

async function complementBibliographyWithOcr(pdf, firstPageData, bibliography, ocrSource, runVersion, options = {}) {
  lastOcrError = '';

  try {
    ensureCurrentSelection(runVersion);
    log(
      options.skipThemeCode
        ? '1ページ目の書誌事項・IPC・FIをOCRします（テーマコードは旧2段組のため対象外）。'
        : '1ページ目の書誌事項・IPC・FI・テーマコードをOCRします。',
      'status-ocr'
    );

    const firstPage = await pdf.getPage(1);
    const regions = await renderOcrRegions(firstPage, firstPageData);
    ensureCurrentSelection(runVersion);
    showOcrImages(regions, options);

    const worker = await getOcrWorker();
    const ocrResult = await recognizeOcrRegions(worker, regions, options);
    ensureCurrentSelection(runVersion);

    const parsed = parseOcrResult(ocrResult);
    const filledCount = mergeOcrBibliography(bibliography, parsed, ocrSource);
    updateOcrDebug(ocrResult);

    const filled = Object.keys(ocrSource);
    log(
      filled.length ? `OCR取得: ${filled.join('、')}` : 'OCRでは書誌事項を追加取得できませんでした。',
      filled.length ? 'status-ok' : 'status-warn'
    );
    return filledCount;
  } catch (error) {
    if (error instanceof ConversionSupersededError) throw error;
    console.error(error);
    lastOcrError = String(error?.message || error || '原因不明');
    log(`OCR処理に失敗しました: ${lastOcrError}`, 'status-bad');
    if (els.ocrRaw) els.ocrRaw.textContent = `【OCRエラー】\n${lastOcrError}`;
    if (els.ocrDetails) els.ocrDetails.hidden = false;
    log('内部テキストで取得できた内容のみで変換を続行します。', 'status-warn');
    return 0;
  } finally {
    try {
      await releaseOcrWorker();
    } catch (error) {
      console.warn('OCR Workerの終了に失敗しました。', error);
    }
  }
}

async function recognizeOcrRegions(worker, regions, options = {}) {
  const biblioRaw = await recognizeCanvas(worker, regions.biblio, '書誌事項', {
    tessedit_pageseg_mode: getPsmValue('SPARSE_TEXT', '11'),
    preserve_interword_spaces: '1'
  });

  const ipcRaw = await recognizeCanvas(worker, regions.ipc, 'IPC', {
    tessedit_pageseg_mode: getPsmValue('SINGLE_BLOCK', '6'),
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/().,- '
  });

  const fiRaw = await recognizeFiRobust(worker, regions.fi);

  const themeCodeRaw = options.skipThemeCode
    ? ''
    : await recognizeCanvas(worker, regions.themeCode, 'テーマコード', {
      tessedit_pageseg_mode: getPsmValue('SINGLE_BLOCK', '6'),
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '
    });

  return { biblioRaw, ipcRaw, fiRaw, themeCodeRaw, themeCodeSkipped: Boolean(options.skipThemeCode) };
}

function parseOcrResult({ biblioRaw, ipcRaw, fiRaw, themeCodeRaw }) {
  const bibliography = parseOcrBibliography(biblioRaw);
  const ipc = parseIpcOcr(ipcRaw);
  const fi = parseFiOcr(fiRaw, ipc);
  const themeCode = parseThemeCodeOcr(themeCodeRaw);

  if (ipc) bibliography.IPC = ipc;
  if (fi) bibliography.FI = fi;
  if (themeCode) bibliography['テーマコード'] = themeCode;
  return bibliography;
}

function updateOcrDebug({ biblioRaw, ipcRaw, fiRaw, themeCodeRaw, themeCodeSkipped = false }) {
  els.ocrRaw.textContent = biblioRaw.trim() || '（OCR結果なし）';
  els.classOcrRaw.textContent = [
    `【IPC】\n${ipcRaw.trim() || '（OCR結果なし）'}`,
    `【FI】\n${fiRaw.trim() || '（OCR結果なし）'}`,
    `【テーマコード】\n${themeCodeSkipped ? '（旧2段組公報のため読取対象外）' : (themeCodeRaw.trim() || '（OCR結果なし）')}`
  ].join('\n\n');
  els.ocrDetails.hidden = false;
}

function reportBibliographyStatus(bibliography) {
  if (bibliography.__skipped) {
    log('書誌事項を取得できなかったため、書誌事項欄はスキップ表示になります。', 'status-warn');
    return;
  }

  const registered = isRegisteredBibliography(bibliography);
  let required = registered
    ? REQUIRED_BIBLIOGRAPHY_FIELDS.registered
    : REQUIRED_BIBLIOGRAPHY_FIELDS.published;
  if (bibliography.__oldTwoColumn) {
    required = required.filter(key => key !== 'テーマコード' && key !== 'Fターム');
  }
  const missing = required.filter(key => !bibliography[key]);

  if (missing.length) {
    log(`書誌事項の一部は取得できませんでした: ${missing.join('、')}`, 'status-warn');
  } else {
    log(registered ? '特許登録公報の書誌事項を取得しました。' : '公開特許公報の書誌事項を取得しました。', 'status-ok');
  }
}

// -----------------------------------------------------------------------------
// OCR Worker・認識実行
// -----------------------------------------------------------------------------

async function initTesseract() {
  if (window.Tesseract && window.OfflineRuntime) {
    log(`Tesseract.js読み込み済み（完全ローカル版 ${LOCAL_DEPENDENCIES.tesseract}）`, 'status-ok');
    return true;
  }
  log('ローカル版Tesseract.jsを読み込めませんでした。フォルダー構成を確認してください。', 'status-bad');
  return false;
}

async function getOcrWorker() {
  if (!tesseractReadyPromise) {
    tesseractReadyPromise = initTesseract().then(ok => {
      if (!ok) tesseractReadyPromise = null;
      return ok;
    }, error => {
      tesseractReadyPromise = null;
      throw error;
    });
  }

  const ready = await tesseractReadyPromise;
  if (!ready || !window.Tesseract) {
    throw new Error('Tesseract.jsを読み込めませんでした');
  }

  if (!ocrWorkerPromise) {
    ocrWorkerPromise = window.Tesseract.createWorker('jpn+eng', 1, {
      workerPath: window.OfflineRuntime.getTesseractWorkerUrl(),
      workerBlobURL: false,
      langPath: 'offline-tessdata://local',
      cacheMethod: 'none',
      gzip: true,
      logger: message => {
        if (message.status !== 'recognizing text') return;

        const percent = Math.round((message.progress || 0) * 100);
        if (percent === 100 || percent >= lastOcrProgress + 20) {
          lastOcrProgress = percent;
          log(`  ${currentOcrStage} OCR認識中... ${percent}%`, 'status-ocr');
        }
      }
    }).catch(error => {
      ocrWorkerPromise = null;
      throw error;
    });
  }

  return ocrWorkerPromise;
}

function getPsmValue(name, fallback) {
  return window.Tesseract?.PSM?.[name] ?? fallback;
}

async function releaseOcrWorker() {
  if (!ocrWorkerPromise) return;
  try {
    const worker = await ocrWorkerPromise;
    await worker.terminate();
  } finally {
    ocrWorkerPromise = null;
  }
}

async function recognizeCanvas(worker, canvas, stage, parameters) {
  currentOcrStage = stage;
  lastOcrProgress = -1;
  log(`${stage} OCRを開始...`, 'status-ocr');
  await worker.setParameters(parameters);
  const result = await worker.recognize(canvas);
  return result?.data?.text || '';
}

async function recognizeFiRobust(worker, canvas) {
  const common = {
    preserve_interword_spaces: '1',
    // OCR結果は通常半角になるが、原稿上の全角・半角、大文字・小文字の混在を許容する。
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/.,():;-_ '
  };

  // まず欄全体を2方式で認識する。SINGLE_BLOCKは行構造、SPARSE_TEXTは
  // 大きな文字間隔や離れた付加記号（G、103E等）の補完に向く。
  const blockRaw = await recognizeCanvas(worker, canvas, 'FI（複数段）', {
    ...common,
    tessedit_pageseg_mode: getPsmValue('SINGLE_BLOCK', '6')
  });
  const sparseRaw = await recognizeCanvas(worker, canvas, 'FI（間隔補正）', {
    ...common,
    tessedit_pageseg_mode: getPsmValue('SPARSE_TEXT', '11')
  });

  // 欄全体OCRでは見出し直下の最上段が見出し・ノイズ扱いされることがある。
  // そこで画像中の文字行を検出し、最上段を専用に、さらに各段を1行ずつOCRする。
  const rowEntries = extractFiRowCanvases(canvas, 0.16)
    .slice(0, APP_CONFIG.maxFiRows);
  const lineRaws = [];
  if (rowEntries.length) {
    const topRaw = await recognizeCanvas(worker, rowEntries[0].canvas, 'FI（最上段専用）', {
      ...common,
      tessedit_pageseg_mode: getPsmValue('SINGLE_LINE', '7')
    });
    if (topRaw) lineRaws.push(topRaw);

    for (let i=1; i<rowEntries.length; i++) {
      const rowRaw = await recognizeCanvas(worker, rowEntries[i].canvas, `FI（行別 ${i+1}/${rowEntries.length}）`, {
        ...common,
        tessedit_pageseg_mode: getPsmValue('SINGLE_LINE', '7')
      });
      if (rowRaw) lineRaws.push(rowRaw);
    }
  }

  // 全体認識・最上段専用・行別認識の結果をすべて解析側へ渡し、重複は後段で除去する。
  return [blockRaw, sparseRaw, ...lineRaws].filter(Boolean).join('\n');
}

// -----------------------------------------------------------------------------
// OCR画像生成・前処理
// -----------------------------------------------------------------------------

async function renderOcrRegions(page, pageData) {
  const renderScale = APP_CONFIG.ocrRenderScale;
  const viewport = page.getViewport({ scale: renderScale });
  const full = document.createElement('canvas');
  full.width = Math.ceil(viewport.width);
  full.height = Math.ceil(viewport.height);
  const ctx = full.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, full.width, full.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const marker = (pageData?.lines || []).find(l => /【要約】|【特許請求の範囲】|【発明の詳細な説明】/.test(l.text));
  const bodyTopRatio = marker && pageData?.height ? (pageData.height - marker.y) / pageData.height : 0.57;
  const biblioBottom = Math.min(0.66, Math.max(0.52, bodyTopRatio + 0.035));

  return {
    biblio: cropOcrCanvas(full, 0.045, 0.02, 0.955, biblioBottom, 1.05, 1.28),
    ipc: cropOcrCanvas(full, 0.055, 0.155, 0.405, 0.31, 2.05, 1.75),
    // FI欄は上側を広めに仮取得した後、上部の長い横罫線を基準に自動トリミングする。
    // これにより「FI」を左上に置きつつ、最上段の上側へ十分な白余白を確保する。
    // 下方向も広く取得し、FIが複数段ある公報に対応する。
    fi: makeFiOcrCanvas(full),
    // 公開公報では「テーマコード（参考）」が右欄に掲載される。
    // 登録公報など、掲載がない場合は空画像となり、解析結果も空欄のままとする。
    themeCode: cropOcrCanvas(full, 0.69, 0.16, 0.955, 0.245, 2.35, 1.7)
  };
}

function copyCanvasRegion(source, sx, sy, sw, sh, padding = 0) {
  const x = Math.max(0, Math.floor(sx));
  const y = Math.max(0, Math.floor(sy));
  const width = Math.max(1, Math.min(source.width - x, Math.ceil(sw)));
  const height = Math.max(1, Math.min(source.height - y, Math.ceil(sh)));
  const pad = Math.max(0, Math.round(padding));
  const out = document.createElement('canvas');
  out.width = width + pad * 2;
  out.height = height + pad * 2;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, x, y, width, height, pad, pad, width, height);
  return out;
}

function findLongHorizontalRuleBands(canvas, maxYRatio = 1) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const maxY = Math.max(1, Math.min(canvas.height, Math.floor(canvas.height * maxYRatio)));
  const active = [];
  for (let y=0; y<maxY; y++) {
    let dark = 0;
    const row = y * canvas.width * 4;
    for (let x=0; x<canvas.width; x++) {
      const i = row + x * 4;
      const lum = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
      if (lum < 145) dark++;
    }
    active.push(dark >= canvas.width * 0.48);
  }
  const bands = [];
  let start = -1;
  for (let y=0; y<=active.length; y++) {
    if (y<active.length && active[y]) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      bands.push({ start, end:y-1, height:y-start });
      start = -1;
    }
  }
  return bands;
}

function eraseLongHorizontalRules(canvas) {
  const bands = findLongHorizontalRuleBands(canvas, 1);
  if (!bands.length) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  bands.forEach(band => {
    const margin = Math.max(2, Math.round(canvas.height * 0.004));
    const y = Math.max(0, band.start - margin);
    const h = Math.min(canvas.height - y, band.height + margin * 2);
    ctx.fillRect(0, y, canvas.width, h);
  });
}

function makeFiOcrCanvas(source) {
  // 公報ごとの上下位置差を吸収するため、最初は上側・下側とも広めに取得する。
  // 左端はIPCの日付欄が混ざらず、FI見出しの左側に余白が残る位置に限定する。
  const raw = cropOcrCanvas(source, 0.365, 0.115, 0.70, 0.39, 2.55, 1.0, true);

  // 上部の二重罫線を分類欄の上端、次の二重罫線を分類欄の下端として利用する。
  // 罫線間だけを切り出すことで、FIの下にある請求項数・出願人等を行別OCRへ混入させない。
  const allRules = findLongHorizontalRuleBands(raw, 1);
  const topRules = allRules.filter(rule => rule.start < raw.height * 0.45);
  const separator = topRules.length ? topRules[topRules.length - 1] : null;
  const gap = Math.max(10, Math.round(raw.height * 0.012));
  const startY = separator ? Math.min(raw.height - 1, separator.end + gap) : 0;
  const lowerRule = allRules.find(rule => rule.start > startY + raw.height * 0.20);
  const endY = lowerRule ? Math.max(startY + 1, lowerRule.start - gap) : raw.height;
  let fi = copyCanvasRegion(raw, 0, startY, raw.width, endY - startY, Math.round(raw.width * 0.018));

  // OCR前に残った長い横罫線を白く除去する。文字中の短い横棒やスラッシュは除去しない。
  eraseLongHorizontalRules(fi);
  enhanceCanvas(fi, 1.82);
  eraseLongHorizontalRules(fi);
  return fi;
}

function detectFiTextBands(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const rows = [];
  const minDark = Math.max(5, Math.round(canvas.width * 0.0015));

  for (let y=0; y<canvas.height; y++) {
    let dark = 0;
    let xMin = canvas.width;
    let xMax = -1;
    const row = y * canvas.width * 4;
    for (let x=0; x<canvas.width; x++) {
      const i = row + x * 4;
      const lum = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
      if (lum < 175) {
        dark++;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    }
    // 長い横罫線は行候補にしない。
    rows.push({ active:dark >= minDark && dark < canvas.width * 0.45, xMin, xMax, dark });
  }

  const bands = [];
  let current = null;
  let blankRun = 0;
  const allowedBlank = Math.max(2, Math.round(canvas.height * 0.003));
  for (let y=0; y<rows.length; y++) {
    const row = rows[y];
    if (row.active) {
      if (!current) current = { start:y, end:y, xMin:row.xMin, xMax:row.xMax, dark:row.dark };
      else {
        current.end = y;
        current.xMin = Math.min(current.xMin, row.xMin);
        current.xMax = Math.max(current.xMax, row.xMax);
        current.dark += row.dark;
      }
      blankRun = 0;
    } else if (current) {
      blankRun++;
      if (blankRun > allowedBlank) {
        current.end = y - blankRun;
        bands.push(current);
        current = null;
        blankRun = 0;
      }
    }
  }
  if (current) bands.push(current);

  return bands.filter(band => {
    const height = band.end - band.start + 1;
    const width = band.xMax - band.xMin + 1;
    return height >= Math.max(8, canvas.height * 0.012) && width >= Math.max(24, canvas.width * 0.035);
  });
}

function extractFiRowCanvases(canvas, minWidthRatio = 0) {
  return detectFiTextBands(canvas)
    .map(band => ({
      ...band,
      widthRatio: Math.max(0, band.xMax - band.xMin + 1) / canvas.width
    }))
    .filter(band => band.widthRatio >= minWidthRatio)
    .map(band => {
      const height = band.end - band.start + 1;
      const padY = Math.max(10, Math.round(height * 0.35));
      const y = Math.max(0, band.start - padY);
      const croppedHeight = Math.min(canvas.height - y, height + padY * 2);
      const rowCanvas = copyCanvasRegion(
        canvas,
        0,
        y,
        canvas.width,
        croppedHeight,
        Math.max(10, Math.round(height * 0.22))
      );
      eraseLongHorizontalRules(rowCanvas);
      enhanceCanvas(rowCanvas, 1.18);
      return {
        canvas: rowCanvas,
        widthRatio: band.widthRatio,
        y: band.start
      };
    });
}

function cropOcrCanvas(source, x0, y0, x1, y1, upscale, contrast, skipEnhance = false) {
  const sx = Math.max(0, Math.floor(source.width * x0));
  const sy = Math.max(0, Math.floor(source.height * y0));
  const sw = Math.max(1, Math.ceil(source.width * (x1 - x0)));
  const sh = Math.max(1, Math.ceil(source.height * (y1 - y0)));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw * upscale));
  out.height = Math.max(1, Math.round(sh * upscale));
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
  if (!skipEnhance) enhanceCanvas(out, contrast);
  return out;
}

function enhanceCanvas(canvas, contrast) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i=0; i<data.length; i+=4) {
    const lum = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
    let value = (lum - 150) * contrast + 150;
    value = Math.max(0, Math.min(255, value));
    data[i] = data[i+1] = data[i+2] = value;
    data[i+3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function showOcrImages(regions, options = {}) {
  if (!els.ocrImages) return;
  els.ocrImages.replaceChildren();
  const targets = [['書誌事項',regions.biblio],['IPC',regions.ipc],['FI',regions.fi]];
  if (!options.skipThemeCode) targets.push(['テーマコード', regions.themeCode]);
  targets.forEach(([label,canvas])=>{
    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption');
    caption.textContent = label;
    const img = new Image();
    img.alt = `${label} OCR対象画像`;
    img.src = canvas.toDataURL('image/png');
    figure.append(caption,img);
    els.ocrImages.appendChild(figure);
  });
}

function resetOcrDebug() {
  if (els.ocrDetails) els.ocrDetails.hidden = true;
  if (els.ocrRaw) els.ocrRaw.textContent = '';
  if (els.classOcrRaw) els.classOcrRaw.textContent = '';
  if (els.ocrImages) els.ocrImages.replaceChildren();
}

// -----------------------------------------------------------------------------
// OCR結果の正規化・書誌事項／分類コード解析
// -----------------------------------------------------------------------------

function normalizeOcrText(value) {
  return toHalfWidth(String(value || ''))
    .replace(/[①-⑳]/g, ch => String(ch.charCodeAt(0) - 0x2460 + 1))
    .replace(/⓪/g, '0')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[．]/g, '.')
    .replace(/[，]/g, ',')
    .replace(/\r/g, '');
}

function normalizeOcrDate(value) {
  let text = normalizeOcrText(value).replace(/[ \t　]+/g, '');
  text = text.replace(/([令平昭])租/g, '$1和');
  text = text.replace(/[（]/g, '(').replace(/[）]/g, ')');
  const jp = text.match(/(?:明治|大正|昭和|平成|令和)[0-9]{1,2}年[0-9]{1,2}月[0-9]{1,2}日(?:\((?:19|20)[0-9]{2}\.[0-9]{1,2}\.[0-9]{1,2}\))?/);
  if (jp) return jp[0];
  const western = text.match(/(?:19|20)[0-9]{2}\.[0-9]{1,2}\.[0-9]{1,2}/);
  return western ? western[0] : '';
}

function extractDateNearOcr(raw, markerRe) {
  const flat = normalizeOcrText(raw).replace(/[ \t　\n]+/g, '');
  const match = flat.match(markerRe);
  if (!match) return '';
  return normalizeOcrDate(flat.slice(match.index, match.index + 120));
}

function extractAllOcrDates(raw) {
  const compact = normalizeOcrText(raw).replace(/[ \t　\n]+/g, '').replace(/([令平昭])租/g, '$1和');
  const values = [];
  const re = /(?:明治|大正|昭和|平成|令和)[0-9]{1,2}年[0-9]{1,2}月[0-9]{1,2}日(?:\((?:19|20)[0-9]{2}\.[0-9]{1,2}\.[0-9]{1,2}\))?/g;
  let match;
  while ((match = re.exec(compact))) values.push(match[0]);
  return unique(values);
}

function cleanOcrName(value) {
  return normalizeOcrText(value)
    .replace(/[【】\[\]]/g, '')
    .replace(/[0-9]{7,}/g, '')
    .replace(/弁理[土上]/g, '弁理士')
    .replace(/あいをわ(?=弁理士法人)/g, 'あいわ')
    .replace(/あいわれ(?=弁理士法人)/g, 'あいわ')
    .replace(/^[:：\s]+|[:：\s]+$/g, '')
    .trim();
}

function isOcrAddress(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/(株式会社|有限会社|合同会社|弁理士法人|特許業務法人|大学|機構|研究所|センター|財団|法人|会社|組合|協会)/.test(text)) return false;
  return /^(東京都|北海道|大阪府|京都府|.{2,3}県)/.test(text) || /丁目|番地|番[0-9]|号|内$/.test(text);
}

function isOcrBibliographyMarker(value) {
  return /\((?:11|12|19|21|22|24|43|45|51|54|57|65|71|72|73|74)\)|審査請求日|最終頁|請求項の数|【/.test(normalizeOcrText(value));
}

function findOcrCorporateName(lines, startIndex, stopCodes) {
  const corporate = /(株式会社|有限会社|合同会社|合資会社|弁理士法人|特許業務法人|(?:国立|公立)大学法人|学校法人|(?:一般|公益)(?:社団|財団)法人|独立行政法人|国立研究開発法人|大学|研究所|機構|財団|協会|組合)/;
  const limit = stopCodes ? Math.min(lines.length, startIndex + 24) : lines.length;
  for (let i=Math.max(0,startIndex); i<limit; i++) {
    const line = cleanOcrName(lines[i]);
    if (!line) continue;
    if (stopCodes && stopCodes.test(line)) break;
    const candidate = line.replace(/^.*?(?:出願人|特許権者)/, '').trim();
    if (corporate.test(candidate) && !isOcrAddress(candidate)) return candidate.slice(0, 80);
  }
  return '';
}

function findMarkerLine(lines, code, label) {
  const re = new RegExp('(?:\\(' + code + '\\)|' + label + ')');
  return lines.findIndex(line => re.test(normalizeOcrText(line)));
}

function extractOcrAgent(lines) {
  const index = findMarkerLine(lines, '74', '代理人');
  if (index < 0) return '';
  for (let i=index; i<Math.min(lines.length,index+16); i++) {
    let line = cleanOcrName(lines[i]).replace(/^.*?代理人/, '').replace(/^\(74\)/, '').trim();
    if (i>index && /\((?:72|73|71|54|57)\)|発明者|特許権者|出願人/.test(line)) break;
    if (!line || /^[0-9]+$/.test(line) || isOcrAddress(line)) continue;
    if (/審査請求日|公開日|出願日|登録日|発行日/.test(line) || normalizeOcrDate(line)) continue;
    if (/弁理士|法人|事務所/.test(line) || /^[一-龯ぁ-んァ-ヶー・]{2,30}$/.test(line)) return line.slice(0,80);
  }
  return '';
}

function extractOcrInventors(lines) {
  const names = [];
  for (let i=0;i<lines.length;i++) {
    const normalized = normalizeOcrText(lines[i]);
    if (!/(?:\(72\)|発明者)/.test(normalized)) continue;
    let same = normalized.replace(/^.*?\(72\)\s*/, '').replace(/^発明者\s*/, '');
    same = cleanOcrName(same);
    const candidates = same ? [same] : [];
    for (let j=i+1;j<Math.min(lines.length,i+6);j++) {
      if (isOcrBibliographyMarker(lines[j])) break;
      candidates.push(cleanOcrName(lines[j]));
    }
    const name = candidates.find(v => v && !isOcrAddress(v) && !/(発明者|代理人|審査請求|最終.*続く|株式会社|法人|会社|識別番号)/.test(v) && /^[一-龯ぁ-んァ-ヶー・\s]{2,24}$/.test(v));
    if (name) names.push(name.replace(/\s+/g,' ').trim());
  }
  return unique(names).join('、');
}

function extractOcrTitle(lines) {
  for (let i=0;i<lines.length;i++) {
    if (!/(?:\(54\)|発明の名称)/.test(normalizeOcrText(lines[i]))) continue;
    let value = normalizeOcrText(lines[i]).replace(/^.*?発明の名称[】\]]?/, '').replace(/^.*?\(54\)/, '').replace(/^[【】\[\]:：\s]+/, '').trim();
    if (!value && lines[i+1]) value = cleanOcrName(lines[i+1]);
    value = value.replace(/\(57\)[\s\S]*$/, '').replace(/最終頁.*$/, '').trim();
    if (value) return value.slice(0,100);
  }
  return '';
}

function extractOcrFieldSegment(raw, targetCode, targetLabel) {
  const text = normalizeOcrText(raw);
  const labels = '登録番号|登録日|発行日|出願番号|出願日|公開日|公開番号|発明の名称|出願人|発明者|特許権者|代理人';
  const codes = '11|12|19|21|22|24|43|45|51|54|57|65|71|72|73|74';
  const markerRe = new RegExp(
    `[（(]\\s*(${codes})\\s*[）)]\\s*(?:(${labels}))?|(?:(${codes})\\s*)?(${labels})`,
    'g'
  );
  const markers = [];
  let match;
  while ((match = markerRe.exec(text))) {
    markers.push({
      index: match.index,
      end: markerRe.lastIndex,
      code: match[1] || match[3] || '',
      label: match[2] || match[4] || ''
    });
  }

  const startIndex = markers.findIndex(marker => marker.code === targetCode || marker.label === targetLabel);
  if (startIndex < 0) return '';
  const start = markers[startIndex].end;
  const end = markers[startIndex + 1]?.index ?? text.length;
  return text.slice(start, end).trim();
}

function parseOcrBibliography(raw) {
  const normalized = normalizeOcrText(raw);
  const flat = normalized.replace(/[ \t　\n]+/g, '');
  const numberFlat = flat
    .replace(/[OoＯｏ]/g, '0')
    .replace(/[IiLlＩｉＬｌ]/g, '1')
    .replace(/[SsＳｓ]/g, '5')
    .replace(/[BbＢｂ]/g, '8');
  const lines = normalized.split('\n').map(s=>s.replace(/[ \t　]+/g,' ').trim()).filter(Boolean);
  const result = {};

  // 旧登録公報の「特許第3,146,154号」のようなカンマ区切りにも対応する。
  let match = flat.match(/特許第([0-9,]{5,15})号/);
  if (match) {
    result['登録番号'] = normalizeBibliographicNumber('登録番号', `特許第${match[1]}号`);
    result.__registered = true;
  }
  if (!result['登録番号']) {
    match = normalized.match(/JP\s*([0-9]{5,12})\s*B[0-9]/i);
    if (match) {
      result['登録番号'] = normalizeBibliographicNumber('登録番号', `特許第${match[1]}号`);
      result.__registered = true;
    }
  }
  // 項目コード・項目名で範囲を区切り、次項目の番号（例: 73 特許権者）を
  // 公開番号・出願番号の末尾へ取り込まない。
  const publicSegment = extractOcrFieldSegment(normalized, '65', '公開番号');
  const publicFlat = publicSegment
    ? normalizeOcrText(publicSegment).replace(/[ \t　\n]+/g, '')
      .replace(/[OoＯｏ]/g, '0').replace(/[IiLlＩｉＬｌ]/g, '1')
      .replace(/[SsＳｓ]/g, '5').replace(/[BbＢｂ]/g, '8')
    : numberFlat;
  const applicationSegment = extractOcrFieldSegment(normalized, '21', '出願番号');
  const applicationFlat = applicationSegment
    ? normalizeOcrText(applicationSegment).replace(/[ \t　\n]+/g, '')
      .replace(/[OoＯｏ]/g, '0').replace(/[IiLlＩｉＬｌ]/g, '1')
      .replace(/[SsＳｓ]/g, '5').replace(/[BbＢｂ]/g, '8')
    : numberFlat;

  // 平成・昭和年式にも対応する。年は「特開平9-276204」のように1桁の場合がある。
  match = publicFlat.match(/特[開閑](平|昭)?成?和?([0-9]{1,4})[-ー－]([0-9]{1,10})/);
  if (match) result['公開番号'] = normalizeBibliographicNumber('公開番号', `特開${match[1] || ''}${match[2]}-${match[3]}`);
  else {
    match = publicSegment.match(/JP\s*([0-9]{4})[-\s]([0-9]{1,10})\s*A/i) ||
            normalized.match(/JP\s*([0-9]{4})[-\s]([0-9]{1,10})\s*A/i);
    if (match) result['公開番号'] = normalizeBibliographicNumber('公開番号', `特開${match[1]}-${match[2]}`);
  }
  if (!result['公開番号']) {
    match = publicFlat.match(/特[開閑](?:平|昭)?[0-9]{5,12}/);
    if (match) result['公開番号'] = normalizeBibliographicNumber('公開番号', match[0].replace('特閑', '特開'));
  }
  match = applicationFlat.match(/特[願詠](平|昭)?成?和?([0-9]{1,4})[-ー－]([0-9]{1,10})/);
  if (match) result['出願番号'] = normalizeBibliographicNumber('出願番号', `特願${match[1] || ''}${match[2]}-${match[3]}`);
  if (!result['出願番号']) {
    match = applicationFlat.match(/特[願詠](?:平|昭)?[0-9]{3,12}/);
    if (match) result['出願番号'] = normalizeBibliographicNumber('出願番号', match[0].replace('特詠', '特願'));
  }

  result['発行日'] = normalizeOcrDate(extractOcrFieldSegment(normalized, '45', '発行日')) ||
    extractDateNearOcr(normalized, /(?:\(45\)|発行日)/);
  result['登録日'] = normalizeOcrDate(extractOcrFieldSegment(normalized, '24', '登録日')) ||
    extractDateNearOcr(normalized, /(?:\(24\)|登録日)/);
  result['公開日'] = normalizeOcrDate(extractOcrFieldSegment(normalized, '43', '公開日')) ||
    extractDateNearOcr(normalized, /(?:\(43\)|公開日)/);
  result['出願日'] = normalizeOcrDate(extractOcrFieldSegment(normalized, '22', '出願日')) ||
    extractDateNearOcr(normalized, /(?:\(22\)|出願日)/);
  result['審査請求日'] = extractDateNearOcr(normalized, /審査請求日/);
  if (result.__registered && !result['審査請求日']) {
    const usedDates = new Set([result['発行日'],result['登録日'],result['公開日'],result['出願日']].filter(Boolean));
    const remainingDates = extractAllOcrDates(normalized).filter(value=>!usedDates.has(value));
    if (remainingDates.length) result['審査請求日'] = remainingDates[remainingDates.length-1];
  }
  result['発明の名称'] = extractOcrTitle(lines);

  const holderIndex = findMarkerLine(lines, result.__registered ? '73' : '71', result.__registered ? '特許権者' : '出願人');
  let holderName = '';
  if (holderIndex >= 0) {
    const idWindow = lines.slice(holderIndex, holderIndex+7).join(' ');
    const idMatch = normalizeOcrText(idWindow).match(/(?:^|\D)([0-9]{9})(?:\D|$)/);
    if (idMatch) result['識別番号'] = idMatch[1];
    holderName = findOcrCorporateName(lines, holderIndex, /\((?:72|74|54|57)\)|発明者|代理人|発明の名称/);
  }
  if (!holderName) holderName = findOcrCorporateName(lines, 0, null);
  if (holderName) result[result.__registered ? '特許権者' : '出願人'] = holderName;
  if (!result['識別番号']) {
    const allIds = normalizeOcrText(normalized).match(/(?:^|\D)([0-9]{9})(?=\D|$)/g) || [];
    if (allIds.length) {
      const id = allIds[0].match(/[0-9]{9}/);
      if (id) result['識別番号'] = id[0];
    }
  }
  result['代理人'] = extractOcrAgent(lines);
  result['発明者'] = extractOcrInventors(lines);

  Object.keys(result).forEach(key=>{
    if (key.startsWith('__')) return;
    if (!String(result[key] || '').trim()) delete result[key];
  });
  return result;
}

function normalizeClassDigit(value) {
  return String(value || '').toUpperCase().replace(/O/g,'0').replace(/[IL]/g,'1');
}

function normalizeClassCode(candidate) {
  let text = normalizeOcrText(candidate).toUpperCase().replace(/\s+/g,'');
  text = text.replace(/[._:;,()\[\]{}-]/g,'');
  text = text.replace(/([A-H][0-9OIL]{2}[A-Z])I(?=[0-9OIL]{1,3}\/)/g,'$1');
  text = text.replace(/\/[F](?=[0-9OIL]{1,6})/g,'/');
  const match = text.match(/([A-H])([0-9OIL]{2})([A-Z])([0-9OIL]{1,3})\/([0-9OIL]{1,6})/);
  if (!match) return '';
  return `${match[1]}${normalizeClassDigit(match[2])}${match[3]}${normalizeClassDigit(match[4])}/${normalizeClassDigit(match[5])}`;
}

function findAllClassCodes(text) {
  const source = normalizeOcrText(text).toUpperCase();
  // 「Ａ４７Ｌ　15/24」「a 4 7 l 15 / 24」など、全角/半角、大小文字、
  // 文字ごとの空白・改行・軽微な区切り記号をすべて許容する。
  const gap = '[\\s._:;,()\\[\\]{}-]*';
  // 区分・クラス・サブクラス・メイングループ間の空白は許容する一方、
  // 「15/24 103E」の103をサブグループへ誤結合しないよう、スラッシュ後の数字列は
  // ひとまとまりのトークンとして読む。
  const pattern = new RegExp(
    `([A-H])${gap}([0-9OIL])${gap}([0-9OIL])${gap}([A-Z])${gap}` +
    `([0-9OIL]{1,3})${gap}\\/${gap}([0-9OILF]{1,7})`,
    'gi'
  );
  const found = [];
  let match;
  while ((match = pattern.exec(source))) {
    const code = normalizeClassCode(match[0]);
    if (code) found.push({ code, index:match.index, end:pattern.lastIndex, raw:match[0] });
    if (pattern.lastIndex === match.index) pattern.lastIndex++;
  }
  return found;
}

function normalizeIpcDate(candidate) {
  const text = normalizeOcrText(candidate).toUpperCase().replace(/\s+/g,'');
  const match = text.match(/\((20[0-9OIL]{2})[.,]([0-9OIL]{2})\)/);
  if (!match) return '';
  return `(${normalizeClassDigit(match[1])}.${normalizeClassDigit(match[2])})`;
}

function parseIpcOcr(raw) {
  const text = normalizeOcrText(raw);
  const tokens = [];
  findAllClassCodes(text).forEach(item=>tokens.push({ type:'code', value:item.code, index:item.index }));
  const dateRe = /\(\s*20[0-9OIL]{2}\s*[.,]\s*[0-9OIL]{2}\s*\)/ig;
  let match;
  while ((match = dateRe.exec(text))) {
    const date = normalizeIpcDate(match[0]);
    if (date) tokens.push({ type:'date', value:date, index:match.index });
  }
  tokens.sort((a,b)=>a.index-b.index);
  const codes = tokens.filter(t=>t.type==='code');
  const dates = tokens.filter(t=>t.type==='date');
  const values = codes.map((codeToken, i)=>{
    const nextCodeIndex = i+1<codes.length ? codes[i+1].index : Number.POSITIVE_INFINITY;
    const date = dates.find(d=>d.index>codeToken.index && d.index<nextCodeIndex) || (dates.length===1 ? dates[0] : dates[i]);
    return `${codeToken.value}${date ? ' '+date.value : ''}`;
  });
  return unique(values).join('、');
}

function normalizeFiSuffix(value) {
  let text = normalizeOcrText(value).toUpperCase().replace(/[^A-Z0-9OILS]/g,'');
  if (!text) return '';
  if (/^[A-Z]$/.test(text)) return text;
  const match = text.match(/([0-9OILS]{2,5})([A-Z]?)$/);
  if (!match) return '';
  let digits = normalizeClassDigit(match[1]).replace(/S/g,'3');
  if (digits.length===4 && /^10{2}[0-9]$/.test(digits)) digits = digits[0] + digits.slice(2);
  if (digits.length===4 && digits[0]===digits[1]) digits = digits.slice(1);
  return digits + (match[2] || '');
}

function dedupeFiValues(values) {
  const cleaned = unique(values.map(v=>String(v||'').trim()).filter(Boolean));
  const basesWithSuffix = new Set(cleaned.filter(v=>/\s+\S+$/.test(v)).map(v=>v.split(/\s+/)[0]));
  return cleaned.filter(v=>{
    const parts=v.split(/\s+/);
    return parts.length>1 || !basesWithSuffix.has(parts[0]);
  });
}

function findFiSuffixBetween(text, start, end) {
  const segment = normalizeOcrText(text.slice(start, end));
  // 同一行または直後の行に分離された「G」「103E」等だけを採用する。
  const fragments = segment.split(/\n+/).map(v=>v.trim()).filter(Boolean).slice(0, 2);
  for (let fragment of fragments) {
    fragment = fragment
      .replace(/^\s*[),.;:_-]+/, '')
      .replace(/^(?:FI|F1|テーマコード|THEME\s*CODE)\b/i, '')
      .trim();
    if (!fragment) continue;
    const short = fragment.match(/^([A-Z]|[0-9OILS]{2,5}\s*[A-Z]?)(?=\s|$|[),.;:_-])/i);
    if (short) {
      const suffix = normalizeFiSuffix(short[1]);
      if (suffix) return suffix;
    }
    // 文字間に大きな空白が入った「1 0 3 E」も許容する。
    const compact = fragment.replace(/\s+/g,'');
    if (/^(?:[A-Z]|[0-9OILS]{2,5}[A-Z]?)$/i.test(compact)) {
      const suffix = normalizeFiSuffix(compact);
      if (suffix) return suffix;
    }
  }
  return '';
}

function firstClassCode(value) {
  const found = findAllClassCodes(normalizeOcrText(value || ''));
  return found.length ? found[0].code : '';
}

function classCodeBase(value) {
  const match = String(value || '').trim().match(/^([A-H][0-9]{2}[A-Z][0-9]{1,3}\/[0-9]{1,7})/i);
  return match ? match[1].toUpperCase() : '';
}

function classGroupPart(code) {
  const match = String(code || '').toUpperCase().match(/^[A-H][0-9]{2}[A-Z]([0-9]{1,3}\/[0-9]{1,7})$/);
  return match ? match[1] : '';
}

function findTopFiSuffixFromRaw(raw, topIpcCode) {
  const targetGroup = classGroupPart(topIpcCode);
  if (!targetGroup) return '';
  const [targetMain, targetSub] = targetGroup.split('/');
  const gap = '[\\s._:;,()\\[\\]{}-]*';
  const groupPattern = new RegExp(`([0-9OIL]{1,3})${gap}\\/${gap}([0-9OILF]{1,7})`, 'i');
  const lines = normalizeOcrText(raw || '').toUpperCase().split(/\n+/);

  for (const line of lines) {
    const match = groupPattern.exec(line);
    if (!match) continue;
    const main = normalizeClassDigit(match[1]);
    const sub = normalizeClassDigit(match[2].replace(/F/g, '1'));
    if (main !== targetMain || sub !== targetSub) continue;
    const suffix = findFiSuffixBetween(line, match.index + match[0].length, line.length);
    if (suffix) return suffix;
  }
  return '';
}

function supplementTopFiFromIpc(values, raw, ipcValue) {
  const topIpcCode = firstClassCode(ipcValue);
  if (!topIpcCode) return dedupeFiValues(values);

  const topBase = topIpcCode.toUpperCase();
  const alreadyPresent = values.some(value => classCodeBase(value) === topBase);
  if (alreadyPresent) return dedupeFiValues(values);

  const targetGroup = classGroupPart(topBase);
  const suffix = findTopFiSuffixFromRaw(raw, topBase);
  const repaired = topBase + (suffix ? ` ${suffix}` : '');
  const result = [...values];

  // 最上段の分類記号だけが誤読された場合は、先頭候補のグループ番号を照合し、
  // IPC最上段の分類記号へ置換する。付加記号（G、103E等）は保持する。
  if (result.length && classGroupPart(classCodeBase(result[0])) === targetGroup) {
    const existingSuffix = String(result[0]).trim().replace(/^\S+\s*/, '');
    result[0] = topBase + (existingSuffix ? ` ${existingSuffix}` : (suffix ? ` ${suffix}` : ''));
  } else {
    // 最上段全体が認識されなかった場合は、IPC最上段の分類コードをFI先頭へ補う。
    result.unshift(repaired);
  }
  return dedupeFiValues(result);
}

function parseFiOcr(raw, ipcValue = '') {
  const text = normalizeOcrText(raw).toUpperCase();
  const codes = findAllClassCodes(text);
  const values = [];
  for (let i=0; i<codes.length; i++) {
    const current = codes[i];
    const nextIndex = i+1<codes.length ? codes[i+1].index : Math.min(text.length, current.end + 80);
    const suffix = findFiSuffixBetween(text, current.end, nextIndex);
    values.push(current.code + (suffix ? ` ${suffix}` : ''));
  }
  return supplementTopFiFromIpc(values, raw, ipcValue).join('、');
}

function normalizeThemeCodeChar(char, position) {
  const ch = String(char || '').toUpperCase();
  if (position === 1) {
    return ({'0':'O','1':'I','5':'S','8':'B'}[ch] || ch).replace(/[^A-Z]/g,'');
  }
  return ({'O':'0','I':'1','L':'1','S':'5','B':'8'}[ch] || ch).replace(/[^0-9]/g,'');
}

function normalizeThemeCode(candidate) {
  const compact = normalizeOcrText(candidate).toUpperCase().replace(/[^A-Z0-9]/g,'');
  if (compact.length !== 5) return '';
  const chars = Array.from(compact);
  const code = chars.map((ch,index)=>normalizeThemeCodeChar(ch,index)).join('');
  return /^[0-9][A-Z][0-9]{3}$/.test(code) ? code : '';
}

function parseThemeCodeOcr(raw) {
  const text = normalizeOcrText(raw).toUpperCase()
    .replace(/テーマコード(?:\(参考\))?/g, ' ')
    .replace(/THEME\s*CODE/g, ' ');
  const compact = text.replace(/[^A-Z0-9]/g,'');
  const values = [];

  // 標準形（例：3B082）を優先する。
  const direct = compact.match(/[0-9OILSB][A-Z0-9][0-9OILSB]{3}/g) || [];
  direct.forEach(value=>{
    const normalized = normalizeThemeCode(value);
    if (normalized) values.push(normalized);
  });

  // OCRが文字間に空白や改行を入れた場合に備え、各行も確認する。
  normalizeOcrText(raw).split('\n').forEach(line=>{
    const candidate = line.replace(/テーマコード|参考|[()（）]/g,'').replace(/[^A-Za-z0-9]/g,'');
    if (candidate.length===5) {
      const normalized = normalizeThemeCode(candidate);
      if (normalized) values.push(normalized);
    }
  });
  return unique(values).join('、');
}

// -----------------------------------------------------------------------------
// OCR結果と内部テキストの統合
// -----------------------------------------------------------------------------

function mergeOcrBibliography(bibliography, ocr, sourceMap) {
  let count = 0;
  const prefer = new Set(['IPC','FI','テーマコード']);
  for (const [key,value] of Object.entries(ocr || {})) {
    if (key.startsWith('__') || !String(value || '').trim()) continue;
    const cleaned = cleanBibliographicValue(value);
    if (key === 'FI' && bibliography[key] && cleaned) {
      // 内部テキストとOCRのどちらか一方だけが拾った複数段FIを欠落させない。
      const merged = unique(`${bibliography[key]}、${cleaned}`.split(/[、,\n]+/).map(v=>v.trim()).filter(Boolean)).join('、');
      if (merged !== bibliography[key]) count++;
      bibliography[key] = merged;
      sourceMap[key] = true;
    } else if (!bibliography[key] || prefer.has(key) || bibliography.__skipped) {
      bibliography[key] = cleaned;
      sourceMap[key] = true;
      count++;
    }
  }
  if (ocr?.__registered || bibliography['登録番号']) bibliography.__registered = true;
  if (bibliography.__registered && !bibliography['特許権者'] && bibliography['出願人']) {
    bibliography['特許権者'] = bibliography['出願人'];
    delete bibliography['出願人'];
  }
  const hasAny = Object.keys(bibliography).some(key=>!key.startsWith('__') && String(bibliography[key] || '').trim());
  if (hasAny) delete bibliography.__skipped;
  return count;
}

function isRegisteredBibliography(bibliography) {
  return Boolean(
    bibliography &&
    (bibliography.__registered || bibliography['登録番号'] || bibliography['特許権者'])
  );
}

// 最終頁「フロントページの続き」に内部テキストで載る出願人・発明者・代理人・Fタームを補完する。
// 旧形式公報では1ページ目の書誌欄が画像のため、この欄が唯一の内部テキスト書誌になる。
function supplementFromFrontPageContinuation(pages, bibliography) {
  let collected = null;
  for (const page of pages) {
    if (page.pageNo === 1) continue;
    if (collected) {
      collected.push(...page.lines);
      continue;
    }
    const start = page.lines.findIndex(line => /フロントページの続き/.test(line.text));
    if (start >= 0) collected = page.lines.slice(start + 1);
  }
  if (!collected || !collected.length) return 0;

  const lineObjs = collected.map(l => ({ text: l.text, xMin: l.xMin, xMax: l.xMax, y: l.y }));
  const holderKey = isRegisteredBibliography(bibliography) ? '特許権者' : '出願人';
  let count = 0;

  if (!bibliography[holderKey]) {
    const info = holderKey === '特許権者'
      ? extractHolderInfo(lineObjs, '73', '特許権者')
      : extractApplicantInfo(lineObjs);
    if (info.names) {
      bibliography[holderKey] = info.names;
      count += 1;
    }
    if (info.ids && !bibliography['識別番号']) bibliography['識別番号'] = info.ids;
  }
  if (!bibliography['発明者']) {
    const inventors = extractInventors(lineObjs);
    if (inventors) {
      bibliography['発明者'] = inventors;
      count += 1;
    }
  }
  if (!bibliography['代理人']) {
    const agent = extractParty(lineObjs, '74', '代理人');
    if (agent) {
      bibliography['代理人'] = agent;
      count += 1;
    }
  }
  if (!bibliography.__oldTwoColumn && !bibliography['Fターム']) {
    const fterm = extractFTerm(lineObjs.map(l => l.text));
    if (fterm) {
      bibliography['Fターム'] = fterm;
      count += 1;
    }
  }

  if (count && bibliography.__skipped) delete bibliography.__skipped;
  return count;
}

// 2ページ目以降のヘッダー「(n) 特開○○○○−○○○○○○」「JP ... A/B」から公報番号を補完する。
function supplementBibliographyFromPageHeader(bibliography, header, sourceMap = null) {
  if (!header) return;
  const half = toHalfWidth(header).replace(/[‐‑‒–—―−ー－]/g, '-');
  let match;

  {
    match = half.match(/JP\s*([0-9]{5,12})\s*B[0-9]?/i) ||
            half.match(/特許第?\s*([0-9][0-9,]{4,14})\s*号?/);
    if (match) {
      const candidate = normalizeBibliographicNumber('登録番号', `特許第${match[1]}号`);
      if (candidate && !candidate.includes('要確認')) {
        bibliography['登録番号'] = candidate;
        bibliography.__registered = true;
        if (sourceMap) delete sourceMap['登録番号'];
      }
    }
  }
  if (!isRegisteredBibliography(bibliography)) {
    match = half.match(/特開\s*(平|昭)?\s*([0-9]{1,4})\s*-\s*([0-9]{1,10})/) ||
            half.match(/JP\s*()([0-9]{4})\s*-\s*([0-9]{1,10})\s*A/i);
    if (match) {
      const candidate = normalizeBibliographicNumber('公開番号', `特開${match[1] || ''}${match[2]}-${match[3]}`);
      if (candidate && !candidate.includes('要確認')) {
        bibliography['公開番号'] = candidate;
        if (sourceMap) delete sourceMap['公開番号'];
      }
    }
  }

  const hasAny = Object.keys(bibliography)
    .some(key => !key.startsWith('__') && String(bibliography[key] || '').trim());
  if (hasAny) delete bibliography.__skipped;
}

// -----------------------------------------------------------------------------
// PDF内部テキスト抽出
// -----------------------------------------------------------------------------

function openPdf(arrayBuffer, disableWorker) {
  const bytes = new Uint8Array(arrayBuffer.slice(0));
  return window.pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: 'local-cmaps/',
    cMapPacked: true,
    CMapReaderFactory: window.OfflineRuntime.CMapReaderFactory,
    standardFontDataUrl: 'local-standard-fonts/',
    StandardFontDataFactory: window.OfflineRuntime.StandardFontDataFactory,
    useWorkerFetch: false,
    useSystemFonts: true,
    disableFontFace: false,
    fontExtraProperties: true,
    stopAtErrors: false,
    disableWorker: !!disableWorker
  }).promise;
}

async function extractPageLines(page, pageNo) {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
    includeMarkedContent: false
  });

  const rawItems = textContent.items
    .map(item => {
      const transform = item.transform || [1, 0, 0, 1, 0, 0];
      return {
        str: normalizeGlyphs(String(item.str || '')),
        x: transform[4],
        y: transform[5],
        w: Number(item.width || 0),
        h: Math.abs(transform[3] || item.height || 8),
        fontName: item.fontName || '',
        hasEOL: Boolean(item.hasEOL)
      };
    })
    .filter(item => item.str.trim())
    // J-PlatPat公報の本文右端に置かれる行番号（10/20/30/40/50）は、
    // 本文と同じY座標で1行に結合されることがあるため、行組み前に座標で除去する。
    .filter(item => !isLikelyMarginLineNumberItem(
      item,
      pageNo,
      viewport.width,
      viewport.height
    ));

  const rows = groupItemsIntoRows(rawItems);
  const furniture = removePageFurniture(rows, viewport.width, viewport.height);
  const twoColumn = detectTwoColumnRows(furniture.rows, viewport.width);
  const lines = layoutRowsToLines(furniture.rows, viewport.width, twoColumn)
    .map(line => ({ ...line, text: cleanLineText(line.text) }))
    .filter(line => line.text && !isRemovableLine(
      line,
      pageNo,
      viewport.width,
      viewport.height
    ));

  return {
    pageNo,
    width: viewport.width,
    height: viewport.height,
    rawItemCount: rawItems.length,
    lines,
    header: furniture.header,
    twoColumn
  };
}

function groupItemsIntoRows(items) {
  const sorted = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const groups = [];

  for (const item of sorted) {
    const tolerance = Math.max(2.5, Math.min(7.5, item.h * 0.62));
    let group = groups.find(row => Math.abs(row.y - item.y) <= tolerance);

    if (!group) {
      group = { y: item.y, items: [] };
      groups.push(group);
    }

    group.items.push(item);
    group.y = (group.y * (group.items.length - 1) + item.y) / group.items.length;
  }

  groups.forEach(group => group.items.sort((a, b) => a.x - b.x));
  return groups.sort((a, b) => b.y - a.y);
}

// 旧形式（〜2000年頃）の公報向けページ装飾の除去。
// ヘッダー「(n) 特開○○○○−○○○○○○」や段番号「1 2」は、通常のヘッダー除去より
// 低い位置に印字されるためパターンで判定する。段間（ガター）の行番号「10/20/30」や
// 脚注記号「＊」も本文行へ結合される前に取り除く。
function removePageFurniture(rows, pageWidth, pageHeight) {
  const center = pageWidth / 2;
  let header = '';

  const kept = rows.filter(row => {
    if (row.y <= pageHeight - 95) return true;
    const text = cleanLineText(assembleLine(row.items));
    const half = toHalfWidth(text).trim();
    const isPubHeader =
      /^JP\s*[0-9]/i.test(half) ||
      (/^\(\s*[0-9]{1,3}\s*\)/.test(half) && (
        /^\(\s*[0-9]{1,3}\s*\)$/.test(half) ||
        // 旧登録公報のヘッダー「特許3,146,154」「特許第…号」も対象。
        // 「特許」単独は本文（特許請求の範囲・特許文献）と衝突するため、直後の文字で絞る。
        /(特開|特表|特公|特許|実開|実表|再表)\s*[平昭0-9第]/.test(half.slice(0, 30)) ||
        /JP\s*[0-9]/i.test(half.slice(0, 30))
      ));
    if (isPubHeader) {
      if (text.length > header.length) header = text;
      return false;
    }
    if (/^[0-9]{1,2}(\s+[0-9]{1,2})*$/.test(half)) return false;   // 段番号行
    return true;
  });

  for (const row of kept) {
    row.items = row.items.filter(item => {
      const mid = item.x + (item.w || 0) / 2;
      return !(
        Math.abs(mid - center) < 16 &&
        /^[0-9*※]{1,3}$/.test(toHalfWidth(item.str).trim())
      );
    });
  }

  return { rows: kept.filter(row => row.items.length), header };
}

// 2段組判定：各行が「中央線をまたがない」か「中央をまたぐ18pt以上の空白を持つ」場合、
// その行は段組らしい。8割以上の行が該当すれば2段組とみなす。
function detectTwoColumnRows(rows, pageWidth) {
  if (rows.length < 4) return false;
  const center = pageWidth / 2;
  let columnLike = 0;

  for (const row of rows) {
    const first = row.items[0];
    const last = row.items[row.items.length - 1];
    if (last.x + last.w < center || first.x > center) {
      columnLike += 1;
      continue;
    }
    for (let k = 1; k < row.items.length; k += 1) {
      const gapStart = row.items[k - 1].x + row.items[k - 1].w;
      const gapEnd = row.items[k].x;
      if (gapEnd - gapStart >= 18 && gapStart <= center && gapEnd >= center) {
        columnLike += 1;
        break;
      }
    }
  }

  return columnLike >= rows.length * 0.8;
}

// 2段組は行を中央で左右に分け、左段→右段の順で行リスト化する。
function layoutRowsToLines(rows, pageWidth, twoColumn) {
  const columns = [];

  if (twoColumn) {
    const center = pageWidth / 2;
    const left = [];
    const right = [];
    for (const row of rows) {
      const leftItems = row.items.filter(item => item.x + (item.w || 0) / 2 < center);
      const rightItems = row.items.filter(item => item.x + (item.w || 0) / 2 >= center);
      if (leftItems.length) left.push({ y: row.y, items: leftItems });
      if (rightItems.length) right.push({ y: row.y, items: rightItems });
    }
    columns.push(left, right);
  } else {
    columns.push(rows);
  }

  const lines = [];
  for (const column of columns) {
    for (const row of column) {
      lines.push({
        y: row.y,
        xMin: row.items[0].x,
        xMax: Math.max(...row.items.map(item => item.x + item.w)),
        text: assembleLine(row.items)
      });
    }
  }
  return lines;
}

function assembleLine(items) {
  let output = '';
  let previous = null;

  for (const item of items) {
    const text = item.str;
    if (!previous) {
      output += text;
    } else {
      const gap = item.x - (previous.x + previous.w);
      const previousChar = lastChar(output);
      const nextChar = firstChar(text);
      const averageWidth = Math.max(2.5, Math.min(14, (
        previous.w / Math.max(1, charCount(previous.str)) +
        item.w / Math.max(1, charCount(text))
      ) / 2));

      if (shouldInsertSpace(previousChar, nextChar, gap, averageWidth)) {
        output += ' ';
      }
      output += text;
    }

    if (item.hasEOL) output += ' ';
    previous = item;
  }

  return output;
}

function shouldInsertSpace(previousChar, nextChar, gap, averageWidth) {
  if (gap <= averageWidth * 0.28) return false;

  const previousIsAscii = isHalfAsciiWord(previousChar);
  const nextIsAscii = isHalfAsciiWord(nextChar);
  if (previousIsAscii && nextIsAscii) return gap > averageWidth * 0.55;
  if (previousIsAscii !== nextIsAscii) return gap > averageWidth * 1.5;
  return gap > averageWidth * 1.8;
}

function normalizeGlyphs(value) {
  const romanNumerals = {
    'Ⅰ': 'Ｉ',
    'Ⅱ': 'ＩＩ',
    'Ⅲ': 'ＩＩＩ',
    'Ⅳ': 'ＩＶ',
    'Ⅴ': 'Ｖ',
    'Ⅵ': 'ＶＩ',
    'Ⅶ': 'ＶＩＩ',
    'Ⅷ': 'ＶＩＩＩ',
    'Ⅸ': 'ＩＸ',
    'Ⅹ': 'Ｘ'
  };

  return String(value)
    .replace(/\u00A0/g, ' ')
    .replace(/[‐‑‒–—―]/g, '－')
    .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, character => romanNumerals[character] || character);
}

function cleanLineText(line) {
  let text = normalizeGlyphs(line)
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/（\s+/g, '（')
    .replace(/\s+）/g, '）')
    .replace(/【\s+/g, '【')
    .replace(/\s+】/g, '】');

  text = removeUnwantedSpaces(text).trim();
  return /^[・･●○■□◆◇▲△▼▽※＊*]+$/.test(text) ? '' : text;
}

function removeUnwantedSpaces(s) {
  const noSpace = '[\\u3040-\\u30ff\\u3400-\\u9fff々〆〤ヶ〇０-９Ａ-Ｚａ-ｚα-ωΑ-Ω％．，、。「」『』（）［］〔〕｛｝〈〉《》【】・…ー－―～：；／＼＋＝×÷±＜＞≦≧℃℉￥＄＃＠＆＊※]';
  const noSpaceRe = new RegExp('(' + noSpace + ')\\s+(' + noSpace + ')','g');
  let prev;
  do{
    prev=s;
    s=s
      // 日本語、全角英数字、ギリシャ文字、全角記号の相互間に入ったPDF由来の空白を削除
      .replace(noSpaceRe,'$1$2')
      // 半角数字と単位・記号の間の空白も削除。例: 5 μm, 100 ％, 2025 ． 4
      .replace(/([0-9０-９])\s+([α-ωΑ-Ωμ％．，、。℃℉])/g,'$1$2')
      .replace(/([α-ωΑ-Ωμ％．，、。℃℉])\s+([0-9０-９])/g,'$1$2')
      // ギリシャ文字＋半角/全角英字の単位表記を結合。例: μ m, α - アミラーゼ
      .replace(/([α-ωΑ-Ωμ])\s+([A-Za-zＡ-Ｚａ-ｚ])/g,'$1$2')
      .replace(/([A-Za-zＡ-Ｚａ-ｚ])\s+([α-ωΑ-Ωμ])/g,'$1$2')
      // 全角括弧・かぎ括弧などの内側/外側の空白を削除
      .replace(/([（［〔｛〈《【「『])\s+/g,'$1')
      .replace(/\s+([）］〕｝〉》】」』])/g,'$1')
      .replace(/([、。，．・…：；％／＼＋＝×÷±＜＞≦≧])\s+/g,'$1')
      .replace(/\s+([、。，．・…：；％／＼＋＝×÷±＜＞≦≧])/g,'$1')
      // 既存の特許公報向け補正
      .replace(/([第図請求項令和平成昭和])\s+([0-9０-９])/g,'$1$2')
      .replace(/([0-9０-９])\s+([年月日項号])/g,'$1$2')
      .replace(/([0-9０-９])\s+([a-zａ-ｚ])/g,'$1$2')
      .replace(/([Ａ-Ｚ])\s+([ａ-ｚＡ-Ｚ])/g,'$1$2')
      .replace(/([ＩＶＸ])\s*([ａ-ｚ])\s*－\s*([ＩＶＸ])\s*([ａ-ｚ])/g,'$1$2－$3$4')
      .replace(/([（(])\s+([ａ-ｚＡ-Ｚ０-９0-9])/g,'$1$2')
      .replace(/([ａ-ｚＡ-Ｚ０-９0-9])\s+([）)])/g,'$1$2');
  }while(s!==prev);
  return s;
}
function isLikelyMarginLineNumberItem(item, pageNo, pageWidth, pageHeight) {
  const text = toHalfWidth(cleanLineText(item.str || '')).trim();
  if (!/^(10|20|30|40|50)$/.test(text)) return false;

  // 本文右余白の行番号。ページ1の書誌欄などに現れる通常数字の誤除去を避けるため、
  // 右端寄り・本文縦位置・2ページ目以降を強めに見る。
  if (
    pageNo > 1 &&
    item.x > pageWidth * 0.78 &&
    item.y > pageHeight * 0.10 &&
    item.y < pageHeight * 0.92
  ) return true;

  return (
    item.x > pageWidth * 0.86 &&
    item.y > pageHeight * 0.12 &&
    item.y < pageHeight * 0.90
  );
}

function isRemovableLine(line, pageNo, pageWidth, pageHeight) {
  const text = line.text.trim();
  const halfWidthText = toHalfWidth(text).trim();
  if (!text) return true;

  if (/^JP\s*[0-9]{4}\s*[-－]\s*[0-9]+\s*A\s*[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}$/i.test(halfWidthText)) return true;
  if (/^\(?\s*[0-9]{1,3}\s*\)?\s*JP\s*/i.test(halfWidthText)) return true;
  if (/^\(\s*[0-9]{1,3}\s*\)$/.test(halfWidthText) && (line.y > pageHeight * 0.88 || line.y < pageHeight * 0.15)) return true;
  if (/^(10|20|30|40|50)$/.test(halfWidthText) && (line.xMin > pageWidth * 0.72 || pageNo > 1)) return true;
  if (/^[0-9]{1,2}$/.test(halfWidthText) && line.xMin > pageWidth * 0.86) return true;
  if (/^[←→↑↓↔↕⇒⇔▼▲▽△■□◆◇●○]+$/.test(text)) return true;
  if (/^[A-ZＡ-Ｚ]部$/.test(text)) return true;

  return (
    /^[IVXＩＶＸ]+[a-zａ-ｚ]?(?:[－-][IVXＩＶＸ]+[a-zａ-ｚ]?)?$/.test(text) &&
    text.length <= 8
  );
}

// -----------------------------------------------------------------------------
// 書誌事項抽出
// -----------------------------------------------------------------------------

function createEmptyBibliography(skipped) {
  const bibliography = Object.fromEntries(
    BIBLIOGRAPHY_FIELDS.map(field => [field, ''])
  );
  if (skipped) bibliography.__skipped = true;
  return bibliography;
}

function hasBibliographyText(lineObjs) {
  const text = lineObjs.map(l=>l.text).join('\n');
  const markers = [
    /特許番号|特許第[0-9０-９]+号|登録日|発行日|特許権者/,
    /特許出願公開番号|公開番号|特開[0-9０-９]{4}/,
    /\(43\)|公開日/, /\(21\)|出願番号/, /\(22\)|出願日/,
    /発明の名称/, /\(71\)\s*出願人|出願人/, /\(73\)\s*特許権者|特許権者/,
    /\(72\)\s*発明者|発明者/, /\(74\)\s*代理人|代理人/,
    /\bFI\b|ＦＩ/, /Int\.\s*Cl\.|ＩＰＣ/, /テーマコード/, /Fターム|Ｆターム/
  ];
  const hitCount = markers.reduce((n,re)=>n+(re.test(text)?1:0),0);
  const hasPublicCore = /(特開[0-9０-９]{4}|特許出願公開番号|公開番号)/.test(text) && /(発明の名称|出願番号|出願日|出願人|発明者)/.test(text);
  const hasRegisteredCore = /(特許第[0-9０-９]+号|特許番号|登録番号)/.test(text) && /(登録日|発行日|特許権者|出願番号)/.test(text);
  return hasPublicCore || hasRegisteredCore || hitCount >= 4;
}

function extractBibliography(firstPageLines) {
  const lineObjs = firstPageLines.map(l=>({
    text: cleanLineText(l.text || l),
    xMin: Number(l.xMin || 0),
    xMax: Number(l.xMax || 0),
    y: Number(l.y || 0)
  })).filter(l=>l.text);
  if (!hasBibliographyText(lineObjs)) return createEmptyBibliography(true);

  const lines = lineObjs.map(l=>l.text);
  const combined = lines.join('\n');
  const registered = /特許番号|特許第[0-9０-９]+号|\(73\)\s*特許権者|登録日|発行日/.test(combined);
  const holderInfo = registered ? extractHolderInfo(lineObjs, '73', '特許権者') : extractApplicantInfo(lineObjs);
  const bib = createEmptyBibliography(false);
  bib['登録番号'] = findFirst(combined,[/特許第\s*([0-9０-９,，]+)\s*号/,/(?:特許番号|登録番号)\s*[:：]?\s*([0-9０-９]{5,12})/]);
  if (bib['登録番号'] && !/^特許第/.test(bib['登録番号'])) bib['登録番号'] = `特許第${toHalfWidth(bib['登録番号'])}号`;
  bib['登録日'] = valueAfter(lines,/\(24\)|登録日/,/(?:\(24\))?\s*登録日?/);
  bib['発行日'] = valueAfter(lines,/\(45\)|発行日/,/(?:\(45\))?\s*発行日?/);
  bib['公開番号'] = findFirst(combined,[/特開\s*((?:平|昭)?[0-9０-９]{1,4}\s*[-－]\s*[0-9０-９]+)/,/([0-9０-９]{4}\s*[-－]\s*[0-9０-９]+)\s*A/]);
  bib['公開日'] = valueAfter(lines,/\(43\)|公開日/,/(?:\(43\))?\s*公開日?/);
  bib['出願番号'] = valueAfter(lines,/\(21\)|出願番号/,/(?:\(21\))?\s*出願番号?/);
  bib['出願日'] = valueAfter(lines,/\(22\)|出願日/,/(?:\(22\))?\s*出願日?/);
  bib['審査請求日'] = valueAfter(lines,/審査請求日/,/審査請求日/);
  bib['発明の名称'] = valueAfter(lines,/\(54\)|発明の名称/,/(?:\(54\))?\s*【?発明の名称】?/);
  bib['識別番号'] = holderInfo.ids;
  bib[registered ? '特許権者' : '出願人'] = holderInfo.names;
  bib['発明者'] = extractInventors(lineObjs);
  bib['代理人'] = extractParty(lineObjs,'74','代理人');
  bib['IPC'] = extractIPC(lines);
  bib['FI'] = extractFI(lines, bib['IPC']);
  bib['テーマコード'] = extractThemeCode(lines);
  bib['Fターム'] = extractFTerm(lines);
  if (bib['公開番号']) bib['公開番号'] = normalizePatentNumber('特開'+bib['公開番号'].replace(/^特開/,''));
  for (const key of Object.keys(bib)) if (!key.startsWith('__')) bib[key] = cleanBibliographicValue(bib[key]);
  validateBibliographicNumbers(bib);
  if (registered || bib['登録番号']) bib.__registered = true;
  return bib;
}

function extractHolderInfo(lineObjs, code, label) {
  const ids = [];
  const names = [];
  const startRe = new RegExp('[（(]\\s*' + code + '\\s*[）)]\\s*' + label + '\\s*');
  const stopRe = /[（(]\s*(72|73|74|54|57)\s*[）)]|^【/;
  for (let i=0;i<lineObjs.length;i++) {
    const line = lineObjs[i].text || '';
    const match = line.match(startRe);
    if (!match) continue;
    for (let j=i;j<lineObjs.length && j<i+22;j++) {
      let value = (lineObjs[j].text || '').trim();
      if (j>i && stopRe.test(value)) break;
      if (j===i) value = value.slice(match.index + match[0].length).trim();
      const idMatches = value.match(/[0-9０-９]{9}/g);
      if (idMatches) ids.push(...idMatches.map(toHalfWidth));
      value = cleanBibliographicValue(value.replace(/[0-9０-９]{9}/g,'').trim());
      if (!value || isPureCode(value) || isBareAddress(value) || isBibliographyNoise(value)) continue;
      if (/(株式会社|有限会社|合同会社|弁理士法人|特許業務法人|大学|機構|研究所|センター|財団|法人|会社|組合|協会)/.test(value)) names.push(value);
    }
  }
  return { ids:unique(ids).join('、'), names:unique(names).join('、') };
}

function extractApplicantInfo(lineObjs) {
  // (71)出願人は、識別番号（原則9桁）・出願人名・住所で構成される。
  // J-PlatPat系PDFでは左列の(21)/(22)と右列の(71)が同じ行に結合されることがある。
  // そのため、(71)行だけでなく、直後の行から左列の出願番号・出願日部分を削って、右列の名称だけを拾う。
  const ids = [];
  const names = [];
  const startRe = /[（(]\s*71\s*[）)]\s*出願人\s*/;
  const hardStopRe = /[（(]\s*(72|73|74|54|57)\s*[）)]|^Ｆ?Fターム|^【/;

  for(let i=0;i<lineObjs.length;i++){
    const line = lineObjs[i].text || '';
    const m = line.match(startRe);
    if(!m) continue;

    const first = line.slice(m.index + m[0].length).trim();
    addApplicantCandidate(first, ids, names);

    for(let j=i+1;j<lineObjs.length && j<i+20;j++){
      let t = (lineObjs[j].text || '').trim();
      if(!t) continue;
      if(hardStopRe.test(t)) break;

      // 同じ行に左列の書誌事項が混ざる代表例を除去する。
      // 例: "(22)出願日 平成29年11月30日(2017.11.30) 株式会社サタケ" → "株式会社サタケ"
      t = stripLeftColumnBibliographyPrefix(t);

      // 次の右列ラベルが同じ行に混ざった場合は手前だけを使う。
      t = t.replace(/\s*[（(]\s*(72|73|74|54|57)\s*[）)].*$/, '').trim();
      if(!t) continue;
      addApplicantCandidate(t, ids, names);
    }
  }
  return { ids: unique(ids).join('、'), names: unique(names).join('、') };
}

function addApplicantCandidate(raw, ids, names) {
  let t = cleanBibliographicValue(raw);
  if(!t) return;

  const idMatches = t.match(/[0-9０-９]{9}/g);
  if(idMatches){
    ids.push(...idMatches.map(toHalfWidth));
    t = t.replace(/[0-9０-９]{9}/g, '').trim();
  }
  t = t.replace(/^出願人\s*/,'').trim();
  if(!t) return;

  // 住所や識別番号、ページ由来のノイズは出願人名に入れない。
  if(isPureCode(t) || isBareAddress(t) || isBibliographyNoise(t)) return;

  // 法人名・団体名はそのまま採用。個人出願人にも備えて、住所でない短い氏名候補も採用する。
  if(/(株式会社|有限会社|合同会社|弁理士法人|特許業務法人|大学|機構|研究所|センター|財団|法人|会社|組合|協会|庁|国立研究開発法人)/.test(t) || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]{2,20}$/u.test(t)){
    names.push(t);
  }
}

function stripLeftColumnBibliographyPrefix(t) {
  let s = String(t || '').trim();
  // 出願番号行の左列を除去。
  s = s.replace(/^[（(]\s*21\s*[）)]\s*出願番号\s*特願[0-9０-９\-－]+(?:\(P?[0-9０-９\-－]+\))?\s*/,'').trim();
  // 出願日行の左列を除去。
  s = s.replace(/^[（(]\s*22\s*[）)]\s*出願日\s*(?:明治|大正|昭和|平成|令和)?[0-9０-９]+\s*年?\s*[0-9０-９]+\s*月?\s*[0-9０-９]+\s*日?\s*(?:\([0-9０-９]{4}\.[0-9０-９]{1,2}\.[0-9０-９]{1,2}\))?\s*/,'').trim();
  // 公開日行の左列を除去。
  s = s.replace(/^[（(]\s*43\s*[）)]\s*公開日\s*(?:明治|大正|昭和|平成|令和)?[0-9０-９]+\s*年?\s*[0-9０-９]+\s*月?\s*[0-9０-９]+\s*日?\s*(?:\([0-9０-９]{4}\.[0-9０-９]{1,2}\.[0-9０-９]{1,2}\))?\s*/,'').trim();
  return s;
}

// 発明者は人名のみ。勤務先住所の「○○株式会社内」等の法人名・数字入りの行を除外する。
function extractInventors(lineObjs) {
  const value = extractParty(lineObjs, '72', '発明者');
  if (!value) return '';
  return value.split('、')
    .map(v => v.trim())
    .filter(v => v &&
      !/[0-9０-９]/.test(v) &&
      !/(株式会社|有限会社|合同会社|合資会社|法人|会社|大学|機構|研究所|センター|事務所|協会|組合)/.test(v))
    .join('、');
}

function extractParty(lineObjs, code, label) {
  // 書誌事項がPDF内部テキストとして存在するPDFだけを対象にする。
  // ただしPDF.jsの行結合では、(21)出願番号の行と(71)出願人の行が同一行に混ざることがあるため、
  // 行頭一致ではなく、行中の「(71)出願人」なども検出する。
  const codeLabelRe = new RegExp('\\(' + code + '\\)\\s*' + label + '\\s*');
  const labelOnlyRe = new RegExp('^' + label + '\\s*$');
  const anyMarkerRe = /\((11|12|19|21|22|24|43|45|51|54|57|65|71|72|73|74)\)|^テーマコード|^Ｆ?Fターム|^FI\b|^審査請求|^【/;
  const nextMarkerRe = /\s*\((11|12|19|21|22|24|43|45|51|54|57|65|71|72|73|74)\).*/;
  const results=[];

  for(let i=0;i<lineObjs.length;i++){
    const line = lineObjs[i].text;
    let matched = false;
    let v = '';

    const m = line.match(codeLabelRe);
    if(m){
      matched = true;
      v = line.slice(m.index + m[0].length).replace(nextMarkerRe,'').trim();
    } else if(labelOnlyRe.test(line)) {
      matched = true;
      v = '';
    }
    if(!matched) continue;

    if(v) results.push(v);

    for(let j=i+1;j<lineObjs.length && j<i+18;j++){
      let t = lineObjs[j].text.trim();
      if(!t) continue;
      // 次の書誌ラベルや本文見出しに入ったら終了。
      if(anyMarkerRe.test(t)) break;
      // PDF.jsが同一行に別ラベルを混ぜた場合は、その手前だけ使う。
      t = t.replace(nextMarkerRe,'').trim();
      if(!t) continue;
      results.push(t);
    }
  }

  const cleaned=unique(results.map(cleanBibliographicValue).filter(Boolean))
    .map(s=>s.replace(/^\([0-9０-９]{2}\)/,''))
    .map(s=>s.trim())
    .filter(Boolean)
    .filter(s=>!isPureCode(s))
    .filter(s=>!isBareAddress(s))
    .filter(s=>!isBibliographyNoise(s));
  return cleaned.join('、');
}

function isBibliographyNoise(s) {
  const t = String(s || '').trim();
  if(!t) return true;
  if(/^(ＯＬ|OL|未請求|請求項の数|全[0-9０-９]+頁)/.test(t)) return true;
  if(/^[0-9０-９A-ZＡ-Ｚ\s]+$/.test(t) && !/(株式会社|会社|法人|大学|機構|研究所)/.test(t)) return true;
  return false;
}

function isPureCode(value) {
  return /^[0-9０-９]{5,}$/.test(String(value).replace(/[^0-9０-９]/g, ''));
}
function isBareAddress(s) {
  const text=String(s||'');
  if(/(株式会社|有限会社|合同会社|弁理士法人|特許業務法人|大学|機構|研究所|センター|財団|法人)/.test(text)) return false;
  return /^(東京都|北海道|大阪府|京都府|.{2,3}県)/.test(text) || /丁目|番地|番[0-9０-９]|号|内$/.test(text);
}
function valueAfter(lines,hitRe,labelRe) {
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(!hitRe.test(line)) continue;
    let v=line.replace(labelRe,'').replace(/^[（(][0-9０-９]{2}[）)]/,'').replace(/^[:：]/,'').trim();
    v = truncateMixedBibliographyValue(v, hitRe);
    if(v) return v;
    for(let j=i+1;j<Math.min(lines.length,i+5);j++){
      if(lines[j]&&!/^[（(][0-9０-９]{2}[）)]/.test(lines[j])) return truncateMixedBibliographyValue(lines[j], hitRe);
    }
  }
  return '';
}

function truncateMixedBibliographyValue(v, hitRe) {
  let s = cleanLineText(String(v || '')).trim();
  if(!s) return '';
  // 同一行に別の書誌ラベルが混ざった場合は、その手前で切る。
  s = s.replace(/\s*[（(]\s*(11|12|19|21|22|24|43|45|51|54|57|65|71|72|73|74)\s*[）)].*$/, '').trim();

  // 項目別に、必要な値だけを厳密に抜く。右列の出願人名が出願日へ混ざるのを防ぐ。
  const hw = toHalfWidth(s);
  if(/出願番号|\(21\)|[（(]\s*21\s*[）)]/.test(String(hitRe))){
    const m = s.match(/特願\s*(?:平|昭)?\s*[0-9０-９]{1,4}\s*[-－]\s*[0-9０-９]+(?:\s*\(P?[0-9０-９]{1,4}\s*[-－]\s*[0-9０-９]+\))?/);
    if(m) return m[0];
  }
  if(/公開日|出願日|\(43\)|\(22\)|[（(]\s*(43|22)\s*[）)]/.test(String(hitRe))){
    const m = s.match(/(?:明治|大正|昭和|平成|令和)?\s*[0-9０-９]+\s*年?\s*[0-9０-９]+\s*月?\s*[0-9０-９]+\s*日?\s*\([0-9０-９]{4}\.[0-9０-９]{1,2}\.[0-9０-９]{1,2}\)/);
    if(m) return m[0];
    const m2 = s.match(/(?:明治|大正|昭和|平成|令和)\s*[0-9０-９]+\s*年?\s*[0-9０-９]+\s*月?\s*[0-9０-９]+\s*日?/);
    if(m2) return m2[0];
    const m3 = hw.match(/[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}/);
    if(m3) return m3[0];
  }
  return s;
}

function extractIPC(lines) {
  const vals=[];
  for(const line of lines){
    const h=toHalfWidth(line);
    if(/Int\.\s*Cl\.|ＩＰＣ|^[A-H][0-9]{2}[A-Z]/.test(h)){
      const matches=h.match(/[A-H][0-9]{2}[A-Z]\s*[0-9]+\/[0-9]+\s*\((?:19|20)[0-9]{2}\.[0-9]{2}\)/g);
      if(matches) vals.push(...matches.map(s=>s.replace(/\s+/g,' ').trim()));
    }
  }
  return unique(vals).join('、');
}
function extractFI(lines, ipcValue = '') {
  const normalized = lines.map(line=>normalizeOcrText(line));
  const start = normalized.findIndex(line=>/(?:^|\s)(?:FI|F1|ＦＩ)(?:\s|$|[:：])/.test(line));
  if (start < 0) return '';
  const block = [];
  for (let i=start; i<Math.min(normalized.length, start+18); i++) {
    const line = normalized[i];
    if (i>start && /(テーマコード|請求項の数|審査請求|\(21\)|\(22\)|\(71\)|\(73\)|【)/.test(line)) break;
    block.push(line);
  }
  return parseFiOcr(block.join('\n'), ipcValue);
}
function extractThemeCode(lines) {
  const vals=[];
  for(let i=0;i<lines.length;i++){
    if(!/テーマコード/.test(lines[i])) continue;
    const window=lines.slice(i,Math.min(lines.length,i+4)).join(' ');
    const candidates=toHalfWidth(window).toUpperCase().match(/[0-9OILSB]\s*[A-Z0-9]\s*[0-9OILSB](?:\s*[0-9OILSB]){2}/g)||[];
    candidates.forEach(v=>{const code=normalizeThemeCode(v);if(code)vals.push(code);});
  }
  return unique(vals).join('、');
}
function extractFTerm(lines) {
  const values = [];
  let active = false;

  for (const line of lines) {
    if (/Fターム|Ｆターム/.test(line)) {
      active = true;
      // 「(参考)」の括弧は全角・半角が混在することがある。
      values.push(line.replace(/.*?[ＦF]ターム(?:[（(]参考[）)])?/, '').trim());
      continue;
    }
    if (active && /^\((54|57|21|22|43|51|71|72|74)\)/.test(line)) break;
    if (active) values.push(line);
  }

  return unique(
    values
      .join(' ')
      .split(/\s+/)
      .filter(value => /^[0-9A-Z０-９Ａ-Ｚ]{3,}$/.test(value))
      .map(toHalfWidth)
  ).join(' ');
}

function cleanBibliographicValue(value) {
  return removeUnwantedSpaces(String(value || ''))
    .replace(/^[:：]/, '')
    .replace(/^(登録番号|登録日|発行日|公開番号|公開日|出願日|出願番号|審査請求日|発明の名称|出願人|特許権者|発明者|代理人|テーマコード|IPC|FI)/, '')
    .trim();
}

// -----------------------------------------------------------------------------
// 本文整形・TXT出力
// -----------------------------------------------------------------------------

function buildBodyText(pages) {
  const bodyLines = [];
  let reachedContinuation = false;

  for (const page of pages) {
    if (reachedContinuation) break;
    let lines = page.lines.map(line => line.text).filter(Boolean);
    if (page.pageNo === 1) {
      const bodyStart = lines.findIndex(line => /【要約】|【特許請求の範囲】|【発明の詳細な説明】/.test(line));
      lines = bodyStart >= 0 ? lines.slice(bodyStart) : [];
    }

    for (let line of lines) {
      // 「フロントページの続き」以降は書誌事項（出願人・発明者等）のため本文に含めない。
      if (/^フロントページの続き/.test(line)) {
        reachedContinuation = true;
        break;
      }
      line = stripLineNumberAtEnd(cleanLineText(line));
      line = stripFigureNoise(line);
      if (!line) continue;

      for (let part of splitHeadings(line)) {
        part = stripLineNumberAtEnd(part);
        if (part) bodyLines.push(part);
      }
    }
  }

  return postProcessBodyText(joinPatentLines(bodyLines));
}
function stripLineNumberAtEnd(s) {
  s = String(s || '').trim();
  // 独立行の行番号
  if(/^(?:10|20|30|40|50|１０|２０|３０|４０|５０)$/.test(s)) return '';
  // 右端の行番号が本文と同一行に結合された場合。空白あり/なし、全角/半角を両方除去。
  // 「図１０」「表２０」「請求項１０」など意味のある番号はなるべく残す。
  const guard = /(図|表|請求項|実施例|比較例|番号|符号|ステップ|Ｓ|S|No\.?|Ｎｏ．)$/;
  const removeTail = (text) => {
    const m = text.match(/^(.*?)(?:[ \u3000]*)(10|20|30|40|50|１０|２０|３０|４０|５０)$/);
    if(!m) return text;
    const before = m[1].trimEnd();
    if(before.length < 6) return text;
    if(guard.test(before)) return text;
    if(/[0-9０-９A-Za-zＡ-Ｚａ-ｚ]$/.test(before)) return text;
    return before;
  };
  let prev;
  do{ prev = s; s = removeTail(s).trim(); }while(s !== prev);
  return s;
}
function postProcessBodyText(body) {
  return String(body || '')
    .split('\n')
    .map(line => stripLineNumberAtEnd(line))
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}
function stripFigureNoise(value) {
  const halfWidthValue = toHalfWidth(value);
  if (/^[0-9]{1,3}$/.test(halfWidthValue)) return '';
  if (/^[A-Z]部(?:拡大画像|画像)?$/.test(halfWidthValue)) return '';
  if (/^(原料玄米|加工玄米)(画像)?$/.test(value)) return '';
  if (/^[←→↑↓↔↕⇒⇔▼▲▽△■□◆◇●○]+$/.test(value)) return '';
  return value;
}

function splitHeadings(value) {
  const text = value.replace(/^\([0-9０-９]{2}\)/, '');
  const parts = [];
  const headingPattern = /(【[^】]{1,40}】)/g;
  let position = 0;
  let match;

  while ((match = headingPattern.exec(text))) {
    if (match.index > position) parts.push(text.slice(position, match.index).trim());
    parts.push(match[1].trim());
    position = headingPattern.lastIndex;
  }

  if (position < text.length) parts.push(text.slice(position).trim());
  return parts.filter(Boolean);
}

function joinPatentLines(lines) {
  const output = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!output.length) {
      output.push(line);
      continue;
    }

    const previous = output[output.length - 1];
    if (mustBreakBefore(line, previous)) {
      output.push(line);
    } else if (shouldJoin(previous, line)) {
      output[output.length - 1] = previous + line;
    } else {
      output.push(line);
    }
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function mustBreakBefore(line, previous) {
  if (/^【[^】]+】$/.test(line)) return true;
  if (/^【図[０-９0-9]+】/.test(line)) return true;
  if (/^（[０-９0-9]+）/.test(line)) return true;
  return /^【[^】]+】$/.test(previous);
}

function shouldJoin(previous, line) {
  if (/[。．.!?！？]$/.test(previous)) return false;
  if (/^[・･●○\-－]/.test(line)) return false;
  return !/^【/.test(line);
}

function composeBodyTxt(body) {
  return ['【本文】', body || '']
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

function composeTxt(bibliography, body, ocrSource = {}, annotateOcr = false) {
  const registered = isRegisteredBibliography(bibliography);
  let order = registered ? OUTPUT_FIELDS.registered : OUTPUT_FIELDS.published;
  if (bibliography.__oldTwoColumn) {
    order = order.filter(key => key !== 'テーマコード' && key !== 'Fターム');
  }
  const bibliographyLines = bibliography.__skipped
    ? ['書誌事項：内部テキスト・OCRのいずれからも取得できないためスキップ']
    : order.map(key => {
      const annotation = annotateOcr && bibliography[key] && ocrSource[key]
        ? '（OCR推定）'
        : '';
      return `${key}：${bibliography[key] || ''}${annotation}`;
    });

  return [
    '【書誌事項】',
    ...bibliographyLines,
    '',
    '【本文】',
    body || ''
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function refreshOutputFromState() {
  if (!currentResult) return;

  const includeBibliography = Boolean(
    currentResult.ocrCompleted &&
    currentResult.bibliography &&
    els.includeBibliography.checked
  );
  convertedText = includeBibliography
    ? composeTxt(currentResult.bibliography, currentResult.body, currentResult.ocrSource, false)
    : composeBodyTxt(currentResult.body);
  const previewText = includeBibliography
    ? composeTxt(currentResult.bibliography, currentResult.body, currentResult.ocrSource, true)
    : composeBodyTxt(currentResult.body);

  els.preview.value = makePreview(previewText, APP_CONFIG.previewLimit);
  els.download.disabled = false;
  renderSummary(currentResult, includeBibliography);
}

function makePreview(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n……（プレビューはここまで。TXTダウンロードには全文が含まれます）`;
}

function downloadTxt() {
  if (!convertedText) return;

  const blob = new Blob([convertedText], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = outputFileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  log(`ダウンロード: ${outputFileName}`, 'status-ok');
}

function renderSummary(state, includeBibliography) {
  const bibliography = state.bibliography || {};
  const registered = state.ocrCompleted && isRegisteredBibliography(bibliography);
  const number = registered ? bibliography['登録番号'] : bibliography['公開番号'];
  const holder = registered ? bibliography['特許権者'] : bibliography['出願人'];
  const rows = [
    ['ページ数', state.pageCount],
    ['抽出items', state.itemTotal.toLocaleString('ja-JP')],
    ['抽出行数', state.lineTotal.toLocaleString('ja-JP')],
    ['TXT出力', includeBibliography ? '書誌事項＋本文' : '本文のみ'],
    ['OCR状態', lastOcrError
      ? `失敗：${lastOcrError}`
      : (state.ocrCompleted ? '書誌事項読取済み' : '未実行')],
    ['本文文字数', state.body.length.toLocaleString('ja-JP')]
  ];

  if (state.ocrCompleted) {
    rows.splice(3, 0,
      ['公報種別', registered ? '特許登録公報' : '公開特許公報'],
      ['書誌事項', includeBibliography
        ? `TXT出力あり（OCR補完 ${state.ocrFilledCount}項目）`
        : 'TXT出力なし'],
      [registered ? '登録番号' : '公開番号', number || '未取得'],
      ['発明の名称', bibliography['発明の名称'] || '未取得'],
      [registered ? '特許権者' : '出願人', holder || '未取得'],
      ['IPC', bibliography.IPC || '未取得'],
      ['FI', bibliography.FI || '未取得'],
      ['テーマコード', bibliography.__oldTwoColumn ? '対象外（旧2段組公報）' : (bibliography['テーマコード'] || '未取得')]
    );
  }

  const fragment = document.createDocumentFragment();
  for (const [label, value] of rows) {
    const heading = document.createElement('b');
    const content = document.createElement('span');
    heading.textContent = label;
    content.textContent = String(value);
    fragment.append(heading, content);
  }
  els.summary.replaceChildren(fragment);
}

function findFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return (match[1] || match[0] || '').trim();
  }
  return '';
}

function normalizePatentNumber(value) {
  return removeUnwantedSpaces(value).replace(/\s+/g, '').replace(/－/g, '-');
}

function normalizeBibliographicNumber(kind, value) {
  const markForReview = text => {
    const base = String(text || '').replace(/[（(]要確認[）)]/g, '').trim();
    return base ? `${base}（要確認）` : '';
  };
  let text = String(value || '')
    .replace(/[！-～]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .replace(/[‐‑‒–—―−ー－]/g, '-')
    .replace(/^(登録番号|公開番号|出願番号)\s*[:：]?\s*/, '')
    .replace(/[（(]要確認[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/[OoＯｏ]/g, '0')
    .replace(/[IiLlＩｉＬｌ]/g, '1')
    .replace(/[SsＳｓ]/g, '5')
    .replace(/[BbＢｂ]/g, '8');

  if (kind === '登録番号') {
    const match = text.match(/特許第?([0-9,]+)号?/) || text.match(/JP([0-9]+)8[0-9]?/i);
    if (!match) return markForReview(text);
    const digits = match[1].replace(/,/g, '');
    const normalized = `特許第${digits}号`;
    return /^[0-9]{7}$/.test(digits) ? normalized : markForReview(normalized);
  }

  const prefix = kind === '公開番号' ? '特開' : kind === '出願番号' ? '特願' : '';
  if (!prefix) return text;
  const match = text.match(new RegExp(`^${prefix}(平|昭)?([0-9]{1,4})-([0-9]{1,10})`));
  if (!match) return markForReview(text);

  const era = match[1] || '';
  const year = match[2];
  const serial = match[3];
  const validYear = kind === '公開番号'
    ? (era ? year.length <= 2 : year.length === 4)
    : (era ? year.length <= 2 : (year.length <= 2 || year.length === 4));
  const validSerial = serial.length >= 1 && serial.length <= 6;
  const normalized = `${prefix}${era}${year}-${serial}`;
  return validYear && validSerial ? normalized : markForReview(normalized);
}

function validateBibliographicNumbers(bibliography) {
  for (const key of ['登録番号', '公開番号', '出願番号']) {
    if (bibliography[key]) bibliography[key] = normalizeBibliographicNumber(key, bibliography[key]);
  }
  if (bibliography['登録番号']) bibliography.__registered = true;
  if (bibliography.__oldTwoColumn) {
    delete bibliography['テーマコード'];
    delete bibliography['Fターム'];
  }
}

function toHalfWidth(value) {
  return String(value)
    .replace(/[！-～]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function firstChar(value) {
  return Array.from(String(value).trim())[0] || '';
}

function lastChar(value) {
  const characters = Array.from(String(value).trim());
  return characters[characters.length - 1] || '';
}

function charCount(value) {
  return Array.from(String(value)).length;
}

function isHalfAsciiWord(character) {
  return /[A-Za-z0-9]/.test(character || '');
}

})();
