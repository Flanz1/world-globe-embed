/**
 * Adds a map straight from a local image, for originals too big to upload to GitHub (over 100 MB,
 * or wider than the admin page can take). Does on this machine what process-maps.yml does:
 * every size, the tile levels and the metadata. Only those small outputs get committed; the
 * original stays where it is.
 *
 *   npm run import-map -- path/to/world_map.png [map-id]
 *
 * Then commit and push content/maps/ and public/maps/ (the script prints the commands).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { processImage } from "./lib/process.ts";

const [file, id] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.error("Usage: npm run import-map -- <image file> [map-id]");
  process.exit(1);
}
let who = process.env.USER || process.env.USERNAME || "unknown";
try {
  who = execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim() || who;
} catch {
  /* no git config */
}
const t0 = Date.now();
console.log(`Processing ${path.basename(file)}… (a 30000+ px image takes a few minutes and several GB of memory)`);
try {
  const meta = await processImage(path.resolve(file), { uploadedBy: who, removeSource: false, ...(id ? { id } : {}) });
  const tiles = Object.values(meta.tiles ?? {}).map((l) => `${l.w} (${l.cols * l.rows} tiles)`);
  console.log(`✓ map "${meta.id}" (${meta.width}×${meta.height}): ${Object.keys(meta.sizes).join(", ")}${tiles.length ? `; tiles ${tiles.join(", ")}` : ""} in ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`\nNow commit and push it (the original isn't copied into the repo):\n`);
  console.log(`  git add content/maps/${meta.id}.json public/maps/${meta.id}`);
  console.log(`  git commit -m "Add map ${meta.id}"`);
  console.log(`  git push`);
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}
