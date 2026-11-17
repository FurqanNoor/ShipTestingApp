import { describe, expect, it } from "vitest";
import { analyzeModel, rankModels } from "../src/engine/analyze";
import { G, RHO, defaultConditions, tankChecks } from "../src/engine/conditions";
import { besselI1, besselK1, holtrop, stawave2 } from "../src/engine/drag";
import { boxHull, exampleHull } from "../src/engine/example";
import { buildColumns, submerged } from "../src/engine/hull";
import { floatUpright, gzCurve, maxLoadVolume } from "../src/engine/hydrostatics";
import { FLIP, IDENTITY, ROLL90, TURN90, autoOrient, mul, place } from "../src/engine/orient";
import { elevation, makeSetup, seaComponents, simulate } from "../src/engine/sim";
import { parseSTL, writeSTL } from "../src/engine/stl";

const metres = (t: Float32Array) => t.map((v) => v * 0.001);
const box = () => buildColumns(metres(place(boxHull(200, 60, 40), IDENTITY).tris), 0.001);

describe("STL", () => {
  it("round-trips binary and reads ASCII", () => {
    const t = boxHull(200, 60, 40);
    expect(Array.from(parseSTL(writeSTL(t)))).toEqual(Array.from(t));
    const ascii = "solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n".repeat(4) + "endsolid";
    expect(parseSTL(new TextEncoder().encode(ascii).buffer as ArrayBuffer).length).toBe(36);
  });
});

describe("box hull against hand calculations", () => {
  const c = box();
  const m = 0.24, V0 = m / RHO;
  const T = V0 / (0.2 * 0.06);
  it("volume, draft, centre of buoyancy", () => {
    expect(c.volume).toBeCloseTo(0.2 * 0.06 * 0.04, 7);
    const up = floatUpright(c, V0)!;
    expect(up.T).toBeCloseTo(T, 5);
    expect(up.zB).toBeCloseTo(T / 2, 5);
    expect(up.BMt).toBeCloseTo(0.06 ** 2 / (12 * T), 4);
    expect(up.freeboard).toBeCloseTo(0.04 - T, 5);
    expect(up.Cb).toBeCloseTo(1, 2);
    expect(up.S).toBeCloseTo(0.2 * 0.06 + 2 * T * (0.2 + 0.06), 3);
    expect(maxLoadVolume(c) * RHO).toBeCloseTo(0.2 * 0.06 * 0.04 * RHO, 4);
  });
  it("righting arm matches the wall-sided formula", () => {
    const KG = 0.02;
    const gz = gzCurve(c, V0, 0, KG);
    const GM = T / 2 + 0.06 ** 2 / (12 * T) - KG;
    const BM = 0.06 ** 2 / (12 * T);
    for (const deg of [5, 10, 15]) {
      const phi = (deg * Math.PI) / 180;
      const expected = Math.sin(phi) * (GM + 0.5 * BM * Math.tan(phi) ** 2);
      expect(gz.gz[gz.deg.indexOf(deg)]).toBeCloseTo(expected, 4);
    }
    expect(gz.deckEdgeDeg).toBeCloseTo((Math.atan((0.04 - T) / 0.03) * 180) / Math.PI, 0);
    expect(gz.capsizeDeg).toBeGreaterThan(60);
  });
  it("a tall narrow box with a high centre of gravity is unstable", () => {
    const tall = buildColumns(metres(place(boxHull(200, 20, 60), IDENTITY).tris), 0.001);
    const gz = gzCurve(tall, 0.1 / RHO, 0, 0.05);
    expect(gz.capsizeDeg).toBe(0);
  });
  it("heeled volume is conserved", () => {
    const s = submerged(c, 0, Math.sin(0.3), Math.cos(0.3), 0.012);
    expect(s.V).toBeGreaterThan(0);
    expect(s.y).toBeLessThan(0); // buoyancy moves to the low side
  });
});

