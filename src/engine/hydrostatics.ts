// Upright floating condition, hull-form coefficients and the roll righting-arm (GZ) curve.
// Same approach as the original app's stability.ts: heel at constant displacement, fixed trim.
import { Columns, solveLevel, submerged } from "./hull";

export interface Upright {
  T: number; // draft, m
  V: number; // displaced volume, m3
  xB: number;
  yB: number;
  zB: number; // KB
  Awp: number;
  xF: number;
  IT: number; // transverse waterplane second moment, m4
  IL: number;
  BMt: number;
  LWL: number;
  xAft: number;
  xFwd: number;
  BWL: number;
  Am: number; // largest section area
  S: number; // wetted surface
  Cb: number;
  Cm: number;
  Cp: number;
  Cwp: number;
  lcbPct: number; // LCB forward of mid-LWL, % of LWL
  iE: number; // half angle of entrance, deg
  At: number; // immersed transom area
  freeboard: number; // lowest deck-edge point above water
  stationBeam: Float64Array; // waterline beam per station
  stationArea: Float64Array;
}

export function floatUpright(c: Columns, V0: number): Upright | null {
  const sol = solveLevel(c, 0, 0, 1, V0);
  if (!sol) return null;
  const T = sol.level;
  const { nx, ny, h } = c;
  const stationBeam = new Float64Array(nx);
  const stationArea = new Float64Array(nx);
  const girth = new Float64Array(nx);
  const bottom = new Float64Array(nx * ny).fill(NaN); // wet column bottoms on the grid
  let Awp = 0, mxF = 0, myF = 0, Iyy = 0, Ixx = 0;
  for (let i = 0; i < c.n; i++) {
    if (c.zb[i] >= T) continue;
    const top = Math.min(T, c.zt[i]);
    stationArea[c.ix[i]] += (top - c.zb[i]) * h;
    bottom[c.ix[i] * ny + c.iy[i]] = c.zb[i];
    if (c.zt[i] > T) {
      stationBeam[c.ix[i]] += h;
      Awp += 1;
      mxF += c.x[i];
      myF += c.y[i];
      Iyy += c.y[i] * c.y[i];
      Ixx += c.x[i] * c.x[i];
    }
  }
  if (Awp === 0) return null;
  const xF = mxF / Awp, yF = myF / Awp;
  const IT = (Iyy - Awp * yF * yF) * c.dA + (Awp * c.dA * h * h) / 12;
  const IL = (Ixx - Awp * xF * xF) * c.dA + (Awp * c.dA * h * h) / 12;
  Awp *= c.dA;

  // Girth of each section: along the bottom between neighbouring wet columns, up the side at the ends of each wet run.
  for (let i = 0; i < nx; i++) {
    let prev = NaN, g = 0;
    for (let j = 0; j <= ny; j++) {
      const z = j < ny ? bottom[i * ny + j] : NaN;
      if (!Number.isNaN(z) && !Number.isNaN(prev)) g += Math.hypot(h, z - prev);
      else if (!Number.isNaN(z)) g += Math.hypot(h / 2, T - z);
      else if (!Number.isNaN(prev)) g += Math.hypot(h / 2, T - prev);
      prev = z;
    }
    girth[i] = g;
  }
  let iAft = -1, iFwd = -1, BWL = 0, Am = 0;
  for (let i = 0; i < nx; i++) {
    if (stationBeam[i] > 0) {
      if (iAft < 0) iAft = i;
      iFwd = i;
    }
    BWL = Math.max(BWL, stationBeam[i]);
    Am = Math.max(Am, stationArea[i]);
  }
  const xAft = iAft * h, xFwd = (iFwd + 1) * h;
  const LWL = xFwd - xAft;
  // Wetted surface: girth integrated along the length, combined with the change in section area
  // so that blunt ends and transoms are counted too.
  let S = 0;
  for (let i = -1; i < nx; i++) {
    const a0 = i >= 0 ? stationArea[i] : 0, a1 = i + 1 < nx ? stationArea[i + 1] : 0;
    const g0 = i >= 0 ? girth[i] : 0, g1 = i + 1 < nx ? girth[i + 1] : 0;
    S += Math.hypot(0.5 * (g0 + g1) * h, a1 - a0);
  }
  const halfBreadthAt = (dist: number) => {
    const i = Math.max(iAft, Math.min(iFwd, Math.round((xFwd - dist) / h - 0.5)));
    return 0.5 * stationBeam[i];
  };
  const iE = (Math.atan(Math.max(halfBreadthAt(0.05 * LWL) / (0.05 * LWL), halfBreadthAt(0.1 * LWL) / (0.1 * LWL))) * 180) / Math.PI;
  const At = stationArea[Math.min(iFwd, iAft + 1)];
  let freeboard = Infinity;
  for (let e = 0; e < c.edges.length; e += 3) freeboard = Math.min(freeboard, c.edges[e + 2] - T);
  const V = sol.V;
  return {
    T, V, xB: sol.x, yB: sol.y, zB: sol.z, Awp, xF, IT, IL, BMt: IT / V, LWL, xAft, xFwd, BWL, Am, S,
    Cb: V / (LWL * BWL * T), Cm: Am / (BWL * T), Cp: V / (Am * LWL), Cwp: Awp / (LWL * BWL),
    lcbPct: (100 * (sol.x - (xAft + LWL / 2))) / LWL, iE, At, freeboard, stationBeam, stationArea,
  };
}

