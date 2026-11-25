/**
 * One-off: rewrites saved regions that still use the older flat `under` + `underTitle` and `pinMaps` into
 * layerGroups and pinGroups (see src/shared/groups.ts). The embed looks the same: one underlay becomes a group
 * named after its old heading, several become one group each, every pin map one pin group. Rewrites
 * content/regions/*.json in place and prints what changed. Safe to run again.
 *
 *   npx tsx scripts/migrate-groups.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringifyCompact } from "../src/shared/json.ts";
import { migrateGroups } from "../src/shared/groups.ts";
import type { RegionFeature } from "../src/shared/region.ts";

const dir = path.resolve(process.argv[2] ?? "content/regions");
const files = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
const feats = new Map(files.map((n) => [n.replace(/\.json$/, ""), JSON.parse(readFileSync(path.join(dir, n), "utf8")) as RegionFeature]));
const pinFile = path.join(path.dirname(dir), "pinmaps.json");
const pinNames = new Map<string, string>(existsSync(pinFile) ? (JSON.parse(readFileSync(pinFile, "utf8")).maps ?? []).map((m: { id: string; name: string }) => [m.id, m.name]) : []);
for (const [id, f] of feats) {
  const p = f.properties;
  if (!p.under && p.underTitle === undefined && !p.pinMaps) continue;
  const next = migrateGroups(p, (r) => feats.get(r)?.properties.name?.trim() || r, (m) => pinNames.get(m) || m);
  writeFileSync(path.join(dir, `${id}.json`), stringifyCompact({ ...f, properties: next }) + "\n");
  console.log(`${id}.json: ${next.layerGroups ? `${next.layerGroups.length} layer group(s) ` : ""}${next.pinGroups ? `${next.pinGroups.length} pin group(s)` : ""}`.trim());
}
