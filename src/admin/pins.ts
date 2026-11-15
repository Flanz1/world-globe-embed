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
import { PIN_DESCRIPTION_MAX, PIN_KINDS, PIN_NAME_MAX, PIN_ID, checkPin, isPinKind, kindInfo, pinColor, pinPath, safeLink, type PinFeature } from "../shared/pins.ts";
import type { MapMeta, SlotsFile } from "../shared/types.ts";
import { clamp } from "../shared/params.ts";
import { $, SITE, h } from "./dom.ts";
import type { GitHub } from "./github.ts";
import { loadMapImage } from "./images.ts";
import { confirmBox, modal } from "./region-dialogs.ts";
import { account, can, canDelete, canEdit, refusal } from "./session.ts";

export interface PinsDeps {
  gh: () => GitHub;
  maps: () => MapMeta[];
  slots: () => SlotsFile;
  act: (label: string, fn: () => Promise<string>) => Promise<void>;
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
const parsed = new Map<string, { feature: PinFeature | null; problem?: string }>();

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const serialize = (f: PinFeature) => stringifyCompact(f) + "\n";
export const pinEntries = (): PinEntry[] => entries;

/* ── Loading ── */

export async function loadPins(): Promise<void> {
  const gh = deps.gh();
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
      b.replaceChildren(pinIcon(p.kind, 14));
    }
    b.title = `${p.name || "(unnamed)"}, ${kindInfo(p.kind).label}`;
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", String(selected === id));
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
    properties: { slot, map: map?.id ?? "", name: "", kind: "city" },
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

function renderForm(rebuild: boolean): void {
  const box = el.form;
  if (!draft) {
    box.replaceChildren(h("p", { className: "muted small", textContent: can("regions") ? "Press “Place a pin” and click the map, or pick a pin on the map or in the list." : "Pick a pin on the map or in the list. You need the “Create regions” permission to place pins." }));
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
  const kind = h("select", { disabled: !ok, ariaLabel: "Kind" }, ...PIN_KINDS.map((k) => h("option", { value: k.id, textContent: k.label, selected: k.id === p.kind })));
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
    if (isPinKind(kind.value)) p.kind = kind.value;
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
  for (const c of [name, kind, useColor, color, desc, link]) c.addEventListener("input", sync);
  const form = h(
    "form",
    { className: "pn-form" },
    h("label", {}, "Name", name),
    h("label", {}, "Kind", kind),
    h("div", { className: "pn-color" }, h("label", { className: "check" }, useColor, "Custom colour"), color),
    h("label", {}, `Description (optional, up to ${PIN_DESCRIPTION_MAX} characters)`, desc),
    h("label", {}, "Link to the note (optional)", link),
    h("p", { className: "muted small" }, "Position: ", h("span", { className: "pn-pos", textContent: posText(f) }), ok ? " · drag the marker to move it" : ""),
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
    adding = false;
    draft = null;
    selected = null;
    renderForm(true);
    renderList();
    syncControls();
    redraw();
  });
  box.replaceChildren(form);
  updateButtons();
}

const posText = (f: PinFeature) => `${f.geometry.coordinates[1].toFixed(2)}° lat, ${f.geometry.coordinates[0].toFixed(2)}° lon (in the map's own frame)`;

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
  await deps.act(`${label}…`, async () => {
    const sha = entryOf(f.id)?.sha;
    if (!isNew && sha) {
      const now = await gh.fileSha(path);
      if (now !== sha) throw new Error(`"${f.properties.name}" was changed by someone else since you opened it. Close it and open it again.`);
    }
    if (isNew && (await gh.fileSha(path)) !== null) throw new Error(`A pin with the id "${f.id}" already exists. Try a different name.`);
    const commit = await gh.commit(`${label} on slot "${slot}"`, async () => [{ path, content: text }]);
    selected = f.id;
    adding = false;
    return commit;
  });
  // After the reload, show the saved pin.
  select(entryOf(f.id) ? f.id : null);
}

async function remove_(): Promise<void> {
  const e = entryOf(selected);
  if (!e?.feature) return;
  const why = refusal({ path: e.path, before: serialize(e.feature), after: null });
  if (why) return void ($(".pn-form .error").textContent = why);
  if (!(await confirmBox("Delete pin", `Delete “${e.feature.properties.name}”? Embeds that show pins stop showing it once the site has rebuilt.`, "Delete pin", "Cancel", true))) return;
  await deps.act(`Deleting pin "${e.feature.properties.name}"…`, () => deps.gh().commit(`Delete pin "${e.feature!.properties.name}"`, async () => [{ path: e.path, content: "", delete: true }]));
  select(null);
}

/* ── The list and the controls above it ── */

