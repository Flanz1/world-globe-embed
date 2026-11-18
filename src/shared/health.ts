/**
 * Content health check: problems the repository's content can have that nothing refuses to save, but that
 * someone should look at. Pure (no DOM, no network), so the admin page's Health tab and the weekly
 * scripts/content-health.ts run give the same answer from the same data.
 */
import { MAX_VERTICES, WARN_VERTICES, pointInGeometry, polygonsOf, vertexCount } from "./geo.ts";
import { placements, type CategoriesFile } from "./categories.ts";
import type { PinFeature } from "./pins.ts";
import type { PinMapsFile } from "./pinmaps.ts";
import { OWN_COLOUR, type RegionFeature } from "./region.ts";
import type { SlotsFile } from "./types.ts";

export type HealthCode = "unreadable" | "older-map" | "pin-outside" | "unused-pin-map" | "no-category" | "empty-colour" | "near-cap" | "missing-pin-map";

/** "problem" is something that is probably wrong, "notice" something worth a look. */
export type HealthSeverity = "problem" | "notice";

export interface HealthIssue {
  code: HealthCode;
  severity: HealthSeverity;
  /** What it is about; the admin page links region subjects to the region. */
  subject: { kind: "region" | "pin" | "pin-map"; id: string };
  /** One plain sentence. */
  message: string;
}

export interface HealthInput {
  regions: { id: string; feature: RegionFeature | null; problem?: string }[];
  pins: { id: string; feature: PinFeature | null; problem?: string }[];
  categories: CategoriesFile | null;
  pinMaps: PinMapsFile | null;
  slots: SlotsFile;
}

/** The checks, in the order the Health tab lists them. */
export const HEALTH_CHECKS: { code: HealthCode; title: string; help: string }[] = [
  { code: "unreadable", title: "Files that can't be read", help: "A region or pin file that is broken or has the wrong shape." },
  { code: "older-map", title: "Drawn on a different map", help: "The slot now shows another map than the one this was drawn on (an older map), so it may sit in the wrong place." },
  { code: "pin-outside", title: "Pins outside their region", help: "A pin of a pin map that a region shows, lying outside every region that shows that pin map." },
  { code: "missing-pin-map", title: "Pin map doesn't exist", help: "A region or pin names a pin map that isn't in the Pins tab." },
  { code: "unused-pin-map", title: "Unused pin maps", help: "A pin map with no pins in it that no region shows." },
  { code: "no-category", title: "Regions in no folder", help: "Regions that aren't in any folder of the Regions tab." },
  { code: "empty-colour", title: "Empty colour folders", help: "A colour (legend entry) that no part of the region is drawn in." },
  { code: "near-cap", title: "Close to the vertex limit", help: `Regions with ${WARN_VERTICES.toLocaleString("en")} or more of the ${MAX_VERTICES.toLocaleString("en")} vertices a region may have.` },
];

const name = (r: RegionFeature, id: string) => r.properties.name?.trim() || id;

