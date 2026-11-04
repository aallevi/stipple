# Stipple — the guide

Everything the sidebar does. The panel itself runs in signal-flow order, from Document
and the layer stack down to Blend. For install and a quick start,
see the [README](../README.md); for how the engine works, see [ARCHITECTURE](ARCHITECTURE.md).

## The layer stack

The panel lists the stack the way every compositing tool does — topmost layer at the
top — while the project stores it bottom-first, which is the order it renders in.

Reorder it by dragging a row by its grip; a line shows where the layer will land, and
it lands there in both directions. `⌘]` and `⌘[` (`Ctrl` on Windows) raise and lower
the selected layer, and the `↑` `↓` buttons in the panel header do the same thing with
the mouse. Order is not cosmetic here: a layer set to `Reads from → Layers below`
samples the composite beneath it, so moving one changes what it draws, not just what
covers what.

## How the controls relate

Everything on the right-hand side is one chain. Knowing where a control sits in it
is usually enough to predict what it will do.

```
 SOURCE ──► Image adjust ──► Ink ──────► tone 0..1 ──┬──► Tone mask ──► keep / drop
            gamma, blur,     luma, or                │
            brightness,      coverage of             └──► Distribution ──► where the
            contrast,        one ink                      density / lineature / count
            sharpen, invert                                        │
                                                                   ▼
                                            POINT (x, y, tone, gradient, random)
                                                                   │
   ink = tone, flipped by "Swap light / dark"                      │
        │                                                          ▼
        ├─► Size      = Size × lerp(1 − Tone spread, 1, ink ^ Tone response)
        │                     × (1 ± Size jitter)          ── a fraction of the picture
        ├─► Rotation  = Angle + random·Randomness + contour·Follow contours
        └─► Colour    = mode(tone, random) × (1 ± Colour jitter)
                        or, in Spot inks: nearest ink to the pixel,
                        dithered towards a second one by Mixing
                                                                   │
                                                                   ▼
                                                    ┌──── the stamp ────┐
   circle / polygon     across = Size × 0.84                   ← 0.84 leaves the
   line family          across = Size × 0.84 × Length            distance field
                        stroke = across × Thickness              room to fall off
                                                                   │
                                            Transform (scale, rotate, offset, flip)
                                                                   ▼
                                            Blend mode + Layer opacity ──► the layer below
```

Three rules fall out of that, and they are the ones worth remembering:

**Nothing is measured in pixels.** Every length a layer carries — `Size`, `Blur`,
`Offset` — is stored as a fraction of the picture's short edge, and `Density` is a
count of dots across it. So a document twice as wide is the same drawing at twice the
size, a preset lands the same way on a snapshot and on a scan, and the sliders offer
the same range of coarse-to-fine whatever resolution you opened. The panel writes all
of it in millimetres, inches or per cent — pick which in Document — so you never have
to think in fractions either.

The one deliberate exception is the halftone `Lineature`, which is lines per inch of
*paper*. A halftone screen is a physical object, so enlarging the document puts more
cells across the image, exactly as enlarging the print would.

**Shape parameters are fractions too.** `Length` is a fraction of the mark's cell and
`Thickness` is a fraction of the mark's own length, so a line keeps its proportions
when you resize the layer, and thickening one grows it inward instead of pushing it
out of its cell. The panel shows the length each fraction resolves to, so you never
have to do that arithmetic.

**Size is a ramp, not a number.** `Size` sets the dark end; `Tone spread` says how
much smaller the light end gets; `Tone response` is the curve between them. Leave the
response at 1 for drawing — mark width tracks tone. Set it to 0.5 for anything meant
to print: ink coverage goes as the square of the dot, so a linear ramp lays a 50%
grey down at about 68%.

**Distribution** — how points are placed.

| Algorithm | Character | Good for |
|---|---|---|
| Stochastic (jittered grid) | Blue-noise-ish, density from tone | The workhorse; instant at any density |
| Weighted Voronoi | Evenly spaced, hand-stippled feel | Fine-art stipple, plotter output |
| Halftone screen | Regular lattice, tone carried by dot size | Print separations, rosettes, line screens |

