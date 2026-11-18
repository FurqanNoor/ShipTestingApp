# OpenFOAM workflow

This implementation uses only the supplied `hull-test-bench-source.zip` as its application base. It does not use the earlier hosted Arova Hull Lab. The original ZIP's numerical audit is retained separately; the changes here are a new version.

## Run locally

Install Node.js 22 or newer and Docker Desktop with Linux containers, or Docker Engine on Linux. Start Docker, then run:

```sh
npm ci
npm run cfd:pull
npm run cfd
```

Open **http://127.0.0.1:5173**. Add your STL, check units and axes, then select **OpenFOAM → Run automatic tests**. The normal workflow needs no numerical input fields; **Advanced settings** retain the manual controls. The single-file HTML still supports the original quick preview, but it cannot launch a native CFD solver; use the local service URL for CFD.

The solver is pinned to OpenCFD OpenFOAM **v2312**, image `opencfd/openfoam-run`, digest `sha256:8d411a033af4a841c98ccaab7a49407812a6d78ba22e501fa1c92b2038d39a76`. This is a different distribution from OpenFOAM Foundation releases; do not silently substitute dictionaries across versions.

The service listens only on loopback, rejects cross-origin requests, limits its queue and request sizes, and runs one solver at a time in a network-isolated container. Inputs stay on your computer. Cases and raw outputs remain in `cfd-runs/`; result and case ZIP downloads are available in the panel. Large field time directories and `polyMesh` are omitted from browser ZIPs; the configuration can regenerate them.

## Choosing tests, speed and CPU cores

In **OpenFOAM → Test your hull** you tick exactly which load/sea combinations to run (default: just *250 g · Calm tow*). Tests always run one after another, never at the same time.

- **Quick** (default): one coarse solve per test. Calm tows simulate 40 hull lengths of towing (about 30 s for a 220 mm hull, at least 24 s) and average the drag over the last 60% of the run. On real competition-style hulls the drag settled only after 8–12 s; the earlier 16-length runs read 9–23% low, by a different amount for each hull. Calm runs still finish well before the wave tests, so a whole study takes no longer. Calm tows use one outer PIMPLE corrector, a Courant limit of 0.4 and a 2 ms step cap. The earlier 0.8 / 4 ms read drag low: halving it raised calm drag by 16%, 6% and 21% on the three loads of a SWATH hull, always upward (setup version calm 2026-11-18c; older calm results are not ranked). Wave tests use a lighter wave grid (4 cells per wave height, 20 per wavelength), measure 8 wave periods after arrival and allow 100 steps per period; the floating hull keeps two outer correctors, with Courant limits of 1 (flow) and 0.5 (interface). Courant 1 was checked against 0.5 on a real run: same heave, 22% faster. Quick numbers are rough screening values with no sensitivity checks and are not comparable with Full runs.
- **Full**: three solves per test, all started at once on the cluster: coarse, medium mesh and a halved time step, with the sensitivity checks below. About 2–3 hours per hull on Roihu.

Each solve is split across the chosen number of **CPU cores** with MPI (`decomposePar` + `mpirun interFoam -parallel`). The default is all cores minus one (all cores on 1–2 core machines); `CFD_CPUS` overrides that default. Docker memory defaults to 70% of system RAM (at least 3 GB); `CFD_MEMORY=8g` overrides it.

The panel shows a **live solver log** streamed from the container, plus simulated time, % done, time left for the current solve, time step, maximum Courant number and mesh cells. Wave tests are much slower than calm tows because the wave grid must resolve the wave height.

**Moving-mesh zone (fixed November 2026).** In beam waves the mesh around the floating hull deforms as it heaves and rolls. That deforming zone used to reach 0.75 hull lengths from the hull, past the tank's end walls (0.5 hull lengths away). Rolling then moved the wall cells, which pumped spurious air at up to 23 m/s just above the water there and forced 0.25 ms time steps. The zone now ends inside the tank. On CSC Roihu (64 cores) a 350 g high-wave test went from about 3 hours to 50 minutes. A larger interface Courant limit (1 instead of 0.5) was tested and rejected: it changed roll and heave by 3–6%.

**Wave gauges.** The two gauges stand between the wave-maker and the hull, close to it, so the measured height includes waves that the hull reflects and radiates. Beside a strongly rolling hull the two gauges differed by up to 40%. The incoming wave is set identically for every hull from an empty-tank calibration; read the ⚠ wave-height flag as information about the hull's reflection unless the gauge histories show a poorly formed wave.

