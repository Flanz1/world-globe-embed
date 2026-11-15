import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadContent } from "../scripts/lib/content.ts";
import { generatePinFiles } from "../scripts/lib/pages.ts";
import { contentPaths } from "../scripts/lib/paths.ts";
import { checkChange, pathKind, type Actor, type Permission } from "../src/shared/access.ts";
import { checkPin, parsePinsFile, parsePinsParam, pinShown, pinsJson, safeLink, type PinFeature } from "../src/shared/pins.ts";
import { validatePin } from "../worker/src/generated/validators.js";

const ME = { id: 5002, login: "ann" };
const OTHER = { id: 5003, login: "bo" };
const pin = (id = "port-a", over: Partial<PinFeature["properties"]> = {}, at: [number, number] = [10, 20]): PinFeature => ({
  type: "Feature",
  id,
  properties: { slot: "inara", map: "terra", name: "Port A", kind: "port", createdBy: ME, updatedBy: ME, ...over },
  geometry: { type: "Point", coordinates: at },
});

describe("pin links and params", () => {
  it("only https links pass", () => {
    expect(safeLink("https://garmeley.com/Places/Aerthos")).toBe("https://garmeley.com/Places/Aerthos");
    for (const bad of ["http://x.com", "javascript:alert(1)", "data:text/html,x", "//x.com", "https://u:p@x.com/", "not a url", "", 5, null]) expect(safeLink(bad)).toBeNull();
  });
  it("?pins= means all, a list of kinds, or nothing", () => {
    expect(parsePinsParam("1")).toBe("all");
    expect(parsePinsParam("all")).toBe("all");
    expect(parsePinsParam("0")).toBeNull();
    expect(parsePinsParam(null)).toBeNull();
    expect(parsePinsParam("")).toBeNull();
    expect(parsePinsParam("nonsense")).toBeNull();
    const kinds = parsePinsParam("city, Battle,nonsense");
    expect(kinds).toEqual(new Set(["city", "battle"]));
    expect(pinShown(kinds!, { kind: "city" })).toBe(true);
    expect(pinShown(kinds!, { kind: "ruin" })).toBe(false);
  });
});

describe("pin files", () => {
  it("the embed file keeps what an embed needs and nothing about people", () => {
    const j = pinsJson([pin("b", { description: "d", link: "https://x.org/a", color: "#fff" }, [1.23456789, -2]), pin("a")]);
    const d = JSON.parse(j) as { pins: { id: string; at: number[] }[] };
    expect(d.pins.map((p) => p.id)).toEqual(["a", "b"]);
    expect(d.pins[1].at).toEqual([1.2346, -2]);
    expect(j).not.toMatch(/createdBy|updatedBy|ann/);
    expect(parsePinsFile(d)).toHaveLength(2);
  });
  it("fetched data is re-checked: bad entries are dropped, never trusted", () => {
    const parsed = parsePinsFile({
      pins: [
        { id: "ok", name: "Fine", kind: "city", at: [1, 2], link: "javascript:alert(1)", color: "red;background:url(x)" },
        { id: "Bad Id", name: "x", kind: "city", at: [1, 2] },
        { id: "kind", name: "x", kind: "dragon", at: [1, 2] },
        { id: "far", name: "x", kind: "city", at: [500, 2] },
        { id: "nan", name: "x", kind: "city", at: [null, 2] },
        { id: "ctl", name: "a\u0000b", kind: "city", at: [1, 2] },
        "nope",
      ],
    });
    expect(parsed).toEqual([{ id: "ok", name: "Fine", kind: "city", at: [1, 2] }]);
    expect(parsePinsFile({})).toBeNull();
    expect(parsePinsFile(null)).toBeNull();
  });
  it("the schema (also the Worker's validator) and checkPin agree on what is valid", () => {
    expect(validatePin(pin())).toBe(true);
    expect(validatePin(pin("a", { link: "javascript:alert(1)" }))).toBe(false);
    expect(validatePin(pin("a", { kind: "dragon" as never }))).toBe(false);
    expect(validatePin(pin("a", { name: "" }))).toBe(false);
    expect(validatePin(pin("a", {}, [181, 0]))).toBe(false);
    expect(validatePin({ ...pin(), extra: 1 })).toBe(false);
    expect(checkPin(pin("a", { name: "   " }))).toHaveLength(1);
    expect(checkPin(pin())).toEqual([]);
  });
});