function renderList(): void {
  const q = search.trim().toLowerCase();
  const rows = slotPins().filter((e) => !q || e.feature!.properties.name.toLowerCase().includes(q) || e.id.includes(q) || e.feature!.properties.kind.includes(q));
  const bad = entries.filter((e) => !e.feature);
  el.count.textContent = `${slotPins().length} pin${slotPins().length === 1 ? "" : "s"} on this slot`;
  el.list.replaceChildren(
    ...rows.map((e) => {
      const p = e.feature!.properties;
      const sw = h("span", { className: "pn-sw" }, pinIcon(p.kind, 12));
      sw.style.background = pinColor(p);
      sw.style.color = inkFor(pinColor(p));
      return h(
        "button",
        { type: "button", className: `pn-row${selected === e.id ? " on" : ""}`, onclick: () => (select(e.id), centreOn(e.feature!)) },
        sw,
        h("span", { className: "pn-name", textContent: p.name }),
        h("span", { className: "muted small", textContent: kindInfo(p.kind).label }),
      );
    }),
    ...(rows.length ? [] : [h("p", { className: "muted small", textContent: slotPins().length ? "No pin matches." : "No pins yet." })]),
    ...bad.map((e) => h("p", { className: "error small", textContent: `${e.path}: ${e.problem ?? "can't be used"}` })),
  );
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
  add.disabled = !can("regions") || !slotMap();
  add.setAttribute("aria-pressed", String(adding));
  add.textContent = adding ? "Click the map… (Esc to cancel)" : "Place a pin";
  (el.pane as HTMLElement).dataset.adding = String(adding);
}

function embedDialog(): void {
  const m = modal(`Embed "${slot}" with pins`, "embed-dlg");
  const kinds = h("select", { ariaLabel: "Which pins" }, h("option", { value: "1", textContent: "All pins" }), ...PIN_KINDS.map((k) => h("option", { value: k.id, textContent: `Only ${k.label.toLowerCase()}` })));
  const code = h("textarea", { className: "code", readOnly: true, rows: 5, spellcheck: false, ariaLabel: "Embed code" });
  const copied = h("span", { className: "ok small", role: "status" });
  const title = deps.slots().slots[slot]?.title ?? slot;
  const update = () => {
    const url = new URL(`v/${encodeURIComponent(slot)}/`, SITE);
    url.searchParams.set("pins", kinds.value);
    code.value =
      `<iframe src="${escapeHtml(url.href)}" width="100%" height="480" style="border:0;border-radius:8px;background:transparent" ` +
      `loading="lazy" allow="fullscreen" title="${escapeHtml(`${title} map with pins`)}"></iframe>`;
    copied.textContent = "";
  };
  kinds.addEventListener("change", update);
  m.body.append(
    h("label", {}, "Show", kinds),
    code,
    h("p", { className: "muted small", textContent: "The whole slot with its pins. To draw pins over a region, tick “Show map pins” in that region's embed code instead. New and changed pins show up in embeds after the next deploy." }),
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
      draft = blankPin(toLonLat(e.clientX - r.left, e.clientY - r.top));
      adding = false;
      select("new");
      (el.form.querySelector("input[type=text]") as HTMLInputElement | null)?.focus();
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
  const add = h("button", { type: "button", textContent: "Place a pin" });
  const embed = h("button", { type: "button", className: "ghost", textContent: "Embed code…" });
  const canvas = h("canvas", { className: "pn-canvas" });
  const layer = h("div", { className: "pn-layer" });
  const zoomIn = h("button", { type: "button", className: "ghost", textContent: "+", title: "Zoom in", ariaLabel: "Zoom in" });
  const zoomOut = h("button", { type: "button", className: "ghost", textContent: "−", title: "Zoom out", ariaLabel: "Zoom out" });
  const fitBtn = h("button", { type: "button", className: "ghost", textContent: "Fit", title: "Show the whole map" });
  const pane = h("div", { className: "pn-pane", tabIndex: 0, role: "application", ariaLabel: "Map. Drag to move, scroll to zoom." }, canvas, layer, h("div", { className: "pn-zoom" }, zoomIn, zoomOut, fitBtn));
  const form = h("div", { className: "pn-formbox" });
  const list = h("div", { className: "pn-list" });
  const count = h("p", { className: "muted small" });
  Object.assign(el, { slotSel, add, canvas, layer, pane, form, list, count });
  root.replaceChildren(
    h(
      "section",
      { className: "card" },
      h("h2", { textContent: "Map pins" }),
      h("p", { className: "muted", textContent: "Mark cities, ruins, battle sites and other places on a slot's map. Embeds can show them on top of the map and the regions (add ?pins=1 to the embed address, or tick “Show map pins” in a region's embed code). A pin can link to its note in the vault." }),
      h("div", { className: "row pn-tools" }, h("label", {}, "Slot", slotSel), h("label", { className: "grow" }, "Search", searchBox), add, embed),
      h("div", { className: "pn-body" }, pane, h("div", { className: "pn-side" }, form, count, list)),
    ),
  );
  slotSel.addEventListener("change", () => {
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
    adding = !adding;
    if (adding) {
      selected = null;
      draft = null;
      renderForm(true);
      renderList();
      pane.focus();
    }
    syncControls();
    redraw();
  });
  embed.addEventListener("click", embedDialog);
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

export function initPins(d: PinsDeps): void {
  deps = d;
}
