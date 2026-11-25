/**
 * Region cards, shared by the globe and flat viewers: clicking (or tapping) a part of the region opens a small card
 * with facts worked out at build time (facts/<region>.json, fetched on the first click): the part's area (km² and
 * share of the world), the regions it borders and the pins inside it. Nothing is computed or stored at run time.
 * Everything from the data is set with textContent. A press that moves more than a few pixels stays a drag, and
 * clicks are ignored while the ruler is on.
 */
import { pointInPolygon, polygonsOf, type Position, type Ring } from "../shared/geo.ts";
import { nameFromId, parseFacts, type FactsFile } from "../shared/facts.ts";
import { sphereAreaKm2, validRadius } from "../shared/measure.ts";
import { pinIcon } from "../shared/pin-icons.ts";
import { kindInfo, parsePinsParam, pinShown } from "../shared/pins.ts";
import { REGION_ID, type RegionData } from "../shared/region.ts";

export interface RegionCardHost {
  canvas: HTMLCanvasElement;
  stage: HTMLElement;
  /** Position in the map image's frame (like the regions' coordinates) under a stage-local point, or null off the map. */
  pick(x: number, y: number): Position | null;
  /** The region as it is drawn now (stacked regions that were switched off are already out of it), or null before it has loaded. */
  region(): RegionData | null;
  /** Stage-local position of a position in the map image's frame (`nearX`: the previous point's x, so the flat map picks the right repeat). */
  project(p: Position, nearX?: number): { x: number; y: number; ok: boolean };
}

const CSS = `
.wfact{position:absolute;left:8px;bottom:8px;z-index:3;box-sizing:border-box;width:min(300px,calc(100% - 16px));max-height:60%;overflow:auto;padding:10px 12px;border-radius:8px;background:rgba(20,18,14,.9);color:#f3ead8;font:13px/1.4 system-ui,sans-serif;pointer-events:auto}
.wfact[hidden]{display:none}
/* Phones: the corner buttons are a vertical column on the right (#198), so the card stays at the bottom and stops short of it. */
@media (max-width:420px){.wfact{width:min(300px,calc(100% - 68px))}}
@media (max-width:420px) and (pointer:coarse){.wfact{width:min(300px,calc(100% - 76px))}}
.wfact h3{margin:0 34px 2px 0;font:700 14px/1.3 system-ui,sans-serif;overflow-wrap:anywhere}
.wfact .sub,.wfact .muted{margin:0 0 6px;font-size:12px;color:#c9bfab}
.wfact dl{margin:6px 0 0;display:grid;gap:6px;border-top:1px solid #c9a94e;padding-top:6px}
.wfact dt{font-size:11px;font-weight:600;letter-spacing:.02em;color:#c9bfab}
.wfact dd{margin:0;overflow-wrap:anywhere}
.wfact ul{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.wfact li{display:flex;align-items:center;gap:6px;min-width:0}
.wfact li svg{flex:none}
.wfact li small{color:#c9bfab}
.wfact .x{all:unset;position:absolute;right:4px;top:4px;width:32px;height:32px;display:grid;place-items:center;border-radius:6px;cursor:pointer;font-size:20px;line-height:1}\n@media (pointer:coarse){.wfact .x{width:44px;height:44px;right:0;top:0}}\n.wfact-hl{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.wfact .x:hover{background:rgba(255,255,255,.15)}
.wfact .x:focus-visible{outline:2px solid #fff;outline-offset:2px}
`.replace(/\n/g, "");

const NEIGHBOURS_SHOWN = 8;
const PINS_SHOWN = 6;

