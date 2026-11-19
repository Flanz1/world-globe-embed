/**
 * The region editor's Pin tool: a toggle in the toolbar. While it is on, click the map to drop a pin, click a pin to
 * edit it, drag a pin to move it, drag empty map to pan. A small popover (a bottom sheet on phones) holds the pin's
 * form: name, kind, pin map (or a new one), description and link. Pins save on their own, one commit each, through the
 * Pins tab's save code; they are not part of the region's Save or its undo history.
 */
import { h } from "../dom.ts";
import { pinIcon } from "../../shared/pin-icons.ts";
import { PIN_DESCRIPTION_MAX, PIN_KINDS, PIN_NAME_MAX, isPinKind, kindInfo, type PinFeature, type PinKind } from "../../shared/pins.ts";
import { mapsOfSlot } from "../../shared/pinmaps.ts";
import { confirmBox } from "../region-dialogs.ts";
import { canDelete, canEdit, can } from "../session.ts";
import { deletePinById, savePinFrom } from "../pins.ts";
import { newMap, pinMaps } from "../pinmaps.ts";
import type { PinsLayer } from "./pins-layer.ts";

export interface PinToolOptions {
  canvas: HTMLCanvasElement;
  pins: PinsLayer;
  slot: string;
  /** The slot's map id (saved in each pin). */
  mapId: string;
  /** Canvas CSS pixels of a pointer event. */
  local: (e: PointerEvent) => { x: number; y: number };
  /** Longitude and latitude at canvas CSS pixels. */
  lonLat: (x: number, y: number) => [number, number];
  /** Canvas CSS pixels of a longitude and latitude. */
  toScreen: (lon: number, lat: number) => [number, number];
  /** The canvas's CSS size. */
  size: () => { w: number; h: number };
  offsets: () => number[];
  view: { get: () => { cx: number; cy: number; k: number }; pan: (dxPx: number, dyPx: number) => void; zoom: (factor: number, x: number, y: number) => void };
  /** The pin tool turned on or off (the editor drops other tools' half-finished work). */
  onToggle: (on: boolean) => void;
}

export interface PinTool {
  button: HTMLButtonElement;
  popover: HTMLElement;
  active: () => boolean;
  toggle: (on?: boolean) => void;
  /** Resolves true when it is fine to carry on (no pin form with unsaved changes, or the person discarded it). */
  okToLeave: () => Promise<boolean>;
  /** Closes the popover, or leaves the tool when none is open. Returns true if the tool was on. */
  escape: () => boolean;
  /** Puts the popover beside its pin (call after the view changed). */
  reposition: () => void;
}

/** The kind and pin map of the last pin, so placing several in a row doesn't mean choosing them each time. */
let lastKind: PinKind = "city";
let lastPinMap = "";

const round = (n: number) => Math.round(n * 10000) / 10000;

