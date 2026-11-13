import { describe, expect, it } from "vitest";
import { OWN_COLOUR, type RegionFeature } from "../src/shared/region.ts";
import { addPart, cutParts, OCCUPIED, reorderPart, stateOf, toStyledGeometry, type EditorState } from "../src/admin/editor/model.ts";
import { combineParts } from "../src/admin/editor/merge.ts";
import { liveState, ownEntry, previewLegend, removeLiveEntry, splitLive, type LiveSource } from "../src/admin/editor/live.ts";

const box = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]] as [number, number][];

function region(id: string, color: string, polys: [number, number][][], extra: Partial<RegionFeature["properties"]> = {}): RegionFeature {
  return {
    type: "Feature",
    id,
    properties: { slot: "world", map: "m", color, fillOpacity: 0.4, label: true, ...extra },
    geometry: polys.length === 1 ? { type: "Polygon", coordinates: [polys[0]] } : { type: "MultiPolygon", coordinates: polys.map((r) => [r]) },
  } as RegionFeature;
}

const a = region("alpha", "#ff0000", [box(0, 0, 10, 10), box(20, 0, 30, 10)], {
  legend: [{ label: "Hills", color: "#00ff00" }],
  partLegend: [OWN_COLOUR, 0],
  partLabels: ["A1", "A2"],
  description: "first",
  provinceBorders: [
    [
      [1, 1],
      [5, 5],
    ],
  ],
});
const b = region("beta", "#0000ff", [box(40, 0, 50, 10)], { colorLabel: "Beta land", partLabels: ["B1"], partLocked: [false], fillOpacity: 0.7 });
const c = region("gamma", "#ff0000", [box(60, 0, 70, 10)], { legend: [{ label: "Hills", color: "#00ff00" }], partLegend: [0] });

const src = (...fs: RegionFeature[]): LiveSource[] => fs.map((f) => ({ id: f.id, state: stateOf(f) }));
const split = (s: EditorState, sources: LiveSource[]) => Object.fromEntries(splitLive(s, sources).map((x) => [x.id, x]));

describe("liveState", () => {
  it("puts every region's parts in one state, each part tagged with its region", () => {
    const s = liveState(src(a, b, c));
    expect(s.parts).toHaveLength(4);
    expect(s.owners).toEqual(["alpha", "alpha", "beta", "gamma"]);
    expect(s.labels).toEqual(["A1", "A2", "B1", ""]);
    expect(s.locked).toEqual([true, true, false, true]);
    // alpha's own colour is the editor's own colour; beta's and gamma's own colours are tagged entries.
    expect(s.props.color).toBe("#ff0000");
    expect(s.styles[0]).toBe(OWN_COLOUR);
    expect(s.props.legend[s.styles[1]]).toMatchObject({ label: "Hills", src: "alpha", srcIdx: 0 });
    expect(s.props.legend[s.styles[2]]).toMatchObject({ label: "Beta land", color: "#0000ff", src: "beta", own: true });
    expect(s.props.legend[s.styles[3]]).toMatchObject({ label: "Hills", src: "gamma", srcIdx: 0 });
    expect(s.lines).toEqual([]);
  });
});

