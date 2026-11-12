/**
 * One-off migration: gives every region without a creator (properties.createdBy) the GitHub account that
 * first committed its file, read from the commit's GitHub noreply address (<id>+<login>@users.noreply.github.com).
 * Regions whose first author can't be told that way go to the repository owner. Also fills in `created`.
 *
 *   npm run region-owners            rewrites content/regions/*.json in place
 *   npm run region-owners -- --dry   only prints what it would do
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Account } from "../src/shared/access.ts";
import type { RegionFeature } from "../src/shared/region.ts";
import { stringifyCompact } from "../src/shared/json.ts";
import { ROOT, contentPaths } from "./lib/paths.ts";

const OWNER: Account = { id: 45669787, login: "Flanz1" };
const NOREPLY = /^(\d+)\+([A-Za-z0-9-]{1,39})@users\.noreply\.github\.com$/i;
const dry = process.argv.includes("--dry");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

if (git("rev-parse", "--is-shallow-repository") === "true") console.warn("! This is a shallow clone: the first commit of a file may be missing. Run git fetch --unshallow first for exact results.");

const dir = contentPaths().regionsDir;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const file = path.join(dir, f);
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const region = JSON.parse(readFileSync(file, "utf8")) as RegionFeature;
  if (region.properties.createdBy) {
    console.log(`  ${rel}: already has a creator (${region.properties.createdBy.login})`);
    continue;
  }
  const first = git("log", "--diff-filter=A", "--follow", "--format=%ae|%aI", "--", rel).split("\n").filter(Boolean).at(-1) ?? "";
  const [email, date] = first.split("|");
  const m = NOREPLY.exec(email ?? "");
  const who: Account = m ? { id: Number(m[1]), login: m[2] } : OWNER;
  region.properties.createdBy = who;
  if (!region.properties.created && date) region.properties.created = new Date(date).toISOString().replace(/\.\d+Z$/, "Z");
  console.log(`  ${rel}: created by ${who.login}${m ? "" : " (first author unknown, so the owner)"}`);
  if (!dry) writeFileSync(file, stringifyCompact(region) + "\n");
}
