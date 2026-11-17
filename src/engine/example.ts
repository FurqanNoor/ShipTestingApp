// Built-in example so the app opens with something to look at. Not a real design:
// a simple closed hull with the proportions of the 120 m reference ferry at 1:545.

/** Returns triangles in millimetres, x forward, y to port, z up. */
export function exampleHull(L = 220, B = 37, D = 16.5): Float32Array {
  const nS = 60, nW = 14;
  const halfBreadth = (u: number, w: number) => {
    // u: 0 stern .. 1 bow, w: 0 keel .. 1 deck
    const plan = u < 0.3 ? 0.82 + 0.18 * Math.sin((u / 0.3) * (Math.PI / 2)) : u < 0.55 ? 1 : Math.max(0, 1 - ((u - 0.55) / 0.45) ** 2.2);
    const fullness = 0.35 + 0.65 * Math.sin(Math.min(1, u * 3, (1 - u) * 2.2) * (Math.PI / 2));
    const section = Math.pow(w, 0.28 + 0.9 * (1 - fullness));
    return 0.5 * B * plan * section;
  };
  const keel = (u: number) => D * (0.22 * Math.max(0, (0.18 - u) / 0.18) ** 1.6 + 0.3 * Math.max(0, (u - 0.86) / 0.14) ** 2);
  const pt = (i: number, j: number, side: 1 | -1): [number, number, number] => {
    const u = i / nS, w = j / nW;
    const z0 = keel(u);
    return [u * L, side * halfBreadth(u, w), z0 + (D - z0) * w];
  };
  const out: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => out.push(...a, ...b, ...c);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => (tri(a, b, c), tri(a, c, d));
  for (let i = 0; i < nS; i++) {
    for (let j = 0; j < nW; j++) {
      quad(pt(i, j, 1), pt(i + 1, j, 1), pt(i + 1, j + 1, 1), pt(i, j + 1, 1)); // port shell
      quad(pt(i, j, -1), pt(i, j + 1, -1), pt(i + 1, j + 1, -1), pt(i + 1, j, -1)); // starboard shell
    }
    quad(pt(i, nW, 1), pt(i + 1, nW, 1), pt(i + 1, nW, -1), pt(i, nW, -1)); // deck
  }
  for (let j = 0; j < nW; j++) quad(pt(0, j, -1), pt(0, j, 1), pt(0, j + 1, 1), pt(0, j + 1, -1)); // transom
  return new Float32Array(out);
}

/** Closed rectangular box in millimetres, for the analytic tests. */
export function boxHull(L: number, B: number, D: number): Float32Array {
  const p = (x: number, y: number, z: number) => [x * L, (y - 0.5) * B, z * D];
  const out: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  quad(p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0));
  quad(p(0, 0, 1), p(0, 1, 1), p(1, 1, 1), p(1, 0, 1));
  quad(p(0, 0, 0), p(0, 0, 1), p(1, 0, 1), p(1, 0, 0));
  quad(p(0, 1, 0), p(1, 1, 0), p(1, 1, 1), p(0, 1, 1));
  quad(p(0, 0, 0), p(0, 1, 0), p(0, 1, 1), p(0, 0, 1));
  quad(p(1, 0, 0), p(1, 0, 1), p(1, 1, 1), p(1, 1, 0));
  return new Float32Array(out);
}
