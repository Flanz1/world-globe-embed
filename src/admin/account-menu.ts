/**
 * Account menu for phones: the repository / signed-in text and Sign out move behind one button in the header
 * (CSS shows the button, and hides the text and the Sign out button, only on phones). Same popover pattern as the
 * colour menu: Escape or a click outside closes it, focus goes to the first item and back to the button.
 */
const SVG = "http://www.w3.org/2000/svg";

export function initAccountMenu(signOut: () => void): { setWho: (text: string) => void; show: (on: boolean) => void } {
  const btn = document.getElementById("account") as HTMLButtonElement;
  const menu = document.getElementById("account-menu") as HTMLElement;
  const who = document.getElementById("who-menu") as HTMLElement;
  const out = document.getElementById("forget-menu") as HTMLButtonElement;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21a8 8 0 0 1 16 0"]) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  btn.replaceChildren(svg);
  menu.addEventListener("beforetoggle", (ev) => {
    if ((ev as ToggleEvent).newState !== "open") return;
    const r = btn.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.left = `${Math.max(8, Math.round(Math.min(r.right - 248, window.innerWidth - 256)))}px`;
  });
  menu.addEventListener("toggle", (ev) => {
    const open = (ev as ToggleEvent).newState === "open";
    btn.setAttribute("aria-expanded", String(open));
    if (open) out.focus();
    else if (menu.contains(document.activeElement) || document.activeElement === document.body) btn.focus();
  });
  btn.addEventListener("click", () => menu.togglePopover());
  out.addEventListener("click", () => {
    menu.hidePopover();
    signOut();
  });
  return {
    setWho: (text) => void (who.textContent = text),
    show: (on) => void (btn.hidden = !on),
  };
}
