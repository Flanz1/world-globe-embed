/**
 * The Pins tab: places (cities, ruins, battle sites…) marked on a slot's map. Pick a slot, press "Place a
 * pin" and click the map, then fill in a name, kind, short description and an optional https link to the
 * place's note. Each pin is one file, content/pins/<id>.json, and every save is one commit. The map is a
 * small flat viewer of its own (drag to pan, wheel or the buttons to zoom); pins are plain DOM markers.
 * Embeds draw them with ?pins=1 (see viewer/pins.ts).
 */
import { escapeHtml } from "../shared/page.ts";
import { stringifyCompact } from "../shared/json.ts";
import { pinIcon, inkFor } from "../shared/pin-icons.ts";
import { PIN_DESCRIPTION_MAX, PIN_KINDS, PIN_NAME_MAX, PIN_ID, checkPin, isPinKind, kindInfo, pinColor, pinPath, safeLink, type PinFeature, type PinKind } from "../shared/pins.ts";
import { traceGeometry } from "../shared/raster.ts";
import type { MapMeta, SlotsFile } from "../shared/types.ts";
import type { RegionFeature } from "../shared/region.ts";
import { clamp } from "../shared/params.ts";
import { $, SITE, h } from "./dom.ts";
import type { GitHub } from "./github.ts";
import { optimistic } from "./optimistic.ts";
import { loadMapImage } from "./images.ts";
import { confirmBox, modal } from "./region-dialogs.ts";
import { canOrganise, initPinMaps, loadPinMaps, moveMapDialog, newFolder, newMap, pinMaps, removeMap, renameMap, renderTree } from "./pinmaps.ts";
import { mapById, mapsOfSlot, type PinMap } from "../shared/pinmaps.ts";
import { account, can, canDelete, canEdit, refusal } from "./session.ts";
import { moreMenu } from "./more-menu.ts";
import { Selection, blockedList, cardBox, groupBox, refreshBoxes, selectionBar } from "./bulk.ts";
import { TRASH_DAYS } from "../shared/trash.ts";

export interface PinsDeps {
  gh: () => GitHub;
  maps: () => MapMeta[];
  slots: () => SlotsFile;
  act: (label: string, fn: () => Promise<string>) => Promise<void>;
  /** The saved regions, to show their outlines behind the pins. */
  regions?: () => RegionFeature[];
}

export interface PinEntry {
  id: string;
  path: string;
  /** Blob SHA when loaded, to notice concurrent edits. */
  sha: string;
  feature: PinFeature | null;
  problem?: string;
}

let deps: PinsDeps;
let entries: PinEntry[] = [];
/** Pins with a save still being committed (id → count). */
const inFlight = new Map<string, number>();
const parsed = new Map<string, { feature: PinFeature | null; problem?: string }>();

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const serialize = (f: PinFeature) => stringifyCompact(f) + "\n";
export const pinEntries = (): PinEntry[] => entries;

/* ── Loading ── */

export async function loadPins(): Promise<void> {
  const gh = deps.gh();
  const pinMapsDone = loadPinMaps().catch(() => {});
  const files = (await gh.listTree("content/pins")).filter((f) => f.type === "file" && f.name.endsWith(".json"));
  const loaded: PinEntry[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, files.length) }, async () => {
      while (next < files.length) {
        const f = files[next++];
        const id = f.name.slice(0, -5);
        let hit = parsed.get(f.sha);
        if (!hit) {
          try {
            const text = await gh.readBlob(f.sha);
            try {
              const feature = JSON.parse(text) as PinFeature;
              if (feature?.type !== "Feature" || feature.geometry?.type !== "Point" || !feature.properties || !isPinKind(feature.properties.kind)) throw new Error("not a pin");
              const errs = checkPin(feature);
              hit = { feature, problem: errs[0] };
            } catch {
              hit = { feature: null, problem: "This file isn't a valid pin (broken JSON or wrong shape)." };
            }
            parsed.set(f.sha, hit);
          } catch (e) {
            loaded.push({ id, path: f.path, sha: "", feature: null, problem: (e as Error).message });
            continue;
          }
        }
        loaded.push({ id, path: f.path, sha: f.sha, feature: hit.feature ? structuredClone(hit.feature) : null, problem: hit.problem });
      }
    }),
  );
  const current = new Set(files.map((f) => f.sha));
  for (const k of parsed.keys()) if (!current.has(k)) parsed.delete(k);
  loaded.sort((a, b) => a.id.localeCompare(b.id));
  await pinMapsDone;
  entries = loaded;
  refresh();
}

/* ── State ── */

interface View {
  /** Longitude and latitude at the centre of the map pane. */
  cx: number;
  cy: number;
  /** Pixels per degree of longitude. */
  k: number;
}

let slot = "";
/** The pin being looked at or edited: a saved one (its id), or "new". */
let selected: string | null = null;
let draft: PinFeature | null = null;
let adding = false;
/** The kind and pin map of the last pin, so placing several in a row doesn't mean choosing them each time. */
let lastKind: PinKind = "city";
let lastPinMap = "";
let showLabels = false;
let showRegions = false;
/** Kinds the list is narrowed to (none ticked: all). */
const kindFilter = new Set<PinKind>();
let search = "";
let view: View = { cx: 0, cy: 0, k: 1 };
let img: HTMLImageElement | null = null;
let imgFor = "";
let built = false;

const el: Record<string, HTMLElement> = {};

const slotMap = (): MapMeta | undefined => deps.maps().find((m) => m.id === deps.slots().slots[slot]?.map);
const slotPins = () => entries.filter((e) => e.feature && e.feature.properties.slot === slot);
const entryOf = (id: string | null) => entries.find((e) => e.id === id);
const aspect = () => slotMap()?.aspect ?? 2;
const ky = () => 2 / aspect();

const paneSize = () => {
  const m = el.pane;
  return { w: Math.max(1, m.clientWidth), h: Math.max(1, m.clientHeight) };
};
const sx = (lon: number) => (lon - view.cx) * view.k + paneSize().w / 2;
const sy = (lat: number) => (view.cy - lat) * view.k * ky() + paneSize().h / 2;
const kMin = () => {
  const { w, h } = paneSize();
  return Math.min(w / 360, h / (180 * ky()));
};

/** Keeps the map covering the pane (or centred when it's smaller than the pane). */
function limit(): void {
  const { w, h } = paneSize();
  view.k = clamp(view.k, kMin(), kMin() * 80);
  const halfW = w / 2 / view.k;
  const halfH = h / 2 / (view.k * ky());
  view.cx = halfW >= 180 ? 0 : clamp(view.cx, -180 + halfW, 180 - halfW);
  view.cy = halfH >= 90 ? 0 : clamp(view.cy, -90 + halfH, 90 - halfH);
}

