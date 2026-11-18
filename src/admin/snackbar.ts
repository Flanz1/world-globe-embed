/**
 * Snackbar: the short result of an action ("Saved", "Deleted region x" with Undo), shown at the bottom of the screen
 * for 5 seconds. It pauses while the pointer or keyboard focus is on it. Success and Undo only: errors stay inline
 * (see showError). A message with an action is never replaced by a plain one; the plain one waits its turn.
 */
export interface SnackbarAction {
  label: string;
  run: () => void;
}

const SHOW_MS = 5000;
let timer: number | undefined;
let remaining = SHOW_MS;
let startedAt = 0;
let paused = false;
let current: { text: string; action?: SnackbarAction } | null = null;
let waiting: { text: string; action?: SnackbarAction } | null = null;

const bar = () => document.getElementById("snackbar");

function close(): void {
  clearTimeout(timer);
  current = null;
  const el = bar();
  if (el) el.hidden = true;
  if (waiting) {
    const next = waiting;
    waiting = null;
    showSnackbar(next.text, next.action);
  }
}

function arm(): void {
  clearTimeout(timer);
  startedAt = Date.now();
  timer = window.setTimeout(close, remaining);
}

export function showSnackbar(text: string, action?: SnackbarAction): void {
  const el = bar();
  if (!el) return;
  if (current?.action && !action) {
    waiting = { text, action };
    return;
  }
  if (current?.action && action) waiting = null;
  current = { text, action };
  const label = el.querySelector<HTMLElement>("#snackbar-text")!;
  const btn = el.querySelector<HTMLButtonElement>("#snackbar-action")!;
  label.textContent = text;
  btn.hidden = !action;
  btn.textContent = action?.label ?? "";
  btn.onclick = () => {
    const run = action?.run;
    close();
    run?.();
  };
  el.hidden = false;
  remaining = SHOW_MS;
  paused = false;
  arm();
}

export function initSnackbar(): void {
  const el = bar();
  if (!el) return;
  const pause = () => {
    if (paused || !current) return;
    paused = true;
    clearTimeout(timer);
    remaining = Math.max(1000, remaining - (Date.now() - startedAt));
  };
  const resume = () => {
    if (!paused || !current) return;
    if (el.matches(":hover") || el.contains(document.activeElement)) return;
    paused = false;
    arm();
  };
  el.addEventListener("mouseenter", pause);
  el.addEventListener("mouseleave", resume);
  el.addEventListener("focusin", pause);
  el.addEventListener("focusout", () => setTimeout(resume, 0));
}

/** An error stays on the page, at the top of the content, until dismissed or replaced; it is announced at once. */
export function showError(text: string | null): void {
  const el = document.getElementById("error-banner");
  if (!el) return;
  el.querySelector<HTMLElement>("#error-banner-text")!.textContent = text ?? "";
  el.hidden = !text;
}

export function initErrorBanner(): void {
  document.getElementById("error-banner-close")?.addEventListener("click", () => showError(null));
}