export function checkHealth(input: HealthInput): HealthIssue[] {
  const out: HealthIssue[] = [];
  const add = (code: HealthCode, severity: HealthSeverity, kind: HealthIssue["subject"]["kind"], id: string, message: string) =>
    out.push({ code, severity, subject: { kind, id }, message });
  const slotMap = (slug: string) => input.slots.slots[slug]?.map;
  const pinMapIds = new Set((input.pinMaps?.maps ?? []).map((m) => m.id));
  const regions = input.regions.filter((r) => r.feature);
  const pins = input.pins.filter((p) => p.feature);

  for (const r of input.regions) if (!r.feature) add("unreadable", "problem", "region", r.id, r.problem ?? "This region file can't be read.");
  for (const p of input.pins) if (!p.feature) add("unreadable", "problem", "pin", p.id, p.problem ?? "This pin file can't be read.");

  for (const { id, feature: f } of regions) {
    const p = f!.properties;
    const now = slotMap(p.slot);
    if (now === undefined) add("older-map", "problem", "region", id, `The slot "${p.slot}" it belongs to doesn't exist.`);
    else if (now !== p.map) add("older-map", "problem", "region", id, `Drawn on map "${p.map}", but slot "${p.slot}" now shows "${now}".`);
  }
  for (const { id, feature: f } of pins) {
    const p = f!.properties;
    const now = slotMap(p.slot);
    if (now === undefined) add("older-map", "problem", "pin", id, `The slot "${p.slot}" it belongs to doesn't exist.`);
    else if (now !== p.map) add("older-map", "problem", "pin", id, `Placed on map "${p.map}", but slot "${p.slot}" now shows "${now}".`);
  }

  // Pins of a pin map that regions show, but lying in none of those regions.
  const showers = new Map<string, RegionFeature[]>();
  for (const { feature: f } of regions)
    for (const pm of f!.properties.pinMaps ?? []) showers.set(pm, [...(showers.get(pm) ?? []), f!]);
  for (const { id, feature: f } of pins) {
    const pm = f!.properties.pinMap;
    const shown = pm ? showers.get(pm) : undefined;
    if (!shown?.length) continue;
    const here = shown.filter((r) => r.properties.slot === f!.properties.slot && r.properties.map === f!.properties.map);
    if (!here.length) continue;
    if (!here.some((r) => pointInGeometry(f!.geometry.coordinates, r.geometry))) {
      const names = here.map((r) => `"${name(r, r.id)}"`);
      add("pin-outside", "notice", "pin", id, `Outside ${here.length === 1 ? names[0] : "all of " + names.join(", ")}, which show${here.length === 1 ? "s" : ""} its pin map "${pm}".`);
    }
  }

  for (const { id, feature: f } of regions)
    for (const pm of f!.properties.pinMaps ?? []) if (!pinMapIds.has(pm)) add("missing-pin-map", "problem", "region", id, `Shows the pin map "${pm}", which doesn't exist.`);
  for (const { id, feature: f } of pins) {
    const pm = f!.properties.pinMap;
    if (pm && !pinMapIds.has(pm)) add("missing-pin-map", "problem", "pin", id, `Belongs to the pin map "${pm}", which doesn't exist.`);
  }

  const used = new Set(pins.map((p) => p.feature!.properties.pinMap).filter(Boolean));
  for (const m of input.pinMaps?.maps ?? []) if (!used.has(m.id) && !showers.has(m.id)) add("unused-pin-map", "notice", "pin-map", m.id, `"${m.name}" has no pins and no region shows it.`);

  const placed = placements(input.categories);
  if (input.categories?.categories.length)
    for (const { id } of regions) if (!placed.has(id)) add("no-category", "notice", "region", id, "Not in any folder.");

  for (const { id, feature: f } of regions) {
    const p = f!.properties;
    if (p.linked?.length) continue; // a linked region's colours come from the regions it links
    const parts = polygonsOf(f!.geometry).length;
    const inUse = new Set((p.partLegend ?? []).slice(0, parts));
    if (!p.partLegend) inUse.add(OWN_COLOUR);
    if (p.colorLabel?.trim() && !inUse.has(OWN_COLOUR) && p.partLegend) add("empty-colour", "notice", "region", id, `The folder "${p.colorLabel.trim()}" (the region's own colour) has no parts.`);
    (p.legend ?? []).forEach((e, i) => {
      if (!inUse.has(i)) add("empty-colour", "notice", "region", id, `The colour folder "${e.label || e.color}" has no parts.`);
    });
  }

  for (const { id, feature: f } of regions) {
    const n = vertexCount(f!.geometry);
    if (n > MAX_VERTICES) add("near-cap", "problem", "region", id, `${n.toLocaleString("en")} vertices, over the limit of ${MAX_VERTICES.toLocaleString("en")}.`);
    else if (n >= WARN_VERTICES) add("near-cap", "notice", "region", id, `${n.toLocaleString("en")} of ${MAX_VERTICES.toLocaleString("en")} vertices (${Math.round((n / MAX_VERTICES) * 100)}%).`);
  }

  const order = new Map(HEALTH_CHECKS.map((c, i) => [c.code, i]));
  return out.sort((a, b) => order.get(a.code)! - order.get(b.code)! || a.subject.id.localeCompare(b.subject.id));
}

/** Issues grouped by check, in the Health tab's order; checks with nothing to report are left out. */
export function groupIssues(issues: readonly HealthIssue[]): { check: (typeof HEALTH_CHECKS)[number]; issues: HealthIssue[] }[] {
  return HEALTH_CHECKS.map((check) => ({ check, issues: issues.filter((i) => i.code === check.code) })).filter((g) => g.issues.length);
}

/** The report as Markdown, for the weekly run's summary. */
export function healthMarkdown(issues: readonly HealthIssue[]): string {
  if (!issues.length) return "## Content health\n\nNo problems found.\n";
  const lines = ["## Content health", "", `${issues.length} thing${issues.length === 1 ? "" : "s"} to look at.`, ""];
  for (const g of groupIssues(issues)) {
    lines.push(`### ${g.check.title} (${g.issues.length})`, "", g.check.help, "");
    for (const i of g.issues) lines.push(`- ${i.subject.kind === "pin-map" ? "pin map" : i.subject.kind} \`${i.subject.id}\`: ${i.message}`);
    lines.push("");
  }
  return lines.join("\n");
}