export interface GZCurve {
  deg: number[];
  gz: number[]; // righting arm, m (weaker side)
  gzMax: number;
  gzMaxDeg: number;
  /** Angle where the righting arm becomes negative: the ship capsizes beyond it. 90 = still positive at 90. */
  capsizeDeg: number;
  /** Heel angle at which the deck edge reaches the water. */
  deckEdgeDeg: number;
}

function sweep(c: Columns, V0: number, yG: number, zG: number, dir: 1 | -1, step: number) {
  const deg: number[] = [], gz: number[] = [], clear: number[] = [];
  for (let d = 0; d <= 90 + 1e-9; d += step) {
    const phi = (dir * d * Math.PI) / 180;
    const ny = Math.sin(phi), nz = Math.cos(phi);
    const r = solveLevel(c, 0, ny, nz, V0);
    if (!r) break;
    gz.push(-dir * ((r.y - yG) * nz - (r.z - zG) * ny));
    let cl = Infinity;
    for (let e = 0; e < c.edges.length; e += 3) cl = Math.min(cl, ny * c.edges[e + 1] + nz * c.edges[e + 2] - r.level);
    clear.push(cl);
    deg.push(d);
  }
  return { deg, gz, clear };
}

const crossing = (deg: number[], v: number[], from = 1): number | null => {
  for (let i = from; i < deg.length; i++)
    if (v[i - 1] > 0 && v[i] <= 0) return deg[i - 1] + ((deg[i] - deg[i - 1]) * v[i - 1]) / (v[i - 1] - v[i]);
  return null;
};

/** GZ curve to both sides; every summary value is taken from the weaker side. */
export function gzCurve(c: Columns, V0: number, yG: number, zG: number, step = 2.5): GZCurve {
  const sides = [sweep(c, V0, yG, zG, 1, step), sweep(c, V0, yG, zG, -1, step)];
  const summary = sides.map((s) => {
    let gzMax = -Infinity, gzMaxDeg = 0;
    s.gz.forEach((g, i) => g > gzMax && ((gzMax = g), (gzMaxDeg = s.deg[i])));
    // Unstable upright (negative arm at the first step): capsize angle is 0.
    const capsizeDeg = s.gz.length > 1 && s.gz[1] <= 0 ? 0 : crossing(s.deg, s.gz, 2) ?? s.deg[s.deg.length - 1];
    const deckEdgeDeg = s.clear[0] <= 0 ? 0 : crossing(s.deg, s.clear) ?? 90;
    return { gzMax, gzMaxDeg, capsizeDeg, deckEdgeDeg };
  });
  const weak = summary[0].capsizeDeg <= summary[1].capsizeDeg ? 0 : 1;
  return {
    deg: sides[weak].deg,
    gz: sides[weak].gz,
    gzMax: Math.max(0, Math.min(summary[0].gzMax, summary[1].gzMax)),
    gzMaxDeg: summary[weak].gzMaxDeg,
    capsizeDeg: Math.min(summary[0].capsizeDeg, summary[1].capsizeDeg),
    deckEdgeDeg: Math.min(summary[0].deckEdgeDeg, summary[1].deckEdgeDeg),
  };
}

/** Largest load the hull carries before the lowest deck-edge point reaches the water (upright). */
export function maxLoadVolume(c: Columns): number {
  let low = Infinity;
  for (let e = 0; e < c.edges.length; e += 3) low = Math.min(low, c.edges[e + 2]);
  return submerged(c, 0, 0, 1, low).V;
}
