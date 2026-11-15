/** Pin icons: line drawings in a 24×24 box, built as SVG elements (never from strings of markup). */
import type { PinKind } from "./pins.ts";

/** Path data per kind; each string is one stroked path. */
export const PIN_ICON_PATHS: Record<PinKind, string[]> = {
  city: ["M4 20V9h6v11", "M10 20V4h6v16", "M16 20v-8h4v8", "M3 20h18"],
  town: ["M4 11 12 4l8 7", "M6 10v10h12V10", "M10 20v-5h4v5"],
  fortress: ["M5 20V8h3v2h2V8h4v2h2V8h3v12", "M3 20h18", "M10 20v-4a2 2 0 0 1 4 0v4"],
  port: ["M12 3a2 2 0 1 0 0 4a2 2 0 0 0 0-4Z", "M12 7v14", "M5 13a7 7 0 0 0 14 0", "M8 11h8"],
  temple: ["M3 9 12 4l9 5H3Z", "M5 9v9", "M10 9v9", "M14 9v9", "M19 9v9", "M3 20h18"],
  ruin: ["M7 20h10", "M9 20V8h6v5l-2 2 2 5"],
  battle: ["M5 5l14 14", "M19 5 5 19", "M3 7l4-4", "M17 21l4-4", "M7 21l-4-4", "M21 7l-4-4"],
  landmark: ["M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1L3.1 9.5l6.1-.9L12 3Z"],
  mountain: ["M3 20 10 7l4 6 2-3 5 10H3Z"],
  other: ["M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8Z"],
};

const NS = "http://www.w3.org/2000/svg";

/** An inline <svg> of the kind's icon, drawn in `currentColor`. */
export function pinIcon(kind: PinKind, size = 14): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of PIN_ICON_PATHS[kind]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** Light or dark ink for a marker background colour. */
export function inkFor(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#1b1812" : "#ffffff";
}
