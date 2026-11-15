/** Loads and validates content/slots.json, content/maps/*.json and content/regions/*.json. */
import { tileUrl } from "../../src/shared/tiles.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { MapMeta, SlotsFile } from "../../src/shared/types.ts";
import { checkGeometry } from "../../src/shared/geo.ts";
import { checkLegend, checkParts, type RegionFeature } from "../../src/shared/region.ts";
import { MAX_PINS_PER_SLOT, checkPin, type PinFeature } from "../../src/shared/pins.ts";
import { checkAccess } from "../../src/shared/access.ts";
import { checkCategories, type CategoriesFile } from "../../src/shared/categories.ts";
import { checkPinMaps, type PinMapsFile } from "../../src/shared/pinmaps.ts";
import { resolveLinked } from "../../src/shared/combine.ts";
import { ROOT, contentPaths, type ContentPaths } from "./paths.ts";

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

function compile(file: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  return ajv.compile(readJson(path.join(ROOT, "schema", file)) as object);
}
const validateSlots = compile("slots.schema.json");
const validateMap = compile("map.schema.json");
const validateRegion = compile("region.schema.json");
const validateAccess = compile("access.schema.json");
const validateCategories = compile("categories.schema.json");
const validatePin = compile("pin.schema.json");
const validatePinMaps = compile("pinmaps.schema.json");

