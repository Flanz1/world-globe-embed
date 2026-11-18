/**
 * The region editor's Pin tool: a toggle in the toolbar. While it is on, click the map to drop a pin, click a pin to
 * edit it, drag a pin to move it, drag empty map to pan. A small popover (a bottom sheet on phones) holds the pin's
 * form: name, kind, pin map (or a new one), description and link. Pins save on their own, one commit each, through the
 * Pins tab's save code; they are not part of the region's Save or its undo history.
 */
import { h } from "../dom.ts";
import { pinIcon } from "../../shared/pin-icons.ts";
import { PIN_DESCRIPTION_MAX, PIN_KINDS, PIN_NAME_MAX, isPinKind, type PinFeature, type PinKind } from "../../shared/pins.ts";
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
  offsets: () => number[];
  view: { get: () => { cx: number; cy: number; k: number }; pan: (dxPx: number, dyPx: number) => void };
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
  /** Closes the popover (and leaves the tool when `leave`). Returns true if something was closed. */
  escape: () => boolean;
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
    (popover.querySelector("input[type=text]") as HTMLInputElement | null)?.focus();
  }

  function render(): void {
    const f = draft;
    if (!f) return;
    const p = f.properties;
    const ok = isNew ? can("regions") : canEdit(f);
    const name = h("input", { type: "text", maxLength: PIN_NAME_MAX, value: p.name, disabled: !ok, autocomplete: "off", ariaLabel: "Name", name: "pin-name" });
    const kinds = h(
      "div",
      { className: "ed-pin-kinds", role: "radiogroup", ariaLabel: "Kind (decides the icon)" },
      ...PIN_KINDS.map((k) => {
        const b = h("button", { type: "button", className: "ghost tiny ed-kind", role: "radio", ariaChecked: String(k.id === p.kind), disabled: !ok, dataset: { kind: k.id }, title: k.label }, pinIcon(k.id, 14), h("span", { textContent: k.label }));
        b.style.setProperty("--kind", k.color);
        b.addEventListener("click", () => {
          p.kind = k.id;
          for (const c of kinds.querySelectorAll<HTMLElement>("[data-kind]")) c.setAttribute("aria-checked", String(c.dataset.kind === k.id));
          sync();
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
    const close = h("button", { type: "button", className: "ghost", textContent: "Close", dataset: { act: "pin-close" } });
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
    const form = h(
      "form",
      { className: "ed-pin-form" },
      h("div", { className: "ed-pin-head" }, h("strong", { textContent: isNew ? "New pin" : "Pin" }), close),
      h("label", {}, "Name", name),
      kinds,
      h("label", {}, "Pin map", pinMap),
      h("label", {}, `Description (optional)`, desc),
      h("label", {}, "Link to the note (optional)", link),
      h("p", { className: "muted small", textContent: `${f.geometry.coordinates[1].toFixed(2)}° lat, ${f.geometry.coordinates[0].toFixed(2)}° lon${ok ? " · drag the pin to move it" : ""}` }),
      err,
      h("div", { className: "row" }, ok ? save : null, !isNew && canDelete(f) ? del : null),
      ok ? null : h("p", { className: "muted small", textContent: "You can look at this pin, but only the person who placed it (or someone allowed to edit others' regions) can change it." }),
    );
    save.disabled = !dirty();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void commit(err);
    });
    close.addEventListener("click", () => void okToLeave().then((go) => go && closePopover()));
    del.addEventListener("click", () => void remove(err));
    form.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") void okToLeave().then((go) => go && closePopover());
    });
    popover.replaceChildren(form);
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
  type Gesture = { kind: "pin"; id: string; x: number; y: number; moved: boolean; editable: boolean } | { kind: "map"; x: number; y: number; moved: boolean } | null;
  let gesture: Gesture = null;
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
      o.canvas.setPointerCapture(e.pointerId);
      const { x, y } = o.local(e);
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
    const g = gesture;
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
    escape: () => {
      if (!on) return false;
      if (draft) void okToLeave().then((go) => go && closePopover());
      else toggle(false);
      return true;
    },
  };
}
