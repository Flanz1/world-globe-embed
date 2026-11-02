import { describe, expect, it } from "vitest";
import { excessScopes } from "../src/admin/github.ts";

describe("admin token scope check", () => {
  it("accepts public_repo alone, harmless read scopes, and fine-grained tokens (no header)", () => {
    expect(excessScopes("public_repo")).toEqual([]);
    expect(excessScopes("public_repo, read:user")).toEqual([]);
    expect(excessScopes(null)).toEqual([]);
    expect(excessScopes("")).toEqual([]);
  });

  it("flags anything broader", () => {
    expect(excessScopes("repo, workflow")).toEqual(["repo", "workflow"]);
    expect(excessScopes("public_repo, delete_repo, admin:org")).toEqual(["delete_repo", "admin:org"]);
  });
});
