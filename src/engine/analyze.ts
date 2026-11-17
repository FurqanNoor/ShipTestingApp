// Runs the full test programme on one hull: 3 weights x (calm water + 3 waves).
import { Conditions, G, NU, RHO, SIZE_LIMIT_MM } from "./conditions";
import { CalmDrag, HullForm, holtrop, stawave2 } from "./drag";
import { buildColumns, gridSize } from "./hull";
import { GZCurve, floatUpright, gzCurve, maxLoadVolume } from "./hydrostatics";
import { SimResult, makeSetup, seaComponents, simulate } from "./sim";

export interface WaveCase {
  label: string;
  heightMm: number;
  periodS: number;
  dragN: number; // calm + added drag in head waves
  addedN: number;
  CT: number;
  maxRollDeg: number; // waves from the side
  maxPitchDeg: number; // head waves
  maxHeaveMm: number;
  buoyMinN: number;
  buoyMaxN: number;
  minClearanceMm: number;
  deckDry: boolean;
  capsized: boolean;
  head: SimResult;
  beam: SimResult;
}

export interface WeightResult {
  label: string;
  grams: number;
  floats: boolean;
  draftMm: number;
  freeboardMm: number;
  buoyancyN: number;
  displacedCm3: number;
  reservePct: number; // spare buoyancy before the deck edge goes under, % of this weight
  kgMm: number;
  GMmm: number;
  stable: boolean;
  rollPeriodS: number;
  gz: GZCurve;
  form: HullForm;
  calm: CalmDrag;
  waves: WaveCase[];
  /** Hull pose at rest, for the 3D view (mm). */
  rest: { xG: number; yG: number; zG: number; draft: number };
}

export interface ModelResult {
  sizeMm: [number, number, number];
  withinLimit: boolean;
  volumeCm3: number;
  maxLoadG: number;
  sealedOpenSurface: boolean;
  weights: WeightResult[];
  score: { dragMN: number; rollDeg: number; maxLoadG: number; failures: number };
  notes: string[];
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** trisMm: placed triangles in millimetres (see orient.place). */
export async function analyzeModel(trisMm: Float32Array, cond: Conditions, onProgress?: (f: number) => void): Promise<ModelResult> {
  const tris = new Float32Array(trisMm.length);
  for (let i = 0; i < tris.length; i++) tris[i] = trisMm[i] * 0.001;
  let L = 0, B = 0, D = 0, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    L = Math.max(L, tris[i]);
    yMin = Math.min(yMin, tris[i + 1]);
    yMax = Math.max(yMax, tris[i + 1]);
    D = Math.max(D, tris[i + 2]);
  }
  B = yMax - yMin;
  if (!(L > 0 && B > 0 && D > 0)) throw new Error("The model has no volume. Export a solid body as STL.");
  const fine = buildColumns(tris, gridSize(L, B, 256, 60000));
  const dyn = buildColumns(tris, gridSize(L, B, 110, 5000));
  if (fine.n < 20 || fine.volume <= 0) throw new Error("The model is too thin to analyse. Export a solid body as STL.");
  await tick();

  const KG = cond.cgMode === "auto" ? fine.cz : (cond.cgPercent / 100) * D;
  const maxLoadG = maxLoadVolume(fine) * RHO * 1000;
  const U = cond.speed;
  const q = 0.5 * RHO * U * U;
  const weights: WeightResult[] = [];
  const total = cond.weights.length * (cond.waves.length + 1);
  let done = 0;
  const step = async () => {
    onProgress?.(++done / total);
    await tick();
  };

