import { describe, expect, it } from "vitest";
import {
  addCategory,
  assignRegions,
  categoryOf,
  checkCategories,
  diffCategories,
  nameProblem,
  newCategoryId,
  placements,
  pruneRegions,
  removeCategory,
  renameCategory,
  serializeCategories,
  shiftCategory,
  type CategoriesFile,
} from "../src/shared/categories.ts";

const ME = { id: 1, login: "me" };
const start: CategoriesFile = { categories: [{ id: "kingdoms", name: "Kingdoms", regions: ["a", "b"] }, { id: "seas", name: "Seas", regions: ["c"] }] };

describe("categories", () => {
  it("makes ids from names and keeps them unique", () => {
    expect(newCategoryId("Free Cities & Leagues", new Set())).toBe("free-cities-leagues");
    expect(newCategoryId("Zürich", new Set())).toBe("zurich");
    expect(newCategoryId("Seas", new Set(["seas", "seas-2"]))).toBe("seas-3");
    expect(newCategoryId("???", new Set())).toBe("category");
  });

  it("adds, renames, reorders and deletes", () => {
    const { file, id } = addCategory(start, "  Free   Cities ", ME, "2026-11-12T10:00:00Z");
    expect(id).toBe("free-cities");
    expect(file.categories[2]).toEqual({ id, name: "Free Cities", regions: [], createdBy: ME, created: "2026-11-12T10:00:00Z" });
    expect(renameCategory(file, "seas", "Oceans").categories[1].name).toBe("Oceans");
    expect(shiftCategory(file, "seas", -1).categories.map((k) => k.id)).toEqual(["seas", "kingdoms", "free-cities"]);
    expect(shiftCategory(file, "kingdoms", -1)).toEqual(file); // already first
    expect(removeCategory(start, "kingdoms").categories.map((k) => k.id)).toEqual(["seas"]);
    expect(start.categories).toHaveLength(2); // the original is untouched
  });

  it("puts a region in one category at a time", () => {
    const moved = assignRegions(start, ["a", "z"], "seas");
    expect(moved.categories[0].regions).toEqual(["b"]);
    expect(moved.categories[1].regions).toEqual(["a", "c", "z"]);
    expect(categoryOf(moved, "a")).toBe("seas");
    expect(categoryOf(assignRegions(start, ["a"], null), "a")).toBeNull();
    expect([...placements(start)]).toEqual([["a", "kingdoms"], ["b", "kingdoms"], ["c", "seas"]]);
  });

  it("tidies away regions that no longer exist", () => {
    expect(pruneRegions(start, new Set(["a", "c"])).categories.map((k) => k.regions)).toEqual([["a"], ["c"]]);
  });

  it("describes a change", () => {
    const next = assignRegions(renameCategory(shiftCategory(start, "seas", -1), "seas", "Oceans"), ["a"], "seas");
    expect(diffCategories(start, next)).toEqual({ added: [], removed: [], renamed: ["seas"], reordered: true, moved: ["a"] });
    expect(diffCategories(null, start)).toMatchObject({ added: ["kingdoms", "seas"], moved: ["a", "b", "c"] });
    expect(diffCategories(start, removeCategory(start, "seas"))).toMatchObject({ removed: ["seas"], moved: ["c"], reordered: false });
  });

  it("reports problems with a file", () => {
    expect(checkCategories(start)).toEqual([]);
    expect(checkCategories({ categories: [start.categories[0], start.categories[0]] }).join()).toMatch(/used twice/);
    expect(checkCategories({ categories: [{ id: "x", name: "A", regions: ["r"] }, { id: "y", name: "a", regions: [] }] }).join()).toMatch(/two categories called/);
    expect(checkCategories({ categories: [{ id: "x", name: "A", regions: ["r"] }, { id: "y", name: "B", regions: ["r"] }] }).join()).toMatch(/in two categories/);
    expect(checkCategories({ categories: [{ id: "X!", name: "", regions: [] }] })).toHaveLength(2);
    expect(checkCategories(null)).toHaveLength(1);
  });

  it("checks names", () => {
    expect(nameProblem(start, " ")).toMatch(/Give the category a name/);
    expect(nameProblem(start, "x".repeat(61))).toMatch(/60 characters/);
    expect(nameProblem(start, "seas")).toMatch(/already a category/);
    expect(nameProblem(start, "seas", "seas")).toBeNull(); // renaming to its own name (or just its case) is fine
    expect(nameProblem(start, "Rivers")).toBeNull();
  });

  it("writes the file with its schema pointer", () => {
    expect(serializeCategories(start)).toMatch(/^\{\n {2}"\$schema": "\.\.\/schema\/categories\.schema\.json"/);
  });
});
