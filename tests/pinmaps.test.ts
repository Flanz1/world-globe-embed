import { describe, expect, it } from "vitest";
import { checkChange, pathKind, type Actor, type Permission } from "../src/shared/access.ts";
import {
  PINMAPS_PATH,
  addFolder,
  addPinMap,
  checkPinMaps,
  emptyPinMaps,
  folderOf,
  mapsOfSlot,
  movePinMap,
  moveFolder,
  removeFolder,
  removePinMap,
  renamePinMap,
  serializePinMaps,
  type PinMapsFile,
} from "../src/shared/pinmaps.ts";
import { validatePinMaps, validateRegion } from "../worker/src/generated/validators.js";

describe("pin maps and folders", () => {
  const build = (): PinMapsFile => {
    let f = emptyPinMaps();
    f = addFolder(f, "Religion").file;
    f = addFolder(f, "Temples", "religion").file;
    f = addPinMap(f, "Holy sites", "inara", "temples").file;
    f = addPinMap(f, "Battles", "inara").file;
    return f;
  };
  it("pin maps get ids from their names and sit in nested folders", () => {
    const f = build();
    expect(f.maps.map((m) => m.id)).toEqual(["holy-sites", "battles"]);
    expect(folderOf(f, "holy-sites")).toBe("temples");
    expect(folderOf(f, "battles")).toBeNull();
    expect(f.folders.find((k) => k.id === "temples")?.parent).toBe("religion");
    expect(checkPinMaps(f)).toEqual([]);
    expect(validatePinMaps(JSON.parse(serializePinMaps(f)))).toBe(true);
  });
  it("moving, renaming and deleting keep the file consistent", () => {
    let f = movePinMap(build(), "battles", "religion");
    expect(folderOf(f, "battles")).toBe("religion");
    f = renamePinMap(f, "battles", "Great battles");
    expect(f.maps.find((m) => m.id === "battles")?.name).toBe("Great battles");
    f = removePinMap(f, "holy-sites");
    expect(f.maps.map((m) => m.id)).toEqual(["battles"]);
    expect(checkPinMaps(f)).toEqual([]);
    f = removeFolder(f, "religion");
    expect(f.folders.map((k) => k.id)).toEqual(["temples"]);
    expect(f.folders[0].parent).toBeUndefined();
    expect(folderOf(f, "battles")).toBeNull();
    expect(moveFolder(f, "temples", null).folders).toHaveLength(1);
  });
  it("the checks catch duplicates, a folder naming a missing pin map, and bad slots", () => {
    const f = build();
    expect(checkPinMaps({ ...f, maps: [...f.maps, { id: "battles", name: "Other", slot: "inara" }] }).length).toBeGreaterThan(0);
    expect(checkPinMaps({ ...f, maps: [...f.maps, { id: "x", name: "battles", slot: "inara" }] }).length).toBeGreaterThan(0);
    expect(checkPinMaps({ ...f, maps: [...f.maps, { id: "x", name: "battles", slot: "other" }] })).toEqual([]);
    expect(checkPinMaps({ ...f, maps: f.maps.slice(1) }).some((e) => /doesn't exist/.test(e))).toBe(true);
    expect(checkPinMaps({ folders: [], maps: [{ id: "A B", name: "x", slot: "inara" }] }).length).toBe(1);
    expect(checkPinMaps({ nope: 1 }).length).toBe(1);
    expect(mapsOfSlot(f, "inara")).toHaveLength(2);
    expect(mapsOfSlot(f, "elsewhere")).toHaveLength(0);
  });
  it("the file is ownerless: whoever may create regions may change it, nobody else", () => {
    const actor = (permissions: Permission[]): Actor => ({ id: 5002, login: "ann", owner: false, permissions: new Set(permissions) });
    const text = serializePinMaps(build());
    expect(pathKind(PINMAPS_PATH)).toBe("pinmaps");
    const d = { path: PINMAPS_PATH, before: null, after: text };
    expect(checkChange(d, actor(["regions"]), 1)).toBeNull();
    expect(checkChange(d, actor([]), 1)).toMatch(/permission/);
    expect(checkChange({ ...d, after: "{" }, actor(["regions"]), 1)).toMatch(/valid JSON/);
    expect(checkChange({ ...d, after: JSON.stringify({ folders: [], maps: [{ id: "a", name: "A", slot: "s" }, { id: "a", name: "B", slot: "s" }] }) }, actor(["regions"]), 1)).toMatch(/pinmaps\.json/);
    expect(checkChange({ path: PINMAPS_PATH, before: text, after: null }, actor(["regions"]), 1)).toBeNull();
  });
  it("a region can include pin maps (schema)", () => {
    const base = JSON.parse(JSON.stringify({ type: "Feature", id: "r", properties: { slot: "inara", map: "m", name: "R", color: "#ff0000", fillOpacity: 0.4, label: true, createdBy: { id: 1, login: "a" }, updatedBy: { id: 1, login: "a" } }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }));
    base.properties.pinMaps = ["holy-sites"];
    expect(validateRegion(base)).toBe(true);
    base.properties.pinMaps = ["Bad Id"];
    expect(validateRegion(base)).toBe(false);
  });
});

describe("pin legend words", () => {
  it("are cleaned, validated by the region schema and resolved per kind across pin maps", async () => {
    const { cleanLegends, kindLabel, legendTitle, resolveLegend } = await import("../src/shared/pins.ts");
    const legends = cleanLegends({ "holy-sites": { title: "Places", kinds: { temple: "Holy site", nope: "x" } }, battles: { kinds: { temple: "Shrine", battle: "Clash" } }, "BAD ID": { title: "x" } })!;
    expect(Object.keys(legends)).toEqual(["holy-sites", "battles"]);
    expect(legends["holy-sites"].kinds).toEqual({ temple: "Holy site" });
    const pins = [{ kind: "temple" as const, pinMap: "battles" }, { kind: "battle" as const, pinMap: "battles" }, { kind: "city" as const, pinMap: "holy-sites" }];
    // order decides: battles first, so its temple label wins when it has temples; holy-sites has none shown
    const r = resolveLegend(pins, legends, ["battles", "holy-sites"])!;
    expect(legendTitle(r)).toBe("Places");
    expect(kindLabel("temple", r)).toBe("Shrine");
    expect(kindLabel("battle", r)).toBe("Clash");
    expect(kindLabel("city", r)).toBe("City");
    expect(legendTitle(undefined)).toBe("Pins");
    expect(resolveLegend([{ kind: "city" }], legends, [])).toBeUndefined();
    const base = { type: "Feature", id: "x", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
    const ok = { ...base, properties: { slot: "inara", map: "m", name: "X", color: "#ff0000", pinMaps: ["holy-sites"], pinLegends: { "holy-sites": { title: "Places" } } } };
    expect(validateRegion(ok)).toBe(true);
    const bad = { ...base, properties: { ...ok.properties, pinLegends: { "holy-sites": { kinds: { nope: "x" } } } } };
    expect(validateRegion(bad)).toBe(false);
  });
});
