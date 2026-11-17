import { describe, expect, it } from 'vitest';
import type { CfdHull } from '../src/cfd/geometry';
import { computeHydrostatics, sampleHydrostaticPlane, type HydroPoint } from '../src/cfd/hydro';

type P = [number, number];

/** Outward convex-prism test fixture, all dimensions in metres. */
function prism(length: number, polygon: P[]): Float64Array {
  const values: number[] = [];
  const p = (x: number, yz: P) => [x, yz[0], yz[1]];
  const tri = (a: number[], b: number[], c: number[]) => values.push(...a, ...b, ...c);
  for (let j = 1; j < polygon.length - 1; j++) {
    tri(p(0, polygon[0]), p(0, polygon[j + 1]), p(0, polygon[j]));
    tri(p(length, polygon[0]), p(length, polygon[j]), p(length, polygon[j + 1]));
  }
  for (let j = 0; j < polygon.length; j++) {
    const a = polygon[j], b = polygon[(j + 1) % polygon.length];
    tri(p(0, a), p(0, b), p(length, b));
    tri(p(0, a), p(length, b), p(length, a));
  }
  return new Float64Array(values);
}

function envelope(trianglesM: Float64Array, volumeM3: number, rimVerticesM: HydroPoint[] = []): CfdHull {
  const minM: HydroPoint = [Infinity, Infinity, Infinity], maxM: HydroPoint = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < trianglesM.length; i++) {
    minM[i % 3] = Math.min(minM[i % 3], trianglesM[i]);
    maxM[i % 3] = Math.max(maxM[i % 3], trianglesM[i]);
  }
  // The hydro engine consumes only the already-validated displacement surface,
  // independent of the actual solver's printed-material surface representation.
  return {
    trianglesM, solverTrianglesM: trianglesM, volumeM3, rimVerticesM, centroidM: [0, 0, 0], triangleCount: trianglesM.length / 9,
    solverGeometryKind: 'sealed-envelope', virtualCap: rimVerticesM.length > 0,
    displacementVirtualCap: rimVerticesM.length > 0, solverTriangleCount: trianglesM.length / 9,
    bounds: { minM, maxM, lengthM: maxM[0] - minM[0], beamM: maxM[1] - minM[1], depthM: maxM[2] - minM[2] },
    notes: [], mode: rimVerticesM.length ? 'open-surface' : 'closed-envelope',
  } as CfdHull;
}

const L = 0.2, B = 0.06, D = 0.04;
const boxTriangles = prism(L, [[-B / 2, 0], [B / 2, 0], [B / 2, D], [-B / 2, D]]);
const box = envelope(boxTriangles, L * B * D);

