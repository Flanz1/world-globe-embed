/**
 * Suggested changes, on the Regions tab. People who can't edit a region send their version as a
 * suggestion; this panel lists the ones waiting for you to look at (for regions you may edit) and the
 * ones you sent (with what became of them). The editor does the comparing and accepting (regions.ts).
 */
import { $, h } from "./dom.ts";
import type { GitHub, SuggestionSummary } from "./github.ts";
import { alertBox, askText } from "./region-dialogs.ts";
import { canEditCreatedBy, currentUser } from "./session.ts";

interface Deps {
  gh: () => GitHub;
  /** Opens the editor on a suggestion, to compare and accept it. */
  review: (s: SuggestionSummary) => void;
}

let deps: Deps;
let items: SuggestionSummary[] = [];

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function initSuggestions(d: Deps): void {
  deps = d;
}

export async function loadSuggestions(): Promise<void> {
  try {
    items = await deps.gh().suggestions();
  } catch {
    // Not set up on this admin API, or a passing error: the panel just stays out of the way.
    items = [];
  }
  renderSuggestions();
}

/** Pending suggestions for a region (cards show a badge). */
export const pendingFor = (region: string): number => items.filter((s) => s.region === region && s.status === "pending").length;

async function decline(s: SuggestionSummary): Promise<boolean> {
  const reason = await askText("Decline suggestion", `Decline ${s.by.login}'s suggestion for ${s.region}? You can tell them why (optional).`, "Decline", { placeholder: "e.g. The border is meant to follow the old road", max: 120 });
  if (reason === null) return false;
  await deps.gh().decideSuggestion(s.id, "declined", reason);
  await loadSuggestions();
  return true;
}

/** Declines with the usual question; for the editor's Decline button. */
export const declineSuggestion = decline;

export async function markAccepted(s: SuggestionSummary): Promise<void> {
  await deps.gh().decideSuggestion(s.id, "accepted");
  await loadSuggestions();
}

function row(s: SuggestionSummary, mine: boolean): HTMLElement {
  const act = (text: string, fn: () => void | Promise<unknown>, cls = "ghost") =>
    h("button", { type: "button", className: cls, textContent: text, dataset: { action: text.toLowerCase() }, onclick: () => void Promise.resolve(fn()).catch((e: Error) => alertBox("Couldn't do that", e.message)) });
  const status = s.status === "pending" ? "waiting" : s.status === "accepted" ? `accepted by ${s.decidedBy}` : `declined by ${s.decidedBy}${s.reason ? `: ${s.reason}` : ""}`;
  const what = mine ? `Your suggestion for ${s.region}` : `${s.by.login} suggests changes to ${s.region}`;
  const buttons: HTMLElement[] = [];
  if (!mine && s.status === "pending") buttons.push(act("Review", () => deps.review(s), ""), act("Decline", () => decline(s)));
  if (mine) buttons.push(act(s.status === "pending" ? "Withdraw" : "Clear", async () => (await deps.gh().removeSuggestion(s.id), loadSuggestions())));
  return h(
    "li",
    { className: "sug-row", dataset: { suggestion: s.id } },
    h("span", {}, h("strong", { textContent: what }), h("span", { className: "muted small", textContent: ` · ${when(s.at)} · ${status}` }), s.note ? h("div", { className: "muted small", textContent: `“${s.note}”` }) : null),
    h("div", { className: "actions" }, ...buttons),
  );
}

function renderSuggestions(): void {
  const me = currentUser();
  const el = $("#suggestions");
  if (!me) return void (el.hidden = true);
  const toReview = items.filter((s) => s.by.id !== me.id && s.status === "pending" && canEditCreatedBy(s.owner));
  const mine = items.filter((s) => s.by.id === me.id);
  el.hidden = !toReview.length && !mine.length;
  el.replaceChildren(
    ...(toReview.length ? [h("h3", { textContent: `Suggestions to review (${toReview.length})` }), h("ul", { className: "sug-list", dataset: { list: "review" } }, ...toReview.map((s) => row(s, false)))] : []),
    ...(mine.length ? [h("h3", { textContent: "Your suggestions" }), h("ul", { className: "sug-list", dataset: { list: "mine" } }, ...mine.map((s) => row(s, true)))] : []),
  );
}
