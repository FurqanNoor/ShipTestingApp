# Wave-maker recalibration in 3D hull runs (18 November 2026, CSC Roihu)

**Problem.** Beam-wave results showed "wave achieved" of 112–186% of the target height. There were three causes:

1. **Gauge placement.** The two gauges stood λ/4 and λ/2 from the hull *centre*.
   - On the 208 mm SWATH, the near gauge lay inside the hull. That gauge line through the moving hull also hung interFoam at the same step (t ≈ 2.09 s) in three 350 g medium-wave runs.
   - Beside narrow hulls, the near gauge sat in the hull's near field.
   - The plain mean of the two gauges included the hull's reflected and radiated wave.
2. **Gain.** The quick-grid gains (1/0.74, 1/0.79) came from 2D empty tanks. In 3D the incident wave was 12–17% high.
3. **Re-reflection.** Waves the hull sent back were only partly absorbed by the generation zone, so strongly reflecting hulls received a larger incoming wave.

**Measurement fix.**
- Four gauges at 0.2, 0.275, 0.35 and 0.425 wavelengths up-wave of the hull's side.
- Least-squares incident/reflected separation (Goda & Suzuki, extended to N gauges), in `server/result-reader.mjs` (`separateIncidentWave`).
- Unit test: a synthetic 10 mm wave with 40% reflection is recovered exactly, while the plain gauge mean reads 12.5 mm.

**Experiments.** All at 250 g, Quick coarse grid, 96 cores. "Incident" is the separated incoming wave height divided by the target; Kr is the reflection coefficient.

| Setup | 01 Deep V medium | 01 Deep V high | 04 Catamaran medium | 04 Catamaran high | 09 SWATH medium | 09 SWATH high |
|---|---|---|---|---|---|---|
| Old gain, zone 1λ, strength 5 | 1.33 (Kr 0.99) | 1.17 | 1.17 (Kr 0.22) | 1.12 | 1.23 (Kr 0.23) | 1.13 |
| Gain ×0.885, zone 1λ, strength 5 | 1.19 | 1.04 | | | | |
| Gain ×0.885, zone 2λ, strength 5 | 1.12 | 1.01 | 1.01 | 0.97 | | |
| **Gain ×0.885, zone 1λ, strength 12** | **1.13** | **1.02** | | | | |

The SWATH 350 g medium-wave case also finished with the new gauges (Kr 0.60); it had hung three times before.

**Adopted (waves protocol 2026-11-19).**
- GEN_STRENGTH 12. It gives the same improvement as a 2λ zone, which would add 21% more cells.
- Quick gains: medium 1/0.861, high 1/0.910.
- Expected incident height: about 1.00–1.03× target for low-reflection hulls, up to about 1.13× for a hull rolling near resonance (the Deep V rolls 11° in medium waves and sends back as much wave as it receives).
- Every run reports its incident ratio and reflection coefficient, and flags deviations beyond ±10%.
