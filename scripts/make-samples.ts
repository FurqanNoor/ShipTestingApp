// Writes sample STL files for trying the app: npx tsx scripts/make-samples.ts <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { boxHull, exampleHull } from "../src/engine/example";
import { Mat3, mul, place } from "../src/engine/orient";
import { writeSTL } from "../src/engine/stl";

const dir = process.argv[2] ?? "samples";
mkdirSync(dir, { recursive: true });
const save = (name: string, tris: Float32Array) => writeFileSync(`${dir}/${name}.stl`, Buffer.from(writeSTL(tris)));
save("ferry-220", exampleHull());
// Same kind of hull, shorter and wider, exported with Y up and the bow pointing backwards.
const zUpToYUp: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];
const halfTurnAboutY: Mat3 = [-1, 0, 0, 0, 1, 0, 0, 0, -1];
save("wide-180-y-up", place(exampleHull(180, 52, 22), mul(halfTurnAboutY, zUpToYUp)).tris);
save("barge-200", boxHull(200, 60, 30));
// Tall and narrow: should fail the stability test.
save("tall-narrow", boxHull(200, 14, 40));
