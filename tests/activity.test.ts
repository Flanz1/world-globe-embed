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

import { cutoffFor, filterChanges, pageOf, people, type Change } from "../src/shared/activity.ts";

const mk = (login: string, date: string): Change => ({ sha: login + date, login, date, verb: "saved", regions: ["r"], tail: "", raw: "" });

describe("activity filters and pages", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  const all = [mk("ann", "2026-11-15T10:00:00Z"), mk("Bo", "2026-11-10T10:00:00Z"), mk("ann", "2026-10-01T10:00:00Z")];
  it("filters by person and by range", () => {
    expect(filterChanges(all, { login: "ANN" })).toHaveLength(2);
    expect(filterChanges(all, { since: cutoffFor("7", now) })).toHaveLength(2);
    expect(filterChanges(all, { since: cutoffFor("1", now), login: "bo" })).toHaveLength(0);
    expect(filterChanges(all, { since: cutoffFor("all", now) })).toHaveLength(3);
  });
  it("pages and clamps", () => {
    const xs = Array.from({ length: 25 }, (_, i) => i);
    expect(pageOf(xs, 3, 10)).toMatchObject({ pages: 3, page: 3, items: [20, 21, 22, 23, 24] });
    expect(pageOf(xs, 9, 10).page).toBe(3);
    expect(pageOf([], 1, 10)).toMatchObject({ pages: 1, page: 1, items: [] });
  });
  it("lists people by activity", () => expect(people(all)).toEqual(["ann", "Bo"]));
});
