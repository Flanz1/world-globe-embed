/** Loads and validates content/slots.json and content/maps/*.json. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { MapMeta, SlotsFile } from "../../src/shared/types.ts";
import { ROOT, contentPaths, type ContentPaths } from "./paths.ts";

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

function compile(file: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  return ajv.compile(readJson(path.join(ROOT, "schema", file)) as object);
}
const validateSlots = compile("slots.schema.json");
const validateMap = compile("map.schema.json");

function describe(file: string, errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const at = e.instancePath ? e.instancePath.replace(/^\//, "").replace(/\//g, ".") : "(top level)";
    let msg = e.message ?? "is invalid";
    if (e.keyword === "additionalProperties") msg = `has an unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    if (e.keyword === "propertyNames") msg = `slot names must be lowercase letters, digits and dashes`;
    if (e.keyword === "enum") msg += `: ${JSON.stringify((e.params as { allowedValues: unknown }).allowedValues)}`;
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
}

export interface ValidationResult {
  content: Content | null;
  errors: string[];
}

export function loadContent(paths: ContentPaths = contentPaths()): ValidationResult {
  const errors: string[] = [];
  const maps = new Map<string, MapMeta>();

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
      const near = known.filter((k) => distance(k, slot.map) <= 2);
      const hint = near.length ? ` Did you mean "${near[0]}"?` : "";
      const list = known.length ? ` Known maps: ${known.join(", ")}.` : " There are no processed maps yet.";
      errors.push(`content/slots.json: slot "${slug}" points at map "${slot.map}", which doesn't exist.${hint}${list}`);
    }
    if (!Object.keys(slots.slots).length) errors.push("content/slots.json: there are no slots");
  }

  return { content: errors.length || !slots ? null : { slots, maps }, errors };
}
