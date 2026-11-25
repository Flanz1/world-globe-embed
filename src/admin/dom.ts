/** Tiny DOM helpers for the admin page. Everything is built with createElement and textContent, never HTML strings. */

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(el, rest);
  if (dataset) Object.assign(el.dataset, dataset);
  for (const c of children) if (c) el.append(c);
  return el;
}

/** The site root (the admin page lives at <root>/admin/). */
export const SITE = new URL("../", location.href);

const SVGNS = "http://www.w3.org/2000/svg";
/** The folder icon in the Regions and Pins trees. */
export function folderIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "r-ficon");
  const path = document.createElementNS(SVGNS, "path");
  path.setAttribute("d", "M3 6.5A1.5 1.5 0 014.5 5H9l2 2h8.5A1.5 1.5 0 0121 8.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z");
  svg.append(path);
  return svg;
}

/** A Material You switch: the checkbox gets role=switch and the .md-switch look; `word` adds the On/Off word (standalone switches only). */
export function switchCtl(box: HTMLInputElement, word = false): HTMLElement {
  box.classList.add("md-switch");
  box.setAttribute("role", "switch");
  return h("span", { className: `sw-ctl${word ? " word" : ""}` }, box, h("span", { className: "sw-state", ariaHidden: "true" }));
}

/** A switch row: the label (and a muted help line) on the left, the switch on the right. */
export function switchRow(text: string | Node, box: HTMLInputElement, opts: { help?: string; word?: boolean; className?: string } = {}): HTMLLabelElement {
  return h(
    "label",
    { className: `sw-row${opts.className ? ` ${opts.className}` : ""}` },
    h("span", { className: "sw-text" }, h("span", {}, text), opts.help ? h("span", { className: "sw-help", textContent: opts.help }) : null),
    switchCtl(box, opts.word ?? false),
  );
}

/** Opens a floating popup of switches under (or beside) a button; Esc, a click outside or the button closes it. Phones get a bottom sheet. */
export function switchPopup(btn: HTMLElement, build: () => HTMLElement[], opts: { title?: string; label: string; align?: "left" | "right"; onClose?: () => void }): { close(): void } {
  const menu = h("div", { className: "sw-menu", role: "dialog", ariaLabel: opts.label }, opts.title ? h("div", { className: "sw-menu-title", textContent: opts.title }) : null, ...build());
  const phone = matchMedia("(max-width: 599px)").matches;
  const scrim = phone ? h("div", { className: "sw-scrim" }) : null;
  if (phone) menu.classList.add("sheet");
  const host = btn.closest("dialog[open]") ?? document.body;
  host.append(...(scrim ? [scrim, menu] : [menu]));
  if (!phone) {
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    let left = opts.align === "right" ? r.right - w : r.left;
    left = Math.max(12, Math.min(left, innerWidth - w - 12));
    menu.style.left = `${left}px`;
    let top = r.bottom + 6;
    if (top + menu.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - 6 - menu.offsetHeight);
    menu.style.top = `${top}px`;
  }
  btn.setAttribute("aria-expanded", "true");
  const close = () => {
    menu.remove();
    scrim?.remove();
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
  };
  const onDown = (e: Event) => {
    const t = e.target as Node;
    if (!menu.contains(t) && !btn.contains(t)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    close();
    btn.focus();
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  menu.querySelector<HTMLElement>("input")?.focus();
  return { close };
}
