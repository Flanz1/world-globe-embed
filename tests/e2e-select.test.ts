import { describe, expect, it } from "vitest";
import { select, ALL } from "../scripts/e2e/select.mjs";

describe("e2e suite selection", () => {
  it("runs nothing for docs, tests and content", () => {
    expect(select(["README.md", "docs/x.md", "tests/a.test.ts", "content/regions/a.json"])).toEqual([]);
  });
  it("a Regions tab / categories change runs only the admin-page suites", () => {
    expect(select(["src/admin/regions.ts", "src/admin/categories.ts", "src/shared/categories.ts", "src/admin/admin.css", "admin/index.html", "schema/categories.schema.json", "worker/src/handler.ts", "scripts/lib/content.ts"])).toEqual(["regions", "roles"]);
  });
  it("an editor change runs the editor suites", () => {
    const s = select(["src/admin/editor/snap.ts"]);
    for (const x of ["cut", "merge", "locks", "coast", "ring-select", "snap", "layers"]) expect(s).toContain(x);
    expect(s).not.toContain("tiles");
    expect(s).not.toContain("upload");
  });
  it("a viewer change runs the viewer and embed suites, not the roles or editor-only ones", () => {
    const s = select(["src/viewer/flat.ts"]);
    expect(s).toContain("view");
    expect(s).not.toContain("roles");
    expect(s).not.toContain("cut");
  });
  it("a suite's own file selects just that suite; shared harness files select all", () => {
    expect(select(["scripts/e2e/locks.mjs"])).toEqual(["locks"]);
    expect(select(["scripts/e2e/fixture.mjs"])).toEqual(ALL);
    expect(select(["scripts/e2e/select.mjs", "tests/e2e-select.test.ts"])).toEqual([]);
  });
});
