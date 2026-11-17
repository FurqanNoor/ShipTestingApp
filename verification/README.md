# Verification evidence

Fixtures use prescribed synthetic CAD geometry and mass properties; they are not physical measurements of a team design. No experimental force or wave data were supplied.

- Current v1.3 automated checks cover the shared 12-condition programme, inferred geometry and sampled wall resolution, dry initial roll/trim, CAD full-tensor and reduced roll inertia, bounded study scheduling/cancellation, numerical comparisons and partial exports. `automatic-tests.txt` records 209 passing Vitest checks; `automatic-server-tests.txt` records 19 passing Node checks. These checks do not represent 60 physically validated CFD predictions.
- `automatic-inertia-native/`: genuine v2312 startup at 0.0004 s verifies the full-tensor constrained-roll handoff about a tilted hull axis and preserves initial CAD pose. It reuses a calm mesh and does not validate hydrodynamic accuracy.
- `automatic-http-preflight.json`: actual HTTP study creation, twelve overloaded conditions blocked without a solve, JSON download, cross-origin rejection and corrected native motion parsing.
- `cg-automated-tests.txt`: historical v1.2 suite, 152 passing Vitest checks, including 40 new analytical mass-property, CG provenance and UI/export checks. `cg-server-tests.txt`: four passing Node result-reader checks.
- `cg-preflight.mjs` and `cg-preflight.json`: the built service core recomputes the supplied binary sample STL with a positioned cargo mass, records estimated CG in the generated OpenFOAM load, and preserves its assumptions. No native solver is launched by this check. Run after `npm run build:cfd` with `node verification/cg-preflight.mjs`.
- `automated-tests.txt`: historical v1.1 suite, 112 passing Vitest checks, including retained preview regressions, exact mesh hydrostatics, geometry preprocessing, CFD dictionaries, dimensional output parsing, physical-input validation and scoring safeguards.
- Four additional Node tests exercise the result reader and unavailable/failed quality states.
- `smoke-calm-001/`: genuine OpenCFD v2312 logs, dimensional force history and mesh reports for a 131,396-cell box. End time 0.01 s. This is a short functional smoke; the force was not settled and detailed geometry diagnostics remain unresolved.
- `smoke-beam-001/`: native Stokes-I wave boundary and six-DoF coupling startup, with recorded motion at 0.0002 and 0.0004 s. See `smoke-override.json`: this deliberately reuses a small calm mesh, does not run the production wave grid, and ends before wave travel/startup. It cannot establish wave amplitude or roll accuracy.
- `http-end-to-end/`: another real calm job submitted to the local HTTP service, completed through Docker, parsed, restored after service restart and downloaded through the case ZIP API. Mandatory safety checks pass; detailed geometry and force stationarity remain unresolved. `rankable` stays false.

The one-click programme uses imposed 150/250/350 g total loads and uniform CAD mass assumptions. CG and inertia remain estimated, not measured. Its up to 60 serial solves and sensitivity thresholds cannot establish real hydrodynamic accuracy; unsuitable or resource-limited conditions remain blocked/failed in the record.

The original 100-case audit applies to the untouched uploaded version, not this modified implementation. Its separate report and ledger are under `public/downloads/`. The previous hosted application was not integrated.

A successful run, finite residuals or a test pass rate is not a physical accuracy percentage. Converge mesh, wall resolution, time step and domain; verify wave propagation/reflection; then calibrate representative designs against repeatable physical data before using placements.