Measured on a slow 4-core cloud VM (your machine is likely faster): a Quick 250 g calm tow of the 200 mm barge sample (128k cells) took **18.5 minutes end to end** (meshing + solve) on 4 cores; one Full-mode coarse calm solve of the same case would take roughly 8 hours there, and Full runs three solves per test. Evidence: `verification/quick-parallel-calm/`.

**Wave meshing (fixed):** the original wave grid used very flat cells in the free-surface band (up to ~18x wider than tall). Refinement and hull snapping inside such cells created faces up to ~83° non-orthogonal, so every wave case tried stopped at the `checkMesh` gate. Wave cases now split a column of cells around the hull horizontally only (snappyHexMesh directional refinement) until they are at most 2.5x wider than tall, and snap the hull onto those cells. The column ends vertically where background cells are tall enough for clean transitions. Verified with real snappyHexMesh + checkMesh: box barge (low waves), curved hull (low and high waves, Quick) and Full coarse grid (3.6M cells) all report **Mesh OK**, with worst non-orthogonality 34–46°. The 65° gate is unchanged. Full-mode medium/fine wave grids still exceed the 5M-cell budget (as they did before) and are reported as such.

**Wave generation and absorption (rebuilt):** once meshing worked, 2D empty-tank runs of the generated wave grids showed that **every wave case diverged**, including the original configuration. The native boundary wave-maker (`waveVelocity`/`waveAlpha`, StokesI) misbehaves at this model scale:
- With active absorption, its shallow-water correction ran away from the first time step (a uniform outflow growing until the floor corner cell drained, then blow-up at 1.3–2.4 s).
- Without it, air velocities at the paddle spiked to 20–120 m/s.

The far-side `shallowWaterAbsorption` is also invalid in deep water. Changing the depth, the grid, the time step, surface tension, the floor condition or the pressure reference did not fix either problem. Waves are now made the way the established wave toolboxes do it, using native OpenFOAM features only:
- **Generation:** a relaxation zone one wavelength long next to a slip wall. An `exprField` evaluates linear finite-depth (Stokes I) wave velocity each time step (cosine ramp over 3 periods), and a density-weighted `acousticDampingSource` relaxes the water toward it. The zone also absorbs waves reflected or radiated back toward it.
- **Absorption:** a density-weighted sponge 1.5 wavelengths long before a slip far wall, with cells growing 10% per cell.
- **Smaller tank for beam waves:** tank depth 0.6 wavelengths (at least keel + half a hull length). Half a hull length of water beyond each hull end, and the larger of half a wavelength or half a hull length between the hull and the generation zone or sponge. Quick wave cases dropped from ~1.0–1.4M to ~0.6–0.9M cells.
- **Calibrated height:** the coarse grids lose some wave height between the wave-maker and the hull. In empty-tank calibration the Quick grid delivered 69% (low), 74% (medium) and 79% (high) of the target height, and the Full grid 91%, 93.5% and 94%, with the period within 0.1%. With the calibrated gains, the measured height at the hull is 98–99% (Quick) and 99–101% (Full). The standard presets therefore use matching wave-maker gains, as physical towing tanks calibrate their paddles. Every run still measures the wave actually produced at its gauges and flags a deviation.
- **Verification:** generated Quick low, medium and high wave cases ran to completion in 2D (alpha bounded to 1e-25, no time-step collapse). The 3D wave mesh with the generation zone and sponge passes `checkMesh`.
- **Unit checking:** the exprField formula mixes metres and plain numbers, so OpenFOAM's dimension-consistency check is switched off for wave cases only (`DebugSwitches { dimensionSet 0; }`). This disables the check, not any arithmetic.

## Time estimates, queue and quality-of-life

