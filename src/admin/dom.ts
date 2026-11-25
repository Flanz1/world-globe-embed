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
