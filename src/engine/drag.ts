// Drag estimates.
// Calm water: Holtrop & Mennen (1984), ported from the vessel.js HullResistance module used by the
// original app (MIT licence, github.com/shiplab/vesseljs). No bulb, no appendages.
// Added drag in head waves: STAWAVE-2 (ITTC Recommended Procedure 7.5-04-01-01.1).

export interface HullForm {
  LWL: number;
  BWL: number;
  T: number;
  V: number; // displaced volume, m3
  S: number; // wetted surface, m2
  Cb: number;
  Cm: number;
  Cp: number;
  Cwp: number;
  lcbPct: number; // forward of mid-LWL, % LWL
  iE: number; // half angle of entrance, deg
  At: number; // immersed transom area, m2
}

export interface CalmDrag {
  total: number; // N
  friction: number; // N, incl. form factor
  wave: number; // N
  transom: number; // N
  formFactor: number; // 1 + k
  Cf: number;
  CT: number; // total drag coefficient on wetted surface
  Re: number;
  Fn: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** ca: correlation allowance (0 for a smooth model). */
export function holtrop(f: HullForm, U: number, rho: number, nu: number, g: number, ca = 0): CalmDrag {
  const L = f.LWL, B = f.BWL, T = f.T, V = f.V;
  const Cp = clamp(f.Cp, 0.5, 0.92), Cm = clamp(f.Cm, 0.5, 0.995), Cwp = clamp(f.Cwp, 0.5, 0.98);
  const lcb = clamp(f.lcbPct, -5, 5);
  const Re = (U * L) / nu;
  const Fn = U / Math.sqrt(g * L);
  if (U <= 0) return { total: 0, friction: 0, wave: 0, transom: 0, formFactor: 1, Cf: 0, CT: 0, Re: 0, Fn: 0 };
  const Cf = 0.075 / (Math.log10(Re) - 2) ** 2; // ITTC-57
  const lr = Math.max(0.05 * L, L * (1 - Cp + (0.06 * Cp * lcb) / (4 * Cp - 1)));
  const k1 = 0.93 + 0.487118 * (B / L) ** 1.06806 * (T / L) ** 0.46106 * (L / lr) ** 0.121563 * (L ** 3 / V) ** 0.36486 * (1 - Cp) ** -0.604247;
  const q = 0.5 * rho * U * U;
  const friction = q * f.S * Cf * k1;

  const At = Math.max(0, f.At);
  const fnt = At > 0 ? U / Math.sqrt((2 * g * At) / (B + B * Cwp)) : 0;
  const c6 = At > 0 && fnt < 5 ? 0.2 * (1 - 0.2 * fnt) : 0;
  const transom = q * At * c6;

  const BL = B / L;
  const c7 = BL < 0.11 ? 0.229577 * BL ** 0.33333 : BL < 0.25 ? BL : 0.5 - 0.0625 / BL;
  const iE = clamp(f.iE, 3, 70);
  const c1 = 2223105 * c7 ** 3.78613 * (T / B) ** 1.07961 * (90 - iE) ** -1.37565;
  const c5 = Math.max(0.2, 1 - (0.8 * At) / (B * T * Cm));
  const L3V = L ** 3 / V;
  const c15 = L3V < 512 ? -1.69385 : L3V < 1726.91 ? -1.69385 + (L / Math.cbrt(V) - 8) / 2.36 : 0;
  const c16 = Cp < 0.8 ? 8.07981 * Cp - 13.8673 * Cp ** 2 + 6.984388 * Cp ** 3 : 1.73014 - 0.7067 * Cp;
  const m1 = 0.0140407 * (L / T) - (1.75254 * Math.cbrt(V)) / L - 4.79323 * BL - c16;
  const lambda = L / B > 12 ? 1.446 * Cp - 0.36 : 1.446 * Cp - 0.03 * (L / B);
  const c17 = 6919.3 * Cm ** -1.3346 * (V / L ** 3) ** 2.00977 * Math.max(0, L / B - 2) ** 1.40692;
  const m3 = -7.2035 * BL ** 0.326869 * (T / B) ** 0.605375;
  const m4 = (fn: number) => c15 * 0.4 * Math.exp(-0.034 * fn ** -3.29);
  const rwA = (fn: number) => c1 * c5 * V * rho * g * Math.exp(m1 * fn ** -0.9 + m4(fn) * Math.cos(lambda * fn ** -2));
  const rwB = (fn: number) => c17 * c5 * V * rho * g * Math.exp(m3 * fn ** -0.9 + m4(fn) * Math.cos(lambda * fn ** -2));
  const wave = Fn < 0.4 ? rwA(Fn) : Fn <= 0.55 ? rwA(0.4) + ((10 * Fn - 4) * (rwB(0.55) - rwA(0.4))) / 1.5 : rwB(Fn);

  const total = friction + wave + transom + q * f.S * ca;
  return { total, friction, wave, transom, formFactor: k1, Cf, CT: total / (q * f.S), Re, Fn };
}

// Modified Bessel functions (Abramowitz & Stegun 9.8).
export function besselI1(x: number): number {
  const ax = Math.abs(x);
  if (ax < 3.75) {
    const t = (x / 3.75) ** 2;
    return x * (0.5 + t * (0.87890594 + t * (0.51498869 + t * (0.15084934 + t * (0.02658733 + t * (0.00301532 + t * 0.00032411))))));
  }
  const y = 3.75 / ax;
  const p = 0.39894228 + y * (-0.03988024 + y * (-0.00362018 + y * (0.00163801 + y * (-0.01031555 + y * (0.02282967 + y * (-0.02895312 + y * (0.01787654 - y * 0.00420059)))))));
  return (Math.sign(x) * p * Math.exp(ax)) / Math.sqrt(ax);
}
export function besselK1(x: number): number {
  if (x <= 2) {
    const y = (x * x) / 4;
    return Math.log(x / 2) * besselI1(x) + (1 / x) * (1 + y * (0.15443144 + y * (-0.67278579 + y * (-0.18156897 + y * (-0.01919402 + y * (-0.00110404 - y * 0.00004686))))));
  }
  const y = 2 / x;
  return (Math.exp(-x) / Math.sqrt(x)) * (1.25331414 + y * (0.23498619 + y * (-0.0365562 + y * (0.01504268 + y * (-0.00780353 + y * (0.00325614 - y * 0.00068245))))));
}

/** Mean added drag in regular head waves, N. heightM is crest to trough. */
export function stawave2(f: HullForm, U: number, heightM: number, periodS: number, rho: number, g: number, kyy = 0.25) {
  const L = f.LWL, B = f.BWL, T = f.T, Cb = clamp(f.Cb, 0.3, 0.95);
  const zeta = heightM / 2;
  const omega = (2 * Math.PI) / periodS;
  const k = (omega * omega) / g;
  const Fr = Math.max(1e-4, U / Math.sqrt(g * L));
  const wBar = ((Math.sqrt(L / g) * Math.cbrt(kyy)) / (1.17 * Fr ** -0.143)) * omega;
  const a1 = 60.3 * Cb ** 1.34;
  const b1 = wBar < 1 ? 11.0 : -8.5;
  const d1 = wBar < 1 ? 14.0 : -566 * (L / B) ** -2.66;
  const raw = wBar ** b1 * Math.exp((b1 / d1) * (1 - wBar ** d1)) * a1 * Fr ** 1.5 * Math.exp(-3.5 * Fr);
  const motion = ((4 * rho * g * zeta * zeta * B * B) / L) * raw;
  const x = 1.5 * k * T;
  const ratio = x > 20 ? 1 : 1 / (1 + (besselK1(x) / (Math.PI * besselI1(x))) ** 2);
  const f1 = 0.692 * (U / Math.sqrt(T * g)) ** 0.769 + 1.81 * Cb ** 6.95;
  const reflection = 0.5 * rho * g * zeta * zeta * B * ratio * f1;
  const total = (Number.isFinite(motion) ? motion : 0) + (Number.isFinite(reflection) ? reflection : 0);
  return { total, motion, reflection };
}
