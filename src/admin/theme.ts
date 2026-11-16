/**
 * The account's colour theme: an accent colour (a seed the whole palette is made from, src/shared/hct.ts) and
 * light / dark / follow the system. The choice applies at once, is cached in localStorage so the next page load
 * paints in the right colours before the admin API answers (public/admin-theme-boot.js reads the same cache), and is saved to the account (PUT /prefs) a moment after the last change. The API
 * hands the saved choice back with the sign-in check, so it costs no extra request.
 * Region, pin and map colours are data and never change with the theme.
 */
import { DEFAULT_SEED, ROLES, schemeFromSeed } from "../shared/hct.ts";
import { CACHE_KEY, DEFAULT_PREFS, PRESETS, isSeed, parsePrefs, roleProperty, themeVars, type Mode, type Prefs } from "../shared/theme-prefs.ts";
import { h } from "./dom.ts";

export { CACHE_KEY, DEFAULT_PREFS, PRESETS, isSeed, parsePrefs, roleProperty, themeVars, type Mode, type Prefs };

const SAVE_DELAY_MS = 600;
const MENU_WIDTH = 220;

let current: Prefs = { ...DEFAULT_PREFS };
let saver: ((p: Prefs) => Promise<unknown>) | null = null;
let onSaveError: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const views: (() => void)[] = [];

const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
/** Whether the page is dark right now (the choice, or the system's when following it). */
export const isDark = (): boolean => (current.mode === "system" ? !!darkQuery?.matches : current.mode === "dark");
export const currentPrefs = (): Prefs => ({ ...current });

/** Set (or, for the default Gold, clear) the colour roles on <html>. Custom properties set through the CSSOM pass the page's strict CSP. */
function setVars(vars: Record<string, string> | null): void {
  const st = document.documentElement.style;
  for (const r of ROLES) {
    const name = roleProperty(r);
    if (vars) st.setProperty(name, vars[name]);
    else st.removeProperty(name);
  }
}

function paint(): void {
  const root = document.documentElement;
  if (current.mode === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = current.mode;
  // Gold is what admin.css already declares for both modes; any other seed is set for the mode that shows now.
  setVars(current.seed === DEFAULT_SEED ? null : themeVars(current.seed, isDark()));
  views.forEach((v) => v());
}

function cache(): void {
  try {
    // Both modes, so public/admin-theme-boot.js can paint before any script runs and pick by the system setting itself.
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...current, vars: { light: themeVars(current.seed, false), dark: themeVars(current.seed, true) } }));
  } catch {
    /* Private window or blocked storage: the theme just isn't remembered between loads. */
  }
}

/** Show a theme without saving it anywhere but the local cache (what the account holds, or the cache at start-up). */
export function adopt(p: Prefs | null): void {
  current = p ?? { ...DEFAULT_PREFS };
  paint();
  cache();
}

/** Start-up: paint from the cache (the inline script already did, before this module loaded). */
export function initTheme(): void {
  let cached: Prefs | null = null;
  try {
    cached = parsePrefs(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"));
  } catch {
    /* nothing cached */
  }
  current = cached ?? { ...DEFAULT_PREFS };
  paint();
  darkQuery?.addEventListener("change", () => current.mode === "system" && paint());
}

/** A person changed the theme: apply it now, save it to the account shortly. */
export function choose(p: Partial<Prefs>): void {
  const next = parsePrefs({ ...current, ...p });
  if (!next || (next.seed === current.seed && next.mode === current.mode)) return;
  adopt(next);
  clearTimeout(timer);
  timer = setTimeout(() => {
    void saver?.(next).catch(() => onSaveError?.());
  }, SAVE_DELAY_MS);
}

/** Wire the account: `save` is the PUT /prefs call. Pass null on sign-out. */
export function connectAccount(save: ((p: Prefs) => Promise<unknown>) | null, onError?: () => void): void {
  saver = save;
  onSaveError = onError ?? null;
}

/** Forget this browser's theme (sign-out), so the next person to sign in here doesn't see it. */
export function forgetTheme(): void {
  clearTimeout(timer);
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to forget */
  }
}

/* ── Controls ── */

const SVG = "http://www.w3.org/2000/svg";
function icon(paths: string[]): SVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    s.append(p);
  }
  return s;
}
const MOON = ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"];
const SUN = ["M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z", "M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"];

/** The sun/moon button: one click flips light and dark. It shows the moon in light mode (go dark) and the sun in dark mode. */
export function modeButton(): HTMLButtonElement {
  const b = h("button", { type: "button", className: "icon theme-mode", ariaLabel: "Dark mode", title: "Dark mode" });
  b.dataset.action = "theme-mode";
  const sync = () => {
    const dark = isDark();
    b.setAttribute("aria-pressed", String(dark));
    b.replaceChildren(icon(dark ? SUN : MOON));
  };
  b.addEventListener("click", () => choose({ mode: isDark() ? "light" : "dark" }));
  views.push(sync);
  sync();
  return b;
}

