#!/usr/bin/env node
// WebSign smoke test: Playwright + system Chrome, page loaded from file://.
//   node test/smoke.mjs            (screenshots go to $SHOTS or /tmp/websign-shots)
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function requireFrom(name, dirs) {
  for (const d of dirs) {
    try { return createRequire(join(d, 'noop.js'))(name); } catch (e) { /* next */ }
  }
  return require(name);
}
const nodePaths = [
  ...(process.env.NODE_PATH || '').split(':').filter(Boolean),
  '/home/claude/.npm-global/lib/node_modules',
  '/opt/npm-tools/node_modules',
];
const { chromium } = requireFrom('playwright', nodePaths);
const PDFLib = require(join(root, 'vendor/pdf-lib/pdf-lib.min.js'));

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const fileUrl = (rel) => pathToFileURL(join(root, rel)).href;
const PAGES = ['index.html', 'app/websign_en.html', 'app/websign_fr.html', 'doc/doc_en.html', 'doc/doc_fr.html'];
let URL_ = fileUrl('app/websign_en.html'); // app page under test (set per language below)
const I18N = new Function(`${readFileSync(join(root, 'src/i18n.js'), 'utf8')}\nreturn I18N;`)();
const tr = (page, key, params) => page.evaluate(([k, p]) => window.__websign.t(k, p), [key, params || null]);
const SHOTS = process.env.SHOTS || '/tmp/websign-shots';
mkdirSync(SHOTS, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'websign-'));

// ---------------------------------------------------------------------------
// tiny test harness
// ---------------------------------------------------------------------------
const results = [];
let current = '';
function check(cond, msg) {
  results.push({ ok: !!cond, msg: `${current}: ${msg}` });
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`);
}
function section(name) { current = name; console.log(`\n# ${name}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
async function makePdf() {
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Page 1: portrait, CropBox offset from the MediaBox origin.
  const p1 = doc.addPage([612, 792]);
  p1.setCropBox(20, 30, 572, 732);
  p1.drawText('WebSign test - page 1', { x: 50, y: 700, size: 20, font, color: rgb(0, 0, 0) });
  p1.drawRectangle({ x: 50, y: 640, width: 200, height: 30, color: rgb(0.1, 0.2, 0.7) });
  // Page 2: /Rotate 90 plus a CropBox offset.
  const p2 = doc.addPage([600, 400]);
  p2.setCropBox(40, 30, 520, 340);
  p2.setRotation(degrees(90));
  p2.drawText('Rotated page 2', { x: 60, y: 320, size: 18, font, color: rgb(0, 0, 0) });
  return doc.save();
}

function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = 235 - Math.round((x / w) * 40);
      raw[o + 1] = 240 - Math.round((y / h) * 30);
      raw[o + 2] = 250;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pdfBytes = Buffer.from(await makePdf());
const pdfPath = join(work, 'sample.pdf');
writeFileSync(pdfPath, pdfBytes);
let encPath = null;
try {
  encPath = join(work, 'protected.pdf');
  execFileSync('qpdf', ['--encrypt', 'secret', 'owner-secret', '256', '--', pdfPath, encPath]);
} catch (e) { encPath = null; }
const pngBytes = makePng(900, 560);
const pngPath = join(work, 'photo.png');
writeFileSync(pngPath, pngBytes);

// ---------------------------------------------------------------------------
// browser helpers
// ---------------------------------------------------------------------------
const consoleErrors = [];
const externalRequests = [];
function watch(page, label) {
  page.on('console', (m) => {
    if (process.env.DEBUG) console.log(`    [${label} console.${m.type()}] ${m.text().slice(0, 300)}`);
    if (m.type() === 'error') consoleErrors.push(`${label}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${label}: pageerror ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!/^(file|blob|data):/.test(u)) externalRequests.push(`${label}: ${u}`);
  });
}

const NO_FS_API = () => {
  for (const k of ['showOpenFilePicker', 'showSaveFilePicker']) {
    Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true });
  }
};

// In-memory stand-in for the File System Access API (native pickers cannot be driven).
const FAKE_FS = () => {
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const fs = { files: {}, writes: [], permission: 'granted', nextOpen: null, saveCalls: 0 };
  window.__fakeFs = fs;
  const handle = (name) => ({
    kind: 'file',
    name,
    async getFile() { const f = fs.files[name]; return new File([fromB64(f.b64)], name, { type: f.type }); },
    async queryPermission() { return 'prompt'; },
    async requestPermission() { return fs.permission; },
    async createWritable() {
      const chunks = [];
      return {
        async write(d) { chunks.push(d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : new Uint8Array(d)); },
        async close() {
          const all = new Uint8Array(await new Blob(chunks).arrayBuffer());
          const type = fs.files[name] ? fs.files[name].type : '';
          fs.files[name] = { b64: toB64(all), type };
          fs.writes.push({ name, size: all.length });
        },
        async abort() {},
      };
    },
  });
  window.showOpenFilePicker = async () => [handle(fs.nextOpen)];
  window.showSaveFilePicker = async (opts) => { fs.saveCalls++; return handle(opts.suggestedName); };
};

async function waitRendered(page, index) {
  await page.waitForFunction((i) => window.__websign.rendered[i] === true, index, { timeout: 20000 });
}

async function openViaInput(page, path) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#open-btn')]);
  await chooser.setFiles(path);
  await page.waitForFunction(() => window.__websign.pageCount > 0, null, { timeout: 20000 });
}

/** Opens a file into an already open document by simulating a drop. */
async function dropFile(page, name, bytes, type) {
  await page.evaluate(async ({ name, b64, type }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type }));
    for (const t of ['dragenter', 'dragover', 'drop']) {
      document.body.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }, { name, b64: Buffer.from(bytes).toString('base64'), type });
}

async function rectOf(page, sel) {
  const r = await page.locator(sel).first().boundingBox();
  if (!r) throw new Error(`no box for ${sel}`);
  return r;
}

async function mouseDrag(page, from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/** Draws a zig-zag in the top-left quadrant of the box (box fractions 0.1..0.4). */
function signaturePath(r) {
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const fx = 0.1 + (0.3 * i) / 16;
    const fy = i % 2 ? 0.15 : 0.38;
    pts.push({ x: r.x + fx * r.width, y: r.y + fy * r.height });
  }
  return pts;
}

async function mouseSign(page) {
  const r = await rectOf(page, '.sigbox .ink');
  const pts = signaturePath(r);
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.up();
}

async function pickColor(page, key) {
  const name = await tr(page, key);
  await page.click('#tb-pen');
  await page.click(`#pen-pop [aria-label="${name}"]`);
}

// Without a "Save as" picker, the app shows a "file ready" dialog with a real link the
// user clicks (programmatic downloads after a slow export are dropped by some browsers).
async function downloadFrom(page, action) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    (async () => {
      await action();
      await page.waitForSelector('#ready-dlg[open] #ready-link', { timeout: 30000 });
      const href = await page.getAttribute('#ready-link', 'href');
      check(/^(blob|data):/.test(href), 'file-ready dialog offers a local link');
      await page.click('#ready-link');
    })(),
  ]);
  await page.waitForSelector('#ready-dlg:not([open])', { state: 'attached', timeout: 5000 });
  const p = await dl.path();
  return { name: dl.suggestedFilename(), bytes: readFileSync(p) };
}

async function saveCopy(page, fmt, outline) {
  await page.click('#tb-save');
  await page.check(`#save-dlg input[name=fmt][value=${fmt}]`);
  if (outline) await page.check('#save-outline'); else await page.uncheck('#save-outline');
  await page.click('#save-copy');
}

/**
 * Pixel analysis of an image region. `box` is in fractions. Returns counts of "red ink"
 * pixels per box quadrant and outside the box, plus "outline grey" pixels on the box edges.
 */
const ANALYSE = async ({ src, box, page }) => {
  let canvas;
  if (src) {
    const bytes = Uint8Array.from(atob(src.b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: src.type }));
    canvas = document.createElement('canvas');
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
  } else {
    canvas = document.querySelectorAll('.page')[page].querySelector('canvas.render');
  }
  const W = canvas.width; const H = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const bx0 = box.x * W; const by0 = box.y * H; const bx1 = (box.x + box.w) * W; const by1 = (box.y + box.h) * H;
  const mx = (bx0 + bx1) / 2; const my = (by0 + by1) / 2;
  const q = { tl: 0, tr: 0, bl: 0, br: 0, outside: 0, edgeGrey: 0, alpha0: 0, alpha255: 0 };
  const isRed = (r, g, b) => r > 140 && g < 110 && b < 110 && r - g > 60;
  const isGrey = (r, g, b, a) => a > 0 && Math.abs(r - g) < 30 && Math.abs(g - b) < 30 && r < 225 && r > 40;
  const band = Math.max(2, Math.round(W / 500));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const r = d[o]; const g = d[o + 1]; const b = d[o + 2]; const a = d[o + 3];
      if (a === 0) q.alpha0++; else if (a === 255) q.alpha255++;
      const inside = x >= bx0 && x < bx1 && y >= by0 && y < by1;
      if (isRed(r, g, b) && a > 128) {
        if (!inside) {
          // tolerate anti-aliasing exactly on the box border
          if (x < bx0 - 2 || x > bx1 + 2 || y < by0 - 2 || y > by1 + 2) q.outside++;
        } else if (x < mx) { if (y < my) q.tl++; else q.bl++; } else if (y < my) q.tr++; else q.br++;
      }
      const nearEdge = x >= bx0 - band && x <= bx1 + band && y >= by0 - band && y <= by1 + band &&
        (Math.abs(x - bx0) <= band || Math.abs(x - bx1) <= band || Math.abs(y - by0) <= band || Math.abs(y - by1) <= band);
      if (nearEdge && isGrey(r, g, b, a)) q.edgeGrey++;
    }
  }
  return { W, H, ...q };
};

