/**
 * Map pins: single places (a city, a ruin, a battle site…) on a slot's map. One file per pin in
 * content/pins/<id>.json, a GeoJSON Point Feature in the map image's own lon/lat frame, like regions.
 * The site build bundles each slot's pins into pins/<slot>.json, which embeds fetch when asked with
 * ?pins=1 (every pin) or ?pins=holy-sites,city (only the pins of those pin maps, or of those kinds).
 */
import type { Account } from "./access.ts";
import { clamp } from "./params.ts";

export const PIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PIN_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const PIN_NAME_MAX = 80;
export const PIN_DESCRIPTION_MAX = 300;
export const PIN_LINK_MAX = 400;
/** Most pins one slot's embed will draw (keeps the bundle and the page light). */
export const MAX_PINS_PER_SLOT = 2000;

export const PIN_KINDS = [
  { id: "city", label: "City", color: "#d9a441" },
  { id: "town", label: "Town or village", color: "#c9a94e" },
  { id: "fortress", label: "Fortress or castle", color: "#8f7f6a" },
  { id: "port", label: "Port", color: "#3f8fbf" },
  { id: "temple", label: "Temple or shrine", color: "#9b6fc9" },
  { id: "ruin", label: "Ruin", color: "#8a8f7a" },
  { id: "battle", label: "Battle", color: "#c2453d" },
  { id: "landmark", label: "Landmark", color: "#3fa56a" },
  { id: "mountain", label: "Mountain or cave", color: "#7a6a5a" },
  { id: "other", label: "Other", color: "#6b7280" },
] as const;
export type PinKind = (typeof PIN_KINDS)[number]["id"];

const KIND_IDS: readonly string[] = PIN_KINDS.map((k) => k.id);
export const isPinKind = (v: unknown): v is PinKind => typeof v === "string" && KIND_IDS.includes(v);
export const kindInfo = (k: PinKind) => PIN_KINDS.find((x) => x.id === k)!;

export const PIN_LEGEND_TITLE = "Pins";
export const LEGEND_TITLE_MAX = 30;
export const LEGEND_LABEL_MAX = 40;
/** A pin map's own words for the embed's pin legend (set per pin map in the region editor, RegionProperties.pinLegends): its title and a label per kind. Anything missing keeps the default. */
export interface PinLegend {
  title?: string;
  kinds?: Partial<Record<PinKind, string>>;
}
/** What a kind is called: the slot's own label for it, or the built-in one. Only the label changes, never the kind (icon, colour, ?pins= filters). */
export const kindLabel = (k: PinKind, legend?: PinLegend | null): string => legend?.kinds?.[k]?.trim() || kindInfo(k).label;
export const legendTitle = (legend?: PinLegend | null): string => legend?.title?.trim() || PIN_LEGEND_TITLE;
/** The colour a pin is drawn in: its own, or its kind's. */
export const pinColor = (p: { kind: PinKind; color?: string }): string => (p.color && PIN_COLOR.test(p.color) ? p.color : kindInfo(p.kind).color);

/** content/pins/<id>.json */
export interface PinFeature {
  $schema?: string;
  type: "Feature";
  id: string;
  properties: {
    slot: string;
    map: string;
    name: string;
    kind: PinKind;
    /** The pin map (content/pinmaps.json) this pin belongs to, if any; an embed can show just one pin map. */
    pinMap?: string;
    color?: string;
    description?: string;
    link?: string;
    createdBy?: Account;
    created?: string;
    updatedBy?: Account;
    updated?: string;
  };
  geometry: { type: "Point"; coordinates: [number, number] };
}

export const pinPath = (id: string) => `content/pins/${id}.json`;

/** What an embed needs of one pin (pins/<slot>.json). */
export interface PinData {
  id: string;
  name: string;
  kind: PinKind;
  /** [lon, lat] in the map image's frame. */
  at: [number, number];
  /** Id of the pin map it belongs to. */
  pinMap?: string;
  color?: string;
  description?: string;
  link?: string;
}

