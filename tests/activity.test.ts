import { describe, expect, it } from "vitest";
import { ago, parseMessage } from "../src/shared/activity.ts";

describe("activity feed", () => {
  it("reads the admin page's commit messages", () => {
    expect(parseMessage("Save region margun")).toMatchObject({ verb: "saved", regions: ["margun"], tail: "" });
    expect(parseMessage("Save regions a, b, c and 4 more")).toMatchObject({ verb: "saved", regions: ["a", "b", "c"], tail: " and 4 more" });
    expect(parseMessage("Move region margun to category Nirydian Religions")).toMatchObject({ verb: "moved", regions: ["margun"], tail: " to category Nirydian Religions" });
    expect(parseMessage("Move region x out of its category")).toMatchObject({ verb: "moved", regions: ["x"] });
    expect(parseMessage("Delete region old")).toMatchObject({ verb: "deleted", regions: ["old"] });
    expect(parseMessage("Transfer region r to ann")).toMatchObject({ verb: "handed over", regions: ["r"], tail: " to ann" });
  });
  it("shows other commits as they are", () => {
    expect(parseMessage('Add slot "x" showing map "y"\n\nbody')).toMatchObject({ verb: "", raw: 'Add slot "x" showing map "y"' });
  });
  it("says how long ago", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(ago("2026-11-15T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-11-15T11:30:00Z", now)).toBe("30 min ago");
    expect(ago("2026-11-15T10:00:00Z", now)).toBe("2 h ago");
    expect(ago("2026-11-14T10:00:00Z", now)).toBe("1 day ago");
    expect(ago("nonsense", now)).toBe("");
  });
});