function fit(): void {
  view = { cx: 0, cy: 0, k: kMin() };
  limit();
}

/* ── Rendering ── */

function draw(): void {
  const canvas = el.canvas as HTMLCanvasElement;
  const { w, h } = paneSize();
  const d = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(h * d)) {
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
  }
  const g = canvas.getContext("2d")!;
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, h);
  if (img) {
    g.imageSmoothingQuality = "high";
    g.drawImage(img, sx(-180), sy(90), 360 * view.k, 180 * view.k * ky());
  }
  if (showRegions) {
    g.save();
    g.lineWidth = 1;
    g.strokeStyle = "rgba(255,255,255,.7)";
    g.setLineDash([4, 3]);
    g.beginPath();
    for (const r of deps.regions?.() ?? []) if (r.properties.slot === slot) traceGeometry(g, r.geometry, sx, sy, [0]);
    g.stroke();
    g.restore();
  }
  (el.layer as HTMLElement).dataset.labels = String(showLabels);
  // Markers: the draft, or every saved pin of this slot.
  const items: { id: string; f: PinFeature }[] = slotPins().map((e) => ({ id: e.id, f: draft && selected === e.id ? draft : e.feature! }));
  if (draft && selected === "new") items.push({ id: "new", f: draft });
  const layer = el.layer;
  const existing = new Map([...layer.children].map((c) => [(c as HTMLElement).dataset.id!, c as HTMLButtonElement]));
  for (const { id, f } of items) {
    let b = existing.get(id);
    if (!b) {
      b = makeMarker(id);
      layer.append(b);
    }
    existing.delete(id);
    const p = f.properties;
    const bg = pinColor(p);
    b.style.background = bg;
    b.style.color = inkFor(bg);
    if (b.dataset.kind !== p.kind) {
      b.dataset.kind = p.kind;
      const label = document.createElement("span");
      label.className = "pn-label";
      b.replaceChildren(pinIcon(p.kind, 14), label);
    }
    const lab = b.querySelector<HTMLElement>(".pn-label");
    if (lab) lab.textContent = p.name;
    b.title = `${p.name || "(unnamed)"}, ${kindInfo(p.kind).label}`;
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", String(selected === id));
    b.dataset.ticked = String(sel.on && sel.has(id));
    const [lon, lat] = f.geometry.coordinates;
    b.style.transform = `translate(${Math.round(sx(lon) - 13)}px,${Math.round(sy(lat) - 13)}px)`;
  }
  for (const b of existing.values()) b.remove();
}

let raf = 0;
const redraw = () => {
  if (!raf)
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw();
    });
};

function makeMarker(id: string): HTMLButtonElement {
  const b = h("button", { type: "button", className: "pn-marker", dataset: { id } });
  let drag: { x: number; y: number; moved: boolean; start: [number, number] } | null = null;
  b.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (sel.on) {
      sel.toggle(id);
      refreshSelection();
      return;
    }
    if (id !== selected && dirty()) {
      void leave().then((ok) => ok && select(id));
      return;
    }
    b.setPointerCapture(e.pointerId);
    select(id);
    const f = draft;
    drag = { x: e.clientX, y: e.clientY, moved: false, start: f ? [...f.geometry.coordinates] : [0, 0] };
  });
  b.addEventListener("pointermove", (e) => {
    if (!drag || !draft || !editable()) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    drag.moved = true;
    const r = el.pane.getBoundingClientRect();
    draft.geometry.coordinates = toLonLat(e.clientX - r.left, e.clientY - r.top);
    renderForm(false);
    redraw();
  });
  b.addEventListener("pointerup", () => (drag = null));
  b.addEventListener("pointercancel", () => (drag = null));
  b.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") e.preventDefault();
    // Arrow keys nudge the selected pin by 1 screen pixel (10 with Shift).
    const dx = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const dy = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if ((dx || dy) && draft && selected === id && editable()) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const [lon, lat] = draft.geometry.coordinates;
      draft.geometry.coordinates = [Math.round(clamp(lon + (dx * step) / view.k, -180, 180) * 10000) / 10000, Math.round(clamp(lat - (dy * step) / (view.k * ky()), -90, 90) * 10000) / 10000];
      renderForm(false);
      redraw();
    }
  });
  return b;
}

function toLonLat(x: number, y: number): [number, number] {
  const { w, h } = paneSize();
  const lon = clamp(view.cx + (x - w / 2) / view.k, -180, 180);
  const lat = clamp(view.cy - (y - h / 2) / (view.k * ky()), -90, 90);
  return [Math.round(lon * 10000) / 10000, Math.round(lat * 10000) / 10000];
}

/* ── Selection and the form ── */

/** Whether the person may change the pin being edited. */
function editable(): boolean {
  if (!draft) return false;
  return selected === "new" ? can("regions") : canEdit(entryOf(selected)?.feature);
}

function select(id: string | null): void {
  selected = id;
  const e = entryOf(id);
  draft = id === "new" ? draft : e?.feature ? structuredClone(e.feature) : null;
  if (id !== "new") adding = false;
  renderForm(true);
  renderList();
  syncControls();
  redraw();
}

function blankPin(at: [number, number]): PinFeature {
  const map = slotMap();
  return {
    $schema: "../../schema/pin.schema.json",
    type: "Feature",
    id: "",
    properties: { slot, map: map?.id ?? "", name: "", kind: lastKind, ...(lastPinMap && mapsOfSlot(pinMaps(), slot).some((m) => m.id === lastPinMap) ? { pinMap: lastPinMap } : {}) },
    geometry: { type: "Point", coordinates: at },
  };
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);

