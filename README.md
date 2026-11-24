# WebSign

**Live site: <https://botelectro9.github.io/WebSign/>**

[English](#english) · [Français](#français)

## English

WebSign lets you sign a PDF or an image directly in your web browser: open the file,
place a signature box, sign inside it with your mouse or your finger, and save the result.

- Open WebSign in English: <https://botelectro9.github.io/WebSign/app/websign_en.html>
- User guide in English: <https://botelectro9.github.io/WebSign/doc/doc_en.html>
- Also available in French: [app](https://botelectro9.github.io/WebSign/app/websign_fr.html) · [guide](https://botelectro9.github.io/WebSign/doc/doc_fr.html)

### How to use

1. **Open a file** — click *Open PDF or image*, or drop a PDF or an image on the page.
   Password-protected PDFs ask for their password. Dropping another file later replaces
   the document (you are asked first if the signature has not been saved).
2. **Add the box** — tap the *Box* button in the floating toolbar. The box appears on the
   page most visible on screen. Its dashed outline is not saved unless you ask for it.
3. **Move and resize** — drag the *Move* tab above the box or its border to move it (also
   onto another page); drag one of the 8 handles to resize it.
4. **Sign** — draw inside the box with the mouse (computer) or one finger (phone, tablet).
   Outside the box the page scrolls and zooms as usual.
5. **Colours** — the *Pen* button offers black (default), white, grey, dark blue, red,
   green, pink, yellow and orange.
6. **Undo / redo** — toolbar buttons, or `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` (or `Ctrl+Y`).
   Tapping *Box* again when a box exists offers *Erase content*, *Delete box* or *Cancel*.
7. **Save the signature** — saves the content of the box as a transparent PNG.
8. **Save the document** — choose PDF, PNG or JPG, optionally tick *Keep the box outline
   visible*, then:
   - **Save** — saves `<name>-signed.pdf|png|jpg`, never touching the original. Chrome/Edge
     on a computer show their own "Save as" window; other browsers show a small **Save as**
     window asking for the file name (DuckDuckGo for Android then picks its own name);
   - **Share…** (Android, when the browser can share files) — sends the signed file to
     another app (Drive, Files, mail…);
   - **Cancel**.

   PDF keeps all pages of the original (text stays selectable); PNG and JPG contain the
   page that holds the box.
9. **Colour blindness** — the *eye* button in the toolbar (and the *Colours* drop-down at the
   top of the home page and the guides) offers *Normal colours* (default), *Protanopia*,
   *Deuteranopia* and *Tritanopia* palettes. The choice is remembered on your device only.

### Privacy

Everything runs locally, in your browser. Your file is never uploaded. The pages load
nothing from the internet and send nothing to it: no CDN, no web fonts, no analytics, no
tracking, no cookies — the libraries are embedded in the page and a strict
Content-Security-Policy blocks network connections. WebSign also works offline: download
the files and open `index.html` (or an app page) directly from your disk (`file://`).

Note: WebSign adds an image of a handwritten signature; it is not a certified
cryptographic digital signature.

## Français

WebSign permet de signer un PDF ou une image directement dans votre navigateur&nbsp;:
ouvrez le fichier, placez un cadre de signature, signez à l’intérieur à la souris ou au
doigt, puis enregistrez le résultat.

- Ouvrir WebSign en français&nbsp;: <https://botelectro9.github.io/WebSign/app/websign_fr.html>
- Guide d’utilisation en français&nbsp;: <https://botelectro9.github.io/WebSign/doc/doc_fr.html>
- Également disponible en anglais&nbsp;: [application](https://botelectro9.github.io/WebSign/app/websign_en.html) · [guide](https://botelectro9.github.io/WebSign/doc/doc_en.html)

### Mode d’emploi

1. **Ouvrir un fichier** — cliquez sur *Ouvrir un PDF ou une image*, ou déposez un PDF ou
   une image sur la page. Pour un PDF protégé, le mot de passe est demandé. Déposer un autre
   fichier ensuite remplace le document (avec confirmation si la signature n’a pas été enregistrée).
2. **Ajouter le cadre** — touchez le bouton *Cadre* de la barre d’outils flottante. Le cadre
   apparaît sur la page la plus visible. Son contour pointillé n’est pas enregistré, sauf
   si vous le demandez.
3. **Déplacer et redimensionner** — faites glisser l’onglet *Déplacer* au-dessus du cadre,
   ou sa bordure, pour le déplacer (y compris vers une autre page)&nbsp;; faites glisser
   l’une des 8 poignées pour le redimensionner.
4. **Signer** — dessinez dans le cadre à la souris (ordinateur) ou avec un doigt
   (téléphone, tablette). En dehors du cadre, la page défile et se zoome normalement.
5. **Couleurs** — le bouton *Stylo* propose noir (par défaut), blanc, gris, bleu foncé,
   rouge, vert, rose, jaune et orange.
6. **Annuler / rétablir** — boutons de la barre, ou `Ctrl/Cmd+Z` et `Ctrl/Cmd+Maj+Z`
   (ou `Ctrl+Y`). Toucher *Cadre* quand un cadre existe propose *Effacer le contenu*,
   *Supprimer le cadre* ou *Annuler*.
7. **Enregistrer la signature** — enregistre le contenu du cadre en PNG transparent.
8. **Enregistrer le document** — choisissez PDF, PNG ou JPG, cochez si besoin *Garder le
   contour du cadre visible*, puis&nbsp;:
   - **Enregistrer** — enregistre `<nom>-signed.pdf|png|jpg`, sans jamais modifier l’original.
     Chrome/Edge sur ordinateur affichent leur propre fenêtre «&nbsp;Enregistrer sous&nbsp;»&nbsp;;
     les autres navigateurs affichent une petite fenêtre **Enregistrer sous** qui demande le
     nom du fichier (DuckDuckGo pour Android choisit alors son propre nom)&nbsp;;
   - **Partager…** (Android, si le navigateur sait partager des fichiers) — envoie le fichier
     signé vers une autre application (Drive, Fichiers, messagerie…)&nbsp;;
   - **Annuler**.

   Le PDF conserve toutes les pages de l’original (le texte reste sélectionnable)&nbsp;;
   PNG et JPG contiennent la page qui porte le cadre.
9. **Daltonisme** — le bouton *œil* de la barre d’outils (et la liste *Couleurs* en haut de
   la page d’accueil et des guides) propose *Couleurs normales* (par défaut), *Protanopie*,
   *Deutéranopie* et *Tritanopie*. Le choix est mémorisé sur votre appareil uniquement.

### Confidentialité

Tout se passe localement, dans votre navigateur. Votre fichier n’est jamais envoyé. Les
pages ne chargent rien depuis Internet et n’y envoient rien&nbsp;: ni CDN, ni polices web,
ni mesure d’audience, ni pistage, ni cookies — les bibliothèques sont intégrées à la page
et une Content-Security-Policy stricte bloque les connexions réseau. WebSign fonctionne
aussi hors ligne&nbsp;: téléchargez les fichiers et ouvrez `index.html` (ou une page de
l’application) directement depuis votre disque (`file://`).

Remarque&nbsp;: WebSign ajoute une image de signature manuscrite&nbsp;; ce n’est pas une
signature électronique cryptographique certifiée.

---

## Developers

### Structure

The site is five self-contained HTML files (inline CSS, JS and SVG; no shared external
file; relative links only), generated by `build.mjs`:

| File | Content |
|---|---|
| `index.html` | Landing page: language choice → app or documentation |
| `app/websign_en.html`, `app/websign_fr.html` | The app (each embeds pdf.js and pdf-lib, ~3.1 MiB) |
| `doc/doc_en.html`, `doc/doc_fr.html` | User guides |

Sources:

- `src/app.html`, `src/app.css`, `src/app.js` — the app, one source for both languages
- `src/i18n.js` — every app string, `{ en: {...}, fr: {...} }`. Static strings are resolved
  at build time; the page language's dictionary is embedded for dynamic ones. The build
  fails if a key is missing or empty in a language.
- `src/doc.html` + `src/doc_en.html` / `src/doc_fr.html` — docs template and content (the
  table of contents is generated from the `<h2 id>` headings)
- `src/index.html` — landing page; `src/base.css`, `src/site.css`, `src/icons.svg` — shared parts
- `vendor/` — pdf.js 6.2.108 (`pdf.min.mjs`, `pdf.worker.min.mjs`) and pdf-lib 1.17.1
  (`pdf-lib.min.js`) with their licences
- `PLAN.md` — design notes

The libraries are embedded as base64 in non-executed `<script type="application/octet-stream">`
blocks and decoded only when needed (pdf.js when a PDF is opened, pdf-lib on the first PDF
export), so the landing page, the docs and the app's start screen open instantly. pdf.js is
loaded with `import()` from a Blob URL; its worker is converted at build time into a classic
script because Chrome refuses module workers created from `blob:` URLs on `file://` pages.

### Rebuild

Node.js 18 or later, no dependencies:

```sh
node build.mjs
```

### Tests

`test/smoke.mjs` drives the system Chrome with Playwright (Playwright is not a project
dependency; the script looks for it in `NODE_PATH`, `~/.npm-global/lib/node_modules` and
`/opt/npm-tools/node_modules`). Every page is loaded from `file://`.

```sh
node test/smoke.mjs     # CHROME=/path/to/chrome to override; screenshots in $SHOTS (default /tmp/websign-shots)
```

It covers the i18n dictionary (same keys, no empty or untranslated strings), the five pages
(lang, title, CSP, every relative link resolves, navigation), and runs the full app suite on
both app pages: PDF with a rotated page and CropBox offsets, PNG, password-protected PDF
(fixture made with `qpdf` if installed), box gestures with mouse and emulated touch,
undo/redo, every export (the signed PDF is re-rendered to check the ink position and
orientation), saving through a stubbed `showSaveFilePicker` (the native
pickers cannot be automated), `beforeunload`, and zero console errors / network requests.

### GitHub Pages

Put `index.html`, `app/`, `doc/` (and the empty `.nojekyll`) at the root of the repository,
then *Settings → Pages → Deploy from a branch → `main` → `/ (root)`*.

### Licences

WebSign's own code is released into the public domain under the **Unlicense** (see
`LICENSE`). The embedded libraries keep their own licences, included in `vendor/`:

- [pdf.js](https://github.com/mozilla/pdf.js) — Apache License 2.0 (`vendor/pdfjs/LICENSE`)
- [pdf-lib](https://github.com/Hopding/pdf-lib) — MIT (`vendor/pdf-lib/LICENSE.md`)
