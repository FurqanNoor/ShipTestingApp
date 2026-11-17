# Any-STL robustness check

This checks that competition entries of any shape inside the 250 × 250 × 250 mm build volume reach the solver. Each STL goes through the same steps as the app:
1. Parse the file.
2. Orient it and guess its units.
3. Check it against the build volume.
4. Run the server's automatic CAD clean-up (`server/geometry-repair.mjs`).
5. Build the automatic plan.
6. Prepare the OpenFOAM case for all 12 tests, in both Quick and Full (coarse) mode.

`corpus.py` generates the synthetic files.

## Test files

The synthetic files cover:
- monohulls from 80 to 250 mm, a sharp V-hull, a 250 × 250 mm barge, and wide-shallow and tall-narrow hulls;
- joined and separate catamarans, a trimaran, and a hull with an overlapping cabin;
- inside-out and mixed normals, and a small hole;
- open skins with flat and sloping sheer, and printed shells with flat and sloping rims;
- a 242,000-triangle dense export;
- ASCII files, metre units, and Y-up exports.

The organiser's own `ShipDesign.stl` and `ChattyShip.stl` were also run.

## Results

See `corpus-table.md`. Every file reaches a prepared OpenFOAM case, or gets a recorded physical outcome.

"cannot float (max N g)" means the hull's own displacement is below that test mass. The app records this as **Sinks** with the maximum mass, not as an error. For example, an 80 mm hull cannot carry 150 g.

Both organiser files are fully prepared (24/24):
- **ShipDesign** is detected as a printed shell.
- **ChattyShip** is four bodies merged by boolean union. One internal pocket is filled, and three sealed air spaces count as displacement.

## Real OpenFOAM meshing (v2312, Quick mode, 250 g, calm and medium beam waves)

| Hull | Calm cells | Calm mesh | Wave cells | Wave mesh |
| --- | --- | --- | --- | --- |
| ChattyShip (merged) | 137,788 | Mesh OK | 269,178 | accepted: only hull-wall skew, all quality-dict criteria 0 |
| ShipDesign (printed, sealed for CFD) | 130,143 | Mesh OK | 259,261 | accepted: only hull-wall skew, all quality-dict criteria 0 |
| Catamaran (3 bodies merged) | 159,871 | Mesh OK | 307,272 | accepted: 5 soft faces (3 at 65.1°, 2 twist) of 307k cells |
| 250 × 110 × 60 mm monohull | 130,578 | Mesh OK | 267,634 | Mesh OK |

snappyHexMesh took 20–52 s per case, with 8 cases sharing 4 cores.

## Fixes found by this check

- **Boolean-merged output:** this contained vertices about 10 nm apart, which the solver's watertightness check rejected for ChattyShip. Output is now simplified and snapped to a 1 µm grid, and is used only if it stays closed and consistently oriented.
- **Solver geometry step:** this still capped files at 250,000 faces, while the app accepts 500,000. It now matches.
- **Mesh gate:** snappyHexMesh's relaxed pass allows non-orthogonality up to 75°, but the gate rejected anything over 65°. A valid catamaran wave mesh was being blocked by 5 faces out of 307k cells. The gate now accepts up to max(10, cells / 10,000) soft-quality faces. It still rejects any face with bad pyramid volume, tetrahedron quality or cell determinant. The solver uses limited non-orthogonal correction.
- **Planning speed:** dense STLs plan about 2.7× faster (13 s → 5 s for 242,000 triangles), and plans are cached per geometry.

## Real solver run on a gate-tolerated mesh (catamaran, medium beam waves, Quick, 4 cores)

The catamaran wave mesh was the one the new gate accepts with 5 soft faces. It was run through the app's own `Allrun` (gate → setFields → decomposePar → `interFoam` on 4 MPI ranks) to 0.6 s simulated time, twice:

| Flow Courant cap | Steps | Solve wall time | Result |
| --- | --- | --- | --- |
| 0.5 (old Quick setting) | 612 | 1,248 s | stable; no NaN; min alpha −7.7×10⁻⁵ |
| 1.0 (new Quick setting) | 465 | 971 s (−22%) | stable; no NaN; heave identical to 0.001 mm |

The interface Courant cap (maxAlphaCo 0.5) and every other setting were the same in both runs. Full mode keeps the stricter 0.5.

Scope: 0.6 s covers hull settling and the start of the wave ramp. The waves had not yet reached the hull, so the motion comparison covers settling only. Each real run still checks its own measured wave and stability.

The estimator's default for Quick wave runs was recalibrated from this run (prediction 960 s against 971 s measured). Every finished run on the competition workstation recalibrates it again. One complete Quick wave test (8.1 s simulated, about 310k cells) is predicted at about 70 min on 16 cores. Files are in `catamaran-wave-run/`.