/** An id from the name that no saved pin uses yet. */
function freshId(name: string): string {
  const base = slugify(name) || "pin";
  const taken = new Set(entries.map((e) => e.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const dirty = (): boolean => {
  if (!draft) return false;
  if (selected === "new") return true;
  const was = entryOf(selected)?.feature;
  return !was || JSON.stringify(was.properties) !== JSON.stringify(draft.properties) || JSON.stringify(was.geometry) !== JSON.stringify(draft.geometry);
};

/** Asks before an unsaved pin form is thrown away; true when it is fine to carry on. */
async function leave(): Promise<boolean> {
  if (!dirty()) return true;
  return confirmBox("Unsaved pin", "The pin you are editing has changes that aren't saved. Discard them?", "Discard pin", "Keep editing", true);
}

function renderForm(rebuild: boolean): void {
  const box = el.form;
  if (!draft) {
    const hint = h("p", { className: "muted small", textContent: !can("regions") ? "Pick a pin on the map or in the list. You need the “Create regions” permission to place pins." : adding ? "Click the map to drop a pin. Press Done or Esc to stop." : "Press “Place pins” and click the map, or pick a pin on the map or in the list." });
    const empty = h("div", { className: "empty" }, hint);
    box.replaceChildren(empty);
    return;
  }
  const f = draft;
  const p = f.properties;
  const ok = editable();
  if (!rebuild && box.querySelector("form")) {
    // Only the position changed (a drag): update the readout.
    const pos = box.querySelector<HTMLElement>(".pn-pos");
    if (pos) pos.textContent = posText(f);
    updateButtons();
    return;
  }
  const name = h("input", { type: "text", maxLength: PIN_NAME_MAX, value: p.name, required: true, disabled: !ok, autocomplete: "off", ariaLabel: "Name" });
  const kind = h(
    "div",
    { className: "pn-kinds", role: "radiogroup", ariaLabel: "Kind (decides the icon)" },
    ...PIN_KINDS.map((k) => {
      const b = h("button", { type: "button", className: "ghost tiny pn-kind", role: "radio", ariaChecked: String(k.id === p.kind), tabIndex: k.id === p.kind ? 0 : -1, disabled: !ok, dataset: { kind: k.id }, title: k.label, ariaLabel: k.label }, pinIcon(k.id, 16));
      b.style.setProperty("--kind", k.color);
      b.addEventListener("click", () => {
        p.kind = k.id;
        for (const c of kind.querySelectorAll<HTMLElement>("[data-kind]")) {
          c.setAttribute("aria-checked", String(c.dataset.kind === k.id));
          c.tabIndex = c.dataset.kind === k.id ? 0 : -1;
        }
        sync();
      });
      b.addEventListener("keydown", (e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const all = [...kind.querySelectorAll<HTMLButtonElement>("[data-kind]")];
        const next = all[(all.indexOf(b) + step + all.length) % all.length];
        next.click();
        next.focus();
      });
      return b;
    }),
  );
  const maps = mapsOfSlot(pinMaps(), slot);
  const pinMap = h("select", { disabled: !ok, ariaLabel: "Pin map" }, h("option", { value: "", textContent: "None" }), ...maps.map((m) => h("option", { value: m.id, textContent: m.name, selected: m.id === p.pinMap })));
  const useColor = h("input", { type: "checkbox", checked: !!p.color, disabled: !ok, ariaLabel: "Use a custom colour" });
  const color = h("input", { type: "color", value: p.color && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : kindInfo(p.kind).color, disabled: !ok || !p.color, ariaLabel: "Colour" });
  const desc = h("textarea", { rows: 3, maxLength: PIN_DESCRIPTION_MAX, value: p.description ?? "", disabled: !ok, ariaLabel: "Description" });
  const link = h("input", { type: "url", value: p.link ?? "", disabled: !ok, placeholder: "https://… (the place's note)", autocomplete: "off", ariaLabel: "Link" });
  const err = h("p", { className: "error small", role: "alert" });
  const save = h("button", { type: "submit", textContent: selected === "new" ? "Place pin" : "Save pin" });
  const del = h("button", { type: "button", className: "ghost danger", textContent: "Delete pin" });
  const cancel = h("button", { type: "button", className: "ghost", textContent: selected === "new" ? "Cancel" : "Close" });
  const sync = () => {
    p.name = name.value;
    if (pinMap.value) p.pinMap = pinMap.value;
    else delete p.pinMap;
    color.disabled = !ok || !useColor.checked;
    if (useColor.checked) p.color = color.value;
    else delete p.color;
    const d = desc.value.trim();
    if (d) p.description = d;
    else delete p.description;
    const l = link.value.trim();
    if (l) p.link = l;
    else delete p.link;
    err.textContent = "";
    updateButtons();
    redraw();
  };
  for (const c of [name, pinMap, useColor, color, desc, link]) c.addEventListener("input", sync);
  const form = h(
    "form",
    { className: "pn-form" },
    h("label", {}, "Name", name),
    h("div", { className: "pn-field" }, h("span", { className: "small", textContent: "Kind (decides the icon)" }), kind),
    h("label", {}, "Pin map (optional: an embed can show one pin map)", pinMap),
    h("div", { className: "pn-color" }, h("label", { className: "check" }, useColor, "Custom colour"), color),
    h("label", {}, `Description (optional, up to ${PIN_DESCRIPTION_MAX} characters)`, desc),
    h("label", {}, "Link to the note (optional)", link),
    h("p", { className: "muted small" }, "Position: ", h("span", { className: "pn-pos", textContent: posText(f) }), ok ? " · drag the marker, or use the arrow keys (Shift: bigger steps)" : ""),
    p.createdBy ? h("p", { className: "muted small", textContent: `Placed by ${p.createdBy.login}${p.updated ? ` · saved ${new Date(p.updated).toLocaleString()}` : ""}` }) : null,
    err,
    h("div", { className: "row" }, ok ? save : null, selected !== "new" && canDelete(entryOf(selected)?.feature) ? del : null, cancel),
    ok ? null : h("p", { className: "muted small", textContent: "You can look at this pin, but only the person who placed it (or someone allowed to edit others' regions) can change it." }),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void save_(err);
  });
  del.addEventListener("click", () => void remove_());
  cancel.addEventListener("click", () => {
    void leave().then((go) => {
      if (!go) return;
      draft = null;
      selected = null;
      renderForm(true);
      renderList();
      syncControls();
      redraw();
    });
  });
  box.replaceChildren(form);
  updateButtons();
}

const posText = (f: PinFeature) => {
  const [lon, lat] = f.geometry.coordinates;
  return `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(2)}° ${lon < 0 ? "W" : "E"}`;
};

function updateButtons(): void {
  const b = el.form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (b) b.disabled = !dirty();
}

/* ── Saving ── */

async function save_(err: HTMLElement): Promise<void> {
  if (!draft) return;
  const me = account();
  const now = stamp();
  const isNew = selected === "new";
  const gh = deps.gh();
  const f: PinFeature = structuredClone(draft);
  f.properties.name = f.properties.name.trim();
  if (!f.properties.name) return void (err.textContent = "Give the pin a name.");
  if (f.properties.link && !safeLink(f.properties.link)) return void (err.textContent = "The link must be a full https:// address.");
  if (f.properties.link) f.properties.link = safeLink(f.properties.link)!;
  const before = isNew ? null : entryOf(selected)?.feature ?? null;
  f.id = isNew ? freshId(f.properties.name) : selected!;
  if (!PIN_ID.test(f.id)) return void (err.textContent = "Couldn't make an id from that name.");
  f.properties.map = slotMap()?.id ?? f.properties.map;
  f.properties.updatedBy = me;
  f.properties.updated = now;
  if (isNew) {
    f.properties.createdBy = me;
    f.properties.created = now;
  }
  const problems = checkPin(f);
  if (problems.length) return void (err.textContent = problems[0].replace(/^pin "[^"]*": /, ""));
  const path = pinPath(f.id);
  const text = serialize(f);
  const why = refusal({ path, before: before ? serialize(before) : null, after: text });
  if (why) return void (err.textContent = why);
  const label = isNew ? `Place pin "${f.properties.name}"` : `Update pin "${f.properties.name}"`;
  const baseSha = entryOf(f.id)?.sha;
  // A second save of the same pin while the first is still being committed would find the file changed (by us).
  const followsOwnSave = (inFlight.get(f.id) ?? 0) > 0;
  inFlight.set(f.id, (inFlight.get(f.id) ?? 0) + 1);
  const wasSelected = selected;
  const wasDraft = draft;
  const wasAdding = adding;
  err.textContent = "";
  await optimistic<PinEntry[]>({
    label,
    apply: () => {
      const before = entries;
      const entry: PinEntry = { id: f.id, path, sha: baseSha ?? "", feature: f };
      entries = isNew ? [...entries, entry].sort((a, b) => a.id.localeCompare(b.id)) : entries.map((x) => (x.id === f.id ? entry : x));
      selected = f.id;
      draft = structuredClone(f);
      lastKind = f.properties.kind;
      lastPinMap = f.properties.pinMap ?? "";
      return before;
    },
    undo: (before) => {
      entries = before;
      // Put the form back as it was so the work isn't lost.
      selected = isNew ? "new" : wasSelected;
      draft = isNew ? wasDraft : structuredClone(f);
      adding = wasAdding;
    },
    render: () => {
      renderForm(true);
      renderList();
      syncControls();
      redraw();
    },
    commit: async () => {
      try {
        if (!isNew && baseSha && !followsOwnSave) {
          if ((await gh.fileSha(path)) !== baseSha) throw new Error(`"${f.properties.name}" was changed by someone else since you opened it. Close it and open it again.`);
        }
        if (isNew && (await gh.fileSha(path)) !== null) throw new Error(`A pin with the id "${f.id}" already exists. Try a different name.`);
        return await gh.commit(`${label} on slot "${slot}"`, async () => [{ path, content: text }]);
      } finally {
        const n = (inFlight.get(f.id) ?? 1) - 1;
        if (n > 0) inFlight.set(f.id, n);
        else inFlight.delete(f.id);
      }
    },
  });
}

/**
 * Saves a pin on behalf of another screen (the region editor's Pin tool): the same checks, the same one commit per
 * pin, and it shows at once. Returns why it can't be saved, or null when it is on its way.
 */
export async function savePinFrom(draft: PinFeature, isNew: boolean): Promise<string | null> {
  const me = account();
  const now = stamp();
  const gh = deps.gh();
  const f: PinFeature = structuredClone(draft);
  f.properties.name = f.properties.name.trim();
  if (!f.properties.name) return "Give the pin a name.";
  if (f.properties.link && !safeLink(f.properties.link)) return "The link must be a full https:// address.";
  if (f.properties.link) f.properties.link = safeLink(f.properties.link)!;
  const before = isNew ? null : entryOf(f.id)?.feature ?? null;
  if (isNew) f.id = freshId(f.properties.name);
  if (!PIN_ID.test(f.id)) return "Couldn't make an id from that name.";
  f.properties.updatedBy = me;
  f.properties.updated = now;
  if (isNew) {
    f.properties.createdBy = me;
    f.properties.created = now;
  }
  const problems = checkPin(f);
  if (problems.length) return problems[0].replace(/^pin "[^"]*": /, "");
  const path = pinPath(f.id);
  const text = serialize(f);
  const why = refusal({ path, before: before ? serialize(before) : null, after: text });
  if (why) return why;
  const label = isNew ? `Place pin "${f.properties.name}"` : `Update pin "${f.properties.name}"`;
  const baseSha = entryOf(f.id)?.sha;
  const followsOwnSave = (inFlight.get(f.id) ?? 0) > 0;
  inFlight.set(f.id, (inFlight.get(f.id) ?? 0) + 1);
  await optimistic<PinEntry[]>({
    label,
    apply: () => {
      const was = entries;
      const entry: PinEntry = { id: f.id, path, sha: baseSha ?? "", feature: f };
      entries = isNew ? [...entries, entry].sort((a, b) => a.id.localeCompare(b.id)) : entries.map((x) => (x.id === f.id ? entry : x));
      return was;
    },
    undo: (was) => void (entries = was),
    render: () => {
      if (!built) return;
      renderList();
      redraw();
    },
    commit: async () => {
      try {
        if (!isNew && baseSha && !followsOwnSave) {
          if ((await gh.fileSha(path)) !== baseSha) throw new Error(`"${f.properties.name}" was changed by someone else since you opened it. Close it and open it again.`);
        }
        if (isNew && (await gh.fileSha(path)) !== null) throw new Error(`A pin with the id "${f.id}" already exists. Try a different name.`);
        return await gh.commit(`${label} on slot "${f.properties.slot}"`, async () => [{ path, content: text }]);
      } finally {
        const n = (inFlight.get(f.id) ?? 1) - 1;
        if (n > 0) inFlight.set(f.id, n);
        else inFlight.delete(f.id);
      }
    },
  });
  return null;
}

/** Deletes a saved pin on behalf of another screen (the caller has already asked the person). Returns why not, or null. */
export async function deletePinById(id: string): Promise<string | null> {
  const e = entryOf(id);
  if (!e?.feature) return "That pin is already gone.";
  const why = refusal({ path: e.path, before: serialize(e.feature), after: null });
  if (why) return why;
  const name = e.feature.properties.name;
  await optimistic<PinEntry[]>({
    label: `Delete pin "${name}"`,
    apply: () => {
      const was = entries;
      entries = entries.filter((x) => x !== e);
      return was;
    },
    undo: (was) => void (entries = was),
    render: () => {
      if (!built) return;
      renderList();
      redraw();
    },
    commit: () => deps.gh().commit(`Delete pin "${name}"`, async () => [{ path: e.path, content: "", delete: true }]),
  });
  return null;
}

async function remove_(): Promise<void> {
  const e = entryOf(selected);
  if (!e?.feature) return;
  const why = refusal({ path: e.path, before: serialize(e.feature), after: null });
  if (why) return void ($(".pn-form .error").textContent = why);
  if (!(await confirmBox("Delete pin", `Delete “${e.feature.properties.name}”? Embeds that show pins stop showing it once the site has rebuilt.`, "Delete pin", "Cancel", true))) return;
  const name = e.feature.properties.name;
  const wasDraft = draft;
  await optimistic<PinEntry[]>({
    label: `Delete pin "${name}"`,
    apply: () => {
      const before = entries;
      entries = entries.filter((x) => x !== e);
      selected = null;
      draft = null;
      adding = false;
      return before;
    },
    undo: (before) => {
      entries = before;
      selected = e.id;
      draft = wasDraft;
    },
    render: () => {
      renderForm(true);
      renderList();
      syncControls();
      redraw();
    },
    commit: () => deps.gh().commit(`Delete pin "${name}"`, async () => [{ path: e.path, content: "", delete: true }]),
  });
}

/* ── The list and the controls above it ── */

/** One pin in the list. */
function pinRow(e: PinEntry): HTMLElement {
  const p = e.feature!.properties;
  const sw = h("span", { className: "pn-sw" }, pinIcon(p.kind, 12));
  sw.style.background = pinColor(p);
  sw.style.color = inkFor(pinColor(p));
  const row = h(
    "button",
    { type: "button", className: `pn-row${selected === e.id ? " on" : ""}`, onclick: () => void leave().then((ok) => ok && (select(e.id), centreOn(e.feature!))) },
    sw,
    h("span", { className: "pn-name", textContent: p.name }),
    h("span", { className: "muted small", textContent: kindInfo(p.kind).label }),
  );
  if (!sel.on) return row;
  // Selecting: the row ticks instead of opening the pin.
  row.onclick = () => (sel.toggle(e.id), refreshSelection());
  const item = h("div", { className: `pn-item${sel.has(e.id) ? " selected" : ""}`, dataset: { pin: e.id } }, cardBox(sel, e.id, domOrder, refreshSelection, "pn-sel"), row);
  return item;
}

const pinMatches = (e: PinEntry, q: string): boolean => (!kindFilter.size || kindFilter.has(e.feature!.properties.kind)) && (!q || e.feature!.properties.name.toLowerCase().includes(q) || e.id.includes(q) || e.feature!.properties.kind.includes(q));
/** The pins of this slot that are in pin map `m` (null: in none, or in one that no longer exists). */
const pinsIn = (m: PinMap | null): PinEntry[] => slotPins().filter((e) => (m ? e.feature!.properties.pinMap === m.id : !e.feature!.properties.pinMap || !mapById(pinMaps(), e.feature!.properties.pinMap)));

function renderList(): void {
  const q = search.trim().toLowerCase();
  sel.keepOnly(new Set(slotPins().map((e) => e.id)));
  const bad = entries.filter((e) => !e.feature);
  const nMaps = mapsOfSlot(pinMaps(), slot).length;
  el.count.textContent = `${slotPins().length} pin${slotPins().length === 1 ? "" : "s"} and ${nMaps} pin map${nMaps === 1 ? "" : "s"} on this slot`;
  const ok = canOrganise();
  const small = (text: string, action: string, onclick: () => void, why = "", cls = "ghost") => h("button", { type: "button", className: cls, textContent: text, onclick, disabled: !!why, title: why, dataset: { action } });
  const mapBody = (m: PinMap | null): HTMLElement => {
    const all = pinsIn(m);
    const nameHit = !!m && !!q && m.name.toLowerCase().includes(q);
    const rows = all.filter((e) => nameHit || pinMatches(e, q));
    const why = ok ? "" : "You don't have permission to change pin maps.";
    return h(
      "section",
      { className: `pinmap${m ? "" : " loose"}`, dataset: m ? { pinmap: m.id } : { pinmap: "" } },
      h(
        "div",
        { className: "pinmap-head" },
        sel.on && rows.length ? groupBox(sel, rows.map((e) => e.id), `Select all shown pins in ${m ? m.name : "no pin map"}`, refreshSelection) : null,
        h("strong", { textContent: m ? m.name : "Not in a pin map" }),
        h("span", { className: "badge", textContent: String(all.length), title: `${all.length} pin${all.length === 1 ? "" : "s"}` }),
        m
          ? h(
              "div",
              { className: "actions" },
              small("Embed code…", "embed-map", () => embedDialog(m.id)),
              small("Move", "move-map", () => moveMapDialog(m), why, "ghost act-extra"),
              small("Rename", "rename-map", () => renameMap(m), why, "ghost act-extra"),
              small("Delete", "delete-map", () => void removeMap(m, all.length), why, "ghost danger act-extra"),
              moreMenu(`More actions for pin map ${m.name}`, [
                { text: "Move…", action: "menu-move-map", onclick: () => moveMapDialog(m), why },
                { text: "Rename…", action: "menu-rename-map", onclick: () => renameMap(m), why },
                { text: "Delete…", action: "menu-delete-map", onclick: () => void removeMap(m, all.length), why, danger: true },
              ], { wrap: "act-more" }),
            )
          : null,
      ),
      ...rows.map(pinRow),
      rows.length ? null : h("p", { className: "muted small", textContent: m ? (all.length ? "No pin matches." : "No pins yet. Pick this pin map in a pin's form to put it here.") : "Every pin is in a pin map." }),
    );
  };
  const looseEmpty = !pinsIn(null).length;
  const tree = renderTree({
    slot,
    mapBody: (m) => (m === null && looseEmpty ? h("span") : mapBody(m)),
    filtering: !!q,
    hasMatch: (m) => !!q && (m ? m.name.toLowerCase().includes(q) || pinsIn(m).some((e) => pinMatches(e, q)) : pinsIn(null).some((e) => pinMatches(e, q))),
  });
  el.list.replaceChildren(
    ...tree,
    ...(!tree.some((n) => n.textContent) && !slotPins().length && !nMaps ? [h("p", { className: "muted small", textContent: "No pins or pin maps yet. Add a pin map, then place pins and choose it in their form." })] : []),
    ...bad.map((e) => h("p", { className: "error small", textContent: `${e.path}: ${e.problem ?? "can't be used"}` })),
  );
  bar?.update();
}

function centreOn(f: PinFeature): void {
  const [lon, lat] = f.geometry.coordinates;
  view.cx = lon;
  view.cy = lat;
  view.k = Math.max(view.k, kMin() * 4);
  limit();
  redraw();
}

function syncControls(): void {
  const add = el.add as HTMLButtonElement;
  add.disabled = !can("regions") || !slotMap() || sel.on;
  if (sel.on) add.title = "Finish selecting first (press Done)";
  else if (add.dataset.tip) add.title = add.dataset.tip;
  (el.select as HTMLButtonElement).setAttribute("aria-pressed", String(sel.on));
  (el.addMap as HTMLButtonElement).disabled = !canOrganise() || !slot;
  (el.addFolder as HTMLButtonElement).disabled = !canOrganise();
  add.setAttribute("aria-pressed", String(adding));
  (el.placing as HTMLElement).hidden = !adding;
  (el.pane as HTMLElement).dataset.adding = String(adding);
  // The empty form's hint changes with the mode (see renderForm).
  if (!draft) renderForm(false);
  // Size the pane to the map so it has no empty bands (see .pn-pane in admin.css).
  (el.pane as HTMLElement).style.setProperty("--pn-aspect", String(aspect()));
}

/** Embed code for the slot's pins: all of them, or the ticked pin maps. `only` ticks one pin map to begin with. */
function embedDialog(only?: string): void {
  const m = modal(`Embed "${slot}" with pins`, "embed-dlg");
  const maps = mapsOfSlot(pinMaps(), slot);
  const all = h("input", { type: "checkbox", checked: !only, ariaLabel: "All pins" });
  const boxes = maps.map((x) => ({ id: x.id, box: h("input", { type: "checkbox", checked: x.id === only, ariaLabel: x.name }) }));
  const code = h("textarea", { className: "code", readOnly: true, rows: 5, spellcheck: false, ariaLabel: "Embed code" });
  const copied = h("span", { className: "ok small", role: "status" });
  const title = deps.slots().slots[slot]?.title ?? slot;
  const update = () => {
    const url = new URL(`v/${encodeURIComponent(slot)}/`, SITE);
    const chosen = boxes.filter((b) => b.box.checked).map((b) => b.id);
    url.searchParams.set("pins", all.checked || !chosen.length ? "1" : chosen.join(","));
    code.value =
      `<iframe src="${escapeHtml(url.href.replace(/%2C/gi, ","))}" width="100%" height="480" style="border:0;border-radius:8px;background:transparent" ` +
      `loading="lazy" allow="fullscreen" title="${escapeHtml(`${title} map with pins`)}"></iframe>`;
    copied.textContent = "";
  };
  all.addEventListener("change", () => {
    if (all.checked) for (const b of boxes) b.box.checked = false;
    update();
  });
  for (const b of boxes)
    b.box.addEventListener("change", () => {
      all.checked = !boxes.some((x) => x.box.checked);
      update();
    });
  m.body.append(
    h("fieldset", { className: "pn-cats" }, h("legend", { textContent: "Show" }), h("label", { className: "check" }, all, "All pins"), ...maps.map((x, i) => h("label", { className: "check" }, boxes[i].box, x.name)), maps.length ? null : h("p", { className: "muted small", textContent: "Add a pin map and put pins in it to build embeds that show only some of them." })),
    code,
    h("p", { className: "muted small", textContent: "The slot with its pins. To show pin maps on a region, include them in that region (Show pin maps, in the editor) or tick “Show map pins” in its embed code. New and changed pins show up in embeds after the next deploy." }),
  );
  m.foot.append(
    copied,
    h("button", {
      type: "button",
      textContent: "Copy embed code",
      onclick: () =>
        void navigator.clipboard.writeText(code.value).then(
          () => (copied.textContent = "Copied"),
          () => {
            code.select();
            copied.textContent = "Couldn't reach the clipboard; the code is selected, press Ctrl+C.";
          },
        ),
    }),
  );
  update();
}

/* ── The map pane: image, pan, zoom ── */

async function loadImage(): Promise<void> {
  const map = slotMap();
  if (!map) {
    img = null;
    imgFor = "";
    return redraw();
  }
  const want = map.id;
  if (imgFor === want) return;
  imgFor = want;
  img = null;
  try {
    const first = await loadMapImage(map, 4096);
    if (imgFor !== want) return;
    img = first;
    fit();
    redraw();
    // A sharper copy once the person zooms in.
    if (map.sizes["8192"]) void loadMapImage(map, 8192).then((big) => imgFor === want && ((img = big), redraw())).catch(() => {});
  } catch {
    redraw();
  }
}

function wirePane(): void {
  const pane = el.pane;
  const pts = new Map<number, { x: number; y: number }>();
  let down: { x: number; y: number; moved: boolean } | null = null;
  pane.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    pane.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    down = { x: e.clientX, y: e.clientY, moved: false };
  });
  pane.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    if (down && !down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) return;
    if (down) down.moved = true;
    view.cx -= (e.clientX - p.x) / view.k;
    view.cy += (e.clientY - p.y) / (view.k * ky());
    p.x = e.clientX;
    p.y = e.clientY;
    limit();
    redraw();
  });
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (down && !down.moved && adding && e.type === "pointerup") {
      const r = pane.getBoundingClientRect();
      const at = toLonLat(e.clientX - r.left, e.clientY - r.top);
      // Place mode stays on: the next click drops the next pin (after asking about an unsaved one).
      void leave().then((go) => {
        if (!go) return;
        draft = blankPin(at);
        select("new");
        (el.form.querySelector("input[type=text]") as HTMLInputElement | null)?.focus();
      });
    }
    down = null;
  };
  pane.addEventListener("pointerup", up);
  pane.addEventListener("pointercancel", up);
  pane.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = pane.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  pane.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && adding) {
      adding = false;
      syncControls();
    }
  });
  new ResizeObserver(() => {
    if (!built) return;
    limit();
    redraw();
  }).observe(pane);
}

