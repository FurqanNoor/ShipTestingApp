# Hull Test Bench + local OpenFOAM

**Hackathon judges: start with [JUDGES.md](JUDGES.md)** (setup on your own computer and CSC account, running tests on Roihu, combining results).

This version adds a real local OpenCFD v2312 solver workflow to the uploaded source. It keeps the existing browser simulation as a quick preview and records CFD output separately. It does not integrate the earlier hosted Arova Hull Lab.

For setup, geometry requirements, supported wave tests and accuracy limits, read [OPENFOAM.md](OPENFOAM.md).

```sh
npm ci
npm run cfd:pull
npm run cfd
```

Start Docker first, then open http://127.0.0.1:5173, add your STL, check its units and axes, and select **OpenFOAM → Run automatic tests**. No CG, inertia, wave or mesh values are required in the normal workflow.

The same **150 g, 250 g and 350 g total test loads** run for every hull: calm towing at **0.30 m/s** and three zero-speed regular beam-wave intensities scaled to hull length. The app detects supported hull geometry, samples a printed-wall resolution length, estimates CAD CG and inertia, and finds a stable dry initial roll/trim pose. Tick the tests you want (default: all 9, Quick) and pick **Quick** (one solve per test, used for the ranking) or **Full** (adds a coarse-mesh and a half-time-step check to each calm tow). Each solve uses several CPU cores and the panel streams the **live solver log** with time left; unsuitable geometry, loading, mesh or resource conditions are recorded explicitly. **New in this build:** per-test time estimates and a pre-check that flags tests a hull can't run before you start; a queue for many hulls (e.g. all competition entries) with finish times, notifications, re-run of unfinished tests and one combined Excel; plain-language failure explanations; and a rebuilt wave setup (clean wave meshing, relaxation-zone wave-maker, sponge absorber, smaller tank, calibrated wave height that every run checks at its gauges). See OPENFOAM.md.

These test masses follow a declared uniform CAD mass distribution. They are protocol defaults, not measured weights recovered from an STL. Automatic CG and inertia do not reveal infill, hidden equipment or real cargo positions. Wave motion is constrained to heave and roll about the posed longitudinal hull axis; it is not a general six-degree-of-freedom ship simulation. **Advanced settings** retain manual tests and measured loading options.

You can stop tests, recover recent local records and download partial or completed **Excel, JSON and individual solver cases**, including assumptions and numerical comparisons. Passing those checks does not establish physical accuracy or validated competition placements. The original audit and historical native smoke evidence remain included. Read [OPENFOAM.md](OPENFOAM.md) before interpreting forces or roll.

The remaining sections describe the retained **quick-preview engine**, not the new CFD solver. Its rasterized open-hull, automatic CG and empirical drag assumptions remain screening limitations.

A simplified version of the Arova Ship Test Bench for testing your own hull designs.
Upload STL files, and every hull is put through the same programme in a virtual model tank:
3 weights, each in calm water and 3 seas. You get drag, roll stability and buoyancy for
each case, a leaderboard across all uploaded hulls, and an Excel file of the results.

## Run

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ (and dist/hull-test-bench.html, a single file that opens from disk)
npm test         # physics checks
```

`npx tsx scripts/make-samples.ts samples` writes a few sample STL files.

**OpenFOAM tests:** `npm run cfd` starts the app with the local solver (Docker). To run every test in parallel on a supercomputer such as CSC Roihu, see [CLUSTER.md](CLUSTER.md).

## Using it

1. **Add STL** (or drop files on the tank). Several files can be added at once.
2. Check the model sits right: deck up, bow at the orange arrow. If not, use **Flip**,
   **Roll 90°** or **Turn 90°**. Set the STL unit if the size shown is wrong.
3. Pick a weight in the panel and a water condition in the table to play it in the tank.
4. **Download Excel** exports every model, weight and sea.

## Test conditions

Everything is Froude-scaled from the original app's 120 m demo ferry to a 220 mm reference hull (entries may be up to 250 × 250 × 250 mm)
(scale 1:545), so all models meet identical conditions. Change them under *Test conditions*.

| | Model scale | Full size |
| --- | --- | --- |
| Empty | 22.5 g | lightship 3743 t |
| Loaded | 28 g | + luggage 20 t, fuel/water 400 t, cargo 500 t |
| Overloaded | 33.5 g | + double luggage, fuel and cargo |
| Moderate sea | 3.7 mm, 0.36 s | 2 m |
| Rough sea | 7.3 mm, 0.45 s | 4 m |
| Very rough sea | 11 mm, 0.54 s | 6 m |
| Speed | 0.40 m/s | 18 kn |

Tank (simulation boundary): 2.2 x 1.1 x 0.55 m. Results are calculated for open, deep water;
the drawn tank does not enter the preview force calculation. Its size checks are preliminary
heuristics, not evidence of boundary independence.

## How results are calculated

| Result | Method | File |
| --- | --- | --- |
| Hull shape | STL rasterised into vertical columns; outer shape sealed at the deck | `src/engine/hull.ts` |
| Orientation | longest axis = length, mirror-symmetric axis = beam, finer end = bow | `src/engine/orient.ts` |
| Draft, freeboard, buoyancy, max load | buoyancy = density x g x submerged volume | `src/engine/hydrostatics.ts` |
| Roll stability | righting-arm (GZ) curve 0-90 deg at constant weight, both sides | `src/engine/hydrostatics.ts` |
| Calm-water drag | Holtrop & Mennen 1984 (ported from vessel.js), ITTC-57 friction | `src/engine/drag.ts` |
| Added drag in waves | STAWAVE-2 (ITTC 7.5-04-01-01.1) summed over the sea's components | `src/engine/drag.ts` |
| Roll, pitch, heave, buoyancy in waves | time simulation in an irregular sea (Bretschneider) | `src/engine/sim.ts` |
| Leaderboard | best in each of drag / roll / max load = 100 points, total = average | `src/engine/analyze.ts` |

Assumptions: fresh water; centre of gravity at the centre of the model's volume (changeable);
load placed so the ship floats level; hull watertight up to the deck edge.

Buoyancy and stability follow directly from the geometry and are checked against hand
calculations for a box hull (`tests/engine.test.ts`). The drag code reproduces the worked
example from Holtrop & Mennen's paper. Drag and wave results are engineering estimates, not
CFD. They are screening estimates and should not establish final team placements without
convergence studies and physical calibration.

## Credits

Built on the Arova Ship Test Bench (conventions, sea states, reference ferry, visual style).
The Holtrop resistance formulas are ported from vessel.js (MIT licence, shiplab/vesseljs).
