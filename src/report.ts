// Builds the Excel workbook from the test results.
import { ModelResult, rankModels } from "./engine/analyze";
import { Conditions, G, NU, REFERENCE, RHO, SCALE, SIZE_LIMIT_MM, tankChecks, waveLength } from "./engine/conditions";
import { Cell, Sheet, buildXlsx } from "./xlsx";

export interface ReportModel {
  name: string;
  file: string;
  result: ModelResult;
}

const head = (labels: string[]): Cell[] => labels.map((v) => ({ v, s: "head" as const }));
const n = (v: number, s: "n0" | "n1" | "n2" | "n3" | "n4"): Cell => ({ v, s });

export function buildWorkbook(models: ReportModel[], cond: Conditions, when = new Date()): Uint8Array {
  const sheets: Sheet[] = [];

  // Ranking
  const ranked = rankModels(models);
  sheets.push({
    name: "Ranking",
    freezeRows: 1,
    widths: [8, 30, 12, 18, 12, 20, 12, 14, 14, 13],
    rows: [
      head(["Place", "Model", "Total score", "Average drag (mN)", "Drag score", "Average max roll (deg)", "Roll score", "Max load (g)", "Buoyancy score", "Failed cases"]),
      ...ranked.map((r): Cell[] => [r.place, r.name, n(r.total, "n1"), n(r.dragMN, "n2"), n(r.scoreDrag, "n1"), n(r.rollDeg, "n1"), n(r.scoreRoll, "n1"), n(r.maxLoadG, "n0"), n(r.scoreLoad, "n1"), r.failures ? { v: r.failures, s: "bad" } : 0]),
      [],
      [{ v: "Each category is scored against the best model: lowest average drag, lowest average roll and highest max load score 100, the others proportionally less. Total = average of the three.", s: "note" }],
      [{ v: "Average drag: calm water and the three seas at all three weights. Average max roll: the three seas at all three weights (a capsize counts as 90 deg).", s: "note" }],
      [{ v: "Max load: weight at which the lowest deck edge reaches the water. A weight at which the model sinks or cannot stay upright removes a third of every score.", s: "note" }],
    ],
  });

  // Summary: one row per model and weight
  const waveHead = cond.waves.flatMap((w) => [`${w.label}: drag (mN)`, `${w.label}: max roll (deg)`]);
  const summary: Cell[][] = [
    head(["Model", "Weight case", "Weight (g)", "Result", "Draft (mm)", "Freeboard (mm)", "Buoyancy force (N)", "Displaced volume (cm3)", "Max load (g)", "Spare buoyancy (%)",
      "Capsize angle (deg, 90 = none up to 90)", "Deck edge under at (deg)", "Initial stability GM (mm)", "Max righting arm (mm)", "Roll period (s)", "Calm drag (mN)", "Calm drag coefficient", ...waveHead]),
  ];
  for (const m of models)
    for (const w of m.result.weights) {
      if (!w.floats) {
        summary.push([m.name, w.label, n(w.grams, "n1"), { v: "Sinks", s: "bad" }, null, null, null, null, n(m.result.maxLoadG, "n0")]);
        continue;
      }
      const verdict: Cell = !w.stable ? { v: "Tips over", s: "bad" } : w.waves.some((v) => v.capsized) ? { v: "Capsizes in waves", s: "bad" } : { v: "Floats upright", s: "ok" };
      summary.push([
        m.name, w.label, n(w.grams, "n1"), verdict, n(w.draftMm, "n1"), n(w.freeboardMm, "n1"), n(w.buoyancyN, "n3"), n(w.displacedCm3, "n1"), n(m.result.maxLoadG, "n0"), n(w.reservePct, "n0"),
        n(w.gz.capsizeDeg, "n0"), n(w.gz.deckEdgeDeg, "n0"), n(w.GMmm, "n1"), n(w.gz.gzMax * 1000, "n2"), n(w.rollPeriodS, "n2"), n(w.calm.total * 1000, "n2"), n(w.calm.CT, "n4"),
        ...w.waves.flatMap((v): Cell[] => [n(v.dragN * 1000, "n2"), v.capsized ? { v: "Capsized", s: "bad" } : n(v.maxRollDeg, "n1")]),
      ]);
    }
  sheets.push({ name: "Summary", rows: summary, freezeRows: 1, widths: [30, 13, 10, 16, 10, 12, 12, 12, 10, 12, 12, 12, 12, 12, 10, 11, 11, ...waveHead.map(() => 13)] });

  // Wave tests: one row per model, weight and water condition
  const waves: Cell[][] = [
    head(["Model", "Weight case", "Weight (g)", "Water", "Wave height (mm)", "Wave period (s)", "Drag force (mN)", "Drag coefficient", "Added drag from waves (mN)", "Max roll (deg)", "Max pitch (deg)", "Max heave (mm)",
      "Buoyancy min (N)", "Buoyancy max (N)", "Deck edge clearance (mm)", "Deck", "Result"]),
  ];
  for (const m of models)
    for (const w of m.result.weights) {
      if (!w.floats) continue;
      waves.push([m.name, w.label, n(w.grams, "n1"), "Calm", 0, null, n(w.calm.total * 1000, "n2"), n(w.calm.CT, "n4"), 0, 0, 0, 0, n(w.buoyancyN, "n3"), n(w.buoyancyN, "n3"), n(w.freeboardMm, "n1"), "Dry", { v: w.stable ? "OK" : "Tips over", s: w.stable ? "ok" : "bad" }]);
      for (const v of w.waves)
        waves.push([
          m.name, w.label, n(w.grams, "n1"), v.label, n(v.heightMm, "n1"), n(v.periodS, "n2"), n(v.dragN * 1000, "n2"), n(v.CT, "n4"), n(v.addedN * 1000, "n2"), n(v.maxRollDeg, "n1"), n(v.maxPitchDeg, "n1"), n(v.maxHeaveMm, "n1"),
          n(v.buoyMinN, "n3"), n(v.buoyMaxN, "n3"), n(v.minClearanceMm, "n1"), v.deckDry ? "Dry" : "Wet", { v: v.capsized ? "Capsized" : "OK", s: v.capsized ? "bad" : "ok" },
        ]);
    }
  sheets.push({ name: "Wave tests", rows: waves, freezeRows: 1, widths: [30, 13, 10, 12, 11, 11, 11, 11, 13, 10, 10, 10, 11, 11, 13, 8, 10] });

  // Stability curves
  const gz: Cell[][] = [head(["Model", "Weight case", "Heel angle (deg)", "Righting arm GZ (mm)"])];
  for (const m of models) for (const w of m.result.weights) w.gz.deg.forEach((d, i) => gz.push([m.name, w.label, n(d, "n1"), n(w.gz.gz[i] * 1000, "n3")]));
  sheets.push({ name: "Stability curves", rows: gz, freezeRows: 1, widths: [30, 13, 14, 18] });

  // Hull form
  const form: Cell[][] = [
    head(["Model", "File", "Length (mm)", "Beam (mm)", "Height (mm)", "Within size limit", "Hull volume (cm3)", "Weight case", "Waterline length (mm)", "Waterline beam (mm)", "Wetted surface (cm2)",
      "Block coeff. Cb", "Prismatic coeff. Cp", "Midship coeff. Cm", "Waterplane coeff. Cwp", "Bow half angle (deg)", "CG height (mm)", "Froude number", "Reynolds number", "Friction drag (mN)", "Wave-making drag (mN)", "Transom drag (mN)", "Notes"]),
  ];
  for (const m of models)
    for (const w of m.result.weights) {
      const [L, B, H] = m.result.sizeMm;
      const base: Cell[] = [m.name, m.file, n(L, "n1"), n(B, "n1"), n(H, "n1"), m.result.withinLimit ? { v: "Yes", s: "ok" } : { v: "No", s: "bad" }, n(m.result.volumeCm3, "n1"), w.label];
      if (!w.floats) form.push([...base, "Sinks"]);
      else
        form.push([
          ...base, n(w.form.LWL * 1000, "n1"), n(w.form.BWL * 1000, "n1"), n(w.form.S * 1e4, "n1"), n(w.form.Cb, "n3"), n(w.form.Cp, "n3"), n(w.form.Cm, "n3"), n(w.form.Cwp, "n3"), n(w.form.iE, "n0"), n(w.kgMm, "n1"),
          n(w.calm.Fn, "n3"), n(w.calm.Re, "n0"), n(w.calm.friction * 1000, "n2"), n(w.calm.wave * 1000, "n2"), n(w.calm.transom * 1000, "n2"), m.result.notes.join(" "),
        ]);
    }
  sheets.push({ name: "Hull form", rows: form, freezeRows: 1, widths: [30, 26, 10, 10, 10, 10, 11, 13, 11, 11, 11, 9, 9, 9, 9, 9, 9, 9, 11, 11, 11, 11, 50] });

  // Test conditions
  const payload = REFERENCE.luggageT + REFERENCE.tanksT + REFERENCE.cargoT;
  const kv = (k: string, v: string | number, note = ""): Cell[] => [k, v, { v: note, s: "note" }];
  const cnd: Cell[][] = [
    [{ v: "Test conditions", s: "title" }],
    kv("Exported", when.toISOString().slice(0, 16).replace("T", " ") + " UTC"),
    [],
    head(["Scale", "Value", "Note"]),
    kv("Size limit (mm)", SIZE_LIMIT_MM, "Maximum model length and beam"),
    kv("Reference ship", REFERENCE.name, `${REFERENCE.lengthM} m long, ${REFERENCE.speedKn} kn, from the original Ship Test Bench`),
    kv("Scale", `1:${SCALE.toFixed(1)}`, "Reference length / size limit. Froude scaling: lengths / scale, time and speed / sqrt(scale), mass / scale^3"),
    kv("Water", "Fresh, 20 C", `Density ${RHO} kg/m3, viscosity ${NU} m2/s, gravity ${G} m/s2`),
    [],
    head(["Weights", "Model weight (g)", "Full-size basis"]),
    ...cond.weights.map((w, i) => kv(w.label, w.grams, [`Lightship ${REFERENCE.lightshipT} t`, `Lightship + luggage ${REFERENCE.luggageT} t + fuel and water ${REFERENCE.tanksT} t + cargo ${REFERENCE.cargoT} t = ${(REFERENCE.lightshipT + payload).toFixed(0)} t`, `Lightship + double luggage, fuel and cargo = ${(REFERENCE.lightshipT + 2 * payload).toFixed(0)} t`][i] ?? w.note)),
    kv("Centre of gravity", cond.cgMode === "auto" ? "Centre of the model's volume" : `${cond.cgPercent} % of model height`, "Load placed so the ship floats level and upright"),
    [],
    head(["Waves", "Significant height (mm) / peak period (s)", "Note"]),
    ...cond.waves.map((w) => kv(w.label, `${w.heightMm} mm / ${w.periodS} s`, `${w.note}. Dominant wavelength ${(waveLength(w.periodS) * 1000).toFixed(0)} mm. Natural irregular sea (Bretschneider spectrum, 20 components, same waves for every model)`)),
    kv("Test speed (m/s)", cond.speed, `${REFERENCE.speedKn} kn at full size`),
    kv("Roll test", "Waves from the side, ship at rest", "Largest roll angle in 35 wave periods"),
    kv("Drag and pitch test", "Head waves at test speed", "Drag = calm-water drag + average added drag from the waves"),
    [],
    head(["Tank (simulation boundary)", "Value", "Check"]),
    kv("Tank size (m)", `${cond.tank.lengthM} x ${cond.tank.widthM} x ${cond.tank.depthM} deep`, "Results are calculated for open, deep water. The tank is sized so its walls and floor would not change them."),
    ...tankChecks(cond).map((c) => kv(c.name, c.text, `${c.ok ? "OK" : "NOT MET"}: needs ${c.limit}`)),
    [],
    head(["Method", "", ""]),
    kv("Hull shape", "Taken from the STL", "Outer shape, sealed at the deck. Open or hollow hulls count as watertight up to the deck edge."),
    kv("Buoyancy", "Water density x gravity x submerged volume", "Draft solved so that buoyancy equals weight"),
    kv("Roll stability", "Righting arm curve 0 to 90 deg", "Heeled at constant weight, both sides, weaker side reported"),
    kv("Calm-water drag", "Holtrop & Mennen (1984)", "ITTC-57 friction at model Reynolds number, form factor, wave-making and transom drag from the measured hull form. Drag coefficient = drag / (0.5 x density x speed^2 x wetted surface)"),
    kv("Added drag in waves", "STAWAVE-2 (ITTC 7.5-04-01-01.1)", "Summed over the wave components"),
    kv("Motions in waves", "Time simulation of heave, roll and pitch", `Buoyancy integrated over the hull under the moving wave surface each step. Roll damping ${cond.rollDamping * 100} % of critical, rising with roll speed`),
    kv("Accuracy", "Engineering estimate, not CFD", "Buoyancy and stability follow directly from the geometry. Drag and wave results are estimates meant for ranking designs under identical conditions."),
  ];
  sheets.push({ name: "Test conditions", rows: cnd, widths: [28, 40, 120] });

  return buildXlsx(sheets);
}