  for (const w of cond.weights) {
    const mass = w.grams / 1000;
    const V0 = mass / RHO;
    const up = floatUpright(fine, V0);
    const upDyn = floatUpright(dyn, V0);
    const KB = up ? up.zB + up.BMt : 0;
    const setup = upDyn && makeSetup(dyn, mass, KG, RHO, G, { Awp: upDyn.Awp, xF: upDyn.xF, IL: upDyn.IL, GM: KB - KG, stationBeam: upDyn.stationBeam }, cond.rollDamping);
    if (!up || !setup) {
      weights.push(sunk(w.label, w.grams, KG));
      done += cond.waves.length;
      await step();
      continue;
    }
    const GM = KB - KG;
    const gz = gzCurve(fine, V0, up.yB, KG);
    const form: HullForm = { LWL: up.LWL, BWL: up.BWL, T: up.T, V: up.V, S: up.S, Cb: up.Cb, Cm: up.Cm, Cp: up.Cp, Cwp: up.Cwp, lcbPct: up.lcbPct, iE: up.iE, At: up.At };
    const calm = holtrop(form, U, RHO, NU, G);
    await step();
    const waves: WaveCase[] = [];
    for (const wave of cond.waves) {
      const H = wave.heightMm / 1000;
      // Mean added drag: STAWAVE-2 summed over the wave components of the sea.
      let added = 0;
      for (const c of seaComponents(H, wave.periodS, G)) added += stawave2(form, U, 2 * c.amp, (2 * Math.PI) / c.omega, RHO, G).total;
      const head = simulate(setup, H, wave.periodS, false, U);
      const beam = simulate(setup, H, wave.periodS, true, 0);
      const clearance = Math.min(head.minClearance, beam.minClearance);
      const capsized = head.capsized || beam.capsized;
      waves.push({
        label: wave.label, heightMm: wave.heightMm, periodS: wave.periodS,
        dragN: calm.total + added, addedN: added, CT: (calm.total + added) / (q * up.S),
        maxRollDeg: Math.max(beam.maxRollDeg, head.maxRollDeg), maxPitchDeg: head.maxPitchDeg, maxHeaveMm: head.maxHeave * 1000,
        buoyMinN: Math.min(head.buoyMin, beam.buoyMin), buoyMaxN: Math.max(head.buoyMax, beam.buoyMax),
        minClearanceMm: clearance * 1000, deckDry: clearance > 0 && !capsized, capsized, head, beam,
      });
      await step();
    }
    weights.push({
      label: w.label, grams: w.grams, floats: true,
      draftMm: up.T * 1000, freeboardMm: up.freeboard * 1000, buoyancyN: RHO * G * up.V, displacedCm3: up.V * 1e6,
      reservePct: (100 * (maxLoadG - w.grams)) / w.grams, kgMm: KG * 1000, GMmm: GM * 1000, stable: GM > 0 && gz.capsizeDeg > 0,
      rollPeriodS: GM > 0 ? (2 * Math.PI * 0.38 * B) / Math.sqrt(G * GM) : NaN,
      gz, form, calm, waves,
      rest: { xG: setup.xG * 1000, yG: setup.yG * 1000, zG: KG * 1000, draft: up.T * 1000 },
    });
  }

  // Score inputs for the leaderboard.
  let dragSum = 0, dragN = 0, rollSum = 0, rollN = 0, failures = 0;
  for (const w of weights) {
    if (!w.floats) {
      failures++;
      continue;
    }
    if (!w.stable || w.waves.some((v) => v.capsized)) failures++;
    dragSum += w.calm.total;
    dragN++;
    for (const v of w.waves) {
      dragSum += v.dragN;
      dragN++;
      rollSum += v.capsized || !w.stable ? 90 : v.maxRollDeg;
      rollN++;
    }
  }
  const notes: string[] = [];
  if (fine.sealedOpenSurface) notes.push("The STL is an open surface, so it was closed at the deck edge for the analysis.");
  if (L * 1000 > SIZE_LIMIT_MM + 0.5 || B * 1000 > SIZE_LIMIT_MM + 0.5) notes.push(`Larger than the ${SIZE_LIMIT_MM} x ${SIZE_LIMIT_MM} mm limit.`);
  return {
    sizeMm: [L * 1000, B * 1000, D * 1000],
    withinLimit: L * 1000 <= SIZE_LIMIT_MM + 0.5 && B * 1000 <= SIZE_LIMIT_MM + 0.5,
    volumeCm3: fine.volume * 1e6, maxLoadG, sealedOpenSurface: fine.sealedOpenSurface, weights,
    score: { dragMN: dragN ? (1000 * dragSum) / dragN : NaN, rollDeg: rollN ? rollSum / rollN : NaN, maxLoadG, failures },
    notes,
  };
}

