// Hull geometry for the calculations: the STL is rasterised into vertical columns on an (x, y)
// grid. Each column runs from the lowest to the highest mesh surface at that spot, so the hull is
// treated as its watertight outer shape (an open-top or hollow hull is sealed at the deck).
// Axes: x forward from the stern, y to port, z up from the keel. Units: metres.

export interface Columns {
  h: number; // cell size
  dA: number;
  nx: number;
  ny: number;
  y0: number; // y of the grid's low edge
  n: number;
  x: Float64Array;
  y: Float64Array;
  zb: Float64Array; // column bottom
  zt: Float64Array; // column top
  ix: Int32Array;
  iy: Int32Array;
  L: number;
  B: number;
  D: number;
  volume: number;
  cx: number;
  cy: number;
  cz: number;
  /** Deck-edge points on both sides, per station: x, y, z triplets. */
  edges: Float64Array;
  /** True when the mesh was a single open surface and had to be closed at the deck edge. */
  sealedOpenSurface: boolean;
}

export function gridSize(L: number, B: number, maxAlong: number, maxCells: number): number {
  return Math.max(L / maxAlong, Math.sqrt((L * B) / maxCells));
}

/** tris: placed triangles in metres (stern at x = 0, centred in y, keel at z = 0). */
export function buildColumns(tris: Float32Array, h: number): Columns {
  let L = 0, yMin = Infinity, yMax = -Infinity, D = 0;
  for (let i = 0; i < tris.length; i += 3) {
    if (tris[i] > L) L = tris[i];
    if (tris[i + 1] < yMin) yMin = tris[i + 1];
    if (tris[i + 1] > yMax) yMax = tris[i + 1];
    if (tris[i + 2] > D) D = tris[i + 2];
  }
  const B = yMax - yMin;
  const nx = Math.max(1, Math.ceil(L / h - 1e-9));
  const ny = Math.max(1, Math.ceil(B / h - 1e-9));
  const y0 = -0.5 * ny * h;
  const zb = new Float64Array(nx * ny).fill(Infinity);
  const zt = new Float64Array(nx * ny).fill(-Infinity);

  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
    const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
    const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-16) continue;
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) / h - 0.5));
    const i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) / h - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - y0) / h - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / h - 0.5));
    const tol = -1e-9 * Math.abs(area);
    for (let i = i0; i <= i1; i++) {
      const px = (i + 0.5) * h;
      for (let j = j0; j <= j1; j++) {
        const py = y0 + (j + 0.5) * h;
        let w0 = (bx - px) * (cy - py) - (cx - px) * (by - py);
        let w1 = (cx - px) * (ay - py) - (ax - px) * (cy - py);
        let w2 = (ax - px) * (by - py) - (bx - px) * (ay - py);
        if (area < 0) (w0 = -w0), (w1 = -w1), (w2 = -w2);
        if (w0 < tol || w1 < tol || w2 < tol) continue;
        const z = (w0 * az + w1 * bz + w2 * cz) / Math.abs(area);
        const k = i * ny + j;
        if (z < zb[k]) zb[k] = z;
        if (z > zt[k]) zt[k] = z;
      }
    }
  }

  // An STL that is a single skin (no thickness) has one hit per column: close it at the deck edge.
  let hit = 0, thin = 0;
  const eps = 1e-6 * Math.max(D, 1e-6);
  for (let k = 0; k < zb.length; k++)
    if (zt[k] > -Infinity) {
      hit++;
      if (zt[k] - zb[k] <= eps) thin++;
    }
  const sealedOpenSurface = hit > 0 && thin > 0.5 * hit;
  if (sealedOpenSurface) {
    for (let i = 0; i < nx; i++) {
      let sheer = -Infinity;
      for (let j = 0; j < ny; j++) sheer = Math.max(sheer, zt[i * ny + j]);
      for (let j = 0; j < ny; j++) if (zt[i * ny + j] > -Infinity) zt[i * ny + j] = sheer;
    }
  }

  let n = 0;
  for (let k = 0; k < zb.length; k++) if (zt[k] - zb[k] > eps) n++;
  const c: Columns = {
    h, dA: h * h, nx, ny, y0, n,
    x: new Float64Array(n), y: new Float64Array(n), zb: new Float64Array(n), zt: new Float64Array(n),
    ix: new Int32Array(n), iy: new Int32Array(n),
    L, B, D, volume: 0, cx: 0, cy: 0, cz: 0, edges: new Float64Array(0), sealedOpenSurface,
  };
  let m = 0, V = 0, mx = 0, my = 0, mz = 0;
  const edges: number[] = [];
  for (let i = 0; i < nx; i++) {
    let jLo = -1, jHi = -1;
    for (let j = 0; j < ny; j++) {
      const k = i * ny + j;
      if (!(zt[k] - zb[k] > eps)) continue;
      c.x[m] = (i + 0.5) * h;
      c.y[m] = y0 + (j + 0.5) * h;
      c.zb[m] = zb[k];
      c.zt[m] = zt[k];
      c.ix[m] = i;
      c.iy[m] = j;
      const len = zt[k] - zb[k];
      V += len;
      mx += len * c.x[m];
      my += len * c.y[m];
      mz += len * 0.5 * (zt[k] + zb[k]);
      m++;
      if (jLo < 0) jLo = j;
      jHi = j;
    }
    if (jLo < 0) continue;
    // Deck edge: highest point within the outer band of the section on each side.
    const band = Math.max(1, Math.round(0.06 * (jHi - jLo + 1)));
    let zLo = -Infinity, zHi = -Infinity;
    for (let j = jLo; j < jLo + band; j++) zLo = Math.max(zLo, zt[i * ny + j]);
    for (let j = jHi; j > jHi - band; j--) zHi = Math.max(zHi, zt[i * ny + j]);
    edges.push((i + 0.5) * h, y0 + jLo * h, zLo, (i + 0.5) * h, y0 + (jHi + 1) * h, zHi);
  }
  c.volume = V * c.dA;
  c.cx = V ? mx / V : 0;
  c.cy = V ? my / V : 0;
  c.cz = V ? mz / V : 0;
  c.edges = new Float64Array(edges);
  return c;
}