`Density` is how many dots fit across the short edge of the picture, from eight to two
thousand, on a slider spaced by ratio rather than by difference — so the fine end is
as adjustable as the coarse one instead of being crushed into the last few pixels of
the track. The Voronoi `Dot count` works the same way and runs to a million. Neither
is bounded by the document's resolution: the output is vector, so there is no pixel
grid for a screen to be too fine for, and the only ceiling is the four-million-point
budget each layer gets. The readout under the slider says what you are actually
getting — the spacing in millimetres, and the grid it comes to.

**Shape** — the library sits at the top of the section, so picking a stamp and tuning it
is one movement. Whichever shape is selected exposes its own geometry below the grid: a
line shape gives you `Arms`/`Segments`, `Length`, `Thickness` and `Waviness`, a polygon
gives you `Sides`, `Inner radius` and `Irregularity`. Those edits belong to the document,
and they are shared by every layer pointing at that shape — `Duplicate` forks it first if
you want a six-armed burst and a sixteen-armed one in the same stack.

**Size** — `Size` is the overall scale, `Tone spread` how much smaller the quiet end
of the range gets, `Tone response` the curve between them (0.5 for print, 1 for
drawing). The readout resolves the pair into pixels.

**Rotation** — a fixed `Angle`, per-mark `Randomness`, and `Follow contours`, which
aligns each mark to the image's contours and is what makes line shapes flow around forms.

**Measure** — what the layer responds to in what it reads, which decides *where* its
dots go. `Overall tone` is the default: dots where it is dark. `One ink` measures how much
of a single ink the image asks for at each pixel, which is what makes a layer one plate of
a separation; `Undercolour` decides how much of the neutral component it leaves to a black
plate. `Nothing` spreads dots evenly, for a spot-ink layer that carries lightness in which
ink each dot takes.

**Colour** — solid, adaptive (hue ramps with tone), sampled from the image, a random
palette pick per point, or **spot inks**. This is the ink the layer *prints with*, which
is separate from the ink it *measures* — the Measure section has a button to match one to
the other.

**How Measure, Colour and the layer stack fit together.** Measure decides where a layer's
dots go; Colour decides what they print with; the stack decides how many such layers
there are and how they land on each other (Blend). So there are two ways to a set of
screens. *One layer, Colour → Spot inks*: dots go where it is dark, and each picks one of
your inks. *Several layers, each Measure → One ink and Colour → that same ink*: every
layer is one plate. `Split into ink plates…` builds the second for you. Mixing them —
a spot-ink layer that also measures one ink — is allowed, and draws only where that ink
is needed but in several inks; it is rarely what a print wants.

## Printing it by hand

There are two ways to get from a photograph to a set of screens, and they make
different-looking prints. The tool supports both, and the difference is worth
understanding before you pick one.

**Spot inks — one layer, one dot, one ink.** Set `Colour mode → Spot inks`, choose two
to eight inks, and every dot is printed with exactly one of them. That is the whole
point: a dot is a hole in a screen, and a screen holds one colour, so a drawing where
each mark commits to an ink is a drawing you can actually pull. `Mixing` decides how
strictly each dot is held to its nearest ink:

| `Mixing` | What you get |
|---|---|
| 0 | **Posterised.** Every dot takes the nearest ink; areas come out flat and unmixed — brown, light brown, ochre, with visible boundaries between them. |
| ~0.5 | **Partly mixed.** Dots stray towards a second ink near the boundaries, softening them, while the bands stay readable. |
| 1 | **Scattered.** Dots dither between the two inks that best rebuild the colour and the eye does the mixing. With cyan, magenta and yellow this is a process print. |

`Match on` decides what "nearest" means. **Colour** compares the whole colour, which is
what a scatter separation wants. **Lightness only** ignores hue, so a palette ordered dark
to light reads the photograph as tonal bands — which is why a portrait printed in three
earth inks stays a portrait instead of breaking into unrelated hues.

Two buttons build a palette from the picture. **Sample the colours** clusters it in full
colour, for a scatter print. **Posterise the tones** builds a dark-to-light ramp keeping
each band's own colour, then sets `Match on` to lightness and `Mixing` to 0 — the whole
posterise in one press. The readout underneath the swatches says what share of the paper
each screen would actually cover, which is the number that decides whether an ink is worth
the pull.

`Leave paper` adds the stock as a candidate that is matched against but never printed,
so highlights come out as bare paper instead of spending a whole screen on the palest
ink. `Propose inks from the image` clusters the photograph and fills the palette with
the colours it is actually made of, skipping anything close to the paper.

