"""Stipple's icon and toolbar mark, as SVG.

Icon: a stippled sphere — a jittered grid kept with a probability that follows
the sphere's shading, the way the app's stochastic screen works — on the app's
grey, with one orange dot, the one accent the interface allows itself.

Mark: the same sphere as an AM halftone. A stochastic stipple at 14px is noise;
a halftone of a few big dots still reads as a lit ball.
"""
import math, random, sys

out_dir = sys.argv[1]
L = (-0.5, -0.62, 0.6)
n = math.sqrt(sum(c * c for c in L)); L = tuple(c / n for c in L)

def ink_at(dx, dy):
    d2 = dx * dx + dy * dy
    dz = math.sqrt(max(0.0, 1 - d2))
    lit = max(0.0, dx * L[0] + dy * L[1] + dz * L[2])
    ink = (1 - lit) ** 1.6
    return min(1.0, ink + (d2 ** 6) * 0.5)  # a darker limb, as a drawn sphere has

def stipple(cx, cy, r, step, rmin, rmax, seed):
    rnd = random.Random(seed)
    dots = []
    y, row = cy - r, 0
    while y <= cy + r:
        x = cx - r + (step / 2 if row % 2 else 0)
        while x <= cx + r:
            jx = x + (rnd.random() - 0.5) * step * 0.9
            jy = y + (rnd.random() - 0.5) * step * 0.9
            dx, dy = (jx - cx) / r, (jy - cy) / r
            if dx * dx + dy * dy < 0.995:
                ink = ink_at(dx, dy)
                if rnd.random() < 0.03 + ink * 0.97:
                    dots.append((jx, jy, rmin + (rmax - rmin) * ink ** 0.8))
            x += step
        y += step * 0.866
        row += 1
    return dots

def halftone(cx, cy, r, cell):
    dots = []
    j = -int(r / cell) - 1
    while j <= int(r / cell) + 1:
        i = -int(r / cell) - 1
        while i <= int(r / cell) + 1:
            x = cx + (i + (0.5 if j % 2 else 0)) * cell
            y = cy + j * cell * 0.866
            dx, dy = (x - cx) / r, (y - cy) / r
            if dx * dx + dy * dy <= 1.0:
                ink = ink_at(dx, dy)
                rad = cell * 0.62 * math.sqrt(ink)
                if rad > cell * 0.08:
                    dots.append((x, y, rad))
            i += 1
        j += 1
    return dots

def doc(S, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">\n{body}\n</svg>\n'

def circles(dots, fill):
    return f'<g fill="{fill}">' + ''.join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}"/>' for x, y, r in dots) + '</g>'

# --- app icon: 1024 canvas, macOS content square of 824 with ~185 corner radius
S = 1024
pad, side, rad = 100, 824, 185
bg = (f'<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9c9c9"/>'
      f'<stop offset="1" stop-color="#ababab"/></linearGradient></defs>'
      f'<rect x="{pad}" y="{pad}" width="{side}" height="{side}" rx="{rad}" fill="url(#g)"/>'
      f'<rect x="{pad + 3}" y="{pad + 3}" width="{side - 6}" height="{side - 6}" rx="{rad - 3}" fill="none" stroke="#7d7d7d" stroke-width="6"/>')
sphere = stipple(500, 540, 285, 13.5, 3.2, 7.6, 7)
accent = '<circle cx="770" cy="262" r="40" fill="#ff9b21" stroke="#141414" stroke-width="7"/>'
open(f'{out_dir}/app-icon.svg', 'w').write(doc(S, bg + circles(sphere, '#141414') + accent))

# --- toolbar mark / favicon: 64 units, no plate, halftone
M = 64
mark = halftone(29, 35, 25, 5.6)
open(f'{out_dir}/mark.svg', 'w').write(doc(M, circles(mark, '#141414')
     + '<circle cx="53" cy="12" r="7.5" fill="#ff9b21" stroke="#141414" stroke-width="2"/>'))
print(len(sphere), 'icon dots,', len(mark), 'mark dots')