export interface Submerged {
  V: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Volume and centroid of the part of the hull below a flat water plane.
 * (nx, ny, nz) is the world "up" direction in hull axes; a point p is under water when n.p <= level.
 */
export function submerged(c: Columns, nx: number, ny: number, nz: number, level: number): Submerged {
  let V = 0, mx = 0, my = 0, mz = 0;
  const { x, y, zb, zt, n } = c;
  for (let i = 0; i < n; i++) {
    const s = level - nx * x[i] - ny * y[i];
    let z0 = zb[i], z1 = zt[i];
    if (nz > 1e-9) {
      const zw = s / nz;
      if (zw < z1) z1 = zw;
    } else if (nz < -1e-9) {
      const zw = s / nz;
      if (zw > z0) z0 = zw;
    } else if (s < 0) continue;
    const len = z1 - z0;
    if (len <= 0) continue;
    V += len;
    mx += len * x[i];
    my += len * y[i];
    mz += len * 0.5 * (z0 + z1);
  }
  if (V <= 0) return { V: 0, x: 0, y: 0, z: 0 };
  return { V: V * c.dA, x: mx / V, y: my / V, z: mz / V };
}

/** Water level that gives submerged volume V0 for the given "up" direction. Null if it cannot float. */
export function solveLevel(c: Columns, nx: number, ny: number, nz: number, V0: number): (Submerged & { level: number }) | null {
  if (V0 >= c.volume) return null;
  let lo = Infinity, hi = -Infinity;
  for (const px of [0, c.L]) for (const py of [-c.B / 2, c.B / 2]) for (const pz of [0, c.D]) {
    const s = nx * px + ny * py + nz * pz;
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  for (let k = 0; k < 34; k++) {
    const mid = 0.5 * (lo + hi);
    if (submerged(c, nx, ny, nz, mid).V < V0) lo = mid;
    else hi = mid;
  }
  const level = 0.5 * (lo + hi);
  return { level, ...submerged(c, nx, ny, nz, level) };
}
