/**
 * The admin page's preview dialog: shows the real viewer (preview/?map=<id>) in a same-origin
 * iframe and adjusts pole padding live with postMessage, then optionally saves to a slot.
 */
import type { PreviewMessage } from "../viewer/contract.ts";
import type { MapMeta, Slot } from "../shared/types.ts";
import { DEFAULT_VIEW } from "../shared/types.ts";

export interface PreviewOptions {
  maps: MapMeta[];
  /** Slot being edited; omit to preview a map without saving. */
  slug?: string;
  slot?: Slot;
  /** Map to show first (defaults to the slot's map). */
  mapId: string;
  /** Called with the fields to write into the slot. */
  onSave?: (patch: { map: string; north: number; south: number; pole: string }) => void;
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

const values = () => ({ north: Number(north.value), south: Number(south.value), pole: pole.value });

/** Padding (split evenly) that keeps a map wider than 2:1 in proportion on the sphere. */
export function fitPadding(aspect: number): number {
  return aspect > 2 ? Math.round(((1 - 2 / aspect) / 2) * 1000) / 10 : 0;
}

function describe(): void {
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
    north: north.value,
    south: south.value,
    pole: pole.value,
    grid: grid.checked ? "1" : "0",
    rotate: "0",
  });
  frame.src = new URL(`preview/?${q}`, SITE).href;
  describe();
}

north.addEventListener("input", send);
south.addEventListener("input", send);
pole.addEventListener("input", send);
grid.addEventListener("change", send);
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
  current.onSave({ map: mapSel.value, north: v.north, south: v.south, pole: v.pole });
  dialog.close();
});

export function openPreview(opts: PreviewOptions): void {
  current = opts;
  const s = opts.slot ?? { map: opts.mapId };
  mapSel.replaceChildren(
    ...opts.maps.map((m) => Object.assign(document.createElement("option"), { value: m.id, textContent: m.name, selected: m.id === opts.mapId })),
  );
  north.value = String(s.north ?? DEFAULT_VIEW.north);
  south.value = String(s.south ?? DEFAULT_VIEW.south);
  pole.value = s.pole && /^#[0-9a-f]{6}$/i.test(s.pole) ? s.pole : DEFAULT_VIEW.pole;
  grid.checked = s.grid ?? false;
  $("pv-title").textContent = opts.slug ? `Preview: ${opts.slug}` : "Preview";
  save.hidden = !opts.slug;
  note.textContent = opts.slug
    ? "Saving commits the map and padding to this slot. Drag and zoom here don't change the embed's starting view."
    : "Maps show up here once they're deployed.";
  load();
  dialog.showModal();
}

$<HTMLButtonElement>("pv-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  frame.src = "about:blank";
  current = null;
});
