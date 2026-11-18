/** The editor's side panel: one set of sections, shown as collapsible sections beside the map on wide screens and as
 *  tabs in a bottom sheet (peek / half / full) under it on phones and tablets. */
import { h } from "../dom.ts";

export type SheetSection = { id: string; title: string; children: (Node | null | false)[] };
import { SNAPS, nearestSnap, snapHeights, type SnapName } from "./sheet-math.ts";
const SHEET_KEY = "wge-ed-sheet";
const TAB_KEY = "wge-ed-tab";
const SEC_KEY = (id: string) => `wge-ed-sec-${id}`;
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

export function sidePanel(opts: { frame: HTMLElement; banners: HTMLElement[]; sections: SheetSection[] }): { el: HTMLElement; refresh: () => void } {
  const mq = matchMedia(SHEET_QUERY);
  const el = h("div", { className: "ed-side" });
  let snap: SnapName = (SNAPS as string[]).includes(read(sessionStorage, SHEET_KEY) ?? "") ? (read(sessionStorage, SHEET_KEY) as SnapName) : "peek";
  let active = read(sessionStorage, TAB_KEY) ?? opts.sections[0].id;
  if (!opts.sections.some((s) => s.id === active)) active = opts.sections[0].id;

  const handle = h("button", { type: "button", className: "ed-handle", ariaLabel: "Resize panel", title: "Resize panel: drag, or press the arrow keys" });
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-valuemin", "0");
  handle.setAttribute("aria-valuemax", "2");
  handle.append(h("span", { className: "ed-handle-bar", ariaHidden: "true" }));
  const tabs = h("div", { className: "ed-tabs", role: "tablist", ariaLabel: "Panel sections" });
  const secs = opts.sections.map((s) => {
    const bodyId = `ed-sec-${s.id}`;
    const tab = h("button", { type: "button", className: "ed-tab", textContent: s.title, id: `${bodyId}-tab` });
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", bodyId);
    tab.dataset.sec = s.id;
    const toggle = h("button", { type: "button", className: "rfolder-toggle ghost ed-sec-toggle" }, h("span", { className: "rfolder-arrow", ariaHidden: "true", textContent: "▾" }), h("span", { textContent: s.title }));
    toggle.setAttribute("aria-controls", bodyId);
    const body = h("div", { className: "ed-sec-body", id: bodyId }, ...s.children);
    const head = h("h3", { className: "ed-sec-head" }, toggle);
    const sec = h("section", { className: "ed-sec" }, head, body);
    sec.dataset.sec = s.id;
    const collapsed = read(localStorage, SEC_KEY(s.id)) === "closed";
    const setOpen = (open: boolean) => {
      sec.classList.toggle("collapsed", !open);
      sec.classList.toggle("closed", !open); // .closed turns the arrow, as in the folder trees
      toggle.setAttribute("aria-expanded", String(open));
    };
    setOpen(!collapsed);
    toggle.addEventListener("click", () => {
      const open = sec.classList.contains("collapsed");
      setOpen(open);
      write(localStorage, SEC_KEY(s.id), open ? "open" : "closed");
    });
    tabs.append(tab);
    return { s, tab, sec, body, toggle };
  });

  // The minimap: the globe preview cropped to its globe (no corner buttons), with a tap target that opens the sheet.
  const thumbHit = h("button", { type: "button", className: "ed-thumb-hit", ariaLabel: "Show or hide the panel", title: "Show or hide the panel" });
  const thumb = h("div", { className: "ed-thumb" }, opts.frame, thumbHit);
  const peek = h("div", { className: "ed-peek" }, thumb, tabs);
  const scroll = h("div", { className: "ed-side-body" }, ...opts.banners, ...secs.map((x) => x.sec));
  el.append(h("div", { className: "ed-sheet-head" }, handle, peek), scroll);

  const bodyEl = (): HTMLElement | null => el.parentElement;
  const total = () => bodyEl()?.clientHeight ?? 600;
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
    write(sessionStorage, TAB_KEY, id);
    for (const x of secs) {
      const on = x.s.id === id;
      x.tab.setAttribute("aria-selected", String(on));
      x.tab.tabIndex = on ? 0 : -1;
      x.sec.classList.toggle("active", on);
    }
  };
  const refresh = (): void => {
    for (const x of secs) {
      const v = visible(x);
      x.tab.hidden = !v;
      x.sec.hidden = !v;
    }
    const first = secs.find(visible);
    if (first && !secs.some((x) => x.s.id === active && visible(x))) show(first.s.id);
    else show(active);
  };
  const mode = (): void => {
    const sheet = mq.matches;
    el.dataset.mode = sheet ? "sheet" : "panel";
    for (const x of secs) {
      if (sheet) {
        x.body.setAttribute("role", "tabpanel");
        x.body.setAttribute("aria-labelledby", x.tab.id);
      } else {
        x.body.removeAttribute("role");
        x.body.removeAttribute("aria-labelledby");
      }
    }
    if (sheet) setSnap(snap, false);
    else applyHeight(null);
  };

  for (const x of secs)
    x.tab.addEventListener("click", () => {
      show(x.s.id);
      if (snap === "peek") setSnap("half");
    });
  thumbHit.addEventListener("click", () => setSnap(snap === "peek" ? "half" : "peek"));
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
    if (!mq.matches || (e.target as HTMLElement).closest(".ed-tab, iframe")) return;
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
    refresh: () => {
      refresh();
      mode();
    },
  };
}
