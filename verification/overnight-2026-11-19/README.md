# Hull tests, 18–19 November 2026: final ranking, fixes and open issues

- **Hulls:** all 10 hulls in `Ships/`, excluding `ShipDesign.stl`.
- **Cluster:** CSC Roihu.
- **Setup versions:** calm 2026-11-19c, waves 2026-11-19.
- **Compute:** about 32,300 core-hours from 18:30 on 18 November (budget 35,000).
- **State:** everything below is committed on `main`; nothing is pushed.

## Final ranking (Quick, all 9 tests per hull, no failures)

Score = mean of drag, roll and stability points. The best hull in each category gets 100 points and the rest get points in proportion.

| # | Hull | Calm drag, mean of 3 loads (pts) | Max roll in waves, mean of 6 (pts) | GM (pts) | Score |
|---|---|---|---|---|---|
| 1 | 04 Twin-hull catamaran | 8.23 mN (81) | 3.3° (99) | 375 mm (100) | **93.5** |
| 2 | 05 Three-hull trimaran | 8.32 mN (80) | 3.3° (100) | 337 mm (90) | **90.0** |
| 3 | 09 SWATH twin pod | 8.85 mN (76) | 4.0° (82) | 375 mm (100) | **85.8** |
| 4 | 06 Single outrigger proa | 8.55 mN (78) | 3.7° (88) | 253 mm (68) | 77.9 |
| 5 | 02 Wide flat scow | 22.95 mN (29) | 3.5° (94) | 263 mm (70) | 64.5 |
| 6 | 08 Hydrofoil catamaran | 89.36 mN (8) | 3.9° (84) | 303 mm (81) | 57.3 |
| 7 | 03 Displacement canoe | 6.68 mN (100) | 11.8° (28) | 47 mm (13) | 46.7 |
| 8 | 01 Deep-V monohull | 9.59 mN (70) | 12.7° (26) | 40 mm (11) | 35.3 |
| 9 | 07 Hydrofoil V monohull | 97.02 mN (7) | 3.7° (89) | 27 mm (7) | 34.4 |
| 10 | 10 Wave-piercing axe bow | 9.07 mN (74) | 14.6° (22) | 23 mm (6) | 34.1 |

**How to read it:**

- **Places 1–2:** 04 and 05 tie on drag (8.23 against 8.32 mN, well inside the mesh uncertainty below) and on roll. 04 leads on initial stability, GM 375 against 337 mm. GM is a hydrostatic number, not a noisy CFD one, so the order 04 > 05 is robust.
- **Places 1–6:** these are multi-hulls, or a scow and an outrigger. Their roll is 3–4° and their GM is 250–375 mm.
- **Places 7, 8 and 10:** the monohulls 03, 01 and 10 have the lowest drag but roll 12–15° and have GM below 50 mm.
- **Hydrofoils (07, 08):**
  - Their drag is 10× that of every other hull. At the 0.30 m/s towing speed the foils lift only about 5% of the weight, because lift scales with speed squared, so the foils and struts are pure drag.
  - The hulls are held at static draft, as agreed, so they cannot rise onto the foils.
- **Previous ranking:** the overnight ranking (05, 04, 09, 02, 06, …) used calm drag from the faulty setup below. That ranking is superseded.

### Calm drag per load (medium mesh, isoAdvector)

Each cell shows total drag, then pressure drag in brackets, then lift as a share of the hull's weight.

| Hull | 150 g | 250 g | 350 g |
|---|---|---|---|
| 01 | 3.47 (1.3) 97% | 8.69 (5.7) 97% | 16.61 (13.1) 96% |
| 02 | 13.74 (11.4) 92% | 21.55 (19.2) 93% | 33.55 (31.1) 94% |
| 03 | 4.18 (1.6) 97% | 6.30 (3.2) 97% | 9.56 (5.9) 97% |
| 04 | 4.71 (1.1) 98% | 6.69 (2.9) 98% | 13.31 (8.4) 97% |
| 05 | 4.83 (0.7) 97% | 7.05 (2.1) 97% | 13.07 (6.7) 96% |
| 06 | 5.22 (1.7) 97% | 8.23 (4.0) 96% | 12.21 (7.0) 96% |
| 07 | 92.46 (85.7) 92% | 91.40 (83.7) 93% | 107.19 (100.0) 94% |
| 08 | 85.40 (77.1) 95% | 86.93 (77.9) 95% | 95.74 (86.5) 95% |
| 09 | 5.44 (2.1) 98% | 8.36 (4.7) 98% | 12.74 (7.8) 97% |
| 10 | 3.46 (1.5) 98% | 6.53 (3.9) 97% | 17.22 (13.8) 97% |

- **Pressure drag is positive on every run.** It was negative on slender hulls before the fixes.
- **Lift is 92–98% of the weight.** That fits a hull held at its static draft while towed, which feels slight suction (sinkage).

## Full checks: 04, 05 and 09

Wave tests reuse the Quick runs. Every wave test passes every check:

