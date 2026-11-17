"""Generate a varied corpus of hull STLs (mm unless stated) for robustness testing."""
import math, os, random, struct, sys

out = sys.argv[1]; os.makedirs(out, exist_ok=True)

def ring(x, L, B, D, n=24, p=0.6, deck=1.0, inset=0.0, bottom=0.0, flat=0.0, sheer=0.0):
    """Section loop at station x: starboard deck -> keel -> port deck (y,z)."""
    t = x / L
    hb = max(0.6, B / 2 * (math.sin(math.pi * min(max(t, 0.02), 0.98)) ** 0.45)) - inset
    pts = []
    for i in range(n + 1):
        a = -math.pi / 2 + math.pi * i / n          # -90..90 deg around the bilge
        y = hb * math.sin(a)
        frac = abs(math.sin(a)) ** (1 / p if p else 1)
        z = bottom + inset + (D * deck - bottom - inset) * (1 - math.cos(a) ** 1.0) if False else None
        Dx = D * deck * (1 + sheer * (x / L) ** 2)
        zz = Dx * (abs(y) / max(hb, 1e-9)) ** (1 / max(p, 1e-3))
        zz = max(zz, flat * D)
        pts.append((y, zz + inset + bottom))
    return pts

def loft(L, B, D, nx=40, ny=24, p=0.6, inset=0.0, closed_top=True, xoff=0.0, yoff=0.0, zoff=0.0, flat=0.0, sheer=0.0):
    secs = [[(x + xoff, y + yoff, z + zoff) for (y, z) in ring(x, L, B, D, ny, p, inset=inset, flat=flat, sheer=sheer)]
            for x in [L * i / nx for i in range(nx + 1)]]
    tris = []
    for i in range(nx):
        a, b = secs[i], secs[i + 1]
        for j in range(ny):
            tris += [(a[j], b[j], b[j + 1]), (a[j], b[j + 1], a[j + 1])]
    top_z = D + inset + zoff
    if closed_top:
        for i in range(nx):  # deck: connect port and starboard edges
            a, b = secs[i], secs[i + 1]
            tris += [(a[ny], b[ny], b[0]), (a[ny], b[0], a[0])]
    for s, rev in ((secs[0], True), (secs[-1], False)):  # end caps (fan)
        c = (sum(p[0] for p in s) / len(s), sum(p[1] for p in s) / len(s), sum(p[2] for p in s) / len(s))
        for j in range(ny):
            t = (c, s[j], s[j + 1]) if rev else (c, s[j + 1], s[j])
            if closed_top or True: tris.append(t)
        t = (c, s[ny], s[0]) if rev else (c, s[0], s[ny])
        tris.append(t)
    return tris

def box(x0, y0, z0, x1, y1, z1):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    q = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return [t for a, b, c, d in q for t in ((v[a], v[b], v[c]), (v[a], v[c], v[d]))]

def orient_out(tris):
    v = sum((a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) for a, b, c in tris)
    return tris if v > 0 else [(a, c, b) for a, b, c in tris]

def shell(L, B, D, wall, **kw):
    outer = orient_out(loft(L, B, D, closed_top=False, **kw))
    inner = loft(L - 0, B, D, closed_top=False, inset=wall, **kw)
    # inner surface faces inward (reverse), then join rims with a ring of faces
    inner = [(a, c, b) for a, b, c in orient_out(inner + [])]
    return outer + inner

def write_bin(path, tris, scale=1.0):
    with open(path, 'wb') as f:
        f.write(b'corpus'.ljust(80, b' ')); f.write(struct.pack('<I', len(tris)))
        for t in tris:
            f.write(struct.pack('<3f', 0, 0, 0))
            for p in t: f.write(struct.pack('<3f', *(c * scale for c in p)))
            f.write(b'\0\0')