async function analyseBytes(page, bytes, type, box) {
  return page.evaluate(ANALYSE, { src: { b64: Buffer.from(bytes).toString('base64'), type }, box });
}

async function analyseRendered(page, index, box) {
  return page.evaluate(ANALYSE, { page: index, box });
}

/** Opens an exported PDF in a fresh viewer page and analyses the rendered page. */
async function analyseExportedPdf(browser, bytes, pageIndex, box) {
  const path = join(work, `check-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(path, bytes);
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(NO_FS_API);
  const page = await ctx.newPage();
  watch(page, 'verify');
  await page.goto(URL_);
  await openViaInput(page, path);
  await page.locator('.page').nth(pageIndex).scrollIntoViewIfNeeded();
  await waitRendered(page, pageIndex);
  const res = await analyseRendered(page, pageIndex, box);
  await ctx.close();
  return res;
}

async function pdfInfo(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes);
  const images = doc.getPages().map((p) => {
    const xo = p.node.Resources() && p.node.Resources().lookup(PDFLib.PDFName.of('XObject'));
    return xo ? xo.keys().length : 0;
  });
  return { pages: doc.getPageCount(), images, rotations: doc.getPages().map((p) => p.getRotation().angle) };
}

const isPdf = (b) => Buffer.from(b).subarray(0, 5).toString('latin1') === '%PDF-';

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
async function staticSuite() {
  section('i18n dictionary');
  const en = Object.keys(I18N.en).sort(); const fr = Object.keys(I18N.fr).sort();
  check(JSON.stringify(en) === JSON.stringify(fr), `same keys in en and fr (${en.length} keys)`);
  const empty = ['en', 'fr'].flatMap((l) => Object.entries(I18N[l]).filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => `${l}:${k}`));
  check(empty.length === 0, `no empty strings ${empty.join(', ')}`);
  const same = en.filter((k) => I18N.en[k] === I18N.fr[k] && !/^(doc\.aria|color\.orange|save\.format|page\.titleDoc)$/.test(k));
  check(same.length === 0, `no untranslated strings (identical en/fr: ${same.join(', ') || 'none'})`);
  const appSrc = readFileSync(join(root, 'src/app.js'), 'utf8') + readFileSync(join(root, 'src/app.html'), 'utf8');
  const used = new Set([...appSrc.matchAll(/(?:\bt\(|data-i18n(?:-aria|-tip)?=)['"]([\w.]+)['"]/g)].map((m) => m[1]));
  for (const m of appSrc.matchAll(/\['(color\.\w+)'/g)) used.add(m[1]);
  const missing = [...used].filter((k) => !(k in I18N.en));
  check(missing.length === 0, `every key used in the source exists (${used.size} used${missing.length ? `, missing: ${missing}` : ''})`);

  section('static pages and links (file://)');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  watch(page, 'static');
  const expect = {
    'index.html': { lang: 'en', title: /WebSign/ },
    'app/websign_en.html': { lang: 'en', title: /^WebSign – Sign a PDF/ },
    'app/websign_fr.html': { lang: 'fr', title: /^WebSign – Signer un PDF/ },
    'doc/doc_en.html': { lang: 'en', title: /User guide/ },
    'doc/doc_fr.html': { lang: 'fr', title: /Guide d’utilisation/ },
  };
  for (const rel of PAGES) {
    await page.goto(fileUrl(rel));
    const info = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '',
      links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
      ids: [...document.querySelectorAll('[id]')].map((e) => e.id),
      libs: document.querySelectorAll('script[type="application/octet-stream"]').length,
    }));
    check(info.lang === expect[rel].lang && expect[rel].title.test(info.title), `${rel}: lang=${info.lang}, title "${info.title}"`);
    check(/connect-src (?:'none'|blob: data:);/.test(info.csp) && /default-src 'none'/.test(info.csp), `${rel}: restrictive CSP`);
    check(rel.startsWith('app/') ? info.libs === 3 : info.libs === 0, `${rel}: embeds ${info.libs} libraries`);
    const bad = [];
    for (const href of info.links) {
      if (/^[a-z]+:/i.test(href)) { bad.push(`${href} (absolute)`); continue; }
      const [path, frag] = href.split('#');
      if (!path) { if (frag && !info.ids.includes(frag)) bad.push(href); continue; }
      const target = join(dirname(join(root, rel)), path);
      if (!existsSync(target)) bad.push(href);
    }
    check(info.links.length > 0 && bad.length === 0, `${rel}: ${info.links.length} links resolve${bad.length ? ` — broken: ${bad.join(', ')}` : ''}`);
    await page.screenshot({ path: join(SHOTS, `page-${rel.replace(/\//g, '_')}.png`), fullPage: rel === 'index.html' });
  }
  // landing points to the four pages; docs cross-link
  await page.goto(fileUrl('index.html'));
  const landingLinks = await page.$$eval('#choices a', (as) => as.map((a) => a.getAttribute('href')));
  check(JSON.stringify(landingLinks.sort()) === JSON.stringify(['app/websign_en.html', 'app/websign_fr.html', 'doc/doc_en.html', 'doc/doc_fr.html']), 'landing links to the 4 pages');
  await page.click('#go-fr-doc');
  check(page.url().endsWith('/doc/doc_fr.html'), 'landing → French docs');
  await page.click('#doc-other');
  check(page.url().endsWith('/doc/doc_en.html'), 'French docs → English docs');
  await page.click('#doc-open');
  check(page.url().endsWith('/app/websign_en.html') && (await page.isVisible('#open-btn')), 'English docs → English app');
  await page.click('#app-help');
  check(page.url().endsWith('/doc/doc_en.html'), 'app → its documentation');
  await page.click('#doc-home');
  check(page.url().endsWith('/index.html'), 'docs → landing');
  await page.goBack();
  check(page.url().endsWith('/doc/doc_en.html'), 'browser back works');
  // colour-vision drop-down on the landing page and the guides, shared through localStorage
  await page.goto(fileUrl('index.html'));
  check((await page.$eval('#vision-select', (s) => [...s.options].map((o) => o.value).join(','))) === 'normal,protan,deutan,tritan' &&
    (await page.inputValue('#vision-select')) === 'normal', 'landing: colours drop-down at the top, Normal colours by default');
  await page.selectOption('#vision-select', 'deutan');
  check((await page.evaluate(() => document.documentElement.dataset.vision)) === 'deutan', 'landing: choosing a palette recolours the page');
  await page.screenshot({ path: join(SHOTS, 'landing-deutan.png') });
  await page.goto(fileUrl('doc/doc_fr.html'));
  check((await page.inputValue('#vision-select')) === 'deutan' && (await page.evaluate(() => document.documentElement.dataset.vision)) === 'deutan',
    'docs: the choice made on the landing page is applied before display');
  const docPickFirst = await page.evaluate(() => {
    const main = document.querySelector('main.doc');
    return main.firstElementChild.classList.contains('doc-vision');
  });
  check(docPickFirst, 'docs: colours drop-down at the start of the page');
  await page.selectOption('#vision-select', 'tritan');
  await page.screenshot({ path: join(SHOTS, 'doc-tritan.png') });
  await page.goto(fileUrl('app/websign_fr.html'));
  check((await page.evaluate(() => document.documentElement.dataset.vision)) === 'tritan', 'app page applies the stored palette');
  await page.goto(fileUrl('doc/doc_en.html'));
  await page.selectOption('#vision-select', 'normal');
  check(!(await page.evaluate(() => document.documentElement.hasAttribute('data-vision'))), 'docs: Normal colours restores the classic palette');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'fr-FR' });
  const mp = await mctx.newPage();
  watch(mp, 'static-mobile');
  await mp.goto(fileUrl('index.html'));
  const firstChoice = await mp.$eval('#choices .choice', (e) => e.id);
  check(firstChoice === 'choice-fr', 'French browser: French choice listed first');
  await mp.screenshot({ path: join(SHOTS, 'mobile-landing.png'), fullPage: true });
  await mp.goto(fileUrl('doc/doc_fr.html'));
  await mp.screenshot({ path: join(SHOTS, 'mobile-doc_fr.png') });
  await mctx.close();
  await ctx.close();
}

