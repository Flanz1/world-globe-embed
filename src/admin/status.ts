/**
 * The strip under the header: one line that always says whether changes are saved and live (saved, saving, deploying,
 * failed), with the branch as a tag when the page writes to a test branch. The whole strip opens a popup with three
 * panes: Activity (recent saves), Deploys (latest workflow runs) and Checks (will a commit save and deploy cleanly?).
 */
import { $, h } from "./dom";

/** One line in the popup's Checks list: will this commit and deploy cleanly? */
export interface Check {
  id: string;
  label: string;
  state: "ok" | "warn" | "error" | "pending";
  detail?: string;
}

const ICON = { ok: "✓", warn: "!", error: "✕", pending: "…" } as const;
const CLS = { ok: "ok", warn: "warn", error: "error", pending: "muted" } as const;

/** Replace the popup's checks. Other parts of the admin page (e.g. pre-commit validation) call this. */
export function setChecks(checks: Check[]): void {
  $("#checks").replaceChildren(
    ...checks.map((c) =>
      h(
        "li",
        { dataset: { check: c.id } },
        h("span", { className: CLS[c.state], textContent: `${ICON[c.state]} ` }),
        c.label,
        c.detail ? h("span", { className: "muted", textContent: ` · ${c.detail}` }) : null,
      ),
    ),
  );
}

export type StripState = "loading" | "saved" | "saving" | "deploying" | "failed";
export type Pane = "activity" | "deploys" | "checks";
const PANES: Pane[] = ["activity", "deploys", "checks"];

export interface StripView {
  state: StripState;
  /** The full sentence (desktop and tablet). */
  long: string;
  /** A few words for phones. */
  short: string;
  /** The pane the popup opens on: a failed deploy opens Deploys, a failed save Checks. */
  pane?: Pane;
}

let openOn: Pane = "activity";

export function setStrip(v: StripView): void {
  const strip = $("#strip");
  strip.dataset.state = v.state;
  $("#strip-long").textContent = v.long;
  $("#strip-short").textContent = v.short;
  openOn = v.pane ?? "activity";
}

/** The branch tag: shown only when the page writes somewhere other than the default branch. */
export function setBranch(branch: string, defaultBranch: string): void {
  const el = $("#branch");
  el.hidden = branch === defaultBranch;
  el.textContent = `Branch ${branch}`;
  el.title = `Writing to branch ${branch} (not ${defaultBranch}): changes won't go live from here`;
}

/** The Deploys tab's count: runs still going or failed (none shows no count). */
export function setDeploysBadge(n: number): void {
  const b = $("#deploys-badge");
  b.hidden = n === 0;
  b.textContent = String(n);
}

export function showPane(pane: Pane): void {
  for (const p of PANES) {
    $(`#pop-${p}`).hidden = p !== pane;
    $(`#pop-btn-${p}`).setAttribute("aria-pressed", String(p === pane));
  }
}

/** Opens the popup on a pane (or the strip's own choice). */
export function openStripPop(pane?: Pane): void {
  showPane(pane ?? openOn);
  const pop = $("#strip-pop");
  if (!pop.matches(":popover-open")) pop.showPopover();
}

export function initStrip(repo: string): void {
  const strip = $<HTMLButtonElement>("#strip");
  const pop = $("#strip-pop");
  $<HTMLAnchorElement>("#runs-all").href = `https://github.com/${repo}/actions`;
  for (const p of PANES) $(`#pop-btn-${p}`).addEventListener("click", () => showPane(p));
  // A click on the strip while the popup is open: the popup's light dismiss closes it on the press, before the click.
  // A click that lands just after that close keeps it closed instead of opening it again.
  let closedAt = -1e9;
  strip.addEventListener("click", () => {
    if (pop.matches(":popover-open")) pop.hidePopover();
    else if (performance.now() - closedAt > 400) openStripPop();
  });
  pop.addEventListener("beforetoggle", (ev) => {
    // (beforetoggle fires at once; toggle comes later, after the click that followed the press.)
    const opening = (ev as ToggleEvent).newState === "open";
    strip.setAttribute("aria-expanded", String(opening));
    if (!opening) return void (closedAt = performance.now());
    // Desktop: under the strip, at its right end. Phones: CSS makes it a bottom sheet.
    const r = strip.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    pop.style.right = "8px";
  });
  pop.addEventListener("toggle", (ev) => {
    const open = (ev as ToggleEvent).newState === "open";
    if (open) pop.querySelector<HTMLElement>('.strip-seg button[aria-pressed="true"]')?.focus();
    else if (pop.contains(document.activeElement) || document.activeElement === document.body) strip.focus();
  });
}
