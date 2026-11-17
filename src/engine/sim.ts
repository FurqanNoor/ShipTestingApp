// Time-domain wave test: heave, roll and pitch of the hull in an irregular (natural-looking) sea.
// Each time step the buoyancy force and its moments are integrated over the actual hull shape
// under the instantaneous wave surface (rho*g*submerged volume, as in the original app's
// buoyancy.ts), then fed back into the motion. The force on each piece of submerged volume acts
// along the local wave-surface normal (the pressure gradient in a wave), so a long wave tilts the
// ship with moment displacement x GM x wave slope, the standard result. Added mass and damping are
// standard estimates.
import { Columns, solveLevel } from "./hull";

export interface WaveComponent {
  amp: number; // m
  omega: number; // rad/s
  k: number; // rad/m
  phase: number;
}

/**
 * Long-crested sea with a Bretschneider (ITTC two-parameter) spectrum: significant wave height
 * hs and peak period tp, as equal-energy components with fixed phases so every model meets
 * exactly the same waves.
 */
export function seaComponents(hs: number, tp: number, g: number, n = 20): WaveComponent[] {
  const wp = (2 * Math.PI) / tp;
  let seed = 20261116;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const amp = hs / Math.sqrt(8 * n);
  const out: WaveComponent[] = [];
  for (let j = 0; j < n; j++) {
    const omega = wp * Math.pow(1.25 / -Math.log((j + 0.5) / n), 0.25);
    out.push({ amp, omega, k: (omega * omega) / g, phase: 2 * Math.PI * rand() });
  }
  return out;
}

export interface SeaRun {
  comps: WaveComponent[];
  beam: boolean; // true: waves from the side, ship at rest. false: head waves at speed U.
  U: number;
  ramp: number; // s
}

/** Wave elevation at distance xi along the wave direction (hull axes, from the centre of gravity). */
export function elevation(run: SeaRun, xi: number, t: number): number {
  const r = t < run.ramp ? 0.5 - 0.5 * Math.cos((Math.PI * t) / run.ramp) : 1;
  let eta = 0;
  for (const c of run.comps) eta += c.amp * Math.cos(c.k * xi + (run.beam ? -c.omega : c.omega + c.k * run.U) * t + c.phase);
  return r * eta;
}

export interface SimSetup {
  cols: Columns;
  mass: number; // kg
  rho: number;
  g: number;
  xG: number;
  yG: number;
  zG: number;
  T: number; // draft on this grid
  m33: number; // mass + heave added mass
  I44: number; // roll inertia incl. added
  I55: number; // pitch inertia incl. added
  b33: number;
  b44: number;
  b55: number;
  naturalPeriods: { heave: number; roll: number; pitch: number };
  smithDraft: number; // mean draft for wave pressure decay
}

export interface SimResult {
  dt: number;
  steps: number;
  /** Per step: heave of the centre of gravity (m, relative to rest), roll (rad), pitch (rad). */
  heave: Float32Array;
  roll: Float32Array;
  pitch: Float32Array;
  maxRollDeg: number;
  maxPitchDeg: number;
  maxHeave: number;
  buoyMin: number; // N
  buoyMax: number; // N
  minClearance: number; // m, deck edge above local water (negative = water on deck)
  capsized: boolean;
  run: SeaRun;
}

