// Hull Test Bench: app state, STL upload, results panel, Excel download.
import { ModelResult, WeightResult, analyzeModel, rankModels } from "../engine/analyze";
import { Conditions, REFERENCE, REFERENCE_MODEL_MM, SCALE, SIZE_LIMIT_MM, defaultConditions, tankChecks, waveLength, withinSizeLimit } from "../engine/conditions";
import { exampleHull } from "../engine/example";
import { FLIP, IDENTITY, Mat3, ROLL90, TURN90, autoOrient, guessUnitScale, mul, place } from "../engine/orient";
import { parseSTL } from "../engine/stl";
import { buildWorkbook } from "../report";
import { Rest, View3D } from "./view3d";
import { attachCfdPanel,type CfdSelection } from "./cfdPanel";
import {attachAutomaticPanel} from "./automaticPanel";
import { cfdLeaderboard } from "../cfd/leaderboard";

interface Model {
  id: number;
  name: string;
  file: string;
  example: boolean;
  raw: Float32Array;
  unit: number; // file unit in mm
  orient: Mat3;
  placed: Float32Array;
  size: [number, number, number];
  result: ModelResult | null;
  error: string | null;
  run: number;
  shape: number; // bumps when the placed mesh changes
}

const state = {
  models: [] as Model[],
  sel: -1,
  weight: 1,
  water: 2, // 0 = calm, 1..3 = sea presets
  heading: "head" as "head" | "beam",
  cond: defaultConditions() as Conditions,
  editing: false,
  busy: 0,
};
let nextId = 1;
let shown = "";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** Escaped text with line-break points after underscores (file names like 02_Wide_Flat_Bottom_Scow have no spaces). */
const breakable = (s: string) => esc(s).replace(/_/g, "_<wbr>");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
const current = () => state.models.find((m) => m.id === state.sel) ?? null;

const view = new View3D($<HTMLCanvasElement>("view"));
view.setTank(state.cond.tank);
view.onLive = (l) => {
  $("live").innerHTML = `<span>Roll <b>${f(l.rollDeg)}&deg;</b></span><span>Pitch <b>${f(l.pitchDeg)}&deg;</b></span><span>Heave <b>${f(l.heaveMm)} mm</b></span>`;
};

// ---------- models ----------

function addModel(name: string, file: string, raw: Float32Array, example = false, placed = false): Model {
  // placed: geometry restored from an OpenFOAM study is already in mm and oriented exactly as it was tested.
  const unit = example || placed ? 1 : guessUnitScale(raw);
  const orient = example || placed ? IDENTITY : autoOrient(raw);
  const p = place(raw, orient, unit);
  const m: Model = { id: nextId++, name, file, example, raw, unit, orient, placed: p.tris, size: p.size, result: null, error: null, run: 0, shape: 0 };
  state.models.push(m);
  return m;
}

async function runModel(m: Model) {
  const run = ++m.run;
  const p = place(m.raw, m.orient, m.unit);
  m.placed = p.tris;
  m.size = p.size;
  m.shape++;
  m.result = null;
  m.error = null;
  state.busy++;
  render();
  setProgress(0.02);
  try {
    const result = await analyzeModel(m.placed, structuredClone(state.cond), (frac) => m.id === state.sel && run === m.run && setProgress(frac));
    if (run === m.run) m.result = result;
  } catch (e) {
    if (run === m.run) m.error = e instanceof Error ? e.message : String(e);
  }
  state.busy--;
  if (!state.busy) setProgress(null);
  render();
}

