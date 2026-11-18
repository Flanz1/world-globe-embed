/**
 * The left-edge stack (top-left on phones) of "what's shown" panels in the embed: the region legend (with its layer toggles) and the
 * pin kind filter sit in one column so they never overlap. The first caller creates it; styled in shared/page.ts.
 */
export function leftStack(stage: HTMLElement): HTMLElement {
  let s = stage.querySelector<HTMLElement>(":scope > .rstack");
  if (!s) {
    s = document.createElement("div");
    s.className = "rstack";
    stage.append(s);
  }
  return s;
}
