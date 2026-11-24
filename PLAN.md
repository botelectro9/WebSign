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
index.html        generated, self-contained (the only file needed at runtime) — committed, served by GitHub Pages
src/app.html      page skeleton with placeholders
src/app.css
src/app.js
build.mjs         inlines css, js and the three libraries into index.html
test/smoke.mjs    Playwright smoke test (system Chrome)
README.md
PLAN.md
.nojekyll
```

Libraries (already installed in /opt/npm-tools/node_modules, no network needed; copy the
needed dist files into `vendor/` so the repo builds on its own):
- pdfjs-dist 6.2.108 — ES modules only (`legacy/build/pdf.min.mjs`, `pdf.worker.min.mjs`)
- pdf-lib 1.17.1 — UMD (`dist/pdf-lib.min.js`)

Inlining: each library is embedded as base64 text in a
`<script type="application/octet-stream" id="lib-…">` block. At runtime:
- pdf.js → `Blob` (text/javascript) → `await import(blobUrl)`
- worker → `Blob` → `new Worker(blobUrl, {type:'module'})` → `GlobalWorkerOptions.workerPort`
- pdf-lib → Blob URL injected as classic `<script>` (or inline directly), loaded lazily on first PDF export
Libraries are decoded lazily (pdf.js only when a PDF is opened) so images open instantly.

## 3. UI

- Empty state: drop zone + "Open PDF or image" button. Also drag & drop on the page at any time.
- Document view: pages stacked vertically, fit to width, rendered at devicePixelRatio;
  PDF pages rendered lazily (IntersectionObserver). Native scroll and pinch zoom stay
  enabled outside the box.
- Floating toolbar (pill, fixed, bottom-centre; inline SVG icons, 44px touch targets, tooltips/aria-labels):
  1. Open file
  2. **Box** — adds the box centred on the most visible page. If a box already exists,
     opens a small menu: *Erase content* / *Delete box* / *Cancel*.
  3. **Pen** — icon tinted with the current colour; popover of 9 swatches:
     black (default) #000000, white #ffffff, grey #808080, dark blue #0b2a6f, red #d62828,
     green #2a9d3a, pink #ff5fa2, yellow #ffd60a, orange #f77f00.
  4. **Undo** / 5. **Redo** (disabled when not available; Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z / Ctrl+Y)
  6. **Save signature** — content of the box as transparent PNG
  7. **Save document** — dialog: format PDF / PNG / JPG, checkbox "Keep the box outline
     visible" (unchecked by default), Save / Cancel.
  Buttons that need a document or a box are disabled until available.

## 4. The box

- Exactly one box. State: `{pageIndex, x, y, w, h}` in fractions of the page (0..1), so it
  survives re-layout, zoom and rotation of the phone.
- Dashed outline visible while editing (never part of exports unless requested).
- 8 resize anchors (corners + edges), enlarged hit areas on touch; minimum size; clamped to the page.
- Moving: a grip tab above the box and the border frame itself (dragging *inside* draws).
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

- **Signature PNG**: strokes rendered on a transparent canvas, box size × 3 (min 1200px wide).
- **PDF, source is a PDF**: pdf-lib loads the original bytes, embeds the signature PNG on
  the box's page. Box corners mapped with pdf.js `viewport.convertToPdfPoint` so page
  `/Rotate` and CropBox offsets are handled (image drawn with matching rotation).
  Optional outline drawn as a thin rectangle. If pdf-lib cannot load the file
  (e.g. encrypted), fall back to a rasterised PDF (each page as JPEG at ~2×) and tell the user.
- **PDF, source is an image**: one page sized to the image, original image embedded
  (JPEG as is, anything else as PNG) + signature.
- **PNG / JPG**: the page that holds the box (or the most visible page if no box),
  rendered at high resolution (image: native size; PDF: scale ≈ 3, capped by canvas limits),
  signature composited, JPG on white background at quality 0.92.
  The dialog states which page is exported when the PDF has several pages.
- File names: `<original>-signed.pdf|png|jpg`, `signature.png`.

## 8. Other

- No network access at all; `<meta http-equiv="Content-Security-Policy">` restricting to
  inline/blob/data if it does not break pdf.js (verify in tests, otherwise drop it).
- `beforeunload` warning when there is unsaved signing work.
- Toasts for errors (unsupported file, password-protected PDF → prompt for password via pdf.js `onPassword`).
- Responsive, respects `prefers-color-scheme`, safe-area insets on phones.
- Known limits: PDFs relying on non-embedded CJK fonts / JPEG2000 images may render
  imperfectly because pdf.js cmaps/wasm decoders are not bundled (export of the original PDF is unaffected).

## 9. Tests (test/smoke.mjs, Playwright + /usr/bin/google-chrome, page loaded from file://)

1. Open a generated PDF (2 pages, one rotated 90°) and a PNG; pages render.
2. Add box, drag to move, drag an anchor to resize, draw strokes (mouse and emulated touch viewport).
3. Undo/redo restore strokes and geometry; box menu erase/delete/cancel.
4. Each export produces a download: signature PNG has alpha; PDF re-opens with pdf-lib,
   same page count, and the rendered signed page has ink inside the box rectangle
   (also on the rotated page); outline absent by default, present when the option is ticked.
5. No console errors, no network requests.
