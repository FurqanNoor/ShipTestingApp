# Overnight run, 18–19 November 2026: results, fixes and open issues

All 10 hulls in `Ships/` were tested, `ShipDesign.stl` excluded. Runs used CSC Roihu, setup version calm 2026-11-19 / waves 2026-11-19. Compute: about 17,000 core-hours from 18:30 (budget 35,000).

## Ranking (Quick: 9 tests per hull, all completed)

Score = average of drag, roll and stability points, one third each. The best hull in each category gets 100 points and the rest in proportion.

| # | Hull | Calm drag (mean of 3 loads) | Max roll in waves (mean of 6) | GM (mean) | Score |
|---|---|---|---|---|---|
| 1 | 05 Three-hull trimaran | 18.9 mN | 3.3° | 337 mm | 70.3 |
| 2 | 04 Twin-hull catamaran | 42.9 mN | 3.3° | 375 mm | 69.5 |
| 3 | 09 SWATH twin pod | 38.1 mN | 4.0° | 375 mm | 64.1 |
| 4 | 02 Wide flat scow | 23.4 mN | 3.5° | 263 mm | 60.4 |
| 5 | 06 Single outrigger proa | 21.9 mN | 3.7° | 253 mm | 57.9 |
| 6 | 08 Hydrofoil catamaran | 108.2 mN | 3.9° | 303 mm | 56.0 |
| 7 | 10 Wave-piercing axe bow | 4.0 mN | 14.6° | 24 mm | 42.9 |
| 8 | 03 Displacement canoe | 5.9 mN | 11.8° | 47 mm | 35.8 |
| 9 | 01 Deep-V monohull | 5.7 mN | 12.7° | 40 mm | 35.4 |
| 10 | 07 Hydrofoil V monohull | 87.1 mN | 3.7° | 27 mm | 33.6 |

**Places 1 and 2 are a tie within the numerical uncertainty.**
- The drag score is normalised to the lowest-drag hull (10, 4.0 mN), and that is the least reliable drag value (see below).
- With 2 mN for hull 10, hull 04 ranks first; with 4–8 mN, hull 05 does.
- The multi-hulls lead mainly through stability: their GM is 6–15× that of the monohulls.

## Full checks on the top hulls (05, 04, 09, 02)

**Wave tests:** every wave test passes every check:
- complete solver history;
- bounded phase fraction;
- stationary RMS roll;
- incoming wave 0.90–1.18× the target height, after separating out the hull's reflection.

**Calm drag:** the finer mesh changes drag by 6–15% (05), 9–26% (04), 9–42% (09) and up to 34% (02). Half the time step changes it by 5–19%. Calm drag carries about 10–40% numerical uncertainty, largest for twin hulls and flat bottoms.

## What was fixed tonight (19 commits on `main`, not pushed)

**Waves**
- Gauges now stand beside the hull's side, not at the hull centre. On the SWATH the old near gauge was inside the hull, and its line through the moving hull hung interFoam three times.
- The reported wave is the incident wave, separated from the hull's reflection with a multi-gauge least-squares method. It was a plain gauge mean before, which read 112–186%.
- Wave-maker recalibrated in 3D: gains 1/0.861 (medium) and 1/0.910 (high), relaxation strength 12. A strongly rolling hull no longer gets a 33% bigger wave. Evidence: `verification/wave-maker-2026-11-18`.

**Calm**
- Quick calm runs on the medium mesh. The coarse mesh read drag −49% to +44% off it.

**Full mode, now about 1 hour per hull**
- Wave tests run once, as in Quick. The half-time-step copy changed roll by only 0.4–1.8%.
- Calm keeps three solves.
- Identical runs are reused: generated case files are fingerprinted byte for byte. Full for a top hull then adds only the three calm half-time-step runs.

**Reliability**
- Light, wide, flat hulls (02 at 150/250 g) blew up the hull-motion coupling. Such runs now retry automatically, escalating up to relaxation 0.1, 5 outer correctors and Courant 0.5. All scow wave tests finished.
- Roihu's scratch file quota (500,000 files) filled up and every run failed. The app now deletes each run's cluster folder after downloading its results; 287 old folders were removed.
- Slurm time limits follow the predicted run time (2× + 45 min) instead of a flat 24 h. 192-core jobs then started within the hour instead of at 07:00.
- Quality checks that a good run can pass:
  - phase-fraction bounds of 0.1% (calm) and 1% (waves);
  - force drift of 5%;
  - snappy's concave cells and a few skew faces accepted.
  Before this, Full could never pass.
- A study save that failed on Windows (EPERM on rename) is now retried.
- The time estimator keeps calibration per mesh level, so medium and fine runs get enough cores.

**User interface**
- Pop-up tables are aligned: the ranking, the test grid and the results table.
- Long file names wrap.
- Resistance is shown in mN.
- The review column names the failed check, e.g. "Mesh sensitivity 33% (limit 5%)".
- Both leaderboards (instant estimate and OpenFOAM) are on the main page.
- Hulls with tests come back in the workbench after a reload.

**Data**
- Old results were archived to `cfd-runs/archive-2026-11-18`, so the leaderboards started empty.

## Tested and rejected

- **Steady-state calm towing (LTS):** about 3× faster, but a hull-dependent bias of −24% to +1%. See `verification/lts-steady-calm`.
- **Surface tension off:** 15–30% less noise and about 20% faster, but it shifted the trimaran's drag by −37% and did not fix the slender-hull problem below.
- **Longer generation zone (2 wavelengths):** as effective as a stronger relaxation, but 21% more cells.

## Open issues, most important first

1. **Calm drag of slender, low-drag hulls (01, 03, 10 at light loads) was biased low, with negative pressure drag.** Investigated on hull 10 at 150 g; see "Calm-tank investigation" below. Two causes were found:
   - **Fixed:** the tank started too full. The background grid had no cell face at z = 0, and `setFields` fills whole cells, so the water started 0–7 mm high, depending on the hull's size. Calm protocol 2026-11-19b puts a face exactly at the waterline, and every calm test is re-run with it.
   - **Remaining:** the water–air interface creeps up the hull walls. It is smeared over several 2–4 mm cells, and the wet fraction on the wall rises over the first ~10 s of every run. The hull then feels about 1 mm of extra water level: about +0.27 N of lift, and a forward push of a few mN on fine bows and sterns. A 64-second tow showed it is persistent, not a start-up transient.
2. **Vertical force above the hull's weight.** At the start this was the tank-fill error, now fixed: the run starts at 1.49 N against a weight of 1.47 N. During the run the wall creep adds about 0.27 N on hull 10, so it is not yet the right weight.
3. **Calm-drag mesh convergence:** 10–40% between the coarse and medium meshes on multi-hulls. Ranking on calm drag can only separate hulls whose drag differs by more than about 30%.
4. **Scoring robustness:** drag points are proportional to the single lowest drag, the least reliable number. Normalising to the median drag, or using rank points, would make the ranking stable. Not changed: it needs your decision.
5. **Hydrofoils (07, 08):** held at static draft in calm water, so they cannot rise onto their foils. Documented only, at your request.
