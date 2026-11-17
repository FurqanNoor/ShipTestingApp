# Wave generation: 2D empty-tank verification (OpenCFD v2312)

**Method.** `tank2d.py` turns a wave case produced by the app's own case generator (hull: the curved sample scaled to 216 × 78 × 44 mm, 250 g) into a 2D empty tank. It keeps the same wave grid, generation zone, sponge, time-step settings and gauges, makes the tank one cell thick at the hull position, and removes the hull and its motion. `tankreport.mjs` uses the app's own gauge analysis (`analyseWaveGauges`) over the app's averaging window. It reports the wave height and period achieved at the two gauges up-wave of the hull position (λ/4 and λ/2).

| Case | Grid | Gain | Achieved height | Achieved period | Stable to end |
| --- | --- | --- | --- | --- | --- |
| quick-nogain low / medium / high | Quick | 1 | 69% / 74% / 79% | 100% | yes |
| quick-gain low / medium / high | Quick | 1/0.69, 1/0.74, 1/0.79 | **98% / 99% / 99%** | **100%** | yes |
| full-nogain low / medium / high | Full coarse | 1 | 91% / 93.5% / 94% | 100% | yes (12 periods past warm-up) |
| full-gain low / high | Full coarse | 1/0.91, 1/0.94 | **100% / 99–101%** | **100%** | yes |

The two gauges differ by about ±5%, indicating a small residual reflection. Gauge files are `postProcessing/waveGauges/0/position.dat`. The interface position is reported relative to a fixed reference, so only its fluctuation is used.

**History.** Before this rebuild, every wave case (original configuration included) diverged. The boundary wave-maker's active absorption ran away at the floor corner cell next to the paddle, and without absorption, air at the paddle spiked to 20–120 m/s. The relaxation-zone wave-maker and sponge replace it.

**Not covered here:** a full 3D hull run to the end of its simulated time. That takes hours on a 4-vCPU VM. The 3D case with hull meshes cleanly (checkMesh "Mesh OK", worst non-orthogonality 46°) and was verified to start and run stably with the generation zone, sponge and moving hull active. Every 3D wave run measures its own achieved wave at the same gauges and flags deviations beyond ±10% height or ±5% period.

Full-grid gains (1/0.91, 1/0.935, 1/0.94) come from the no-gain runs above and were confirmed for low and high waves. Medium was not rerun; it lies between them.
