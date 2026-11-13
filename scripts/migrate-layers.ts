/**
 * One-off: puts the parts of saved regions into layer order (see src/shared/layers.ts), so regions
 * drawn before parts were layers look as they did: where parts overlap, the smaller one stays on top.
 * Drops the legacy partContested field (a zone keeps its colour). Rewrites content/regions/*.json in
 * place and prints what changed. Safe to run again: a region already in order is left alone.
 *
 *   npx tsx scripts/migrate-layers.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringifyCompact } from "../src/shared/json.ts";
import { legacyLayerOrder, reorderFeature } from "../src/shared/layers.ts";
import { polygonsOf } from "../src/shared/geo.ts";
import type { RegionFeature } from "../src/shared/region.ts";

const dir = path.resolve(process.argv[2] ?? "content/regions");
for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
  const file = path.join(dir, name);
  const f = JSON.parse(readFileSync(file, "utf8")) as RegionFeature;
  const order = legacyLayerOrder(f.geometry);
  const legacy = f.properties.partContested !== undefined;
  if (!order && !legacy) continue;
  const next = reorderFeature(f, order ?? polygonsOf(f.geometry).map((_, i) => i));
  writeFileSync(file, stringifyCompact(next) + "\n");
  const moved = order ? order.flatMap((old, i) => (old !== i ? [`part ${old + 1} → ${i + 1}`] : [])) : [];
  console.log(`${name}: ${[moved.length ? moved.join(", ") : "", legacy ? "partContested dropped" : ""].filter(Boolean).join("; ")}`);
}