/** The round swatch button and its menu: 8 presets, Custom…, and Light / Dark / System. Keyboard operable like the More… menu. */
export function colourMenu(): HTMLElement {
  const menu = h("div", { className: "theme-menu", role: "menu", ariaLabel: "Colour theme", id: "theme-menu" });
  menu.setAttribute("popover", "auto");
  const swatch = h("button", { type: "button", className: "icon theme-swatch", ariaLabel: "Accent colour", title: "Colour theme" });
  swatch.dataset.action = "theme-colour";
  swatch.setAttribute("aria-haspopup", "menu");
  swatch.setAttribute("aria-expanded", "false");
  swatch.append(h("span", { className: "dot" }));

  const items: { el: HTMLElement; sync: () => void }[] = [];
  const dots: { el: HTMLElement; seed: string }[] = [];
  const radio = (label: string, group: string, on: () => boolean, pick: () => void, dot?: string) => {
    const el = h("button", { type: "button", role: "menuitemradio", className: "ghost text theme-item", dataset: { group } }, h("span", { className: "dot", ariaHidden: "true" }), label);
    if (dot) dots.push({ el: el.querySelector<HTMLElement>(".dot")!, seed: dot });
    else el.querySelector(".dot")!.remove();
    el.addEventListener("click", pick);
    items.push({
      el,
      sync: () => {
        el.setAttribute("aria-checked", String(on()));
      },
    });
    return el;
  };
  const head = (text: string) => h("div", { className: "theme-head small muted", role: "presentation", textContent: text });

  const custom = h("input", { type: "color", ariaLabel: "Custom colour", value: current.seed });
  custom.addEventListener("input", () => choose({ seed: custom.value.toLowerCase() }));
  const isPreset = () => PRESETS.some((p) => p.seed === current.seed);
  const customRow = h("label", { className: "theme-item theme-custom", role: "menuitemradio" }, "Custom…", custom);
  items.push({
    el: customRow,
    sync: () => {
      customRow.setAttribute("aria-checked", String(!isPreset()));
      custom.value = current.seed;
    },
  });

  const modeBtn = (label: Mode, text: string) => {
    const b = h("button", { type: "button", className: "ghost", textContent: text, dataset: { group: "mode", mode: label } });
    b.addEventListener("click", () => choose({ mode: label }));
    items.push({ el: b, sync: () => b.setAttribute("aria-pressed", String(current.mode === label)) });
    return b;
  };
  const seg = h("div", { className: "seg theme-seg", role: "group", ariaLabel: "Mode" }, modeBtn("light", "Light"), modeBtn("dark", "Dark"), modeBtn("system", "System"));

  menu.append(
    head("Accent colour"),
    ...PRESETS.map((p) => radio(p.name, "seed", () => current.seed === p.seed, () => choose({ seed: p.seed }), p.seed)),
    customRow,
    head("Mode"),
    seg,
  );
  const nameOf = () => (isPreset() ? PRESETS.find((p) => p.seed === current.seed)!.name : "Custom");
  const sync = () => {
    items.forEach((i) => i.sync());
    swatch.setAttribute("aria-label", `Accent colour: ${nameOf()}`);
    swatch.title = `Colour theme (${nameOf()})`;
    // Each dot is that preset's primary for the mode showing now, so what you pick is what you get.
    for (const d of dots) d.el.style.background = schemeFromSeed(d.seed, isDark()).primary;
  };
  views.push(sync);
  sync();

  const focusable = () => [...menu.querySelectorAll<HTMLElement>("button, input")];
  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  menu.addEventListener("beforetoggle", (ev) => {
    if ((ev as ToggleEvent).newState !== "open") return;
    const r = swatch.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    // Right edge under the swatch, kept on screen (on a phone the header wraps and the swatch can sit anywhere).
    const w = Math.min(MENU_WIDTH, window.innerWidth - 16);
    menu.style.left = `${Math.max(8, Math.round(Math.min(r.right - w, window.innerWidth - w - 8)))}px`;
  });
  menu.addEventListener("toggle", (ev) => {
    const open = (ev as ToggleEvent).newState === "open";
    swatch.setAttribute("aria-expanded", String(open));
    if (open) {
      (menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? focusable()[0])?.focus();
      window.addEventListener("resize", close);
    } else {
      window.removeEventListener("resize", close);
      if (menu.contains(document.activeElement) || document.activeElement === document.body) swatch.focus();
    }
  });
  menu.addEventListener("keydown", (ev) => {
    const live = focusable();
    const at = live.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => (ev.preventDefault(), live[(n + live.length) % live.length]?.focus());
    if (ev.key === "ArrowDown") go(at + 1);
    else if (ev.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (ev.key === "Home") go(0);
    else if (ev.key === "End") go(live.length - 1);
    else if (ev.key === "Tab") menu.hidePopover();
  });
  swatch.addEventListener("click", () => menu.togglePopover());
  return h("span", { className: "theme-colour" }, swatch, menu);
}
