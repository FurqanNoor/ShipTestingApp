"""Turn a generated beam-wave case into a 2D empty-tank check (same wave grid, inlet, absorber, gauges, time step).
usage: tank2d.py <generated_case_dir> <out_dir>"""
import json, os, re, shutil, sys

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out + '/system'); os.makedirs(out + '/constant'); os.makedirs(out + '/0')
for f in ['controlDict', 'fvSchemes', 'fvSolution', 'setFieldsDict', 'blockMeshDict']:
    shutil.copy(f'{src}/system/{f}', f'{out}/system/{f}')
for f in ['g', 'transportProperties', 'turbulenceProperties', 'waveProperties']:
    if os.path.exists(f'{src}/constant/{f}'): shutil.copy(f'{src}/constant/{f}', f'{out}/constant/{f}')
for f in ['U', 'alpha.water', 'p_rgh', 'UZero', 'UWave']:
    if os.path.exists(f'{src}/0/{f}'): shutil.copy(f'{src}/0/{f}', f'{out}/0/{f}')
if os.path.exists(f'{src}/system/fvOptions'): shutil.copy(f'{src}/system/fvOptions', f'{out}/system/fvOptions')
for ref in ['UZero', 'UWave']:
    if os.path.exists(f'{out}/0/{ref}'):
        t = open(f'{out}/0/{ref}').read().replace('boundaryField\n{\n', 'boundaryField\n{\n    inlet { type empty; }\n    outlet { type empty; }\n')
        open(f'{out}/0/{ref}', 'w').write(t)
shutil.copy(f'{src}/manifest.json', f'{out}/manifest.json')

ctrl = open(f'{out}/system/controlDict').read()
gx = float(re.search(r'locations \(\(([-\d.eE+]+)', ctrl).group(1))

# blockMesh: a 1-cell slab around the gauge x position, x faces empty.
bm = open(f'{out}/system/blockMeshDict').read()
verts = re.search(r'vertices \((.*?)\);', bm, re.S).group(1)
pts = re.findall(r'\(([^()]+)\)', verts)
xs = sorted({float(p.split()[0]) for p in pts})
lo, hi = xs[0], xs[-1]
def fix(p):
    x, y, z = map(float, p.split())
    return f'({gx - 0.005 if abs(x - lo) < 1e-12 else gx + 0.005} {y} {z})'
bm = bm.replace(verts, '\n'.join(fix(p) for p in pts))
bm = re.sub(r'\) \((\d+) (\d+) (\d+)\) simpleGrading', lambda m: f') (1 {m.group(2)} {m.group(3)}) simpleGrading', bm)
bm = bm.replace('inlet { type patch;', 'inlet { type empty;').replace('outlet { type patch;', 'outlet { type empty;')
open(f'{out}/system/blockMeshDict', 'w').write(bm)

for f in ['U', 'alpha.water', 'p_rgh']:
    t = open(f'{out}/0/{f}').read()
    for patch in ['inlet', 'outlet']:
        t = re.sub(r'(\n\s*' + patch + r'\s*\n\s*\{)[^}]*\}', r'\1\n        type empty;\n    }', t, count=1)
    t = re.sub(r'\n\s*hull\s*\n\s*\{[^}]*\}', '', t)
    open(f'{out}/0/{f}', 'w').write(t)

# No hull: drop the force and rigid-body objects, keep wave gauges and phase checks.
def drop(text, name):
    i = text.find('\n    ' + name)
    if i < 0: return text
    j = text.index('{', i); depth = 0
    for k in range(j, len(text)):
        depth += text[k] == '{'; depth -= text[k] == '}'
        if depth == 0: return text[:i] + text[k + 1:]
    return text
for name in ['hullForces', 'rigidBodyState']:
    ctrl = drop(ctrl, name)
ctrl = re.sub(r'writeInterval\s+[^;]+;', 'writeInterval 1000;', ctrl, count=1)
open(f'{out}/system/controlDict', 'w').write(ctrl)
open(f'{out}/Allrun', 'w').write('source /usr/lib/openfoam/openfoam2312/etc/bashrc\nblockMesh > log.blockMesh 2>&1 && setFields > log.setFields 2>&1 && interFoam > log.interFoam 2>&1\necho DONE > tank.done\n')
m = json.load(open(f'{out}/manifest.json'))
print(out, 'H', m['condition']['heightM'], 'T', m['condition']['periodS'], 'end', m['numerics']['durationS'], 'gauge x', gx)