async function appSuite(lang) {
  // =========================================================================
  section(`[${lang}] desktop: open PDF, box, strokes, undo/redo, exports (no File System Access API)`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
  await ctx.addInitScript(NO_FS_API);
  const page = await ctx.newPage();
  watch(page, 'desktop');
  await page.goto(URL_);
  check(await page.isVisible('#start'), 'start screen visible');
  check((await page.getAttribute('html', 'lang')) === lang && (await page.title()) === I18N[lang]['page.title'], `<html lang="${lang}"> and title`);
  const i18nDom = await page.evaluate(() => ({
    emptyText: [...document.querySelectorAll('[data-i18n]')].filter((e) => !e.textContent.trim()).map((e) => e.dataset.i18n),
    noAria: [...document.querySelectorAll('[data-i18n-aria]')].filter((e) => !(e.getAttribute('aria-label') || '').trim()).map((e) => e.dataset.i18nAria),
    noTip: [...document.querySelectorAll('[data-i18n-tip]')].filter((e) => !(e.dataset.tip || '').trim()).map((e) => e.dataset.i18nTip),
  }));
  check(!i18nDom.emptyText.length && !i18nDom.noAria.length && !i18nDom.noTip.length, `all static strings filled in (${JSON.stringify(i18nDom)})`);
  check((await page.textContent('#start h1')) === I18N[lang]['start.title'], 'start screen shown in the page language');
  check(await page.evaluate(() => document.getElementById('lib-pdfjs').textContent.length > 100000 && document.getElementById('lib-pdflib').textContent.length > 100000),
    'embedded libraries not decoded at page load (lazy)');
  check(await page.isHidden('#toolbar'), 'toolbar hidden before a document is open');
  await page.screenshot({ path: join(SHOTS, `${lang}-desktop-start.png`) });

  const tbButtons = await page.$$eval('#toolbar button', (bs) => bs.map((b) => b.id));
  check(JSON.stringify(tbButtons) === JSON.stringify(['tb-box', 'tb-pen', 'tb-undo', 'tb-redo', 'tb-sig', 'tb-save', 'tb-vision']),
    `toolbar has exactly box, pen, undo, redo, save signature, save page, colours (${tbButtons.join(',')})`);
  const labels = await page.$$eval('#toolbar button', (bs) => bs.every((b) => (b.getAttribute('aria-label') || '').length > 2));
  check(labels, 'every toolbar button has an aria-label');

  await openViaInput(page, pdfPath);
  await waitRendered(page, 0);
  check((await page.evaluate(() => window.__websign.pageCount)) === 2, 'PDF has 2 pages');
  const p1 = await analyseRendered(page, 0, { x: 0, y: 0, w: 0.01, h: 0.01 });
  check(p1.W > 900, `page 1 rendered (${p1.W}x${p1.H})`);
  const dims = await page.$$eval('.page', (ps) => ps.map((p) => [p.offsetWidth, p.offsetHeight]));
  check(dims[1][1] > dims[1][0], `rotated page 2 is displayed portrait (${dims[1].join('x')}, CropBox 520x340 rotated 90)`);
  check(Math.abs(dims[0][1] / dims[0][0] - 732 / 572) < 0.002, `page 1 aspect follows its CropBox (${dims[0].join('x')})`);
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded();
  await waitRendered(page, 1);
  check(true, 'page 2 rendered lazily after scrolling');
  await page.evaluate(() => window.scrollTo(0, 0));
  check(await page.isDisabled('#tb-sig'), 'save signature disabled without a box');
  check(await page.isDisabled('#tb-undo'), 'undo disabled initially');

  // --- colour vision (eye button) ---
  const bgOf = (pg) => pg.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  await page.click('#tb-vision');
  check(await page.isVisible('#vision-menu'), 'eye button opens the colours menu');
  const vItems = await page.$$eval('#vision-menu [data-vision]', (bs) => bs.map((b) => [b.dataset.vision, b.getAttribute('aria-checked'), b.textContent.trim()]));
  check(JSON.stringify(vItems.map((v) => v[0])) === JSON.stringify(['normal', 'protan', 'deutan', 'tritan']) && vItems[0][1] === 'true' && vItems.every((v) => v[2].length > 3),
    `colours menu: normal (checked by default), protanopia, deuteranopia, tritanopia (${vItems.map((v) => v[2]).join(' | ')})`);
  const bgNormal = await bgOf(page);
  const seen = new Set([bgNormal]);
  for (const v of ['protan', 'deutan', 'tritan']) {
    if (await page.isHidden('#vision-menu')) await page.click('#tb-vision');
    await page.click(`#vision-menu [data-vision=${v}]`);
    const st = await page.evaluate(() => [document.documentElement.dataset.vision, localStorage.getItem('websign.vision')]);
    check(st[0] === v && st[1] === v, `${v}: palette applied and remembered locally`);
    seen.add(await bgOf(page));
  }
  check(seen.size === 4, `each palette changes the page colours (${[...seen].join(', ')})`);
  await page.click('#tb-pen');
  check(await page.isVisible('#pen-pop .sw-name'), 'with a colour-vision palette, ink colours show their names');
  await page.screenshot({ path: join(SHOTS, `${lang}-tritan-pen.png`) });
  await page.click('#tb-pen');
  await page.click('#tb-vision');
  await page.click('#vision-menu [data-vision=normal]');
  check((await bgOf(page)) === bgNormal && !(await page.evaluate(() => document.documentElement.hasAttribute('data-vision'))), 'Normal colours restores the classic palette');
  check(await page.isHidden('#vision-menu'), 'colours menu closes after a choice');

  // --- add, move, resize ---
  await page.click('#tb-box');
  let box = await page.evaluate(() => window.__websign.box);
  check(box && box.page === 0, 'box added on the most visible page (page 1)');
  check(await page.isVisible('#box-menu') === false, 'no menu when adding the first box');
  const box0 = box;
  const g = await rectOf(page, '.sigbox .grip');
  await mouseDrag(page, { x: g.x + g.width / 2, y: g.y + g.height / 2 }, { x: g.x + g.width / 2 + 80, y: g.y + g.height / 2 + 60 });
  box = await page.evaluate(() => window.__websign.box);
  check(box.x > box0.x + 0.05 && box.y > box0.y + 0.03 && Math.abs(box.w - box0.w) < 1e-9, 'grip drag moves the box (size unchanged)');
  const boxMoved = box;
  const fr = await rectOf(page, '.sigbox .edge.b');
  await mouseDrag(page, { x: fr.x + 20, y: fr.y + fr.height / 2 }, { x: fr.x - 20, y: fr.y + fr.height / 2 + 20 });
  box = await page.evaluate(() => window.__websign.box);
  check(box.x < boxMoved.x && box.y > boxMoved.y, 'dragging the border frame moves the box');
  const se = await rectOf(page, '.sigbox .h.se');
  const beforeResize = box;
  await mouseDrag(page, { x: se.x + se.width / 2, y: se.y + se.height / 2 }, { x: se.x + 90, y: se.y + 40 });
  box = await page.evaluate(() => window.__websign.box);
  check(box.w > beforeResize.w + 0.05 && box.h > beforeResize.h + 0.01 && Math.abs(box.x - beforeResize.x) < 1e-9, 'SE anchor resizes the box');
  const nw = await rectOf(page, '.sigbox .h.nw');
  const beforeNw = box;
  await mouseDrag(page, { x: nw.x + nw.width / 2, y: nw.y + nw.height / 2 }, { x: nw.x + 2000, y: nw.y + 2000 });
  box = await page.evaluate(() => window.__websign.box);
  const pageW = dims[0][0];
  check(box.w * pageW >= 35.5 && box.x + box.w <= beforeNw.x + beforeNw.w + 1e-9, `minimum size enforced (${(box.w * pageW).toFixed(1)}px)`);
  await page.click('#tb-undo');
  box = await page.evaluate(() => window.__websign.box);
  check(JSON.stringify(box) === JSON.stringify(beforeNw), 'undo restores geometry after resize');
  await mouseDrag(page, { x: se.x, y: se.y }, { x: se.x + 5000, y: se.y + 5000 });
  box = await page.evaluate(() => window.__websign.box);
  check(box.x + box.w <= 1 + 1e-9 && box.y + box.h <= 1 + 1e-9, 'resize clamped to the page');
  await page.click('#tb-undo');
  box = await page.evaluate(() => window.__websign.box);
  check(JSON.stringify(box) === JSON.stringify(beforeNw), 'undo after clamped resize');

  // --- strokes ---
  await pickColor(page, 'color.red');
  check((await page.evaluate(() => window.__websign.color)) === '#d62828', 'pen colour set to red');
  check((await page.getAttribute('#tb-pen', 'aria-label')) === await tr(page, 'tb.pen', { color: await tr(page, 'color.red') }), 'pen button label reflects the colour');
  await mouseSign(page);
  let strokes = await page.evaluate(() => window.__websign.strokes);
  check(strokes.length === 1 && strokes[0].points.length > 10 && strokes[0].color === '#d62828', `mouse stroke recorded (${strokes[0] && strokes[0].points.length} points)`);
  check(strokes[0].points.every((p) => p.x >= 0 && p.x <= 0.5 && p.y >= 0 && p.y <= 0.5), 'stroke points stored as box fractions');
  const ink = await rectOf(page, '.sigbox .ink');
  await page.mouse.click(ink.x + ink.width * 0.25, ink.y + ink.height * 0.25);
  strokes = await page.evaluate(() => window.__websign.strokes);
  check(strokes.length === 2 && strokes[1].points.length === 1, 'single click makes a dot stroke');
  await page.click('#tb-undo');
  check((await page.evaluate(() => window.__websign.strokes.length)) === 1, 'undo removes the dot');
  await page.click('#tb-redo');
  check((await page.evaluate(() => window.__websign.strokes.length)) === 2, 'redo restores the dot');
  await page.keyboard.press('Control+z');
  check((await page.evaluate(() => window.__websign.strokes.length)) === 1, 'Ctrl+Z undoes');
  await page.keyboard.press('Control+Shift+z');
  check((await page.evaluate(() => window.__websign.strokes.length)) === 2, 'Ctrl+Shift+Z redoes');
  await page.keyboard.press('Control+z');
  check(await page.isEnabled('#tb-redo'), 'redo available after undo');
  await mouseDrag(page, { x: ink.x + ink.width * 0.2, y: ink.y + ink.height * 0.2 }, { x: ink.x + ink.width * 0.3, y: ink.y + ink.height * 0.3 }, 4);
  check(await page.isDisabled('#tb-redo'), 'new action clears redo stack');
  await page.click('#tb-undo');
  check((await page.evaluate(() => window.__websign.strokes.length)) === 1, 'back to one stroke');

  // --- box menu ---
  await page.click('#tb-box');
  check(await page.isVisible('#box-menu'), 'box button opens menu when a box exists');
  await page.screenshot({ path: join(SHOTS, `${lang}-desktop-box-menu.png`) });
  await page.click('#bm-cancel');
  check(await page.isHidden('#box-menu') && (await page.evaluate(() => window.__websign.strokes.length)) === 1, 'Cancel closes menu, nothing changed');
  await page.click('#tb-box');
  await page.click('#bm-erase');
  check((await page.evaluate(() => window.__websign.strokes.length)) === 0 && (await page.evaluate(() => !!window.__websign.box)), 'Erase content clears strokes, keeps box');
  await page.click('#tb-undo');
  check((await page.evaluate(() => window.__websign.strokes.length)) === 1, 'undo restores erased strokes');
  await page.click('#tb-box');
  await page.click('#bm-delete');
  check((await page.evaluate(() => window.__websign.box)) === null && (await page.locator('.sigbox').count()) === 0, 'Delete box removes the box');
  await page.click('#tb-undo');
  box = await page.evaluate(() => window.__websign.box);
  check(JSON.stringify(box) === JSON.stringify(beforeNw) && (await page.evaluate(() => window.__websign.strokes.length)) === 1, 'undo restores box and strokes');
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5);
  await page.screenshot({ path: join(SHOTS, `${lang}-desktop-signed.png`) });

  // --- exports from page 1 ---
  const sig = await downloadFrom(page, () => page.click('#tb-sig'));
  check(sig.name === 'signature.png', `signature download name (${sig.name})`);
  const sigA = await analyseBytes(page, sig.bytes, 'image/png', { x: 0, y: 0, w: 1, h: 1 });
  check(sigA.W >= 1200, `signature PNG at least 1200px wide (${sigA.W}x${sigA.H})`);
  check(sigA.alpha0 > sigA.W * sigA.H * 0.5 && sigA.tl > 100 && sigA.br === 0, 'signature PNG is transparent with ink in the top-left quadrant');

  await page.click('#tb-save');
  check(await page.isVisible('#save-dlg'), 'save dialog opens');
  check(await page.isDisabled('#save-overwrite'), 'Overwrite disabled without File System Access API');
  const reason = await page.textContent('#save-reason');
  check(reason === await tr(page, 'reason.unsupported'), `disabled reason shown ("${reason}")`);
  check(await page.isChecked('#save-dlg input[value=pdf]') && !(await page.isChecked('#save-outline')), 'defaults: PDF, outline unchecked');
  await page.check('#save-dlg input[value=png]');
  check((await page.textContent('#save-note')) === await tr(page, 'save.notePageBox', { n: 1, total: 2 }), 'dialog states which page is exported');
  await page.screenshot({ path: join(SHOTS, `${lang}-desktop-save-dialog.png`) });
  await page.click('#save-cancel');
  check(await page.isHidden('#save-dlg'), 'Cancel closes the dialog');

  const pdfA = await downloadFrom(page, () => saveCopy(page, 'pdf', false));
  check(pdfA.name === 'sample-signed.pdf' && isPdf(pdfA.bytes), `PDF copy downloaded (${pdfA.name}, ${pdfA.bytes.length} bytes)`);
  let info = await pdfInfo(pdfA.bytes);
  check(info.pages === 2 && info.images[0] === 1 && info.images[1] === 0, `pdf-lib re-opens it: ${info.pages} pages, images per page ${info.images}`);
  {
    const d = await PDFLib.PDFDocument.load(pdfA.bytes);
    const fonts = d.getPage(0).node.Resources().lookup(PDFLib.PDFName.of('Font'));
    check(fonts && fonts.keys().length === 1, 'original content kept (page font still there, not rasterised)');
  }
  let an = await analyseExportedPdf(browser, pdfA.bytes, 0, box);
  check(an.tl > 100 && an.tr === 0 && an.bl === 0 && an.br === 0 && an.outside === 0,
    `page 1 (CropBox offset): ink only in the box's top-left quadrant (tl=${an.tl} tr=${an.tr} bl=${an.bl} br=${an.br} out=${an.outside})`);
  check(an.edgeGrey === 0, `no outline by default (edge grey px ${an.edgeGrey})`);

  const pdfB = await downloadFrom(page, () => saveCopy(page, 'pdf', true));
  an = await analyseExportedPdf(browser, pdfB.bytes, 0, box);
  check(an.edgeGrey > 200, `outline present when ticked (edge grey px ${an.edgeGrey})`);

  const pngA = await downloadFrom(page, () => saveCopy(page, 'png', false));
  an = await analyseBytes(page, pngA.bytes, 'image/png', box);
  check(pngA.name === 'sample-signed.png' && an.W === 572 * 3, `PNG page export at scale 3 (${an.W}x${an.H})`);
  check(an.tl > 100 && an.br === 0 && an.outside === 0 && an.edgeGrey === 0, `PNG has ink in box, no outline (tl=${an.tl}, grey=${an.edgeGrey})`);
  const jpgA = await downloadFrom(page, () => saveCopy(page, 'jpg', true));
  check(jpgA.name === 'sample-signed.jpg' && jpgA.bytes[0] === 0xff && jpgA.bytes[1] === 0xd8, 'JPG export is a JPEG');
  an = await analyseBytes(page, jpgA.bytes, 'image/jpeg', box);
  check(an.tl > 100 && an.edgeGrey > 200 && an.alpha0 === 0, `JPG has ink and outline, opaque (tl=${an.tl}, grey=${an.edgeGrey})`);

  // --- rotated page 2: add a box there, move across pages, export ---
  await page.click('#tb-box');
  await page.click('#bm-delete');
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded();
  await page.evaluate(() => { const r = document.querySelectorAll('.page')[1].getBoundingClientRect(); window.scrollBy(0, r.top - 120); });
  await page.click('#tb-box');
  box = await page.evaluate(() => window.__websign.box);
  check(box.page === 1, 'new box lands on page 2 (most visible)');
  // move it to the top of page 2 by its top border, then across into page 1 and back (undo)
  let et = await rectOf(page, '.sigbox .edge.t');
  let p2r = await rectOf(page, '.page >> nth=1');
  await mouseDrag(page, { x: et.x + et.width * 0.25, y: et.y + et.height / 2 }, { x: et.x + et.width * 0.25, y: p2r.y + 3 }, 8);
  box = await page.evaluate(() => window.__websign.box);
  check(box.page === 1 && box.y < 0.02, `box moved to the top of page 2 (y=${box.y.toFixed(3)})`);
  await page.evaluate(() => { const r = document.querySelectorAll('.page')[1].getBoundingClientRect(); window.scrollBy(0, r.top - 450); });
  const p1r = await rectOf(page, '.page >> nth=0');
  et = await rectOf(page, '.sigbox .edge.t');
  await mouseDrag(page, { x: et.x + et.width * 0.25, y: et.y + et.height / 2 }, { x: et.x + et.width * 0.25, y: p1r.y + p1r.height - 150 }, 10);
  box = await page.evaluate(() => window.__websign.box);
  const parentPage = await page.evaluate(() => document.querySelector('.sigbox').parentElement.dataset.page);
  check(box.page === 0 && parentPage === '0', 'box dragged across into page 1 (re-parented on release)');
  await page.click('#tb-undo');
  box = await page.evaluate(() => window.__websign.box);
  check(box.page === 1 && (await page.evaluate(() => document.querySelector('.sigbox').parentElement.dataset.page)) === '1', 'undo moves it back to page 2');
  // centre it vertically on page 2 for the export
  await page.evaluate(() => { const r = document.querySelectorAll('.page')[1].getBoundingClientRect(); window.scrollBy(0, r.top - 100); });
  const gr = await rectOf(page, '.sigbox .grip');
  await mouseDrag(page, { x: gr.x + gr.width / 2, y: gr.y + gr.height / 2 }, { x: gr.x + gr.width / 2 - 30, y: gr.y + gr.height / 2 + 200 }, 6);
  box = await page.evaluate(() => window.__websign.box);
  await pickColor(page, 'color.red');
  await mouseSign(page);
  check((await page.evaluate(() => window.__websign.strokes.length)) === 1, 'signed on rotated page');
  const pdfR = await downloadFrom(page, () => saveCopy(page, 'pdf', false));
  info = await pdfInfo(pdfR.bytes);
  check(info.pages === 2 && info.images[1] === 1 && info.rotations[1] === 90, `rotated page keeps /Rotate 90 and gets the image (${info.images})`);
  an = await analyseExportedPdf(browser, pdfR.bytes, 1, box);
  check(an.tl > 100 && an.tr === 0 && an.bl === 0 && an.br === 0 && an.outside === 0,
    `rotated page: ink only in top-left quadrant, i.e. upright (tl=${an.tl} tr=${an.tr} bl=${an.bl} br=${an.br} out=${an.outside})`);
  const pdfR2 = await downloadFrom(page, () => saveCopy(page, 'pdf', true));
  an = await analyseExportedPdf(browser, pdfR2.bytes, 1, box);
  check(an.edgeGrey > 150, `rotated page outline when ticked (grey px ${an.edgeGrey})`);
  await page.click('#tb-save');
  await page.check('#save-dlg input[value=png]');
  check((await page.textContent('#save-note')) === await tr(page, 'save.notePageBox', { n: 2, total: 2 }), 'PNG of page with the box = page 2');
  await page.click('#save-cancel');
  const pngR = await downloadFrom(page, () => saveCopy(page, 'png', false));
  an = await analyseBytes(page, pngR.bytes, 'image/png', box);
  check(an.tl > 100 && an.br === 0 && an.H > an.W, `PNG of rotated page (${an.W}x${an.H}) has ink in place`);

  // --- replacing the document by dropping a file ---
  await mouseSign(page); // unsaved work
  await dropFile(page, 'photo.png', pngBytes, 'image/png');
  await page.waitForSelector('#confirm-dlg[open]');
  check(true, 'dropping a file with unsaved work asks for confirmation');
  await page.click('#confirm-dlg button[value=cancel]');
  check((await page.evaluate(() => window.__websign.pageCount)) === 2, 'cancel keeps the current document');
  await dropFile(page, 'photo.png', pngBytes, 'image/png');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => window.__websign.kind === 'image');
  check((await page.evaluate(() => window.__websign.box)) === null, 'dropped image replaces the document, box reset');
  await dropFile(page, 'notes.txt', Buffer.from('hello'), 'text/plain');
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'));
  check((await page.textContent('#toast')) === await tr(page, 'err.unsupported'), 'unsupported file shows an error message');
  // leaving the page with unsaved signing work triggers the beforeunload warning
  await page.click('#tb-box');
  await mouseSign(page);
  let unloadDialog = null;
  page.once('dialog', async (d) => { unloadDialog = d.type(); await d.dismiss(); });
  await page.click('#app-home');
  await sleep(500);
  check(unloadDialog === 'beforeunload' && page.url() === URL_, `leaving with unsaved work asks first (${unloadDialog})`);
  // --- password-protected PDF (needs qpdf to create the fixture) ---
  if (encPath) {
    const ep = await ctx.newPage();
    watch(ep, 'encrypted');
    await ep.goto(URL_);
    const [ch] = await Promise.all([ep.waitForEvent('filechooser'), ep.click('#open-btn')]);
    await ch.setFiles(encPath);
    await ep.waitForSelector('#pwd-dlg[open]');
    check((await ep.textContent('#pwd-note')) === await tr(ep, 'pwd.prompt'), 'password prompt shown for an encrypted PDF');
    await ep.fill('#pwd-input', 'wrong');
    await ep.keyboard.press('Enter');
    await ep.waitForFunction((msg) => document.getElementById('pwd-dlg').open && document.getElementById('pwd-note').textContent === msg, await tr(ep, 'pwd.incorrect'));
    check(true, 'wrong password: asked again');
    await ep.fill('#pwd-input', 'secret');
    await ep.click('#pwd-dlg button[value=ok]');
    await waitRendered(ep, 0);
    check((await ep.evaluate(() => window.__websign.pageCount)) === 2, 'encrypted PDF opened with the password');
    await ep.click('#tb-box');
    await pickColor(ep, 'color.red');
    await mouseSign(ep);
    const ebox = await ep.evaluate(() => window.__websign.box);
    const encOut = await downloadFrom(ep, () => saveCopy(ep, 'pdf', false));
    await ep.waitForFunction((msg) => document.getElementById('toast').textContent.includes(msg), await tr(ep, 'toast.rasterised'));
    const ei = await pdfInfo(encOut.bytes);
    check(ei.pages === 2 && ei.images[0] === 2 && ei.images[1] === 1, `encrypted PDF exported as page images + signature, user told (${ei.images})`);
    an = await analyseExportedPdf(browser, encOut.bytes, 0, ebox);
    check(an.tl > 100 && an.br === 0 && an.outside === 0, `rasterised export: ink in place (tl=${an.tl})`);
    // cancelling the password prompt abandons the opening quietly
    const cp = await ctx.newPage();
    watch(cp, 'encrypted-cancel');
    await cp.goto(URL_);
    const [ch2] = await Promise.all([cp.waitForEvent('filechooser'), cp.click('#open-btn')]);
    await ch2.setFiles(encPath);
    await cp.waitForSelector('#pwd-dlg[open]');
    await cp.click('#pwd-cancel');
    await sleep(500);
    check((await cp.evaluate(() => window.__websign.pageCount)) === 0 && (await cp.isVisible('#start')) && !(await cp.evaluate(() => document.getElementById('toast').classList.contains('show'))),
      'cancelling the password prompt returns to the start screen without error');
  } else {
    check(true, 'SKIPPED encrypted-PDF test (qpdf not found)');
  }
  await ctx.close();

  // =========================================================================
  section(`[${lang}] phone viewport with touch: image, box gestures and signing by finger`);
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  });
  await mctx.addInitScript(NO_FS_API);
  const m = await mctx.newPage();
  watch(m, 'mobile');
  const cdp = await mctx.newCDPSession(m);
  const touch = async (pts, holdMs = 0) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0].x, y: pts[0].y }] });
    if (holdMs) await sleep(holdMs);
    for (const p of pts.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // Chrome swallows the click of a synthetic tap that follows a synthetic drag too closely.
    await sleep(450);
  };
  const line = (a, b, n = 10) => Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
  await m.goto(URL_);
  await m.screenshot({ path: join(SHOTS, `${lang}-mobile-start.png`) });
  await openViaInput(m, pngPath);
  await waitRendered(m, 0);
  check(await m.evaluate(() => document.getElementById('lib-pdfjs').textContent.length > 100000), 'opening an image does not decode pdf.js');
  const pr = await rectOf(m, '.page');
  check(pr.width <= 390 && pr.width > 300, `image fits phone width (${pr.width}px)`);
  const tbr = await rectOf(m, '#toolbar');
  check(tbr.x >= 0 && tbr.x + tbr.width <= 390, `toolbar fits the phone width (${tbr.width.toFixed(0)}px)`);
  const btnSizes = await m.$$eval('#toolbar button', (bs) => bs.map((b) => b.getBoundingClientRect().width));
  check(btnSizes.every((w) => w >= 40), `toolbar touch targets >= 40px (${btnSizes.map((w) => w.toFixed(0))})`);
  await m.tap('#tb-box');
  let mb = await m.evaluate(() => window.__websign.box);
  check(!!mb, 'box added by tap');
  let mg = await rectOf(m, '.sigbox .grip');
  await touch(line({ x: mg.x + mg.width / 2, y: mg.y + mg.height / 2 }, { x: mg.x + mg.width / 2 - 40, y: mg.y + mg.height / 2 + 30 }));
  let mb2 = await m.evaluate(() => window.__websign.box);
  check(mb2.x < mb.x - 0.05 && mb2.y > mb.y, 'finger drag on the grip moves the box');
  const mh = await rectOf(m, '.sigbox .h.e');
  await touch(line({ x: mh.x + mh.width / 2, y: mh.y + mh.height / 2 }, { x: mh.x + 60, y: mh.y + mh.height / 2 }));
  const mb3 = await m.evaluate(() => window.__websign.box);
  check(mb3.w > mb2.w + 0.1 && Math.abs(mb3.h - mb2.h) < 1e-9, 'finger drag on the E anchor widens the box');
  const scroll0 = await m.evaluate(() => window.scrollY);
  const mink = await rectOf(m, '.sigbox .ink');
  await m.tap('#tb-pen');
  await m.screenshot({ path: join(SHOTS, `${lang}-mobile-pen.png`) });
  await m.tap(`#pen-pop [aria-label="${await tr(m, 'color.red')}"]`);
  await touch(signaturePath(mink));
  const ms = await m.evaluate(() => window.__websign.strokes);
  check(ms.length === 1 && ms[0].points.length > 10, `finger stroke recorded (${ms[0] && ms[0].points.length} points)`);
  check((await m.evaluate(() => window.scrollY)) === scroll0, 'drawing inside the box does not scroll the page');
  await m.screenshot({ path: join(SHOTS, `${lang}-mobile-signed.png`) });
  await m.tap('#tb-box');
  await m.screenshot({ path: join(SHOTS, `${lang}-mobile-box-menu.png`) });
  await m.tap('#bm-cancel');
  const mbox = await m.evaluate(() => window.__websign.box);
  const mpng = await downloadFrom(m, async () => {
    await m.tap('#tb-save');
    await m.screenshot({ path: join(SHOTS, `${lang}-mobile-save-dialog.png`) });
    check(await m.isChecked('#save-dlg input[value=png]'), 'PNG source defaults to PNG format');
    await m.tap('#save-copy');
  });
  an = await analyseBytes(m, mpng.bytes, 'image/png', mbox);
  check(mpng.name === 'photo-signed.png' && an.W === 900 && an.H === 560, `image exported at native size (${an.W}x${an.H})`);
  check(an.tl > 100 && an.br === 0 && an.outside === 0, `image export ink in place (tl=${an.tl})`);
  const mpdf = await downloadFrom(m, async () => { await m.tap('#tb-save'); await m.check('#save-dlg input[value=pdf]'); await m.tap('#save-copy'); });
  info = await pdfInfo(mpdf.bytes);
  check(info.pages === 1 && info.images[0] === 2, `image → PDF: 1 page, original image + signature (${info.images})`);
  const pdfDoc = await PDFLib.PDFDocument.load(mpdf.bytes);
  const sz = pdfDoc.getPage(0).getSize();
  check(Math.abs(sz.width - 675) < 0.01 && Math.abs(sz.height - 420) < 0.01, `PDF page sized to the image (${sz.width}x${sz.height} pt)`);
  an = await analyseExportedPdf(browser, mpdf.bytes, 0, mbox);
  check(an.tl > 100 && an.br === 0 && an.outside === 0, `image → PDF ink in place (tl=${an.tl})`);
  // a touch drag on the page outside the box scrolls natively
  await m.evaluate(() => { document.getElementById('pages').style.paddingBottom = '1500px'; });
  await m.evaluate(() => window.scrollTo(0, 0));
  const pr2 = await rectOf(m, '.page');
  const sb = await m.evaluate(() => window.scrollY);
  await touch(line({ x: pr2.x + 20, y: 700 }, { x: pr2.x + 20, y: 300 }, 12));
  await sleep(300);
  check((await m.evaluate(() => window.scrollY)) > sb + 50, 'touch drag outside the box scrolls the page');
  await mctx.close();

  // =========================================================================
  section(`[${lang}] Android WebView browser (DuckDuckGo UA) without "Save as": data: link and share sheet`);
  const wctx = await browser.newContext({
    viewport: { width: 1000, height: 800 }, acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 DuckDuckGo/5',
  });
  await wctx.addInitScript(NO_FS_API);
  await wctx.addInitScript(() => {
    window.__shared = [];
    navigator.canShare = (d) => !!(d && d.files && d.files.length);
    navigator.share = async (d) => { window.__shared.push(...d.files.map((f) => ({ name: f.name, type: f.type, size: f.size }))); };
  });
  const w = await wctx.newPage();
  watch(w, 'webview');
  await w.goto(URL_);
  await openViaInput(w, pngPath);
  await waitRendered(w, 0);
  await w.click('#tb-box');
  const wb = await rectOf(w, '.sigbox');
  await mouseDrag(w, { x: wb.x + wb.width * 0.2, y: wb.y + wb.height * 0.5 }, { x: wb.x + wb.width * 0.7, y: wb.y + wb.height * 0.4 });
  check((await w.evaluate(() => window.__websign.strokes.length)) === 1, 'signed in the WebView context');
  // share sheet
  await saveCopy(w, 'png', false);
  await w.waitForSelector('#ready-dlg[open]');
  const wHref = await w.getAttribute('#ready-link', 'href');
  check(wHref.startsWith('data:image/png;base64,'), 'Android WebView gets a data: link (blob: downloads unsupported there)');
  check(await w.isVisible('#ready-share'), 'share button shown when files can be shared');
  await w.screenshot({ path: join(SHOTS, `${lang}-webview-ready.png`) });
  await w.click('#ready-share');
  await w.waitForSelector('#ready-dlg:not([open])', { state: 'attached', timeout: 5000 });
  const shared = await w.evaluate(() => window.__shared);
  check(shared.length === 1 && shared[0].name === 'photo-signed.png' && shared[0].type === 'image/png' && shared[0].size > 1000,
    `share sheet receives the signed file (${JSON.stringify(shared)})`);
  // download through the data: link
  const wdl = await downloadFrom(w, () => saveCopy(w, 'png', false));
  check(wdl.name === 'photo-signed.png' && wdl.bytes[0] === 0x89 && wdl.bytes[1] === 0x50, `data: link downloads the PNG (${wdl.name}, ${wdl.bytes.length} bytes)`);
  const wsig = await downloadFrom(w, () => w.click('#tb-sig'));
  check(wsig.name === 'signature.png' && wsig.bytes[0] === 0x89, 'signature PNG also downloadable in the WebView');
  await wctx.close();

  // =========================================================================
  section(`[${lang}] File System Access API (stubbed in-memory handles): overwrite original / create a copy`);
  const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await fctx.addInitScript(FAKE_FS);
  let f = await fctx.newPage();
  watch(f, 'fs-stub');
  let downloads = 0;
  f.on('download', () => downloads++);
  await f.goto(URL_);
  await f.evaluate(({ b64 }) => { window.__fakeFs.files['contract.pdf'] = { b64, type: 'application/pdf' }; window.__fakeFs.nextOpen = 'contract.pdf'; },
    { b64: pdfBytes.toString('base64') });
  await f.click('#open-btn');
  await waitRendered(f, 0);
  await f.click('#tb-box');
  await pickColor(f, 'color.red');
  await mouseSign(f);
  const fbox = await f.evaluate(() => window.__websign.box);
  await f.click('#tb-save');
  check(await f.isEnabled('#save-overwrite'), 'Overwrite enabled for PDF opened through a writable handle');
  await f.check('#save-dlg input[value=png]');
  check(await f.isDisabled('#save-overwrite') && (await f.textContent('#save-reason')) === await tr(f, 'reason.format', { format: 'PDF' }), 'Overwrite disabled when the format differs (PNG for a PDF)');
  await f.check('#save-dlg input[value=pdf]');
  await f.evaluate(() => { window.__fakeFs.permission = 'denied'; });
  await f.click('#save-overwrite');
  const permMsg = await tr(f, 'err.permission');
  await f.waitForFunction((msg) => document.getElementById('toast').textContent === msg, permMsg);
  check((await f.evaluate(() => window.__fakeFs.writes.length)) === 0, 'permission denied: nothing written, message shown');
  await f.evaluate(() => { window.__fakeFs.permission = 'granted'; });
  const readFake = (name) => f.evaluate((n) => window.__fakeFs.files[n].b64, name).then((b) => Buffer.from(b, 'base64'));
  for (const round of [1, 2]) {
    await f.click('#tb-save');
    await f.click('#save-overwrite');
    await f.waitForFunction((n) => window.__fakeFs.writes.length === n, round);
    const written = await readFake('contract.pdf');
    const wi = await pdfInfo(written);
    check(isPdf(written) && wi.pages === 2 && wi.images[0] === 1,
      `overwrite #${round}: valid signed PDF written (${written.length} bytes, images ${wi.images}) — signature stamped once`);
  }
  an = await analyseExportedPdf(browser, await readFake('contract.pdf'), 0, fbox);
  check(an.tl > 100 && an.br === 0 && an.outside === 0, `overwritten PDF renders the signature in place (tl=${an.tl})`);
  await f.click('#tb-save');
  await f.click('#save-copy');
  await f.waitForFunction(() => window.__fakeFs.writes.length === 3);
  const copy = await f.evaluate(() => window.__fakeFs.writes[2]);
  check(copy.name === 'contract-signed.pdf' && (await f.evaluate(() => window.__fakeFs.saveCalls)) === 1, `Create a copy uses showSaveFilePicker (${copy.name})`);
  check(downloads === 0, 'no download fallback was used when pickers are available');
  // image opened through a handle: PNG overwrite allowed, JPG not
  // (a fresh page: once a document is open, the start screen's Open button is gone)
  f = await fctx.newPage();
  watch(f, 'fs-stub-image');
  await f.goto(URL_);
  await f.evaluate(({ b64 }) => { window.__fakeFs.files['photo.png'] = { b64, type: 'image/png' }; window.__fakeFs.nextOpen = 'photo.png'; },
    { b64: pngBytes.toString('base64') });
  await f.click('#open-btn');
  await f.waitForFunction(() => window.__websign.kind === 'image');
  await f.click('#tb-box');
  await pickColor(f, 'color.red');
  await mouseSign(f);
  await f.click('#tb-save');
  check(await f.isEnabled('#save-overwrite'), 'PNG opened via handle: Overwrite enabled for PNG');
  await f.check('#save-dlg input[value=jpg]');
  check(await f.isDisabled('#save-overwrite'), 'PNG opened via handle: Overwrite disabled for JPG');
  await f.check('#save-dlg input[value=png]');
  await f.click('#save-overwrite');
  await f.waitForFunction(() => window.__fakeFs.writes.length === 1);
  const wpng = await readFake('photo.png');
  an = await analyseBytes(f, wpng, 'image/png', await f.evaluate(() => window.__websign.box));
  check(wpng[0] === 0x89 && an.W === 900 && an.tl > 100, `PNG overwritten in place with the signed image (${an.W}x${an.H})`);
  await fctx.close();

  // =========================================================================
  section(`[${lang}] File opened without a handle while the API exists (drag & drop fallback)`);
  const dctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await dctx.addInitScript(FAKE_FS);
  const dpage = await dctx.newPage();
  watch(dpage, 'drop');
  await dpage.goto(URL_);
  await dropFile(dpage, 'sample.pdf', pdfBytes, 'application/pdf');
  await waitRendered(dpage, 0);
  await dpage.click('#tb-save');
  check(await dpage.isDisabled('#save-overwrite') && (await dpage.textContent('#save-reason')) === await tr(dpage, 'reason.noHandle'),
    'Overwrite disabled when there is no file handle');
  await dctx.close();
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  await staticSuite();
  for (const lang of ['en', 'fr']) {
    URL_ = fileUrl(`app/websign_${lang}.html`);
    await appSuite(lang);
  }
} catch (e) {
  check(false, `unexpected exception: ${e.stack || e}`);
} finally {
  await browser.close();
}

section('global');
check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `:\n    ${consoleErrors.join('\n    ')}` : ''}`);
check(externalRequests.length === 0, `no network requests${externalRequests.length ? `:\n    ${externalRequests.join('\n    ')}` : ''}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
if (failed.length) {
  console.log('Failures:');
  for (const r of failed) console.log(`  - ${r.msg}`);
  process.exit(1);
}
