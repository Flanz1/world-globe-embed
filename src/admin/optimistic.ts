/**
 * Optimistic saves for the admin page. A change that is cheap to check on the client (a region moved to
 * another category, a category renamed, a region deleted) is shown at once and committed in the background,
 * instead of freezing the page until the commit lands. If the save fails, the change is undone and the
 * reason is shown. Saves run one after another, so quick successive changes don't race each other.
 */

/** One line for the status sidebar's Checks list (null removes it). Shape matches status.ts's Check. */
export interface SaveCheck {
  id: string;
  label: string;
  state: "ok" | "warn" | "error" | "pending";
  detail?: string;
}

export interface OptimisticHooks {
  /** Shows how the latest change fared in the sidebar's Checks list. */
  setCheck: (c: SaveCheck | null) => void;
  setStatus: (text: string, kind?: "muted" | "error" | "ok") => void;
  /** After a save: status, run polling and (when `reload`) a reload from the server. */
  committed: (sha: string, reload: boolean) => Promise<void>;
  /** Re-reads everything from the server, quietly. */
  reload: () => Promise<void>;
}

let hooks: OptimisticHooks;
let queue: Promise<void> = Promise.resolve();
let pending = 0;
let stale = false;

export const initOptimistic = (h: OptimisticHooks) => void (hooks = h);
export const hasPendingSaves = () => pending > 0;

export interface OptimisticChange<S> {
  /** What the person is doing, for messages: "Move region x to category y". */
  label: string;
  /** Returns why the change can't be made, or null. Checked before anything changes on screen. */
  check?: () => string | null;
  /** Changes the local state and returns what's needed to undo it. */
  apply: () => S;
  undo: (before: S) => void;
  /** Redraws whatever shows the state. */
  render: () => void;
  /** Writes it (one commit); resolves with the commit's SHA. */
  commit: () => Promise<string>;
}

/** Shows the change now and saves it in the background. Resolves once saved (or undone). */
export function optimistic<S>(c: OptimisticChange<S>): Promise<void> {
  const problem = c.check?.();
  if (problem) {
    hooks.setStatus(problem, "error");
    hooks.setCheck({ id: "save", label: "Change refused before saving", state: "error", detail: problem });
    return Promise.resolve();
  }
  const before = c.apply();
  c.render();
  pending++;
  hooks.setStatus(`${c.label}… saving`);
  hooks.setCheck({ id: "save", label: pending > 1 ? `Saving ${pending} changes in the background` : "Passed the save rules, saving in the background", state: "pending", detail: c.label });
  const run = async () => {
    try {
      const sha = await c.commit();
      pending--;
      // Reload only when nothing else is waiting, or it would wipe the changes still being saved.
      if (pending === 0) {
        await hooks.committed(sha, true);
        stale = false;
        hooks.setCheck({ id: "save", label: "Last change saved", state: "ok", detail: c.label });
      } else await hooks.committed(sha, false);
    } catch (e) {
      pending--;
      const msg = `Couldn't save "${c.label}": ${(e as Error).message}`;
      if (pending === 0 && !stale) {
        c.undo(before);
        c.render();
      } else stale = true; // later changes are built on this one: put it all right from the server below
      hooks.setStatus(`${msg} The change was undone.`, "error");
      hooks.setCheck({ id: "save", label: "Last save failed, change undone", state: "error", detail: (e as Error).message });
      if (pending === 0) {
        stale = false;
        await hooks.reload().catch(() => {});
        hooks.setStatus(`${msg} The change was undone.`, "error");
      }
    }
  };
  const done = queue.then(run);
  queue = done;
  return done;
}

window.addEventListener("beforeunload", (e) => {
  if (pending > 0) e.preventDefault();
});
