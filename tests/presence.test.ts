import { describe, expect, it } from "vitest";
import { editingNote, joinNames, othersOn } from "../src/admin/editor/presence.ts";

const e = (id: number, login: string, regions: string[]) => ({ id, login, tab: "t", regions, at: "" });

describe("presence", () => {
  it("lists other people on the regions, not yourself", () => {
    const o = othersOn([e(1, "me", ["a"]), e(2, "ann", ["a", "b"]), e(3, "bo", ["a"]), e(2, "ann", ["a"])], ["a"], 1);
    expect(o.get("a")).toEqual(["ann", "bo"]);
    expect(o.has("b")).toBe(false);
  });
  it("words the notice", () => {
    expect(joinNames(["a"])).toBe("a");
    expect(joinNames(["a", "b", "c"])).toBe("a, b and c");
    expect(editingNote(new Map(), ["a"])).toBe("");
    expect(editingNote(new Map([["a", ["ann"]]]), ["a"])).toMatch(/^ann has this region open/);
    expect(editingNote(new Map([["a", ["ann"]], ["b", ["ann", "bo"]]]), ["a", "b"])).toMatch(/^ann and bo have one of these regions/);
  });
});
