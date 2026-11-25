/** Heights of the editor bottom sheet (no DOM here, so it can be unit-tested). */
export type SnapName = "peek" | "half" | "full";
export const SNAPS: SnapName[] = ["peek", "half", "full"];

/** The pixel heights the sheet snaps to, for a body `total` px tall. */
export function snapHeights(total: number): Record<SnapName, number> {
  // Peek shows the handle, the tool strip and the tabs.
  const peek = Math.min(136, Math.round(total * 0.45));
  const half = Math.max(peek, Math.round(total * 0.5));
  const full = Math.max(half, total - 64);
  return { peek, half, full };
}

/** The snap nearest to a height. */
export function nearestSnap(px: number, total: number): SnapName {
  const s = snapHeights(total);
  return SNAPS.reduce((best, n) => (Math.abs(s[n] - px) < Math.abs(s[best] - px) ? n : best), "peek" as SnapName);
}

