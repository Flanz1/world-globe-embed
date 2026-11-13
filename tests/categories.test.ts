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
  childrenOf,
  depthOf,
  moveCategory,
  moveTargets,
  pathName,
  withDescendants,
  MAX_DEPTH,
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
    expect(diffCategories(start, next)).toEqual({ added: [], removed: [], renamed: ["seas"], reordered: true, moved: ["a"], reparented: [] });
    expect(diffCategories(null, start)).toMatchObject({ added: ["kingdoms", "seas"], moved: ["a", "b", "c"] });
    expect(diffCategories(start, removeCategory(start, "seas"))).toMatchObject({ removed: ["seas"], moved: ["c"], reordered: false });
  });

  it("reports problems with a file", () => {
    expect(checkCategories(start)).toEqual([]);
    expect(checkCategories({ categories: [start.categories[0], start.categories[0]] }).join()).toMatch(/used twice/);
    expect(checkCategories({ categories: [{ id: "x", name: "A", regions: ["r"] }, { id: "y", name: "a", regions: [] }] }).join()).toMatch(/two folders called/);
    expect(checkCategories({ categories: [{ id: "x", name: "A", regions: ["r"] }, { id: "y", name: "B", regions: ["r"] }] }).join()).toMatch(/in two categories/);
    expect(checkCategories({ categories: [{ id: "X!", name: "", regions: [] }] })).toHaveLength(2);
    expect(checkCategories(null)).toHaveLength(1);
  });

  it("checks names", () => {
    expect(nameProblem(start, " ")).toMatch(/Give the folder a name/);
    expect(nameProblem(start, "x".repeat(61))).toMatch(/60 characters/);
    expect(nameProblem(start, "seas")).toMatch(/already a folder/);
    expect(nameProblem(start, "seas", "seas")).toBeNull(); // renaming to its own name (or just its case) is fine
    expect(nameProblem(start, "Rivers")).toBeNull();
  });

  it("writes the file with its schema pointer", () => {
    expect(serializeCategories(start)).toMatch(/^\{\n {2}"\$schema": "\.\.\/schema\/categories\.schema\.json"/);
  });

  describe("nesting", () => {
    const nested: CategoriesFile = {
      categories: [
        { id: "kingdoms", name: "Kingdoms", regions: ["a"] },
        { id: "cities", name: "Cities", regions: ["b"], parent: "kingdoms" },
        { id: "ports", name: "Ports", regions: [], parent: "cities" },
        { id: "seas", name: "Seas", regions: ["c"] },
      ],
    };

    it("reads the tree", () => {
      expect(childrenOf(nested, null).map((k) => k.id)).toEqual(["kingdoms", "seas"]);
      expect(childrenOf(nested, "kingdoms").map((k) => k.id)).toEqual(["cities"]);
      expect(depthOf(nested, "ports")).toBe(2);
      expect([...withDescendants(nested, "kingdoms")].sort()).toEqual(["cities", "kingdoms", "ports"]);
      expect(pathName(nested, "ports")).toBe("Kingdoms › Cities › Ports");
      expect(checkCategories(nested)).toEqual([]);
    });

    it("adds a subfolder and lets siblings in different folders share a name", () => {
      const { file, id } = addCategory(nested, "Cities", ME, "2026-11-13T10:00:00Z", "seas");
      expect(file.categories.find((k) => k.id === id)).toMatchObject({ name: "Cities", parent: "seas" });
      expect(nameProblem(nested, "Cities", undefined, "seas")).toBeNull();
      expect(nameProblem(nested, "cities", undefined, "kingdoms")).toMatch(/already a folder/);
      expect(checkCategories(file)).toEqual([]);
    });

    it("moves a folder with what's in it, and refuses loops and going too deep", () => {
      const moved = moveCategory(nested, "cities", "seas");
      expect(childrenOf(moved, "seas").map((k) => k.id)).toEqual(["cities"]);
      expect(pathName(moved, "ports")).toBe("Seas › Cities › Ports");
      expect(moveCategory(moved, "cities", null).categories.find((k) => k.id === "cities")!.parent).toBeUndefined();
      expect(moveCategory(nested, "kingdoms", "ports")).toEqual(nested); // into its own descendant
      expect(moveCategory(nested, "kingdoms", "kingdoms")).toEqual(nested);
      expect(moveTargets(nested, "kingdoms").map((k) => k.id)).toEqual(["seas"]);
      let deep = nested;
      for (let i = 0; i < MAX_DEPTH + 2; i++) {
        const parent = deep.categories[deep.categories.length - 1].id;
        deep = addCategory(deep, `Deep ${i}`, ME, "2026-11-13T10:00:00Z", parent).file;
      }
      expect(checkCategories(deep).join()).toMatch(/levels deep/);
    });

    it("deleting a folder moves the ones inside it up a level", () => {
      const gone = removeCategory(nested, "cities");
      expect(gone.categories.find((k) => k.id === "ports")!.parent).toBe("kingdoms");
      expect(removeCategory(nested, "kingdoms").categories.find((k) => k.id === "cities")!.parent).toBeUndefined();
    });

    it("↑ and ↓ move a folder among its siblings only", () => {
      expect(childrenOf(shiftCategory(nested, "seas", -1), null).map((k) => k.id)).toEqual(["seas", "kingdoms"]);
      expect(shiftCategory(nested, "cities", 1)).toEqual(nested); // the only one in Kingdoms
    });

    it("reports a changed parent", () => {
      expect(diffCategories(nested, moveCategory(nested, "cities", null))).toMatchObject({ reparented: ["cities"], added: [], removed: [] });
    });

    it("rejects a parent that doesn't exist or loops", () => {
      expect(checkCategories({ categories: [{ id: "x", name: "X", regions: [], parent: "nope" }] }).join()).toMatch(/parent must be/);
      expect(checkCategories({ categories: [{ id: "x", name: "X", regions: [], parent: "y" }, { id: "y", name: "Y", regions: [], parent: "x" }] }).join()).toMatch(/inside itself/);
    });
  });
});
