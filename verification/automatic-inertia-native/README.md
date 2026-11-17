# Native constrained-inertia startup evidence

This is a real **OpenCFD OpenFOAM v2312 interFoam** run, ending normally at
0.0004 s. It checks the native dictionary, initial orientation and constrained
rotation handling. It is not a physical wave-response or accuracy benchmark.

The synthetic box has a deliberately displaced CG at Y = 5 mm to produce a
startup torque. Its full prescribed inertia tensor includes nonzero products.
The desired world roll axis is `(cos(0.35), 0, -sin(0.35))`, so the computational
body frame is nonidentity. The native axis constraint is body `(1 0 0)`.
The complete tensor is recorded; the only free rotation uses `a^T I a`.
No general unconstrained rotational response is claimed.

Observed checks:

- Two actual motion-state samples were written.
- Both world angular-velocity vectors align with the desired world roll axis;
  relative cross-product errors are below 3 × 10⁻¹¹.
- Comparison of all 145,488 initial/first-step mesh points gives maximum
  displacement 4.83 × 10⁻⁸ m. Setting equal native `orientation` and
  `initialOrientation` did not rotate the initial CAD by the 0.35 rad body frame.
- Actual solver logs, motion output, generated dictionaries, manifest and
  numerical checks are included in this directory.

The existing 131,396-cell calm mesh was reused. The generated production wave
mesh was deliberately not run. This ends before wave propagation/ramp and cannot
establish drag, flooding, wave response, numerical convergence or placements.

To reproduce from a project with the original calm smoke mesh available, run
from the project root. `setup.ts` creates a fresh directory and stops if it
already exists; it never deletes prior results.

```sh
./node_modules/.bin/esbuild verification/automatic-inertia-native/setup.ts --bundle --platform=node --format=esm --outfile=/tmp/automatic-inertia-native-setup.mjs
node /tmp/automatic-inertia-native-setup.mjs
docker run --rm --user "$(id -u):$(id -g)" --volume "$PWD/cfd-runs/automatic-inertia-native-001:/case" --workdir /case --entrypoint bash opencfd/openfoam-run@sha256:8d411a033af4a841c98ccaab7a49407812a6d78ba22e501fa1c92b2038d39a76 -lc 'source /usr/lib/openfoam/openfoam2312/etc/bashrc && setFields > log.setFields 2>&1 && interFoam > log.interFoam 2>&1'
```

The distributed ZIP contains evidence, not the large native mesh or a claim of
experimental validation. The baseline calm smoke must first supply
`cfd-runs/smoke-calm-001/constant/polyMesh` to repeat this startup run.
