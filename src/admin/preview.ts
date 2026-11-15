/**
 * The admin page's preview dialog: shows the real viewer (preview/?map=<id>) in a same-origin
 * iframe and adjusts pole padding live with postMessage, then optionally saves to a slot.
 */
import type { PreviewMessage } from "../viewer/contract.ts";
import type { MapMeta, Slot, ViewMode } from "../shared/types.ts";
import { DEFAULT_VIEW } from "../shared/types.ts";
import { EARTH_RADIUS_KM, KM_PER_MI, MAX_RADIUS_KM, MIN_RADIUS_KM, formatLength, validRadius, type DistUnit } from "../shared/measure.ts";

export interface PreviewOptions {
  maps: MapMeta[];
  /** Slot being edited; omit to preview a map without saving. */
  slug?: string;
  slot?: Slot;
  /** Map to show first (defaults to the slot's map). */
  mapId: string;
  /** Called with the fields to write into the slot. */
  onSave?: (patch: { map: string; view: ViewMode; north: number; south: number; pole: string; shift: number; radius: number }) => void;
}

const SITE = new URL("../", location.href);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dialog = $<HTMLDialogElement>("preview");
const frame = $<HTMLIFrameElement>("pv-frame");
const mapSel = $<HTMLSelectElement>("pv-map");
const north = $<HTMLInputElement>("pv-north");
const south = $<HTMLInputElement>("pv-south");
const northV = $<HTMLOutputElement>("pv-north-v");
const southV = $<HTMLOutputElement>("pv-south-v");
const pole = $<HTMLInputElement>("pv-pole");
const grid = $<HTMLInputElement>("pv-grid");
const fit = $<HTMLButtonElement>("pv-fit");
const save = $<HTMLButtonElement>("pv-save");
const hint = $<HTMLParagraphElement>("pv-hint");
const note = $<HTMLParagraphElement>("pv-note");

let current: PreviewOptions | null = null;
let view: ViewMode = "globe";
const viewBtns = [$<HTMLButtonElement>("pv-view-globe"), $<HTMLButtonElement>("pv-view-flat")];

function showView(): void {
  for (const b of viewBtns) {
    const on = b.dataset.view === view;
    b.className = on ? "" : "ghost";
    b.setAttribute("aria-pressed", String(on));
  }
}
const shift = $<HTMLInputElement>("pv-shift");
const shiftN = $<HTMLInputElement>("pv-shift-n");

/** Degrees rounded to 2 decimals and kept within ±180. */
export function roundShift(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(-180, Math.min(180, v)) * 100) / 100;
}

const radius = $<HTMLInputElement>("pv-radius");
const radiusUnit = $<HTMLSelectElement>("pv-radius-unit");
const radiusHint = $<HTMLSpanElement>("pv-radius-hint");
const earth = $<HTMLButtonElement>("pv-earth");

/** The world radius typed in, in km: 0 when blank (no ruler in the embed), NaN when it isn't a usable size. */
export function radiusKm(text: string, unit: DistUnit): number {
  if (text.trim() === "") return 0;
  const v = Number(text) * (unit === "mi" ? KM_PER_MI : 1);
  const km = Math.round(v * 10) / 10;
  return validRadius(km) ? km : NaN;
}

const values = () => {
  const r = radiusKm(radius.value, radiusUnit.value as DistUnit);
  return { north: Number(north.value), south: Number(south.value), pole: pole.value, shift: roundShift(Number(shift.value)), radius: Number.isNaN(r) ? 0 : r };
};

/** Padding (split evenly) that keeps a map wider than 2:1 in proportion on the sphere. */
export function fitPadding(aspect: number): number {
  return aspect > 2 ? Math.round(((1 - 2 / aspect) / 2) * 1000) / 10 : 0;
}

function describeRadius(): void {
  const r = radiusKm(radius.value, radiusUnit.value as DistUnit);
  radiusHint.classList.toggle("error", Number.isNaN(r));
  radiusHint.textContent = Number.isNaN(r)
    ? `Enter a radius between ${MIN_RADIUS_KM.toLocaleString()} and ${MAX_RADIUS_KM.toLocaleString()} km.`
    : r
      ? `Circumference ${formatLength(2 * Math.PI * r, radiusUnit.value as DistUnit)}. Readers get a ruler (distance and area) in every embed of this slot.`
      : "Leave empty for no ruler. Earth's radius is 6,371 km.";
  save.disabled = Number.isNaN(r);
}

