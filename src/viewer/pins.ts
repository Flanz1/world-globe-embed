/**
 * Map pins in the embed, shared by the globe and flat viewers: ?pins=1 (or ?pins=holy-sites for one pin map) fetches
 * pins/<slot>.json and draws each pin as a small round marker on top of the map and the regions. A marker
 * shows its name on hover or focus; clicking it opens a card with the description and a link (normally to
 * the place's note in the Obsidian vault). Everything from the data is set with textContent or checked
 * first (links must be https), and the markers are plain DOM: no extra canvas, no WebGL.
 */
import { pinIcon, inkFor } from "../shared/pin-icons.ts";
import { PIN_ID, kindInfo, markerSize, parsePinsFile, parsePinsParam, pinColor, pinShown, safeLink, type PinData } from "../shared/pins.ts";

/** Where a pin is on screen, or that it can't be seen (far side of the globe, outside the flat view). */
export interface PinPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface PinLayer {
  /** Positions every marker. `project` gets a pin's [lon, lat] in the map image's frame. */
  place(project: (at: [number, number]) => PinPoint): void;
}

const CSS = `
.wpins{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.wpin{all:unset;box-sizing:border-box;position:absolute;left:0;top:0;display:grid;place-items:center;border-radius:50%;border:2px solid rgba(255,255,255,.92);box-shadow:0 1px 4px rgba(0,0,0,.55);cursor:pointer;pointer-events:auto;will-change:transform}
.wpin[hidden]{display:none}
.wpin:focus-visible{outline:2px solid #fff;outline-offset:2px}
.wpin[aria-expanded=true]{box-shadow:0 0 0 3px rgba(255,255,255,.55),0 1px 4px rgba(0,0,0,.55);z-index:2}
.wpin::after{content:attr(data-name);position:absolute;left:50%;bottom:calc(100% + 5px);transform:translateX(-50%);padding:2px 7px;border-radius:5px;background:rgba(20,18,14,.85);color:#f3ead8;font:600 12px/1.3 system-ui,sans-serif;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;opacity:0;pointer-events:none;transition:opacity .12s}
.wpin:hover::after,.wpin:focus-visible::after{opacity:1}
.wpin-card{position:absolute;left:8px;bottom:8px;z-index:3;box-sizing:border-box;width:min(300px,calc(100% - 16px));max-height:60%;overflow:auto;padding:10px 12px;border-radius:8px;background:rgba(20,18,14,.9);color:#f3ead8;font:13px/1.4 system-ui,sans-serif;pointer-events:auto}
.wpin-card[hidden]{display:none}
.wpin-card h3{margin:0 24px 2px 0;font:700 14px/1.3 system-ui,sans-serif;overflow-wrap:anywhere}
.wpin-card .kind{margin:0 0 6px;font-size:11px;opacity:.7}
.wpin-card p{margin:0 0 8px;overflow-wrap:anywhere}
.wpin-card a{display:inline-block;padding:4px 10px;border-radius:6px;background:#c9a94e;color:#1b1812;font-weight:600;text-decoration:none}
.wpin-card a:focus-visible,.wpin-card .x:focus-visible{outline:2px solid #fff;outline-offset:2px}
.wpin-card .x{all:unset;position:absolute;right:6px;top:6px;width:22px;height:22px;display:grid;place-items:center;border-radius:5px;cursor:pointer;font-size:16px;line-height:1}
.wpin-card .x:hover{background:rgba(255,255,255,.15)}
`.replace(/\n/g, "");

/** Fetches and draws this slot's pins if the page asked for them (?pins=…); null when it didn't or there is nothing to show. */
/** `fallback` is what a region embed asks for by itself (the region's pin maps) when the URL has no ?pins=. */
export async function setupPins(stage: HTMLElement, canvas: HTMLElement, slug: string, search = location.search, fallback?: string): Promise<PinLayer | null> {
  const sel = parsePinsParam(new URLSearchParams(search).get("pins") ?? fallback);
  // The admin preview page has no pins of its own.
  if (!sel || !PIN_ID.test(slug)) return null;
  let file: ReturnType<typeof parsePinsFile>;
  try {
    const r = await fetch(new URL(`../../pins/${slug}.json`, location.href));
    file = r.ok ? parsePinsFile(await r.json()) : null;
  } catch {
    file = null;
  }
  const mapName = new Map((file?.maps ?? []).map((m) => [m.id, m.name]));
  const labelOf = (p: PinData) => (p.pinMap && mapName.get(p.pinMap)) || "";
  const pins = (file?.pins ?? []).filter((p) => pinShown(sel, p));
  if (!pins.length) return null;

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const layer = document.createElement("div");
  layer.className = "wpins";
  const card = document.createElement("div");
  card.className = "wpin-card";
  card.hidden = true;
  card.setAttribute("role", "dialog");
  stage.append(layer, card);

  // Wheel over a marker still zooms the map (the markers sit above the canvas).
  layer.addEventListener(
    "wheel",
    (e) => {
      const fwd = new WheelEvent("wheel", { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, cancelable: true, bubbles: false });
      canvas.dispatchEvent(fwd);
      if (fwd.defaultPrevented) e.preventDefault();
    },
    { passive: false },
  );

  let open: HTMLButtonElement | null = null;
  const close = () => {
    open?.setAttribute("aria-expanded", "false");
    open = null;
    card.hidden = true;
  };
  const show = (btn: HTMLButtonElement, p: PinData) => {
    if (open === btn) return close();
    open?.setAttribute("aria-expanded", "false");
    open = btn;
    btn.setAttribute("aria-expanded", "true");
    const title = document.createElement("h3");
    title.textContent = p.name;
    const kind = document.createElement("p");
    kind.className = "kind";
    kind.textContent = labelOf(p) ? `${labelOf(p)} · ${kindInfo(p.kind).label}` : kindInfo(p.kind).label;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "x";
    x.textContent = "×";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", close);
    const parts: Node[] = [x, title, kind];
    if (p.description) {
      const d = document.createElement("p");
      d.textContent = p.description;
      parts.push(d);
    }
    const href = p.link ? safeLink(p.link) : null;
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Open note";
      parts.push(a);
    }
    card.replaceChildren(...parts);
    card.setAttribute("aria-label", p.name);
    card.hidden = false;
  };
  stage.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      const b = open;
      close();
      b.focus();
    }
  });
  // A click on the map itself (not a marker) puts the card away.
  canvas.addEventListener("pointerdown", close);

  const size = markerSize(Math.min(stage.clientWidth, stage.clientHeight));
  const markers = pins.map((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wpin";
    b.hidden = true;
    b.dataset.name = p.name;
    b.setAttribute("aria-label", `${p.name}, ${labelOf(p) ? `${labelOf(p)}, ` : ""}${kindInfo(p.kind).label}`);
    b.setAttribute("aria-expanded", "false");
    const bg = pinColor(p);
    b.style.background = bg;
    b.style.color = inkFor(bg);
    b.style.width = b.style.height = `${size}px`;
    b.append(pinIcon(p.kind, Math.round(size * 0.6)));
    b.addEventListener("click", () => show(b, p));
    layer.append(b);
    return { b, p };
  });

  const half = size / 2;
  return {
    place(project) {
      for (const { b, p } of markers) {
        const pt = project(p.at);
        const on = pt.visible && Number.isFinite(pt.x) && Number.isFinite(pt.y);
        if (b.hidden === on) b.hidden = !on;
        if (on) b.style.transform = `translate(${Math.round(pt.x - half)}px,${Math.round(pt.y - half)}px)`;
      }
    },
  };
}
