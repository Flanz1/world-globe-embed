/** Toolbar icons: our own 20 px line icons (1.75 px stroke, round caps), no icon library. */

export type IconName =
  | "select" | "polygon" | "freehand" | "fill" | "add-part" | "cut" | "split" | "combine" | "extend" | "province-border"
  | "undo" | "redo" | "simplify" | "smooth" | "snap" | "coast" | "grid" | "pin" | "comment" | "layers";

/** Each icon: path data, drawn on a 20 x 20 grid. */
export const ICON_PATHS: Record<IconName, string[]> = {
  select: ["M5 3l11 6.5-5 1.5-2.5 5z"],
  polygon: ["M4 14.5 6.5 5.5 14 4l2.5 7-5 5z", "M4 14.5h.01M6.5 5.5h.01M14 4h.01M16.5 11h.01M11.5 16h.01"],
  freehand: ["M3 17l1-4L14 3l3 3L7 16z", "M12 5l3 3"],
  fill: ["M4 10l6-6 6 6-6 6z", "M4 10h12", "M17 13.5c0 1.2-.9 2-.9 2s-.9-.8-.9-2a.9.9 0 011.8 0z"],
  "add-part": ["M3 3h14v14H3z", "M10 6.5v7M6.5 10h7"],
  cut: ["M4 6a2 2 0 104 0 2 2 0 10-4 0", "M4 14a2 2 0 104 0 2 2 0 10-4 0", "M7.5 7.5L17 15M7.5 12.5L17 5"],
  split: ["M4 4h12v12H4z", "M2.5 17.5l15-15"],
  combine: ["M3 3h8v8H3z", "M9 9h8v8H9z"],
  extend: ["M8 8h4v4H8z", "M4 4l3 3M16 4l-3 3M4 16l3-3M16 16l-3-3"],
  "province-border": ["M3 4h14v12H3z", "M3 10h2.5M8.5 10h3M14.5 10H17"],
  undo: ["M6 8h6a4 4 0 010 8H8", "M9 5L6 8l3 3"],
  redo: ["M14 8H8a4 4 0 000 8h4", "M11 5l3 3-3 3"],
  simplify: ["M3 15L8 6l4 6 5-8"],
  smooth: ["M3 14C6 4 9 4 10 10s4 6 7-4"],
  snap: ["M5 3v7a5 5 0 0010 0V3", "M5 6.5h3M12 6.5h3"],
  coast: ["M3 8c2-2 3 2 5 0s3 2 5 0 3 2 4 0", "M3 14c2-2 3 2 5 0s3 2 5 0 3 2 4 0"],
  grid: ["M3 3h14v14H3z", "M3 10h14M10 3v14"],
  pin: ["M10 17s5-4.6 5-8.5a5 5 0 00-10 0C5 12.4 10 17 10 17z", "M10 9.5h.01"],
  comment: ["M3 4h14v9H9l-4 3.5V13H3z"],
  layers: ["M10 3l7 4-7 4-7-4z", "M3 10.5l7 4 7-4", "M3 13.5l7 4 7-4"],
};

const NS = "http://www.w3.org/2000/svg";

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("ed-ic");
  for (const d of ICON_PATHS[name]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/**
 * Give a toolbar button an icon. With `label` the text stays beside it; without, the button is icon-only: the text moves
 * to aria-label and the tooltip (which then starts with the name), so it is still named for screen readers and mice.
 */
export function iconify<T extends HTMLButtonElement>(b: T, name: IconName, label: boolean): T {
  const text = (b.textContent ?? "").trim();
  const plain = text.replace(/…$/, "");
  b.textContent = "";
  b.append(icon(name));
  if (label) b.append(Object.assign(document.createElement("span"), { className: "ed-lbl", textContent: text }));
  else {
    b.classList.add("icon-only");
    b.setAttribute("aria-label", plain);
    if (!b.title.startsWith(plain)) b.title = `${plain}: ${b.title}`;
  }
  b.dataset.icon = name;
  return b;
}