describe("pins in content", () => {
  const LQIP = "data:image/webp;base64,UklGRg==";
  function project(pins: Record<string, unknown>) {
    const paths = contentPaths(mkdtempSync(path.join(tmpdir(), "wge-p-")));
    mkdirSync(paths.mapsDir, { recursive: true });
    mkdirSync(paths.pinsDir, { recursive: true });
    mkdirSync(path.join(paths.publicDir, "maps/terra"), { recursive: true });
    writeFileSync(path.join(paths.publicDir, "maps/terra/abcdef012345-1024.webp"), "x");
    writeFileSync(paths.slotsFile, JSON.stringify({ slots: { inara: { map: "terra" } } }));
    writeFileSync(path.join(paths.mapsDir, "terra.json"), JSON.stringify({ id: "terra", name: "t", uploadedBy: "t", date: "2026-01-01T00:00:00.000Z", aspect: 2, width: 2048, height: 1024, hash: "abcdef012345", sizes: { "1024": "maps/terra/abcdef012345-1024.webp" }, lqip: LQIP }));
    for (const [file, data] of Object.entries(pins)) writeFileSync(path.join(paths.pinsDir, file), typeof data === "string" ? data : JSON.stringify(data));
    return paths;
  }
  it("loads pins and bundles them per slot", () => {
    const r = loadContent(project({ "port-a.json": pin(), "b.json": pin("b", {}, [3, 4]) }));
    expect(r.errors).toEqual([]);
    expect(r.content?.pins?.size).toBe(2);
    const files = generatePinFiles(r.content!);
    expect(files.map((f) => f.path)).toEqual(["pins/inara.json"]);
    expect(JSON.parse(files[0].json).pins).toHaveLength(2);
  });
  it("rejects a pin on an unknown slot, a mismatched id, an http link and broken JSON", () => {
    const r = loadContent(project({ "a.json": pin("a", { slot: "inra" }), "b.json": pin("not-b"), "c.json": pin("c", { link: "http://x.org" }), "d.json": "{ nope" }));
    const text = r.errors.join("\n");
    expect(r.content).toBeNull();
    expect(text).toMatch(/content\/pins\/a\.json: slot "inra" doesn't exist.*Did you mean "inara"/);
    expect(text).toMatch(/content\/pins\/b\.json: "id" is "not-b"/);
    expect(text).toMatch(/content\/pins\/c\.json: .*link/);
    expect(text).toMatch(/content\/pins\/d\.json: is not valid JSON/);
  });
  it("a slot with no pins gets no file", () => {
    expect(generatePinFiles(loadContent(project({})).content!)).toEqual([]);
  });
});

describe("who may change pins", () => {
  const actor = (id: number, login: string, permissions: Permission[], owner = false): Actor => ({ id, login, owner, permissions: new Set(permissions) });
  const path = "content/pins/port-a.json";
  const text = (p: PinFeature) => JSON.stringify(p);
  const ann = actor(ME.id, ME.login, ["regions"]);
  const bo = actor(OTHER.id, OTHER.login, ["regions", "editOthers"]);
  const cy = actor(7, "cy", ["regions", "editOthers", "deleteOthers"]);
  const owner = actor(45669787, "Flanz1", [], true);

  it("is its own kind of file", () => {
    expect(pathKind(path)).toBe("pin");
    expect(pathKind("content/pins/Bad Name.json")).toBe("content");
  });
  it("anyone who can create regions places pins, as themselves", () => {
    expect(checkChange({ path, before: null, after: text(pin()) }, ann, 45669787)).toBeNull();
    expect(checkChange({ path, before: null, after: text(pin("port-a", { createdBy: OTHER })) }, ann, 45669787)).toMatch(/createdBy/);
    expect(checkChange({ path, before: null, after: text(pin("port-a", { updatedBy: OTHER })) }, ann, 45669787)).toMatch(/updatedBy/);
    expect(checkChange({ path, before: null, after: text(pin("port-a", { createdBy: { id: 9, login: "nobody" }, updatedBy: { id: 9, login: "nobody" } })) }, actor(9, "nobody", []), 45669787)).toMatch(/permission/);
  });
  it("only the placer (or editors) change a pin; only the placer (or deleters) delete it", () => {
    const mine = pin();
    expect(checkChange({ path, before: text(mine), after: text({ ...mine, properties: { ...mine.properties, name: "New" } }) }, ann, 45669787)).toBeNull();
    const theirs = pin("port-a", { createdBy: OTHER, updatedBy: OTHER });
    const edited = { ...theirs, properties: { ...theirs.properties, name: "New", updatedBy: ME } };
    expect(checkChange({ path, before: text(theirs), after: text(edited) }, ann, 45669787)).toMatch(/someone else/);
    expect(checkChange({ path, before: text(mine), after: null }, ann, 45669787)).toBeNull();
    expect(checkChange({ path, before: text(theirs), after: null }, ann, 45669787)).toMatch(/someone else/);
    expect(checkChange({ path, before: text(mine), after: text({ ...mine, properties: { ...mine.properties, updatedBy: OTHER, name: "x" } }) }, bo, 45669787)).toBeNull();
    expect(checkChange({ path, before: text(mine), after: null }, bo, 45669787)).toMatch(/someone else/);
    expect(checkChange({ path, before: text(mine), after: null }, cy, 45669787)).toBeNull();
    expect(checkChange({ path, before: text(mine), after: null }, owner, 45669787)).toBeNull();
  });
  it("who placed a pin can't be rewritten by an editor", () => {
    const mine = pin();
    const stolen = { ...mine, properties: { ...mine.properties, createdBy: OTHER, updatedBy: OTHER } };
    expect(checkChange({ path, before: text(mine), after: text(stolen) }, bo, 45669787)).toMatch(/Only the repository owner/);
  });
  it("the file must be the pin it names", () => {
    expect(checkChange({ path, before: null, after: text(pin("other")) }, ann, 45669787)).toMatch(/must have the id/);
    expect(checkChange({ path, before: null, after: "{ nope" }, ann, 45669787)).toMatch(/valid JSON/);
  });
});
