#!/usr/bin/env node
// Builds the five self-contained pages of the site from src/ and vendor/:
//
//   index.html            landing page (language choice -> app or documentation)
//   app/websign_en.html   WebSign, English      (embeds pdf.js + pdf-lib)
//   app/websign_fr.html   WebSign, French       (embeds pdf.js + pdf-lib)
//   doc/doc_en.html       user guide, English
//   doc/doc_fr.html       user guide, French
//
// Plain Node (>= 18), no dependencies:  node build.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p));
const text = (p) => read(p).toString('utf8');
const LANGS = ['en', 'fr'];

// ---------------------------------------------------------------------------
// i18n dictionary (src/i18n.js declares `const I18N = {en:{...}, fr:{...}}`)
// ---------------------------------------------------------------------------
const I18N = new Function(`${text('src/i18n.js')}\nreturn I18N;`)();
{
  const all = new Set(LANGS.flatMap((l) => Object.keys(I18N[l])));
  for (const l of LANGS) {
    for (const k of all) {
      if (typeof I18N[l][k] !== 'string' || !I18N[l][k].trim()) throw new Error(`i18n: "${k}" missing or empty in "${l}"`);
    }
  }
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------
// Embedded libraries (app pages only)
// ---------------------------------------------------------------------------
// Libraries are embedded as base64 inside non-executed <script> blocks and turned
// into Blob URLs at runtime, only when needed (pdf.js is ES-module only, so it cannot
// simply be inlined as a classic script).
function stripSourceMap(buf) {
  // Avoid dev tools trying to fetch a .map file that is not shipped.
  return Buffer.from(buf.toString('utf8').replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n'), 'utf8');
}

// Chrome refuses module workers created from blob: URLs when the page is opened from
// file:// (opaque origin), but classic workers work everywhere. The pdf.js worker bundle
// only uses ESM syntax for its final export and for import.meta.url (used by the optional
// wasm decoders to resolve relative URLs), so it converts to a classic script safely.
function classicWorker(buf) {
  let src = buf.toString('utf8');
  const exportStmt = 'export{WorkerMessageHandler};';
  if (src.split(exportStmt).length !== 2) throw new Error('pdf.worker: unexpected export layout');
  src = src.replace(exportStmt, '');
  src = src.split('import.meta.url').join('self.location.href');
  if (/\bexport\s*[{*]|\bimport\.meta\b|^\s*import\s/m.test(src)) throw new Error('pdf.worker: ESM syntax left after conversion');
  return Buffer.from(src, 'utf8');
}

function wrap(b64, width = 120) {
  const out = [];
  for (let i = 0; i < b64.length; i += width) out.push(b64.slice(i, i + width));
  return out.join('\n');
}

const libs = [
  { id: 'lib-pdfjs', file: 'vendor/pdfjs/pdf.min.mjs', note: 'pdf.js 6.2.108, Apache-2.0, https://github.com/mozilla/pdf.js' },
  { id: 'lib-pdfjs-worker', file: 'vendor/pdfjs/pdf.worker.min.mjs', note: 'pdf.js worker 6.2.108, Apache-2.0 (converted to a classic script)', transform: classicWorker },
  { id: 'lib-pdflib', file: 'vendor/pdf-lib/pdf-lib.min.js', note: 'pdf-lib 1.17.1, MIT, https://github.com/Hopding/pdf-lib' },
];
const libBlocks = libs
  .map(({ id, file, note, transform }) => {
    let buf = stripSourceMap(read(file));
    if (transform) buf = transform(buf);
    return `<!-- ${note} -->\n<script type="application/octet-stream" id="${id}">\n${wrap(buf.toString('base64'))}\n</script>`;
  })
  .join('\n');

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
const CSP_APP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; connect-src blob: data:; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const CSP_STATIC = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232f5bea'/%3E%3Cpath d='M7 21c3-1 4-9 6-9s1 8 3 8 2-5 4-5 1 4 3 4 2-2 2-2' fill='none' stroke='white' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
const ICONS = text('src/icons.svg').trim();
const baseCss = text('src/base.css');

function guardInline(name, src) {
  if (/<\/(script|style)/i.test(src)) throw new Error(`${name} must not contain a closing </script> or </style> sequence`);
  return src;
}

function fill(template, vars, label) {
  let html = template;
  for (const [k, v] of Object.entries(vars)) {
    const marker = k.startsWith('/*') || k.startsWith('<!--') ? k : `{{${k}}}`;
    if (!html.includes(marker)) throw new Error(`${label}: marker ${marker} missing`);
    html = html.split(marker).join(v); // split/join: no $-pattern surprises
  }
  const left = html.match(/\{\{[A-Z_]+\}\}|\/\* @[A-Z_]+ \*\/|<!-- @[A-Z_]+ -->/);
  if (left) throw new Error(`${label}: unfilled marker ${left[0]}`);
  return html;
}

const outputs = [];
function emit(rel, html) {
  const out = join(root, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  outputs.push([rel, Buffer.byteLength(html)]);
}

// ---------------------------------------------------------------------------
// App pages: static strings resolved at build time, dictionary embedded for the rest
// ---------------------------------------------------------------------------
function resolveStrings(html, dict, label) {
  const need = (k) => {
    if (typeof dict[k] !== 'string') throw new Error(`${label}: unknown i18n key "${k}"`);
    return escapeHtml(dict[k]);
  };
  // <tag ... data-i18n="key" ...></tag>  ->  text content
  html = html.replace(/(<([a-z0-9]+)\b[^>]*\sdata-i18n="([\w.]+)"[^>]*>)(<\/\2>)/g, (m, open, tag, key, close) => open + need(key) + close);
  html = html.replace(/\sdata-i18n-aria="([\w.]+)"/g, (m, key) => `${m} aria-label="${need(key)}"`);
  html = html.replace(/\sdata-i18n-tip="([\w.]+)"/g, (m, key) => `${m} data-tip="${need(key)}"`);
  return html;
}

const appTemplate = text('src/app.html');
const appCss = guardInline('app.css', baseCss + text('src/app.css'));
const appJs = guardInline('app.js', text('src/app.js'));
for (const lang of LANGS) {
  const dict = I18N[lang];
  const strings = guardInline('i18n', `const WEBSIGN_STRINGS = ${JSON.stringify(dict, null, 1)};`);
  let html = fill(appTemplate, {
    LANG: lang,
    TITLE: escapeHtml(dict['page.title']),
    DESCRIPTION: escapeHtml(dict['page.description']),
    CSP: CSP_APP,
    FAVICON,
    '<!-- @ICONS -->': ICONS,
    '/* @CSS */': appCss.trim(),
    '/* @JS */': `${strings}\n${appJs.trim()}`,
    '<!-- @LIBS -->': libBlocks,
  }, `app/${lang}`);
  html = resolveStrings(html, dict, `app/${lang}`);
  emit(`app/websign_${lang}.html`, html);
}

// ---------------------------------------------------------------------------
// Documentation pages: src/doc_<lang>.html fragments in a shared template;
// the table of contents is generated from the <h2 id> headings.
// ---------------------------------------------------------------------------
const DOC = {
  en: { title: 'WebSign – User guide', toc: 'Contents', open: 'Open WebSign', other: 'Version française', home: 'Back to the WebSign home page', homeText: 'WebSign home page' },
  fr: { title: 'WebSign – Guide d’utilisation', toc: 'Sommaire', open: 'Ouvrir WebSign', other: 'English version', home: 'Retour à l’accueil de WebSign', homeText: 'Accueil de WebSign' },
};
const docTemplate = text('src/doc.html');
const siteCss = guardInline('site.css', baseCss + text('src/site.css'));
for (const lang of LANGS) {
  const d = DOC[lang];
  const other = lang === 'en' ? 'fr' : 'en';
  const content = text(`src/doc_${lang}.html`);
  const toc = [...content.matchAll(/<h2 id="([\w-]+)">([\s\S]*?)<\/h2>/g)]
    .map(([, id, title]) => `      <li><a href="#${id}">${title.replace(/<[^>]+>/g, '').trim()}</a></li>`)
    .join('\n');
  if (!toc) throw new Error(`doc_${lang}: no <h2 id> headings`);
  const html = fill(docTemplate, {
    LANG: lang,
    TITLE: escapeHtml(d.title),
    CSP: CSP_STATIC,
    FAVICON,
    HOME_LABEL: escapeHtml(d.home),
    HOME_TEXT: escapeHtml(d.homeText),
    OTHER_HREF: `doc_${other}.html`,
    OTHER_LANG: other,
    OTHER_LABEL: escapeHtml(d.other),
    OPEN_LABEL: escapeHtml(d.open),
    TOC_LABEL: escapeHtml(d.toc),
    TOC: toc,
    CONTENT: content.trim(),
    '<!-- @ICONS -->': ICONS,
    '/* @CSS */': siteCss.trim(),
  }, `doc/${lang}`);
  emit(`doc/doc_${lang}.html`, html);
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------
emit('index.html', fill(text('src/index.html'), {
  CSP: CSP_STATIC,
  FAVICON,
  '<!-- @ICONS -->': ICONS,
  '/* @CSS */': siteCss.trim(),
}, 'index'));

for (const [rel, size] of outputs) console.log(`${rel.padEnd(22)} ${(size / 1024).toFixed(1).padStart(8)} KiB`);
