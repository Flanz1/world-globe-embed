/**
 * CLI used by process-maps.yml: validates every file in content/incoming/, then
 * converts each to WebP textures + metadata and deletes the original.
 * If any file is invalid nothing is written, and the run fails with a clear message.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { inspect, listIncoming, processImage } from "./lib/process.ts";

function uploader(file: string): string {
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
if (!files.length) {
  console.log("No images in content/incoming/. Nothing to do.");
  process.exit(0);
}

const checks = await Promise.all(files.map(inspect));
const errors = checks.flatMap((c) => c.errors);
const seen = new Map<string, string>();
for (const c of checks) {
  const other = seen.get(c.id);
  if (other) errors.push(`${path.basename(c.file)} and ${other} would both become map "${c.id}". Rename one of them.`);
  seen.set(c.id, path.basename(c.file));
}
if (errors.length) {
  console.error("\nThese uploads can't be processed:\n");
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error("\nDelete or fix the file(s) in content/incoming/ and push again.\n");
  if (process.env.GITHUB_ACTIONS) for (const e of errors) console.log(`::error title=Map upload rejected::${e}`);
  summary(`### Map upload rejected\n\n${errors.map((e) => `- ${e}`).join("\n")}`);
  process.exit(1);
}

summary("### Processed maps\n\n| Map id | Source | Sizes |\n|---|---|---|");
for (const c of checks) {
  const meta = await processImage(c.file, { uploadedBy: uploader(c.file) });
  const sizes = Object.keys(meta.sizes).join(", ");
  console.log(`✓ ${path.basename(c.file)} → map "${meta.id}" (${c.width}×${c.height}; ${sizes}px; uploaded by ${meta.uploadedBy})`);
  summary(`| \`${meta.id}\` | ${path.basename(c.file)} (${c.width}×${c.height}) | ${sizes} |`);
}