function describe(): void {
  describeRadius();
  northV.value = `${north.value}%`;
  southV.value = `${south.value}%`;
  const m = current?.maps.find((x) => x.id === mapSel.value);
  if (!m) return void (hint.textContent = "");
  const band = 100 - Number(north.value) - Number(south.value);
  const ideal = 200 / m.aspect; // band height (in %) that keeps the map undistorted
  const stretch = ideal / band;
  const padded = Number(north.value) + Number(south.value) > 0;
  hint.textContent =
    `${m.width}×${m.height} (${m.aspect.toFixed(2)}:1). ` +
    (Math.abs(stretch - 1) < 0.03
      ? "Shown in correct proportions."
      : stretch < 1
        ? `Stretched ${Math.round((1 / stretch - 1) * 100)}% north–south. More padding fixes it.`
        : `Squashed ${Math.round((1 - 1 / stretch) * 100)}% north–south.${padded ? " Less padding fixes it." : ""}`);
}

function send(): void {
  describe();
  const msg: PreviewMessage = { type: "wge-preview", ...values(), grid: grid.checked };
  frame.contentWindow?.postMessage(msg, SITE.origin);
}

function load(): void {
  const q = new URLSearchParams({
    map: mapSel.value,
    view,
    north: north.value,
    south: south.value,
    pole: pole.value,
    shift: shift.value,
    radius: String(values().radius),
    grid: grid.checked ? "1" : "0",
    rotate: "0",
  });
  frame.src = new URL(`preview/?${q}`, SITE).href;
  describe();
}

north.addEventListener("input", send);
south.addEventListener("input", send);
pole.addEventListener("input", send);
shift.addEventListener("input", () => {
  shiftN.value = String(roundShift(Number(shift.value)));
  send();
});
// Typing: update live while the number is valid, tidy it up (clamp, 2 decimals) when leaving the field.
shiftN.addEventListener("input", () => {
  if (shiftN.value.trim() === "" || !Number.isFinite(Number(shiftN.value))) return;
  shift.value = String(roundShift(Number(shiftN.value)));
  send();
});
shiftN.addEventListener("change", () => {
  const v = roundShift(Number(shiftN.value));
  shiftN.value = String(v);
  shift.value = String(v);
  send();
});
grid.addEventListener("change", send);
radius.addEventListener("input", send);
radiusUnit.addEventListener("change", () => {
  // Keep the same size: convert what's typed into the other unit.
  const km = radiusKm(radius.value, radiusUnit.value === "mi" ? "km" : "mi");
  if (km) radius.value = String(Math.round((radiusUnit.value === "mi" ? km / KM_PER_MI : km) * 100) / 100);
  send();
});
earth.addEventListener("click", () => {
  radius.value = String(radiusUnit.value === "mi" ? Math.round((EARTH_RADIUS_KM / KM_PER_MI) * 100) / 100 : EARTH_RADIUS_KM);
  send();
});
// The globe and the flat map are different viewers, so switching reloads the iframe (with the current settings).
for (const b of viewBtns)
  b.addEventListener("click", () => {
    const v: ViewMode = b.dataset.view === "flat" ? "flat" : "globe";
    if (v === view) return;
    view = v;
    showView();
    load();
  });
mapSel.addEventListener("change", load);
fit.addEventListener("click", () => {
  const m = current?.maps.find((x) => x.id === mapSel.value);
  if (!m) return;
  const p = fitPadding(m.aspect);
  north.value = south.value = String(p);
  send();
});
save.addEventListener("click", () => {
  if (!current?.onSave) return;
  const v = values();
  current.onSave({ map: mapSel.value, view, north: v.north, south: v.south, pole: v.pole, shift: v.shift, radius: v.radius });
  dialog.close();
});

export function openPreview(opts: PreviewOptions): void {
  current = opts;
  const s = opts.slot ?? { map: opts.mapId };
  mapSel.replaceChildren(
    ...opts.maps.map((m) => Object.assign(document.createElement("option"), { value: m.id, textContent: m.name, selected: m.id === opts.mapId })),
  );
  shift.value = shiftN.value = String(roundShift(s.shift ?? DEFAULT_VIEW.shift));
  north.value = String(s.north ?? DEFAULT_VIEW.north);
  south.value = String(s.south ?? DEFAULT_VIEW.south);
  pole.value = s.pole && /^#[0-9a-f]{6}$/i.test(s.pole) ? s.pole : DEFAULT_VIEW.pole;
  radiusUnit.value = "km";
  radius.value = s.radius ? String(s.radius) : "";
  grid.checked = s.grid ?? false;
  view = s.view === "flat" ? "flat" : "globe";
  showView();
  $("pv-title").textContent = opts.slug ? `Preview: ${opts.slug}` : "Preview";
  save.hidden = !opts.slug;
  note.textContent = opts.slug
    ? "Saving commits the map, default view, padding, prime meridian and world size to this slot. Drag and zoom here don't change the embed's starting view."
    : "Maps show up here once they're deployed.";
  load();
  dialog.showModal();
}

$<HTMLButtonElement>("pv-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  frame.src = "about:blank";
  current = null;
});
