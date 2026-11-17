// Test conditions. Everything is Froude-scaled from the repo's 120 m demo ferry to the
// 220 mm size limit, so every model is tested at the same weights, speed and waves.

export const G = 9.81; // m/s2
export const RHO = 998; // fresh water at 20 C, kg/m3
export const NU = 1.004e-6; // kinematic viscosity of fresh water at 20 C, m2/s

export const SIZE_LIMIT_MM = 220;

/** Full-size reference: the demo ferry from the original Ship Test Bench (npm run report). */
export const REFERENCE = {
  name: "Demo ferry 120 m",
  lengthM: 120,
  speedKn: 18,
  rhoSea: 1025,
  lightshipT: 3742.7, // hull steel + decks + outfit + lifeboats
  luggageT: 20.1, // persons and effects
  tanksT: 400.2, // fuel and water
  cargoT: 500.0, // cargo, stores, provisions
};

export const SCALE = REFERENCE.lengthM / (SIZE_LIMIT_MM / 1000); // 545.45

/** Model mass in grams for a full-size mass in tonnes (Froude scaling, sea water to fresh water). */
export function scaleMassG(tonnes: number): number {
  return ((tonnes * 1000) / SCALE ** 3) * (RHO / REFERENCE.rhoSea) * 1000;
}

export interface WeightPreset {
  label: string;
  note: string;
  grams: number;
}
export interface WavePreset {
  label: string;
  note: string;
  heightMm: number; // significant wave height (average of the highest third), crest to trough
  periodS: number; // peak period
}
export interface Tank {
  lengthM: number;
  widthM: number;
  depthM: number;
}
export interface Conditions {
  weights: WeightPreset[];
  waves: WavePreset[];
  speed: number; // m/s
  /** Centre of gravity height: "auto" = centre of the model's volume, otherwise % of model height. */
  cgMode: "auto" | "percent";
  cgPercent: number;
  rollDamping: number; // fraction of critical
  tank: Tank;
}

const R = REFERENCE;
const payloadT = R.luggageT + R.tanksT + R.cargoT;
const half = (g: number) => Math.round(g * 2) / 2;

export function defaultConditions(): Conditions {
  return {
    weights: [
      { label: "Empty", note: "Ship only, no luggage or cargo", grams: half(scaleMassG(R.lightshipT)) },
      { label: "Loaded", note: "Ship + luggage, fuel and cargo", grams: half(scaleMassG(R.lightshipT + payloadT)) },
      { label: "Overloaded", note: "Ship + double luggage, fuel and cargo", grams: half(scaleMassG(R.lightshipT + 2 * payloadT)) },
    ],
    // Full-size sea states from the original app: 2 m / 4 m / 6 m waves at 0.75 / 0.6 / 0.5 rad/s.
    waves: [
      { label: "Moderate", note: "2 m sea at full size", heightMm: +((2 / SCALE) * 1000).toFixed(1), periodS: +(((2 * Math.PI) / 0.75) / Math.sqrt(SCALE)).toFixed(2) },
      { label: "Rough", note: "4 m sea at full size", heightMm: +((4 / SCALE) * 1000).toFixed(1), periodS: +(((2 * Math.PI) / 0.6) / Math.sqrt(SCALE)).toFixed(2) },
      { label: "Very rough", note: "6 m sea at full size", heightMm: +((6 / SCALE) * 1000).toFixed(1), periodS: +(((2 * Math.PI) / 0.5) / Math.sqrt(SCALE)).toFixed(2) },
    ],
    speed: +((R.speedKn * 0.514444) / Math.sqrt(SCALE)).toFixed(2),
    cgMode: "auto",
    cgPercent: 50,
    rollDamping: 0.08,
    tank: { lengthM: 2.2, widthM: 1.1, depthM: 0.55 },
  };
}

export const waveLength = (periodS: number) => (G * periodS * periodS) / (2 * Math.PI); // deep water

/** Checks that the virtual tank is large enough to behave like open water. */
export function tankChecks(c: Conditions, hullLengthM = SIZE_LIMIT_MM / 1000, sectionAreaM2 = 0.0004) {
  const longest = Math.max(...c.waves.map((w) => waveLength(w.periodS)));
  const { lengthM, widthM, depthM } = c.tank;
  const wakeReturn = widthM / Math.tan((19.47 * Math.PI) / 180); // Kelvin wake reflects back to the centreline here
  return [
    { name: "Deep water", value: depthM / longest, limit: "depth / longest wave >= 0.5", ok: depthM / longest >= 0.5, text: `${(depthM / longest).toFixed(2)}` },
    { name: "Depth Froude number", value: c.speed / Math.sqrt(G * depthM), limit: "< 0.5", ok: c.speed / Math.sqrt(G * depthM) < 0.5, text: (c.speed / Math.sqrt(G * depthM)).toFixed(2) },
    { name: "Blockage", value: sectionAreaM2 / (widthM * depthM), limit: "< 0.5 %", ok: sectionAreaM2 / (widthM * depthM) < 0.005, text: `${((100 * sectionAreaM2) / (widthM * depthM)).toFixed(2)} %` },
    { name: "Wake reflection", value: wakeReturn / hullLengthM, limit: "returns > 2 ship lengths behind bow", ok: wakeReturn > 2 * hullLengthM, text: `${(wakeReturn / hullLengthM).toFixed(1)} lengths` },
    { name: "Tank length", value: lengthM / hullLengthM, limit: ">= 8 ship lengths", ok: lengthM / hullLengthM >= 8, text: `${(lengthM / hullLengthM).toFixed(0)} lengths` },
  ];
}
