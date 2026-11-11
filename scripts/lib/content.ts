/** Loads and validates content/slots.json, content/maps/*.json and content/regions/*.json. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { MapMeta, SlotsFile } from "../../src/shared/types.ts";
import { checkGeometry } from "../../src/shared/geo.ts";
import { checkLegend, type RegionFeature } from "../../src/shared/region.ts";
import { ROOT, contentPaths, type ContentPaths } from "./paths.ts";

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

function compile(file: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  return ajv.compile(readJson(path.join(ROOT, "schema", file)) as object);
}
const validateSlots = compile("slots.schema.json");
const validateMap = compile("map.schema.json");
const validateRegion = compile("region.schema.json");

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
    const lg = checkLegend(region.properties, region.geometry, rel);
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

  return { content: errors.length || !slots ? null : { slots, maps, regions }, errors, warnings };
}
