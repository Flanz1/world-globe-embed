/**
 * The region editor's Comment tool: a toggle in the toolbar, next to Pin ("Comments 2" shows how many are open). While it
 * is on, click the map to leave a comment at that spot ("the border looks off here"); the region's comments show as
 * numbered markers, and clicking one opens it. People who may edit the region can Resolve (and Reopen) a comment; its
 * author or an editor can delete it. Comments are stored by the admin API (worker/src/comments.ts), never in the
 * region file, so they don't take part in Save or undo. A "Show resolved comments" switch lives in the Other regions panel.
 *
 * The popover looks like the Pin tool's (same form classes and rules, a bottom sheet on phones). The markers are real buttons laid over the canvas.
 */
import { h } from "../dom.ts";
import type { MapComment } from "../github.ts";
import { addComment, commentsFor, deleteComment, loadComments, onCommentsChange, openCountFor, setCommentStatus } from "../comments.ts";
import { confirmBox } from "../region-dialogs.ts";
import { canEditCreatedBy, currentUser } from "../session.ts";

export const COMMENT_MAX = 240;
const round = (n: number) => Math.round(n * 10000) / 10000;
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

export interface CommentToolOptions {
  canvas: HTMLCanvasElement;
  /** The region being edited, or null when it isn't saved yet (then the tool is switched off with `why`). */
  region: string | null;
  why: string;
  local: (e: PointerEvent) => { x: number; y: number };
  lonLat: (x: number, y: number) => [number, number];
  toScreen: (lon: number, lat: number) => [number, number];
  size: () => { w: number; h: number };
  offsets: () => number[];
  view: { pan: (dxPx: number, dyPx: number) => void; zoom: (factor: number, x: number, y: number) => void };
  /** The tool turned on or off (the editor switches the other tools off). */
  onToggle: (on: boolean) => void;
}

export interface CommentTool {
  button: HTMLButtonElement;
  /** The "Show resolved comments" row, for the Other regions panel. */
  row: HTMLElement;
  popover: HTMLElement;
  /** Holds the markers; goes over the map. */
  markers: HTMLElement;
  active: () => boolean;
  toggle: (on?: boolean) => void;
  okToLeave: () => Promise<boolean>;
  /** Closes the popover, or leaves the tool when none is open. Returns true if the tool was on. */
  escape: () => boolean;
  /** Puts the markers and the popover where the view says (call after the view changed). */
  reposition: () => void;
  /** Stops listening for comment changes (the editor closed). */
  dispose: () => void;
}

