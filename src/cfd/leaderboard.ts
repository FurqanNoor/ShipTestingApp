/**
 * Hackathon ranking from automatic OpenFOAM studies: one row per hull, drag + roll + stability combined.
 *
 * Fairness rules:
 * - Only the latest study of each hull counts.
 * - Hulls are ranked together only when their studies used identical settings: protocol version (solver setup),
 *   Quick/Full, backend and cores per solve. The most common settings form the reference; other hulls are listed as
 *   "different settings" and must be re-run.
 * - Every test in the reference programme must have finished. A run that stopped for numerical reasons makes the hull
 *   "incomplete" (re-run it); sinking or capsizing is a design result and counts as a failure.
 * - A hull with failures ranks below every hull without failures, whatever its score.
 *
 * Scores (as in the preview leaderboard): the best hull in each category scores 100 and the rest in proportion.
 * Drag: mean calm towing drag over the loads (lower is better). Roll: mean maximum roll over the wave tests, 90 degrees for
 * a capsize (lower is better). Stability: mean initial metacentric height GM over the loads (higher is better).
 * Total = average of the three.
 */

type R = Record<string, unknown>;
const rec = (v: unknown): R => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : {});
const arr = (v: unknown): R[] => (Array.isArray(v) ? v.map(rec) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/**
 * Solver-setup version per test type. Bump one when a change makes new results of that type incomparable with old ones;
 * results of the other type stay valid (e.g. calm runs were lengthened without changing wave runs).
 * 2026-11-18: calm outlet absorber + wave morphing-zone fix. 2026-11-18b (calm): 40 L/U runs averaged after 0.4 of the run.
 */
// calm 2026-11-18c: Courant 0.4 / 2 ms cap (the old 0.8 / 4 ms read drag 6-21% low). Older calm results are not ranked.
// calm 2026-11-19: Quick calm drag from the medium mesh (the coarse mesh read -49%..+44% off it). Older calm results are not ranked.
// waves 2026-11-19: gauges beside the hull's side with incident/reflected separation, wave-maker strength 12, recalibrated gain.
// calm 2026-11-19b: a background cell face at the still waterline (setFields had filled the tank 0-7 mm too full,
// hull-dependent, so hulls floated deeper than their weight). Older calm results are not ranked.
// calm 2026-11-19c: isoAdvector (interIsoFoam) instead of MULES. MULES let the interface creep up the hull wall, adding
// ~0.27 N lift and a few mN of forward push on fine hulls (negative pressure drag). Older calm results are not ranked.
// calm 2026-11-20: 28 L/U towing (was 40) averaged over the second half (was the last 60%), ~30% faster; force sums
// no longer printed to the solver log. Older calm results are not ranked.
export const PROTOCOLS = { calm: '2026-11-20', waves: '2026-11-19' } as const;
export const PROTOCOL_VERSION = `calm:${PROTOCOLS.calm};waves:${PROTOCOLS.waves}`;

export interface LeaderboardSettings { protocol: string; calmProtocol: string; wavesProtocol: string; speed: string; backend: string; cores: number | null }
export interface LeaderboardRow {
  name: string; studyId: string; createdAt: string; settings: LeaderboardSettings; settingsLabel: string;
  status: 'ranked' | 'incomplete' | 'different-settings';
  place: number | null; dragMN: number | null; rollDeg: number | null; gmMm: number | null; failures: number;
  scoreDrag: number | null; scoreRoll: number | null; scoreStability: number | null; total: number | null; note: string;
}

const TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled', 'interrupted']);
const DESIGN_FAILURES = new Set(['sinks', 'stability-failure']);
const modeOf = (c: R) => (str(c.mode) === 'calm' ? 'calm' : 'waves');
const shown = (p: string) => p || 'before 2026-11-18';
const protocolText = (calm: string, waves: string) => (calm === waves ? shown(calm) : `calm ${shown(calm)}, waves ${shown(waves)}`);

/** Settings recorded with a study. A single-version stamp (e.g. "2026-11-18") applies to both test types; none means older. */
export function settingsOf(study: unknown): LeaderboardSettings {
  const o = rec(rec(study).options), v = str(o.protocolVersion);
  const part = (k: string) => (/calm:|waves:/.test(v) ? new RegExp(`${k}:([^;]+)`).exec(v)?.[1] ?? '' : v);
  const calmProtocol = part('calm'), wavesProtocol = part('waves');
  return { protocol: protocolText(calmProtocol, wavesProtocol), calmProtocol, wavesProtocol,
    speed: str(o.speed) || 'full', backend: str(o.backend) || 'local', cores: num(o.cores) };
}
/** Hulls compare only at the same Quick/Full mode, backend and cores; setup versions are checked per test type. */
export const settingsKey = (s: LeaderboardSettings) => `${s.speed}|${s.backend}|${s.cores ?? ''}`;
export const settingsLabel = (s: LeaderboardSettings) =>
  `${s.speed === 'quick' ? 'Quick' : 'Full'} · ${s.backend === 'cluster' ? 'cluster' : 'this computer'} · ${s.cores ?? '?'} cores · setup ${s.protocol}`;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function cfdLeaderboard(studies: unknown[]): { rows: LeaderboardRow[]; reference: LeaderboardSettings | null; conditionIds: string[] } {
  // Studies per hull name (a re-run of some tests is a separate study of the same hull).
  const byHull = new Map<string, R[]>();
  for (const s of studies.map(rec)) {
    if (!arr(s.conditions).length) continue;
    const name = str(s.name) || 'Hull';
    byHull.set(name, [...(byHull.get(name) ?? []), s]);
  }
  // Reference settings: those used by the most hulls.
  const counts = new Map<string, { n: number; s: LeaderboardSettings }>();
  for (const list of byHull.values()) {
    for (const k of new Set(list.map(s => settingsKey(settingsOf(s))))) {
      const st = settingsOf(list.find(s => settingsKey(settingsOf(s)) === k));
      counts.set(k, { n: (counts.get(k)?.n ?? 0) + 1, s: st });
    }
  }
  const referenceBase = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.s ?? null;
  const refKey = referenceBase ? settingsKey(referenceBase) : '';
  // Reference setup per test type: the newest used at the reference settings. Older results of that type do not count.
  const atRef = studies.map(rec).filter(s => settingsKey(settingsOf(s)) === refKey).map(settingsOf);
  const newest = (k: 'calmProtocol' | 'wavesProtocol') => atRef.map(s => s[k]).sort().pop() ?? '';
  const reference: LeaderboardSettings | null = referenceBase
    ? { ...referenceBase, calmProtocol: newest('calmProtocol'), wavesProtocol: newest('wavesProtocol'), protocol: protocolText(newest('calmProtocol'), newest('wavesProtocol')) }
    : null;
  const current = (s: R, c: R) => {
    const st = settingsOf(s);
    return !!reference && (modeOf(c) === 'calm' ? st.calmProtocol === reference.calmProtocol : st.wavesProtocol === reference.wavesProtocol);
  };
  // Each hull's tests at the reference settings and current setups, newest finished result per test.
  const merged = new Map<string, { latest: R; conditions: Map<string, R>; outdated: Set<string> }>();
  for (const [name, list] of byHull) {
    const same = list.filter(s => settingsKey(settingsOf(s)) === refKey).sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)));
    if (!same.length) continue;
    const conditions = new Map<string, R>(), outdated = new Set<string>();
    for (const s of same) for (const c of arr(s.conditions)) {
      const id = str(c.id);
      if (!current(s, c)) { outdated.add(id); continue; }
      // Studies are visited oldest first: a newer real result (completed, or a sink/capsize verdict) replaces anything;
      // otherwise the newest entry stands unless a real result already exists (an interrupted or failed re-run does
      // not hide a valid earlier result, and a running re-run shows as running rather than an old interruption).
      const prev = conditions.get(id), real = (x: R) => str(x.status) === 'completed' || DESIGN_FAILURES.has(str(rec(x.hint).verdict));
      if (!prev || real(c) || !real(prev)) conditions.set(id, c);
    }
    merged.set(name, { latest: same[same.length - 1], conditions, outdated });
  }
  // Reference programme: the largest set of tests that most hulls ran.
  const programmes = new Map<string, number>();
  for (const { conditions } of merged.values()) {
    if (!conditions.size) continue;
    const k = [...conditions.keys()].sort().join(',');
    programmes.set(k, (programmes.get(k) ?? 0) + 1);
  }
  const programme = [...programmes.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] ?? '';
  const conditionIds = programme ? programme.split(',') : [];

  const rows: LeaderboardRow[] = [...byHull.entries()].map(([name, list]) => {
    const m = merged.get(name);
    const s = m?.latest ?? [...list].sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)))[0];
    const settings = settingsOf(s);
    const base = { name, studyId: str(s.id), createdAt: str(s.createdAt), settings, settingsLabel: settingsLabel(settings),
      place: null, dragMN: null, rollDeg: null, gmMm: null, failures: 0, scoreDrag: null, scoreRoll: null, scoreStability: null, total: null };
    if (!m)
      return { ...base, status: 'different-settings' as const, note: `Tested with different settings (${settingsLabel(settings)}). Re-run with ${reference ? settingsLabel(reference) : 'the reference settings'}.` };
    const missing = conditionIds.filter(id => !m.conditions.has(id));
    if (missing.length) {
      const old = missing.filter(id => m.outdated.has(id)), never = missing.filter(id => !m.outdated.has(id));
      const note = old.length
        ? `Re-run with the current solver setup: ${old.join(', ')}${never.length ? `; not tested: ${never.join(', ')}` : ''}.`
        : `Not tested: ${missing.join(', ')}. Run the same tests as the other hulls.`;
      return { ...base, status: 'incomplete' as const, note };
    }
    const byId = m.conditions;
    const drag: number[] = [], roll: number[] = [], gm: number[] = [], rerun: string[] = [];
    let failures = 0;
    for (const id of conditionIds) {
      const c = byId.get(id)!, m = rec(rec(c.result).metrics), verdict = str(rec(c.hint).verdict), status = str(c.status);
      if (!TERMINAL.has(status)) { rerun.push(`${id} still running`); continue; }
      if (DESIGN_FAILURES.has(verdict)) { failures++; if (str(c.mode) !== 'calm') roll.push(90); continue; }
      if (status !== 'completed') { rerun.push(`${id} ${status}`); continue; }
      const g = num(m.initialGmM);
      if (g !== null) gm.push(g * 1000);
      if (str(c.mode) === 'calm') { const d = num(m.meanDragN); if (d === null) rerun.push(`${id} has no drag`); else drag.push(d * 1000); }
      else { const r = num(m.maxRollDeg); if (r === null) rerun.push(`${id} has no roll`); else roll.push(Math.abs(r)); }
    }
    if (rerun.length) {
      const running = rerun.filter(x => x.endsWith('still running')).map(x => x.replace(/ still running$/, '')), redo = rerun.filter(x => !x.endsWith('still running'));
      const note = [redo.length ? `Re-run needed: ${redo.join('; ')}.` : '', running.length ? `Still running: ${running.join(', ')}.` : ''].filter(Boolean).join(' ');
      return { ...base, failures, status: 'incomplete' as const, note };
    }
    return { ...base, failures, status: 'ranked' as const, dragMN: mean(drag), rollDeg: mean(roll), gmMm: mean(gm),
      note: failures ? `${failures} test${failures === 1 ? '' : 's'} failed (sinks or capsizes); ranked below hulls without failures.` : '' };
  });

  const ranked = rows.filter(r => r.status === 'ranked');
  const best = (pick: (r: LeaderboardRow) => number | null, lower: boolean) => {
    const xs = ranked.map(pick).filter((x): x is number => x !== null && x > 0);
    return xs.length ? (lower ? Math.min(...xs) : Math.max(...xs)) : null;
  };
  const bDrag = best(r => r.dragMN, true), bRoll = best(r => r.rollDeg === null ? null : Math.max(r.rollDeg, .1), true), bGm = best(r => r.gmMm, false);
  for (const r of ranked) {
    r.scoreDrag = bDrag !== null && r.dragMN !== null && r.dragMN > 0 ? (100 * bDrag) / r.dragMN : null;
    r.scoreRoll = bRoll !== null && r.rollDeg !== null ? (100 * bRoll) / Math.max(r.rollDeg, .1) : null;
    r.scoreStability = bGm !== null && r.gmMm !== null ? Math.max(0, (100 * r.gmMm) / bGm) : null;
    const parts = [r.scoreDrag, r.scoreRoll, r.scoreStability].filter((x): x is number => x !== null);
    r.total = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  }
  ranked.sort((a, b) => a.failures - b.failures || (b.total ?? -1) - (a.total ?? -1));
  ranked.forEach((r, i) => { r.place = i + 1; });
  const others = rows.filter(r => r.status !== 'ranked').sort((a, b) => a.name.localeCompare(b.name));
  return { rows: [...ranked, ...others], reference, conditionIds };
}