- complete solver history;
- bounded phase fraction;
- stationary RMS roll;
- incident wave 0.90–1.18× the target height.

Calm drag in mN on the coarse mesh, the medium mesh, and the coarse mesh with half the time step:

| Hull, load | Coarse | Medium (reported) | Half time step | Mesh change | Time-step change |
|---|---|---|---|---|---|
| 04, 150 g | 3.29 | 4.71 | 3.31 | 30% | 1% |
| 04, 250 g | 6.91 | 6.69 | 6.62 | 3% | 4% |
| 04, 350 g | 10.88 | 13.31 | 12.42 | 18% | 12% |
| 05, 150 g | 3.07 | 4.83 | 2.97 | 36% | 3% |
| 05, 250 g | 9.71 | 7.05 | 9.29 | 27% | 4% |
| 05, 350 g | 14.86 | 13.07 | 13.01 | 12% | 12% |
| 09, 150 g | 3.24 | 5.44 | 3.09 | 40% | 5% |
| 09, 250 g | 6.33 | 8.36 | 5.73 | 24% | 9% |
| 09, 350 g | 13.08 | 12.74 | stopped | 3% | — |

09's 350 g half-time-step run was stopped at 21:26 with the 06 and 07 Full studies started from the app at 21:22. All other runs had finished.

**What this says:**

- **The time step is not the issue:** halving it changes drag by 1–4%, and by 12% at 350 g.
- **The mesh dominates the uncertainty:** 3–40% between the coarse and medium meshes, with no consistent sign. Calm drag can therefore separate hulls only when it differs by more than about 30%:
  - 04, 05, 06, 09 and 03 are one group, at 6.7–8.9 mN;
  - 02 is clearly higher;
  - 07 and 08 are far higher.

  This is why the score is mostly decided by roll and GM among the top hulls.

## What was fixed (all on `main`)

### Calm towing tank (today; protocol 2026-11-19c)

All evidence is in `verification/calm-wall-creep/`.

1. **The tank started too full.**
   - **Cause:** the background grid had no cell face at the still waterline, and `setFields` fills whole cells. The water therefore started 0–7 mm high, depending on the hull's size, and hulls floated deeper than their weight.
   - **Fix:** the domain now puts a face exactly at z = 0.
2. **The interface crept up the hull wall.**
   - **Cause:** the MULES interface scheme let the water–air interface smear several millimetres up the hull wall during every run. On these 20 mm drafts that meant about 1 mm of extra water level at the hull, +0.27 N of lift, and a forward push that made slender hulls' pressure drag negative.
   - **What was ruled out:** a tank slope, the outlet absorber, surface tension and mesh resolution.
   - **Fix:** calm tests now use geometric VOF (isoAdvector, `interIsoFoam`). The wall stays dry above 5 mm, and drag is positive and steady. Wave tests keep MULES.
3. **Cost of the fix:** isoAdvector takes about 2.5× longer per simulated second. A Quick calm test now takes 2.5–5 h. Up to 30 run at once on the cluster, so a full set of 10 hulls finishes in an afternoon.

### Cluster and app (today)

- **Cores:** medium meshes get cores by cell count (about 5,000 cells per core, so 64 cores), not a fixed 192. At about 1,000 cells per core, 192 cores cost three times the core-hours and gave no speed.
- **Time estimates:**
  - isoAdvector runs have their own estimator key.
  - The estimator no longer credits cores beyond about 2,000 cells each.
  - Slurm limits are 2× the prediction + 45 min.
- **Downloads:**
  - Results now download compressed: 17 s instead of more than 15 min for a run with a 330 MB solver log.
  - The duplicate `service-runner.log` is no longer downloaded.
  - Four large uncompressed downloads at once never finished before this fix.
- **Larger force histories:** the result reader accepts force histories up to 1,000,000 samples (was 250,000). Long isoAdvector runs exceed the old limit.
- **Reuse in every study:** identical runs are reused in every study, not only Full, and re-read with the current reader.
- **Folder cleanup after cancelling:** a cancelled job's cluster folder is removed even if the app restarts within the minute. Two quick restarts had left 50 folders behind; they were removed.
- **Start-up check:** studies submitted right after start-up wait for the cluster check instead of being refused with "Start Docker".
- **Provisional rankings:** both ranking tables say when only some hulls have finished. With 2 of 10 done, hull 10 had looked like the winner.

### Overnight (18–19 November)

**Waves**
- Gauges stand beside the hull's side, not at its centre. A gauge line through the moving SWATH hull hung interFoam.
- The reported wave is the incident wave, separated from the hull's reflection by a least-squares fit over several gauges.
- The wave-maker was recalibrated in 3D. A strongly rolling hull no longer gets a 33% bigger wave.

**Calm**
- Quick calm tests use the medium mesh. The coarse mesh read −49% to +44% off it.

**Full mode**
- Wave tests run once; a half-time-step copy changed roll by only 0.4–1.8%.
- Identical runs are reused, so Full adds only the coarse and half-time-step calm runs.

