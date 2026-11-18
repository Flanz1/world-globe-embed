import { describe, expect, it } from "vitest";
import { nearestSnap, snapHeights } from "../src/admin/editor/sheet-math.ts";

describe("editor bottom sheet heights", () => {
  it("peek < half < full on a phone", () => {
    const s = snapHeights(640);
    expect(s).toEqual({ peek: 112, half: 320, full: 576 });
  });
  it("peek shrinks on a short landscape screen and the order holds", () => {
    const s = snapHeights(200);
    expect(s.peek).toBe(80);
    expect(s.peek).toBeLessThanOrEqual(s.half);
    expect(s.half).toBeLessThanOrEqual(s.full);
  });
  it("snaps to the nearest height", () => {
    expect(nearestSnap(130, 640)).toBe("peek");
    expect(nearestSnap(300, 640)).toBe("half");
    expect(nearestSnap(560, 640)).toBe("full");
  });
});
