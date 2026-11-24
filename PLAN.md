# WebSign — implementation plan

A single `index.html` that opens a PDF or an image, lets the user place a signature
box, sign inside it with mouse or finger, and export the result. No server, no network
requests: everything runs in the browser, works from `file://` and from GitHub Pages.

## 1. Feasibility

| Need | Browser capability |
|---|---|
| Open a local PDF / image | `<input type=file>`, drag & drop, `File.arrayBuffer()` |
| Render PDF pages | pdf.js (pdfjs-dist) on `<canvas>` |
| Render images | `createImageBitmap` / `<img>` on `<canvas>` |
| Box with move / resize anchors | absolutely positioned element + Pointer Events |
| Signing with mouse or finger | Pointer Events (`touch-action: none`, pointer capture) on a canvas |
| Save box as PNG | offscreen canvas → `toBlob('image/png')` (transparent) |
| Save page as PNG / JPG | composite canvas → `toBlob` |
| Save as PDF | pdf-lib: stamp the signature on the *original* PDF (text stays vector/selectable) |
| Download | `<a download>` with a Blob URL |

Conclusion: fully possible in HTML/JS/CSS only.

## 2. Repository layout

```
index.html            generated — landing page (language choice → app or docs)
app/websign_en.html   generated — WebSign, English (embeds the libraries)
app/websign_fr.html   generated — WebSign, French (embeds the libraries)
doc/doc_en.html       generated — user guide, English
doc/doc_fr.html       generated — user guide, French
src/app.html          app page template (static strings as data-i18n keys)
src/app.css, src/app.js
src/i18n.js           all app strings: { en: {...}, fr: {...} }
src/index.html        landing page source
src/doc.html          docs template; src/doc_en.html, src/doc_fr.html = content
src/base.css, src/site.css, src/icons.svg   shared parts
vendor/               pdf.js + pdf-lib dist files and their licences
build.mjs             generates the 5 pages (plain Node, no dependencies)
test/smoke.mjs        Playwright smoke test (system Chrome, file://)
README.md, PLAN.md, .nojekyll
```

Every generated page is fully self-contained (inline CSS/JS/SVG, no shared external
file) and all links are relative, so the site works from the root of GitHub Pages and
from `file://`. Deployment: upload `index.html` plus the `app/` and `doc/` folders.

Libraries (copied from /opt/npm-tools/node_modules into `vendor/`):
- pdfjs-dist 6.2.108 — ES modules only (`legacy/build/pdf.min.mjs`, `pdf.worker.min.mjs`)
- pdf-lib 1.17.1 — UMD (`dist/pdf-lib.min.js`)

Inlining (app pages only): each library is embedded as base64 text in a
`<script type="application/octet-stream" id="lib-…">` block. At runtime:
- pdf.js → `Blob` (text/javascript) → `await import(blobUrl)`
- worker → converted **at build time** to a classic script (its only ESM syntax is the
  final `export{WorkerMessageHandler}` and `import.meta.url`), then `new Worker(blobUrl)`
  → `GlobalWorkerOptions.workerPort`. Reason: Chrome refuses *module* workers created from
  `blob:` URLs on `file://` pages (verified). If workers are unavailable the worker code is
  loaded on the main thread (pdf.js picks up `globalThis.pdfjsWorker`).
- pdf-lib → Blob URL injected as classic `<script>`, loaded lazily on first PDF export.
Libraries are decoded lazily (pdf.js only when a PDF is opened) so images, the landing
page and the docs open instantly.

i18n: one app source; `build.mjs` resolves static strings (`data-i18n`,
`data-i18n-aria`, `data-i18n-tip`) at build time and embeds the page language's
dictionary for dynamic strings (`t(key, params)`). The build fails if a key is missing or
empty in a language. `<html lang>` and `<title>` are set per page.

## 3. UI

- Landing (`index.html`): name, one-line pitch (EN + FR), privacy statement, four entry
  points: Open WebSign (English) / Ouvrir WebSign (Français) / Documentation (English) /
  Documentation (Français). The browser language's choice is listed first.
- App start screen: drop zone + "Open PDF or image" button. Drag & drop on the page at any
  time; dropping a file while a document is open replaces it (confirmation if there is
  unsaved signing work). A slim top bar holds the WebSign logo (link to `../index.html`),
  the file name, and a "Help" link to the docs in the same language.
- Document view: pages stacked vertically, fit to width (max 980 CSS px), rendered at
  devicePixelRatio × visual-viewport zoom; PDF pages rendered lazily (IntersectionObserver),
  far pages released. Native scroll and pinch zoom stay enabled outside the box.
- Floating toolbar (pill, fixed, bottom-centre; inline SVG icons, 44px touch targets,
  tooltips/aria-labels) — exactly these buttons (no Open button, no other option):
  1. **Box** — adds the box centred on the most visible page. If a box already exists,
     opens a small menu: *Erase content* / *Delete box* / *Cancel*.
  2. **Pen** — current colour shown under the icon; popover of 9 swatches:
     black (default) #000000, white #ffffff, grey #808080, dark blue #0b2a6f, red #d62828,
     green #2a9d3a, pink #ff5fa2, yellow #ffd60a, orange #f77f00.
  3. **Undo** / 4. **Redo** (disabled when not available; Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z / Ctrl+Y)
  5. **Save signature** — content of the box as transparent PNG
  6. **Save page** — dialog: format PDF / PNG / JPG, checkbox "Keep the box outline
     visible" (unchecked by default), then three buttons: **Overwrite original** /
     **Create a copy** / **Cancel** (see §7).
  Buttons that need a document, a box or ink are disabled until available.
