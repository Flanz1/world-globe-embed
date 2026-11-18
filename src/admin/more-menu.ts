/**
 * A "More…" button with a popover menu of the less used actions of a row (styled by .rmenu). The one menu used by the region
 * cards, the pin map rows and the folder rows, so they look and behave the same (arrow keys, Home/End, Escape, flips above the
 * button when there's no room below).
 */
import { h } from "./dom.ts";

export interface MoreItem {
  text: string;
  /** data-action of the menu item (keep it different from the inline button's); defaults to the text in kebab case. */
  action?: string;
  onclick: () => void;
  /** Why the item is disabled (shown as its tooltip). */
  why?: string;
  /** Tooltip of an enabled item. */
  hint?: string;
  danger?: boolean;
}

export function moreMenu(label: string, list: readonly (MoreItem | null)[], opts: { data?: Record<string, string>; wrap?: string } = {}): HTMLElement {
  const items = list.filter((x): x is MoreItem => !!x);
  const menu = h("div", { className: "rmenu", role: "menu", ariaLabel: label, dataset: opts.data ?? {} });
  menu.setAttribute("popover", "auto");
  const buttons = items.map((x) => {
    const b = h("button", { type: "button", role: "menuitem", className: `ghost${x.danger ? " danger" : ""}`, textContent: x.text, disabled: !!x.why, title: x.why || x.hint || "", dataset: { action: x.action ?? x.text.toLowerCase().replace(/\W+/g, "-") } });
    b.addEventListener("click", () => {
      menu.hidePopover();
      x.onclick();
    });
    return b;
  });
  menu.append(...buttons);
  const more = h("button", { type: "button", className: "ghost text", textContent: "More…", ariaLabel: label, dataset: { action: "more" } });
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-haspopup", "menu");
  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const enabled = () => buttons.filter((b) => !b.disabled);
  menu.addEventListener("beforetoggle", (ev) => {
    if ((ev as ToggleEvent).newState !== "open") return;
    const r = more.getBoundingClientRect();
    const room = window.innerHeight - r.bottom - 8;
    const need = buttons.length * 40 + 16;
    menu.style.top = room >= need || r.top < need ? `${Math.round(r.bottom + 4)}px` : `${Math.round(r.top - 4 - need)}px`;
    menu.style.left = `${Math.max(8, Math.round(Math.min(r.right - 170, window.innerWidth - 198)))}px`;
  });
  menu.addEventListener("toggle", (ev) => {
    const open = (ev as ToggleEvent).newState === "open";
    more.setAttribute("aria-expanded", String(open));
    if (open) {
      (enabled()[0] ?? buttons[0])?.focus();
      window.addEventListener("scroll", close, { capture: true, passive: true });
      window.addEventListener("resize", close);
    } else {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
      if (menu.contains(document.activeElement) || document.activeElement === document.body) more.focus();
    }
  });
  menu.addEventListener("keydown", (ev) => {
    const live = enabled();
    const at = live.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => (ev.preventDefault(), live[(n + live.length) % live.length]?.focus());
    if (ev.key === "ArrowDown") go(at + 1);
    else if (ev.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (ev.key === "Home") go(0);
    else if (ev.key === "End") go(live.length - 1);
    else if (ev.key === "Tab") menu.hidePopover();
  });
  more.addEventListener("click", () => menu.togglePopover());
  return h("span", { className: opts.wrap ?? "rmore" }, more, menu);
}