export function createCommentTool(o: CommentToolOptions): CommentTool {
  let on = false;
  let showResolved = false;
  /** The comment open in the popover, or a new one being written at `at`. */
  let sel: string | null = null;
  let at: [number, number] | null = null;
  let text = "";
  let busy = false;

  const count = h("span", { className: "ed-cm-count", ariaHidden: "true", hidden: true });
  const button = h("button", { type: "button", className: "ghost", ariaPressed: "false", dataset: { act: "comment-tool" } }, "Comments", count);
  const popover = h("div", { className: "ed-cm-pop", hidden: true, role: "dialog", ariaLabel: "Comment" });
  const markers = h("div", { className: "ed-cm-markers" });
  for (const t of ["pointerdown", "pointerup", "mousedown", "wheel", "dblclick", "contextmenu"] as const) popover.addEventListener(t, (e) => e.stopPropagation());
  const box = h("input", { type: "checkbox", name: "ed-comments-resolved" });
  const row = h("label", { className: "check ed-ov-comments", title: "Also show the comments that were ticked off" }, box, "Show resolved comments");
  box.addEventListener("change", () => {
    showResolved = box.checked;
    paintMarkers(true);
  });

  const mine = (): MapComment[] => (o.region ? commentsFor(o.region) : []);
  const shown = (): MapComment[] => mine().filter((c) => showResolved || c.status === "open" || c.id === sel);
  const current = (): MapComment | null => (sel ? (mine().find((c) => c.id === sel) ?? null) : null);

  function syncButton(): void {
    const n = o.region ? openCountFor(o.region) : 0;
    count.textContent = n ? String(n) : "";
    count.hidden = !n;
    button.setAttribute("aria-label", n ? `Comments, ${n} open` : "Comments");
    button.disabled = !o.region;
    button.title = o.region ? "Comments: click the map to leave a comment at that spot, click a numbered marker to read it" : o.why;
  }

  const dirty = () => !sel && !!at && text.trim().length > 0;
  async function okToLeave(): Promise<boolean> {
    if (!dirty()) return true;
    if (!(await confirmBox("Unposted comment", "The comment you are writing isn't posted yet. Discard it?", "Discard comment", "Keep writing", true))) return false;
    close();
    return true;
  }

  function close(): void {
    if (popover.contains(document.activeElement)) o.canvas.focus();
    sel = null;
    at = null;
    text = "";
    popover.hidden = true;
    popover.replaceChildren();
    paintMarkers(true);
  }

  async function openNew(lon: number, lat: number): Promise<void> {
    if (!(await okToLeave())) return;
    sel = null;
    at = [round(wrapLon(lon)), round(Math.max(-90, Math.min(90, lat)))];
    text = "";
    render();
    popover.hidden = false;
    paintMarkers(true);
    reposition();
    popover.querySelector("textarea")?.focus();
  }

  async function openExisting(c: MapComment): Promise<void> {
    if (sel === c.id) return;
    if (!(await okToLeave())) return;
    sel = c.id;
    at = null;
    render();
    popover.hidden = false;
    paintMarkers(true);
    reposition();
    (popover.querySelector("button[data-act=comment-resolve], button[data-act=comment-close]") as HTMLElement | null)?.focus();
  }

  const anchor = (): [number, number] | null => (at ? at : (() => {
    const c = current();
    return c ? [c.lon, c.lat] : null;
  })());

  /** Beside the spot (right of it, or left when that doesn't fit); on phones CSS makes it a bottom sheet. */
  function placePopover(): void {
    const a = anchor();
    if (!a || popover.hidden) return;
    if (window.matchMedia("(max-width: 600px)").matches) {
      popover.style.left = popover.style.top = "";
      return;
    }
    const { w, h: hh } = o.size();
    const [px, py] = nearest(a[0], a[1]) ?? o.toScreen(a[0], a[1]);
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    const gap = 22;
    let x = px + gap;
    if (x + pw > w - 8) x = px - gap - pw;
    x = Math.max(8, Math.min(w - pw - 8, x));
    const y = Math.max(8, Math.min(hh - ph - 8, py - ph / 2));
    popover.style.left = `${Math.round(x)}px`;
    popover.style.top = `${Math.round(y)}px`;
  }

  /** Screen position of a spot in the world copy that is on screen, if any. */
  function nearest(lon: number, lat: number): [number, number] | null {
    const { w } = o.size();
    for (const off of o.offsets()) {
      const [x, y] = o.toScreen(lon + off, lat);
      if (x >= -12 && x <= w + 12) return [x, y];
    }
    return null;
  }

  function render(): void {
    const c = current();
    const me = currentUser();
    const err = h("p", { className: "error small", role: "alert" });
    popover.replaceChildren();
    if (!c) {
      if (!at) return;
      const ta = h("textarea", { rows: 3, maxLength: COMMENT_MAX, value: text, ariaLabel: "Comment", name: "comment-text", placeholder: "e.g. The border looks off here" });
      const count = h("span", { className: "muted small", ariaLive: "polite" });
      const post = h("button", { type: "submit", textContent: "Post comment", disabled: true, dataset: { act: "comment-post" } });
      const sync = () => {
        text = ta.value;
        post.disabled = !text.trim() || busy;
        count.textContent = text.length >= COMMENT_MAX - 40 ? `${text.length}/${COMMENT_MAX}` : "";
        err.textContent = "";
      };
      ta.addEventListener("input", sync);
      const form = h(
        "form",
        { className: "ed-pin-form" },
        h("div", { className: "ed-pin-head" }, h("strong", { textContent: "New comment" })),
        h("div", { className: "ed-pin-body" }, h("label", {}, "Comment", ta), count, h("p", { className: "muted small", textContent: `${at[1].toFixed(2)}° lat, ${at[0].toFixed(2)}° lon · the region's editors will see it` }), err),
        h("div", { className: "ed-pin-foot" }, h("span", { className: "grow" }), h("button", { type: "button", className: "ghost", textContent: "Cancel", dataset: { act: "comment-close" }, onclick: () => void okToLeave().then((go) => go && close()) }), post),
      );
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        void send(err);
      });
      form.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") void okToLeave().then((go) => go && close());
      });
      sync();
      popover.append(form);
      return;
    }
    const mayResolve = canEditCreatedBy(c.owner);
    const mayDelete = mayResolve || c.by.id === me?.id;
    const act = (t: string, id: string, fn: () => Promise<unknown>, cls = "ghost") => h("button", { type: "button", className: cls, textContent: t, dataset: { act: id }, onclick: () => void fn().catch((e: Error) => (err.textContent = e.message)) });
    const form = h(
      "div",
      { className: "ed-pin-form" },
      h("div", { className: "ed-pin-head" }, h("strong", { textContent: `Comment by ${c.by.login}` }), h("span", { className: "muted small", textContent: ` · ${when(c.at)}${c.status === "resolved" ? ` · resolved by ${c.resolvedBy}` : ""}` })),
      h("div", { className: "ed-pin-body" }, h("p", { className: "ed-cm-text", textContent: c.text }), err),
      h(
        "div",
        { className: "ed-pin-foot" },
        mayDelete ? act("Delete", "comment-delete", () => remove(c), "ghost danger") : null,
        h("span", { className: "grow" }),
        act("Close", "comment-close", async () => close()),
        mayResolve ? act(c.status === "open" ? "Resolve" : "Reopen", "comment-resolve", () => setCommentStatus(c.id, c.status === "open" ? "resolved" : "open"), "tonal") : null,
      ),
    );
    form.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close();
    });
    popover.append(form);
  }

  async function send(err: HTMLElement): Promise<void> {
    if (!o.region || !at || busy || !text.trim()) return;
    busy = true;
    try {
      const c = await addComment(o.region, text, at[0], at[1]);
      busy = false;
      sel = null;
      at = null;
      text = "";
      await openExisting(c);
    } catch (e) {
      busy = false;
      err.textContent = (e as Error).message;
    }
  }

  async function remove(c: MapComment): Promise<void> {
    if (!(await confirmBox("Delete comment", "Delete this comment for good?", "Delete comment", "Cancel", true))) return;
    await deleteComment(c.id);
    close();
  }

  /* ── Markers: real buttons over the canvas ── */
  let key = "";
  const buttons = new Map<string, HTMLButtonElement>();
  function paintMarkers(force = false): void {
    const list = on ? shown() : [];
    const k = `${on}|${sel}|${at}|${list.map((c) => `${c.id}:${c.status}`).join(",")}`;
    if (k !== key || force) {
      key = k;
      buttons.clear();
      const out: HTMLElement[] = list.map((c, i) => {
        const b = h("button", { type: "button", className: `ed-cm-mark${c.status === "resolved" ? " resolved" : ""}`, ariaLabel: `Comment by ${c.by.login}: ${c.text.slice(0, 40)}${c.status === "resolved" ? " (resolved)" : ""}`, ariaPressed: String(c.id === sel), dataset: { comment: c.id }, textContent: c.status === "resolved" ? "✓" : String(i + 1) });
        b.addEventListener("click", () => void openExisting(c));
        buttons.set(c.id, b);
        return b;
      });
      if (at) out.push(h("span", { className: "ed-cm-mark new", ariaHidden: "true", dataset: { comment: "new" }, textContent: "+" }));
      markers.replaceChildren(...out);
    }
    positionMarkers();
  }
  function positionMarkers(): void {
    for (const el of markers.children as Iterable<HTMLElement>) {
      const id = el.dataset.comment;
      const c = id === "new" ? null : mine().find((x) => x.id === id);
      const spot: [number, number] | null = c ? [c.lon, c.lat] : at;
      const p = spot ? nearest(spot[0], spot[1]) : null;
      el.hidden = !p;
      if (p) {
        el.style.left = `${Math.round(p[0])}px`;
        el.style.top = `${Math.round(p[1])}px`;
      }
    }
  }
  function reposition(): void {
    if (!on) return;
    positionMarkers();
    placePopover();
  }

  /* ── The map: click to comment, drag to pan, two fingers to zoom (the other tools' gestures are off while this is on) ── */
  type Gesture = { kind: "map"; x: number; y: number; moved: boolean } | { kind: "pinch"; d: number; mx: number; my: number } | null;
  let gesture: Gesture = null;
  const pts = new Map<number, { x: number; y: number }>();
  const own = (e: Event) => {
    if (!on) return false;
    e.stopImmediatePropagation();
    return true;
  };
  o.canvas.addEventListener(
    "pointerdown",
    (e) => {
      if (!own(e) || e.button !== 0) return;
      o.canvas.focus();
      try {
        o.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* not an active pointer: carry on */
      }
      const { x, y } = o.local(e);
      pts.set(e.pointerId, { x, y });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        gesture = { kind: "pinch", d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      } else if (pts.size === 1) gesture = { kind: "map", x, y, moved: false };
    },
    true,
  );
  o.canvas.addEventListener(
    "pointermove",
    (e) => {
      if (!on || !gesture) return;
      e.stopImmediatePropagation();
      const { x, y } = o.local(e);
      const pt = pts.get(e.pointerId);
      if (pt) {
        pt.x = x;
        pt.y = y;
      }
      if (gesture.kind === "pinch") {
        if (pts.size !== 2) return;
        const [a, b] = [...pts.values()];
        const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        o.view.pan(mx - gesture.mx, my - gesture.my);
        o.view.zoom(d / gesture.d, mx, my);
        gesture = { kind: "pinch", d, mx, my };
        return;
      }
      if (!gesture.moved && Math.hypot(x - gesture.x, y - gesture.y) < 4) return;
      gesture.moved = true;
      o.view.pan(x - gesture.x, y - gesture.y);
      gesture.x = x;
      gesture.y = y;
    },
    true,
  );
  const up = (e: PointerEvent) => {
    if (!own(e)) return;
    pts.delete(e.pointerId);
    const g = gesture;
    if (g?.kind === "pinch") {
      if (pts.size < 2) {
        const rest = [...pts.values()][0];
        gesture = rest ? { kind: "map", x: rest.x, y: rest.y, moved: true } : null;
      }
      return;
    }
    gesture = null;
    if (g?.kind === "map" && !g.moved && e.type === "pointerup") {
      const [lon, lat] = o.lonLat(g.x, g.y);
      void openNew(lon, lat);
    }
  };
  o.canvas.addEventListener("pointerup", up, true);
  o.canvas.addEventListener("pointercancel", up, true);
  o.canvas.addEventListener("dblclick", (e) => void own(e), true);

  function toggle(v = !on): void {
    if (v && !o.region) return;
    if (v === on) return;
    if (!v && dirty()) {
      void okToLeave().then((go) => go && toggle(false));
      return;
    }
    on = v;
    button.setAttribute("aria-pressed", String(on));
    o.canvas.style.cursor = on ? "crosshair" : "";
    if (on) void loadComments();
    else close();
    paintMarkers(true);
    o.onToggle(on);
  }
  button.addEventListener("click", () => toggle());
  const stop = onCommentsChange(() => {
    syncButton();
    if (sel && !current()) close();
    else if (sel && !popover.hidden) render();
    paintMarkers();
  });
  syncButton();

  return {
    button,
    row,
    popover,
    markers,
    active: () => on,
    toggle,
    okToLeave,
    reposition,
    dispose: stop,
    escape: () => {
      if (!on) return false;
      if (sel || at) void okToLeave().then((go) => go && close());
      else toggle(false);
      return true;
    },
  };
}
