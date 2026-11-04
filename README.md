# Stipple

Turn photographs into stippled, screened and line-drawn point art, then split it into
films you can burn onto screens.

![Stipple](artifacts/app.png)

I've been using this to have some screen printing fun at home, and it's freely available
to anyone who'd like the same. It isn't a product. It's a tool that has made a lot of
prints I'm happy with, and I hope it does the same for you.

**[Try it in your browser →](https://aallevi.github.io/stipple/)** No install needed.
Everything runs on your machine, and your images never leave it.

- **Layers.** Each layer has its own algorithm, shape, ink, tone mask and blend mode. A
  layer can also read *the render beneath it* instead of the photo.
- **Three distributions.** Stochastic (jittered), weighted Voronoi (on the GPU, up to a
  million dots) and classic halftone screens.
- **Any shape as a dot.** Choose from the built-in shapes or drop in your own SVG or
  transparent PNG. Shapes stay vector all the way out.
- **Made for printing.** Spot-ink separations, CMYK/duotone/tritone plates, and one
  black-on-white film per ink with registration marks.
- **Local.** It runs entirely on your machine. Nothing is uploaded.

---

## Install

To run it locally, or to work on it:

You need [Node.js](https://nodejs.org) 20 or newer and a browser with WebGL2 (any recent
Chrome, Firefox, Safari or Edge).

```bash
git clone https://github.com/aallevi/stipple.git
cd stipple
npm install
npm start
```

`npm start` builds the app and opens it at <http://localhost:4173>. Press `Ctrl-C` in the
terminal to stop it. That's the whole install; you don't need Rust or a desktop shell.

| Command | What it does |
|---|---|
| `npm start` | Build, then serve and open in your browser |
| `npm run dev` | Live-reloading dev server at <http://localhost:1420> |
| `npm run build` | Type-check and write a static site to `dist/` |

`dist/` is plain static files with relative paths, so you can host it anywhere, from a
folder on a web server to GitHub Pages. The live copy above is redeployed from `master`
on every push by `.github/workflows/pages.yml`.

### Optional: the desktop app

A native window (Tauri v2) adds two things: native file dialogs and TIFF import. To build
it you also need a [Rust toolchain](https://rustup.rs).

```bash
npm run app            # run it in dev mode
npm run app:build      # bundle → src-tauri/target/release/bundle/
npm run install-app    # macOS: build and copy into /Applications (add -- --launch to open it)
```

---

## Usage

1. **Open an image.** Drop it on the empty canvas, tap *Open image…*, or press `⌘O` /
   `Ctrl+O`. Drop another later to swap the picture under your drawing.
2. **Pick a preset** to see what's possible: *Classic stipple*, *Voronoi drawing*,
   *Three-angle screens*, *Contour lines* and others.
3. **Set the document** (top of the sidebar) to the size and dpi you'll print at.
   Every length is shown in mm, inches or %, and it's the size you'll get.
4. **Work down the sidebar.** The sections follow the signal: *Source → Image adjust →
   Ink → Tone mask → Distribution → Shape → Size → Rotation → Colour → Transform →
   Blend*. A setting only affects the sections below it.
5. **Compare** with the photo using the panel on the canvas: *Original*, *Split* (drag
   the orange divider) or *Photo under* to see it faintly through the paper. It is only
   a view and never appears in an export.
6. **Export** to PNG, SVG or PDF, or **Plates** for screen printing.

### From photo to screens

Everything about the print lives in **Inks & plates**, at the top of the sidebar. A print
is a group of layers, one per ink.

- **Make one.** *Make from the selected layer…* turns that layer into a group of
  **spot colours** (2–8 inks found in the picture) or **overprinting plates** (CMYK, CMY,
  RGB, risograph, earth, tritone, duotone). *Colour → Spot inks* does the first too. With
  a print already in hand, the same menu adds a second group beside it instead.
- **Spot colours** sit side by side: each ink owns the part of the picture closest to its
  colour, so screens never overprint. **Overprinting plates** print over each other and
  mix, as process printing does. *Inks print* switches a group between the two and keeps
  its inks.
- **Edit the inks.** Each swatch is one ink layer: recolour it, or press its *×* to remove
  that ink. *Sample the colours*, *Posterise the tones*, an ink set, or *Pick a colour
  from the picture* for a small detail the sampling missed — picked inks stay when you
  sample again. Select the group to change every ink at once, or one layer to give that
  ink its own shape, size or pattern.
- **Export plates** writes one SVG film per ink, solid black on white, plus a colour
  proof, with identical registration marks on every film.

### Layers and groups

Groups are folders in the layer list. Select the folder to edit all its layers together
(each keeps its own colour, screen angle and seed); select a layer inside to change only
that one. Fold, hide, drag and duplicate a group as one; drop a layer between two of its
layers to put it in, drag it out to take it out, and *⇱* dissolves the folder.

### Shortcuts

| Key | Action |
|---|---|
| `⌘O` | Open image |
| `⌘Z` / `⇧⌘Z` | Undo / redo |
| `⌘]` / `⌘[` | Raise / lower the selected layer |
| `0` | Fit to window |

Use `Ctrl` instead of `⌘` on Windows and Linux. On the canvas, drag to pan, scroll or
pinch to zoom, and double-click or double-tap to fit. It works on a phone too: swipe
up and down to scroll the controls, and drag sideways to move a slider. You can also reorder layers by dragging
the grip, and add a shape by dropping an SVG or PNG on the shape panel.

### Files

| | Formats |
|---|---|
| Images in | PNG, JPEG, WebP, GIF, BMP, plus TIFF in the desktop app |
| Shapes in | SVG, or PNG/WebP/GIF with transparency |
| Out | PNG at the document resolution, SVG, PDF, SVG plates |
| Projects | `.stipple` files from *Save* and *Load* |

---

## Learn more

- **[The guide](docs/GUIDE.md)** explains every control, how they relate, and the full
  screen-printing workflow.
- **[Architecture](docs/ARCHITECTURE.md)** covers the dirty-graph engine, GPU Voronoi,
  signed-distance shapes, tiled export and the test suites.

```bash
npm test               # unit tests
npm run verify         # end-to-end browser checks (with `npm run dev` running)
```

Issues and pull requests are welcome. Prints made with it are even more welcome.

## License

[MIT](LICENSE). Use it, change it, print with it.