async function addFiles(files: File[]) {
  const stl = files.filter((x) => /\.stl$/i.test(x.name));
  if (!stl.length) return toast("Choose STL files (.stl).");
  const added: Model[] = [];
  for (const file of stl) {
    try {
      const raw = parseSTL(await file.arrayBuffer());
      added.push(addModel(file.name.replace(/\.stl$/i, ""), file.name, raw));
    } catch (e) {
      toast(`${file.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!added.length) return;
  state.models = state.models.filter((m) => !m.example);
  state.sel = added[0].id;
  for (const m of added) await runModel(m);
}

function removeModel(id: number) {
  const m = state.models.find((x) => x.id === id);
  if (m && !m.example) dismissHull(m.name);
  if (m) m.run++;
  state.models = state.models.filter((x) => x.id !== id);
  if (state.sel === id) state.sel = state.models[0]?.id ?? -1;
  if (!state.models.length) loadExample();
  else render();
}

function loadExample() {
  const m = addModel("Example hull", "built-in example", exampleHull(), true);
  state.sel = m.id;
  void runModel(m);
}

async function rerunAll() {
  for (const m of state.models) { m.run++; m.result = null; }
  render();
  for (const m of [...state.models]) await runModel(m);
}

// ---------- rendering ----------

function setProgress(frac: number | null) {
  $("progress").hidden = frac === null;
  if (frac !== null) $("progress-fill").style.width = `${Math.round(frac * 100)}%`;
}

let toastTimer = 0;
function toast(text: string) {
  $("toast").textContent = text;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ($("toast").textContent = ""), 6000);
}

function verdict(w: WeightResult): { cls: string; text: string } {
  if (!w.floats) return { cls: "bad", text: "Sinks at this weight" };
  if (!w.stable) return { cls: "bad", text: "Tips over: not stable upright" };
  const cap = w.waves.find((v) => v.capsized);
  if (cap) return { cls: "bad", text: `Capsizes in ${cap.label.toLowerCase()} waves` };
  const wet = w.waves.find((v) => !v.deckDry);
  if (wet) return { cls: "warn", text: `Floats upright, water on deck in ${wet.label.toLowerCase()} waves` };
  return { cls: "ok", text: "Floats upright, deck stays dry" };
}

function tile(k: string, v: string, unit: string, sub = "", bad = false) {
  return `<div class="tile${bad ? " bad" : ""}"><div class="k">${k}</div><div class="v">${v}<small>${unit}</small></div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
}

function gzChart(w: WeightResult): string {
  const W = 400, H = 128, L = 34, R = 8, T = 8, B = 20;
  const mm = w.gz.gz.map((g) => g * 1000);
  const hi = Math.max(1e-6, ...mm), lo = Math.min(0, ...mm);
  const x = (d: number) => L + ((W - L - R) * d) / 90;
  const y = (v: number) => T + ((H - T - B) * (hi - v)) / (hi - lo);
  const pts = w.gz.deg.map((d, i) => `${x(d).toFixed(1)},${y(mm[i]).toFixed(1)}`);
  const iMax = mm.indexOf(Math.max(...mm));
  const ticks = [0, 15, 30, 45, 60, 75, 90];
  const deck = w.gz.deckEdgeDeg;
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Righting arm against heel angle">
    ${ticks.map((t) => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}"/><text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="middle">${t}&deg;</text>`).join("")}
    <line class="grid" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>
    ${hi > 1e-3 ? `<text class="axis" x="${L - 5}" y="${y(hi) + 3}" text-anchor="end">${f(hi, hi < 10 ? 1 : 0)}</text>` : ""}
    ${lo < -1e-3 && y(lo) - y(0) > 12 ? `<text class="axis" x="${L - 5}" y="${y(lo) + 3}" text-anchor="end">${f(lo, lo > -10 ? 1 : 0)}</text>` : ""}
    ${hi <= 1e-3 || y(0) - y(hi) > 12 ? `<text class="axis" x="${L - 5}" y="${y(0) + 3}" text-anchor="end">0</text>` : ""}
    <text class="axis" x="${W - R}" y="${T + 8}" text-anchor="end">righting arm, mm</text>
    <polygon class="area" points="${x(0)},${y(0)} ${pts.join(" ")} ${x(w.gz.deg[w.gz.deg.length - 1] ?? 0)},${y(0)}"/>
    <polyline class="curve" points="${pts.join(" ")}"/>
    ${deck > 0 && deck < 90 ? `<line class="mark" x1="${x(deck)}" x2="${x(deck)}" y1="${T}" y2="${H - B}"/><text class="marklabel" x="${x(deck) + 4}" y="${H - B - 5}">deck edge under</text>` : ""}
    ${iMax >= 0 ? `<circle class="pt" cx="${x(w.gz.deg[iMax])}" cy="${y(mm[iMax])}" r="3.5"/>` : ""}
  </svg></div>`;
}

function panelHtml(m: Model): string {
  const [L, B, H] = m.size;
  const over = !withinSizeLimit([L, B, H]);
  let html = `<div class="sec">
    <div class="model-name">${esc(m.name)}</div>
    <div class="model-meta"><span>${f(L)} &times; ${f(B)} &times; ${f(H)} mm</span>
      <span class="pill ${over ? "bad" : "ok"}">${over ? `Over the ${SIZE_LIMIT_MM} mm limit` : `Within ${SIZE_LIMIT_MM} &times; ${SIZE_LIMIT_MM} &times; ${SIZE_LIMIT_MM} mm`}</span>
      ${m.example ? `<span class="pill info">Built-in example, add your STL to replace it</span>` : ""}</div>`;
  if (m.error) return html + `<p class="note bad">${esc(m.error)}</p></div>` + conditionsHtml();
  if (!m.result) return html + `<p class="note"><span class="spin"></span>Testing this hull at 3 weights in calm water and 3 seas&hellip;</p></div>` + conditionsHtml();
  const r = m.result;
  const w = r.weights[state.weight] ?? r.weights[0];
  const v = verdict(w);
  if (r.sealedOpenSurface) html += `<p class="note">This STL is an open surface, so it was closed at the deck edge.</p>`;
  html += `<div class="seg" role="group" aria-label="Weight">${state.cond.weights
    .map((c, i) => `<button type="button" data-weight="${i}" aria-pressed="${i === state.weight}" title="${esc(c.note)}"><b>${f(c.grams, c.grams % 1 ? 1 : 0)} g</b><small>${esc(c.label)}</small></button>`)
    .join("")}</div>
    <div class="verdict"><span class="pill ${v.cls}">${v.text}</span></div></div>`;

  if (!w.floats) {
    html += `<div class="sec"><h2>Buoyancy</h2><div class="tiles">${tile("Max load", f(r.maxLoadG, 0), "g", "before the deck edge goes under", true)}${tile("Hull volume", f(r.volumeCm3, 0), "cm&sup3;")}</div>
      <p class="note">The hull cannot carry ${f(w.grams, 1)} g. Make it larger or lighter loaded.</p></div>`;
  } else {
    html += `<div class="sec"><h2>Buoyancy</h2><div class="tiles">
      ${tile("Draft", f(w.draftMm), "mm", "under water")}
      ${tile("Freeboard", f(w.freeboardMm), "mm", "deck above water", w.freeboardMm <= 0)}
      ${tile("Buoyancy", f(w.buoyancyN, 3), "N", `${f(w.displacedCm3)} cm&sup3;`)}
      ${tile("Max load", f(r.maxLoadG, 0), "g", `${f(w.reservePct, 0)} % spare`)}
    </div></div>`;
    html += `<div class="sec"><h2>Roll stability <span>righting arm vs heel angle</span></h2><div class="tiles">
      ${tile("Evaluated GZ limit", w.stable ? (w.gz.capsizeDeg >= 90 ? "&gt;90" : f(w.gz.capsizeDeg, 0)) : "0", "&deg;", "", !w.stable)}
      ${tile("Deck edge under at", f(w.gz.deckEdgeDeg, 0), "&deg;")}
      ${tile("Stiffness (GM)", f(w.GMmm), "mm", Number.isFinite(w.rollPeriodS) ? `roll period ${f(w.rollPeriodS, 2)} s` : "", w.GMmm <= 0)}
    </div>${gzChart(w)}</div>`;
    const rows = [
      { i: 0, label: "Calm", sub: "flat water", drag: w.calm.total, ct: w.calm.CT, roll: "0.0&deg;", rollCls: "", buoy: f(w.buoyancyN, 3), deck: "Dry", deckCls: "ok" },
      ...w.waves.map((s, k) => ({
        i: k + 1, label: s.label, sub: `${f(s.heightMm)} mm, ${f(s.periodS, 2)} s`, drag: s.dragN, ct: s.CT,
        roll: s.capsized ? "Capsized" : `${f(s.maxRollDeg)}&deg;`, rollCls: s.capsized ? "bad" : "",
        buoy: `${f(s.buoyMinN, 2)}&ndash;${f(s.buoyMaxN, 2)}`, deck: s.deckDry ? "Dry" : "Wet", deckCls: s.deckDry ? "ok" : "warn",
      })),
    ];
    html += `<div class="sec"><h2>Drag and waves <span>at ${f(state.cond.speed, 2)} m/s</span></h2><div class="tablewrap"><table>
      <thead><tr><th>Water</th><th>Drag force<br>mN</th><th>Drag<br>coeff.</th><th>Max<br>roll</th><th>Buoyancy<br>N</th><th>Deck</th></tr></thead><tbody>
      ${rows.map((x) => `<tr class="pick" tabindex="0" role="button" data-water="${x.i}" aria-selected="${x.i === state.water}" aria-label="Show ${x.label} in the tank">
        <td>${x.label}<small>${x.sub}</small></td><td class="num">${f(x.drag * 1000, 2)}</td><td>${f(x.ct, 4)}</td><td class="num ${x.rollCls}">${x.roll}</td><td>${x.buoy}</td><td class="${x.deckCls}">${x.deck}</td></tr>`).join("")}
      </tbody></table></div><p class="note">Select a row to play it in the tank.</p></div>`;
  }
  return html + boardsHtml() + conditionsHtml();
}

// ---------- leaderboards: instant estimate (this page) and OpenFOAM (solver results), side by side ----------
let cfdStudies: unknown[] | null = null;
function boardsHtml(): string {
  return `<div class="boards">${leaderboardHtml()}<div class="sec" id="cfd-board">${cfdBoardInner()}</div></div>`;
}
function cfdBoardInner(): string {
  if (cfdStudies === null) return `<h2>OpenFOAM ranking <span>solver results</span></h2><p class="note">Start the app with <code>npm run cfd</code> to see OpenFOAM results here.</p>`;
  const { rows, reference } = cfdLeaderboard(cfdStudies);
  if (!rows.length) return `<h2>OpenFOAM ranking <span>solver results</span></h2><p class="note">No OpenFOAM results yet. Use <b>OpenFOAM → Run automatic tests</b>, or import another judge's results.</p>${cfdBoardActions()}`;
  const n = (v: number | null, d = 1) => (v === null ? "-" : v.toFixed(d));
  const cell = (value: string, score: number | null) => `<td>${value}<small>${score === null ? "" : `${n(score, 0)} pts`}</small></td>`;
  const ranked = rows.filter((r) => r.status === "ranked").length, waiting = rows.filter((r) => r.status === "incomplete").length;
  const provisional = waiting && ranked ? `<p class="note" style="color:var(--warn, #c90)"><b>Provisional:</b> ${ranked} of ${ranked + waiting} hulls finished. Points are relative to the best finished hull in each column, so they change as the others finish.</p>` : "";
  const tag = (r: (typeof rows)[number]) => r.status === "ranked" ? (r.failures ? `<small style="color:var(--bad)">${r.failures} failed test${r.failures > 1 ? "s" : ""}</small>` : "") : `<small style="color:var(--warn, #c90)">${r.status === "incomplete" ? "Not ranked yet" : "Different settings"}</small>`;
  return `<h2>OpenFOAM ranking <span>CFD solver results</span></h2>${provisional}<div class="tablewrap"><table>
    <thead><tr><th>#</th><th style="text-align:left">Hull</th><th>Calm drag<br>mN</th><th>Max roll<br>deg</th><th>GM<br>mm</th><th>Score</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.place === 1 && rows.length > 1 && !provisional ? "first" : ""}" title="${esc(r.note || r.settingsLabel)}"><td><span class="place">${r.place ?? "—"}</span></td><td style="text-align:left;white-space:normal">${breakable(r.name)}${tag(r)}</td>
      ${cell(n(r.dragMN, 2), r.scoreDrag)}${cell(n(r.rollDeg), r.scoreRoll)}${cell(n(r.gmMm), r.scoreStability)}<td class="num">${n(r.total, 0)}</td></tr>`).join("")}
    </tbody></table></div><p class="note">Score = average of drag, roll and stability (one third each). Best in each category = 100 points, the rest in proportion; a hull that sinks or capsizes ranks below all hulls without failures. ${reference ? `Compared at: ${esc(reference.speed === "quick" ? "Quick" : "Full")} · ${reference.cores ?? "?"} cores · setup ${esc(reference.protocol)}.` : ""} Hover a row for details.</p>${cfdBoardActions()}`;
}
/** Judges combine results: export every finished study (with the tested hull shape) to a file; import others' files. */
function cfdBoardActions(): string {
  return `<div class="board-actions"><a class="btn small" href="/api/cfd/export" download title="Save every finished test (with the hull shapes) to one file for another judge">Export results</a><label class="btn small" for="cfd-import-file" title="Add another judge's exported results to this ranking">Import results</label><span class="note" id="cfd-import-status" role="status"></span></div>`;
}
// The file input lives outside the board, which re-renders every 30 s (a re-render during the file dialog lost the file).
const cfdImportInput = Object.assign(document.createElement("input"), { type: "file", id: "cfd-import-file", accept: ".json,application/json", multiple: true, hidden: true });
document.body.append(cfdImportInput);
cfdImportInput.addEventListener("change", async () => {
  const input = cfdImportInput;
  if (!input.files?.length) return;
  const status = () => document.getElementById("cfd-import-status");
  const say = (t: string) => { const el = status(); if (el) el.textContent = t; };
  let added = 0, skipped = 0, invalid = 0;
  try {
    for (const file of Array.from(input.files)) {
      say(`Importing ${file.name}…`);
      const r = await fetch("/api/cfd/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      const d = await r.json().catch(() => ({})) as { added?: number; skipped?: number; invalid?: number; error?: string };
      if (!r.ok) throw new Error(d.error ?? `Import failed (${r.status}).`);
      added += d.added ?? 0; skipped += d.skipped ?? 0; invalid += d.invalid ?? 0;
    }
    restoredOnce = false;
    await refreshCfdBoard();
    say(`Imported ${added} stud${added === 1 ? "y" : "ies"}${skipped ? `, ${skipped} already here` : ""}${invalid ? `, ${invalid} unreadable` : ""}.`);
  } catch (e) { say(e instanceof Error ? e.message : String(e)); }
  input.value = "";
});
// ---------- hulls with OpenFOAM tests come back after a reload ----------
// The workbench only lives in this tab; studies (and their exact tested geometry) live on the server. On load, every hull
// with a study is put back. Closing one (x) hides it until it gets a newer study.
const DISMISSED_KEY = "hull-bench-dismissed-hulls";
function dismissed(): Record<string, string> { try { return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "{}") ?? {}; } catch { return {}; } }
function newestStudyOf(name: string): { id: string; createdAt: string } | null {
  const own = (cfdStudies ?? []).map((x) => x as { id?: string; name?: string; createdAt?: string }).filter((x) => x.name === name && x.id);
  own.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return own[0] ? { id: String(own[0].id), createdAt: String(own[0].createdAt ?? "") } : null;
}
function dismissHull(name: string) {
  const s = newestStudyOf(name);
  if (!s) return;
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify({ ...dismissed(), [name]: s.createdAt })); } catch { /* per-browser convenience */ }
}
let restoredOnce = false;
async function restoreTestedHulls() {
  if (restoredOnce || !cfdStudies) return;
  restoredOnce = true;
  const hidden = dismissed(), have = new Set(state.models.map((m) => m.name));
  const names = [...new Set(cfdStudies.map((x) => String((x as { name?: string }).name ?? "")).filter(Boolean))].sort();
  const added: Model[] = [];
  for (const name of names) {
    const s = newestStudyOf(name);
    if (!s || have.has(name) || (hidden[name] && hidden[name] >= s.createdAt)) continue;
    try {
      const r = await fetch(`/api/cfd/studies/${s.id}/geometry`);
      if (!r.ok) continue;
      const g = await r.json() as { trianglesMm?: number[] };
      if (!Array.isArray(g.trianglesMm) || !g.trianglesMm.length || g.trianglesMm.length % 9) continue;
      added.push(addModel(name, `${name}.stl`, Float32Array.from(g.trianglesMm), false, true));
    } catch { /* leave the workbench as it is */ }
  }
  if (!added.length) return;
  const wasExample = current()?.example ?? true;
  state.models = state.models.filter((m) => !m.example);
  if (wasExample) state.sel = added[0].id;
  render();
  for (const m of added) await runModel(m);
}
async function refreshCfdBoard() {
  try {
    const r = await fetch("/api/cfd/studies");
    if (!r.ok) return;
    const d = await r.json();
    cfdStudies = Array.isArray(d) ? d : Array.isArray(d?.studies) ? d.studies : [];
    const el = document.getElementById("cfd-board");
    if (el) el.innerHTML = cfdBoardInner();
    void restoreTestedHulls();
  } catch { /* plain preview build without the OpenFOAM server */ }
}
void refreshCfdBoard();
setInterval(() => void refreshCfdBoard(), 30_000);

function ranked() {
  const pool = state.models.filter((m) => m.result);
  const real = pool.filter((m) => !m.example);
  return (real.length ? real : pool).map((m) => ({ name: m.name, file: m.file, result: m.result! }));
}

function leaderboardHtml(): string {
  const rows = rankModels(ranked());
  if (!rows.length) return `<div class="sec"><h2>Instant estimate ranking <span>quick preview · not CFD</span></h2><p class="note">Add STL files to compare them instantly.</p></div>`;
  const cell = (value: string, score: number) => `<td>${value}<small>${f(score, 0)} pts</small></td>`;
  return `<div class="sec"><h2>Instant estimate ranking <span>quick preview · not CFD</span></h2><div class="tablewrap"><table>
    <thead><tr><th>#</th><th style="text-align:left">Model</th><th>Avg drag<br>mN</th><th>Avg max<br>roll</th><th>Max load<br>g</th><th>Score</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.place === 1 && rows.length > 1 ? "first" : ""}"><td><span class="place">${r.place || "—"}</span></td><td style="text-align:left;white-space:normal">${breakable(r.name)}${r.failures ? `<small style="color:var(--bad)">${r.failures} failed case${r.failures > 1 ? "s" : ""}</small>` : ""}</td>
      ${cell(f(r.dragMN, 2), r.scoreDrag)}${cell(Number.isFinite(r.rollDeg) ? `${f(r.rollDeg)}&deg;` : "-", r.scoreRoll)}${cell(f(r.maxLoadG, 0), r.scoreLoad)}<td class="num">${f(r.total, 0)}</td></tr>`).join("")}
    </tbody></table></div><p class="note">${rows.length > 1 ? "Best in each category scores 100 points, the rest in proportion. Score is the average of drag, roll and max load." : "Add more STL files to rank designs against each other."}</p></div>`;
}

function conditionsHtml(): string {
  const c = state.cond;
  const checks = tankChecks(c);
  const allOk = checks.every((k) => k.ok);
  let body: string;
  if (state.editing) {
    body = `<form class="form" id="cond-form">
      <div class="row"><label>Weights (g)</label>${c.weights.map((w, i) => `<input id="cw${i}" type="number" min="0.1" step="0.1" value="${w.grams}" aria-label="${esc(w.label)} weight in grams">`).join("")}</div>
      <div class="row"><label>Wave height (mm)</label>${c.waves.map((w, i) => `<input id="ch${i}" type="number" min="0" step="0.1" value="${w.heightMm}" aria-label="${esc(w.label)} wave height in mm">`).join("")}</div>
      <div class="row"><label>Wave period (s)</label>${c.waves.map((w, i) => `<input id="cp${i}" type="number" min="0.05" step="0.01" value="${w.periodS}" aria-label="${esc(w.label)} wave period in seconds">`).join("")}</div>
      <div class="row"><label for="cs">Speed (m/s)</label><input id="cs" type="number" min="0.01" step="0.01" value="${c.speed}"><span></span><span></span></div>
      <div class="row"><label for="cg">Centre of gravity</label><select id="cg" style="grid-column: span 2"><option value="auto"${c.cgMode === "auto" ? " selected" : ""}>Centre of model volume</option><option value="percent"${c.cgMode === "percent" ? " selected" : ""}>% of model height</option></select><input id="cgp" type="number" min="1" max="150" step="1" value="${c.cgPercent}" aria-label="Centre of gravity height in percent of model height"></div>
      <div class="buttons"><button class="btn small primary" type="submit">Apply and re-test</button><button class="btn small" type="button" data-act="cond-reset">Reset to defaults</button><button class="btn small" type="button" data-act="cond-cancel">Cancel</button></div>
    </form>`;
  } else {
    body = `<dl class="cond">
      <dt>Scale</dt><dd>1:${f(SCALE, 0)}<small>${REFERENCE.lengthM} m reference ferry scaled to a ${REFERENCE_MODEL_MM} mm model · entries up to ${SIZE_LIMIT_MM} &times; ${SIZE_LIMIT_MM} &times; ${SIZE_LIMIT_MM} mm</small></dd>
      <dt>Weights</dt><dd>${c.weights.map((w) => `${f(w.grams, w.grams % 1 ? 1 : 0)} g`).join(" &middot; ")}<small>Empty ship &middot; with luggage, fuel and cargo &middot; double load</small></dd>
      <dt>Seas</dt><dd>${c.waves.map((w) => `${f(w.heightMm)} mm / ${f(w.periodS, 2)} s`).join(" &middot; ")}<small>2 m, 4 m and 6 m seas at full size. Natural irregular waves, identical for every model. Longest ${f(Math.max(...c.waves.map((w) => waveLength(w.periodS))) * 1000, 0)} mm.</small></dd>
      <dt>Speed</dt><dd>${f(c.speed, 2)} m/s<small>${REFERENCE.speedKn} knots at full size. Drag is measured heading into the waves, roll with waves from the side.</small></dd>
      <dt>Tank</dt><dd>${c.tank.lengthM} &times; ${c.tank.widthM} &times; ${c.tank.depthM} m deep <span class="pill ${allOk ? "ok" : "bad"}">${allOk ? "open-water assumption" : "domain checks unmet"}</span>
        <small>${checks.map((k) => `${k.name} ${k.text}`).join(" &middot; ")}</small></dd>
      <dt>Centre of gravity</dt><dd>${c.cgMode === "auto" ? "Centre of the model's volume" : `${c.cgPercent} % of model height`}<small>Load placed so the ship floats level. Fresh water.</small></dd>
    </dl><div style="margin-top:12px"><button class="btn small" type="button" data-act="cond-edit">Change conditions</button></div>`;
  }
  return `<details class="sec" id="cond"${state.editing || condOpen ? " open" : ""}><summary>Test conditions<span>same for every model</span></summary>${body}</details>`;
}
let condOpen = false;

function render() {
  // model tabs
  $("chips").innerHTML = state.models
    .map((m) => {
      const dot = m.error ? "bad" : !m.result ? "busy" : m.result.score.failures ? "bad" : "ok";
      return `<button class="chip" type="button" role="tab" data-model="${m.id}" aria-selected="${m.id === state.sel}"><span class="dot ${dot}"></span>${esc(m.name)}${m.example ? "" : `<span class="x" data-remove="${m.id}" role="button" aria-label="Remove ${esc(m.name)}" title="Remove">&times;</span>`}</button>`;
    })
    .join("");
  const m = current();
  const panel = $("panel");
  const scroll = panel.scrollTop;
  panel.innerHTML = m ? panelHtml(m) : `<div class="empty">Add an STL file to test a hull.</div>${boardsHtml()}`;
  panel.scrollTop = scroll;

  // stage controls
  const pressed = (on: boolean) => `aria-pressed="${on}"`;
  $("orient").innerHTML = m
    ? `<div class="group" title="Deck up, bow at the orange arrow"><span class="cap">Deck up, bow at arrow</span><button type="button" data-act="flip" title="Turn the model upside down">Flip</button><button type="button" data-act="roll" title="Quarter turn about the length axis">Roll 90&deg;</button><button type="button" data-act="turn" title="Quarter turn about the vertical axis">Turn 90&deg;</button>
       ${m.example ? "" : `<select id="unit" aria-label="STL unit" title="Unit of the STL file">${[[1, "mm"], [10, "cm"], [25.4, "inch"], [1000, "m"]].map(([u, n]) => `<option value="${u}"${m.unit === u ? " selected" : ""}>STL in ${n}</option>`).join("")}</select>`}</div>`
    : "";
  $("playbar").innerHTML = `
    <div class="group"><button type="button" data-act="play" aria-label="${view.playing ? "Pause" : "Play"}">${view.playing ? "Pause" : "Play"}</button>
      ${[0.25, 0.5, 1].map((s) => `<button type="button" data-speed="${s}" ${pressed(view.speed === s)} title="Playback speed">${s === 1 ? "1" : s === 0.5 ? "&frac12;" : "&frac14;"}&times;</button>`).join("")}</div>
    <div class="group"><span class="cap">Water</span>${["Calm", ...state.cond.waves.map((w) => w.label)].map((n, i) => `<button type="button" data-water="${i}" ${pressed(state.water === i)}>${esc(n)}</button>`).join("")}</div>
    <div class="group"><span class="cap">Waves from</span><button type="button" data-heading="head" ${pressed(state.heading === "head")}>Ahead</button><button type="button" data-heading="beam" ${pressed(state.heading === "beam")}>Side</button></div>
    <div class="group"><button type="button" data-act="fit">Reset view</button></div>
    <div class="tank-note">Tank ${state.cond.tank.lengthM} &times; ${state.cond.tank.widthM} &times; ${state.cond.tank.depthM} m<br>open-water conditions</div>`;
  ($("excel") as HTMLButtonElement).disabled = !ranked().length;
  syncView();
}

function syncView() {
  const m = current();
  if (!m) return;
  const w = m.result?.weights[state.weight];
  let rest: Rest;
  if (w?.floats) rest = w.rest;
  else if (w) rest = { xG: m.size[0] / 2, yG: 0, zG: m.size[2] / 2, draft: m.size[2] + 3 };
  else rest = { xG: m.size[0] / 2, yG: 0, zG: m.size[2] / 2, draft: m.size[2] * 0.4 };
  const sea = state.water > 0 && w?.floats ? w.waves[state.water - 1] : null;
  view.setCase(rest, sea ? (state.heading === "beam" ? sea.beam : sea.head) : null, sea?.heightMm ?? 1);
  const key = `${m.id}:${m.shape}`;
  if (key !== shown) {
    view.setHull(m.placed, m.size[0], shown.split(":")[0] !== String(m.id) || !m.result);
    shown = key;
  }
}

// ---------- events ----------

document.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const el = t.closest<HTMLElement>("[data-remove],[data-model],[data-weight],[data-water],[data-heading],[data-speed],[data-act]");
  if (!el) return;
  const d = el.dataset;
  const m = current();
  if (d.remove) return removeModel(+d.remove);
  if (d.model) state.sel = +d.model;
  else if (d.weight) state.weight = +d.weight;
  else if (d.water) state.water = +d.water;
  else if (d.heading) state.heading = d.heading as "head" | "beam";
  else if (d.speed) view.speed = +d.speed;
  else if (d.act === "play") view.playing = !view.playing;
  else if (d.act === "fit") return view.resetCamera();
  else if (d.act === "flip" && m) return ((m.orient = mul(FLIP, m.orient)), void runModel(m));
  else if (d.act === "roll" && m) return ((m.orient = mul(ROLL90, m.orient)), void runModel(m));
  else if (d.act === "turn" && m) return ((m.orient = mul(TURN90, m.orient)), void runModel(m));
  else if (d.act === "cond-edit") state.editing = true;
  else if (d.act === "cond-cancel") state.editing = false;
  else if (d.act === "cond-reset") {
    state.cond = defaultConditions();
    state.editing = false;
    view.setTank(state.cond.tank);
    return void rerunAll();
  }
  render();
});
document.addEventListener("keydown", (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>("tr.pick");
  if (row && (ev.key === "Enter" || ev.key === " ")) {
    ev.preventDefault();
    row.click();
  }
});
document.addEventListener("toggle", (ev) => {
  if ((ev.target as HTMLElement).id === "cond") condOpen = (ev.target as HTMLDetailsElement).open;
}, true);
document.addEventListener("change", (ev) => {
  const t = ev.target as HTMLSelectElement;
  const m = current();
  if (t.id === "unit" && m) {
    m.unit = +t.value;
    void runModel(m);
  }
});
document.addEventListener("submit", (ev) => {
  if ((ev.target as HTMLElement).id !== "cond-form") return;
  ev.preventDefault();
  const num = (id: string, fallback: number, min: number) => {
    const v = parseFloat($<HTMLInputElement>(id).value);
    return Number.isFinite(v) && v >= min ? v : fallback;
  };
  const c = structuredClone(state.cond);
  c.weights.forEach((w, i) => (w.grams = num(`cw${i}`, w.grams, 0.1)));
  c.waves.forEach((w, i) => ((w.heightMm = num(`ch${i}`, w.heightMm, 0)), (w.periodS = num(`cp${i}`, w.periodS, 0.05))));
  c.speed = num("cs", c.speed, 0.01);
  c.cgMode = $<HTMLSelectElement>("cg").value === "percent" ? "percent" : "auto";
  c.cgPercent = num("cgp", c.cgPercent, 1);
  // keep the virtual tank deep and wide enough for the chosen waves
  const longest = Math.max(...c.waves.map((w) => waveLength(w.periodS)));
  c.tank.depthM = Math.max(0.55, Math.ceil(longest * 0.6 * 20) / 20);
  state.cond = c;
  state.editing = false;
  view.setTank(c.tank);
  void rerunAll();
});

