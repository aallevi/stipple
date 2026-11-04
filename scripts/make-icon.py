"""Stipple's icon: a 1920s heavyweight sewing machine, three-quarter view.

Black, shiny, vector. The machine is modelled as a few solids — a bed slab,
and a pillar-arm-head outline extruded to depth — and projected obliquely
(x right, y up, z receding up and to the right), so its faces agree with each
other the way a drawn object's would. Chrome on the working parts, gold
decals in the app's orange, a spool of orange thread on top.

Writes assets/brand/app-icon.svg and assets/brand/mark.svg.
"""
import math, sys

out_dir = sys.argv[1] if len(sys.argv) > 1 else 'assets/brand'

KX, KY = 0.42, 0.30          # how far depth recedes, per unit, to the right and up

def P(x, y, z, s, ox, oy):
    return (ox + s * (x + KX * z), oy - s * (y + KY * z))

def path(pts, close=True):
    d = 'M' + ' L'.join(f'{x:.1f},{y:.1f}' for x, y in pts)
    return d + (' Z' if close else '')

# The side outline of pillar, arm and head, in x-y, traced clockwise.
PROFILE = [
    (40, 150), (40, 330), (52, 360), (90, 374), (200, 380), (330, 386), (470, 396),
    (540, 398), (575, 390), (592, 368), (594, 330), (594, 60), (478, 60), (478, 236),
    (468, 252), (420, 260), (300, 264), (190, 262), (160, 256), (152, 236), (152, 150),
]
# The upper edge, left to right, for the arm's top surface.
UPPER = PROFILE[1:11]
Z0, Z1 = 150, 262            # the arm's front and back

