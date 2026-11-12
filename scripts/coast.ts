/**
 * Builds (or rebuilds) the coast file of maps that are already processed, from their textures:
 *
 *   npm run coast                 every map
 *   npm run coast -- my-map    one map
 *   npm run coast -- my-map --mask out/mask.png   also write the land mask (white = land) for checking
 *
 * Writes public/maps/<id>/<hash>-coast.bin and adds "coast" to content/maps/<id>.json.
 * New uploads get one from process-maps automatically.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { MapMeta } from "../src/shared/types.ts";
import { buildCoast, coastFile, describeStats, loadMapRaster } from "./lib/coast-build.ts";
import { contentPaths } from "./lib/paths.ts";

const args = process.argv.slice(2);
const maskAt = args.indexOf("--mask");
const maskFile = maskAt >= 0 ? args[maskAt + 1] : undefined;
const noInland = args.includes("--no-inland-seas");
const ids = args.filter((a, i) => !a.startsWith("--") && (maskAt < 0 || i !== maskAt + 1));
const paths = contentPaths();
const all = readdirSync(paths.mapsDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const todo = ids.length ? ids : all;
for (const id of todo) {
  const metaFile = path.join(paths.mapsDir, `${id}.json`);
  if (!existsSync(metaFile)) {
    console.error(`✗ no map "${id}" (content/maps/${id}.json)`);
    process.exitCode = 1;
    continue;
  }
  const meta = JSON.parse(readFileSync(metaFile, "utf8")) as MapMeta;
  const t0 = Date.now();
  const raster = await loadMapRaster(meta, paths.publicDir);
  const { bytes, stats, land } = buildCoast(raster, { inlandSeas: !noInland });
  const rel = coastFile(meta.id, meta.hash);
  writeFileSync(path.join(paths.publicDir, rel), bytes);
  const { $schema, lqip, ...rest } = meta;
  const out = { $schema, ...rest, coast: rel, lqip };
  writeFileSync(metaFile, JSON.stringify(out, null, 2) + "\n");
  console.log(`✓ ${id} (${raster.width}×${raster.height}, ${Math.round((Date.now() - t0) / 1000)} s): ${describeStats(stats)}; ${(bytes.length / 1e6).toFixed(2)} MB`);
  if (maskFile) {
    const px = new Uint8Array(land.length);
    for (let i = 0; i < land.length; i++) px[i] = land[i] ? 255 : 0;
    await sharp(px, { raw: { width: raster.width, height: raster.height, channels: 1 }, limitInputPixels: false }).png({ compressionLevel: 3 }).toFile(maskFile);
    console.log(`  mask → ${maskFile}`);
  }
}