function sunk(label: string, grams: number, KG: number): WeightResult {
  const zeroForm: HullForm = { LWL: 0, BWL: 0, T: 0, V: 0, S: 0, Cb: 0, Cm: 0, Cp: 0, Cwp: 0, lcbPct: 0, iE: 0, At: 0 };
  return {
    label, grams, floats: false, draftMm: NaN, freeboardMm: NaN, buoyancyN: NaN, displacedCm3: NaN, reservePct: NaN, kgMm: KG * 1000, GMmm: NaN,
    stable: false, rollPeriodS: NaN, gz: { deg: [], gz: [], gzMax: 0, gzMaxDeg: 0, capsizeDeg: 0, deckEdgeDeg: 0 }, form: zeroForm,
    calm: { total: NaN, friction: NaN, wave: NaN, transom: NaN, formFactor: NaN, Cf: NaN, CT: NaN, Re: NaN, Fn: NaN }, waves: [],
    rest: { xG: 0, yG: 0, zG: 0, draft: 0 },
  };
}

export interface Ranked {
  name: string;
  dragMN: number;
  rollDeg: number;
  maxLoadG: number;
  failures: number;
  /** 0-100 per category, 100 = best model in that category. */
  scoreDrag: number;
  scoreRoll: number;
  scoreLoad: number;
  total: number;
  place: number;
}

/**
 * Leaderboard. Each category is scored against the best model: lowest average drag, lowest
 * average roll and highest max load each earn 100, the others proportionally less. A weight
 * at which the model sinks or cannot stay upright removes a third of every score. The total
 * is the plain average of the three categories.
 */
export function rankModels(models: { name: string; result: ModelResult }[]): Ranked[] {
  const rows = models.map(({name,result}) => {
    const valid = result.weights.filter(w => w.floats && w.stable && !w.waves.some(v => v.capsized) && [w.calm.total,...w.waves.map(v=>v.dragN)].every(n=>Number.isFinite(n)&&n>0) && w.waves.every(v=>Number.isFinite(v.maxRollDeg)));
    const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:NaN;
    const dragMN=mean(valid.flatMap(w=>[w.calm.total,...w.waves.map(v=>v.dragN)]))*1000;
    const rollDeg=mean(valid.flatMap(w=>w.waves.map(v=>v.maxRollDeg)));
    const eligible=result.withinLimit&&valid.length>0&&Number.isFinite(dragMN)&&dragMN>0&&Number.isFinite(rollDeg)&&Number.isFinite(result.maxLoadG)&&result.maxLoadG>0;
    return {name,dragMN,rollDeg,maxLoadG:result.maxLoadG,failures:result.weights.length-valid.length,validFrac:eligible?valid.length/result.weights.length:0,eligible};
  });
  const good=rows.filter(r=>r.eligible),bestDrag=Math.min(...good.map(r=>r.dragMN)),bestRoll=Math.min(...good.map(r=>Math.max(r.rollDeg,.1))),bestLoad=Math.max(...good.map(r=>r.maxLoadG));
  const out:Ranked[]=rows.map(r=>{
    const scoreDrag=r.eligible?100*r.validFrac*bestDrag/r.dragMN:0,scoreRoll=r.eligible?100*r.validFrac*bestRoll/Math.max(r.rollDeg,.1):0,scoreLoad=r.eligible?100*r.validFrac*r.maxLoadG/bestLoad:0;
    return {name:r.name,dragMN:r.dragMN,rollDeg:r.rollDeg,maxLoadG:r.maxLoadG,failures:r.failures,scoreDrag,scoreRoll,scoreLoad,total:(scoreDrag+scoreRoll+scoreLoad)/3,place:0};
  });
  out.sort((a,b)=>b.total-a.total);
  out.forEach((r,i)=>r.place=r.total<=0?0:i>0&&Math.abs(out[i-1].total-r.total)<1e-9?out[i-1].place:i+1);
  return out;
}