function describe(file: string, errors: ErrorObject[] | null | undefined): string[] {
  // if/then/else failures are always accompanied by the specific error inside the branch.
  return (errors ?? []).filter((e) => e.keyword !== "if").map((e) => {
    const at = e.instancePath ? e.instancePath.replace(/^\//, "").replace(/\//g, ".") : "(top level)";
    let msg = e.message ?? "is invalid";
    if (e.keyword === "additionalProperties") msg = `has an unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    if (e.keyword === "propertyNames") msg = `slot names must be lowercase letters, digits and dashes`;
    if (e.keyword === "enum") msg += `: ${JSON.stringify((e.params as { allowedValues: unknown }).allowedValues)}`;
    if (e.keyword === "minItems" && /^geometry\.coordinates(\.\d+){1,2}$/.test(at))
      msg = `has fewer than ${(e.params as { limit: number }).limit} positions; a ring needs at least 4 (3 corners plus the first one repeated at the end)`;
    if (e.keyword === "pattern" && at.endsWith(".color")) msg = "must be a colour like #c0392b or #c33";
    return `${file}: ${at} ${msg}`;
  });
}

/** Small edit distance, for "did you mean" hints. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export interface Content {
  slots: SlotsFile;
  maps: Map<string, MapMeta>;
  /** Region id → region. Optional so older callers (and tests) that build Content by hand still work. */
  regions?: Map<string, RegionFeature>;
  /** Pin id → pin (content/pins/). Optional like regions. */
  pins?: Map<string, PinFeature>;
  /** Pin maps and their folders (content/pinmaps.json). Optional. */
  pinMaps?: PinMapsFile;
}

export interface ValidationResult {
  content: Content | null;
  errors: string[];
  /** Problems that don't fail the build (e.g. a region drawn on a different map than its slot shows now). */
  warnings: string[];
}

const hintFor = (want: string, known: string[]): string => {
  const near = known.filter((k) => distance(k, want) <= 2);
  return near.length ? ` Did you mean "${near[0]}"?` : "";
};

export function loadContent(paths: ContentPaths = contentPaths()): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maps = new Map<string, MapMeta>();
  const regions = new Map<string, RegionFeature>();
  const pins = new Map<string, PinFeature>();

  const mapFiles = existsSync(paths.mapsDir) ? readdirSync(paths.mapsDir).filter((f) => f.endsWith(".json")) : [];
  for (const f of mapFiles) {
    const rel = `content/maps/${f}`;
    let data: unknown;
    try {
      data = readJson(path.join(paths.mapsDir, f));
    } catch (e) {
      errors.push(`${rel}: is not valid JSON (${(e as Error).message})`);
      continue;
    }
    if (!validateMap(data)) {
      errors.push(...describe(rel, validateMap.errors));
      continue;
    }
    const meta = data as MapMeta;
    const stem = f.slice(0, -5);
    if (meta.id !== stem) errors.push(`${rel}: "id" is "${meta.id}" but the file is named "${stem}.json"`);
    for (const [w, p] of Object.entries(meta.sizes)) {
      if (!existsSync(path.join(paths.publicDir, p)))
        errors.push(`${rel}: the ${w}px texture "public/${p}" is missing; re-upload the map so it gets processed again`);
    }
    for (const [w, l] of Object.entries(meta.tiles ?? {})) {
      const missing: string[] = [];
      for (let r = 0; r < l.rows; r++) for (let c = 0; c < l.cols; c++) if (!existsSync(path.join(paths.publicDir, tileUrl(l, c, r)))) missing.push(`${c}-${r}`);
      if (missing.length) errors.push(`${rel}: ${missing.length} of the ${w}px tiles are missing (e.g. ${missing[0]}); re-upload the map so it gets processed again`);
    }
    maps.set(meta.id, meta);
  }

  let slots: SlotsFile | null = null;
  if (!existsSync(paths.slotsFile)) {
    errors.push("content/slots.json: file is missing");
  } else {
    let data: unknown;
    try {
      data = readJson(paths.slotsFile);
    } catch (e) {
      errors.push(`content/slots.json: is not valid JSON (${(e as Error).message}). Check for a missing comma or quote.`);
    }
    if (data !== undefined) {
      if (!validateSlots(data)) errors.push(...describe("content/slots.json", validateSlots.errors));
      else slots = data as SlotsFile;
    }
  }

  if (slots) {
    const known = [...maps.keys()].sort();
    for (const [slug, slot] of Object.entries(slots.slots)) {
      if (maps.has(slot.map)) continue;
      const hint = hintFor(slot.map, known);
      const list = known.length ? ` Known maps: ${known.join(", ")}.` : " There are no processed maps yet.";
      errors.push(`content/slots.json: slot "${slug}" points at map "${slot.map}", which doesn't exist.${hint}${list}`);
    }
    if (!Object.keys(slots.slots).length) errors.push("content/slots.json: there are no slots");
  }

  const regionFiles = existsSync(paths.regionsDir) ? readdirSync(paths.regionsDir).filter((f) => f.endsWith(".json")).sort() : [];
  for (const f of regionFiles) {
    const rel = `content/regions/${f}`;
    let data: unknown;
    try {
      data = readJson(path.join(paths.regionsDir, f));
    } catch (e) {
      errors.push(`${rel}: is not valid JSON (${(e as Error).message})`);
      continue;
    }
    if (!validateRegion(data)) {
      errors.push(...describe(rel, validateRegion.errors));
      continue;
    }
    const region = data as RegionFeature;
    const stem = f.slice(0, -5);
    let ok = true;
    if (region.id !== stem) {
      errors.push(`${rel}: "id" is "${region.id}" but the file is named "${stem}.json". The id is permanent (embeds use it), so rename the file, not the id`);
      ok = false;
    }
    const geo = checkGeometry(region.geometry, `${rel}: geometry`);
    if (geo.length) {
      errors.push(...geo);
      ok = false;
    }
    const lg = [...checkLegend(region.properties, region.geometry, rel), ...checkParts(region.properties, region.geometry, rel)];
    if (lg.length) {
      errors.push(...lg);
      ok = false;
    }
    const { slot: slotName, map } = region.properties;
    if (slots) {
      const slot = slots.slots[slotName];
      if (!slot) {
        const known = Object.keys(slots.slots).sort();
        errors.push(`${rel}: slot "${slotName}" doesn't exist in content/slots.json.${hintFor(slotName, known)} Known slots: ${known.join(", ")}.`);
        ok = false;
      } else if (slot.map !== map) {
        warnings.push(
          `${rel}: region "${region.id}" was drawn on map "${map}", but slot "${slotName}" now shows map "${slot.map}". Check that it still lines up, then re-save it in the admin page.`,
        );
      }
    }
    if (!maps.has(map)) warnings.push(`${rel}: the map it was drawn on ("${map}") no longer exists.`);
    if (ok) regions.set(region.id, region);
  }

  // Linked combined regions are rebuilt from the regions they link, so every page and embed shows them as those regions are now.
  for (const [id, region] of regions) {
    if (!region.properties.linked) continue;
    const r = resolveLinked(region, (x) => regions.get(x));
    const rel = `content/regions/${id}.json`;
    if (r.missing.length) warnings.push(`${rel}: linked region${r.missing.length > 1 ? "s" : ""} ${r.missing.join(", ")} ${r.missing.length > 1 ? "don't" : "doesn't"} exist (or can't be linked); the rest are combined.`);
    if (r.errors.length) warnings.push(`${rel}: can't combine its linked regions (${r.errors[0]}); the saved snapshot is shown instead.`);
    if (r.feature) regions.set(id, r.feature);
  }

  // Underlays are looked up by id when the embed loads; one that's gone just isn't shown.
  for (const [id, region] of regions) {
    for (const e of region.properties.under ?? []) {
      const other = regions.get(e.id);
      if (e.id === id || !other || other.properties.slot !== region.properties.slot)
        warnings.push(`content/regions/${id}.json: the region shown under it ("${e.id}") doesn't exist on slot "${region.properties.slot}", so it isn't shown.`);
    }
  }

  // Map pins (optional): a bad pin is a build error, like a bad region, so a typo never silently drops a place.
  const pinFiles = existsSync(paths.pinsDir) ? readdirSync(paths.pinsDir).filter((f) => f.endsWith(".json")).sort() : [];
  const perSlot = new Map<string, number>();
  for (const f of pinFiles) {
    const rel = `content/pins/${f}`;
    let data: unknown;
    try {
      data = readJson(path.join(paths.pinsDir, f));
    } catch (e) {
      errors.push(`${rel}: is not valid JSON (${(e as Error).message})`);
      continue;
    }
    if (!validatePin(data)) {
      errors.push(...describe(rel, validatePin.errors));
      continue;
    }
    const pin = data as PinFeature;
    const stem = f.slice(0, -5);
    let ok = true;
    if (pin.id !== stem) {
      errors.push(`${rel}: "id" is "${pin.id}" but the file is named "${stem}.json". The id is permanent, so rename the file, not the id`);
      ok = false;
    }
    const bad = checkPin(pin, rel);
    if (bad.length) {
      errors.push(...bad);
      ok = false;
    }
    if (slots && !slots.slots[pin.properties.slot]) {
      const known = Object.keys(slots.slots).sort();
      errors.push(`${rel}: slot "${pin.properties.slot}" doesn't exist in content/slots.json.${hintFor(pin.properties.slot, known)} Known slots: ${known.join(", ")}.`);
      ok = false;
    }
    if (slots && ok && slots.slots[pin.properties.slot]?.map !== pin.properties.map)
      warnings.push(`${rel}: pin "${pin.id}" was placed on map "${pin.properties.map}", but slot "${pin.properties.slot}" now shows map "${slots.slots[pin.properties.slot]?.map}". Check that it still lines up.`);
    if (ok) {
      pins.set(pin.id, pin);
      perSlot.set(pin.properties.slot, (perSlot.get(pin.properties.slot) ?? 0) + 1);
    }
  }
  for (const [slot, n] of perSlot) if (n > MAX_PINS_PER_SLOT) errors.push(`content/pins/: slot "${slot}" has ${n} pins; at most ${MAX_PINS_PER_SLOT} are allowed.`);

  // Pin maps (optional): named sets of pins in folders. A pin or region naming one that's gone is only a warning (deleting a pin map leaves such ids behind).
  let pinMaps: PinMapsFile | undefined;
  const pinMapsFile = path.join(paths.content, "pinmaps.json");
  if (existsSync(pinMapsFile)) {
    try {
      const data = readJson(pinMapsFile);
      if (!validatePinMaps(data)) errors.push(...describe("content/pinmaps.json", validatePinMaps.errors));
      else {
        const bad = checkPinMaps(data);
        errors.push(...bad.map((e) => `content/pinmaps.json: ${e}`));
        if (!bad.length) pinMaps = data as PinMapsFile;
        for (const m of (data as PinMapsFile).maps) if (slots && !slots.slots[m.slot]) errors.push(`content/pinmaps.json: the pin map "${m.id}" is on slot "${m.slot}", which doesn't exist in content/slots.json.`);
      }
    } catch (e) {
      errors.push(`content/pinmaps.json: is not valid JSON (${(e as Error).message})`);
    }
  }
  const mapsById = new Map((pinMaps?.maps ?? []).map((m) => [m.id, m]));
  for (const pin of pins.values()) {
    const id = pin.properties.pinMap;
    if (id === undefined) continue;
    const m = mapsById.get(id);
    if (!m) warnings.push(`content/pins/${pin.id}.json: the pin map "${id}" doesn't exist, so the pin isn't in one.`);
    else if (m.slot !== pin.properties.slot) warnings.push(`content/pins/${pin.id}.json: the pin is on slot "${pin.properties.slot}" but its pin map "${id}" is on slot "${m.slot}".`);
  }
  for (const [id, region] of regions)
    for (const pm of region.properties.pinMaps ?? [])
      if (mapsById.get(pm)?.slot !== region.properties.slot) warnings.push(`content/regions/${id}.json: the pin map "${pm}" doesn't exist on slot "${region.properties.slot}", so its pins aren't shown.`);

  // Who may use the admin page (optional: without it only the repository owner can sign in).
  const accessFile = path.join(paths.content, "access.json");
  if (existsSync(accessFile)) {
    try {
      const data = readJson(accessFile);
      if (!validateAccess(data)) errors.push(...describe("content/access.json", validateAccess.errors));
      else errors.push(...checkAccess(data).map((e) => `content/access.json: ${e}`));
    } catch (e) {
      errors.push(`content/access.json: is not valid JSON (${(e as Error).message})`);
    }
  }

  // Region categories (optional). A region id that no longer exists is only a warning: deleting a region leaves its id behind until the next category change tidies it up.
  const categoriesFile = path.join(paths.content, "categories.json");
  if (existsSync(categoriesFile)) {
    try {
      const data = readJson(categoriesFile);
      if (!validateCategories(data)) errors.push(...describe("content/categories.json", validateCategories.errors));
      else {
        errors.push(...checkCategories(data).map((e) => `content/categories.json: ${e}`));
        for (const k of (data as CategoriesFile).categories)
          for (const r of k.regions)
            if (!regionFiles.includes(`${r}.json`)) warnings.push(`content/categories.json: category "${k.name}" lists the region "${r}", which doesn't exist (it was probably deleted).`);
      }
    } catch (e) {
      errors.push(`content/categories.json: is not valid JSON (${(e as Error).message})`);
    }
  }

  return { content: errors.length || !slots ? null : { slots, maps, regions, pins, pinMaps }, errors, warnings };
}