describe('Exact mesh hydrostatics for OpenFOAM initial conditions', () => {
  it('integrates a closed box volume and centroid without the raster engine', () => {
    const result = sampleHydrostaticPlane(boxTriangles, D + 0.01);
    expect(result.volumeM3).toBeCloseTo(L * B * D, 14);
    expect(result.centerBuoyancyM[0]).toBeCloseTo(L / 2, 12);
    expect(result.centerBuoyancyM[1]).toBeCloseTo(0, 12);
    expect(result.centerBuoyancyM[2]).toBeCloseTo(D / 2, 12);
    expect(result.waterplaneAreaM2).toBe(0);
  });

  it('solves box draft, buoyancy, waterplane inertia, wetted area and GM analytically', () => {
    const T = 0.02, KG = 0.02, mass = 1000 * L * B * T;
    const result = computeHydrostatics(box, { massKg: mass, cgM: [L / 2, 0, KG], requireStable: true });
    expect(result.draftM).toBeCloseTo(T, 12);
    expect(result.freeboardM).toBeCloseTo(D - T, 12);
    expect(result.buoyancyN).toBeCloseTo(mass * 9.81, 12);
    expect(result.centerBuoyancyM[2]).toBeCloseTo(T / 2, 12);
    expect(result.waterplaneAreaM2).toBeCloseTo(L * B, 12);
    expect(result.waterplaneIxxM4).toBeCloseTo(L * B ** 3 / 12, 14);
    expect(result.wettedAreaM2).toBeCloseTo(L * B + 2 * T * (L + B), 12);
    expect(result.gmM).toBeCloseTo(T / 2 + B * B / (12 * T) - KG, 12);
    expect(result.freeFloatingAllowed).toBe(true);
    expect(result.flags).toEqual([]);
  });

  it('matches the V-section prism draft, KB, waterplane and GM', () => {
    const T = 0.02, KG = 0.015;
    const tris = prism(L, [[-B / 2, D], [0, 0], [B / 2, D]]);
    const hull = envelope(tris, L * B * D / 2);
    const V = L * B * T * T / (2 * D), width = B * T / D;
    const r = computeHydrostatics(hull, { massKg: 1000 * V, cgM: [L / 2, 0, KG] });
    expect(r.draftM).toBeCloseTo(T, 12);
    expect(r.centerBuoyancyM[2]).toBeCloseTo(2 * T / 3, 12);
    expect(r.waterplaneAreaM2).toBeCloseTo(L * width, 12);
    expect(r.waterplaneIxxM4).toBeCloseTo(L * width ** 3 / 12, 14);
    expect(r.gmM).toBeCloseTo(2 * T / 3 + (L * width ** 3 / 12) / V - KG, 12);
  });

  it('matches an independently derived clipped tetrahedron volume, KB and waterplane inertia', () => {
    const O = [0, 0, 0], A = [L, 0, 0], C = [0, 0, D], P = [0, B, 0];
    const tris = new Float64Array([...O, ...P, ...A, ...O, ...A, ...C, ...O, ...C, ...P, ...A, ...P, ...C]);
    const T = D / 2, t = 1 - T / D;
    const V = L * B * D / 6 * (1 - t ** 3);
    const KB = (L * B / 2 * (T * T / 2 - 2 * T ** 3 / (3 * D) + T ** 4 / (4 * D * D))) / V;
    const s = sampleHydrostaticPlane(tris, T);
    expect(s.volumeM3).toBeCloseTo(V, 14);
    expect(s.centerBuoyancyM[2]).toBeCloseTo(KB, 12);
    expect(s.waterplaneAreaM2).toBeCloseTo(L * B * t * t / 2, 12);
    expect(s.waterplaneCentroidM[0]).toBeCloseTo(L * t / 3, 12);
    expect(s.waterplaneCentroidM[1]).toBeCloseTo(B * t / 3, 12);
    expect(s.waterplaneIxxM4).toBeCloseTo(L * B ** 3 * t ** 4 / 36, 14);
  });

  it('rejects impossible loads and invalid measured parameters', () => {
    expect(() => computeHydrostatics(box, { massKg: 1, cgM: [0.1, 0, 0.02] })).toThrow(/exceeds/);
    expect(() => computeHydrostatics(box, { massKg: 0, cgM: [0.1, 0, 0.02] })).toThrow(/positive/);
    expect(() => computeHydrostatics(box, { massKg: 0.2, densityKgM3: NaN, cgM: [0.1, 0, 0.02] })).toThrow(/positive/);
    expect(() => computeHydrostatics(box, { massKg: 0.2, cgM: [0.1, NaN, 0.02] })).toThrow(/centre of gravity/);
    expect(() => computeHydrostatics({ ...box, volumeM3: box.volumeM3 * 2 }, { massKg: 0.2, cgM: [0.1, 0, 0.02] })).toThrow(/does not match/);
  });

  it('rejects non-positive GM for free floating but permits an explicitly constrained fixed tow', () => {
    const opts = { massKg: 0.24, cgM: [0.1, 0, 0.05] as HydroPoint };
    const fixed = computeHydrostatics(box, { ...opts, requireStable: false });
    expect(fixed.gmM).toBeLessThan(0);
    expect(fixed.freeFloatingAllowed).toBe(false);
    expect(fixed.flags).toContain('nonpositive-gm');
    expect(() => computeHydrostatics(box, { ...opts, requireStable: true })).toThrow(/Non-positive initial GM/);
  });

  it('limits dry displacement by the actual lowest rim and reports residual ballast moments', () => {
    const rim: HydroPoint[] = [[0, -B / 2, 0.03], [L, -B / 2, 0.03], [L, B / 2, 0.03], [0, B / 2, 0.03]];
    const hull = envelope(boxTriangles, L * B * D, rim);
    const r = computeHydrostatics(hull, { massKg: 0.24, cgM: [0.105, 0.002, 0.02] });
    expect(r.hasOpenRim).toBe(true);
    expect(r.freeboardM).toBeCloseTo(0.01, 12);
    expect(r.maxSupportedMassKg).toBeCloseTo(1000 * L * B * 0.03, 12);
    expect(r.uprightRollMomentNm).toBeCloseTo(-0.002 * 0.24 * 9.81, 12);
    expect(r.uprightPitchMomentNm).toBeCloseTo(0.005 * 0.24 * 9.81, 12);
    expect(r.flags).toContain('unbalanced-upright-roll');
    expect(r.flags).toContain('unbalanced-upright-pitch');
    expect(() => computeHydrostatics(hull, { massKg: 0.4, cgM: [0.1, 0, 0.02] })).toThrow(/open-rim displacement/);
  });

  it('preserves exact hydrostatics under a shared geometric and cubic mass reduction', () => {
    const s = 0.5;
    const scaled = envelope(boxTriangles.map(v => v * s), box.volumeM3 * s ** 3);
    const a = computeHydrostatics(box, { massKg: 0.24, cgM: [0.1, 0, 0.02] });
    const b = computeHydrostatics(scaled, { massKg: 0.24 * s ** 3, cgM: [0.1 * s, 0, 0.02 * s] });
    expect(b.draftM / a.draftM).toBeCloseTo(s, 12);
    expect(b.gmM / a.gmM).toBeCloseTo(s, 12);
    expect(b.waterplaneAreaM2 / a.waterplaneAreaM2).toBeCloseTo(s ** 2, 12);
    expect(b.waterplaneIxxM4 / a.waterplaneIxxM4).toBeCloseTo(s ** 4, 12);
    expect(b.buoyancyN / a.buoyancyN).toBeCloseTo(s ** 3, 12);
  });

  it('handles a waterplane exactly through pre-existing mesh edges without losing cap area', () => {
    const original = [...boxTriangles];
    const result: number[] = [];
    // Split every triangle into four with edge midpoints, placing side-face
    // vertices exactly at half-depth; the physical box remains unchanged.
    for (let i = 0; i < original.length; i += 9) {
      const a = original.slice(i, i + 3), b = original.slice(i + 3, i + 6), c = original.slice(i + 6, i + 9);
      const ab = a.map((v, k) => (v + b[k]) / 2), bc = b.map((v, k) => (v + c[k]) / 2), ca = c.map((v, k) => (v + a[k]) / 2);
      result.push(...a, ...ab, ...ca, ...ab, ...b, ...bc, ...ca, ...bc, ...c, ...ab, ...bc, ...ca);
    }
    const sample = sampleHydrostaticPlane(new Float64Array(result), D / 2);
    expect(sample.volumeM3).toBeCloseTo(L * B * D / 2, 14);
    expect(sample.waterplaneAreaM2).toBeCloseTo(L * B, 12);
    expect(sample.waterplaneIxxM4).toBeCloseTo(L * B ** 3 / 12, 14);
  });
});
