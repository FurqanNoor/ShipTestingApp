// Submit hull STL files as automatic studies to a running `npm run cfd` server, prepared exactly as the UI does
// (same STL parser, unit guess, auto-orientation and placement).
// Usage: npx esbuild scripts/batch-submit.ts --bundle --platform=node --format=esm --outfile=<tmp>.mjs
//        node <tmp>.mjs [--dry] [--speed quick|full] [--conditions a,b,c] file.stl ...
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseSTL } from "../src/engine/stl";
import { autoOrient, guessUnitScale, place } from "../src/engine/orient";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const dry = args.includes("--dry"); if (dry) args.splice(args.indexOf("--dry"), 1);
const speed = opt("--speed") ?? "quick";
const conditionIds = opt("--conditions")?.split(",").filter(Boolean);
const experimentJson = opt("--experiment"); // e.g. {"wavelengths":2,"gainScale":0.88} with --speed experiment
const experiment = experimentJson ? JSON.parse(experimentJson) : undefined;
const server = process.env.CFD_SERVER ?? "http://127.0.0.1:5173";

for (const file of args) {
  const buf = readFileSync(file);
  const raw = parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const unit = guessUnitScale(raw), orient = autoOrient(raw), p = place(raw, orient, unit);
  const name = basename(file).replace(/\.stl$/i, "");
  const size = p.size.map((v) => v.toFixed(1)).join(" × ");
  if (dry) { console.log(`${name}: ${raw.length / 9} triangles, unit ×${unit}, orient [${orient.join(",")}], size ${size} mm`); continue; }
  const res = await fetch(`${server}/api/cfd/studies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, trianglesMm: Array.from(p.tris), speed, ...(conditionIds ? { conditionIds } : {}), ...(experiment ? { experiment } : {}) }) });
  const body = await res.json() as { id?: string; error?: string; conditions?: { id: string; status: string }[] };
  console.log(res.ok ? `${name}: study ${body.id} (${body.conditions?.length} tests, size ${size} mm)` : `${name}: FAILED ${res.status} ${body.error}`);
}