/** The https link of a pin as a clean URL, or null when it isn't a usable one. Never returns anything but https. */
export function safeLink(v: unknown): string | null {
  if (typeof v !== "string" || v.length > PIN_LINK_MAX) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !CONTROL.test(v);

/** Problems with a pin beyond what the JSON schema checks. */
export function checkPin(f: PinFeature, where = `pin "${f.id}"`): string[] {
  const out: string[] = [];
  const p = f.properties;
  if (!text(p.name, PIN_NAME_MAX) || !p.name.trim()) out.push(`${where}: the name must be 1–${PIN_NAME_MAX} characters of plain text`);
  if (p.pinMap !== undefined && !PIN_ID.test(p.pinMap)) out.push(`${where}: the pin map must be an id of lowercase letters, digits and dashes`);
  if (p.description !== undefined && !(typeof p.description === "string" && p.description.length <= PIN_DESCRIPTION_MAX)) out.push(`${where}: the description is too long`);
  if (p.link !== undefined && safeLink(p.link) === null) out.push(`${where}: the link must be a full https:// address`);
  const [lon, lat] = f.geometry.coordinates;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) out.push(`${where}: the position is outside the map`);
  return out;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** A pin as the embed gets it. */
export function pinData(f: PinFeature): PinData {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  return {
    id: f.id,
    name: p.name,
    kind: p.kind,
    at: [round(lon), round(lat)],
    ...(p.pinMap ? { pinMap: p.pinMap } : {}),
    ...(p.color ? { color: p.color } : {}),
    ...(p.description ? { description: p.description } : {}),
    ...(p.link ? { link: p.link } : {}),
  };
}

/** The body of pins/<slot>.json, minified. Stable order (by id) so rebuilds don't change the file for nothing. */
export function pinsJson(pins: readonly PinFeature[], maps: readonly { id: string; name: string }[] = []): string {
  const sorted = [...pins].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length > MAX_PINS_PER_SLOT) throw new Error(`a slot can show at most ${MAX_PINS_PER_SLOT} pins`);
  const used = new Set(sorted.map((p) => p.properties.pinMap));
  return JSON.stringify({ pins: sorted.map(pinData), maps: maps.filter((m) => used.has(m.id)).map((m) => ({ id: m.id, name: m.name })) });
}

/** What an embed reads from pins/<slot>.json: the pins and the names of the pin maps they are in. */
export interface PinsFile {
  pins: PinData[];
  maps: { id: string; name: string }[];
}

/** The legend with only what is usable (known kinds, plain text, within the length limits); undefined when nothing is left. */
export function cleanLegend(v: unknown): PinLegend | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as { title?: unknown; kinds?: unknown };
  const out: PinLegend = {};
  if (text(r.title, LEGEND_TITLE_MAX) && r.title.trim()) out.title = r.title.trim();
  if (r.kinds && typeof r.kinds === "object") {
    const kinds: Partial<Record<PinKind, string>> = {};
    for (const [k, l] of Object.entries(r.kinds)) if (isPinKind(k) && text(l, LEGEND_LABEL_MAX) && l.trim()) kinds[k] = l.trim();
    if (Object.keys(kinds).length) out.kinds = kinds;
  }
  return out.title || out.kinds ? out : undefined;
}

