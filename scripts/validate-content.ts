/** CLI: validate content/ and exit non-zero with readable errors. */
import { loadContent } from "./lib/content.ts";

const { content, errors, warnings } = loadContent();
for (const w of warnings) {
  console.warn(`  ! ${w}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Content validation::${w}`);
}
if (errors.length) {
  console.error(`\nContent validation failed (${errors.length} problem${errors.length > 1 ? "s" : ""}):\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error("");
  if (process.env.GITHUB_ACTIONS) for (const e of errors) console.log(`::error title=Content validation::${e}`);
  process.exit(1);
}
console.log(
  `Content OK: ${Object.keys(content!.slots.slots).length} slot(s), ${content!.maps.size} map(s), ${content!.regions?.size ?? 0} region(s)` +
    (warnings.length ? `, ${warnings.length} warning(s).` : "."),
);
