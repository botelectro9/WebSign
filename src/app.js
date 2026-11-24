(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  // Strings of this page's language, embedded by build.mjs from src/i18n.js.
  /* global WEBSIGN_STRINGS */
  const STRINGS = WEBSIGN_STRINGS;
  function t(key, params) {
    const s = STRINGS[key];
    if (typeof s !== 'string') { console.warn(`Missing string: ${key}`); return key; }
    return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
  }
  const COLORS = [
    ['color.black', '#000000'], ['color.white', '#ffffff'], ['color.grey', '#808080'],
    ['color.darkblue', '#0b2a6f'], ['color.red', '#d62828'], ['color.green', '#2a9d3a'],
    ['color.pink', '#ff5fa2'], ['color.yellow', '#ffd60a'], ['color.orange', '#f77f00'],
  ];
  const STROKE_WIDTH = 0.032;          // stroke width as a fraction of the box height
  const MIN_BOX_PX = 36;               // minimum box size on screen (CSS px)
  const MAX_CANVAS_AREA = 16000000;    // stay below iOS Safari's ~16.7 MP canvas limit
  const MAX_CANVAS_SIDE = 8192;
  const MAX_PAGE_CSS_WIDTH = 980;
  const EXPORT_SCALE = 3;              // PDF page raster scale for PNG/JPG export
  const OUTLINE_COLOR = [0.42, 0.45, 0.5];
  const HISTORY_LIMIT = 300;
  const FORMAT_INFO = {
    pdf: { mime: 'application/pdf', ext: 'pdf', label: 'PDF', accept: ['.pdf'] },
    png: { mime: 'image/png', ext: 'png', label: 'PNG', accept: ['.png'] },
    jpg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG', accept: ['.jpg', '.jpeg'] },
  };

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const hasFsAccess = typeof window.showOpenFilePicker === 'function';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    doc: null,        // { kind, name, type, bytes, handle, pdf, pages[], image }
    box: null,        // { page, x, y, w, h }  all in fractions of the page
    strokes: [],      // immutable [{ color, width, points:[{x,y}] }], points in box fractions
    color: '#000000',
    undo: [],
    redo: [],
    dirty: false,
  };
  let drawing = null;  // active stroke gesture
  let gesture = null;  // active move/resize gesture
  let pageObserver = null;
  let openToken = 0;

  const els = {
    start: $('start'), dropzone: $('dropzone'), openBtn: $('open-btn'), fileInput: $('file-input'),
    pages: $('pages'), topbar: $('topbar'), filename: $('filename'), toolbar: $('toolbar'),
    tbBox: $('tb-box'), tbPen: $('tb-pen'), penDot: $('pen-dot'), tbUndo: $('tb-undo'), tbRedo: $('tb-redo'),
    tbSig: $('tb-sig'), tbSave: $('tb-save'),
    boxMenu: $('box-menu'), bmErase: $('bm-erase'), bmDelete: $('bm-delete'), bmCancel: $('bm-cancel'),
    penPop: $('pen-pop'), dropOverlay: $('drop-overlay'),
    tbVision: $('tb-vision'), visionMenu: $('vision-menu'),
    saveDlg: $('save-dlg'), saveForm: $('save-form'), saveNote: $('save-note'), saveOutline: $('save-outline'),
    saveCopy: $('save-copy'), saveOverwrite: $('save-overwrite'), saveCancel: $('save-cancel'), saveReason: $('save-reason'),
    pwdDlg: $('pwd-dlg'), pwdForm: $('pwd-form'), pwdInput: $('pwd-input'), pwdNote: $('pwd-note'), pwdCancel: $('pwd-cancel'),
    confirmDlg: $('confirm-dlg'), confirmNote: $('confirm-note'),
    readyDlg: $('ready-dlg'), readyNote: $('ready-note'), readyLink: $('ready-link'), readyShare: $('ready-share'),
    busy: $('busy'), busyText: $('busy-text'), toast: $('toast'),
  };

  // ---------------------------------------------------------------------------
  // Small UI helpers
  // ---------------------------------------------------------------------------
  let toastTimer = 0;
  function toast(msg, isError = false) {
    clearTimeout(toastTimer);
    els.toast.textContent = msg;
    els.toast.classList.toggle('error', isError);
    els.toast.classList.add('show');
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), isError ? 6000 : 3200);
  }
  let busyDepth = 0;
  function busy(text) {
    busyDepth++;
    els.busyText.textContent = text || t('busy.working');
    els.busy.hidden = false;
    return () => { busyDepth = Math.max(0, busyDepth - 1); if (!busyDepth) els.busy.hidden = true; };
  }
  function setBusyText(text) { els.busyText.textContent = text; }

  /**
   * Shows a modal dialog and resolves with the value of the button that closed it ('' for
   * Escape). Uses the synchronous submit/cancel events rather than the asynchronously
   * dispatched 'close' event, so a dialog reopened right after closing cannot receive a
   * stale close event.
   */
  function showDialog(dlg) {
    return new Promise((resolve) => {
      const form = dlg.querySelector('form');
      const finish = (v) => {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('cancel', onCancel);
        resolve(v);
      };
      const onSubmit = (e) => finish(e.submitter && e.submitter.value ? e.submitter.value : 'ok');
      const onCancel = () => finish('');
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('cancel', onCancel);
      dlg.showModal();
    });
  }

  function confirmDialog(message) {
    els.confirmNote.textContent = message;
    return showDialog(els.confirmDlg).then((v) => v === 'ok');
  }

  function errorMessage(e) {
    return (e && (e.message || e.name)) || String(e);
  }

  // ---------------------------------------------------------------------------
  // Embedded libraries (base64 in non-executed <script> blocks -> Blob URLs)
  // ---------------------------------------------------------------------------
  function base64ToBytes(b64) {
    const clean = b64.replace(/\s+/g, '');
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(clean);
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function libUrl(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Embedded library ${id} is missing`);
    const bytes = base64ToBytes(el.textContent);
    el.textContent = ''; // free the base64 text, the Blob keeps the bytes
    return URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  }

  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = (async () => {
        const lib = await import(libUrl('lib-pdfjs'));
        // The worker is embedded as a classic script (converted at build time): module
        // workers from blob: URLs are refused on file:// pages.
        const workerUrl = libUrl('lib-pdfjs-worker');
        try {
          lib.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { name: 'pdfjs-worker' });
        } catch (e) {
          // Workers unavailable: load the worker code on the main thread; pdf.js picks it
          // up from globalThis.pdfjsWorker and runs without a worker (slower, still works).
          console.warn('pdf.js worker could not start, running on the main thread:', e);
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = workerUrl;
            s.onload = resolve;
            s.onerror = () => reject(new Error('pdf.js worker failed to load'));
            document.head.appendChild(s);
          });
        }
        return lib;
      })();
      pdfjsPromise.catch(() => { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }

  let pdfLibPromise = null;
  function loadPdfLib() {
    if (!pdfLibPromise) {
      pdfLibPromise = new Promise((resolve, reject) => {
        if (window.PDFLib) return resolve(window.PDFLib);
        const s = document.createElement('script');
        s.src = libUrl('lib-pdflib');
        s.onload = () => (window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib failed to initialise')));
        s.onerror = () => reject(new Error('pdf-lib failed to load'));
        document.head.appendChild(s);
      });
      pdfLibPromise.catch(() => { pdfLibPromise = null; });
    }
    return pdfLibPromise;
  }

  // ---------------------------------------------------------------------------
  // Opening files
  // ---------------------------------------------------------------------------
  function sniffType(bytes, file) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    if (head.includes('%PDF-')) return { kind: 'pdf', type: 'pdf' };
    const b = bytes;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: 'image', type: 'png' };
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', type: 'jpg' };
    const name = (file.name || '').toLowerCase();
    if ((file.type || '').startsWith('image/') || /\.(gif|webp|bmp|avif|svg|ico|heic|heif|tiff?)$/.test(name)) {
      return { kind: 'image', type: 'other' };
    }
    if (file.type === 'application/pdf' || name.endsWith('.pdf')) return { kind: 'pdf', type: 'pdf' };
    return null;
  }

  function hasWork() {
    return state.dirty && (state.box !== null || state.strokes.length > 0);
  }

  async function openFile(file, handle = null) {
    if (!file) return;
    if (state.doc && hasWork()) {
      const ok = await confirmDialog(t('confirm.text', { name: file.name }));
      if (!ok) return;
    }
    const token = ++openToken;
    const done = busy(t('busy.opening'));
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sniff = sniffType(bytes, file);
      if (!sniff) throw new UserError(t('err.unsupported'));
      const doc = { kind: sniff.kind, type: sniff.type, name: file.name || 'document', bytes, handle, pages: [] };
      if (sniff.kind === 'pdf') await loadPdfDoc(doc, done);
      else await loadImageDoc(doc, file);
      if (token !== openToken) { closeDocObjects(doc); return; }
      showDocument(doc);
    } catch (e) {
      if (e && e.name === 'CancelledOpen') return;
      console.warn('Open failed:', e);
      toast(e instanceof UserError ? e.message : t('err.open', { error: errorMessage(e) }), true);
    } finally {
      done();
    }
  }

  class UserError extends Error {}

  async function loadPdfDoc(doc) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
      data: doc.bytes.slice(),        // pdf.js transfers the buffer; keep the original intact
      isEvalSupported: false,         // keeps the CSP free of 'unsafe-eval'
      useWasm: false,                 // decoders are not bundled; pdf.js uses its JS paths
      enableXfa: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    let cancelled = false;
    task.onPassword = (update, reason) => {
      askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (pw === null) { cancelled = true; task.destroy(); } else update(pw);
      });
    };
    let pdf;
    try {
      pdf = await task.promise;
    } catch (e) {
      if (cancelled) { const c = new Error('cancelled'); c.name = 'CancelledOpen'; throw c; }
      if (e && e.name === 'InvalidPDFException') throw new UserError(t('err.damaged'));
      throw e;
    }
    doc.pdf = pdf;
    doc.loadingTask = task;
    const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
    doc.pages = pages.map((pdfPage, index) => {
      const vp = pdfPage.getViewport({ scale: 1 });
      return { index, pdfPage, baseW: vp.width, baseH: vp.height };
    });
  }

  function askPassword(incorrect) {
    els.pwdNote.textContent = t(incorrect ? 'pwd.incorrect' : 'pwd.prompt');
    els.pwdInput.value = '';
    const p = showDialog(els.pwdDlg).then((v) => (v === 'ok' ? els.pwdInput.value : null));
    els.pwdInput.focus();
    return p;
  }

  async function loadImageDoc(doc, file) {
    const mime = doc.type === 'png' ? 'image/png' : doc.type === 'jpg' ? 'image/jpeg' : (file.type || '');
    const blob = new Blob([doc.bytes], { type: mime });
    let source = null;
    try {
      source = await createImageBitmap(blob);
    } catch (e) {
      source = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new UserError(t('err.imageFormat'))); };
        img.src = url;
      });
    }
    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;
    if (!w || !h) throw new UserError(t('err.noSize'));
    doc.image = { source, w, h };
    doc.pages = [{ index: 0, baseW: w, baseH: h }];
  }

  function closeDocObjects(doc) {
    if (!doc) return;
    for (const p of doc.pages) { if (p.task) try { p.task.cancel(); } catch (e) { /* ignore */ } }
    if (doc.loadingTask) doc.loadingTask.destroy().catch(() => {});
    if (doc.image && doc.image.source && doc.image.source.close) doc.image.source.close();
  }

  function showDocument(doc) {
    if (pageObserver) pageObserver.disconnect();
    cancelGestures();
    closeDocObjects(state.doc);
    els.pages.textContent = '';
    state.doc = doc;
    state.box = null;
    state.strokes = [];
    state.undo = [];
    state.redo = [];
    state.dirty = false;
    boxEl.remove();

    pageObserver = new IntersectionObserver(onPagesIntersect, { rootMargin: '900px 0px' });
    doc.pages.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = String(p.index);
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', t('page.aria', { n: p.index + 1, total: doc.pages.length }));
      if (doc.pages.length > 1) {
        const num = document.createElement('span');
        num.className = 'page-num';
        num.textContent = `${p.index + 1} / ${doc.pages.length}`;
        el.appendChild(num);
      }
      p.el = el;
      p.canvas = null;
      p.renderedKey = '';
      p.visible = false;
      els.pages.appendChild(el);
      pageObserver.observe(el);
    });

    els.start.hidden = true;
    els.topbar.hidden = false;
    els.toolbar.hidden = false;
    els.filename.textContent = doc.name;
    document.title = t('page.titleDoc', { name: doc.name });
    layoutPages();
    window.scrollTo(0, 0);
    updateUI();
  }

  // ---------------------------------------------------------------------------
  // Page layout and rendering
  // ---------------------------------------------------------------------------
  function viewScale() {
    const zoom = window.visualViewport ? clamp(window.visualViewport.scale || 1, 1, 3) : 1;
    return (window.devicePixelRatio || 1) * zoom;
  }

  function capSize(w, h) {
    let k = 1;
    if (w * h > MAX_CANVAS_AREA) k = Math.sqrt(MAX_CANVAS_AREA / (w * h));
    k = Math.min(k, MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h);
    return [Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k))];
  }

  let lastLayoutWidth = 0;
  function layoutPages() {
    const doc = state.doc;
    if (!doc) return;
    const avail = Math.max(120, Math.min(els.pages.clientWidth - 24, MAX_PAGE_CSS_WIDTH));
    lastLayoutWidth = els.pages.clientWidth;
    for (const p of doc.pages) {
      let w = avail;
      if (doc.kind === 'image') w = Math.min(avail, Math.max(p.baseW, 280));
      p.cssW = w;
      p.cssH = (w * p.baseH) / p.baseW;
      p.el.style.width = `${p.cssW}px`;
      p.el.style.height = `${p.cssH}px`;
    }
    for (const p of doc.pages) if (p.visible) schedulePageRender(p);
    placeBox();
  }

  function onPagesIntersect(entries) {
    const doc = state.doc;
    if (!doc) return;
    for (const entry of entries) {
      const p = doc.pages[Number(entry.target.dataset.page)];
      if (!p || p.el !== entry.target) continue;
      p.visible = entry.isIntersecting;
      if (p.visible) schedulePageRender(p);
      else if (doc.kind === 'pdf' && p.canvas) {
        // Free memory of pages far outside the viewport; they re-render when they come back.
        if (p.task) { p.task.cancel(); p.task = null; }
        p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove();
        p.canvas = null; p.renderedKey = '';
      }
    }
  }

  function schedulePageRender(p) {
    renderPage(p).catch((e) => {
      if (e && e.name === 'RenderingCancelledException') return;
      console.warn('Page render failed:', e);
      toast(t('err.render', { n: p.index + 1 }), true);
    });
  }

  async function renderPage(p) {
    const doc = state.doc;
    const ratio = viewScale();
    const [pw, ph] = capSize(Math.round(p.cssW * ratio), Math.round(p.cssH * ratio));
    const key = `${pw}x${ph}`;
    if (p.renderedKey === key || p.pendingKey === key) return;
    if (p.task) { p.task.cancel(); p.task = null; }
    p.pendingKey = key;
    const canvas = document.createElement('canvas');
    canvas.className = 'render';
    canvas.setAttribute('aria-hidden', 'true');
    try {
      if (doc.kind === 'pdf') {
        const viewport = p.pdfPage.getViewport({ scale: pw / p.baseW });
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const task = p.pdfPage.render({ canvas, viewport });
        p.task = task;
        try { await task.promise; } finally { if (p.task === task) p.task = null; }
      } else {
        canvas.width = pw; canvas.height = ph;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(doc.image.source, 0, 0, pw, ph);
      }
    } finally {
      if (p.pendingKey === key) p.pendingKey = '';
    }
    if (state.doc !== doc || !p.el.isConnected) return;
    if (p.canvas) { p.canvas.width = 0; p.canvas.remove(); }
    p.el.insertBefore(canvas, p.el.firstChild);
    p.canvas = canvas;
    p.renderedKey = key;
  }

  let resizeTimer = 0;
  new ResizeObserver(() => {
    if (!state.doc || els.pages.clientWidth === lastLayoutWidth) return;
    layoutPages();
    clearTimeout(resizeTimer);
  }).observe(els.pages);
  if (window.visualViewport) {
    let zoomTimer = 0;
    window.visualViewport.addEventListener('resize', () => {
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(() => {
        if (!state.doc) return;
        for (const p of state.doc.pages) if (p.visible) schedulePageRender(p);
        sizeInkCanvas();
      }, 250);
    });
  }
  window.matchMedia && window.addEventListener('resize', () => {
    // devicePixelRatio changes (moving the window to another screen, browser zoom)
    if (!state.doc) return;
    for (const p of state.doc.pages) if (p.visible) schedulePageRender(p);
    sizeInkCanvas();
  });

  function mostVisiblePage() {
    const doc = state.doc;
    if (!doc) return 0;
    const top = els.topbar.getBoundingClientRect().bottom;
    const bottom = Math.min(window.innerHeight, els.toolbar.getBoundingClientRect().top || window.innerHeight);
    let best = 0; let bestArea = -1;
    for (const p of doc.pages) {
      const r = p.el.getBoundingClientRect();
      const vis = Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top));
      if (vis > bestArea + 0.5) { best = p.index; bestArea = vis; }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Strokes
  // ---------------------------------------------------------------------------
  function drawStrokes(ctx, strokes, W, H) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      const pts = s.points;
      if (!pts.length) continue;
      const lw = Math.max(0.5, s.width * H);
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      const first = pts[0];
      const isDot = pts.every((p) => Math.abs(p.x - first.x) * W < 0.75 && Math.abs(p.y - first.y) * H < 0.75);
      if (isDot) {
        ctx.beginPath();
        ctx.arc(first.x * W, first.y * H, lw / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(first.x * W, first.y * H);
      if (pts.length === 2) {
        ctx.lineTo(pts[1].x * W, pts[1].y * H);
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const a = pts[i]; const b = pts[i + 1];
          ctx.quadraticCurveTo(a.x * W, a.y * H, ((a.x + b.x) / 2) * W, ((a.y + b.y) / 2) * H);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x * W, last.y * H);
      }
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------------
  // The signature box element
  // ---------------------------------------------------------------------------
  const boxEl = document.createElement('div');
  boxEl.className = 'sigbox';
  boxEl.setAttribute('role', 'group');
  boxEl.setAttribute('aria-label', t('box.aria'));
  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-move"/></svg><span></span>';
  grip.lastChild.textContent = t('box.move');
  grip.dataset.mode = 'move';
  const ink = document.createElement('canvas');
  ink.className = 'ink';
  ink.setAttribute('aria-hidden', 'true');
  boxEl.appendChild(ink);
  for (const side of ['t', 'r', 'b', 'l']) {
    const e = document.createElement('div');
    e.className = `edge ${side}`;
    e.dataset.mode = 'move';
    boxEl.appendChild(e);
  }
  for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const e = document.createElement('div');
    e.className = `h ${h}`;
    e.dataset.mode = h;
    boxEl.appendChild(e);
  }
  boxEl.appendChild(grip);
  const inkCtx = ink.getContext('2d');

  function boxPage() {
    return state.doc && state.box ? state.doc.pages[state.box.page] : null;
  }

  function placeBox() {
    const box = state.box;
    if (!box || !state.doc) { boxEl.remove(); return; }
    const page = state.doc.pages[box.page];
    // While a move gesture crosses pages, the element stays in its original page
    // (re-parenting would drop pointer capture) and is positioned relative to it.
    const host = gesture && gesture.host ? gesture.host : page;
    if (boxEl.parentNode !== host.el) host.el.appendChild(boxEl);
    let { x, y, w, h } = box;
    if (host !== page) {
      const hr = host.el.getBoundingClientRect();
      const pr = page.el.getBoundingClientRect();
      x = (pr.left + x * pr.width - hr.left) / hr.width;
      y = (pr.top + y * pr.height - hr.top) / hr.height;
      w = (w * pr.width) / hr.width;
      h = (h * pr.height) / hr.height;
    }
    boxEl.style.left = `${x * 100}%`;
    boxEl.style.top = `${y * 100}%`;
    boxEl.style.width = `${w * 100}%`;
    boxEl.style.height = `${h * 100}%`;
    sizeInkCanvas();
  }

  function boxCssSize() {
    const page = boxPage();
    if (!page) return [0, 0];
    return [state.box.w * page.cssW, state.box.h * page.cssH];
  }

  function sizeInkCanvas() {
    if (!state.box) return;
    const [bw, bh] = boxCssSize();
    const [cw, ch] = capSize(Math.max(1, Math.round(bw * viewScale())), Math.max(1, Math.round(bh * viewScale())));
    if (ink.width !== cw || ink.height !== ch) { ink.width = cw; ink.height = ch; }
    redrawInk();
  }

  let inkFrame = 0;
  function requestInk() {
    if (!inkFrame) inkFrame = requestAnimationFrame(() => { inkFrame = 0; redrawInk(); });
  }
  function redrawInk() {
    inkCtx.clearRect(0, 0, ink.width, ink.height);
    const list = drawing ? state.strokes.concat([drawing.stroke]) : state.strokes;
    drawStrokes(inkCtx, list, ink.width, ink.height);
  }

  // --- drawing --------------------------------------------------------------
  ink.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || drawing || gesture) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    closePopovers();
    try { ink.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const rect = ink.getBoundingClientRect();
    drawing = { id: e.pointerId, rect, stroke: { color: state.color, width: STROKE_WIDTH, points: [] } };
    addPoint(e);
    requestInk();
  });
  function addPoint(e) {
    const r = drawing.rect;
    const pts = drawing.stroke.points;
    const x = clamp((e.clientX - r.left) / r.width, -0.5, 1.5);
    const y = clamp((e.clientY - r.top) / r.height, -0.5, 1.5);
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.x - x) * r.width < 0.6 && Math.abs(last.y - y) * r.height < 0.6) return;
    pts.push({ x, y });
  }
  ink.addEventListener('pointermove', (e) => {
    if (!drawing || e.pointerId !== drawing.id) return;
    e.preventDefault();
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    if (list && list.length) for (const ce of list) addPoint(ce);
    else addPoint(e);
    requestInk();
  });
  function finishStroke(e, keep) {
    if (!drawing || (e && e.pointerId !== drawing.id)) return;
    const stroke = drawing.stroke;
    drawing = null;
    if (keep && stroke.points.length) {
      const before = snapshot();
      stroke.points.forEach(Object.freeze);
      state.strokes = state.strokes.concat([Object.freeze({ color: stroke.color, width: stroke.width, points: Object.freeze(stroke.points) })]);
      pushHistory(before);
    }
    requestInk();
  }
  ink.addEventListener('pointerup', (e) => finishStroke(e, true));
  ink.addEventListener('pointercancel', (e) => finishStroke(e, false));
  ink.addEventListener('lostpointercapture', (e) => finishStroke(e, true));

  // --- moving and resizing --------------------------------------------------
  function pageAtPoint(cx, cy) {
    for (const p of state.doc.pages) {
      const r = p.el.getBoundingClientRect();
      if (cy >= r.top && cy <= r.bottom && cx >= r.left - 60 && cx <= r.right + 60) return p;
    }
    return null;
  }

  boxEl.addEventListener('pointerdown', (e) => {
    const mode = e.target.closest && e.target.closest('[data-mode]') ? e.target.closest('[data-mode]').dataset.mode : null;
    if (!mode || !e.isPrimary || drawing || gesture || !state.box) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    closePopovers();
    const target = e.target.closest('[data-mode]');
    try { target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const page = boxPage();
    const pageRect = page.el.getBoundingClientRect();
    const boxRect = boxEl.getBoundingClientRect();
    gesture = {
      id: e.pointerId, mode, target, host: page, before: snapshot(), start: { ...state.box },
      sx: e.clientX, sy: e.clientY, pageRect,
      offX: e.clientX - boxRect.left, offY: e.clientY - boxRect.top,
      wpx: boxRect.width, hpx: boxRect.height,
    };
    boxEl.classList.add(mode === 'move' ? 'moving' : 'resizing');
  });

  boxEl.addEventListener('pointermove', (e) => {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    e.preventDefault();
    if (g.mode === 'move') {
      const target = pageAtPoint(e.clientX, e.clientY) || state.doc.pages[state.box.page];
      const r = target.el.getBoundingClientRect();
      const w = Math.min(1, g.wpx / r.width);
      const h = Math.min(1, g.hpx / r.height);
      const x = clamp((e.clientX - g.offX - r.left) / r.width, 0, 1 - w);
      const y = clamp((e.clientY - g.offY - r.top) / r.height, 0, 1 - h);
      state.box = { page: target.index, x, y, w, h };
    } else {
      const pr = g.pageRect;
      const dx = (e.clientX - g.sx) / pr.width;
      const dy = (e.clientY - g.sy) / pr.height;
      const minW = Math.min(1, MIN_BOX_PX / pr.width);
      const minH = Math.min(1, MIN_BOX_PX / pr.height);
      const s = g.start;
      let l = s.x; let t = s.y; let rr = s.x + s.w; let b = s.y + s.h;
      if (g.mode.includes('w')) l = clamp(l + dx, 0, rr - minW);
      if (g.mode.includes('e')) rr = clamp(rr + dx, l + minW, 1);
      if (g.mode.includes('n')) t = clamp(t + dy, 0, b - minH);
      if (g.mode.includes('s')) b = clamp(b + dy, t + minH, 1);
      state.box = { page: s.page, x: l, y: t, w: rr - l, h: b - t };
    }
    placeBox();
  });

  function endGesture(e) {
    const g = gesture;
    if (!g || (e && e.pointerId !== g.id)) return;
    gesture = null;
    boxEl.classList.remove('moving', 'resizing');
    const a = g.start; const b = state.box;
    const changed = b && (a.page !== b.page || ['x', 'y', 'w', 'h'].some((k) => Math.abs(a[k] - b[k]) > 1e-6));
    placeBox(); // re-parents to the new page if the box moved across pages
    if (changed) pushHistory(g.before);
  }
  boxEl.addEventListener('pointerup', endGesture);
  boxEl.addEventListener('pointercancel', endGesture);
  boxEl.addEventListener('lostpointercapture', endGesture);

  function cancelGestures() {
    drawing = null;
    gesture = null;
    boxEl.classList.remove('moving', 'resizing');
  }

  // Keep the browser from starting text selection / callouts inside the box.
  boxEl.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------
  function snapshot() {
    return { box: state.box ? { ...state.box } : null, strokes: state.strokes };
  }
  function pushHistory(before) {
    state.undo.push(before);
    if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
    state.redo.length = 0;
    state.dirty = true;
    updateUI();
  }
  function restore(snap) {
    state.box = snap.box ? { ...snap.box } : null;
    state.strokes = snap.strokes;
    state.dirty = true;
    placeBox();
    updateUI();
  }
  function undo() {
    if (!state.undo.length || drawing || gesture) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
  }
  function redo() {
    if (!state.redo.length || drawing || gesture) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
  }

  // ---------------------------------------------------------------------------
  // Box actions
  // ---------------------------------------------------------------------------
  function addBox() {
    const doc = state.doc;
    if (!doc || state.box) return;
    const index = mostVisiblePage();
    const p = doc.pages[index];
    const r = p.el.getBoundingClientRect();
    const top = els.topbar.getBoundingClientRect().bottom;
    const bottom = Math.min(window.innerHeight, els.toolbar.getBoundingClientRect().top);
    const visTop = Math.max(r.top, top); const visBottom = Math.min(r.bottom, bottom);
    const cy = visBottom > visTop ? (visTop + visBottom) / 2 : r.top + r.height / 2;
    const wpx = clamp(p.cssW * 0.42, Math.min(140, p.cssW), 340);
    const hpx = Math.min(p.cssH, Math.max(MIN_BOX_PX, wpx * 0.38));
    const w = wpx / p.cssW; const h = hpx / p.cssH;
    const x = clamp(0.5 - w / 2, 0, 1 - w);
    const y = clamp((cy - r.top) / r.height - h / 2, 0, 1 - h);
    const before = snapshot();
    state.box = { page: index, x, y, w, h };
    placeBox();
    pushHistory(before);
    toast(t('toast.signHint'));
  }
  function eraseContent() {
    if (!state.strokes.length) return;
    const before = snapshot();
    state.strokes = [];
    redrawInk();
    pushHistory(before);
  }
  function deleteBox() {
    if (!state.box) return;
    const before = snapshot();
    state.box = null;
    state.strokes = [];
    placeBox();
    pushHistory(before);
  }

  // ---------------------------------------------------------------------------
  // Toolbar, popovers, keyboard
  // ---------------------------------------------------------------------------
  function updateUI() {
    const hasDoc = !!state.doc;
    const hasBox = !!state.box;
    els.tbBox.classList.toggle('active-box', hasBox);
    els.tbBox.setAttribute('aria-label', t(hasBox ? 'tb.boxOptions' : 'tb.boxAdd'));
    els.tbBox.dataset.tip = t(hasBox ? 'tb.boxOptionsTip' : 'tb.boxAddTip');
    els.tbBox.disabled = !hasDoc;
    els.tbPen.disabled = !hasDoc;
    els.tbUndo.disabled = !state.undo.length;
    els.tbRedo.disabled = !state.redo.length;
    els.tbSig.disabled = !(hasBox && state.strokes.length);
    els.tbSave.disabled = !hasDoc;
    els.bmErase.disabled = !state.strokes.length;
  }

  function positionPopover(pop, anchor) {
    pop.hidden = false;
    const a = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const vw = document.documentElement.clientWidth;
    pop.style.left = `${clamp(a.left + a.width / 2 - pw / 2, 8, vw - pw - 8)}px`;
    pop.style.bottom = `${window.innerHeight - a.top + 10}px`;
  }
  function closePopovers() {
    for (const [pop, btn] of [[els.boxMenu, els.tbBox], [els.penPop, els.tbPen], [els.visionMenu, els.tbVision]]) {
      if (!pop.hidden) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    }
  }
  function togglePopover(pop, btn, focusSel) {
    const open = pop.hidden;
    closePopovers();
    if (!open) return;
    els.toast.classList.remove('show');
    positionPopover(pop, btn);
    btn.setAttribute('aria-expanded', 'true');
    const f = pop.querySelector(focusSel);
    if (f) f.focus({ preventScroll: true });
  }

  els.tbBox.addEventListener('click', () => {
    if (!state.box) { closePopovers(); addBox(); return; }
    togglePopover(els.boxMenu, els.tbBox, 'button:not(:disabled)');
  });
  els.bmErase.addEventListener('click', () => { closePopovers(); eraseContent(); els.tbBox.focus(); });
  els.bmDelete.addEventListener('click', () => { closePopovers(); deleteBox(); els.tbBox.focus(); });
  els.bmCancel.addEventListener('click', () => { closePopovers(); els.tbBox.focus(); });
  els.boxMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...els.boxMenu.querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });

  // Pen colours
  for (const [key, hex] of COLORS) {
    const name = t(key);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', name);
    b.title = name;
    b.dataset.color = hex;
    b.innerHTML = `<span style="background:${hex}"></span><b class="sw-name">${name}</b>`;
    b.addEventListener('click', () => { setColor(hex); closePopovers(); els.tbPen.focus(); });
    els.penPop.appendChild(b);
  }
  els.penPop.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const items = [...els.penPop.children];
    const i = items.indexOf(document.activeElement);
    items[(i + keys[e.key] + items.length) % items.length].focus();
  });
  function setColor(hex) {
    state.color = hex;
    els.penDot.style.background = hex;
    const name = t(COLORS.find((c) => c[1] === hex)[0]);
    els.tbPen.setAttribute('aria-label', t('tb.pen', { color: name }));
    for (const b of els.penPop.children) {
      const on = b.dataset.color === hex;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  setColor('#000000');
  els.tbPen.addEventListener('click', () => togglePopover(els.penPop, els.tbPen, '[aria-checked="true"]'));

  // Colour vision: normal colours (default) or a palette for protanopia, deuteranopia or
  // tritanopia. Shared with the landing page and the guides; stored locally only.
  const VISION_KEY = 'websign.vision';
  function currentVision() {
    return document.documentElement.getAttribute('data-vision') || 'normal';
  }
  function applyVision(v) {
    if (v === 'protan' || v === 'deutan' || v === 'tritan') document.documentElement.setAttribute('data-vision', v);
    else { document.documentElement.removeAttribute('data-vision'); v = 'normal'; }
    for (const b of els.visionMenu.querySelectorAll('[data-vision]')) {
      b.setAttribute('aria-checked', String(b.dataset.vision === v));
    }
    els.tbVision.classList.toggle('active-box', v !== 'normal');
    return v;
  }
  applyVision(currentVision());
  els.tbVision.addEventListener('click', () => togglePopover(els.visionMenu, els.tbVision, '[aria-checked="true"]'));
  for (const b of els.visionMenu.querySelectorAll('[data-vision]')) {
    b.addEventListener('click', () => {
      const v = applyVision(b.dataset.vision);
      try { localStorage.setItem(VISION_KEY, v); } catch { /* storage unavailable: applies to this page only */ }
      closePopovers();
      els.tbVision.focus();
    });
  }
  els.visionMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...els.visionMenu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });
  window.addEventListener('storage', (e) => { if (e.key === VISION_KEY) applyVision(e.newValue); });

  els.tbUndo.addEventListener('click', undo);
  els.tbRedo.addEventListener('click', redo);
  els.tbSig.addEventListener('click', () => saveSignature());
  els.tbSave.addEventListener('click', () => openSaveDialog());

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.popover') || e.target.closest('#tb-box') || e.target.closest('#tb-pen') || e.target.closest('#tb-vision')) return;
    closePopovers();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.boxMenu.hidden) { closePopovers(); els.tbBox.focus(); return; }
      if (!els.penPop.hidden) { closePopovers(); els.tbPen.focus(); return; }
      if (!els.visionMenu.hidden) { closePopovers(); els.tbVision.focus(); return; }
    }
    if (!state.doc || document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (hasWork()) { e.preventDefault(); e.returnValue = t('unload'); }
  });

  // ---------------------------------------------------------------------------
  // Opening: start screen button, drag and drop
  // ---------------------------------------------------------------------------
  els.openBtn.addEventListener('click', async () => {
    if (hasFsAccess) {
      let handle;
      try {
        [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: t('picker.desc'),
            accept: {
              'application/pdf': ['.pdf'],
              'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg'],
            },
          }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.warn('showOpenFilePicker failed, using the file input instead:', e);
        els.fileInput.click();
        return;
      }
      try {
        openFile(await handle.getFile(), handle);
      } catch (e) {
        toast(t('err.read', { error: errorMessage(e) }), true);
      }
      return;
    }
    els.fileInput.click();
  });
  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    els.fileInput.value = '';
    if (f) openFile(f, null);
  });

  let dragDepth = 0;
  const isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    if (state.doc) els.dropOverlay.hidden = false;
    else els.dropzone.classList.add('over');
  });
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) { els.dropOverlay.hidden = true; els.dropzone.classList.remove('over'); }
  });
  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    els.dropzone.classList.remove('over');
    const item = e.dataTransfer.items && [...e.dataTransfer.items].find((i) => i.kind === 'file');
    // Both calls must happen synchronously inside the drop event.
    const handlePromise = item && typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle() : null;
    const file = item ? item.getAsFile() : (e.dataTransfer.files && e.dataTransfer.files[0]);
    let handle = null;
    if (handlePromise) {
      try { handle = await handlePromise; } catch (err) { handle = null; }
      if (handle && handle.kind !== 'file') handle = null;
    }
    if (file) openFile(file, handle);
  });

  // ---------------------------------------------------------------------------
  // Export helpers
  // ---------------------------------------------------------------------------
  function baseName() {
    const n = state.doc ? state.doc.name : 'document';
    return n.replace(/\.[^.]+$/, '') || 'document';
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('err.tooLarge')))), mime, quality);
    });
  }

  /** Native (document-unit) size of the box: PDF points or image pixels. */
  function boxNativeSize() {
    const p = boxPage();
    return [state.box.w * p.baseW, state.box.h * p.baseH];
  }

  /** Signature strokes on a transparent canvas, box size × 3 (min 1200 px wide). */
  function signatureCanvas() {
    const [nw, nh] = boxNativeSize();
    let W = Math.max(1200, Math.round(nw * 3));
    let H = Math.round((W * nh) / nw);
    [W, H] = capSize(W, Math.max(1, H));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    drawStrokes(c.getContext('2d'), state.strokes, W, H);
    return c;
  }

  // Android browsers built on the system WebView (DuckDuckGo, Via, Lightning…) cannot
  // download blob: URLs at all; most of them do handle data: URLs. Chromium marks the
  // WebView with "; wv)" in its user agent; DuckDuckGo adds "DuckDuckGo/".
  function isAndroidWebView() {
    const ua = navigator.userAgent || '';
    return /Android/i.test(ua) && (/; wv\)/.test(ua) || /DuckDuckGo\//.test(ua));
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // The system share sheet with a file: on iPhone/iPad it offers "Save to Files", where
  // the user chooses the folder; on Android it offers Drive, Files, mail…
  function canShareFile(file) {
    try {
      return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [file] });
    } catch {
      return false;
    }
  }

  /**
   * Offers the file in a small dialog: a real link the user clicks (most reliable way to
   * download everywhere, including Safari/iOS where a download started by script after a
   * slow export is ignored) and, where available, the system share sheet.
   */
  async function offerDownload(blob, name) {
    const webView = isAndroidWebView();
    const url = webView ? await blobToDataUrl(blob) : URL.createObjectURL(blob);
    const file = new File([blob], name, { type: blob.type });
    const shareable = canShareFile(file);
    const link = els.readyLink;
    link.href = url;
    link.download = name;
    els.readyShare.hidden = !shareable;
    els.readyNote.textContent = t(shareable ? 'ready.noteShare' : 'ready.note', { name });
    // The export is finished: hide the "Saving…" indicator while waiting for the user.
    const busyWasShown = !els.busy.hidden;
    els.busy.hidden = true;
    return new Promise((resolve) => {
      let saved = false;
      let toastMsg = '';
      const onClick = () => {
        saved = true;
        toastMsg = t('toast.downloaded', { name });
        // Let the browser start the download from this click, then close.
        setTimeout(() => els.readyDlg.close('saved'), 0);
      };
      const onShare = async () => {
        try {
          await navigator.share({ files: [file], title: name });
          saved = true;
          toastMsg = t('toast.shared', { name });
          els.readyDlg.close('shared');
        } catch (e) {
          if (!e || e.name !== 'AbortError') toast(t('err.share', { error: errorMessage(e) }), true);
        }
      };
      link.addEventListener('click', onClick);
      els.readyShare.addEventListener('click', onShare);
      els.readyDlg.addEventListener('close', function onClose() {
        els.readyDlg.removeEventListener('close', onClose);
        link.removeEventListener('click', onClick);
        els.readyShare.removeEventListener('click', onShare);
        if (!webView) setTimeout(() => URL.revokeObjectURL(url), 120000);
        link.href = '#';
        if (busyWasShown && busyDepth) els.busy.hidden = false;
        if (saved) savedToast(toastMsg);
        resolve(saved);
      });
      els.readyDlg.showModal();
      link.focus();
    });
  }

  /**
   * "Create a copy": let the user choose the location with showSaveFilePicker where it
   * exists, otherwise download. The picker must be opened first, while the click's user
   * activation is still valid; the (possibly slow) export runs afterwards.
   */
  async function saveAsCopy(makeBlob, name, fmt) {
    const info = FORMAT_INFO[fmt];
    let handle = null;
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: info.label, accept: { [info.mime]: info.accept } }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return false;
        console.warn('showSaveFilePicker failed, downloading instead:', e);
        handle = null;
      }
    }
    const blob = await makeBlob();
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      savedToast(t('toast.saved', { name: handle.name || name }));
    } else {
      // No "Save as" picker in this browser (Firefox, Safari, mobile browsers, Brave…).
      // A download started by script after the export is silently dropped by several of
      // them, so hand the user a real link to click instead.
      return offerDownload(blob, name);
    }
    return true;
  }

  async function saveSignature() {
    if (!state.box || !state.strokes.length) return;
    try {
      await saveAsCopy(() => canvasToBlob(signatureCanvas(), 'image/png'), 'signature.png', 'png');
    } catch (e) {
      console.warn(e);
      toast(t('err.sig', { error: errorMessage(e) }), true);
    }
  }

  function exportPageIndex() {
    return state.box ? state.box.page : mostVisiblePage();
  }

  /** Renders a page at high resolution with the signature composited. */
  async function renderPageForExport(index, { withOutline, opaque }) {
    const doc = state.doc;
    const p = doc.pages[index];
    let canvas;
    if (doc.kind === 'pdf') {
      let scale = EXPORT_SCALE;
      const [cw] = capSize(Math.round(p.baseW * scale), Math.round(p.baseH * scale));
      scale = cw / p.baseW;
      const viewport = p.pdfPage.getViewport({ scale });
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      await p.pdfPage.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise;
    } else {
      const [W, H] = capSize(doc.image.w, doc.image.h);
      canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      if (opaque) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(doc.image.source, 0, 0, W, H);
    }
    const box = state.box;
    if (box && box.page === index) {
      const ctx = canvas.getContext('2d');
      const W = canvas.width; const H = canvas.height;
      const bx = box.x * W; const by = box.y * H; const bw = box.w * W; const bh = box.h * H;
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx, by, bw, bh);
      ctx.clip();
      ctx.translate(bx, by);
      drawStrokes(ctx, state.strokes, bw, bh);
      ctx.restore();
      if (withOutline) {
        const lw = Math.max(1, Math.round(W / 700));
        ctx.save();
        ctx.strokeStyle = `rgb(${OUTLINE_COLOR.map((c) => Math.round(c * 255)).join(',')})`;
        ctx.lineWidth = lw;
        ctx.strokeRect(bx + lw / 2, by + lw / 2, bw - lw, bh - lw);
        ctx.restore();
      }
    }
    return canvas;
  }

  async function exportImage(fmt, withOutline) {
    const canvas = await renderPageForExport(exportPageIndex(), { withOutline, opaque: fmt === 'jpg' });
    if (fmt === 'jpg') {
      // JPEG has no alpha: flatten on white.
      const flat = document.createElement('canvas');
      flat.width = canvas.width; flat.height = canvas.height;
      const ctx = flat.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, flat.width, flat.height);
      ctx.drawImage(canvas, 0, 0);
      canvas.width = 0;
      return canvasToBlob(flat, 'image/jpeg', 0.92);
    }
    return canvasToBlob(canvas, 'image/png');
  }

  async function signaturePngBytes() {
    const blob = await canvasToBlob(signatureCanvas(), 'image/png');
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Draws signature/outline on a pdf-lib page given the box rectangle in PDF user space. */
  async function stampPdfPage(PDFLib, pdfDoc, page, corners, withOutline) {
    const { tl, tr, bl } = corners;
    if (state.strokes.length) {
      const png = await pdfDoc.embedPng(await signaturePngBytes());
      const width = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
      const height = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
      const angle = (Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180) / Math.PI;
      // The image's bottom-left corner sits at the box's on-screen bottom-left corner;
      // its x axis follows the box's on-screen top edge (handles /Rotate).
      page.drawImage(png, { x: bl[0], y: bl[1], width, height, rotate: PDFLib.degrees(angle) });
    }
    if (withOutline) {
      const br = [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1]];
      const xs = [tl[0], tr[0], bl[0], br[0]]; const ys = [tl[1], tr[1], bl[1], br[1]];
      const x0 = Math.min(...xs); const y0 = Math.min(...ys);
      const bw = 0.75;
      page.drawRectangle({
        x: x0 + bw / 2, y: y0 + bw / 2,
        width: Math.max(...xs) - x0 - bw, height: Math.max(...ys) - y0 - bw,
        borderWidth: bw, borderColor: PDFLib.rgb(...OUTLINE_COLOR),
      });
    }
  }

  async function exportPdf(withOutline) {
    const PDFLib = await loadPdfLib();
    const doc = state.doc;
    const box = state.box;
    if (doc.kind === 'image') {
      const out = await PDFLib.PDFDocument.create();
      const { w, h } = doc.image;
      const ptW = w * 0.75; const ptH = h * 0.75; // 96 px per inch
      let img = null;
      try {
        if (doc.type === 'jpg' && jpegOrientation(doc.bytes) <= 1) img = await out.embedJpg(doc.bytes);
        else if (doc.type === 'png') img = await out.embedPng(doc.bytes);
      } catch (e) { img = null; }
      if (!img) {
        const [cw, ch] = capSize(w, h);
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(doc.image.source, 0, 0, cw, ch);
        const blob = await canvasToBlob(c, 'image/png');
        img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
      }
      const page = out.addPage([ptW, ptH]);
      page.drawImage(img, { x: 0, y: 0, width: ptW, height: ptH });
      if (box) await stampPdfPage(PDFLib, out, page, flatCorners(box, ptW, ptH), withOutline);
      return out.save();
    }

    let pdfDoc = null;
    try {
      pdfDoc = await PDFLib.PDFDocument.load(doc.bytes, { updateMetadata: false });
    } catch (e) {
      console.warn('pdf-lib cannot edit this PDF, rasterising instead:', e);
    }
    if (!pdfDoc) return rasterPdf(PDFLib, withOutline);
    if (box) {
      const p = doc.pages[box.page];
      const vp = p.pdfPage.getViewport({ scale: 1 });
      const pt = (fx, fy) => vp.convertToPdfPoint(fx * vp.width, fy * vp.height);
      const corners = { tl: pt(box.x, box.y), tr: pt(box.x + box.w, box.y), bl: pt(box.x, box.y + box.h) };
      await stampPdfPage(PDFLib, pdfDoc, pdfDoc.getPage(box.page), corners, withOutline);
    }
    return pdfDoc.save();
  }

  /** Box corners for an unrotated page of size W×H points whose origin is bottom-left. */
  function flatCorners(box, W, H) {
    return {
      tl: [box.x * W, H - box.y * H],
      tr: [(box.x + box.w) * W, H - box.y * H],
      bl: [box.x * W, H - (box.y + box.h) * H],
    };
  }

  /** Fallback for PDFs pdf-lib cannot modify (e.g. encrypted): every page as a JPEG. */
  async function rasterPdf(PDFLib, withOutline) {
    const doc = state.doc;
    const out = await PDFLib.PDFDocument.create();
    for (const p of doc.pages) {
      setBusyText(t('busy.raster', { n: p.index + 1, total: doc.pages.length }));
      const [cw] = capSize(Math.round(p.baseW * 2), Math.round(p.baseH * 2));
      const viewport = p.pdfPage.getViewport({ scale: cw / p.baseW });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(viewport.width));
      c.height = Math.max(1, Math.floor(viewport.height));
      await p.pdfPage.render({ canvas: c, viewport, background: 'rgb(255,255,255)' }).promise;
      const blob = await canvasToBlob(c, 'image/jpeg', 0.9);
      c.width = 0;
      const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      const page = out.addPage([p.baseW, p.baseH]);
      page.drawImage(jpg, { x: 0, y: 0, width: p.baseW, height: p.baseH });
      if (state.box && state.box.page === p.index) {
        await stampPdfPage(PDFLib, out, page, flatCorners(state.box, p.baseW, p.baseH), withOutline);
      }
    }
    exportNotice = t('toast.rasterised');
    return out.save();
  }

  /** EXIF orientation of a JPEG (1 = upright, 0 = unknown). */
  function jpegOrientation(b) {
    if (b[0] !== 0xff || b[1] !== 0xd8) return 0;
    let i = 2;
    while (i + 4 < b.length) {
      if (b[i] !== 0xff) return 0;
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
        const t = i + 10; // TIFF header
        const le = b[t] === 0x49;
        const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
        const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (e + 12 > b.length) break;
          if (u16(e) === 0x0112) return u16(e + 8);
        }
        return 1;
      }
      if (marker === 0xda) return 1; // start of scan: no EXIF before it
      i += 2 + len;
    }
    return 1;
  }

  // Set by an export that had to deviate from the normal path (raster fallback); shown
  // together with the success message so it is not overwritten by it.
  let exportNotice = null;
  function savedToast(msg) {
    toast(exportNotice ? `${msg}. ${exportNotice}` : msg, !!exportNotice);
    exportNotice = null;
  }

  async function buildExport(fmt, withOutline) {
    exportNotice = null;
    if (fmt === 'pdf') return new Blob([await exportPdf(withOutline)], { type: 'application/pdf' });
    return exportImage(fmt, withOutline);
  }

  // ---------------------------------------------------------------------------
  // Save dialog: Overwrite original / Create a copy / Cancel
  // ---------------------------------------------------------------------------
  function selectedFormat() {
    return els.saveForm.elements.fmt.value;
  }

  function overwriteStatus(fmt) {
    const doc = state.doc;
    if (!hasFsAccess) return { ok: false, reason: t('reason.unsupported') };
    if (!doc.handle || typeof doc.handle.createWritable !== 'function') {
      return { ok: false, reason: t('reason.noHandle') };
    }
    if (doc.type !== fmt) {
      const orig = FORMAT_INFO[doc.type] ? FORMAT_INFO[doc.type].label : t('reason.otherFormat');
      return { ok: false, reason: t('reason.format', { format: orig }) };
    }
    return { ok: true, reason: '' };
  }

  function refreshSaveDialog() {
    const fmt = selectedFormat();
    const doc = state.doc;
    const n = doc.pages.length;
    els.saveNote.textContent = fmt !== 'pdf' && n > 1
      ? t(state.box ? 'save.notePageBox' : 'save.notePage', { n: exportPageIndex() + 1, total: n })
      : '';
    const ow = overwriteStatus(fmt);
    els.saveOverwrite.disabled = !ow.ok;
    els.saveReason.textContent = ow.reason;
    els.saveOutline.disabled = !state.box;
  }

  function openSaveDialog() {
    if (!state.doc) return;
    closePopovers();
    const doc = state.doc;
    const def = doc.type === 'png' || doc.type === 'jpg' ? doc.type : doc.type === 'other' ? 'png' : 'pdf';
    els.saveForm.elements.fmt.value = def;
    els.saveOutline.checked = false;
    refreshSaveDialog();
    els.saveDlg.returnValue = '';
    els.saveDlg.showModal();
  }
  els.saveForm.addEventListener('change', refreshSaveDialog);
  els.saveCancel.addEventListener('click', () => els.saveDlg.close('cancel'));
  els.saveCopy.addEventListener('click', () => {
    const fmt = selectedFormat();
    const outline = els.saveOutline.checked && !!state.box;
    els.saveDlg.close('copy');
    runSave(() => saveAsCopy(() => buildExport(fmt, outline), `${baseName()}-signed.${FORMAT_INFO[fmt].ext}`, fmt));
  });
  els.saveOverwrite.addEventListener('click', () => {
    const fmt = selectedFormat();
    const outline = els.saveOutline.checked && !!state.box;
    if (!overwriteStatus(fmt).ok) return;
    const handle = state.doc.handle;
    // Ask for write permission right away, inside the click's user activation.
    const permission = requestWritePermission(handle);
    els.saveDlg.close('overwrite');
    runSave(async () => {
      if ((await permission) !== 'granted') {
        toast(t('err.permission'), true);
        return false;
      }
      const blob = await buildExport(fmt, outline);
      const w = await handle.createWritable();
      try {
        await w.write(blob);
        await w.close();
      } catch (e) {
        if (typeof w.abort === 'function') w.abort().catch(() => {});
        throw e;
      }
      // state.doc.bytes deliberately stays the ORIGINAL unsigned file for this session,
      // so saving again re-stamps the same signature once instead of twice.
      savedToast(t('toast.overwrote', { name: handle.name || state.doc.name }));
      return true;
    });
  });

  async function requestWritePermission(handle) {
    const opts = { mode: 'readwrite' };
    try {
      if (typeof handle.queryPermission === 'function' && (await handle.queryPermission(opts)) === 'granted') return 'granted';
      if (typeof handle.requestPermission === 'function') return await handle.requestPermission(opts);
      return 'granted'; // no permission API: createWritable() will fail if not allowed
    } catch (e) {
      console.warn('requestPermission failed:', e);
      return 'denied';
    }
  }

  async function runSave(fn) {
    const done = busy(t('busy.saving'));
    try {
      await nextFrame();
      const saved = await fn();
      if (saved) state.dirty = false;
    } catch (e) {
      console.warn('Save failed:', e);
      toast(t('err.save', { error: errorMessage(e) }), true);
    } finally {
      done();
    }
  }

  // ---------------------------------------------------------------------------
  // Read-only hook for automated tests
  // ---------------------------------------------------------------------------
  Object.defineProperty(window, '__websign', {
    value: Object.freeze({
      get box() { return state.box ? { ...state.box } : null; },
      get strokes() { return state.strokes; },
      get color() { return state.color; },
      get pageCount() { return state.doc ? state.doc.pages.length : 0; },
      get kind() { return state.doc ? state.doc.kind : null; },
      get rendered() { return state.doc ? state.doc.pages.map((p) => !!p.renderedKey) : []; },
      get canUndo() { return state.undo.length > 0; },
      get canRedo() { return state.redo.length > 0; },
      t,
    }),
  });

  updateUI();
})();
