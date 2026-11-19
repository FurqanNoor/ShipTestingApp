# Calm tow: tank fill error and interface creep on the hull wall (19 November 2026)

**Case:** hull 10 (wave-piercing axe bow, 242 × 119 mm, 19 mm draft) at 150 g; weight 1.472 N; 0.30 m/s.
**Mesh:** the medium calm mesh, 179k cells, 192 cores on Roihu.

**Symptom:** on slender hulls the calm pressure drag was negative, and the vertical force on the held hull was 0.4–0.7 N above its weight. Negative pressure drag means a forward push from the water, which a towed hull in calm water cannot have.

## 1. The tank started too full (fixed: protocol 2026-11-19b)

- **Cause:** the background grid had about 30 mm cells in z with no face at z = 0. `setFields` fills whole cells by their centre, so the water started at the first face above the waterline: +2.7 mm for this hull, 0–7 mm in general, depending on the hull's size.
- **Hydrostatics check:** pressure integrated over the meshed hull patch at a level of z = 0 gives 1.467 N, which matches the weight. So the geometry and the mesh are correct.
- **Still-water run, old grid:** the vertical force started at 1.94 N.
- **Fix:** the domain's z extent is rounded to whole cells, so a face lies exactly at z = 0. On the new grid the run starts at 1.49 N.

## 2. The interface crept up the hull wall (fixed: protocol 2026-11-19c)

After the fix above, the vertical force still rose from 1.49 to 1.78 N over the first ~10 s, and the pressure drag still settled at about −2 mN. What was ruled out:

| Check | Result |
|---|---|
| Total water volume (volume integral of the water fraction) | Constant at 2.3044 m³ (change of −1.5e-4 m³) |
| Free-surface gauges along the tank, 0.6 m off the centreline | Flat to ±0.05 mm from inlet to outlet |
| Gauges 20 mm from the hull's side and 0.1–0.3 m ahead of and behind the hull on the centreline | +0.1 to +0.2 mm |
| Deep pressure probes along the tank | Level to 0.1 Pa |
| Outlet absorber removed | Identical force history (1.521 / 1.678 / 1.752 N against 1.519 / 1.674 / 1.758 N) |
| Surface tension 0 (three hulls) | Same rise (+0.2 to +0.3 N) |
| A 64-second tow (old grid) | Persistent: pressure drag about −3 mN up to the end |

Sampling the hull patch at 2, 4, 6 and 8 s showed the cause. The pressure rose by about 10 Pa (≈1 mm of water head) evenly over the whole bottom, while the water fraction on the hull wall above the waterline kept growing. The next table shows the area-weighted water fraction on the side faces at 8 s.

| Height above the waterline | MULES (`interFoam`) | isoAdvector (`interIsoFoam`) |
|---|---|---|
| −1 to 0 mm | 0.68 | 0.98 |
| 2–3 mm | 0.36 | 0.15 |
| 5–7.5 mm | 0.22 (0.11 at 2 s) | 0.00 |
| 10–15 mm | 0.08 (0.03 at 2 s) | 0.00 |
| 20–30 mm | 0.04 (0.01 at 2 s) | 0.00 |

The smeared "wet film" on the wall makes the solver see about 1 mm of extra water level at the hull. On a 19 mm draft that is a large error: lift rises by about 0.27 N, and on a fine bow and stern there is a net forward push.

## Forces, in 2-second blocks (drag and pressure drag in mN)

| Solver | 0–2 s | 2–4 s | 4–6 s | 6–8 s | 8–10 s |
|---|---|---|---|---|---|
| MULES: Fz (N) | 1.494 | 1.540 | 1.638 | 1.714 | 1.748 |
| MULES: drag / pressure drag | −5.1 / −7.9 | −10.7 / −11.6 | −1.4 / −2.7 | −1.1 / −4.0 | 6.1 / 3.0 |
| MULES with level-5 cells within 3 mm of the hull: Fz (N) | 1.528 | 1.587 | 1.673 | (time limit) | |
| **isoAdvector: Fz (N)** | **1.427** | **1.430** | **1.428** | **1.428** | **1.429** |
| **isoAdvector: drag / pressure drag** | 7.7 / 4.3 | 5.7 / 3.0 | 6.1 / 3.2 | 6.2 / 3.3 | 6.0 / 3.1 |

MULES settled at 0.1–1.7 mN total drag, with pressure drag of −1 to −3 mN, from 16 to 34 s.

- **Finer cells don't help:** a finer mesh near the wall did not stop the creep.
- **isoAdvector works:** with it the wall stays dry above 5 mm, lift is steady from the first 2 s, and drag is steady and positive. Viscous drag is 2.9 mN and pressure drag +3.2 mN.
- **The lift is plausible:** lift 3% below the weight fits a hull held at its static draft at Fr 0.19, which feels slight suction (sinkage).
- **Cost:** isoAdvector is about 13% slower per simulated second.

**Adopted:** calm tests use `interIsoFoam` with `reconstructionScheme isoAlpha` (see `useIsoAdvector` in `src/cfd/case.ts`). Wave tests keep MULES: they measure roll, all of them passed their checks, and moving-mesh isoAdvector is untested here.

**Not yet exploited:** isoAdvector drag is steady after about 2 s, against 20–30 s for MULES. Shorter calm runs could save roughly half the calm compute. This should first be checked on a twin hull and a flat-bottom hull.

Roihu experiment folders: `exp/w10still`, `w10tow`, `w10gA`, `w10gB`, `w10surf`, `w10iso`, `w10fine5`. They were removed after this summary.