describe("splitLive", () => {
  it("gives back each region unchanged when nothing was edited", () => {
    const sources = src(a, b, c);
    const out = split(liveState(sources), sources);
    for (const x of sources) {
      const { owners, ...rest } = out[x.id].state;
      expect(owners).toBeUndefined();
      expect(rest).toEqual(x.state);
      expect(out[x.id].problem).toBeNull();
    }
  });

  it("keeps region-wide settings and province borders, and writes colour edits back where they came from", () => {
    const sources = src(a, b);
    const s = liveState(sources);
    s.props.color = "#111111";
    const hills = s.styles[1];
    s.props.legend[hills] = { ...s.props.legend[hills], label: "High hills" };
    const bOwn = ownEntry(s, "beta");
    s.props.legend[bOwn] = { ...s.props.legend[bOwn], color: "#222222" };
    const out = split(s, sources);
    expect(out.alpha.state.props).toMatchObject({ color: "#111111", description: "first", legend: [{ label: "High hills", color: "#00ff00" }] });
    expect(out.alpha.state.lines).toHaveLength(1);
    expect(out.beta.state.props).toMatchObject({ color: "#222222", colorLabel: "Beta land", fillOpacity: 0.7, legend: [] });
  });

  it("moves a part to another region, borrowing its colour into that region's legend", () => {
    const sources = src(a, b);
    const s = liveState(sources);
    s.owners![1] = "beta"; // alpha's "Hills" part goes to beta
    const out = split(s, sources);
    expect(out.alpha.state.parts).toHaveLength(1);
    expect(out.alpha.state.props.legend).toEqual([{ label: "Hills", color: "#00ff00" }]); // kept though unused
    expect(out.beta.state.parts).toHaveLength(2);
    expect(out.beta.state.labels).toEqual(["A2", "B1"]);
    expect(out.beta.state.props.legend).toEqual([{ label: "Hills", color: "#00ff00" }]);
    expect(out.beta.state.styles).toEqual([0, OWN_COLOUR]);
  });

  it("a part in the first region's own colour moved to another region keeps that colour", () => {
    const sources = src(a, b);
    const s = liveState(sources);
    s.owners![0] = "beta";
    const out = split(s, sources);
    expect(out.beta.state.props.legend).toEqual([{ label: "alpha", color: "#ff0000" }]);
    // gamma has the same own colour as alpha: no entry needed
    const s2 = liveState(src(a, c));
    s2.owners![0] = "gamma";
    expect(split(s2, src(a, c)).gamma.state.styles[0]).toBe(OWN_COLOUR);
  });

  it("keeps contested (occupied) areas through liveState and the save split", () => {
    const occ = region("delta", "#00aa00", [box(0, 20, 10, 30), box(5, 25, 8, 28)], { partOccupied: [false, true] });
    const legacy = region("epsilon", "#aa00aa", [box(20, 20, 30, 30), box(22, 22, 25, 25)], { partContested: [-1, 0] });
    const sources = src(b, occ, legacy);
    const s = liveState(sources);
    expect(s.contested).toEqual([-1, -1, OCCUPIED, -1, OCCUPIED]);
    const out = split(s, sources);
    expect(out.delta.state.contested).toEqual([-1, OCCUPIED]);
    expect(out.epsilon.state.contested).toEqual([-1, OCCUPIED]);
    expect(out.beta.state.contested).toEqual([-1]);
    // What a save writes for each region.
    const st = out.delta.state;
    expect(toStyledGeometry(st.parts, st.styles, st.labels, st.contested, st.locked, st.labelHidden).partOccupied).toEqual([false, true]);
  });
  it("refuses a region left with no parts", () => {
    const sources = src(a, b);
    const s = liveState(sources);
    s.owners![2] = "alpha";
    expect(split(s, sources).beta.problem).toMatch(/no parts left/);
  });

  it("follows parts through add, cut, reorder and combine", () => {
    const sources = src(a, b);
    let s = liveState(sources);
    s = { ...s, parts: addPart(s.parts, box(80, 0, 90, 10).slice(0, 4)), styles: [...s.styles, OWN_COLOUR], labels: [...s.labels, "new"], labelHidden: [...s.labelHidden, false], contested: [...s.contested, -1], locked: [...s.locked, true], owners: [...s.owners!, "beta"] };
    s = reorderPart(s, 3, 0);
    expect(s.owners).toEqual(["beta", "alpha", "alpha", "beta"]);
    // Split beta's original part (now index 3) in two with a cut across it.
    s = cutParts(s, [box(44, -5, 46, 15).slice(0, 4)]).state;
    expect(s.owners!.filter((o) => o === "beta")).toHaveLength(3);
    const res = combineParts(s, [1, 2], 30, 1);
    if (typeof res !== "string") s = res.state;
    expect(s.owners!.length).toBe(s.parts.length);
    const out = split(s, sources);
    expect(out.beta.state.labels).toContain("new");
    expect(out.alpha.state.parts.length + out.beta.state.parts.length).toBe(s.parts.length);
  });
});

describe("removeLiveEntry", () => {
  it("sends the removed colour's parts back to their own region's colour", () => {
    const s = liveState(src(a, b));
    s.styles[2] = s.styles[1]; // beta's part in alpha's Hills
    const next = removeLiveEntry(s, s.styles[1]);
    expect(next.styles[1]).toBe(OWN_COLOUR);
    expect(next.props.legend[next.styles[2]]).toMatchObject({ src: "beta", own: true });
  });
});

describe("previewLegend", () => {
  it("shares identical entries and stays within the legend limit", () => {
    const s = liveState(src(a, b, c));
    const p = previewLegend(s);
    expect(p.legend.filter((e) => e.label === "Hills")).toHaveLength(1);
    expect(p.styles[1]).toBe(p.styles[3]);
  });
});