function zoomAt(factor: number, x: number, y: number): void {
  const { w, h } = paneSize();
  const before = toLonLat(x, y);
  view.k = clamp(view.k * factor, kMin(), kMin() * 80);
  // Keep the point under the cursor where it was.
  view.cx = before[0] - (x - w / 2) / view.k;
  view.cy = before[1] + (y - h / 2) / (view.k * ky());
  limit();
  redraw();
}

/* ── Building the tab ── */

function build(): void {
  const root = $("#tab-pins");
  const slotSel = h("select", { ariaLabel: "Slot" });
  const searchBox = h("input", { type: "search", placeholder: "Search pins", autocomplete: "off", ariaLabel: "Search pins" });
  const add = h("button", { type: "button", textContent: "Place pins", title: "Place pins: click the map to drop a pin; stays on until you press Done or Esc", ariaPressed: "false", dataset: { action: "place-pins", tip: "Place pins: click the map to drop a pin; stays on until you press Done or Esc" } });
  const embed = h("button", { type: "button", className: "ghost", textContent: "Embed code…" });
  const addMap = h("button", { type: "button", className: "ghost", textContent: "+ Pin map", dataset: { action: "new-pinmap" } });
  const addFolder = h("button", { type: "button", className: "ghost", textContent: "+ Folder", dataset: { action: "new-pinfolder" } });
  const selectBtn = h("button", { type: "button", className: "ghost", textContent: "Select pins", title: "Tick several pins to move them to another pin map, or delete them together", ariaPressed: "false", dataset: { action: "select-pins" } });
  Object.assign(el, { addMap, addFolder, select: selectBtn });
  const canvas = h("canvas", { className: "pn-canvas" });
  const layer = h("div", { className: "pn-layer" });
  const zoomIn = h("button", { type: "button", className: "ghost", textContent: "+", title: "Zoom in", ariaLabel: "Zoom in" });
  const zoomOut = h("button", { type: "button", className: "ghost", textContent: "−", title: "Zoom out", ariaLabel: "Zoom out" });
  const fitBtn = h("button", { type: "button", className: "ghost", textContent: "Fit", title: "Show the whole map" });
  const labelsBtn = h("button", { type: "button", className: "ghost", textContent: "Labels", title: "Show each pin's name next to it", ariaPressed: "false", dataset: { action: "pin-labels" } });
  const regionsBtn = h("button", { type: "button", className: "ghost", textContent: "Regions", title: "Show the outlines of this slot's regions behind the pins", ariaPressed: "false", dataset: { action: "pin-regions" } });
  const placing = h("p", { className: "pn-placing small", hidden: true, role: "status", ariaLive: "polite" }, h("span", { textContent: "Placing pins: click the map to drop one. " }), h("button", { type: "button", className: "ghost tiny", textContent: "Done", dataset: { action: "place-done" } }));
  const kindBar = h("div", { className: "pn-kindbar", role: "group", ariaLabel: "Show only these kinds" }, ...PIN_KINDS.map((k) => {
    const b = h("button", { type: "button", className: "ghost tiny pn-kind", ariaPressed: "false", dataset: { kind: k.id }, title: `Show only ${k.label.toLowerCase()} pins`, ariaLabel: `Show only ${k.label.toLowerCase()} pins` }, pinIcon(k.id, 16));
    b.style.setProperty("--kind", k.color);
    b.addEventListener("click", () => {
      if (kindFilter.has(k.id)) kindFilter.delete(k.id);
      else kindFilter.add(k.id);
      b.setAttribute("aria-pressed", String(kindFilter.has(k.id)));
      renderList();
    });
    return b;
  }));
  const pane = h("div", { className: "pn-pane", tabIndex: 0, role: "application", ariaLabel: "Map. Drag to move, scroll to zoom." }, canvas, layer, h("div", { className: "pn-zoom" }, labelsBtn, regionsBtn, zoomIn, zoomOut, fitBtn));
  const form = h("div", { className: "pn-formbox" });
  const list = h("div", { className: "pn-list" });
  const count = h("p", { className: "muted small" });
  Object.assign(el, { slotSel, add, canvas, layer, pane, form, list, count, placing });
  root.replaceChildren(
    h(
      "section",
      { className: "card" },
      h("h2", { textContent: "Map pins" }),
      h("p", { className: "muted", textContent: "Mark cities, ruins, battle sites and other places on a slot's map. Group pins into pin maps (“Holy sites”, “Battles”) and sort those into folders, like regions. An embed shows one pin map (?pins=holy-sites), or every pin (?pins=1), and a region can include pin maps so their pins show on its embed. A pin can link to its note in the vault." }),
      h("div", { className: "row pn-tools" }, h("label", {}, "Slot", slotSel), h("label", { className: "grow" }, "Search", searchBox), h("div", { className: "pn-actions" }, add, embed)),
      placing,
      h("div", { className: "pn-body" }, pane, h("div", { className: "pn-side" }, form)),
      h("div", { className: "pn-below" }, count, kindBar, h("div", { className: "pn-listbar" }, addMap, addFolder, selectBtn), list),
    ),
  );
  slotSel.addEventListener("change", () => {
    sel.clear();
    if (slotSel.value !== slot && dirty()) {
      const to = slotSel.value;
      slotSel.value = slot;
      void leave().then((go) => {
        if (!go) return;
        slotSel.value = to;
        slotSel.dispatchEvent(new Event("change"));
      });
      return;
    }
    slot = slotSel.value;
    selected = null;
    draft = null;
    adding = false;
    imgFor = "";
    renderForm(true);
    refresh();
    void loadImage();
  });
  searchBox.addEventListener("input", () => {
    search = searchBox.value;
    renderList();
  });
  add.addEventListener("click", () => {
    if (adding) return stopPlacing();
    void leave().then((go) => {
      if (!go) return;
      adding = true;
      selected = null;
      draft = null;
      renderForm(true);
      renderList();
      pane.focus();
      syncControls();
      redraw();
    });
  });
  const stopPlacing = () => {
    adding = false;
    syncControls();
    redraw();
  };
  placing.querySelector("button")!.addEventListener("click", stopPlacing);
  // Esc anywhere in the tab ends place mode.
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && adding) {
      e.stopPropagation();
      stopPlacing();
    }
  });
  labelsBtn.addEventListener("click", () => {
    showLabels = !showLabels;
    labelsBtn.setAttribute("aria-pressed", String(showLabels));
    redraw();
  });
  regionsBtn.addEventListener("click", () => {
    showRegions = !showRegions;
    regionsBtn.setAttribute("aria-pressed", String(showRegions));
    redraw();
  });
  embed.addEventListener("click", () => embedDialog());
  addMap.addEventListener("click", () => newMap(slot, null));
  selectBtn.addEventListener("click", () => void setSelecting(!sel.on));
  // Clicking a pin row's empty space is handled by the row itself; Esc leaves selection mode.
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sel.on && !document.querySelector("dialog[open]") && !e.defaultPrevented) setSelecting(false);
  });
  addFolder.addEventListener("click", () => newFolder(null));
  zoomIn.addEventListener("click", () => zoomAt(1.6, paneSize().w / 2, paneSize().h / 2));
  zoomOut.addEventListener("click", () => zoomAt(1 / 1.6, paneSize().w / 2, paneSize().h / 2));
  fitBtn.addEventListener("click", () => (fit(), redraw()));
  wirePane();
  built = true;
}