def machine(s, ox, oy, mark=False):
    p = lambda x, y, z: P(x, y, z, s, ox, oy)
    out = []
    add = out.append
    # -- bed: top, front, right side
    bx, by, bz = 640, 62, 300
    add(f'<path d="{path([p(0,by,0), p(bx,by,0), p(bx,by,bz), p(0,by,bz)])}" fill="url(#bedTop)"/>')
    add(f'<path d="{path([p(0,0,0), p(bx,0,0), p(bx,by,0), p(0,by,0)])}" fill="url(#blackFace)"/>')
    add(f'<path d="{path([p(bx,0,0), p(bx,0,bz), p(bx,by,bz), p(bx,by,0)])}" fill="#0b0b0b"/>')
    # a chrome bead along the bed's front top edge
    add(f'<path d="{path([p(0,by-4,0), p(bx,by-4,0), p(bx,by,0), p(0,by,0)])}" fill="url(#chrome)"/>')
    # needle plate and slide plate, chrome, on the bed top under the head
    add(f'<path d="{path([p(52,by,170), p(150,by,170), p(150,by,250), p(52,by,250)])}" fill="url(#chrome)" stroke="#555" stroke-width="{s*1.5:.1f}"/>')
    add(f'<path d="{path([p(88,by,200), p(112,by,200), p(112,by,214), p(88,by,214)])}" fill="#2a2a2a"/>')

    # -- body: back outline, top surface, right face of the pillar, front face
    back = [p(x, y, Z1) for x, y in PROFILE]
    add(f'<path d="{path(back)}" fill="#050505"/>')
    for (x1, y1), (x2, y2) in zip(UPPER, UPPER[1:]):
        quad = [p(x1, y1, Z0), p(x2, y2, Z0), p(x2, y2, Z1), p(x1, y1, Z1)]
        add(f'<path d="{path(quad)}" fill="url(#armTop)" stroke="url(#armTop)" stroke-width="{s*1.2:.1f}"/>')
    add(f'<path d="{path([p(594,60,Z0), p(594,330,Z0), p(594,330,Z1), p(594,60,Z1)])}" fill="#0e0e0e"/>')
    front = [p(x, y, Z0) for x, y in PROFILE]
    add(f'<path d="{path(front)}" fill="url(#blackFace)"/>')
    # gloss: a soft band along the arm, and a streak down the pillar
    gloss = [p(70, 362, Z0), p(330, 374, Z0), p(560, 384, Z0), p(560, 360, Z0), p(330, 350, Z0), p(70, 338, Z0)]
    add(f'<path d="{path(gloss)}" fill="url(#gloss)"/>')
    add(f'<path d="{path([p(500,90,Z0), p(512,90,Z0), p(512,330,Z0), p(500,330,Z0)])}" fill="#ffffff" opacity="0.10"/>')

    if not mark:
        # gold decals: a running scroll along the arm and a cartouche on the pillar
        decal = [p(x, 318 + 10 * math.sin(x / 26.0), Z0) for x in range(190, 452, 6)]
        add(f'<path d="{path(decal, False)}" fill="none" stroke="#ff9b21" stroke-width="{s*5:.1f}" stroke-linecap="round"/>')
        for cx in (210, 290, 370):
            cx_, cy_ = p(cx, 300, Z0)
            add(f'<circle cx="{cx_:.1f}" cy="{cy_:.1f}" r="{s*6:.1f}" fill="#ff9b21"/>')
        c1, c2 = p(500, 120, Z0), p(568, 300, Z0)
        add(f'<rect x="{c1[0]:.1f}" y="{c2[1]:.1f}" width="{c2[0]-c1[0]:.1f}" height="{c1[1]-c2[1]:.1f}" rx="{s*14:.1f}" '
            f'fill="none" stroke="#ff9b21" stroke-width="{s*4:.1f}"/>')

    # -- head: chrome face plate, needle bar, needle, presser foot
    fp = [p(50, 170, Z0 - 1), p(144, 170, Z0 - 1), p(144, 344, Z0 - 1), p(50, 344, Z0 - 1)]
    add(f'<path d="{path(fp)}" fill="url(#chrome)" stroke="#6a6a6a" stroke-width="{s*2:.1f}"/>')
    sx, sy = p(97, 258, Z0 - 2)
    add(f'<circle cx="{sx:.1f}" cy="{sy:.1f}" r="{s*9:.1f}" fill="#9a9a9a" stroke="#555" stroke-width="{s*1.5:.1f}"/>')
    nz = (Z0 + Z1) / 2
    bar = [p(90, 150, nz - 6), p(104, 150, nz - 6), p(104, 104, nz - 6), p(90, 104, nz - 6)]
    add(f'<path d="{path(bar)}" fill="url(#chromeV)"/>')
    add(f'<path d="{path([p(95.5,104,nz-6), p(98.5,104,nz-6), p(97.5,by+6,nz-6), p(96.5,by+6,nz-6)])}" fill="#dcdcdc"/>')
    foot = [p(76, by + 2, nz - 16), p(120, by + 2, nz - 16), p(116, by + 14, nz - 16), p(80, by + 14, nz - 16)]
    add(f'<path d="{path(foot)}" fill="url(#chrome)" stroke="#555" stroke-width="{s*1.2:.1f}"/>')
    add(f'<path d="{path([p(112,104,nz-14), p(118,104,nz-14), p(118,by+10,nz-14), p(112,by+10,nz-14)])}" fill="url(#chromeV)"/>')

    # -- hand wheel, on the right, facing along x
    wx, wy, wz, wr = 606, 300, 206, 86
    rim = [p(wx, wy + wr * math.cos(t), wz + wr * math.sin(t)) for t in [i * math.pi / 36 for i in range(72)]]
    rim_in = [p(wx, wy + (wr - 14) * math.cos(t), wz + (wr - 14) * math.sin(t)) for t in [i * math.pi / 36 for i in range(72)]]
    add(f'<path d="{path(rim)}" fill="url(#chrome)" stroke="#444" stroke-width="{s*2:.1f}"/>')
    add(f'<path d="{path(rim_in)}" fill="#0a0a0a"/>')
    for k in range(5):
        t = k * 2 * math.pi / 5 + 0.3
        a = p(wx + 1, wy + 14 * math.cos(t), wz + 14 * math.sin(t))
        b = p(wx + 1, wy + (wr - 14) * math.cos(t), wz + (wr - 14) * math.sin(t))
        add(f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}" stroke="url(#chrome)" stroke-width="{s*10:.1f}" stroke-linecap="round"/>')
    hub = [p(wx + 2, wy + 20 * math.cos(t), wz + 20 * math.sin(t)) for t in [i * math.pi / 18 for i in range(36)]]
    add(f'<path d="{path(hub)}" fill="url(#chrome)" stroke="#444" stroke-width="{s*1.5:.1f}"/>')

    # -- spool pin and a spool of orange thread on the arm
    pz = (Z0 + Z1) / 2
    top = 386 + 12
    def ell(cx, cy, cz, r, n=40):
        return [p(cx + r * math.cos(t), cy, cz + r * math.sin(t)) for t in [i * 2 * math.pi / n for i in range(n)]]
    add(f'<path d="{path([p(326,386,pz), p(334,386,pz), p(334,top+70,pz), p(326,top+70,pz)])}" fill="url(#chromeV)"/>')
    lo, hi = ell(330, top, pz, 26), ell(330, top + 52, pz, 26)
    side = [lo[i] for i in range(0, 21)] + [hi[i] for i in range(20, -1, -1)]
    add(f'<path d="{path(lo)}" fill="#7a4a10"/>')
    add(f'<path d="{path(side)}" fill="url(#thread)"/>')
    add(f'<path d="{path(hi)}" fill="#ffb24f" stroke="#7a4a10" stroke-width="{s*2:.1f}"/>')
    add(f'<path d="{path(ell(330, top + 52, pz, 8))}" fill="#3a2a10"/>')
    return out

DEFS = '''<defs>
<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cbcbcb"/><stop offset="1" stop-color="#a9a9a9"/></linearGradient>
<linearGradient id="blackFace" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2b2b"/><stop offset="0.45" stop-color="#121212"/><stop offset="1" stop-color="#050505"/></linearGradient>
<linearGradient id="bedTop" x1="0" y1="1" x2="0.4" y2="0"><stop offset="0" stop-color="#1c1c1c"/><stop offset="0.55" stop-color="#3a3a3a"/><stop offset="1" stop-color="#151515"/></linearGradient>
<linearGradient id="armTop" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#4a4a4a"/><stop offset="1" stop-color="#1a1a1a"/></linearGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="0.45" stop-color="#bdbdbd"/><stop offset="0.55" stop-color="#8a8a8a"/><stop offset="1" stop-color="#e2e2e2"/></linearGradient>
<linearGradient id="chromeV" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8a8a8a"/><stop offset="0.4" stop-color="#ffffff"/><stop offset="1" stop-color="#777"/></linearGradient>
<linearGradient id="thread" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b8650c"/><stop offset="0.4" stop-color="#ffb24f"/><stop offset="1" stop-color="#c26e10"/></linearGradient>
</defs>'''

def doc(S, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">\n{DEFS}\n' + '\n'.join(body) + '\n</svg>\n'

# App icon: the macOS 824-unit content square with a 185 corner, the machine inside it.
icon = [
    '<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#plate)"/>',
    '<rect x="103" y="103" width="818" height="818" rx="182" fill="none" stroke="#7d7d7d" stroke-width="6"/>',
    '<ellipse cx="520" cy="780" rx="350" ry="46" fill="#000" opacity="0.18"/>',
] + machine(0.93, 168, 772)
open(f'{out_dir}/app-icon.svg', 'w').write(doc(1024, icon))

# Toolbar mark and favicon: the machine alone, simplified, filling the square.
open(f'{out_dir}/mark.svg', 'w').write(doc(1024, machine(1.06, 92, 840, mark=True)))
print('ok')