/** Validates fetched pin data; anything that doesn't fit is dropped (never trusted as is). Null if the file isn't a pin file at all. */
export function parsePinsFile(j: unknown): PinsFile | null {
  const list = (j as { pins?: unknown } | null)?.pins;
  if (!Array.isArray(list)) return null;
  const out: PinData[] = [];
  for (const raw of list.slice(0, MAX_PINS_PER_SLOT)) {
    const r = raw as Partial<PinData> | null;
    if (!r || typeof r !== "object") continue;
    const at = r.at;
    if (!PIN_ID.test(String(r.id)) || !isPinKind(r.kind) || !text(r.name, PIN_NAME_MAX) || !r.name.trim()) continue;
    if (!Array.isArray(at) || at.length !== 2 || !at.every((n) => typeof n === "number" && Number.isFinite(n)) || Math.abs(at[0]) > 180 || Math.abs(at[1]) > 90) continue;
    const link = r.link === undefined ? undefined : safeLink(r.link);
    out.push({
      id: r.id as string,
      name: r.name,
      kind: r.kind,
      at: [at[0], at[1]],
      ...(typeof r.pinMap === "string" && PIN_ID.test(r.pinMap) ? { pinMap: r.pinMap } : {}),
      ...(typeof r.color === "string" && PIN_COLOR.test(r.color) ? { color: r.color } : {}),
      ...(typeof r.description === "string" && r.description.length <= PIN_DESCRIPTION_MAX ? { description: r.description } : {}),
      ...(link ? { link } : {}),
    });
  }
  const maps = ((j as { maps?: unknown }).maps instanceof Array ? ((j as { maps: unknown[] }).maps) : [])
    .map((m) => m as { id?: unknown; name?: unknown })
    .filter((m): m is { id: string; name: string } => !!m && typeof m.id === "string" && PIN_ID.test(m.id) && text(m.name, 60) && !!(m.name as string).trim());
  return { pins: out, maps };
}

/** What ?pins= asked for: every pin, or the pins of those pin maps (by id) or of those kinds. */
export type PinSelection = "all" | Set<string>;

/**
 * ?pins= : "1"/"true"/"all" → every pin; a comma list → only the pins in those pin maps (`holy-sites`) or of those
 * kinds (`city`, `battle`); "0", empty or missing → none (null). A name that is no pin map or kind simply matches nothing.
 */
export function parsePinsParam(v: string | null | undefined): PinSelection | null {
  if (v == null) return null;
  const s = v.trim().toLowerCase();
  if (!s || s === "0" || s === "false" || s === "no") return null;
  if (s === "1" || s === "true" || s === "all") return "all";
  const names = s.split(",").map((x) => x.trim()).filter((x) => PIN_ID.test(x));
  return names.length ? new Set(names) : null;
}

export const pinShown = (sel: PinSelection, p: { kind: PinKind; pinMap?: string }): boolean => sel === "all" || sel.has(p.kind) || (!!p.pinMap && sel.has(p.pinMap));

/** Pin markers shrink a little on small embeds so they don't swamp the map. */
export const markerSize = (stageMin: number): number => Math.round(clamp(stageMin / 18, 18, 28));

/** Per pin map id: its own legend words. */
export type PinLegends = Record<string, PinLegend>;
export const PIN_LEGENDS_MAX = 8;

/** The legends with only what is usable (valid pin map ids, clean words); undefined when nothing is left. */
export function cleanLegends(v: unknown): PinLegends | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: PinLegends = {};
  for (const [id, l] of Object.entries(v).slice(0, PIN_LEGENDS_MAX)) {
    const c = PIN_ID.test(id) ? cleanLegend(l) : undefined;
    if (c) out[id] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The words one embed's legend uses, when several pin maps are shown: the title of the first pin map (in `order`) that has
 * one, and for each kind the label from the first pin map that has pins of that kind and gives it a label.
 */
export function resolveLegend(pins: readonly { kind: PinKind; pinMap?: string }[], legends: PinLegends | undefined, order: readonly string[]): PinLegend | undefined {
  if (!legends) return undefined;
  const shown = new Set(pins.map((p) => p.pinMap).filter((x): x is string => !!x));
  const ids = [...order, ...Object.keys(legends)].filter((id, i, all) => all.indexOf(id) === i && shown.has(id) && legends[id]);
  const out: PinLegend = {};
  for (const id of ids) if (!out.title && legends[id].title) out.title = legends[id].title;
  const kinds: Partial<Record<PinKind, string>> = {};
  for (const k of KIND_IDS as PinKind[])
    for (const id of ids) {
      const l = legends[id].kinds?.[k];
      if (l && pins.some((p) => p.kind === k && p.pinMap === id)) {
        kinds[k] = l;
        break;
      }
    }
  if (Object.keys(kinds).length) out.kinds = kinds;
  return out.title || out.kinds ? out : undefined;
}
