/**
 * Health tab: the content health check (src/shared/health.ts) over what the page has already loaded
 * (regions, pins, folders, pin maps, slots). Read-only, and it costs no requests.
 * Groups with a problem come first and start open; groups with only notices start closed; checks that
 * found nothing are named in one closing line.
 */
import { h } from "./dom.ts";
import { $ } from "./dom.ts";
import { HEALTH_CHECKS, checkHealth, groupIssues, type HealthIssue } from "../shared/health.ts";
import { categories } from "./categories.ts";
import { pinMaps } from "./pinmaps.ts";
import { openPinById, pinEntries } from "./pins.ts";
import { regionEntries } from "./regions.ts";
import type { SlotsFile } from "../shared/types.ts";

export interface HealthDeps {
  slots: () => SlotsFile;
  /** Opens a region (editor or the Regions tab). Returns false when it no longer exists. */
  openRegion: (id: string) => boolean;
}

let deps: HealthDeps;
export const initHealth = (d: HealthDeps) => void (deps = d);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Draws the tab's list and the count on the tab button. `checked` shows "Checked just now" after a press of Check again. */
export function renderHealth(checked = false): void {
  const panel = $("#tab-health");
  const regions = regionEntries();
  const pins = pinEntries();
  const loaded = regions.length > 0 || pins.length > 0;
  const issues = loaded ? checkHealth({ regions, pins, categories: categories(), pinMaps: pinMaps(), slots: deps.slots() }) : [];
  const problems = issues.filter((i) => i.severity === "problem").length;
  const notices = issues.length - problems;

  const btn = $("#tab-btn-health");
  // The rail item keeps its icon and name; only the small count pill on its icon changes.
  btn.querySelector(".nav-badge")?.remove();
  if (issues.length) btn.append(h("span", { className: `nav-badge ${problems ? "error" : "warn"}`, textContent: String(issues.length), ariaHidden: "true" }));
  const count = problems && notices ? `${plural(problems, "problem", "problems")}, ${plural(notices, "notice", "notices")}` : problems ? plural(problems, "problem", "problems") : plural(notices, "notice", "notices");
  btn.setAttribute("aria-label", issues.length ? `Health, ${count}` : "Health");

  const summary = !loaded ? "Loading…" : !issues.length ? "✓ All clear · nothing to fix" : [problems ? `✕ ${plural(problems, "problem", "problems")}` : "", notices ? `! ${plural(notices, "notice", "notices")}` : ""].filter(Boolean).join(" · ");

  // Groups holding a problem first (open), then notice-only groups (closed).
  const groups = groupIssues(issues);
  const hasProblem = (g: (typeof groups)[number]) => g.issues.some((i) => i.severity === "problem");
  const ordered = [...groups.filter(hasProblem), ...groups.filter((g) => !hasProblem(g))];
  const found = new Set(groups.map((g) => g.check.code));
  const clear = HEALTH_CHECKS.filter((c) => !found.has(c.code)).map((c) => c.title);

  panel.replaceChildren(
    h(
      "section",
      { className: "card" },
      h(
        "div",
        { className: "card-head" },
        h("h2", {}, "Content health", issues.length ? h("span", { className: "rcount-pill", textContent: String(issues.length) }) : null),
        h("button", { type: "button", className: "ghost", textContent: "Check again", onclick: () => renderHealth(true) }),
      ),
      h("p", { className: "muted small", textContent: "Things in regions, pins and folders worth a look. Nothing here blocks saving." }),
      h(
        "div",
        { className: "row hl-head" },
        h("strong", { id: "hl-summary", textContent: summary }),
        h("span", { className: "muted small", ariaLive: "polite", textContent: checked ? "Checked just now" : "" }),
      ),
      ...ordered.map((g) =>
        h(
          "details",
          { className: "hl-group", open: hasProblem(g), dataset: { check: g.check.code } },
          h("summary", {}, g.check.title, h("span", { className: "badge", textContent: String(g.issues.length) })),
          h("p", { className: "muted small", textContent: g.check.help }),
          h("ul", { className: "hl-list" }, ...g.issues.map(row)),
        ),
      ),
      loaded && issues.length && clear.length ? h("p", { className: "muted small", textContent: `Also checked: ${clear.join(", ")}.` }) : "",
    ),
  );
}

function row(i: HealthIssue): HTMLElement {
  const kind = i.subject.kind === "pin-map" ? "pin map" : i.subject.kind;
  const { kind: k, id } = i.subject;
  const open = h("button", {
    type: "button",
    className: "link",
    textContent: id,
    title: k === "region" ? `Open ${id}` : k === "pin" ? `Show ${id} on the Pins tab` : "Show the Pins tab",
    onclick: () => {
      if (k === "region" && deps.openRegion(id)) return;
      if (k === "pin" && openPinById(id)) return;
      location.hash = "#pins";
    },
  });
  return h(
    "li",
    { className: "hl-row", dataset: { severity: i.severity } },
    h("span", { className: "muted small", textContent: `${i.severity === "problem" ? "Problem" : "Notice"} · ${kind}` }),
    open,
    h("span", { className: "muted", textContent: i.message }),
  );
}
