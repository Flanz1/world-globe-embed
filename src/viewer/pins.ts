/**
 * Map pins in the embed, shared by the globe and flat viewers: ?pins=1 (or ?pins=holy-sites for one pin map) fetches
 * pins/<slot>.json and draws each pin as a small round marker on top of the map and the regions. A marker
 * shows its name on hover or focus; clicking it opens a card with the description and a link (normally to
 * the place's note in the Obsidian vault). Everything from the data is set with textContent or checked
 * first (links must be https), and the markers are plain DOM: no extra canvas, no WebGL.
 */
import { pinIcon, inkFor } from "../shared/pin-icons.ts";
import { leftStack } from "./stack.ts";
import { PIN_ID, PIN_KINDS, kindInfo, cleanLegends, kindLabel, legendTitle, markerSize, resolveLegend, type PinLegends, parsePinsFile, parsePinsParam, pinColor, pinShown, safeLink, type PinData } from "../shared/pins.ts";

/** Where a pin is on screen, or that it can't be seen (far side of the globe, outside the flat view). */
export interface PinPoint {
  x: number;
  y: number;
  visible: boolean;
}

/** Asks the viewer to zoom in on these pins ([lon, lat] in the map image's frame); false if it can't zoom in any further. */
export type ZoomTo = (points: [number, number][]) => boolean;

export interface PinLayer {
  /** Positions every marker. `project` gets a pin's [lon, lat] in the map image's frame. */
  place(project: (at: [number, number]) => PinPoint): void;
  /** Takes the markers and the card off the page. */
  destroy(): void;
}

const CSS = `
.wpins{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.wpin{all:unset;box-sizing:border-box;position:absolute;left:0;top:0;display:grid;place-items:center;border-radius:50%;border:2px solid rgba(255,255,255,.92);box-shadow:0 1px 4px rgba(0,0,0,.55);cursor:pointer;pointer-events:auto;will-change:transform}
.wpin[hidden]{display:none}
.wpin:focus-visible{outline:2px solid #fff;outline-offset:2px}
.wpin[aria-expanded=true]{box-shadow:0 0 0 3px rgba(255,255,255,.55),0 1px 4px rgba(0,0,0,.55);z-index:2}
.wpin::after{content:attr(data-name);position:absolute;left:50%;bottom:calc(100% + 5px);transform:translateX(-50%);padding:2px 7px;border-radius:5px;background:rgba(20,18,14,.85);color:#f3ead8;font:600 12px/1.3 system-ui,sans-serif;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;opacity:0;pointer-events:none;transition:opacity .12s}
.wpin:hover::after,.wpin:focus-visible::after{opacity:1}
.wpin:hover,.wpin:focus-visible{z-index:2}
.wpin-card{position:absolute;left:8px;bottom:8px;z-index:3;box-sizing:border-box;width:min(300px,calc(100% - 16px));max-height:60%;overflow:auto;padding:10px 12px;border-radius:8px;background:rgba(20,18,14,.9);color:#f3ead8;font:13px/1.4 system-ui,sans-serif;pointer-events:auto}
.wpin-card[hidden]{display:none}
.wpin-card h3{margin:0 24px 2px 0;font:700 14px/1.3 system-ui,sans-serif;overflow-wrap:anywhere}
.wpin-card .kind{margin:0 0 6px;font-size:11px;opacity:.7}
.wpin-card p{margin:0 0 8px;overflow-wrap:anywhere}
.wpin-card a{display:inline-block;padding:4px 10px;border-radius:6px;background:#c9a94e;color:#1b1812;font-weight:600;text-decoration:none}
.wpin-card a:focus-visible,.wpin-card .x:focus-visible{outline:2px solid #fff;outline-offset:2px}
.wpin-card .x{all:unset;position:absolute;right:6px;top:6px;width:22px;height:22px;display:grid;place-items:center;border-radius:5px;cursor:pointer;font-size:16px;line-height:1}
.wpin-card .x:hover{background:rgba(255,255,255,.15)}
.wpin.wcl{border-color:rgba(243,234,216,.9);background:rgba(20,18,14,.92);color:#f3ead8;font:700 12px/1 system-ui,sans-serif;box-shadow:0 0 0 3px var(--ring,rgba(243,234,216,.3)),0 1px 4px rgba(0,0,0,.55)}
.wcl-list{position:absolute;z-index:3;box-sizing:border-box;width:min(240px,calc(100% - 16px));max-height:50%;overflow:auto;padding:4px;border-radius:8px;background:rgba(20,18,14,.92);color:#f3ead8;font:13px/1.3 system-ui,sans-serif;pointer-events:auto}
.wcl-list[hidden]{display:none}
.wcl-list button{all:unset;box-sizing:border-box;display:block;width:100%;padding:6px 8px;border-radius:5px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcl-list button:hover{background:rgba(255,255,255,.15)}
.wcl-list button:focus-visible{outline:2px solid #f3ead8;outline-offset:-2px}
.wpl{border-radius:10px;background:var(--embed-panel,rgba(20,18,14,.8));-webkit-backdrop-filter:var(--embed-blur);backdrop-filter:var(--embed-blur);color:#f3ead8;font:12px/1.3 system-ui,sans-serif;display:flex;flex-direction:column;overflow:hidden;order:2}
.wpl[hidden]{display:none}
.wpl-head{all:unset;box-sizing:border-box;display:block;width:100%;padding:4px 8px;font-weight:600;cursor:pointer}
.wpl-head::after{content:"▾";margin-left:6px;opacity:.7}.wpl-head[aria-expanded=false]::after{content:"▸"}
.wpl-chips{display:flex;flex-direction:column;gap:3px;padding:0 6px 6px;overflow:auto;max-height:calc(6 * 31px)}
.wpl-chips[hidden]{display:none}
.wpl-chip{all:unset;box-sizing:border-box;display:flex;align-items:center;min-height:28px;cursor:pointer}
.wpl-pill{flex:1;min-width:0;display:flex;align-items:center;gap:6px;min-height:28px;padding:0 8px;border-radius:14px;border:1px solid rgba(243,234,216,.45);background:rgba(243,234,216,.16);white-space:nowrap}
.wpl-pill i{flex:none;display:grid;place-items:center;width:18px;height:18px;border-radius:50%}
.wpl-pill span{overflow:hidden;text-overflow:ellipsis}
.wpl-pill .n{margin-left:auto;padding-left:8px;opacity:.75;text-decoration:none}
.wpl-pill::after{content:"✓";flex:none;width:12px;text-align:center}
.wpl-chip[aria-pressed=false] .wpl-pill{background:none;border-color:rgba(243,234,216,.3)}
.wpl-chip[aria-pressed=false] .wpl-pill::after{content:""}
.wpl-chip[aria-pressed=false] .wpl-pill span:not(.n){text-decoration:line-through;opacity:.8}
.wpl-chip:focus-visible .wpl-pill,.wpl-head:focus-visible{outline:2px solid #f3ead8;outline-offset:1px}
.wpl-head:focus-visible{outline-offset:-2px}
@media (pointer:coarse){.wpl-chips{max-height:none;gap:0}.wpl-chip{min-height:44px}}
`.replace(/\n/g, "");

