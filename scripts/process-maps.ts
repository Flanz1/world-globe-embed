/**
 * CLI used by process-maps.yml: validates every file in content/incoming/, then
 * converts each to WebP textures + metadata and deletes the original.
 * If any file is invalid nothing is written, and the run fails with a clear message.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { inspect, joinParts, listIncoming, processImage } from "./lib/process.ts";

// Big uploads arrive in parts: join them first. Who uploaded a joined file = who committed its manifest.
const { joined, errors: partErrors, rejected: rejectedParts } = joinParts();

function uploader(file: string): string {
  file = joined.get(file) ?? file;
  try {
    const name = execFileSync("git", ["log", "-1", "--format=%an", "--", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (name) return name;
  } catch {
    /* not a git checkout */
  }
  return process.env.GITHUB_ACTOR || process.env.USER || "unknown";
}

const summary = (md: string) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");

const files = listIncoming();
if (!files.length && !partErrors.length) {
  console.log("No images in content/incoming/. Nothing to do.");
  process.exit(0);
}

const inspected = await Promise.all(files.map(inspect));
const errors = [...partErrors, ...inspected.flatMap((c) => c.errors)];
const rejected = new Set<string>(rejectedParts);
const seen = new Map<string, string>();
const checks = inspected.filter((c) => {
  if (c.errors.length) {
    rejected.add(c.file);
    return false;
  }
  const other = seen.get(c.id);
  if (other) {
    errors.push(`${path.basename(c.file)} and ${other} would both become map "${c.id}". Rename one of them.`);
    rejected.add(c.file);
    return false;
  }
  seen.set(c.id, path.basename(c.file));
  return true;
});
if (errors.length) {
  // A rejected upload is removed from content/incoming/ (and the removal is committed), so one bad file can't hold up every deploy after it.
  // The people who uploaded it see why in the run's summary; the good uploads of the same push are still processed.
  console.error("\nThese uploads can't be processed, so they are removed (upload them again once fixed):\n");
  for (const e of errors) console.error(`  ✗ ${e}`);
  if (process.env.GITHUB_ACTIONS) for (const e of errors) console.log(`::error title=Map upload rejected::${e}`);
  summary(`### Map upload rejected\n\n${errors.map((e) => `- ${e}`).join("\n")}\n\nThe rejected file(s) were removed from content/incoming/.`);
  for (const f of rejected) rmSync(f, { force: true });
}

summary("### Processed maps\n\n| Map id | Source | Sizes |\n|---|---|---|");
for (const c of checks) {
  const meta = await processImage(c.file, { uploadedBy: uploader(c.file) });
  const sizes = Object.keys(meta.sizes).join(", ");
  console.log(`✓ ${path.basename(c.file)} → map "${meta.id}" (${c.width}×${c.height}; ${sizes}px; uploaded by ${meta.uploadedBy})`);
  summary(`| \`${meta.id}\` | ${path.basename(c.file)} (${c.width}×${c.height}) | ${sizes} |`);
}
