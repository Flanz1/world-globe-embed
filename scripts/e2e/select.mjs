/**
 * Picks the e2e suites a change needs, from the files it touched.
 *
 *   node scripts/e2e/select.mjs [base-ref]     prints suite names (space separated), or nothing
 *
 * TypeScript under src/ and worker/ is matched through the import graph: each suite lists the entry
 * files its page or process loads (SUITE_ROOTS), and a changed file selects every suite whose
 * entries import it, directly or not. So a change to the Regions tab selects the suites that load
 * the whole admin page (regions, roles), not the editor suites that only open the editor.
 * Other files (CSS, build scripts, schema, the suites themselves) have the rules in RULES.
 * Docs, tests/ and content/ select nothing, and `check` already typechecks, lints and builds everything.
 * The full suite runs nightly (e2e.yml), which covers what this leaves out.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALL = ["contested", "regions", "snap", "merge", "coast", "cut", "locks", "ring-select", "tiles", "tiers", "view", "upload", "roles"];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ADMIN = ["src/admin/main.ts"];
const EDITOR = ["src/admin/editor/editor.ts"];
const VIEWER = ["src/viewer/boot.ts", "src/viewer/globe.ts", "src/viewer/flat.ts", "src/viewer/region-ui.ts"];
const WORKER = ["worker/src/handler.ts"];
/**
 * Files the editor imports but that the editor suites don't test (the Regions tab, sign-in session,
 * categories): changes there don't select them. Roots keep the path from the entry; these are cut.
 */
const EDITOR_CUT = ["src/admin/regions.ts", "src/admin/session.ts", "src/admin/categories.ts", "src/admin/github.ts", "src/shared/access.ts", "src/shared/categories.ts"];
/** Entry files each suite exercises. Editor suites cut the graph at EDITOR_CUT. */
export const SUITE_ROOTS = {
  regions: [...ADMIN, ...VIEWER],
  roles: [...ADMIN, ...WORKER],
  upload: ["src/admin/upload-image.ts", "src/admin/images.ts"],
  cut: EDITOR,
  merge: EDITOR,
  locks: EDITOR,
  coast: EDITOR,
  "ring-select": EDITOR,
  snap: [...EDITOR, ...VIEWER],
  contested: [...EDITOR, ...VIEWER],
  view: VIEWER,
  tiers: [...VIEWER, "src/shared/tiers.ts"],
  tiles: [...VIEWER, "src/shared/tiers.ts", "src/shared/tiles.ts", "src/shared/raster.ts"],
};

/** [pattern, suites | (match) => suites]; first match wins. [] = no e2e needed. */
const RULES = [
  [/^(docs|tests|content)\//, []],
  [/\.md$/, []],
  [/^scripts\/e2e\/select\.(mjs|d\.mts)$/, []], // unit-tested in tests/e2e-select.test.ts
  [/^scripts\/e2e\/run\.mjs$/, ["view", "ring-select"]], // a quick smoke of the runner
  [/^scripts\/e2e\/(fixture|ports|mock-github|admin-api)\.(mjs|d\.mts)$/, ALL],
  [/^scripts\/e2e\/([\w-]+)\.mjs$/, (m) => (ALL.includes(m[1]) ? [m[1]] : [])],
  [/^(package(-lock)?\.json|vite\.config\.ts|tsconfig\.json|eslint\.config\.js)$/, ALL],
  [/^src\/admin\/editor\/.*\.css$/, ["cut", "merge", "locks", "coast", "ring-select", "snap", "contested"]],
  [/^(src\/admin\/.*\.css|admin\/.*)$/, ["regions", "roles"]],
  [/^src\/(viewer|shared)\/.*\.css$/, ["view", "regions"]],
  [/^(schema\/|scripts\/build-worker-validators)/, ["regions", "roles"]],
  [/^worker\/(?!src\/.*\.ts$)/, ["roles"]],
  [/^scripts\/(process-maps|import-map|coast)\.ts$|^scripts\/lib\/(process|coast)/, ["tiers", "tiles", "upload", "coast"]],
  // Build and page generation: every suite builds a fixture, and `regions` covers the admin and embed pages.
  [/^scripts\//, ["regions"]],
];

const EDITOR_SUITES = new Set(["cut", "merge", "locks", "coast", "ring-select", "snap", "contested"]);

let graph;
/** suite → Set of repo-relative files its entries import. Built once with esbuild. */
function importGraph() {
  if (graph) return graph;
  const { buildSync } = createRequire(path.join(ROOT, "package.json"))("esbuild");
  graph = {};
  for (const [suite, entries] of Object.entries(SUITE_ROOTS)) {
    const r = buildSync({
      entryPoints: entries.map((e) => path.join(ROOT, e)),
      bundle: true,
      write: false,
      metafile: true,
      outdir: "out",
      platform: "browser",
      packages: "external",
      external: EDITOR_SUITES.has(suite) ? EDITOR_CUT.map((f) => path.join(ROOT, f)) : [],
      logLevel: "silent",
      loader: { ".css": "empty" },
      define: { "import.meta.env": "{}" },
    });
    graph[suite] = new Set(Object.keys(r.metafile.inputs).map((f) => f.replace(/\\/g, "/")));
  }
  return graph;
}

export function select(files) {
  const out = new Set();
  for (const f of files) {
    const rule = RULES.find(([re]) => re.test(f));
    if (rule) {
      const [re, suites] = rule;
      for (const s of typeof suites === "function" ? suites(re.exec(f)) : suites) out.add(s);
    } else if (/\.(ts|js)$/.test(f)) {
      const g = importGraph();
      for (const [suite, files] of Object.entries(g)) if (files.has(f)) out.add(suite);
    }
  }
  return ALL.filter((s) => out.has(s));
}

if (process.argv[1]?.endsWith("select.mjs")) {
  const base = process.argv[2] ?? "origin/main";
  const files = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean);
  console.log(select(files).join(" "));
}