/** Fetches and draws this slot's pins if the page asked for them (?pins=…); null when it didn't or there is nothing to show. */
/** `fallback` is what a region embed asks for by itself (the region's pin maps) when the URL has no ?pins=. */
export async function setupPins(stage: HTMLElement, canvas: HTMLElement, slug: string, search = location.search, fallback?: string, zoomTo?: ZoomTo, legends?: PinLegends): Promise<PinLayer | null> {
  const sel = parsePinsParam(new URLSearchParams(search).get("pins") ?? fallback);
  // The admin preview page has no pins file of its own: it gets them from the admin page (watchPreviewPins).
  if (!sel || !PIN_ID.test(slug)) return null;
  let file: ReturnType<typeof parsePinsFile>;
  try {
    const r = await fetch(new URL(`../../pins/${slug}.json`, location.href));
    file = r.ok ? parsePinsFile(await r.json()) : null;
  } catch {
    file = null;
  }
  // The legend words belong to the region's pin maps, so they only apply when the embed shows those (not an own ?pins=).
  return buildPins(stage, canvas, file, sel, zoomTo, new URLSearchParams(search).has("pins") ? undefined : legends, fallback?.split(",") ?? []);
}

/**
 * Admin preview only: the admin page sends the pins to show ({ type: "wge-pins", file, show }), as it has them
 * before they are deployed. Only same-origin messages from the parent count; the data is validated like a fetched file.
 */
export function watchPreviewPins(stage: HTMLElement, canvas: HTMLElement, set: (layer: PinLayer | null) => void, zoomTo?: ZoomTo): void {
  let layer: PinLayer | null = null;
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== "wge-pins") return;
    layer?.destroy();
    const sel = parsePinsParam(typeof e.data.show === "string" ? e.data.show : null);
    layer = sel ? buildPins(stage, canvas, parsePinsFile(e.data.file), sel, zoomTo, cleanLegends(e.data.legends), typeof e.data.show === "string" ? e.data.show.split(",") : []) : null;
    set(layer);
  });
  // The viewer starts after the page has loaded, so the admin page can't know when it's listening: ask for the pins.
  if (window.parent !== window) window.parent.postMessage({ type: "wge-pins-wanted" }, location.origin);
}

