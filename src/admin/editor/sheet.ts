/** The editor's inspector: one set of tabbed sections (Region, Parts, Layers). Wide screens: a card floating over the
 *  map's right side that folds to an icon strip. Phones and tablets: a bottom sheet (peek / half / full) under the map.
 *  Also the minimap: the globe preview as a disc over the map's bottom left. */
import { h } from "../dom.ts";
import { icon, type IconName } from "./icons.ts";

export type SheetSection = { id: string; title: string; icon: IconName; children: (Node | null | false)[] };
import { SNAPS, nearestSnap, snapHeights, type SnapName } from "./sheet-math.ts";
const SHEET_KEY = "wge-ed-sheet";
const TAB_KEY = "wge-ed-tab";
const FOLD_KEY = "wge-ed-insp";
export const SHEET_QUERY = "(max-width: 860px)";

const read = (s: Storage, k: string): string | null => {
  try {
    return s.getItem(k);
  } catch {
    return null;
  }
};
const write = (s: Storage, k: string, v: string): void => {
  try {
    s.setItem(k, v);
  } catch {
    /* private window or blocked storage: the panel just doesn't remember */
  }
};

export function sidePanel(opts: { frame: HTMLElement; banners: HTMLElement[]; sections: SheetSection[]; embed?: () => void; onLayout?: () => void; start?: string }): {
  el: HTMLElement;
  minimap: HTMLElement;
  refresh: () => void;
  badge: (id: string, text: string) => void;
  show: (id: string) => void;
} {
  const mq = matchMedia(SHEET_QUERY);
  const el = h("div", { className: "ed-side" });
  let snap: SnapName = (SNAPS as string[]).includes(read(sessionStorage, SHEET_KEY) ?? "") ? (read(sessionStorage, SHEET_KEY) as SnapName) : "peek";
  // Wide screens open on opts.start (Parts; Region for a new region, which needs its id). The bottom sheet remembers its tab.
  let active = (mq.matches ? read(sessionStorage, TAB_KEY) : null) ?? opts.start ?? opts.sections[0].id;
  if (!opts.sections.some((s) => s.id === active)) active = opts.sections[0].id;

  const handle = h("button", { type: "button", className: "ed-handle", ariaLabel: "Resize panel", title: "Resize panel: drag, or press the arrow keys" });
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-valuemin", "0");
  handle.setAttribute("aria-valuemax", "2");
  handle.append(h("span", { className: "ed-handle-bar", ariaHidden: "true" }));
  const tabs = h("div", { className: "ed-tabs", role: "tablist", ariaLabel: "Panel sections" });
  /** The folded inspector: an icon strip (one per tab, then Embed code and Open). */
  const strip = h("div", { className: "ed-insp-strip", role: "toolbar", ariaLabel: "Inspector" });
  strip.setAttribute("aria-orientation", "vertical");
  const iconBtn = (name: IconName, label: string, act: string, onclick: () => void) => {
    const b = h("button", { type: "button", className: "ed-ib", title: label, ariaLabel: label, dataset: { act }, onclick });
    b.append(icon(name));
    return b;
  };
  const secs = opts.sections.map((s) => {
    const bodyId = `ed-sec-${s.id}`;
    const badge = h("span", { className: "ed-tab-badge", hidden: true });
    const tab = h("button", { type: "button", className: "ed-tab", id: `${bodyId}-tab` }, h("span", { className: "ed-tab-name", textContent: s.title }), badge);
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", bodyId);
    tab.dataset.sec = s.id;
    const body = h("div", { className: "ed-sec-body", id: bodyId }, ...s.children);
    const sec = h("section", { className: "ed-sec" }, body);
    sec.dataset.sec = s.id;
    sec.setAttribute("aria-label", s.title);
    const pick = iconBtn(s.icon, s.title, `inspector-${s.id}`, () => {
      show(s.id);
      setFolded(false);
    });
    pick.dataset.sec = s.id;
    tabs.append(tab);
    strip.append(pick);
    return { s, tab, sec, body, badge, pick };
  });

  // Wide screens: the inspector floats over the map and folds to the icon strip.
  let folded = read(localStorage, FOLD_KEY) === "folded";
  const setFolded = (f: boolean, save = true): void => {
    folded = f;
    if (save) write(localStorage, FOLD_KEY, f ? "folded" : "open");
    el.dataset.folded = String(f);
    foldBtn.setAttribute("aria-expanded", String(!f));
    if (save) opts.onLayout?.();
  };
  const embedBtn = opts.embed ? iconBtn("code", "Embed code…", "inspector-embed", opts.embed) : null;
  const foldBtn = iconBtn("panel", "Fold the inspector away", "inspector-fold", () => setFolded(true));
  strip.append(
    h("span", { className: "sep", ariaHidden: "true" }),
    ...(opts.embed ? [iconBtn("code", "Embed code…", "inspector-embed-strip", opts.embed)] : []),
    iconBtn("panel", "Open the inspector", "inspector-open", () => setFolded(false)),
  );
  const inspHead = h("div", { className: "ed-insp-head" }, h("strong", { className: "ed-insp-title", textContent: "Inspector" }), embedBtn, foldBtn);

  // The minimap: the globe preview, cropped to a disc over the map's bottom left; its button makes it bigger.
  const grow = iconBtn("expand", "Bigger globe", "minimap-size", () => {
    const big = minimap.classList.toggle("big");
    grow.title = big ? "Smaller globe" : "Bigger globe";
    grow.setAttribute("aria-label", grow.title);
    grow.setAttribute("aria-pressed", String(big));
  });
  grow.setAttribute("aria-pressed", "false");
  const minimap = h("div", { className: "ed-mini" }, h("div", { className: "ed-mini-disc" }, opts.frame), grow);
  for (const t of ["pointerdown", "mousedown", "wheel"] as const) minimap.addEventListener(t, (e) => e.stopPropagation());

  const scroll = h("div", { className: "ed-side-body" }, ...opts.banners, ...secs.map((x) => x.sec));
  el.append(h("div", { className: "ed-sheet-head" }, handle, inspHead, h("div", { className: "ed-peek" }, tabs)), scroll, strip);
  setFolded(folded, false);

  const bodyEl = (): HTMLElement | null => el.parentElement;
  /** The height the sheet and the map share: the body, less anything else stacked in it (the tool rail on phones). */
  const total = (): number => {
    const b = bodyEl();
    if (!b) return 600;
    let t = b.clientHeight;
    for (const c of b.children) if (c !== el && !c.classList.contains("ed-canvas-wrap")) t -= (c as HTMLElement).offsetHeight;
    return t;
  };
  const applyHeight = (px: number | null): void => {
    const b = bodyEl();
    if (!b) return;
    if (px === null || !mq.matches) b.style.removeProperty("--ed-sheet");
    else b.style.setProperty("--ed-sheet", `${Math.round(px)}px`);
  };
  const setSnap = (n: SnapName, save = true): void => {
    snap = n;
    if (save) write(sessionStorage, SHEET_KEY, n);
    applyHeight(snapHeights(total())[n]);
    handle.setAttribute("aria-valuenow", String(SNAPS.indexOf(n)));
    handle.setAttribute("aria-valuetext", n);
    el.dataset.snap = n;
  };
  const visible = (x: (typeof secs)[number]): boolean => [...x.body.children].some((c) => !(c as HTMLElement).hidden);
  const show = (id: string): void => {
    active = id;
    if (mq.matches) write(sessionStorage, TAB_KEY, id);
    for (const x of secs) {
      const on = x.s.id === id;
      x.tab.setAttribute("aria-selected", String(on));
      x.tab.tabIndex = on ? 0 : -1;
      x.sec.classList.toggle("active", on);
      x.pick.setAttribute("aria-pressed", String(on));
    }
  };
  const refresh = (): void => {
    for (const x of secs) {
      const v = visible(x);
      x.tab.hidden = !v;
      x.pick.hidden = !v;
      x.sec.hidden = !v;
    }
    const first = secs.find(visible);
    if (first && !secs.some((x) => x.s.id === active && visible(x))) show(first.s.id);
    else show(active);
  };
  for (const x of secs) {
    x.body.setAttribute("role", "tabpanel");
    x.body.setAttribute("aria-labelledby", x.tab.id);
  }
  const mode = (): void => {
    const sheet = mq.matches;
    el.dataset.mode = sheet ? "sheet" : "panel";
    if (sheet) setSnap(snap, false);
    else applyHeight(null);
    opts.onLayout?.();
  };
  // A banner (unsaved work kept, someone else editing) or an error message opens a folded inspector, so it isn't missed.
  const unfoldFor = new MutationObserver(() => {
    if (folded && opts.banners.some((b) => !b.hidden && (b.textContent ?? "").trim() && (!b.classList.contains("ed-msg") || b.classList.contains("error")))) {
      setFolded(false, false);
      opts.onLayout?.();
    }
  });
  for (const b of opts.banners) unfoldFor.observe(b, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });

  for (const x of secs)
    x.tab.addEventListener("click", () => {
      show(x.s.id);
      if (mq.matches && snap === "peek") setSnap("half");
    });
  tabs.addEventListener("keydown", (e) => {
    const shown = secs.filter((x) => !x.tab.hidden);
    const i = shown.findIndex((x) => x.tab === document.activeElement);
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d || i < 0) return;
    e.preventDefault();
    const n = shown[(i + d + shown.length) % shown.length];
    show(n.s.id);
    n.tab.focus();
  });

  // Drag the handle (or the strip around it); a tap steps up one height, then back to peek.
  let drag: { y: number; h0: number; moved: boolean } | null = null;
  const sheetHead = el.firstElementChild as HTMLElement;
  sheetHead.addEventListener("pointerdown", (e) => {
    if (!mq.matches || (e.target as HTMLElement).closest(".ed-tab")) return;
    drag = { y: e.clientY, h0: el.getBoundingClientRect().height, moved: false };
    sheetHead.setPointerCapture(e.pointerId);
  });
  sheetHead.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const s = snapHeights(total());
    applyHeight(Math.max(s.peek, Math.min(s.full, drag.h0 + dy)));
  });
  const end = (e: PointerEvent): void => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (sheetHead.hasPointerCapture(e.pointerId)) sheetHead.releasePointerCapture(e.pointerId);
    if (d.moved) setSnap(nearestSnap(el.getBoundingClientRect().height, total()));
    else if ((e.target as HTMLElement).closest(".ed-handle")) setSnap(SNAPS[(SNAPS.indexOf(snap) + 1) % SNAPS.length]);
  };
  sheetHead.addEventListener("pointerup", end);
  sheetHead.addEventListener("pointercancel", end);
  handle.addEventListener("keydown", (e) => {
    const i = SNAPS.indexOf(snap);
    const to = e.key === "ArrowUp" || e.key === "ArrowRight" ? i + 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? 2 : e.key === "Enter" || e.key === " " ? (i + 1) % 3 : -1;
    if (to < 0) return;
    e.preventDefault();
    setSnap(SNAPS[Math.max(0, Math.min(2, to))]);
  });
  // A pointer tap fires a click too; keyboard Enter/Space is handled above, so swallow the click.
  handle.addEventListener("click", (e) => e.preventDefault());

  mq.addEventListener("change", mode);
  addEventListener("resize", () => mq.matches && setSnap(snap, false));
  // Measuring needs the dialog to be shown, so the editor calls refresh() after showModal().
  return {
    el,
    minimap,
    show: (id) => {
      if (secs.some((x) => x.s.id === id && !x.tab.hidden)) show(id);
    },
    badge: (id, text) => {
      const x = secs.find((y) => y.s.id === id);
      if (!x) return;
      x.badge.textContent = text;
      x.badge.hidden = !text;
      x.pick.title = text ? `${x.s.title} (${text})` : x.s.title;
    },
    refresh: () => {
      refresh();
      mode();
    },
  };
}
