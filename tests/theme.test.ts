import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SEED, ROLES, contrast, hctFromHex, hexFromHct, schemeFromSeed, type Role } from "../src/shared/hct.ts";

const css = readFileSync(new URL("../src/admin/admin.css", import.meta.url), "utf8");
/** The role values admin.css declares between two theme markers. */
const declared = (from: string, to: string): Record<string, string> => {
  const block = css.slice(css.indexOf(from), css.indexOf(to));
  return Object.fromEntries([...block.matchAll(/--((?:md-sys-color|app)-[a-z-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1].replace(/^md-sys-color-/, ""), m[2]]));
};

/** Pairs of text (or icon) on a background that must reach WCAG AA, 4.5:1. */
const PAIRS: [Role, Role][] = [
  ["on-primary", "primary"],
  ["on-primary-container", "primary-container"],
  ["on-secondary", "secondary"],
  ["on-secondary-container", "secondary-container"],
  ["on-error", "error"],
  ["on-error-container", "error-container"],
  ["app-on-warn", "app-warn"],
  ["app-on-warn-container", "app-warn-container"],
  ["inverse-on-surface", "inverse-surface"],
];
const SURFACES: Role[] = ["surface", "surface-container-lowest", "surface-container-low", "surface-container", "surface-container-high", "surface-container-highest"];
const ON_SURFACES: Role[] = ["on-surface", "on-surface-variant", "primary", "error", "app-warn", "app-ok"];

describe("HCT", () => {
  it("round-trips colours through hue, chroma and tone", () => {
    for (const hex of ["#8a6a1f", "#036879", "#3f692b", "#b3261e", "#6750a4", "#ffffff", "#000000", "#808080"]) {
      const { hue, chroma, tone } = hctFromHex(hex);
      const back = hctFromHex(hexFromHct(hue, chroma, tone));
      expect(back.tone).toBeCloseTo(tone, 0);
      if (chroma > 5) expect(Math.abs(back.hue - hue)).toBeLessThan(2);
    }
  });
  it("keeps tone exact when the chroma has to be cut to fit sRGB", () => {
    const strong = hctFromHex(hexFromHct(85, 120, 90));
    expect(strong.tone).toBeCloseTo(90, 0);
    expect(strong.chroma).toBeLessThan(120);
  });
});

describe("Material You scheme", () => {
  for (const seed of [DEFAULT_SEED, "#036879", "#3f692b", "#a03a5c", "#5b4b9a", "#777777"])
    for (const dark of [false, true])
      it(`${seed} ${dark ? "dark" : "light"}: on-colours pass AA on their containers and surfaces`, () => {
        const s = schemeFromSeed(seed, dark);
        for (const r of ROLES) expect(s[r]).toMatch(/^#[0-9a-f]{6}$/);
        for (const [fg, bg] of PAIRS) expect(contrast(s[fg], s[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        for (const bg of SURFACES) for (const fg of ON_SURFACES) expect(contrast(s[fg], s[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        // Outlines of controls (text fields, outlined buttons) reach 3:1 on the surfaces they sit on.
        for (const bg of SURFACES.slice(0, 5)) expect(contrast(s.outline, s[bg]), `outline on ${bg}`).toBeGreaterThanOrEqual(3);
      });

  it("admin.css declares the Gold scheme, light and dark", () => {
    expect(declared("/* theme:light */", "/* theme:dark */")).toEqual(schemeFromSeed(DEFAULT_SEED, false));
    const dark = schemeFromSeed(DEFAULT_SEED, true);
    const darkBlock = css.slice(css.indexOf("/* theme:dark */"), css.indexOf("/* theme:end */"));
    // Dark is written twice: for prefers-color-scheme, and for the [data-theme=dark] override.
    const halves = darkBlock.split(':root[data-theme="dark"]');
    expect(halves).toHaveLength(2);
    for (const half of halves) {
      const got = Object.fromEntries([...half.matchAll(/--((?:md-sys-color|app)-[a-z-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1].replace(/^md-sys-color-/, ""), m[2]]));
      expect(got).toEqual(dark);
    }
  });

  it("uses no hard-coded UI colours outside the theme block", () => {
    const rules = css.slice(css.indexOf("/* theme:end */"));
    // Hex colours left after the roles are data/map colours, each commented as such, or the map background token.
    const hexes = [...rules.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase());
    expect(hexes.filter((h) => !["#14120f", "#e8590c", "#e8dcc8", "#ece2d0", "#fff", "#000"].includes(h))).toEqual([]);
  });
});