- **Before you run:** every test for the selected hull is prepared (not run) on the server. Tests that cannot run (for example "Hull cannot float this load", or a mesh over budget) are flagged in the grid and skipped. Each test shows an estimated run time, and the run button shows the total.
- **How estimates work:** mesh size comes from the generated case (within ~2% of the real mesh in tests). Run time = time steps × cells × measured cost per cell-step ÷ cores^0.83. Defaults were measured on a slow 4-vCPU VM, so they err on the long side. After every finished run the app re-calibrates for your computer (`cfd-runs/calibration.json`), so estimates improve quickly. While a test is solving, its remaining time comes from the live solver rate.
- **Queue:** you can add hulls while tests run. **Queue these tests for all N loaded hulls** queues one study per uploaded STL (e.g. all competition entries). The queue panel shows each hull's start time, duration and finish time, plus the overall finish time. You can remove queued hulls, stop everything, or view any study.
- **History:** finished studies stay listed. **Re-run N unfinished tests** re-queues failed, interrupted or stopped tests (the hull geometry is stored with each study). **Download all hulls (Excel)** gives one comparison sheet across every hull.
- **Notifications:** the browser tab title shows progress and time left. If you allow notifications, you get one when each hull finishes and when the queue is empty. Closing the dialog does not stop anything.
- **Plain-language failures:** common problems (cannot float, mesh quality, out of memory, time limit, unstable solver, Docker not running, disk full, bad STL) are explained with what to do. The technical error stays available.
- **Wave check:** every wave run measures the wave actually produced at two gauges up-wave of the hull and reports it as % of the requested height and period. Outside ±10% height or ±5% period, the result is flagged ⚠ because roll responds to the wave actually generated.
- **Full-history quality checks:** long runs produce solver logs larger than 5 MB. The residual, phase-bound and time-step checks now stream the whole log instead of leaving those checks blank.

```sh
CFD_MEMORY=8g CFD_CPUS=4 npm run cfd
```

On PowerShell, set `$env:CFD_MEMORY="8g"` and `$env:CFD_CPUS="4"` before `npm run cfd`. Docker must also have sufficient assigned memory and disk space. The service defaults to a two-hour wall-clock job limit; `CFD_TIMEOUT_MS` can set a longer limit, up to 24 hours. A job that hits resource or time limits fails explicitly.

## What is implemented

- **Calm-water towing resistance:** a fixed hull at its hydrostatic draft, with an actual water/air `interFoam` solve. The outlet is the standard ship-resistance setup (outflow at the tow speed, water height following the flow) with a wake-wave absorber over the last two hull lengths, so the tank cannot drain or slosh. With the earlier fixed-pressure outlet, 14.7 s runs drifted to negative drag; with this outlet the drag is steady after about 5 hull lengths, and runs on 16 and 32 cores agree within 1%. Dimensional pressure and viscous forces are read from the solver; signed drag is −Fx with +X bow and incoming flow in −X.
- **Regular beam waves at zero forward speed:** native Stokes-I wave generation and absorption with constrained heave and roll using `sixDoFRigidBodyMotion`. Automatic runs use explicitly CAD-estimated inertia; manual measured inputs remain available. Other translations and rotations are constrained. The actual motion history is read with its recorded angle units.
- **Regular head-wave force at zero forward speed:** a fixed hull receives waves. This measures wave loading, not advancing-ship resistance.
- **Initialization from validated geometry:** clipped-triangle hydrostatics calculate displacement, draft, CB, waterplane inertia and GM. Automatic runs solve an initial dry roll/trim equilibrium for the prescribed mass and CAD CG, without changing the hull shape, scale or loading.
- **Separate actual CFD results:** Excel, JSON, case downloads, raw logs, source/condition hashes and matching-protocol refinement comparisons. Empirical preview readings never replace missing CFD data or enter a CFD result.

**Nonzero-speed waves plus towing current are rejected.** The pinned native Stokes-I boundary does not superpose the requested steady current. Implementing and validating a wave/current boundary is additional work; a plausible force number would not make an incorrect boundary accurate.

The wave cases use a **regular crest-to-trough height H**. The preview uses significant height Hs for an irregular sea. Reusing a numeric preset is not an equivalence between those experiments.

## Automatic test programme

The primary button sends only the selected, oriented STL and its name. The server builds the shared `standard-220-v1` protocol rather than reusing edited preview weights or solver fields. It detects a supported printed-wall hull, open exterior surface or closed exterior envelope, calculates CAD CG and the full mass-inertia tensor, and chooses the test settings.

Every design receives these **9 physical conditions**:

- **150 g, 250 g and 350 g total model masses**, each distributed over the declared CAD material or shell.
- **Calm towing at 0.30 m/s** in fresh water for each mass.
- **Medium and high regular beam waves at zero forward speed** for each mass. At 220 mm length, crest-to-trough H and period T are 7.3 mm / 0.45 s and 12 mm / 0.60 s. H scales with `L / 220 mm`; T scales with its square root. (Low waves were dropped: their response was too small to separate designs, and their 4 mm height needed the densest grids.) These are repeatable model-scale comparisons, not an irregular-sea equivalence or experimentally calibrated loads.

