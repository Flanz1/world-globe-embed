/**
 * Pre-merge checks for a feature branch: run it before saying a PR is ready, and again after a rebase.
 *
 *   npm run preflight                 against origin/main
 *   npm run preflight -- --base main  against another base
 *   npm run preflight -- --fix        also regenerate files that are out of date (then commit them)
 *
 * Checks, cheapest first:
 *   1. how far the branch is behind the base, and whether it merges into it without conflicts
 *      (git merge-tree, nothing is changed);
 *   2. worker/src/generated/validators.js matches a fresh `npm run worker:validators`;
 *   3. the e2e suite registry: every browser check has its header line, and which suites
 *      this branch's changes need (run them with `npm run e2e -- --changed`).
 * Exits non-zero if anything needs fixing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "origin/main";
const fix = args.includes("--fix");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let failed = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  failed++;
  console.log(`  FIX   ${m}`);
};

console.log(`Preflight against ${base}`);

// 1. Up to date / conflicts.
if (base.startsWith("origin/")) {
  try {
    git("fetch", "-q", "origin", base.slice("origin/".length));
  } catch {
    console.log(`  note  couldn't fetch ${base}; using the local copy`);
  }
}
const behind = Number(git("rev-list", "--count", `HEAD..${base}`));
if (behind === 0) ok(`up to date with ${base}`);
else {
  let conflicts = [];
  try {
    git("merge-tree", "--write-tree", "--name-only", "--no-messages", base, "HEAD");
  } catch (e) {
    // Exit 1 = conflicts; stdout is the tree id, then the conflicted paths.
    conflicts = String(e.stdout ?? "").split("\n").slice(1).filter(Boolean);
    if (!conflicts.length) throw e;
  }
  if (conflicts.length) bad(`${behind} commit(s) behind ${base}, and merging it conflicts in: ${conflicts.join(", ")}. Rebase or merge ${base} and resolve them.`);
  else bad(`${behind} commit(s) behind ${base} (merges cleanly). Update the branch, then run preflight again: the checks below only see this branch.`);
}

// 2. Generated validators.
const { generateValidators, VALIDATORS_FILE } = await import("./build-worker-validators.ts");
const want = generateValidators();
let have = "";
try {
  have = readFileSync(VALIDATORS_FILE, "utf8");
} catch {
  /* missing */
}
if (have === want) ok("worker/src/generated/validators.js is up to date");
else if (fix) {
  writeFileSync(VALIDATORS_FILE, want);
  ok("worker/src/generated/validators.js regenerated: commit it");
} else bad("worker/src/generated/validators.js is out of date: run npm run worker:validators (or preflight -- --fix) and commit it");

// 3. e2e registry and the suites this branch needs.
const { ALL, readSuites, select } = await import("./e2e/select.mjs");
const dir = path.join(ROOT, "scripts/e2e");
const missing = [];
for (const f of execFileSync("git", ["ls-files", "scripts/e2e/*.mjs"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)) {
  const name = path.basename(f);
  if (name === "fixture.mjs") continue;
  const src = readFileSync(path.join(ROOT, f), "utf8");
  if (/makeFixture\(/.test(src) && !/^\/\/ e2e-(suite|tool):/.test(src)) missing.push(name);
}
if (missing.length) bad(`browser checks without a "// e2e-suite: roots=..." first line (so they never run): ${missing.join(", ")}`);
else ok(`${readSuites(dir).length} e2e suites registered`);
const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
const suites = select(changed);
console.log(`  info  e2e suites for this branch: ${suites.length ? suites.join(" ") : "none"}${suites.length === ALL.length ? " (all)" : ""}`);
if (suites.length) console.log("        run them with: npm run e2e -- --changed");

console.log(failed ? `\n${failed} thing(s) to fix before merging.` : "\nReady to merge as far as preflight can tell (CI still has the last word).");
process.exit(failed ? 1 : 0);