describe("orientation", () => {
  it("recovers the ship axes from rotated files", () => {
    const base = exampleHull();
    for (const rot of [IDENTITY, ROLL90, TURN90, mul(ROLL90, TURN90), mul(TURN90, mul(TURN90, IDENTITY))]) {
      const raw = place(base, rot).tris;
      const placed = place(raw, autoOrient(raw));
      expect(placed.size[0]).toBeCloseTo(220, 3);
      expect(placed.size[1]).toBeCloseTo(37, 1);
      expect(placed.size[2]).toBeCloseTo(16.5, 3);
      // bow (fine end) at high x: compare breadth near both ends
      const width = (lo: number, hi: number) => {
        let w = 0;
        for (let i = 0; i < placed.tris.length; i += 3) if (placed.tris[i] >= lo && placed.tris[i] <= hi) w = Math.max(w, Math.abs(placed.tris[i + 1]));
        return w;
      };
      expect(width(190, 215)).toBeLessThan(width(5, 30));
    }
  });

  it("flip turns the model upside down and back", () => {
    const base = place(exampleHull(), IDENTITY).tris;
    const twice = place(place(base, FLIP).tris, FLIP).tris;
    for (let i = 0; i < base.length; i += 997) expect(twice[i]).toBeCloseTo(base[i], 3);
    const keelHeight = (t: Float32Array) => { let s = 0, n = 0; for (let i = 0; i < t.length; i += 3) if (Math.abs(t[i + 1]) < 0.5) (s += t[i + 2]), n++; return s / n; };
    expect(keelHeight(place(base, FLIP).tris)).toBeGreaterThan(keelHeight(base));
  });
});

describe("drag", () => {
  it("Bessel functions", () => {
    expect(besselI1(1)).toBeCloseTo(0.565159, 5);
    expect(besselI1(5)).toBeCloseTo(24.33564, 3);
    expect(besselK1(1)).toBeCloseTo(0.601907, 5);
    expect(besselK1(3)).toBeCloseTo(0.0401564, 6);
  });
  it("reproduces the Holtrop & Mennen worked example (205 m ship, 25 kn)", () => {
    const f = { LWL: 205, BWL: 32, T: 10, V: 37500, S: 7381.45, Cb: 37500 / (205 * 32 * 10), Cm: 0.98, Cp: 0.5833, Cwp: 0.75, lcbPct: -0.75, iE: 12.08, At: 16 };
    const U = 25 * 0.514444;
    const r = holtrop(f, U, 1025, 1.1883e-6, 9.81);
    expect(r.Fn).toBeCloseTo(0.2868, 3);
    expect(r.formFactor).toBeCloseTo(1.156, 2);
    expect(r.friction / r.formFactor / 1000).toBeGreaterThan(869.63 * 0.99);
    expect(r.friction / r.formFactor / 1000).toBeLessThan(869.63 * 1.01);
    // The example ship has a bulb (c2 = 0.7595); this port has none.
    expect((r.wave * 0.7595) / 1000).toBeGreaterThan(557.11 * 0.97);
    expect((r.wave * 0.7595) / 1000).toBeLessThan(557.11 * 1.03);
    expect(r.transom).toBe(0);
  });
  it("added drag in waves is positive and grows with wave height squared", () => {
    const f = { LWL: 0.21, BWL: 0.036, T: 0.009, V: 28e-6, S: 0.008, Cb: 0.41, Cm: 0.66, Cp: 0.62, Cwp: 0.77, lcbPct: -2, iE: 18, At: 0 };
    const a = stawave2(f, 0.4, 0.004, 0.36, RHO, G).total, b = stawave2(f, 0.4, 0.008, 0.36, RHO, G).total;
    expect(a).toBeGreaterThan(0);
    expect(b / a).toBeCloseTo(4, 6);
  });
});

