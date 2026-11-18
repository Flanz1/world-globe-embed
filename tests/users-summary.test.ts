import { describe, expect, it } from "vitest";
import { summaryOf } from "../src/shared/access.ts";

describe("summaryOf (the one line under a person's role)", () => {
  it("names what the role can do, in a fixed order", () => {
    expect(summaryOf(["regions"])).toBe("Create regions");
    expect(summaryOf(["editOthers", "regions"])).toBe("Create regions, edit others'");
    expect(summaryOf(["users", "maps"])).toBe("Maps & slots, manage users");
  });
  it("says so when there is nothing or everything", () => {
    expect(summaryOf([])).toBe("No permissions");
    expect(summaryOf(["maps", "regions", "editOthers", "deleteOthers", "renameIds", "users"])).toBe("Everything");
  });
});
