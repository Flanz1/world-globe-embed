/** The colour theme of an account (accent seed + light/dark/system), as the admin page and the admin API both see it. No DOM here. */
import { DEFAULT_SEED, ROLES, schemeFromSeed } from "./hct.ts";

export type Mode = "light" | "dark" | "system";
export interface Prefs {
  seed: string;
  mode: Mode;
}

export const DEFAULT_PREFS: Prefs = { seed: DEFAULT_SEED, mode: "system" };
export const PRESETS: { name: string; seed: string }[] = [
  { name: "Gold", seed: DEFAULT_SEED },
  { name: "Sea", seed: "#036879" },
  { name: "Moss", seed: "#3f692b" },
  { name: "Ember", seed: "#a3534b" },
  { name: "Rose", seed: "#a8386b" },
  { name: "Violet", seed: "#6750a4" },
  { name: "Slate", seed: "#3c6da2" },
  { name: "Sand", seed: "#9a5c1e" },
];

/** Same key and shape the inline script in admin/index.html reads. */
export const CACHE_KEY = "globe-admin-theme";

export const isSeed = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-f]{6}$/.test(s);
const isMode = (m: unknown): m is Mode => m === "light" || m === "dark" || m === "system";
/** A saved or cached value, or null when it isn't a valid theme. */
export const parsePrefs = (v: unknown): Prefs | null => {
  const p = v as Partial<Prefs> | null;
  return p && isSeed(p.seed) && isMode(p.mode) ? { seed: p.seed, mode: p.mode } : null;
};

/** The custom property a colour role is declared as in admin.css (`--md-sys-color-primary`, `--app-warn`). */
export const roleProperty = (r: string): string => `--${r.startsWith("app-") ? r : `md-sys-color-${r}`}`;

/** Every role value of a seed's scheme, by custom property name. Set on <html> they override admin.css's Gold. */
export const themeVars = (seed: string, dark: boolean): Record<string, string> => {
  const scheme = schemeFromSeed(seed, dark);
  return Object.fromEntries(ROLES.map((r) => [roleProperty(r), scheme[r]]));
};
