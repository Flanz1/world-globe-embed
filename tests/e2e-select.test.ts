import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { select, ALL, GROUPS, QUARANTINED, readSuites } from "../scripts/e2e/select.mjs";

const E2E = path.resolve(import.meta.dirname, "../scripts/e2e");

describe("e2e suite selection", () => {
  it("runs nothing for docs, tests and content", () => {
    expect(select(["README.md", "docs/x.md", "tests/a.test.ts", "content/regions/a.json"])).toEqual([]);
  });
  it("a Regions tab / categories change runs only the admin-page suites", () => {
    expect(select(["src/admin/regions.ts", "src/admin/categories.ts", "src/shared/categories.ts", "src/admin/admin.css", "admin/index.html", "schema/categories.schema.json", "worker/src/handler.ts", "scripts/lib/content.ts"])).toEqual(ALL.filter((x) => ["regions", "comments", "rename", "roles", "theme", "live", "live-many", "trash", "health", "bulk", "warp"].includes(x)));
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

describe("e2e suite registry (the header line of each scripts/e2e/<name>.mjs)", () => {
  it("finds the suites, slowest first", () => {
    for (const s of ["layers", "regions", "roles", "view", "recovery"]) expect(ALL).toContain(s);
    const w = readSuites().map((s) => s.weight);
    expect(w).toEqual([...w].sort((a, b) => b - a));
  });
  it("every root a suite names exists", () => {
    for (const s of readSuites()) {
      expect(s.roots.length, `${s.name} names no roots`).toBeGreaterThan(0);
      for (const r of s.roots) expect(existsSync(path.resolve(E2E, "../..", r)), `${s.name}: ${r}`).toBe(true);
    }
  });
  it("header tokens are group names or paths", () => {
    for (const file of readdirSync(E2E).filter((f) => f.endsWith(".mjs"))) {
      const h = /^\/\/ e2e-suite: roots=(\S+)/.exec(readFileSync(path.join(E2E, file), "utf8"));
      if (h) for (const t of h[1].split(",")) expect(t in GROUPS || t.includes("/"), `${file}: unknown group ${t}`).toBe(true);
    }
  });
  it("a browser check without a header is marked as a hand-run tool, not forgotten", () => {
    for (const file of readdirSync(E2E).filter((f) => f.endsWith(".mjs") && f !== "fixture.mjs")) {
      const src = readFileSync(path.join(E2E, file), "utf8");
      if (!/makeFixture\(/.test(src)) continue;
      expect(/^\/\/ e2e-(suite|tool):/.test(src), `${file}: add a "// e2e-suite: roots=..." first line (or "// e2e-tool:" if it is run by hand)`).toBe(true);
    }
  });
  it("quarantined suites name their issue and are never selected", () => {
    for (const [name, issue] of Object.entries(QUARANTINED)) {
      expect(issue, `${name}: quarantine= must be an issue number`).toMatch(/^\d+$/);
      expect(ALL).not.toContain(name);
      expect(select(["scripts/e2e/fixture.mjs"])).not.toContain(name);
    }
  });
});
