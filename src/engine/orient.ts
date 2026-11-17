// Puts an STL on the ship axes used by the original app: x forward (stern at 0), y to port
// (centred), z up (keel at 0). STL files carry no axis information, so the orientation is
// detected from the shape and can be corrected with 90 degree turns.

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Quarter turn about the length axis (deck rolls to the side). */
export const ROLL90: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];
/** Half turn about the length axis (upside down). */
export const FLIP: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];
/** Quarter turn about the vertical axis (bow swings to the side). */
export const TURN90: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
}

export function bounds(t: Float32Array) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = t[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Rotate by m, scale, then move stern to x = 0, centreline to y = 0 and keel to z = 0. */
export function place(raw: Float32Array, m: Mat3, scale = 1): { tris: Float32Array; size: [number, number, number] } {
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const x = raw[i], y = raw[i + 1], z = raw[i + 2];
    out[i] = (m[0] * x + m[1] * y + m[2] * z) * scale;
    out[i + 1] = (m[3] * x + m[4] * y + m[5] * z) * scale;
    out[i + 2] = (m[6] * x + m[7] * y + m[8] * z) * scale;
  }
  const b = bounds(out);
  const yc = (b.min[1] + b.max[1]) / 2;
  for (let i = 0; i < out.length; i += 3) {
    out[i] -= b.min[0];
    out[i + 1] -= yc;
    out[i + 2] -= b.min[2];
  }
  return { tris: out, size: [b.size[0], b.size[1], b.size[2]] };
}

/** Area-weighted surface samples (x, y, z, weight), deterministic. */
function surfaceSamples(t: Float32Array, target = 60000): Float32Array {
  const nT = t.length / 9;
  const areas = new Float64Array(nT);
  let total = 0;
  for (let i = 0; i < nT; i++) {
    const o = i * 9;
    const ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2];
    const vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    total += areas[i] = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  }
  const out: number[] = [];
  let q = 0;
  for (let i = 0; i < nT; i++) {
    if (areas[i] <= 0) continue;
    const n = Math.max(1, Math.round((areas[i] / total) * target));
    const o = i * 9;
    for (let s = 0; s < n; s++) {
      q++;
      // R2 low-discrepancy sequence folded into the triangle
      let a = (q * 0.7548776662466927) % 1, b = (q * 0.5698402909980532) % 1;
      if (a + b > 1) (a = 1 - a), (b = 1 - b);
      const c = 1 - a - b;
      out.push(
        c * t[o] + a * t[o + 3] + b * t[o + 6],
        c * t[o + 1] + a * t[o + 4] + b * t[o + 7],
        c * t[o + 2] + a * t[o + 5] + b * t[o + 8],
        areas[i] / n,
      );
    }
  }
  return new Float32Array(out);
}

/** 0 = perfectly mirror-symmetric across the middle of `axis`; larger = less symmetric. */
function asymmetry(s: Float32Array, min: number[], size: number[], axis: number, other: number): number {
  const N = 14;
  const h = new Float64Array(N * N);
  let sum = 0;
  for (let i = 0; i < s.length; i += 4) {
    const u = Math.min(N - 1, Math.floor(((s[i + other] - min[other]) / (size[other] || 1)) * N));
    const v = Math.min(N - 1, Math.floor(((s[i + axis] - min[axis]) / (size[axis] || 1)) * N));
    h[u * N + v] += s[i + 3];
    sum += s[i + 3];
  }
  let d = 0;
  for (let u = 0; u < N; u++) for (let v = 0; v < N; v++) d += Math.abs(h[u * N + v] - h[u * N + (N - 1 - v)]);
  return d / (sum || 1);
}

/**
 * Longest dimension becomes the length. Of the two remaining axes, the one the shape is
 * mirror-symmetric across is the beam (port/starboard); the other is vertical with the
 * file's positive direction up. The finer end is taken as the bow.
 */
export function autoOrient(raw: Float32Array): Mat3 {
  const b = bounds(raw);
  const len = b.size.indexOf(Math.max(...b.size));
  const [a, c] = [0, 1, 2].filter((k) => k !== len);
  const s = surfaceSamples(raw);
  const asymA = 0.5 * (asymmetry(s, b.min, b.size, a, len) + asymmetry(s, b.min, b.size, a, c));
  const asymC = 0.5 * (asymmetry(s, b.min, b.size, c, len) + asymmetry(s, b.min, b.size, c, a));
  let up: number;
  if (Math.max(asymA, asymC) > 0.12 && Math.min(asymA, asymC) < 0.6 * Math.max(asymA, asymC)) up = asymA > asymC ? a : c;
  else up = a === 2 || c === 2 ? 2 : 1; // no clear answer: CAD convention, Z up (else Y)
  const unit = (k: number) => [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
  const x = unit(len), z = unit(up);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  let m: Mat3 = [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]];

  // Bow = finer end. Compare mean half-breadth near both ends.
  const widthAt = [0, 0], weightAt = [0, 0];
  const yAxis = [0, 1, 2].find((k) => k !== len && k !== up)!;
  const yMid = b.min[yAxis] + b.size[yAxis] / 2;
  for (let i = 0; i < s.length; i += 4) {
    const f = (s[i + len] - b.min[len]) / b.size[len];
    const end = f < 0.14 ? 0 : f > 0.86 ? 1 : -1;
    if (end < 0) continue;
    widthAt[end] += Math.abs(s[i + yAxis] - yMid) * s[i + 3];
    weightAt[end] += s[i + 3];
  }
  const w0 = widthAt[0] / (weightAt[0] || 1), w1 = widthAt[1] / (weightAt[1] || 1);
  if (w0 < 0.92 * w1) m = mul(mul(TURN90, TURN90), m); // fine end is at low x: turn the bow forward
  return m;
}

/** Guess the STL unit from its largest dimension. Model hulls are tens to hundreds of mm. */
/**
 * Guess STL units from size. Competition hulls are at most 250 mm, typically 100-250 mm, so prefer the unit that puts
 * the longest side in that range: millimetres, then centimetres, then metres (inches only via the workbench unit menu).
 */
export function guessUnitScale(raw: Float32Array): number {
  const big = Math.max(...bounds(raw).size);
  for (const scale of [1, 10, 1000]) { const mm = big * scale; if (mm >= 80 && mm <= 250.5) return scale; }
  if (big < 1) return 1000; // metres
  if (big < 25) return 10; // centimetres
  return 1; // millimetres
}
