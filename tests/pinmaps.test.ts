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
  it("are saved per slot, validated, and reach the embed's pins file without touching kinds", async () => {
    const { setLegend } = await import("../src/shared/pinmaps.ts");
    const { kindLabel, legendTitle, parsePinsFile, pinsJson } = await import("../src/shared/pins.ts");
    let f = setLegend(emptyPinMaps(), "inara", { title: "Places", kinds: { temple: "Holy site" } });
    expect(checkPinMaps(f)).toEqual([]);
    expect(validatePinMaps(JSON.parse(serializePinMaps(f)))).toBe(true);
    const parsed = parsePinsFile(JSON.parse(pinsJson([], [], f.legends!.inara)))!;
    expect(legendTitle(parsed.legend)).toBe("Places");
    expect(kindLabel("temple", parsed.legend)).toBe("Holy site");
    expect(kindLabel("city", parsed.legend)).toBe("City");
    expect(legendTitle(undefined)).toBe("Pins");
    f = setLegend(f, "inara", {});
    expect(f.legends).toBeUndefined();
    expect(serializePinMaps(f)).not.toContain("legends");
    expect(checkPinMaps({ folders: [], maps: [], legends: { inara: { kinds: { nope: "x" } } } }).length).toBeGreaterThan(0);
    expect(validatePinMaps({ folders: [], maps: [], legends: { inara: { kinds: { nope: "x" } } } })).toBe(false);
  });
});
