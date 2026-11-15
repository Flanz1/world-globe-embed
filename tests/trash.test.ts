import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../src/shared/history.ts";
import { TRASH_DAYS, timeLeft, trashItems, trashSince } from "../src/shared/trash.ts";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const save = (sha: string, hoursAgo: number, files: HistoryEntry["files"], message = "save"): HistoryEntry => ({ sha, parent: `${sha}-parent`, date: ago(hoursAgo), author: { login: "ann", id: 1 }, message, files });
const gone = (id: string, dir = "regions") => ({ path: `content/${dir}/${id}.json`, status: "removed" as const });

describe("trash", () => {
  it("lists regions and pins deleted in the last 3 days, newest first, with the commit that still had them", () => {
    const items = trashItems([save("c", 1, [gone("b-pin", "pins")]), save("b", 50, [gone("a-region")]), save("a", 80, [gone("too-old")])], NOW);
    expect(items.map((i) => [i.kind, i.id, i.parent])).toEqual([["pin", "b-pin", "c-parent"], ["region", "a-region", "b-parent"]]);
    expect(items[1].deletedBy).toBe("ann");
    expect(timeLeft(items[1].expires, NOW)).toBe("22 hours");
    expect(TRASH_DAYS).toBe(3);
  });

  it("leaves out anything saved again afterwards, moved by a rename, or that isn't a region or pin", () => {
    const entries = [
      save("d", 1, [{ path: "content/regions/back.json", status: "added" }]),
      save("c", 2, [gone("back")]),
      save("b", 3, [gone("old-name"), { path: "content/regions/old-name.json", status: "added" }]),
      save("a", 4, [gone("x", "maps"), { path: "content/slots.json", status: "removed" }]),
    ];
    expect(trashItems(entries, NOW)).toEqual([]);
  });

  it("only counts a file's latest save, and never a modification", () => {
    const entries = [save("c", 1, [{ path: "content/regions/r.json", status: "modified" }]), save("b", 2, [gone("r")])];
    expect(trashItems(entries, NOW)).toEqual([]);
  });

  it("asks the save log for the last 3 days and words the time left", () => {
    expect(trashSince(NOW)).toBe("2026-11-12T12:00:00Z");
    expect(timeLeft(ago(-50), NOW)).toBe("2 days 2 hours");
    expect(timeLeft(ago(-0.5), NOW)).toBe("under an hour");
    expect(timeLeft(ago(1), NOW)).toBe("expired");
  });
});
