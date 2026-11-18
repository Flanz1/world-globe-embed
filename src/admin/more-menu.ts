/**
 * A "More…" button with a popover menu of the less used actions of a row (the same look and keyboard behaviour as the region
 * cards' More… menu, styled by .rmenu). Used by the pin map and folder rows on phones, where the full row doesn't fit.
 */
import { h } from "./dom.ts";

export interface MoreItem {
  text: string;
  /** data-action of the menu item (keep it different from the inline button's). */
  action: string;
  onclick: () => void;
  why?: string;
  danger?: boolean;
}

export function moreMenu(label: string, items: readonly MoreItem[]): HTMLElement {
  const menu = h("div", { className: "rmenu", role: "menu", ariaLabel: label });
  menu.setAttribute("popover", "auto");
  const buttons = items.map((x) => {
    const b = h("button", { type: "button", role: "menuitem", className: `ghost${x.danger ? " danger" : ""}`, textContent: x.text, disabled: !!x.why, title: x.why ?? "", dataset: { action: x.action } });
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
  return h("span", { className: "act-more" }, more, menu);
}