/** Re-reads the slot list into the picker and redraws (after loading or a save). */
function refresh(): void {
  if (!built) return;
  const slotSel = el.slotSel as HTMLSelectElement;
  const names = Object.keys(deps.slots().slots);
  if (!names.includes(slot)) slot = names[0] ?? "";
  slotSel.replaceChildren(...names.map((n) => h("option", { value: n, textContent: deps.slots().slots[n].title ? `${deps.slots().slots[n].title} (${n})` : n, selected: n === slot })));
  renderList();
  syncControls();
  if (!draft) renderForm(true);
  void loadImage();
  redraw();
}

/** Opens the Pins tab on a pin's slot with that pin selected. False when there is no such pin. */
export function openPinById(id: string): boolean {
  const e = entryOf(id);
  if (!e?.feature) return false;
  location.hash = "#pins";
  if (!built) renderPins();
  slot = e.feature.properties.slot;
  refresh();
  select(id);
  return true;
}

/** Called when the Pins tab is opened. */
export function renderPins(): void {
  if (!built) build();
  refresh();
  // The pane has a size only once the tab is visible.
  requestAnimationFrame(() => {
    if (img && view.k === 1) fit();
    limit();
    redraw();
  });
}

/* ── Bulk actions: tick several pins, then move them to another pin map or delete them together ── */

