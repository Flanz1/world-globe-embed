/**
 * CLI: the content health check (src/shared/health.ts) over content/. Prints a Markdown report, also to the
 * job summary when run by GitHub Actions. Always exits 0 unless --fail is given and a "problem" was found.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadContent } from "./lib/content.ts";
import { contentPaths } from "./lib/paths.ts";
import { checkHealth, healthMarkdown } from "../src/shared/health.ts";
import type { CategoriesFile } from "../src/shared/categories.ts";
import type { PinFeature } from "../src/shared/pins.ts";
import type { RegionFeature } from "../src/shared/region.ts";

const paths = contentPaths();
const { content, errors } = loadContent(paths);
if (!content) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const dir = (sub: string) => path.join(paths.content, sub);
function readAll<T>(sub: string): { id: string; feature: T | null; problem?: string }[] {
  if (!existsSync(dir(sub))) return [];
  return readdirSync(dir(sub))
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const id = f.slice(0, -5);
      try {
        return { id, feature: JSON.parse(readFileSync(path.join(dir(sub), f), "utf8")) as T };
      } catch (e) {
        return { id, feature: null, problem: (e as Error).message };
      }
    });
}
const categoriesFile = path.join(paths.content, "categories.json");
const categories = existsSync(categoriesFile) ? (JSON.parse(readFileSync(categoriesFile, "utf8")) as CategoriesFile) : null;

const issues = checkHealth({
  regions: readAll<RegionFeature>("regions"),
  pins: readAll<PinFeature>("pins"),
  categories,
  pinMaps: content.pinMaps ?? null,
  slots: content.slots,
});
const report = healthMarkdown(issues);
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
if (process.argv.includes("--fail") && issues.some((i) => i.severity === "problem")) process.exit(1);