function buildPins(stage: HTMLElement, canvas: HTMLElement, file: ReturnType<typeof parsePinsFile>, sel: NonNullable<ReturnType<typeof parsePinsParam>>, zoomTo?: ZoomTo, legends?: PinLegends, order: string[] = []): PinLayer | null {
  const mapName = new Map((file?.maps ?? []).map((m) => [m.id, m.name]));
  const labelOf = (p: PinData) => (p.pinMap && mapName.get(p.pinMap)) || "";
  const pins = (file?.pins ?? []).filter((p) => pinShown(sel, p));
  if (!pins.length) return null;
  const legend = resolveLegend(pins, legends, order);

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
    kind.textContent = labelOf(p) ? `${labelOf(p)} · ${kindLabel(p.kind, legend)}` : kindLabel(p.kind, legend);
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
  const gone = new AbortController();
  stage.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && open) {
        const b = open;
        close();
        b.focus();
      }
    },
    { signal: gone.signal },
  );
  // A click on the map itself (not a marker) puts the card away.
  canvas.addEventListener("pointerdown", close, { signal: gone.signal });

  const size = markerSize(Math.min(stage.clientWidth, stage.clientHeight));
  const markers = pins.map((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wpin";
    b.hidden = true;
    b.dataset.name = p.name;
    b.setAttribute("aria-label", `${p.name}, ${labelOf(p) ? `${labelOf(p)}, ` : ""}${kindLabel(p.kind, legend)}`);
    b.setAttribute("aria-expanded", "false");
    const bg = pinColor(p);
    b.style.background = bg;
    b.style.color = inkFor(bg);
    b.style.width = b.style.height = `${size}px`;
    b.append(pinIcon(p.kind, Math.round(size * 0.6)));
    b.addEventListener("click", () => show(b, p));
    layer.append(b);
    return { b, p, x: 0, y: 0, on: false };
  });

  /* ── Kind filter: one toggle chip per kind present, in the top-left stack ── */
  const off = new Set<string>();
  const counts = new Map<string, number>();
  for (const p of pins) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  let lastProject: ((at: [number, number]) => PinPoint) | null = null;
  let panel: HTMLElement | null = null;
  if (counts.size >= 2) {
    panel = document.createElement("div");
    panel.className = "wpl";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "wpl-head";
    head.textContent = legendTitle(legend);
    const chips = document.createElement("div");
    chips.className = "wpl-chips";
    chips.id = "wpl-chips";
    head.setAttribute("aria-controls", chips.id);
    const fold = (open: boolean) => {
      head.setAttribute("aria-expanded", String(open));
      head.title = open ? "Hide pin filter" : "Show pin filter";
      chips.hidden = !open;
    };
    fold(stage.clientWidth >= 420);
    head.addEventListener("click", () => fold(head.getAttribute("aria-expanded") !== "true"));
    for (const k of PIN_KINDS) {
      const n = counts.get(k.id);
      if (!n) continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "wpl-chip";
      chip.setAttribute("aria-pressed", "true");
      chip.setAttribute("aria-label", `${kindLabel(k.id, legend)}, ${n} ${n === 1 ? "pin" : "pins"}`);
      const sw = document.createElement("i");
      sw.style.background = k.color;
      sw.style.color = inkFor(k.color);
      sw.append(pinIcon(k.id, 12));
      const label = document.createElement("span");
      const count = document.createElement("span");
      count.className = "n";
      count.textContent = String(n);
      label.textContent = kindLabel(k.id, legend);
      const pill = document.createElement("span");
      pill.className = "wpl-pill";
      pill.append(sw, label, count);
      chip.append(pill);
      chip.addEventListener("click", () => {
        const now = !off.has(k.id);
        if (now) off.add(k.id);
        else off.delete(k.id);
        chip.setAttribute("aria-pressed", String(!now));
        closeList();
        if (open && off.has(markers.find((m) => m.b === open)!.p.kind)) close();
        if (lastProject) cluster(lastProject);
      });
      chips.append(chip);
    }
    panel.append(head, chips);
    for (const t of ["pointerdown", "wheel"] as const) panel.addEventListener(t, (e) => e.stopPropagation());
    leftStack(stage).append(panel);
  }

  /* ── Clusters: markers that would overlap merge into one numbered marker ── */
  const gap = size * 1.1;
  const csize = size + 8;
  const clusterEls: HTMLButtonElement[] = [];
  const list = document.createElement("div");
  list.className = "wcl-list";
  list.hidden = true;
  stage.append(list);
  function closeList(): void {
    list.hidden = true;
  }
  const showList = (members: { p: PinData; b: HTMLButtonElement }[], x: number, y: number) => {
    list.replaceChildren(
      ...members.map(({ p, b }) => {
        const it = document.createElement("button");
        it.type = "button";
        it.textContent = p.name;
        it.addEventListener("click", () => {
          closeList();
          b.hidden = false;
          show(b, p);
          b.focus();
        });
        return it;
      }),
    );
    list.style.left = `${Math.max(8, Math.min(x - 120, stage.clientWidth - 248))}px`;
    list.style.top = `${Math.max(8, Math.min(y + csize / 2 + 4, stage.clientHeight - 60))}px`;
    list.hidden = false;
    (list.firstElementChild as HTMLElement | null)?.focus();
  };
  stage.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !list.hidden) closeList();
    },
    { signal: gone.signal },
  );
  canvas.addEventListener("pointerdown", closeList, { signal: gone.signal });

  const clusterBtn = (i: number): HTMLButtonElement => {
    let c = clusterEls[i];
    if (!c) {
      c = document.createElement("button");
      c.type = "button";
      c.className = "wpin wcl";
      c.style.width = c.style.height = `${csize}px`;
      layer.append(c);
      clusterEls[i] = c;
    }
    return c;
  };
  const clusterData = new Map<HTMLButtonElement, { members: typeof markers; x: number; y: number }>();
  layer.addEventListener("click", (e) => {
    const c = (e.target as Element).closest<HTMLButtonElement>(".wcl");
    const d = c && clusterData.get(c);
    if (!d) return;
    closeList();
    const pts = d.members.map((m) => m.p.at);
    const spread = Math.max(...pts.map((a) => Math.abs(a[0] - pts[0][0]) + Math.abs(a[1] - pts[0][1])));
    if (spread < 1e-4 || !zoomTo || !zoomTo(pts)) showList(d.members, d.x, d.y);
  });

  /** Positions every marker and merges those that would overlap. */
  function cluster(project: (at: [number, number]) => PinPoint): void {
    lastProject = project;
    const cell = gap;
    const grid = new Map<string, { x: number; y: number; members: typeof markers }[]>();
    const groups: { x: number; y: number; members: typeof markers }[] = [];
    const keyOf = (cx: number, cy: number) => `${cx},${cy}`;
    for (const m of markers) {
      const pt = project(m.p.at);
      m.on = pt.visible && Number.isFinite(pt.x) && Number.isFinite(pt.y) && !off.has(m.p.kind);
      m.x = pt.x;
      m.y = pt.y;
      if (!m.on) continue;
      // The open marker stays a single pin so its card keeps pointing at something.
      let g: (typeof groups)[number] | undefined;
      if (m.b !== open) {
        const cx = Math.floor(m.x / cell);
        const cy = Math.floor(m.y / cell);
        search: for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (const c of grid.get(keyOf(cx + dx, cy + dy)) ?? []) {
              if (Math.hypot(c.x - m.x, c.y - m.y) < gap && c.members[0].b !== open) {
                g = c;
                break search;
              }
            }
      }
      if (g) {
        g.members.push(m);
        continue;
      }
      g = { x: m.x, y: m.y, members: [m] };
      groups.push(g);
      const k = keyOf(Math.floor(m.x / cell), Math.floor(m.y / cell));
      const a = grid.get(k);
      if (a) a.push(g);
      else grid.set(k, [g]);
    }
    let ci = 0;
    clusterData.clear();
    for (const g of groups) {
      if (g.members.length === 1) {
        const m = g.members[0];
        if (m.b.hidden) m.b.hidden = false;
        m.b.style.transform = `translate(${Math.round(m.x - size / 2)}px,${Math.round(m.y - size / 2)}px)`;
        continue;
      }
      // Cluster centre: the mean of its members.
      const x = g.members.reduce((a, m) => a + m.x, 0) / g.members.length;
      const y = g.members.reduce((a, m) => a + m.y, 0) / g.members.length;
      const c = clusterBtn(ci++);
      const n = g.members.length;
      const kinds = new Set(g.members.map((m) => m.p.kind));
      c.textContent = String(n);
      c.dataset.name = `${n} pins`;
      c.setAttribute("aria-label", `${n} pins, zoom in`);
      c.style.setProperty("--ring", kinds.size === 1 ? kindInfo([...kinds][0]).color : "rgba(243,234,216,.3)");
      c.hidden = false;
      c.style.transform = `translate(${Math.round(x - csize / 2)}px,${Math.round(y - csize / 2)}px)`;
      clusterData.set(c, { members: g.members, x, y });
      for (const m of g.members) m.b.hidden = true;
    }
    for (let i = ci; i < clusterEls.length; i++) clusterEls[i].hidden = true;
    for (const m of markers) if (!m.on && !m.b.hidden) m.b.hidden = true;
  }

  return {
    destroy() {
      gone.abort();
      layer.remove();
      card.remove();
      list.remove();
      panel?.remove();
      style.remove();
    },
    place: cluster,
  };
}
