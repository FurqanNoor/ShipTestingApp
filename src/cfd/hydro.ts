import type { CfdHull } from './geometry';

export type HydroPoint = [number, number, number];

export interface CfdHydroOptions {
  massKg: number;
  /** Actual mass centre, in the placed STL frame: X from stern, Y port, Z above keel. */
  cgM: HydroPoint;
  densityKgM3?: number;
  gravityMps2?: number;
  /** Set for free-floating starts. A fixed tow may use an unstable constrained pose. */
  requireStable?: boolean;
}

export interface CfdHydroState {
  massKg: number;
  densityKgM3: number;
  gravityMps2: number;
  totalVolumeM3: number;
  displacedVolumeM3: number;
  draftM: number;
  freeboardM: number;
  buoyancyN: number;
  gmM: number;
  centerBuoyancyM: HydroPoint;
  waterplaneAreaM2: number;
  waterplaneIxxM4: number;
  waterplaneCentroidM: [number, number];
  wettedAreaM2: number;
  hasOpenRim: boolean;
  lowestRimM: number | null;
  maxSupportedMassKg: number;
  uprightRollMomentNm: number;
  uprightPitchMomentNm: number;
  freeFloatingAllowed: boolean;
  fixedTrim: true;
  flags: string[];
  warnings: string[];
}

export interface HydroPlaneSample {
  volumeM3: number;
  centerBuoyancyM: HydroPoint;
  wettedAreaM2: number;
  waterplaneAreaM2: number;
  waterplaneIxxM4: number;
  waterplaneCentroidM: [number, number];
}

function vector(triangles: ArrayLike<number>, offset: number): HydroPoint {
  return [triangles[offset], triangles[offset + 1], triangles[offset + 2]];
}

/** Clip an outward face at z <= level, retaining its face winding. */
function belowPlane(triangle: HydroPoint[], level: number): HydroPoint[] {
  const clipped: HydroPoint[] = [];
  for (let i = 0; i < triangle.length; i++) {
    const a = triangle[i], b = triangle[(i + 1) % triangle.length];
    const insideA = a[2] <= level, insideB = b[2] <= level;
    if (insideA) clipped.push(a);
    if (insideA !== insideB) {
      const t = (level - a[2]) / (b[2] - a[2]);
      clipped.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), level]);
    }
  }
  return clipped;
}

/**
 * Exact facet integration for a validated outward, closed triangular envelope.
 * Tetrahedra use O=(0,0,level). The waterplane cap has zero signed volume and
 * zero first moment in this decomposition, so no cap tessellation is needed.
 * Waterplane area/inertia use the oriented cut-boundary line integrals.
 */
