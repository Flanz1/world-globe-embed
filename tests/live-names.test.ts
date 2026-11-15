import { describe, expect, it } from "vitest";
import { combineRegions } from "../src/shared/combine.ts";
import { applyLinkedNames, linkedNamesOf, liveState, revertLinkedNames, splitLive, type LiveSource } from "../src/admin/editor/live.ts";
import { stateOf } from "../src/admin/editor/model.ts";
import type { RegionFeature } from "../src/shared/region.ts";

const sq = (x: number): [number, number][][] => [[[x, 0], [x + 2, 0], [x + 2, 2], [x, 2], [x, 0]]];
const region = (id: string, props: Partial<RegionFeature["properties"]>, polys: [number, number][][][]): RegionFeature => ({
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id,
  properties: { slot: "inara", map: "terra", color: "#c0392b", ...props },
  geometry: polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys },
});

const x = region("x", { colorLabel: "Realm", legendTitle: "Realms", legend: [{ label: "Elves", color: "#00ff00" }], partLegend: [0], partLabels: ["X"] }, [sq(0)]);
const y = region("y", { name: "Why", color: "#2e86c1", partLabels: ["Y"] }, [sq(10)]);
const sources: LiveSource[] = [x, y].map((f) => ({ id: f.id, state: stateOf(f), name: f.properties.name }));

describe("a linked region's own legend names in the editor state", () => {
  it("renames in the editor become names of the linked region, not of its sources", () => {
    const s = liveState(sources);
    expect(linkedNamesOf(s, sources)).toBeUndefined();
    const edited = JSON.parse(JSON.stringify(s)) as typeof s;
    edited.props.legend.find((e) => e.srcIdx === 0)!.label = "Wood folk";
    edited.props.legend.find((e) => e.own)!.label = "Sea people";
    edited.props.colorLabel = "Main";
    edited.props.legendTitle = "Peoples";
    const names = linkedNamesOf(edited, sources)!;
    expect(names).toEqual({
      legendTitle: "Peoples",
      colorLabel: "Main",
      legend: [
        { color: "#00ff00", from: "Elves", label: "Wood folk" },
        { color: "#2e86c1", from: "Why", label: "Sea people" },
      ],
    });
    // Saving splits back to the sources with their own names.
    const split = splitLive(revertLinkedNames(edited, sources), sources);
    expect(split[0].state.props.legend[0].label).toBe("Elves");
    expect(split[0].state.props.colorLabel).toBe("Realm");
    expect(split[0].state.props.legendTitle).toBe("Realms");
    expect(split[1].state.props.colorLabel).toBe("");
    // Reopening applies them again; the combined region shows them.
    expect(applyLinkedNames(liveState(sources), sources, names).props.legend.map((e) => e.label)).toEqual(["Wood folk", "Sea people"]);
    const combined = combineRegions([x, y], { id: "xy", base: { slot: "inara", map: "terra" } }, 1, names).feature!.properties;
    expect(combined.legend!.map((e) => e.label)).toEqual(["Wood folk", "Sea people"]);
    expect(combined.colorLabel).toBe("Main");
  });
});
