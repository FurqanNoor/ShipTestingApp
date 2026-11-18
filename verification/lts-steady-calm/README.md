# Steady-state calm towing (local time stepping): tested and rejected for ranking

**Date:** 18 November 2026, CSC Roihu, OpenFOAM v2312.

**Idea.** OpenFOAM's DTCHull resistance tutorial solves calm-water towing as a pseudo-steady problem: `ddtSchemes localEuler`, so each cell advances at its own stable step. This needs far fewer solver steps than a time-accurate tow.

**Method.** `lts-setup.sh` copies a finished Quick (coarse, transient) calm case, keeps its mesh and initial fields, and switches it to local time stepping:
- `momentumPredictor no`, `nCorrectors 2`, `rDeltaTSmoothingCoeff 0.05`, `rDeltaTDampingCoeff 0.5`;
- 64 cores;
- drag is the mean of −Fx over the last 60% of iterations, the same window as the transient reader.

**Settings, on 01 Deep V at 350 g** (transient 16.32 mN by the same script; 930 s solve):

| Variant | maxCo / maxAlphaCo | Iterations | Solve | Drag | Change |
|---|---|---|---|---|---|
| A (tutorial) | 10 / 5 | 4000 | 130 s | +2.2 mN (wrong sign) | unusable |
| B | 2 / 1 | 4000 | 137 s | 13.87 | −15% |
| C | 1 / 0.5 | 8000 | 215 s | 15.15 | −7% |
| D | 1 / 0.25 | 8000 | 273 s | 16.07 | −1.5% |
| E | 2 / 0.5 | 10000 | 252 s | 15.66 | −4% (still drifting) |

**Variant D on other hulls** (reference = the app's transient Quick drag):

| Case | Transient (mN) | Steady D (mN) | Change |
|---|---|---|---|
| 01 Deep V 350 g | 16.27 | 16.07 | −1.2% |
| 02 Wide flat scow 350 g | 34.83 | 33.76 | −3.1% |
| 03 Displacement canoe 250 g | 10.53 | 9.80 | −6.9% |
| 07 Hydrofoil V 250 g | 84.61 | 85.58 | +1.1% |
| 10 Wave-piercing axe bow 150 g | 4.00 | 3.03 | −24% |

**Verdict.** About 3× faster (≈4.5 min against ≈15 min of solving), but the bias depends on the hull, from +1% to −24%, and is largest for low-drag hulls. Drag also swings ±15% between 500-iteration blocks. It would reorder the ranking, so it is **not used**. The viscous component agreed closely wherever it was compared; the error is in the pressure (wave-making) part, which is sensitive to interface sharpness.