const sel = new Selection();
let bar: ReturnType<typeof selectionBar> | undefined;
const refreshSelection = (): void => {
  if (built) refreshBoxes(el.list, sel);
  bar?.update();
  redraw();
};
/** The ids of the pin rows on screen, top to bottom (for "select all shown" and shift+click ranges). */
const domOrder = (): string[] => [...el.list.querySelectorAll<HTMLElement>(".pn-item[data-pin]")].map((c) => c.dataset.pin ?? "");
const byIds = (ids: string[]): PinEntry[] => ids.map((id) => entryOf(id)).filter((e): e is PinEntry => !!e?.feature);
const perCommit = (): number => 16;
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const nameOf = (part: PinEntry[]) => (part.length === 1 ? `pin "${part[0].feature!.properties.name}"` : `${part.length} pins`);

async function setSelecting(on: boolean): Promise<void> {
  if (on === sel.on) return;
  if (on) {
    if (!(await leave())) return;
    // Place mode and an open pin end when selection starts.
    adding = false;
    draft = null;
    selected = null;
    sel.on = true;
    renderForm(true);
  } else {
    sel.on = false;
    sel.clear();
  }
  renderList();
  syncControls();
  redraw();
}

const bulkWhy = {
  move: (ids: string[]) =>
    !can("regions") ? "You don't have permission to change pins." : blockedList("pin", "change", ids.filter((id) => { const f = entryOf(id)?.feature; return !f || !canEdit(f); })),
  delete: (ids: string[]) => blockedList("pin", "delete", ids.filter((id) => { const f = entryOf(id)?.feature; return !f || !canDelete(f); })),
};