/** hydro: waterplane values on the same grid as `cols`. GM: transverse metacentric height (m). */
export function makeSetup(
  cols: Columns, mass: number, zG: number, rho: number, g: number,
  hydro: { Awp: number; xF: number; IL: number; GM: number; stationBeam: Float64Array }, rollDamping: number,
): SimSetup | null {
  const eq = solveLevel(cols, 0, 0, 1, mass / rho);
  if (!eq) return null;
  const { h } = cols;
  // Strip-theory heave/pitch added mass (half-circle sections), reduced for short wide hulls.
  let a33 = 0, a55 = 0;
  for (let i = 0; i < hydro.stationBeam.length; i++) {
    const b = hydro.stationBeam[i], x = (i + 0.5) * h - hydro.xF;
    a33 += (Math.PI / 8) * rho * b * b * h;
    a55 += (Math.PI / 8) * rho * b * b * x * x * h;
  }
  const slender = cols.L / Math.hypot(cols.L, cols.B);
  a33 *= slender;
  a55 *= slender;
  const m33 = mass + a33;
  const I44 = mass * (0.38 * cols.B) ** 2;
  const I55 = mass * (0.25 * cols.L) ** 2 + a55;
  const c33 = rho * g * hydro.Awp;
  const c44 = mass * g * Math.max(hydro.GM, 0.02 * cols.B);
  const c55 = rho * g * hydro.IL;
  return {
    cols, mass, rho, g, xG: eq.x, yG: eq.y, zG, T: eq.level, m33, I44, I55,
    b33: 2 * 0.3 * Math.sqrt(c33 * m33),
    b44: 2 * rollDamping * Math.sqrt(c44 * I44),
    b55: 2 * 0.3 * Math.sqrt(c55 * I55),
    naturalPeriods: {
      heave: 2 * Math.PI * Math.sqrt(m33 / c33),
      roll: 2 * Math.PI * Math.sqrt(I44 / c44),
      pitch: 2 * Math.PI * Math.sqrt(I55 / c55),
    },
    smithDraft: eq.V / hydro.Awp,
  };
}

