import { describe, expect, it } from "vitest";
import { stringifyCompact } from "../src/shared/json.ts";

describe("stringifyCompact", () => {
  const feature = {
    type: "Feature",
    id: "x",
    properties: { name: "a, [1, 2] b", list: [1, 2, 3], pair: [1e-7, -2.5] },
    geometry: { type: "Polygon", coordinates: [[[-103.5022, 37.3811], [0, 0], [10, 0], [-103.5022, 37.3811]]] },
  };
  it("keeps a position on one line and parses back to the same data", () => {
    const text = stringifyCompact(feature);
    expect(JSON.parse(text)).toEqual(feature);
    expect(text).toContain("[-103.5022, 37.3811],");
    expect(text.split("\n").filter((l) => l.includes("37.3811")).length).toBe(2);
  });
  it("leaves other arrays and strings alone", () => {
    const text = stringifyCompact(feature);
    expect(text).toContain('"name": "a, [1, 2] b"');
    expect(text).toMatch(/"list": \[\n\s+1,\n\s+2,\n\s+3\n\s+\]/);
  });
  it("is about half the size of plain pretty printing for a big ring", () => {
    const ring = Array.from({ length: 1000 }, (_, i) => [i / 10, -i / 20]);
    const big = { geometry: { type: "Polygon", coordinates: [ring] } };
    expect(stringifyCompact(big).length).toBeLessThan(JSON.stringify(big, null, 2).length * 0.6);
  });
});