export function createPinTool(o: PinToolOptions): PinTool {
  let on = false;
  let draft: PinFeature | null = null;
  let isNew = false;
  let snapshot = "";
  let busy = false;

  const button = h("button", { type: "button", className: "ghost", textContent: "Pin", title: "Pin (I): click the map to place a pin, click a pin to edit it, drag a pin to move it, drag the map to pan", ariaPressed: "false", dataset: { act: "pin-tool" } });
  const popover = h("div", { className: "ed-pin-pop", hidden: true, role: "dialog", ariaLabel: "Pin" });
  for (const t of ["pointerdown", "pointerup", "mousedown", "wheel", "dblclick", "contextmenu"] as const) popover.addEventListener(t, (e) => e.stopPropagation());

  const state = (f: PinFeature) => JSON.stringify([f.properties, f.geometry.coordinates]);
  const dirty = (): boolean => !!draft && state(draft) !== snapshot;

  async function okToLeave(): Promise<boolean> {
    if (!dirty()) return true;
    const keep = !(await confirmBox("Unsaved pin", "The pin you are editing has changes that aren't saved. Discard them?", "Discard pin", "Keep editing", true));
    if (keep) return false;
    closePopover();
    return true;
  }

  function closePopover(): void {
    if (popover.contains(document.activeElement)) o.canvas.focus();
    draft = null;
    popover.hidden = true;
    popover.replaceChildren();
    o.pins.setDraft(null);
  }

  /** Opens the form for a saved pin, or for a new one at `at`. */
  async function open(f: PinFeature | null, at?: [number, number]): Promise<void> {
    if (draft && draft.id === f?.id && !isNew && f) return;
    if (!(await okToLeave())) return;
    isNew = !f;
    draft = f
      ? structuredClone(f)
      : { $schema: "../../schema/pin.schema.json", type: "Feature", id: "", properties: { slot: o.slot, map: o.mapId, name: "", kind: lastKind, ...(lastPinMap && mapsOfSlot(pinMaps(), o.slot).some((m) => m.id === lastPinMap) ? { pinMap: lastPinMap } : {}) }, geometry: { type: "Point", coordinates: at! } };
    snapshot = state(draft);
    o.pins.setDraft(draft);
    render();
    popover.hidden = false;
    reposition();
    (popover.querySelector("input[type=text]") as HTMLInputElement | null)?.focus();
  }

  /** Beside the pin (right of it, or left when that doesn't fit), never over it; on phones CSS makes it a bottom sheet. */
  function reposition(): void {
    if (!draft || popover.hidden) return;
    if (window.matchMedia("(max-width: 600px)").matches) {
      popover.style.left = popover.style.top = "";
      return;
    }
    const { w, h: hh } = o.size();
    const [lon, lat] = draft.geometry.coordinates;
    const [px, py] = o.toScreen(lon, lat);
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

  function render(): void {
    const f = draft;
    if (!f) return;
    const p = f.properties;
    const ok = isNew ? can("regions") : canEdit(f);
    const name = h("input", { type: "text", maxLength: PIN_NAME_MAX, value: p.name, disabled: !ok, autocomplete: "off", ariaLabel: "Name", name: "pin-name" });
    const kindLabel = h("span", { className: "small", textContent: `Kind: ${kindInfo(p.kind).label}` });
    const kinds = h(
      "div",
      { className: "ed-pin-kinds", role: "radiogroup", ariaLabel: "Kind (decides the icon)" },
      ...PIN_KINDS.map((k) => {
        const b = h("button", { type: "button", className: "ghost tiny ed-kind", role: "radio", ariaChecked: String(k.id === p.kind), tabIndex: k.id === p.kind ? 0 : -1, disabled: !ok, dataset: { kind: k.id }, title: k.label, ariaLabel: k.label }, pinIcon(k.id, 20));
        b.style.setProperty("--kind", k.color);
        b.addEventListener("click", () => {
          p.kind = k.id;
          kindLabel.textContent = `Kind: ${k.label}`;
          for (const c of kinds.querySelectorAll<HTMLElement>("[data-kind]")) {
            c.setAttribute("aria-checked", String(c.dataset.kind === k.id));
            c.tabIndex = c.dataset.kind === k.id ? 0 : -1;
          }
          sync();
        });
        b.addEventListener("keydown", (e) => {
          const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          const all = [...kinds.querySelectorAll<HTMLButtonElement>("[data-kind]")];
          const next = all[(all.indexOf(b) + step + all.length) % all.length];
          next.click();
          next.focus();
        });
        return b;
      }),
    );
    const maps = mapsOfSlot(pinMaps(), o.slot);
    const NEW = "__new";
    const pinMap = h(
      "select",
      { disabled: !ok, ariaLabel: "Pin map", name: "pin-map" },
      h("option", { value: "", textContent: "No pin map" }),
      ...maps.map((m) => h("option", { value: m.id, textContent: m.name, selected: m.id === p.pinMap })),
      ...(ok && can("regions") ? [h("option", { value: NEW, textContent: "New pin map…" })] : []),
    );
    const desc = h("textarea", { rows: 2, maxLength: PIN_DESCRIPTION_MAX, value: p.description ?? "", disabled: !ok, ariaLabel: "Description", name: "pin-description" });
    const link = h("input", { type: "url", value: p.link ?? "", disabled: !ok, placeholder: "https://… (the place's note)", autocomplete: "off", ariaLabel: "Link", name: "pin-link" });
    const err = h("p", { className: "error small", role: "alert" });
    const save = h("button", { type: "submit", textContent: "Save pin", dataset: { act: "pin-save" } });
    const del = h("button", { type: "button", className: "ghost danger", textContent: "Delete pin", dataset: { act: "pin-delete" } });
    const sync = () => {
      p.name = name.value;
      const d = desc.value.trim();
      if (d) p.description = d;
      else delete p.description;
      const l = link.value.trim();
      if (l) p.link = l;
      else delete p.link;
      err.textContent = "";
      save.disabled = !dirty();
      o.pins.setDraft(f);
    };
    for (const c of [name, desc, link]) c.addEventListener("input", sync);
    pinMap.addEventListener("change", () => {
      if (pinMap.value === NEW) {
        pinMap.value = p.pinMap ?? "";
        newMap(o.slot, null, (id) => {
          p.pinMap = id;
          render();
          sync();
        });
        return;
      }
      if (pinMap.value) p.pinMap = pinMap.value;
      else delete p.pinMap;
      sync();
    });
    const cancel = h("button", { type: "button", className: "ghost", textContent: "Cancel", dataset: { act: "pin-close" } });
    const form = h(
      "form",
      { className: "ed-pin-form" },
      h("div", { className: "ed-pin-head" }, h("strong", { textContent: isNew ? "New pin" : "Pin" })),
      h(
        "div",
        { className: "ed-pin-body" },
        h("label", {}, "Name", name),
        h("div", { className: "ed-pin-kindfield" }, kindLabel, kinds),
        h("label", {}, "Pin map", pinMap),
        h("label", {}, `Description (optional)`, desc),
        h("label", {}, "Link to the note (optional)", link),
        h("p", { className: "muted small", textContent: `${f.geometry.coordinates[1].toFixed(2)}° lat, ${f.geometry.coordinates[0].toFixed(2)}° lon${ok ? " · drag the pin to move it" : ""}` }),
        err,
        ok ? null : h("p", { className: "muted small", textContent: "You can look at this pin, but only the person who placed it (or someone allowed to edit others' regions) can change it." }),
      ),
      h("div", { className: "ed-pin-foot" }, !isNew && canDelete(f) ? del : null, h("span", { className: "grow" }), cancel, ok ? save : null),
    );
    save.disabled = !dirty();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void commit(err);
    });
    cancel.addEventListener("click", () => void okToLeave().then((go) => go && closePopover()));
    del.addEventListener("click", () => void remove(err));
    form.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") void okToLeave().then((go) => go && closePopover());
    });
    popover.replaceChildren(form);
    reposition();
  }

  async function commit(err: HTMLElement): Promise<void> {
    if (!draft || busy) return;
    busy = true;
    const f = draft;
    const why = await savePinFrom(f, isNew);
    busy = false;
    if (why) return void (err.textContent = why);
    lastKind = isPinKind(f.properties.kind) ? f.properties.kind : lastKind;
    lastPinMap = f.properties.pinMap ?? "";
    closePopover();
    o.pins.refresh();
  }

  async function remove(err: HTMLElement): Promise<void> {
    if (!draft || isNew) return;
    const f = draft;
    if (!(await confirmBox("Delete pin", `Delete “${f.properties.name}”? Embeds that show pins stop showing it once the site has rebuilt.`, "Delete pin", "Cancel", true))) return;
    const why = await deletePinById(f.id);
    if (why) return void (err.textContent = why);
    closePopover();
    o.pins.refresh();
  }

  /* ── The map ── */
  type Gesture = { kind: "pin"; id: string; x: number; y: number; moved: boolean; editable: boolean } | { kind: "map"; x: number; y: number; moved: boolean } | { kind: "pinch"; d: number; mx: number; my: number } | null;
  let gesture: Gesture = null;
  /** Fingers (and the mouse) currently down, so two fingers can pinch-zoom while the tool is on. */
  const pts = new Map<number, { x: number; y: number }>();
  const mine = (e: Event) => {
    if (!on) return false;
    e.stopImmediatePropagation();
    return true;
  };
  o.canvas.addEventListener(
    "pointerdown",
    (e) => {
      if (!mine(e) || e.button !== 0) return;
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
        return;
      }
      if (pts.size > 2) return;
      const hit = o.pins.pinAt(x, y, o.offsets());
      if (hit) {
        const editable = hit === draft ? (isNew ? can("regions") : canEdit(hit)) : canEdit(hit);
        gesture = { kind: "pin", id: hit.id, x, y, moved: false, editable };
        if (hit !== draft) void open(hit);
      } else gesture = { kind: "map", x, y, moved: false };
    },
    true,
  );
  o.canvas.addEventListener(
    "pointermove",
    (e) => {
      if (!on) return;
      if (!gesture) return; // hover tooltips etc. carry on as usual
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
      if (gesture.kind === "pin") {
        if (!gesture.editable || !draft) return;
        let [lon, lat] = o.lonLat(x, y);
        lon = ((((lon + 180) % 360) + 360) % 360) - 180;
        lat = Math.max(-90, Math.min(90, lat));
        draft.geometry.coordinates = [round(lon), round(lat)];
        o.pins.setDraft(draft);
        render();
      } else {
        o.view.pan(x - gesture.x, y - gesture.y);
        gesture.x = x;
        gesture.y = y;
      }
    },
    true,
  );
  const up = (e: PointerEvent) => {
    if (!mine(e)) return;
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
    if (g?.kind === "map" && !g.moved && e.type === "pointerup" && can("regions")) {
      let [lon, lat] = o.lonLat(g.x, g.y);
      lon = ((((lon + 180) % 360) + 360) % 360) - 180;
      lat = Math.max(-90, Math.min(90, lat));
      void open(null, [round(lon), round(lat)]);
    }
  };
  o.canvas.addEventListener("pointerup", up, true);
  o.canvas.addEventListener("pointercancel", up, true);
  o.canvas.addEventListener("dblclick", (e) => void mine(e), true);

  function toggle(v = !on): void {
    if (v === on) return;
    if (!v && dirty()) {
      void okToLeave().then((go) => go && toggle(false));
      return;
    }
    on = v;
    button.setAttribute("aria-pressed", String(on));
    o.pins.force(on);
    o.canvas.style.cursor = on ? "crosshair" : "";
    if (!on) closePopover();
    o.onToggle(on);
  }
  button.addEventListener("click", () => toggle());

  return {
    button,
    popover,
    active: () => on,
    toggle,
    okToLeave,
    reposition,
    escape: () => {
      if (!on) return false;
      if (draft) void okToLeave().then((go) => go && closePopover());
      else toggle(false);
      return true;
    },
  };
}