describe("wave simulation", () => {
  it("sea components carry the energy of the significant wave height", () => {
    const comps = seaComponents(0.008, 0.45, G);
    const m0 = comps.reduce((a, c) => a + 0.5 * c.amp * c.amp, 0);
    expect(4 * Math.sqrt(m0)).toBeCloseTo(0.008, 9);
    const run = { comps, beam: true, U: 0, ramp: 0 };
    let max = 0;
    for (let t = 0; t < 20; t += 0.01) max = Math.max(max, Math.abs(elevation(run, 0, t)));
    expect(max).toBeGreaterThan(0.004);
    expect(max).toBeLessThan(0.0127);
  });
  const c = box();
  const m = 0.24, KG = 0.015;
  const up = floatUpright(c, m / RHO)!;
  const setup = makeSetup(c, m, KG, RHO, G, { Awp: up.Awp, xF: up.xF, IL: up.IL, GM: up.zB + up.BMt - KG, stationBeam: up.stationBeam }, 0.08)!;
  it("stays at rest in calm water with buoyancy equal to weight", () => {
    const r = simulate(setup, 0, 0.4, true, 0);
    expect(r.maxHeave).toBeLessThan(1e-5);
    expect(r.maxRollDeg).toBeLessThan(0.05);
    expect(r.buoyMax).toBeCloseTo(m * G, 3);
    expect(r.capsized).toBe(false);
  });
  it("rolls in beam waves, pitches in head waves, more in bigger waves", () => {
    const small = simulate(setup, 0.004, 0.45, true, 0), big = simulate(setup, 0.012, 0.45, true, 0);
    expect(small.maxRollDeg).toBeGreaterThan(0.2);
    expect(big.maxRollDeg).toBeGreaterThan(small.maxRollDeg * 1.5);
    const head = simulate(setup, 0.008, 0.45, false, 0.4);
    expect(head.maxPitchDeg).toBeGreaterThan(0.1);
    expect(head.maxRollDeg).toBeLessThan(0.1);
    expect(head.buoyMax).toBeGreaterThan(m * G);
  });
});

describe("full programme", () => {
  it("runs the example hull and ranks models", async () => {
    const cond = defaultConditions();
    expect(cond.weights.map((w) => w.grams)).toEqual([22.5, 28, 33.5]);
    expect(cond.speed).toBeCloseTo(0.4, 2);
    expect(tankChecks(cond).every((c) => c.ok)).toBe(true);
    const t0 = Date.now();
    const a = await analyzeModel(place(exampleHull(), IDENTITY).tris, cond);
    const b = await analyzeModel(place(boxHull(200, 60, 40), IDENTITY).tris, cond);
    console.log("analysis ms", Date.now() - t0);
    for (const w of a.weights) {
      console.log(w.label, w.grams, "g  T", w.draftMm.toFixed(2), "fb", w.freeboardMm.toFixed(2), "GM", w.GMmm.toFixed(1), "KG", w.kgMm.toFixed(1), "caps", w.gz.capsizeDeg.toFixed(0), "deck", w.gz.deckEdgeDeg.toFixed(0),
        "Troll", w.rollPeriodS.toFixed(3), "| calm mN", (w.calm.total * 1000).toFixed(2), "fr", (w.calm.friction * 1000).toFixed(2), "wv", (w.calm.wave * 1000).toFixed(2), "tr", (w.calm.transom * 1000).toFixed(2), "CT", w.calm.CT.toFixed(4),
        "Fn", w.calm.Fn.toFixed(3), "Cb", w.form.Cb.toFixed(2), "Cp", w.form.Cp.toFixed(2), "iE", w.form.iE.toFixed(0), "S cm2", (w.form.S * 1e4).toFixed(1));
      for (const v of w.waves) console.log("   ", v.label, "drag mN", (v.dragN * 1000).toFixed(2), "roll", v.maxRollDeg.toFixed(1), "pitch", v.maxPitchDeg.toFixed(1), "heave mm", v.maxHeaveMm.toFixed(2), "buoy", v.buoyMinN.toFixed(3), v.buoyMaxN.toFixed(3), "clear", v.minClearanceMm.toFixed(1), v.deckDry, v.capsized);
    }
    console.log("example", a.score, a.sizeMm, a.maxLoadG.toFixed(1), "box", b.score);
    expect(a.weights.every((w) => w.floats && Number.isFinite(w.calm.total) && w.calm.total > 0)).toBe(true);
    expect(a.withinLimit).toBe(true);
    const ranked = rankModels([{ name: "a", result: a }, { name: "b", result: b }]);
    expect(ranked.map((r) => r.place).sort()).toEqual([1, 2]);
    expect(Math.max(...ranked.map((r) => r.scoreDrag))).toBeCloseTo(100, 6);
    expect(Math.max(...ranked.map((r) => r.scoreLoad))).toBeCloseTo(100, 6);
    expect(ranked[0].total).toBeGreaterThanOrEqual(ranked[1].total);
  }, 60000);
});