One thing to know: by default a layer already gets fewer dots *and* smaller dots in the
lights, and in spot mode the ink choice lightens them a third time — so the print comes
out much paler than the photograph. The panel notices and offers **Set up for even
coverage**, which lays dots down evenly at one size and leaves lightness entirely to
which ink each dot takes. That is what a real scatter separation does.

**Ink plates — one layer per ink.** `Split into ink plates…` at the top of the layer
stack replaces the stack with one halftone plate per ink: CMYK, CMY, RGB, risograph,
earth, tritone or duotone. Here each layer *measures* the coverage of its own ink and
prints solid in it; the plates multiply, carry the classic 30°-apart screen angles, and only the black
plate carries the neutrals, so total ink coverage stays printable. Each plate is an
ordinary layer afterwards — change its ink, its shape, or switch its screen to Stochastic
or Voronoi for a stippled plate. The same menu then offers `↩ Back to the stack from
before`, which restores the layers you had before the first split.

Use spot inks when you want to choose the colours, and when a posterised or hand-printed
look is the point. Use process separations when you want a faithful reproduction and are
happy to print C, M, Y and K.

**Plates** — the `Plates` button separates whatever is on screen into films: one SVG per
ink, solid black on white, plus a colour proof, all with identical registration marks in
a margin outside the artwork. It works on either route — a spot layer is split dot by
dot, and a stack of solid-coloured layers is split layer by layer — and it tells you
which screens it found before it writes anything. A layer that is not one ink (a hue
ramp, or colour sampled straight from the image) cannot belong to a single screen, so it
is left out and named in the warning.

**Document** — each edge is shown in pixels and in millimetres (or inches), with a link
beside them that keeps the proportions when closed. Pixels are how detailed the file is,
millimetres are how big the print is, and `Resolution` is the exchange rate: raising it
keeps the print size and gives the file more pixels, and `2×` / `½×` do that in one press.
That is the upscale: the same print, the same screen, every dot drawn with twice the
pixels — how to get a crisp PNG out of a small source. Typing a bigger size in
millimetres is different: a bigger sheet, and since the halftone is ruled in lines per
inch of paper, more screen cells across it. Changes are staged until `Apply`, because a resize
re-runs every layer.

**One canvas pixel is 1/dpi of an inch**, everywhere — the panel readout, the halftone
lineature, and all four exporters. A 900 × 600 document at 300 dpi is 3 × 2 inches, and
that is the size the SVG, the PDF and the plates open at; the PNG comes out 900 × 600,
one pixel per canvas pixel. Set the resolution you intend to print at and the numbers
in the panel are the numbers you get.

**Show lengths in** decides what every length in the panel is written in — millimetres by
default, or inches, or per cent of the short edge, or raw canvas pixels. The engine works
in pixels throughout; this only changes how they are typed and read. Millimetres and
inches hold as long as the resolution does. Per cent holds whatever size the document is,
which is the one to pick when the same treatment has to work on pictures of different
sizes.

Opening an image takes its *shape*, not its pixel count: the document keeps its long edge
and adopts the new aspect ratio, so a 4000px photograph and a 1200px one land in the same
physical sheet and every length you tuned still means what it meant. No detail is lost by
that — the density map samples the source at its own resolution regardless, and the canvas
only sets how large the output raster is.

**Tone mask** — restrict a layer to a slice of the tonal range, with feathered edges.
Two layers with complementary masks and different shapes is the cheapest route to a
hand-drawn look: coarse marks in the shadows, fine ones in the light.

**Image adjust** — per-layer brightness, contrast, gamma, blur, sharpen, invert. Note
the order: gamma, then blur, then brightness, then contrast. Blur precedes the grade so
that a layer reading the render below it has continuous tone to work with, and brightness
precedes contrast so the contrast pivot can be moved onto whatever part of the range the
input actually occupies.

Export is PNG (1:1 at the document resolution), SVG, PDF, or `Plates` for screenprinting.
Both vector formats emit one definition per shape and one instance per point, so files
stay proportionate — though past a few hundred thousand points any vector file becomes
slow to open, and the export dialog will say so. Plate export writes SVG only; open the
films in any vector editor if your bureau wants PDF.