def write_ascii(path, tris):
    with open(path, 'w') as f:
        f.write('solid corpus\n')
        for t in tris:
            f.write(' facet normal 0 0 0\n  outer loop\n')
            for p in t: f.write(f'   vertex {p[0]:.6f} {p[1]:.6f} {p[2]:.6f}\n')
            f.write('  endloop\n endfacet\n')
        f.write('endsolid corpus\n')

def subdivide(tris, times):
    for _ in range(times):
        nt = []
        for a, b, c in tris:
            ab = tuple((a[i] + b[i]) / 2 for i in range(3)); bc = tuple((b[i] + c[i]) / 2 for i in range(3)); ca = tuple((c[i] + a[i]) / 2 for i in range(3))
            nt += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]
        tris = nt
    return tris

mono = lambda L, B, D, **k: orient_out(loft(L, B, D, **k))
cases = {
    'mono-150': mono(150, 60, 40),
    'mono-220': mono(220, 80, 45),
    'mono-250-max': mono(250, 110, 60),
    'tiny-80': mono(80, 30, 20),
    'vhull-sharp-220': mono(220, 75, 50, p=1.5),
    'flat-barge-250x250': orient_out(box(0, -125, 0, 250, 125, 60)),
    'wide-shallow-200': mono(200, 160, 30, p=0.3, flat=0.0),
    'tall-narrow-250': mono(240, 50, 250, p=0.8),
    'catamaran-joined': orient_out(loft(220, 50, 45, yoff=-55)) + orient_out(loft(220, 50, 45, yoff=55)) + orient_out(box(30, -70, 38, 190, 70, 50)),
    'catamaran-separate': orient_out(loft(200, 45, 40, yoff=-50)) + orient_out(loft(200, 45, 40, yoff=50)),
    'trimaran': orient_out(loft(230, 60, 50)) + orient_out(loft(150, 25, 30, xoff=40, yoff=-70, zoff=10)) + orient_out(loft(150, 25, 30, xoff=40, yoff=70, zoff=10)) + orient_out(box(60, -80, 44, 170, 80, 52)),
    'hull-plus-cabin-overlap': mono(220, 80, 45) + orient_out(box(60, -25, 35, 150, 25, 70)),
    'inside-out-normals': [(a, c, b) for a, b, c in mono(220, 80, 45)],
    'open-skin-no-thickness': orient_out(loft(220, 80, 45, closed_top=False)),
    'open-skin-sheer': orient_out(loft(220, 80, 40, closed_top=False, sheer=0.35)),
    'sheer-closed-deck': mono(220, 80, 40, sheer=0.35),
    '_outer-flat': mono(220, 80, 45), '_inner-flat': orient_out(loft(216, 76, 60, xoff=2, zoff=2)),
    '_outer-sheer': mono(220, 80, 40, sheer=0.35), '_inner-sheer': orient_out(loft(216, 76, 70, xoff=2, zoff=2)),
    'dense-300k': subdivide(mono(220, 80, 45, nx=60, ny=30), 3),
}
for name, tris in cases.items():
    write_bin(f'{out}/{name}.stl', tris)
write_ascii(f'{out}/ascii-mono-200.stl', mono(200, 70, 40))
write_bin(f'{out}/inches-mono-200mm.stl', mono(200, 70, 40), scale=1 / 25.4)
write_bin(f'{out}/metres-mono-200mm.stl', mono(200, 70, 40), scale=1 / 1000)
# Hull rotated as many CAD tools export (Y-up, bow along Z)
rot = [((p[1], p[2], p[0]), (q[1], q[2], q[0]), (r[1], r[2], r[0])) for p, q, r in mono(210, 75, 42)]
write_bin(f'{out}/y-up-rotated.stl', rot)
# Mixed normals: every 7th triangle flipped
m = mono(220, 80, 45); write_bin(f'{out}/mixed-normals.stl', [(a, c, b) if i % 7 == 0 else (a, b, c) for i, (a, b, c) in enumerate(m)])
# Small hole: 3 missing triangles
write_bin(f'{out}/small-hole.stl', m[:100] + m[103:])
print(len(os.listdir(out)), 'files')
