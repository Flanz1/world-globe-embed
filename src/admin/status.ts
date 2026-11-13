import { $, h } from "./dom";

/** One line in the status sidebar's "Checks" list: will this commit and deploy cleanly? */
export interface Check {
  id: string;
  label: string;
  state: "ok" | "warn" | "error" | "pending";
  detail?: string;
}

const ICON = { ok: "✓", warn: "!", error: "✕", pending: "…" } as const;
const CLS = { ok: "ok", warn: "warn", error: "error", pending: "muted" } as const;

/** Replace the sidebar's checks. Other parts of the admin page (e.g. pre-commit validation) call this. */
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