const withPinMap = (f: PinFeature, pinMap: string): PinFeature => {
  const properties = { ...f.properties, updatedBy: account(), updated: stamp() };
  if (pinMap) properties.pinMap = pinMap;
  else delete properties.pinMap;
  return { ...f, properties };
};

function bulkMove(ids: string[]): void {
  const m = modal("Change pin map");
  const maps = mapsOfSlot(pinMaps(), slot);
  const select = h("select", { ariaLabel: "Pin map", dataset: { field: "bulk-pinmap" } }, h("option", { value: "", textContent: "None (not in a pin map)" }), ...maps.map((x) => h("option", { value: x.id, textContent: x.name })));
  const go = h("button", { type: "button", textContent: `Move ${plural(ids.length, "pin")}`, dataset: { action: "confirm-bulk-move" } });
  go.addEventListener("click", () => {
    m.close();
    void movePins(ids, select.value);
  });
  m.body.append(h("p", { className: "muted small", textContent: `Puts ${plural(ids.length, "pin")} in one pin map${ids.length > perCommit() ? ` (several saves, ${perCommit()} at a time)` : ""}. The pins themselves don't change.` }), h("label", {}, "Pin map ", select));
  m.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }), go);
  select.focus();
}

async function movePins(ids: string[], pinMap: string): Promise<void> {
  const all = byIds(ids);
  for (let i = 0; i < all.length; i += perCommit()) {
    const part = all.slice(i, i + perCommit());
    const label = pinMap ? `Move ${nameOf(part)} to pin map ${mapById(pinMaps(), pinMap)?.name ?? pinMap}` : `Take ${nameOf(part)} out of their pin map`;
    await optimistic<PinEntry[]>({
      label,
      check: () => {
        for (const e of part) {
          const why = refusal({ path: e.path, before: serialize(e.feature!), after: serialize(withPinMap(e.feature!, pinMap)) });
          if (why) return `Can't change ${e.id}: ${why}`;
        }
        return null;
      },
      apply: () => {
        const before = entries;
        entries = entries.map((e) => (part.includes(e) ? { ...e, feature: withPinMap(e.feature!, pinMap) } : e));
        return before;
      },
      undo: (before) => void (entries = before),
      render: () => {
        renderList();
        redraw();
      },
      commit: () =>
        deps.gh().commit(label, async () => {
          const out: { path: string; content: string }[] = [];
          for (const e of part) out.push({ path: e.path, content: serialize(withPinMap(JSON.parse((await deps.gh().readFile(e.path)).text) as PinFeature, pinMap)) });
          return out;
        }),
    });
  }
}

