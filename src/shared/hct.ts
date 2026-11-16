/**
 * HCT colour space (hue and chroma from CAM16, tone = CIE L*) and the Material You (M3) colour scheme the admin page
 * and editor use. Written for this project, no dependency: the admin page computes a scheme from an account's seed
 * colour at runtime, and the default (Gold) scheme in admin.css is checked against it by tests/theme.test.ts.
 */

type Vec3 = [number, number, number];

// ── sRGB and L* helpers ──
const linearize = (c: number): number => {
  const n = c / 255;
  return (n <= 0.040449936 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)) * 100;
};
const delinearize = (c: number): number => {
  const n = c / 100;
  const v = n <= 0.0031308 ? n * 12.92 : 1.055 * Math.pow(n, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};
const E = 216 / 24389;
const KAPPA = 24389 / 27;
/** CIE L* (0–100) of a relative luminance Y (0–100). */
export const lstarFromY = (y: number): number => {
  const t = y / 100;
  return 116 * (t > E ? Math.cbrt(t) : (KAPPA * t + 16) / 116) - 16;
};
/** Relative luminance Y (0–100) of a CIE L* (0–100). */
export const yFromLstar = (l: number): number => {
  const ft = (l + 16) / 116;
  const ft3 = ft * ft * ft;
  return 100 * (ft3 > E ? ft3 : (116 * ft - 16) / KAPPA);
};

export type Rgb = Vec3;
export const rgbFromHex = (hex: string): Rgb => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const hexFromRgb = ([r, g, b]: Rgb): string => "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
const yFromRgb = ([r, g, b]: Rgb): number => 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
export const lstarFromRgb = (rgb: Rgb): number => lstarFromY(yFromRgb(rgb));
const grayFromLstar = (l: number): Rgb => {
  const c = delinearize(yFromLstar(l));
  return [c, c, c];
};
/** WCAG contrast ratio of two colours (1–21). */
export const contrast = (a: string, b: string): number => {
  const ya = yFromRgb(rgbFromHex(a)) / 100;
  const yb = yFromRgb(rgbFromHex(b)) / 100;
  return (Math.max(ya, yb) + 0.05) / (Math.min(ya, yb) + 0.05);
};

// ── CAM16 with the default viewing conditions (D65, 200/π·Y(50) lux, grey background L* 50, average surround) ──
const VC = (() => {
  const white: Vec3 = [95.047, 100, 108.883];
  const la = ((200 / Math.PI) * yFromLstar(50)) / 100;
  const [x, y, z] = white;
  const rW = x * 0.401288 + y * 0.650173 + z * -0.051461;
  const gW = x * -0.250268 + y * 1.204414 + z * 0.045854;
  const bW = x * -0.002079 + y * 0.048952 + z * 0.953127;
  const f = 0.8 + 2 / 10; // average surround
  const c = 0.59 + (0.69 - 0.59) * ((f - 0.9) * 10);
  const d = Math.max(0, Math.min(1, f * (1 - (1 / 3.6) * Math.exp((-la - 42) / 92))));
  const rgbD: Vec3 = [d * (100 / rW) + 1 - d, d * (100 / gW) + 1 - d, d * (100 / bW) + 1 - d];
  const k = 1 / (5 * la + 1);
  const k4 = k * k * k * k;
  const fl = k4 * la + 0.1 * (1 - k4) * (1 - k4) * Math.cbrt(5 * la);
  const n = yFromLstar(50) / white[1];
  const zz = 1.48 + Math.sqrt(n);
  const nbb = 0.725 / Math.pow(n, 0.2);
  const af = [rgbD[0] * rW, rgbD[1] * gW, rgbD[2] * bW].map((v) => Math.pow((fl * v) / 100, 0.42));
  const rgbA = af.map((v) => (400 * v) / (v + 27.13));
  const aw = (2 * rgbA[0] + rgbA[1] + 0.05 * rgbA[2]) * nbb;
  return { n, aw, nbb, ncb: nbb, c, nc: f, rgbD, fl, flRoot: Math.pow(fl, 0.25), z: zz };
})();

interface Cam {
  hue: number;
  chroma: number;
  j: number;
  jstar: number;
  astar: number;
  bstar: number;
}

const camFromRgb = (rgb: Rgb): Cam => {
  const [r, g, b] = rgb.map(linearize);
  const x = 0.41233895 * r + 0.35762064 * g + 0.18051042 * b;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = 0.01932141 * r + 0.11916382 * g + 0.95034478 * b;
  const cone: Vec3 = [
    0.401288 * x + 0.650173 * y - 0.051461 * z,
    -0.250268 * x + 1.204414 * y + 0.045854 * z,
    -0.002079 * x + 0.048952 * y + 0.953127 * z,
  ];
  const [rA, gA, bA] = cone.map((v, i) => {
    const dv = VC.rgbD[i] * v;
    const af = Math.pow((VC.fl * Math.abs(dv)) / 100, 0.42);
    return (Math.sign(dv) * 400 * af) / (af + 27.13);
  });
  const a = (11 * rA - 12 * gA + bA) / 11;
  const bb = (rA + gA - 2 * bA) / 9;
  const u = (20 * rA + 20 * gA + 21 * bA) / 20;
  const p2 = (40 * rA + 20 * gA + bA) / 20;
  let hue = (Math.atan2(bb, a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  else if (hue >= 360) hue -= 360;
  const hueRad = (hue * Math.PI) / 180;
  const ac = p2 * VC.nbb;
  const j = 100 * Math.pow(ac / VC.aw, VC.c * VC.z);
  const huePrime = hue < 20.14 ? hue + 360 : hue;
  const eHue = 0.25 * (Math.cos((huePrime * Math.PI) / 180 + 2) + 3.8);
  const p1 = (50000 / 13) * eHue * VC.nc * VC.ncb;
  const t = (p1 * Math.hypot(a, bb)) / (u + 0.305);
  const alpha = Math.pow(t, 0.9) * Math.pow(1.64 - Math.pow(0.29, VC.n), 0.73);
  const chroma = alpha * Math.sqrt(j / 100);
  const m = chroma * VC.flRoot;
  const jstar = ((1 + 100 * 0.007) * j) / (1 + 0.007 * j);
  const mstar = (1 / 0.0228) * Math.log1p(0.0228 * m);
  return { hue, chroma, j, jstar, astar: mstar * Math.cos(hueRad), bstar: mstar * Math.sin(hueRad) };
};

const camFromJch = (j: number, chroma: number, hue: number): Cam => {
  const hueRad = (hue * Math.PI) / 180;
  const m = chroma * VC.flRoot;
  const jstar = ((1 + 100 * 0.007) * j) / (1 + 0.007 * j);
  const mstar = (1 / 0.0228) * Math.log1p(0.0228 * m);
  return { hue, chroma, j, jstar, astar: mstar * Math.cos(hueRad), bstar: mstar * Math.sin(hueRad) };
};

const camDistance = (a: Cam, b: Cam): number =>
  1.41 * Math.pow(Math.hypot(a.jstar - b.jstar, a.astar - b.astar, a.bstar - b.bstar), 0.63);

/** The sRGB colour a CAM16 colour is seen as (channels clamped to 0–255). */
const rgbFromCam = ({ j, chroma, hue }: Cam): Rgb => {
  const alpha = chroma === 0 || j === 0 ? 0 : chroma / Math.sqrt(j / 100);
  const t = Math.pow(alpha / Math.pow(1.64 - Math.pow(0.29, VC.n), 0.73), 1 / 0.9);
  const hRad = (hue * Math.PI) / 180;
  const eHue = 0.25 * (Math.cos(hRad + 2) + 3.8);
  const ac = VC.aw * Math.pow(j / 100, 1 / VC.c / VC.z);
  const p1 = eHue * (50000 / 13) * VC.nc * VC.ncb;
  const p2 = ac / VC.nbb;
  const hSin = Math.sin(hRad);
  const hCos = Math.cos(hRad);
  const gamma = (23 * (p2 + 0.305) * t) / (23 * p1 + 11 * t * hCos + 108 * t * hSin);
  const a = gamma * hCos;
  const b = gamma * hSin;
  const rA = (460 * p2 + 451 * a + 288 * b) / 1403;
  const gA = (460 * p2 - 891 * a - 261 * b) / 1403;
  const bA = (460 * p2 - 220 * a - 6300 * b) / 1403;
  const [rF, gF, bF] = [rA, gA, bA].map((v, i) => {
    const base = Math.max(0, (27.13 * Math.abs(v)) / (400 - Math.abs(v)));
    return (Math.sign(v) * (100 / VC.fl) * Math.pow(base, 1 / 0.42)) / VC.rgbD[i];
  });
  const x = 1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF;
  const y = 0.38752654 * rF + 0.62144744 * gF - 0.00897398 * bF;
  const z = -0.0158415 * rF - 0.03412294 * gF + 1.04996444 * bF;
  const lr = 3.2413774792388685 * x - 1.5376652402851851 * y - 0.49885366846268053 * z;
  const lg = -0.9691452513005321 * x + 1.8758853451067872 * y + 0.04156585616912061 * z;
  const lb = 0.05562093689691305 * x - 0.2039552456474212 * y + 1.0571799111354545 * z;
  return [delinearize(lr), delinearize(lg), delinearize(lb)];
};

/** Searches lightness J for a colour of this hue and chroma whose L* is `tone`; null when it is out of the sRGB gamut. */
const findByJ = (hue: number, chroma: number, tone: number): Rgb | null => {
  let low = 0;
  let high = 100;
  let bestDL = 1000;
  let bestDE = 1000;
  let best: Rgb | null = null;
  while (Math.abs(low - high) > 0.01) {
    const mid = low + (high - low) / 2;
    const rgb = rgbFromCam(camFromJch(mid, chroma, hue));
    const l = lstarFromRgb(rgb);
    const dL = Math.abs(tone - l);
    if (dL < 0.2) {
      const got = camFromRgb(rgb);
      const dE = camDistance(got, camFromJch(got.j, got.chroma, hue));
      if (dE <= 1 && dE <= bestDE) {
        bestDL = dL;
        bestDE = dE;
        best = rgb;
      }
    }
    if (bestDL === 0 && bestDE === 0) break;
    if (l < tone) low = mid;
    else high = mid;
  }
  return best;
};

/** The sRGB colour with this HCT hue and tone, at the given chroma or the highest chroma the gamut allows below it. */
export const rgbFromHct = (hue: number, chroma: number, tone: number): Rgb => {
  if (chroma < 0.0001 || tone < 0.0001 || tone > 99.9999) return grayFromLstar(tone);
  hue = ((hue % 360) + 360) % 360;
  const exact = findByJ(hue, chroma, tone);
  if (exact) return exact;
  let low = 0;
  let high = chroma;
  let answer: Rgb | null = null;
  while (high - low >= 0.4) {
    const mid = low + (high - low) / 2;
    const got = findByJ(hue, mid, tone);
    if (got) {
      answer = got;
      low = mid;
    } else high = mid;
  }
  return answer ?? grayFromLstar(tone);
};

export interface Hct {
  hue: number;
  chroma: number;
  tone: number;
}
export const hctFromHex = (hex: string): Hct => {
  const rgb = rgbFromHex(hex);
  const cam = camFromRgb(rgb);
  return { hue: cam.hue, chroma: cam.chroma, tone: lstarFromRgb(rgb) };
};
export const hexFromHct = (hue: number, chroma: number, tone: number): string => hexFromRgb(rgbFromHct(hue, chroma, tone));

// ── Material You scheme ──

/** Default seed for accounts that never picked a colour: Gold, the admin page's accent before the M3 restyle. */
export const DEFAULT_SEED = "#8a6a1f";

/** Colour roles, in the order admin.css lists them. `app-*` are project roles (warn, ok) built the same way as error. */
export const ROLES = [
  "primary",
  "on-primary",
  "primary-container",
  "on-primary-container",
  "secondary",
  "on-secondary",
  "secondary-container",
  "on-secondary-container",
  "surface",
  "surface-container-lowest",
  "surface-container-low",
  "surface-container",
  "surface-container-high",
  "surface-container-highest",
  "on-surface",
  "on-surface-variant",
  "outline",
  "outline-variant",
  "inverse-surface",
  "inverse-on-surface",
  "error",
  "on-error",
  "error-container",
  "on-error-container",
  "app-warn",
  "app-on-warn",
  "app-warn-container",
  "app-on-warn-container",
  "app-ok",
] as const;
export type Role = (typeof ROLES)[number];
export type Scheme = Record<Role, string>;

/** Fixed hues (HCT) of the project roles: error red as M3, warn orange, ok green. */
const ERROR_HUE = 25;
const WARN_HUE = 60;
const OK_HUE = 145;

/** The M3 "tonal spot" scheme of a seed colour, light or dark. Tones as M3; chroma as our design brief. */
export const schemeFromSeed = (seed: string, dark: boolean): Scheme => {
  const { hue } = hctFromHex(seed);
  const p = (t: number) => hexFromHct(hue, 40, t);
  const s = (t: number) => hexFromHct(hue, 16, t);
  const n = (t: number) => hexFromHct(hue, 5, t);
  const nv = (t: number) => hexFromHct(hue, 10, t);
  const e = (t: number) => hexFromHct(ERROR_HUE, 84, t);
  const w = (t: number) => hexFromHct(WARN_HUE, 60, t);
  const k = (t: number) => hexFromHct(OK_HUE, 48, t);
  const tone = (light: number, darkTone: number) => (dark ? darkTone : light);
  return {
    primary: p(tone(40, 80)),
    "on-primary": p(tone(100, 20)),
    "primary-container": p(tone(90, 30)),
    "on-primary-container": p(tone(10, 90)),
    secondary: s(tone(40, 80)),
    "on-secondary": s(tone(100, 20)),
    "secondary-container": s(tone(90, 30)),
    "on-secondary-container": s(tone(10, 90)),
    surface: n(tone(98, 6)),
    "surface-container-lowest": n(tone(100, 4)),
    "surface-container-low": n(tone(96, 10)),
    "surface-container": n(tone(94, 12)),
    "surface-container-high": n(tone(92, 17)),
    "surface-container-highest": n(tone(90, 22)),
    "on-surface": n(tone(10, 90)),
    "on-surface-variant": nv(tone(30, 80)),
    outline: nv(tone(50, 60)),
    "outline-variant": nv(tone(80, 30)),
    "inverse-surface": n(tone(20, 90)),
    "inverse-on-surface": n(tone(95, 20)),
    error: e(tone(40, 80)),
    "on-error": e(tone(100, 20)),
    "error-container": e(tone(90, 30)),
    "on-error-container": e(tone(10, 90)),
    "app-warn": w(tone(40, 80)),
    "app-on-warn": w(tone(100, 20)),
    "app-warn-container": w(tone(90, 30)),
    "app-on-warn-container": w(tone(10, 90)),
    "app-ok": k(tone(40, 80)),
  };
};

/** CSS custom-property declarations for a scheme (`--md-sys-color-primary: #…;` …), as admin.css writes them. */
export const schemeDeclarations = (scheme: Scheme): string =>
  ROLES.map((r) => `--${r.startsWith("app-") ? r : `md-sys-color-${r}`}: ${scheme[r]};`).join(" ");
