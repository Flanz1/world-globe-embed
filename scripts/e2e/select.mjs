/**
 * Picks the e2e suites a change needs, from the files it touched.
 *
 *   node scripts/e2e/select.mjs [base-ref]     prints suite names (space separated), or nothing
 *
 * Content-only, docs and workflow-only changes need none. Anything shared (fixture, runner,
 * viewer/shared code, build scripts) runs everything. The full suite also runs nightly (e2e.yml).
 */
import { execFileSync } from "node:child_process";

const ALL = ["contested", "regions", "snap", "merge", "coast", "cut", "locks", "ring-select", "tiles", "tiers", "view", "upload"];
const EDITOR = ["regions", "snap", "merge", "coast", "cut", "locks", "ring-select", "contested"];

/** [pattern, suites]; first match wins. */
const RULES = [
  [/^scripts\/e2e\/(fixture|ports|run|select|mock-github)\.mjs$/, ALL],
  [/^scripts\/e2e\/([\w-]+)\.mjs$/, (m) => (ALL.includes(m[1]) ? [m[1]] : ALL)],
  [/^src\/admin\/editor\//, EDITOR],
  [/^src\/admin\/(upload-image|images)\.ts$/, ["upload", "tiers", "tiles"]],
  [/^src\/admin\//, ["regions", ...EDITOR]],
  [/^admin\//, ["regions", ...EDITOR, "upload"]],
  [/^src\/shared\/(tiers|tiles|raster)\.ts$/, ["tiers", "tiles", "view", "upload"]],
  [/^src\/(viewer|shared)\//, ALL],
  [/^scripts\/(lib|process-maps|import-map|generate-pages|validate-content|coast)/, ALL],
  [/^(package(-lock)?\.json|vite\.config\.ts|tsconfig\.json|schema\/)/, ALL],
];

export function select(files) {
  const out = new Set();
  for (const f of files) {
    for (const [re, suites] of RULES) {
      const m = re.exec(f);
      if (!m) continue;
      for (const s of typeof suites === "function" ? suites(m) : suites) out.add(s);
      break;
    }
  }
  return ALL.filter((s) => out.has(s));
}

if (process.argv[1]?.endsWith("select.mjs")) {
  const base = process.argv[2] ?? "origin/main";
  const files = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean);
  console.log(select(files).join(" "));
}