- Docs: long page with a generated table of contents, links to the app in the same
  language, to the other language's docs and back to the landing page.

## 4. The box

- Exactly one box. State: `{pageIndex, x, y, w, h}` in fractions of the page (0..1), so it
  survives re-layout, zoom and rotation of the phone.
- Dashed outline visible while editing (never part of exports unless requested).
- 8 resize anchors (corners + edges), enlarged hit areas on touch; minimum size; clamped to the page.
- Moving: a grip tab above the box and the border frame itself (dragging *inside* draws).
  Dragging it onto another page moves it there (re-parented on release, so pointer capture is kept).
- All gestures use Pointer Events with pointer capture; `touch-action: none` on the box only.

## 5. Signature strokes

- Stored as vectors: `{color, width, points:[{x,y}]}` with coordinates in fractions of the
  box → resizing the box rescales the signature without blur, exports are re-rendered at
  high resolution.
- Rendering: round caps/joins, quadratic mid-point smoothing; a single tap makes a dot.
  Stroke width relative to box height (constant visual weight), `getCoalescedEvents()` when available.
- Only the primary pointer draws (palm/second finger ignored).

## 6. Undo / redo

Snapshot history of `{box, strokes}` (immutable strokes, cheap). Recorded actions:
add box, delete box, move, resize, stroke, erase content. New action clears redo stack.

## 7. Export

- **Signature PNG**: strokes rendered on a transparent canvas, box size × 3 in document
  units (min 1200px wide).
- **PDF, source is a PDF**: pdf-lib loads the original bytes, embeds the signature PNG on
  the box's page. Box corners mapped with pdf.js `viewport.convertToPdfPoint` so page
  `/Rotate` and CropBox offsets are handled (image drawn with matching rotation).
  Optional outline drawn as a thin rectangle. If pdf-lib cannot load the file
  (e.g. encrypted), fall back to a rasterised PDF (each page as JPEG at 2×) and tell the user.
- **PDF, source is an image**: one page sized to the image at 96 dpi, original image
  embedded (JPEG as is unless it has a non-upright EXIF orientation, PNG as is, anything
  else re-encoded as PNG) + signature.
- **PNG / JPG**: the page that holds the box (or the most visible page if no box),
  rendered at high resolution (image: native size; PDF: scale 3, capped at 16 MP / 8192 px),
  signature composited, JPG on white background at quality 0.92.
  The dialog states which page is exported when the PDF has several pages.
- **Create a copy**: `<original>-signed.pdf|png|jpg` (and `signature.png`). With
  `showSaveFilePicker` (opened first, inside the click's user activation) the user picks
  the location; otherwise `<a download>`.
- **Overwrite original**: only with the File System Access API. Files are opened with
  `showOpenFilePicker()` (start-screen button) or `DataTransferItem.getAsFileSystemHandle()`
  (drop) so the `FileSystemFileHandle` is kept; `<input type=file>` is the fallback.
  Enabled only when a writable handle exists **and** the chosen format equals the
  original's (PDF→PDF, PNG→PNG, JPG→JPG; multi-page PDF → PDF only). Otherwise disabled
  with a one-line reason ("not supported by this browser" / "original file location
  unknown" / "format differs from the original"). On click: `requestPermission({mode:
  'readwrite'})`, then `createWritable()` / `write()` / `close()`; refusal → message, nothing
  written; never silently replaced by a download. The in-memory original bytes stay the
  ORIGINAL unsigned bytes for the session, so saving again stamps the signature once.

## 8. Other

- No network access at all; every page has `<meta http-equiv="Content-Security-Policy">`
  with `default-src 'none'` and `connect-src 'none'` (app pages also allow inline and
  `blob:` scripts/workers; pdf.js runs with `isEvalSupported:false`, `useWasm:false`).
- `beforeunload` warning when leaving an app page with unsaved signing work (pages are
  separate files, no state carry-over).
- Toasts for errors (unsupported file, password-protected PDF → prompt for password via
  pdf.js `onPassword`).
- Responsive, respects `prefers-color-scheme`, safe-area insets on phones.
- Known limits: PDFs relying on non-embedded CJK fonts / JPEG2000 / JBIG2 images may render
  imperfectly because pdf.js cmaps/wasm decoders are not bundled (export of the original
  PDF is unaffected).

## 9. Tests (test/smoke.mjs, Playwright + /usr/bin/google-chrome, pages loaded from file://)

0. i18n: same keys in en/fr, no empty or untranslated strings, every key used in the
   source exists; each of the 5 pages: `lang`, title, CSP, every relative link resolves
   to an existing file / anchor; navigation landing ↔ docs ↔ app.

1. Open a generated PDF (2 pages, one rotated 90°) and a PNG; pages render.
2. Add box, drag to move, drag an anchor to resize, draw strokes (mouse and emulated touch viewport).
3. Undo/redo restore strokes and geometry; box menu erase/delete/cancel.
4. Each export produces a download: signature PNG has alpha; PDF re-opens with pdf-lib,
   same page count, and the rendered signed page has ink inside the box rectangle
   (also on the rotated page); outline absent by default, present when the option is ticked.
5. Overwrite/copy with a stubbed in-memory File System Access API (native pickers cannot
   be driven): disabled states and reasons, permission refused, overwrite twice (signature
   stamped once), copy through `showSaveFilePicker`, PNG overwrite of an image.
6. `beforeunload` when leaving with unsaved work; libraries not decoded at page load.
7. Steps 1–6 run on both app pages (EN and FR).
8. No console errors, no network requests, on every page.