/** hs: significant wave height (m), tp: peak period (s). Runs `periods` peak periods. */
export function simulate(s: SimSetup, hs: number, tp: number, beam: boolean, U: number, periods = 40): SimResult {
  const { cols, rho, g, xG, yG, zG } = s;
  const comps = seaComponents(hs, tp, g);
  const nc = comps.length;
  const kp = (2 * Math.PI / tp) ** 2 / g;
  const Te = (2 * Math.PI) / ((2 * Math.PI) / tp + (beam ? 0 : kp * U));
  const fastest = Math.min(s.naturalPeriods.heave, s.naturalPeriods.roll, s.naturalPeriods.pitch);
  const dt = Math.min(Te / 60, fastest / 25);
  const run: SeaRun = { comps, beam, U: beam ? 0 : U, ramp: 3 * tp };
  const steps = Math.min(30000, Math.ceil((periods * tp) / dt));
  const measureFrom = Math.floor((5 * tp) / dt);

  // The waves are long-crested, so the surface only varies along one hull axis: tabulate it per
  // grid line. "Felt" elevation includes the decay of wave pressure with depth (Smith effect).
  const lines = beam ? cols.ny : cols.nx;
  const lineXi = new Float64Array(lines);
  for (let l = 0; l < lines; l++) lineXi[l] = beam ? cols.y0 + (l + 0.5) * cols.h - yG : (l + 0.5) * cols.h - xG;
  const cs = new Float64Array(lines * nc), sn = new Float64Array(lines * nc);
  for (let l = 0; l < lines; l++)
    for (let j = 0; j < nc; j++) {
      cs[l * nc + j] = Math.cos(comps[j].k * lineXi[l]);
      sn[l * nc + j] = Math.sin(comps[j].k * lineXi[l]);
    }
  const decay = comps.map((c) => Math.exp(-c.k * s.smithDraft));
  const omegaT = comps.map((c) => (beam ? -c.omega : c.omega + c.k * U));
  const felt = new Float64Array(lines), surface = new Float64Array(lines), slope = new Float64Array(lines);
  const ct = new Float64Array(nc), st = new Float64Array(nc);
  const line = beam ? cols.iy : cols.ix;
  const ne = cols.edges.length / 3;
  const edgeLine = new Int32Array(ne);
  for (let e = 0; e < ne; e++) {
    const xi = beam ? cols.edges[e * 3 + 1] - yG : cols.edges[e * 3] - xG;
    edgeLine[e] = Math.max(0, Math.min(lines - 1, Math.round((xi - lineXi[0]) / cols.h)));
  }

  const heave = new Float32Array(steps), roll = new Float32Array(steps), pitch = new Float32Array(steps);
  const Z0 = zG - s.T; // centre of gravity above still water at rest
  let Z = Z0, vZ = 0, phi = (0.5 * Math.PI) / 180, vPhi = 0, th = 0, vTh = 0;
  let maxRoll = 0, maxPitch = 0, maxHeave = 0, buoyMin = Infinity, buoyMax = -Infinity, minClear = Infinity, capsized = false;
  const weight = s.mass * g;
  const rollRate = ((2 * Math.PI) / s.naturalPeriods.roll) * 0.2; // roll speed at which damping has doubled
  const { x, y, zb, zt, n } = cols;

  for (let it = 0; it < steps; it++) {
    const t = it * dt;
    const r = t < run.ramp ? 0.5 - 0.5 * Math.cos((Math.PI * t) / run.ramp) : 1;
    for (let j = 0; j < nc; j++) {
      const a = omegaT[j] * t + comps[j].phase;
      ct[j] = r * comps[j].amp * Math.cos(a);
      st[j] = r * comps[j].amp * Math.sin(a);
    }
    for (let l = 0; l < lines; l++) {
      let f = 0, full = 0, sl = 0;
      for (let j = 0; j < nc; j++) {
        const c = cs[l * nc + j], q = sn[l * nc + j];
        const e = ct[j] * c - st[j] * q;
        full += e;
        f += e * decay[j];
        sl -= (ct[j] * q + st[j] * c) * comps[j].k * decay[j];
      }
      felt[l] = f;
      surface[l] = full;
      slope[l] = sl;
    }
    const nx = -Math.sin(th), ny = Math.cos(th) * Math.sin(phi), nz = Math.cos(th) * Math.cos(phi);
    if (nz < 0.05) {
      capsized = true;
      heave.fill(Z - Z0, it);
      roll.fill(phi, it);
      pitch.fill(th, it);
      break;
    }
    // Horizontal wave direction in hull axes (world Y for beam waves, world X for head waves).
    const ex = beam ? 0 : Math.cos(th), ey = beam ? Math.cos(phi) : Math.sin(th) * Math.sin(phi), ez = beam ? -Math.sin(phi) : Math.sin(th) * Math.cos(phi);
    let V = 0, Mx = 0, My = 0;
    for (let i = 0; i < n; i++) {
      const rx = x[i] - xG, ry = y[i] - yG, l = line[i];
      let z1 = zG + (felt[l] - Z - nx * rx - ny * ry) / nz;
      if (z1 > zt[i]) z1 = zt[i];
      const len = z1 - zb[i];
      if (len <= 0) continue;
      const rz = zb[i] + 0.5 * len - zG;
      const sl = slope[l];
      const fx = nx - sl * ex, fy = ny - sl * ey, fz = nz - sl * ez; // local force direction
      V += len;
      Mx += len * (ry * fz - rz * fy);
      My += len * (rz * fx - rx * fz);
    }
    const F = rho * g * V * cols.dA;
    vZ += ((F - weight - s.b33 * vZ) / s.m33) * dt;
    vPhi += ((rho * g * Mx * cols.dA - s.b44 * vPhi * (1 + Math.abs(vPhi) / rollRate)) / s.I44) * dt;
    vTh += ((rho * g * My * cols.dA - s.b55 * vTh) / s.I55) * dt;
    Z += vZ * dt;
    phi += vPhi * dt;
    th += vTh * dt;
    heave[it] = Z - Z0;
    roll[it] = phi;
    pitch[it] = th;
    if (it >= measureFrom) {
      maxRoll = Math.max(maxRoll, Math.abs(phi));
      maxPitch = Math.max(maxPitch, Math.abs(th));
      maxHeave = Math.max(maxHeave, Math.abs(Z - Z0));
      buoyMin = Math.min(buoyMin, F);
      buoyMax = Math.max(buoyMax, F);
      for (let e = 0; e < ne; e++) {
        const pz = Z + nx * (cols.edges[e * 3] - xG) + ny * (cols.edges[e * 3 + 1] - yG) + nz * (cols.edges[e * 3 + 2] - zG);
        const cl = pz - surface[edgeLine[e]];
        if (cl < minClear) minClear = cl;
      }
    }
  }
  if (capsized) maxRoll = Math.PI / 2;
  if (!Number.isFinite(buoyMin)) (buoyMin = weight), (buoyMax = weight);
  if (!Number.isFinite(minClear)) minClear = 0;
  return {
    dt, steps, heave, roll, pitch,
    maxRollDeg: (maxRoll * 180) / Math.PI, maxPitchDeg: (maxPitch * 180) / Math.PI, maxHeave,
    buoyMin, buoyMax, minClearance: minClear, capsized, run,
  };
}