function bulkDelete(ids: string[]): void {
  const m = modal(`Delete ${plural(ids.length, "pin")}`, "danger");
  const shown = ids.slice(0, 10);
  const go = h("button", { type: "button", className: "danger", textContent: `Delete ${plural(ids.length, "pin")}`, dataset: { action: "confirm-bulk-delete" } });
  go.addEventListener("click", () => {
    m.close();
    void removeMany(ids);
  });
  const cancel = h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close });
  m.body.append(
    h("p", {}, `This deletes ${plural(ids.length, "pin")}${ids.length > perCommit() ? ` (in several saves, ${perCommit()} at a time)` : " in one save"}:`),
    h("ul", { className: "bulk-list" }, ...shown.map((id) => h("li", {}, h("code", { textContent: id }))), ids.length > shown.length ? h("li", { className: "muted", textContent: `and ${ids.length - shown.length} more` }) : null),
    h(
      "div",
      { className: "rename-note", role: "note" },
      h("span", { className: "rename-note-icon", ariaHidden: "true", textContent: "⚠" }),
      h("div", {}, h("strong", { textContent: "Embeds that show these pins will stop showing them." }), " They disappear once the site has rebuilt."),
    ),
    h("p", { className: "muted small", textContent: `They stay in Recently deleted for ${TRASH_DAYS} days, where you can restore them.` }),
  );
  m.foot.append(cancel, go);
  cancel.focus();
}

async function removeMany(ids: string[]): Promise<void> {
  const all = byIds(ids);
  for (let i = 0; i < all.length; i += perCommit()) {
    const part = all.slice(i, i + perCommit());
    const label = `Delete ${nameOf(part)}`;
    await optimistic<PinEntry[]>({
      label,
      check: () => {
        for (const e of part) {
          const why = refusal({ path: e.path, before: serialize(e.feature!), after: null });
          if (why) return `Can't delete ${e.id}: ${why}`;
        }
        return null;
      },
      apply: () => {
        const before = entries;
        entries = entries.filter((x) => !part.includes(x));
        return before;
      },
      undo: (before) => void (entries = before),
      render: () => {
        renderList();
        redraw();
      },
      commit: () => deps.gh().commit(label, async () => part.map((e) => ({ path: e.path, content: "", delete: true }))),
    });
  }
}

export function initPins(d: PinsDeps): void {
  deps = d;
  initPinMaps({ gh: d.gh, render: () => renderList() });
  bar = selectionBar(
    sel,
    "pin",
    [
      { text: "Change pin map…", action: "bulk-move", why: bulkWhy.move, run: bulkMove },
      { text: "Delete…", action: "bulk-delete", why: bulkWhy.delete, run: bulkDelete, danger: true },
    ],
    domOrder,
    refreshSelection,
    () => void setSelecting(false),
  );
  document.body.append(bar.el);
}
