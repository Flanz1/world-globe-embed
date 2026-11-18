/**
 * "Back to top": a small pill on phones that appears after the first screen of the Regions tab.
 * (CSS shows it only on phones and hides it while the bulk-selection bar is up.)
 */
export function initBackToTop(): void {
  const btn = document.getElementById("to-top");
  if (!btn) return;
  const update = (): void => {
    const regions = document.getElementById("tab-regions");
    btn.hidden = !(regions && !regions.hidden && window.scrollY > window.innerHeight);
  };
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  document.addEventListener("click", () => setTimeout(update, 0));
  btn.addEventListener("click", () => {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
    document.getElementById("r-search")?.focus({ preventScroll: true });
  });
}