/** "12,300 km²", "1.2 million km²": the reader's number format. */
const km2 = (v: number): string => {
  const n = (x: number, d: number) => x.toLocaleString(undefined, { maximumFractionDigits: d });
  return v >= 1e6 ? `${n(v / 1e6, 2)} million km²` : `${n(v, v < 10 ? 2 : v < 100 ? 1 : 0)} km²`;
};
/** At most one decimal; "<0.1%" for tiny shares. */
const percent = (fraction: number): string => {
  const p = fraction * 100;
  return p < 0.1 ? "<0.1%" : `${p.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
};

/** The member of the drawn region a point is in (the one on top), with the index of its part; null if none. Underlays are cut copies, so only whole regions count. */
export function hitPart(r: RegionData, at: Position): { region: RegionData; part: number } | null {
  const list = r.members ? r.members.filter((m) => !m.underOf && !(r.clip && m !== r.members![r.members!.length - 1])) : [r];
  for (let m = list.length - 1; m >= 0; m--) {
    const polys = polygonsOf(list[m].geometry);
    for (let k = polys.length - 1; k >= 0; k--) if (pointInPolygon(at, polys[k])) return { region: list[m], part: k };
  }
  return null;
}

export function setupRegionCard(cfg: { radius: number; pins?: string }, host: RegionCardHost, search = location.search): { redraw(): void } {
  const radius = validRadius(cfg.radius) ? cfg.radius : 0;
  // Pins show in the card only if the embed shows them (?pins=…, or the region's own pin maps).
  const pinSel = parsePinsParam(new URLSearchParams(search).get("pins") ?? cfg.pins);

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const card = document.createElement("div");
  card.className = "wfact";
  card.hidden = true;
  card.setAttribute("role", "dialog");
  const hl = document.createElement("canvas");
  hl.className = "wfact-hl";
  hl.setAttribute("aria-hidden", "true");
  host.stage.append(hl, card);
  // The part the card is about, outlined on the map; redrawn whenever the view moves.
  let shown: Ring[] | null = null;
  const redraw = (): void => {
    if (!shown && !hl.width) return;
    const w = Math.max(1, host.stage.clientWidth);
    const h = Math.max(1, host.stage.clientHeight);
    const d = Math.min(window.devicePixelRatio || 1, 2);
    if (hl.width !== Math.round(w * d) || hl.height !== Math.round(h * d)) {
      hl.width = Math.round(w * d);
      hl.height = Math.round(h * d);
    }
    const g = hl.getContext("2d")!;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!shown) return;
    g.lineJoin = g.lineCap = "round";
    for (const [width, color] of [[6, "rgba(255,255,255,.55)"], [2.5, "#ffd36a"]] as const) {
      g.lineWidth = width;
      g.strokeStyle = color;
      for (const ring of shown) {
        g.beginPath();
        let pen = false;
        let prev: number | undefined;
        for (const p of ring) {
          const s = host.project(p, prev);
          prev = s.x;
          if (!s.ok) pen = false;
          else if (pen) g.lineTo(s.x, s.y);
          else {
            g.moveTo(s.x, s.y);
            pen = true;
          }
        }
        g.stroke();
      }
    }
  };

  const cache = new Map<string, Promise<FactsFile | null>>();
  const load = (id: string, parts: number): Promise<FactsFile | null> => {
    const key = `${id}:${parts}`;
    let p = cache.get(key);
    if (!p) {
      p = fetch(new URL(`../../facts/${id}.json`, location.href))
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => parseFacts(j, parts))
        .catch(() => null);
      cache.set(key, p);
    }
    return p;
  };

  let token = 0;
  const close = (): void => {
    token++;
    card.hidden = true;
    shown = null;
    redraw();
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = ""): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const row = (label: string, ...content: (Node | string)[]): [HTMLElement, HTMLElement] => {
    const dt = el("dt", label);
    const dd = el("dd");
    dd.append(...content);
    return [dt, dd];
  };
  const size = (fraction: number): string => (radius ? `${km2(fraction * sphereAreaKm2(radius))} · ${percent(fraction)} of the world` : `${percent(fraction)} of the world`);

  function render(hit: { region: RegionData; part: number }, f: FactsFile): HTMLElement[] {
    const part = f.p[hit.part];
    const list = el("dl");
    list.append(...row("Area", size(part.a)));
    if (f.p.length > 1) list.append(...row("Whole region", size(f.t)));
    if (part.n?.length) {
      const names = part.n.map((k) => f.r[k].name || nameFromId(f.r[k].id));
      const more = names.length - NEIGHBOURS_SHOWN;
      list.append(...row("Borders with", names.slice(0, NEIGHBOURS_SHOWN).join(", ") + (more > 0 ? ` and ${more} more` : "")));
    }
    const pins = pinSel ? (part.i ?? []).map((k) => f.i[k]).filter((p) => pinShown(pinSel, { kind: p.kind, pinMap: p.map })) : [];
    if (pins.length) {
      const ul = el("ul");
      for (const p of pins.slice(0, PINS_SHOWN)) {
        const li = el("li");
        li.append(pinIcon(p.kind), el("span", p.name), el("small", kindInfo(p.kind).label));
        ul.append(li);
      }
      if (pins.length > PINS_SHOWN) ul.append(el("li", `and ${pins.length - PINS_SHOWN} more`));
      list.append(...row("Pins here", ul));
    }
    return [list];
  }

  function open(hit: { region: RegionData; part: number }, viaTouch: boolean): void {
    const mine = ++token;
    const r = hit.region;
    const regionName = r.name.trim() || nameFromId(r.id);
    const label = (r.labels[hit.part] ?? "").trim();
    const title = label || regionName;
    const x = el("button", "×");
    x.type = "button";
    x.className = "x";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", close);
    const body = el("p", "Loading facts…", "muted");
    card.replaceChildren(x, el("h3", title), ...(label && label !== regionName ? [el("p", regionName, "sub")] : []), body);
    card.setAttribute("aria-label", `${title} facts`);
    card.hidden = false;
    shown = polygonsOf(r.geometry)[hit.part] ?? null;
    redraw();
    // Touch moves focus to × (after the click the browser sends next, which would otherwise take it back to the page).
    if (viaTouch) {
      const stop = new AbortController();
      host.canvas.addEventListener("click", () => x.focus(), { once: true, signal: stop.signal });
      setTimeout(() => stop.abort(), 500);
    }
    const id = r.id.split("@")[0];
    if (!REGION_ID.test(id)) return void (body.textContent = "Facts aren't available right now");
    void load(id, polygonsOf(r.geometry).length).then((f) => {
      if (mine !== token) return;
      if (f) body.replaceWith(...render(hit, f));
      else body.textContent = "Facts aren't available right now";
    });
  }

  // A click is a press and release in nearly the same place, so drags (and pinches) still move the view.
  const down = new Map<number, { x: number; y: number; t: number }>();
  let multi = false;
  host.canvas.addEventListener("pointerdown", (e) => {
    if (down.size) multi = true;
    down.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
  });
  host.canvas.addEventListener("pointercancel", (e) => {
    down.delete(e.pointerId);
    if (!down.size) multi = false;
  });
  host.canvas.addEventListener("pointerup", (e) => {
    const s = down.get(e.pointerId);
    down.delete(e.pointerId);
    if (down.size) return;
    const wasMulti = multi;
    multi = false;
    if (!s || wasMulti || e.button > 0 || host.canvas.dataset.ruler === "on") return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6 || performance.now() - s.t > 700) return;
    const reg = host.region();
    if (!reg) return;
    const rect = host.canvas.getBoundingClientRect();
    const at = host.pick(e.clientX - rect.left, e.clientY - rect.top);
    const hit = at && hitPart(reg, at);
    // Mouse clicks leave the focus where it is; touch moves it to ×.
    if (hit) open(hit, e.pointerType === "touch" || e.pointerType === "pen");
    else close();
  });
  // Esc closes it from anywhere; a pin card opening (its marker is clicked) puts this one away.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !card.hidden) close();
  });
  host.stage.addEventListener(
    "click",
    (e) => {
      if ((e.target as Element | null)?.closest?.(".wpin")) close();
    },
    true,
  );
  return { redraw };
}