export function sampleHydrostaticPlane(trianglesM: ArrayLike<number>, levelM: number): HydroPlaneSample {
  if (!Number.isFinite(levelM)) throw new Error('The waterplane level must be finite.');
  if (!trianglesM.length || trianglesM.length % 9 !== 0) throw new Error('Hydrostatics needs complete triangular faces.');
  let volume = 0, mx = 0, my = 0, mz = 0, wettedArea = 0;
  let twiceArea = 0, areaMx6 = 0, areaMy6 = 0, inertiaY12 = 0;
  for (let offset = 0; offset < trianglesM.length; offset += 9) {
    // Faces wholly above the plane contribute nothing; skip them without allocating.
    if (trianglesM[offset + 2] > levelM && trianglesM[offset + 5] > levelM && trianglesM[offset + 8] > levelM) continue;
    const tri = [vector(trianglesM, offset), vector(trianglesM, offset + 3), vector(trianglesM, offset + 6)];
    const poly = belowPlane(tri, levelM);
    if (poly.length < 3) continue;
    const a = poly[0];
    for (let j = 1; j < poly.length - 1; j++) {
      const b = poly[j], c = poly[j + 1];
      const az = a[2] - levelM, bz = b[2] - levelM, cz = c[2] - levelM;
      const signed = (a[0] * (b[1] * cz - bz * c[1]) - a[1] * (b[0] * cz - bz * c[0]) + az * (b[0] * c[1] - b[1] * c[0])) / 6;
      volume += signed;
      mx += signed * (a[0] + b[0] + c[0]) / 4;
      my += signed * (a[1] + b[1] + c[1]) / 4;
      mz += signed * (levelM + a[2] + b[2] + c[2]) / 4;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      wettedArea += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    // Only faces with submerged area contribute. This gives a unique boundary
    // even if the waterplane passes exactly through an existing chine edge.
    const minZ = Math.min(tri[0][2], tri[1][2], tri[2][2]);
    const maxZ = Math.max(tri[0][2], tri[1][2], tri[2][2]);
    if (minZ >= levelM || maxZ < levelM) continue;
    for (let j = 0; j < poly.length; j++) {
      const p = poly[j], q = poly[(j + 1) % poly.length];
      if (p[2] !== levelM || q[2] !== levelM) continue;
      // Reverse the clipped-face boundary to obtain outward +Z cap winding.
      const cross = q[0] * p[1] - p[0] * q[1];
      twiceArea += cross;
      areaMx6 += (q[0] + p[0]) * cross;
      areaMy6 += (q[1] + p[1]) * cross;
      inertiaY12 += (q[1] ** 2 + q[1] * p[1] + p[1] ** 2) * cross;
    }
  }
  const area = twiceArea / 2;
  const xF = area > 0 ? areaMx6 / (6 * area) : 0;
  const yF = area > 0 ? areaMy6 / (6 * area) : 0;
  const inertia = area > 0 ? Math.max(0, inertiaY12 / 12 - area * yF * yF) : 0;
  if (![volume, mx, my, mz, area, inertia, wettedArea].every(Number.isFinite)) throw new Error('Non-finite facet integration. Repair the hull mesh before CFD.');
  return {
    volumeM3: Math.max(0, volume),
    centerBuoyancyM: volume > 0 ? [mx / volume, my / volume, mz / volume] : [0, 0, 0],
    wettedAreaM2: wettedArea,
    waterplaneAreaM2: Math.max(0, area),
    waterplaneIxxM4: inertia,
    waterplaneCentroidM: [xF, yF],
  };
}

/** Still-water upright, fixed-trim initial condition; mass/CG are never inferred. */
export function computeHydrostatics(hull: CfdHull, options: CfdHydroOptions): CfdHydroState {
  const rho = options.densityKgM3 ?? 1000, gravity = options.gravityMps2 ?? 9.81;
  if (![options.massKg, rho, gravity].every(v => Number.isFinite(v) && v > 0)) throw new Error('Mass, water density and gravity must be finite positive values.');
  if (!Array.isArray(options.cgM) || options.cgM.length !== 3 || !options.cgM.every(Number.isFinite)) throw new Error('Supply the specified three-dimensional centre of gravity in metres.');
  const triangles = hull.trianglesM;
  if (!triangles.length || triangles.length % 9 !== 0) throw new Error('A validated closed hull envelope is required.');
  const min: HydroPoint = [Infinity, Infinity, Infinity], max: HydroPoint = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triangles.length; i++) {
    if (!Number.isFinite(triangles[i])) throw new Error('The hull has a non-finite vertex.');
    min[i % 3] = Math.min(min[i % 3], triangles[i]);
    max[i % 3] = Math.max(max[i % 3], triangles[i]);
  }
  if (max.some((v, i) => v <= min[i])) throw new Error('Hull length, beam and depth must be positive.');
  const full = sampleHydrostaticPlane(triangles, max[2]);
  if (!(full.volumeM3 > 0)) throw new Error('The hull has no outward enclosed displacement volume.');
  if (!Number.isFinite(hull.volumeM3) || Math.abs(full.volumeM3 - hull.volumeM3) > Math.max(1e-12, full.volumeM3 * 1e-6)) throw new Error('Hydrostatic volume does not match the validated envelope. Check winding and geometry.');
  const rim = hull.rimVerticesM ?? [];
  if (rim.some(p => p.length !== 3 || !p.every(Number.isFinite))) throw new Error('The hull has an invalid rim vertex.');
  const lowestRim = rim.length ? rim.reduce((z, p) => Math.min(z, p[2]), Infinity) : null;
  const capacityLevel = lowestRim ?? max[2];
  const capacity = sampleHydrostaticPlane(triangles, capacityLevel).volumeM3;
  const target = options.massKg / rho;
  if (!(target < capacity * (1 - 1e-9))) {
    const maxG = Math.floor(capacity * rho * 1000), cm3 = (capacity * 1e6).toFixed(0);
    throw new Error(rim.length
      ? `This load reaches or exceeds open-rim displacement. No dry upright initial condition exists. This hull can carry at most about ${maxG} g before water reaches the lowest point of its open rim (${cm3} cm³ below the rim).`
      : `This load reaches or exceeds the hull envelope displacement. No surface-floating initial condition exists. This hull can carry at most about ${maxG} g before the deck goes under (${cm3} cm³ of hull volume).`);
  }
  let lo = min[2], hi = capacityLevel;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (sampleHydrostaticPlane(triangles, mid).volumeM3 < target) lo = mid; else hi = mid;
  }
  const draft = (lo + hi) / 2;
  const sample = sampleHydrostaticPlane(triangles, draft);
  if (!(sample.waterplaneAreaM2 > 0)) throw new Error('The solved initial condition has no waterplane. Check the displacement envelope.');
  if (Math.abs(sample.volumeM3 - target) > Math.max(1e-12, target * 1e-6)) throw new Error('Could not conserve displacement while solving the initial draft.');
  const gm = sample.centerBuoyancyM[2] + sample.waterplaneIxxM4 / target - options.cgM[2];
  const flags: string[] = [], warnings: string[] = [
    'Initial draft assumes upright, zero-trim hydrostatic equilibrium. CFD must settle any residual list or trim before force sampling.',
    'STL geometry does not determine actual mass, centre of gravity or inertia. These must be measured or independently calculated.',
  ];
  if (gm <= 0) {
    flags.push('nonpositive-gm');
    warnings.push('Upright transverse GM is non-positive. A free-floating start is not accepted; a fixed tow is a constrained pose only.');
    if (options.requireStable) throw new Error('Non-positive initial GM: this upright free-floating initial condition is unstable. Lower CG or select a constrained fixed tow.');
  }
  const rollOffset = sample.centerBuoyancyM[1] - options.cgM[1];
  const pitchOffset = options.cgM[0] - sample.centerBuoyancyM[0];
  if (Math.abs(rollOffset) > Math.max(0.0001, (max[1] - min[1]) * 0.001)) {
    flags.push('unbalanced-upright-roll');
    warnings.push('Specified transverse CG differs from upright CB. Initial roll moment is nonzero; this calculation does not solve equilibrium list.');
  }
  if (Math.abs(pitchOffset) > Math.max(0.0001, (max[0] - min[0]) * 0.001)) {
    flags.push('unbalanced-upright-pitch');
    warnings.push('Specified longitudinal CG differs from upright CB. Initial pitch moment is nonzero; this calculation does not solve equilibrium trim.');
  }
  if (options.cgM.some((v, i) => v < min[i] || v > max[i])) {
    flags.push('cg-outside-envelope-bounds');
    warnings.push('The supplied CG is outside the hull envelope bounds. Confirm payload placement and coordinate units.');
  }
  if (rim.length) {
    warnings.push('Hydrostatic initialization caps the displacement envelope at the open rim and assumes a dry interior. The still-water initial condition does not solve flooding.');
    if (hull.virtualCap) warnings.push('The exported solver geometry is also virtually capped. A solid cap prevents water ingress, so this solver surface cannot validate open-boat flooding after rim immersion.');
    else if (hull.solverGeometryKind === 'printed-material') warnings.push('The solver uses the actual printed-material surface, including its cavity. Water ingress must be resolved and checked by the free-surface CFD run; dry-hull hydrostatic capacity is only an initial-condition limit.');
  }
  const buoyancy = sample.volumeM3 * rho * gravity;
  return {
    massKg: options.massKg, densityKgM3: rho, gravityMps2: gravity,
    totalVolumeM3: full.volumeM3, displacedVolumeM3: sample.volumeM3,
    draftM: draft, freeboardM: capacityLevel - draft, buoyancyN: buoyancy,
    gmM: gm, centerBuoyancyM: sample.centerBuoyancyM,
    waterplaneAreaM2: sample.waterplaneAreaM2, waterplaneIxxM4: sample.waterplaneIxxM4,
    waterplaneCentroidM: sample.waterplaneCentroidM, wettedAreaM2: sample.wettedAreaM2,
    hasOpenRim: rim.length > 0, lowestRimM: lowestRim, maxSupportedMassKg: capacity * rho,
    uprightRollMomentNm: buoyancy * rollOffset, uprightPitchMomentNm: buoyancy * pitchOffset,
    freeFloatingAllowed: gm > 0, fixedTrim: true, flags, warnings,
  };
}