**Reliability**
- Unstable hull-motion coupling is retried automatically with stronger stabilisation.
- Run folders are deleted from Roihu after download, which keeps scratch under its 500,000-file quota.
- Slurm time limits follow the predicted run time.
- Quality thresholds are ones a good run can pass.
- A failed study save on Windows (EPERM) is retried.

**UI**
- Tables are aligned, and long names wrap.
- Drag is shown in mN.
- Failed checks are named.
- Both leaderboards are on the main page.
- Tested hulls come back after a reload.

**Data**
- Old results were archived to `cfd-runs/archive-2026-11-18`.

## Tested and rejected

- **Steady-state calm towing (LTS):** about 3× faster, but a hull-dependent bias of −24% to +1% (`verification/lts-steady-calm`).
- **Surface tension off:** less noise, but it shifted drag by up to −37% and did not cure the wall creep.
- **Finer cells at the hull wall with MULES:** the creep continued (`verification/calm-wall-creep`).
- **A longer wave-generation zone:** no better than a stronger relaxation, and 21% more cells.

## Open issues and decisions for you

1. **Calm mesh uncertainty of 10–36%.** A fine-mesh calm check would settle it but costs several hours per hull with isoAdvector. Until then, treat calm-drag differences under about 30% as ties.
2. **Scoring.** Drag points are proportional to the single lowest drag (03 at 6.68 mN), so one uncertain number moves every hull's drag points. Points normalised to the median, or rank points, would be steadier. Not changed: this is your call.
3. **Test speed and hydrofoils.** All calm tests tow at 0.30 m/s, where foils cannot lift. If the challenge is about speed, add a faster calm test (and free heave/trim) so that 07 and 08 are judged on what they are built for.
4. **Not modelled:**
   - **Wind:** the air drag of the dry hull at towing speed is included, about 0.3 mN. A real wind is not.
   - **Forward speed in waves:** wave tests have the hull at zero forward speed, in beam seas.
5. **Shorter calm runs.** Done: calm protocol 2026-11-20 (see below).
6. **Solver log size.** Done with calm protocol 2026-11-20: the force sums are no longer printed to the solver log.
7. **Keep the PC awake while tests run.** On 19 November the PC lost its network at about 14:55, and the SSH certificate then expired at 18:50. The jobs finished on Roihu and were downloaded after the certificate was renewed, with nothing lost, but results arrived four hours late.

## Hackathon setup (night 19–20 November)

### Calm protocol 2026-11-20: about 30% faster

- **Change:** tow for 28 hull lengths per speed (was 40), at least 17 s, and average over the second half (was the last 60%). Force sums are no longer printed to the log.
- **Evidence:** cutting the 30 finished 40-length calm runs back to 28 lengths changed the drag by 1.5% on average and 5.7% at most. Shorter cuts were rejected: 60% of the length changed drag by up to 14%.
- **End-to-end check:** hull 04, all 9 Quick tests, run from a fresh app folder and a fresh Roihu folder. It took 3 h 06 min from submission to the last download, including the queue.

  | Load | Calm drag, 2026-11-20 | Reference (19c, 40 lengths) | Change |
  |---|---|---|---|
  | 150 g | 4.75 mN | 4.71 mN | +0.8% |
  | 250 g | 7.07 mN | 6.69 mN | +5.7% |
  | 350 g | 12.74 mN | 13.31 mN | −4.3% |

  All six wave tests completed (max roll 3.0–4.0°).
- **Split-half drift check:** hull 04's 350 g run drifts 13.7% between the two halves of its averaging window, so it shows *Check failed: Completed numerical quality*. The 40-length reference run of the same hull and load drifted 8.6% and failed the same 5% check, as did many runs of the 01–10 ranking. The check only labels the result for review; the hull is still ranked.

### Multiple judges

- Each judge uses their own computer and CSC account ([JUDGES.md](../../JUDGES.md)). The Roihu folder fills itself in from the project and username.
- **Export results / Import results** under the OpenFOAM ranking combine everyone's tests into one ranking.
- **Slurm time limits** are at least 3 h, because the estimator under-predicted wave runs (42–102 min at 96 cores).

### Leaderboard fixes found in the end-to-end check

- **The reference settings are chosen by finished results.** Before, cancelled and empty studies counted too. The cancelled Full studies of hulls 11–20 outvoted the Quick runs, and the ranking switched to Full settings.
- **Outdated calm tests stay in the test programme.** Before, with most hulls holding only older calm results, calm drag silently dropped out of the ranking. Now those hulls show *Re-run with the current solver setup: 150g-calm, 250g-calm, 350g-calm*.

### Old results

- **Archive:** the results for hulls 01–20 are in `cfd-runs/archive-2026-11-19/studies`, and exported to `hull-results-01-20-reference-2026-11-19.json` on the Desktop.
- **Calm protocol:** their calm tests use protocol 19c. After an import, their wave results count, but their calm tests show *re-run* under the 2026-11-20 setup.
