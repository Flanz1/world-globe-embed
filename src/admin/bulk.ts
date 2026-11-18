/**
 * Selection mode for the admin lists (Regions now, Pins later): tick cards, then act on all of them from a bar
 * docked at the bottom of the screen. This file holds the selection state and the bar; what each action does
 * (and who may do it) is passed in by the tab.
 */
import { h } from "./dom.ts";

export interface BulkAction {
  text: string;
  /** Machine name for tests (data-action). */
  action: string;
  /** Why this can't be done for the current selection ("" = fine). Shown as the button's tooltip. */
  why: (ids: string[]) => string;
  run: (ids: string[]) => void;
  danger?: boolean;
}

export class Selection {
  on = false;
  readonly ids = new Set<string>();
  has = (id: string) => this.ids.has(id);
  toggle(id: string, on = !this.ids.has(id)): void {
    if (on) this.ids.add(id);
    else this.ids.delete(id);
  }
  setMany(ids: Iterable<string>, on: boolean): void {
    for (const id of ids) this.toggle(id, on);
  }
  clear = () => this.ids.clear();
  /** Forgets ids that no longer exist (after a delete or a reload). */
  keepOnly(valid: Set<string>): void {
    for (const id of [...this.ids]) if (!valid.has(id)) this.ids.delete(id);
  }
}

const groups = new WeakMap<HTMLInputElement, string[]>();

/** Brings every checkbox under `root` (and the card highlight) in line with the selection, without rebuilding the list. */
export function refreshBoxes(root: ParentNode, sel: Selection): void {
  for (const box of root.querySelectorAll<HTMLInputElement>("input.bulk-box")) {
    const ids = groups.get(box);
    if (ids) {
      const n = ids.filter((id) => sel.has(id)).length;
      box.checked = ids.length > 0 && n === ids.length;
      box.indeterminate = n > 0 && n < ids.length;
      box.setAttribute("aria-checked", box.indeterminate ? "mixed" : String(box.checked));
    } else if (box.dataset.id) {
      box.checked = sel.has(box.dataset.id);
      box.closest(".rcard")?.classList.toggle("selected", box.checked);
    }
  }
}

/** A tri-state "select these" checkbox for a group (a folder) of ids. */
export function groupBox(sel: Selection, ids: string[], label: string, rerender: () => void): HTMLInputElement {
  const n = ids.filter((id) => sel.has(id)).length;
  const box = h("input", { type: "checkbox", ariaLabel: label, title: label, className: "bulk-box", dataset: { action: "select-group" } });
  box.checked = ids.length > 0 && n === ids.length;
  box.indeterminate = n > 0 && n < ids.length;
  box.disabled = !ids.length;
  groups.set(box, ids);
  box.setAttribute("aria-checked", box.indeterminate ? "mixed" : String(box.checked));
  box.addEventListener("change", () => {
    sel.setMany(ids, box.checked);
    rerender();
  });
  return box;
}

let lastClicked: string | null = null;

/** The checkbox on a card. Shift+click ticks everything between this card and the one ticked before it (in list order). */
export function cardBox(sel: Selection, id: string, order: () => string[], rerender: () => void): HTMLElement {
  const box = h("input", { type: "checkbox", className: "bulk-box", ariaLabel: `Select ${id}`, dataset: { action: "select", id } });
  box.checked = sel.has(id);
  let shift = false;
  box.addEventListener("click", (ev) => void (shift = ev.shiftKey));
  box.addEventListener("change", () => {
    const ids = order();
    const a = lastClicked ? ids.indexOf(lastClicked) : -1;
    const b = ids.indexOf(id);
    if (shift && a >= 0 && b >= 0) sel.setMany(ids.slice(Math.min(a, b), Math.max(a, b) + 1), box.checked);
    else sel.toggle(id, box.checked);
    lastClicked = id;
    rerender();
  });
  return h("label", { className: "rsel", title: `Select ${id}` }, box);
}

/**
 * The bar at the bottom of the screen. One element, kept up to date by `update()`. It's hidden when selection
 * mode is off, and its buttons scroll sideways inside it on a narrow screen (never wrap, never widen the page).
 * Order: the actions (outlined, Delete last and separated), then Select all shown / Clear, then Done.
 * `why` of an action is shown as the button's tooltip when it can't be done for the selection.
 */
export function selectionBar(sel: Selection, noun: string, actions: BulkAction[], shownIds: () => string[], rerender: () => void, done: () => void): { el: HTMLElement; update: () => void } {
  const count = h("strong", { className: "bulk-count", role: "status", ariaLive: "polite" });
  const all = h("button", { type: "button", className: "text", textContent: "Select all shown", dataset: { action: "select-all" }, onclick: () => (sel.setMany(shownIds(), true), rerender()) });
  const none = h("button", { type: "button", className: "text", textContent: "Clear", dataset: { action: "select-none" }, onclick: () => (sel.clear(), rerender()) });
  const buttons = actions.map((a) => h("button", { type: "button", className: a.danger ? "ghost danger" : "ghost", textContent: a.text, dataset: { action: a.action }, onclick: () => a.run([...sel.ids]) }));
  const sep = h("span", { className: "bulk-sep", ariaHidden: "true" });
  const close = h("button", { type: "button", className: "tonal", textContent: "Done", dataset: { action: "select-done" }, onclick: done });
  const plain = buttons.filter((_, i) => !actions[i].danger);
  const danger = buttons.filter((_, i) => actions[i].danger);
  const el = h("div", { className: "bulk-bar", role: "region", ariaLabel: `Actions for selected ${noun}s`, hidden: true }, count, h("div", { className: "bulk-actions" }, ...plain, sep, ...danger, sep.cloneNode() as HTMLElement, all, none, close));
  const update = () => {
    el.hidden = !sel.on;
    document.body.classList.toggle("bulk-on", sel.on);
    const ids = [...sel.ids];
    count.textContent = ids.length ? `${ids.length} selected` : `Tick ${noun}s to act on them`;
    actions.forEach((a, i) => {
      const why = ids.length ? a.why(ids) : `Select at least one ${noun} first.`;
      buttons[i].disabled = !!why;
      buttons[i].title = why;
    });
    none.disabled = !ids.length;
  };
  return { el, update };
}

/** "You can't edit 2 of these regions (big-ring, rings-2)": names who is in the way, up to a few. */
export function blockedList(noun: string, verb: string, blocked: string[]): string {
  if (!blocked.length) return "";
  const names = blocked.length > 4 ? `${blocked.slice(0, 4).join(", ")} and ${blocked.length - 4} more` : blocked.join(", ");
  return `You can't ${verb} ${blocked.length} of these ${noun}s (${names}).`;
}