Automatic runs find a dry initial roll/trim pose using the prescribed mass and CAD CG, with a default search bound of **±20°** in each angle. The Newton solve requires balanced horizontal CB/CG positions and restoring behaviour. Flooded, overloaded, unstable or non-convergent starts are blocked; the code does not move CG or reduce the test mass to force a valid result. The original CAD shape is retained; any rigid initial pose and its transform are recorded. Subsequent wave motion remains constrained, not a continuing free trim/pitch equilibrium solve.

In **Full** mode, each selected condition gets three solves that check whether the Quick answer has converged. **Coarse** uses the Quick grid and numerics over the same calm window as Quick (40 hull lengths) or a longer wave window (25 periods, about 12 measured). **Medium** refines the grid by √2 in every direction; its value is the one reported. **Time-step** repeats coarse with the Courant limit and step cap halved. On a cluster all three start at once, and each job gets about 5000 cells per core (64–192 cores), so a larger mesh does not take proportionally longer. A check passes when the change is at most 5%: calm drag wanders about ±10% over 3-second blocks of the averaging window, so smaller changes cannot be told apart from noise.

Dropped in November 2026 from the earlier five-solve study: the **fine** grid (8–10 hours per wave test, which made Full an overnight job) and the **50% larger domain** (on the first measured Full study it moved calm drag by −27% to +22%, with the sign changing between loads, i.e. within the run's own drag wander). Tiny responses, missing channels and mismatched protocols are inconclusive, not passes. A failed or blocked condition is retained and the programme continues.

Full mode with all 9 tests means **up to 27 solves**, each with a default maximum budget of **5 million cells**. The default resources are not an assertion that 5 million cells will fit. Larger wave or thin-wall meshes may require a workstation with deliberately increased Docker resources. Memory, cell and time limits are enforced or fail explicitly; the service never substitutes an unresolved wave grid or estimated force. Locally (15 cores) the estimator predicts about 6 h for all 9 Quick tests of a 220 mm hull; Full is only practical on the cluster, where all tests and checks run at once (about 2–3 h per hull). Use Full on finalists or close calls.

**Stop tests** cancels the study and prevents further scheduled solves. Partial results remain downloadable. Recent local records can be reopened after refresh or restart; interrupted work is not silently resumed. The study Excel includes the per-condition results, numerical checks, source assumptions and solver metadata. JSON and individual solver-case ZIPs retain detailed evidence.

## CAD mass, CG and constrained inertia

The three automatic total masses are **imposed protocol values, not measured ship weights**. Every hull gets the same **competition load rule**:

- **50% of the test mass is a compact ballast weight** on the centreline. It sits lengthwise at the hull's volume centre, centred 10% of the hull depth above the lowest inside hull surface at that point.
- **The other 50% is spread uniformly** over the hull, using the distribution for its geometry type below. The deck is included where the CAD has one.

| Detected geometry | Spread half |
| --- | --- |
| Thin-wall printed boat | Uniform density in the actual wall material, inner and outer surfaces. Interior air and the virtual rim cap have no mass. |
| Open exterior surface | Uniform thin shell over the real surface. The virtual sealing deck has no mass. |
| Closed outer displacement hull | Uniform thin shell, including exported deck facets. |

The ballast is a point mass: its own small inertia is not modelled, and hull mass is not counted twice.

**Recorded outcomes, never skipped.** If a hull cannot float a test mass, the test is recorded as **Sinks**, with the largest mass the hull could carry. If it floats but is unstable upright (non-positive transverse GM) under the load rule, it is recorded as **Capsizes (stability failure)**. Both outcomes appear in the results table and Excel as results, not as errors.

STL geometry does not identify density differences, infill, batteries, equipment or cargo positions. No unseen component locations are invented. The CG, complete CAD inertia tensor, assumed distribution and imposed mass source remain labelled as **estimates**, including in the case, JSON and Excel. X is measured from the stern, Y from the centreline (+Y port), and Z above the keel in the original placed model frame; solver transforms are recorded separately.

Automatic wave motion permits vertical heave and rotation about the initial posed hull's longitudinal axis `a`, fixed in world coordinates. Its effective scalar roll inertia is **`Iroll = aᵀ I a`**, calculated from the full CAD tensor about the loaded CG, including products of inertia after the initial rigid pose. Reaction constraints suppress the other rotational degrees of freedom. This reduced model does **not** claim general coupled pitch/yaw motion or a fully free six-degree-of-freedom ship. Both the full tensor and its projection are recorded. Uniform-mass assumptions and unrepresented intrinsic inertia of added point loads remain limitations.

**Advanced settings** retain individual CFD tests, measured CG/inertia inputs and optional positioned ballast/equipment and cargo/luggage. Point masses are combined with the remaining hull mass, without double counting. Use those inputs when real measurements are available; they can improve the physical model beyond automatic uniform-CAD assumptions. A closed solid-body distribution is available only where it represents real material. Manual requests that claim measured values still require their measurement confirmation.

## Geometry and flooding

The displayed CAD remains the imported surface. CFD preflight distinguishes:

1. **Closed outer envelope:** a watertight, consistently oriented exterior displacement hull.
2. **Printed shell:** a watertight solid describing the actual printed walls and an open cavity, with a supported planar rim. An outer dry envelope is reconstructed for initialization only; the solver meshes the actual inner and outer wall surfaces. `setFields` starts the interior dry. The real opening remains available for later water entry.
3. **Open exterior surface:** a planar rim is virtually capped. Here the solver also sees the virtual cap as a wall, so it cannot represent real open-boat flooding. That assumption is recorded explicitly.

In the **automatic competition programme**, a printed-wall hull is meshed for CFD as its sealed outer envelope (the walls capped at the rim). This keeps thin walls from multiplying the cell count; the mass still uses the real wall material. Water coming over the rim is flagged instead (see *Rim immersion* below). Advanced manual cases can still mesh the actual printed walls.

### Automatic CAD clean-up (any competition STL)

Entries can be any shape that fits the **250 × 250 × 250 mm** build volume, with up to **500,000 triangles**. Before planning, the server cleans up every uploaded STL and lists each change in the plan notes and the results:

- **Units:** millimetres are assumed. A file whose longest side is 8–25 mm is treated as centimetres, and one whose longest side is 0.08–0.25 is treated as metres. Inches are not guessed. The unit can be overridden in the app.
- **Orientation:** the deck faces up and the bow lies along X. Y-up CAD exports are rotated automatically.
- **Cleaning:** vertices are welded, zero-area and duplicated triangles are removed, and mixed or inside-out normals are re-oriented.
- **Small holes:** holes with a perimeter under 12% of (length + beam + depth) are closed. Larger openings are treated as the open top.
- **Multi-body exports:** catamarans, trimarans, and hulls with separate cabins, keels or overlapping parts are merged by exact boolean union (manifold-3d). Overlap is not double counted. Sealed internal air pockets count as displacement.
- **Sloping rims and top openings** (sheer lines, open cockpits): the hull is trimmed at the lowest point where water could come in, because that is the real freeboard.
- **Boolean output:** snapped to a 1 µm grid so that the solver's own watertightness check accepts it.

Shapes that still cannot be made into a valid hull are rejected with a plain-language reason. Examples are a lone open sheet with branching edges, and a hull larger than the build volume. OpenFOAM `surfaceCheck` provides an additional self-intersection inspection. Browser preflight does not certify every possible mesh intersection.

For printed walls, automatic mode samples inward-normal distances to opposing near-parallel surfaces and uses 80% of the least sampled thickness as a conservative resolution length. This is a sampled hint, **not a certified global minimum**: thin details between samples can be missed. Too few or ambiguous samples block automatic meshing. Advanced mode can use a verified minimum wall thickness. Requested refinement spans the declared length by at least three cells; a case beyond its budget is rejected rather than silently erasing the wall. Inspect actual wall cells and refinement logs before trusting resolution.

## Physics and numerical limits

`interFoam` solves transient, incompressible, immiscible water/air flow with VOF interface transport, gravity and surface tension. Water density is 998 kg/m³, kinematic viscosity 1.004×10⁻⁶ m²/s, and surface tension 0.072 N/m. The initial model uses laminar flow and an implicit 90° wetting assumption. Transition, printed roughness, contact angle and near-wall viscous resolution need sensitivity checks or physical measurements. The starter has no automatically generated prism layers; converge the wall mesh or add and validate layers before treating friction as resolved.

The initial domain uses 2 hull lengths upstream, 5 downstream, 3 to either side and 3 below the keel, with an air region. These are starting clearances, not a guarantee of boundary independence. `domainScale` enlarges them while retaining near-hull refinement controls.

Wave cases replace the coarse background with a three-block graded grid around the free surface. Coarse requests six cells per height and thirty per wavelength; medium eight/sixty; fine twelve/ninety, plus transverse hull resolution. These are starting levels for convergence studies, not validated universal criteria. The budget must cover the background plus hull refinement; weak model-scale waves may require many millions of cells. Native absorption also requires empty-tank gauge and reflection checks.

**Rim immersion.** For beam-wave runs, the result reports whether the deck edge could dip under. The check is roll × half-beam + heave amplitude + wave amplitude ≥ freeboard. Hulls where this happens are flagged **may swamp**. It appears in the results table and in Excel as the rim-dip margin.

Adaptive time stepping respects prescribed Courant controls. Force averages are time-weighted, use the post-startup final half, require at least twenty samples, and report temporal variation and split-window drift. Standard deviation is not a confidence interval for correlated samples. Vertical fluid force includes dynamic pressure/viscous effects and must not be labelled pure buoyancy.

## Checks before accepting a result

The run stops if surface/meshing commands or mandatory topology and `meshQualityDict` safety limits fail. A separate `checkMesh -allGeometry` report is retained. Additional concave-cell diagnostics can require review even when mandatory face/volume safety limits pass; they remain visible in the result and prevent a complete numerical-review status.

Every CFD result remains **unverified and not eligible for automatic placement** until the following are established:

- Achieved hull, wall, waterline and propagation resolution; positive cell volumes and acceptable quality throughout motion.
- Final-time completion, finite residuals, phase bounds, conservation/flux balance and settled histories.
- Coarse/medium mesh and smaller time-step studies under the same physical protocol (the domain size is fixed by the protocol).
- For waves, measured incident H/T and reflected-wave sensitivity using empty-tank gauges before interpreting hull response.
- Agreement and uncertainty relative to repeatable tow/wave-tank measurements or independently validated reference cases.

The service records physical geometry and protocol hashes. Different mass/CG, CG source or distribution, added masses/positions, speed, waves, observation duration or domain do not compare as one protocol. Mesh/time changes retain matching physical identifiers. Matching hashes or a stable average do not establish convergence or physical accuracy.

## Verification performed here

See `verification/` in the distribution for real solver logs and summaries.

- A real v2312 calm-water smoke used a 200×60×40 mm box and **131,396 cells**, reached **0.01 s**, and wrote **56 dimensional force samples** with normal solver completion. Mandatory mesh safety and phase bounds passed. The short force history was not settled, and detailed cell-concavity diagnostics remained. This is a functional smoke test, not a drag benchmark.
- A real native Stokes-I plus six-DoF startup smoke executed **0.0004 s**, initialized both wave boundaries, coupled prescribed-inertia heave/roll, and wrote unit-labelled motion output. It deliberately reused the small calm mesh and ended before wave travel/startup. It verifies dictionaries and coupling, not a resolved wave experiment.
- The isolated original-source audit ran 100 acceptance checks (74 pass, 26 fail) and another 100 simulation scenarios. That report describes the original uploaded version; it does not claim those failures are all corrected here.

The earlier v1.1 OpenFOAM release passed 112 automated checks and four server-result tests. The historical v1.2 version passed 152 automated checks plus four server-result tests, covering mass-property calculations, payload weighting, input rejection and estimated-versus-measured provenance. The current v1.3 version adds automatic programme, geometry/wall inference, dry initial equilibrium, constrained inertia, numerical-study orchestration and export checks; 209 automated checks and 19 Node server checks passed. Version 1.5 adds the competition load rule, automatic CAD clean-up for any STL inside 250 × 250 × 250 mm, printed-shell sealing for CFD, rim immersion flags, the consistent mesh gate, and faster planning; 224 automated checks and 29 Node server checks pass. See `verification/any-stl-robustness/` for the STL corpus and the real meshing results. These software checks do not validate a physical hull's mass distribution or hydrodynamic accuracy.

Automated checks:

```sh
npm test
npm run typecheck
npm run build:cfd
npm run test:server
npm run build
```

Browser visual interaction was not available in this environment. Local HTTP status, input rejection and cross-origin checks were exercised. No experimental accuracy percentage is claimed.