$("add").addEventListener("click", () => $<HTMLInputElement>("file").click());
$<HTMLInputElement>("file").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  void addFiles([...(input.files ?? [])]);
  input.value = "";
});
let dragDepth = 0;
window.addEventListener("dragenter", (ev) => {
  if (!ev.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  $("drop").classList.add("on");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) ((dragDepth = 0), $("drop").classList.remove("on"));
});
window.addEventListener("dragover", (ev) => ev.preventDefault());
window.addEventListener("drop", (ev) => {
  ev.preventDefault();
  dragDepth = 0;
  $("drop").classList.remove("on");
  void addFiles([...(ev.dataTransfer?.files ?? [])]);
});
// ---------- Excel ----------

type Downloads = { save(req: { filename: string; data: Blob }): Promise<unknown> } | null;
type ClaudeHost = { use(name: string): Promise<Downloads> };
const host = () => (window as unknown as { claude?: ClaudeHost }).claude;
let downloads: Promise<Downloads> | null = null;
/** Published as a Claude artifact, files are saved through the host's downloads capability. */
function getDownloads(): Promise<Downloads> {
  const h = host();
  if (!h?.use) return Promise.resolve(null);
  return (downloads ??= h.use("downloads").catch(() => null));
}
void getDownloads();

$("excel").addEventListener("click", async () => {
  const models = ranked();
  if (!models.length) return;
  const bytes = buildWorkbook(models, state.cond);
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const filename = `hull-test-results-${new Date().toISOString().slice(0, 10)}.xlsx`;
  toast("Preparing the Excel file...");
  const d = await getDownloads();
  if (d) {
    try {
      await d.save({ filename, data: blob });
      return toast(`Saved ${filename}`);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "declined") return toast("Download cancelled.");
      if (code === "rate_limited") return toast("A download prompt is already open.");
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  toast(host()?.use ? "If no download starts, open this page in its own tab and try again." : `Downloading ${filename}`);
});

// ---------- theme and start ----------

new MutationObserver(() => view.applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => view.applyTheme());
document.fonts?.ready.then(() => view.applyTheme());

// Test hooks for the browser check (no effect on normal use).
(window as unknown as Record<string, unknown>).__bench = { state, addFiles, buildWorkbook: () => buildWorkbook(ranked(), state.cond) };

const cfdSelection = ():CfdSelection|null => {
  const m = current(); if (!m) return null;
  const w = state.cond.weights[state.weight];
  const sea = state.water > 0 ? state.cond.waves[state.water - 1] : null;
  return {id:m.id,name:m.name,trianglesMm:m.placed,sizeMm:m.size,massG:w?.grams ?? 28,speedMps:state.cond.speed,waveHeightMm:sea?.heightMm,wavePeriodS:sea?.periodS};
};
const toSelection = (m: Model):CfdSelection => ({id:m.id,name:m.name,trianglesMm:m.placed,sizeMm:m.size,massG:28,speedMps:state.cond.speed});
const advancedCfd=attachCfdPanel({getSelection:cfdSelection,notify:toast,bindButton:false});
attachAutomaticPanel({button:document.getElementById("cfd"),getSelection:cfdSelection,getAll:()=>state.models.filter(m=>!m.example).map(toSelection),openAdvanced:advancedCfd.open});

loadExample();
