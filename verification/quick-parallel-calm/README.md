# Quick mode + parallel solve: real OpenFOAM v2312 run

- Hull: `samples/barge-200.stl`, condition 250 g · calm tow at 0.30 m/s, **Quick** speed, **4 CPU cores** (`HULL_NPROCS=4`, scotch decomposition, `mpirun interFoam -parallel`).
- Machine: 4-vCPU cloud VM. A single core there ran this mesh at ~1.7 s per time step, so it is slower than a typical desktop.
- Wall clock for the whole study (meshing + solve + parsing): **18.5 min** (14:40:53 → 14:59:22 UTC). Mesh: 128,170 cells. Simulated time: 4.0 s (6 hull lengths).
- Reference: one Full-mode coarse calm solve of the same case (20 s simulated at ≤0.5 ms steps) measured 0.53 s/step on 4 cores here, i.e. roughly 8 hours, and Full mode runs 5 such solves per test.
- Result reader parsed the parallel log (End marker, forces, mesh count). Mean drag 0.0549 N.
- Quality flags as recorded: `alphaBounded` false (min alpha −4e‑5 with the quick numerics), `residualsFinite` null (log larger than the reader's 5 MB window), `forceHistoryDrift` false (4 s is too short for a settled drag). These are expected for a quick screening run; use Full mode before relying on the numbers.

Only `log.interFoam.tail` (last 40 lines) is kept here; the full 9 MB log was not copied.
