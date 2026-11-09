import { describe, expect, it } from "vitest";
import {
  areaPercent,
  boundingCap,
  chaikin,
  checkGeometry,
  closeRing,
  douglasPeucker,
  findSelfIntersection,
  geometryBounds,
  globeToImage,
  imageToGlobe,
  lonBounds,
  lonDelta,
  normalizeWinding,
  pointInGeometry,
  pointInRing,
  segmentsIntersect,
  signedArea,
  simplifyRing,
  sphericalArea,
  sphericalCentroid,
  toStoredGeometry,
  unwrapRing,
  windsAroundPole,
  wrapLon,
  type Position,
  type RegionGeometry,
} from "../src/shared/geo.ts";

/** A small circle (cap) of angular radius r around (lon0, lat0), as a closed CCW ring of n vertices. */
function cap(lon0: number, lat0: number, rDeg: number, n = 720): Position[] {
  const D = Math.PI / 180;
  const c: [number, number, number] = [Math.cos(lat0 * D) * Math.cos(lon0 * D), Math.cos(lat0 * D) * Math.sin(lon0 * D), Math.sin(lat0 * D)];
  // Orthonormal basis (east, north) at the centre.
  const e: [number, number, number] = [-Math.sin(lon0 * D), Math.cos(lon0 * D), 0];
  const nn: [number, number, number] = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
  const ring: Position[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const v = [0, 1, 2].map((k) => Math.cos(rDeg * D) * c[k] + Math.sin(rDeg * D) * (Math.cos(t) * e[k] + Math.sin(t) * nn[k]));
    ring.push([Math.atan2(v[1], v[0]) / D, Math.asin(v[2]) / D]);
  }
  return closeRing(ring);
}

describe("longitude wrapping", () => {
  it("wraps into ±180 and measures the short way round", () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
    expect(wrapLon(180)).toBe(180);
    expect(lonDelta(179, -179)).toBe(2);
    expect(lonDelta(-179, 179)).toBe(-2);
  });

  it("unwraps a ring that crosses the antimeridian into continuous longitudes", () => {
    const ring: Position[] = [[170, 0], [-170, 0], [-170, 10], [170, 10], [170, 0]];
    expect(unwrapRing(ring).map((p) => p[0])).toEqual([170, 190, 190, 170, 170]);
    expect(windsAroundPole(ring)).toBe(false);
  });

  it("detects a ring that goes round a pole", () => {
    const ring: Position[] = [[0, 80], [90, 80], [180, 80], [-90, 80], [0, 80]];
    expect(windsAroundPole(ring)).toBe(true);
  });

  it("finds the tightest longitude interval, across ±180 too", () => {
    expect(lonBounds([10, 20, 15])).toEqual([10, 20]);
    expect(lonBounds([175, -175, 179])).toEqual([175, 185]);
  });
});

describe("planar helpers", () => {
  it("segment intersection", () => {
    expect(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 1], [2, 2], [3, 3])).toBe(false);
    expect(segmentsIntersect([0, 0], [2, 0], [1, 0], [3, 0])).toBe(true); // collinear overlap
  });

  it("finds a self-intersection (bow tie) and accepts a simple ring", () => {
    expect(findSelfIntersection([[0, 0], [2, 2], [2, 0], [0, 2]])).not.toBeNull();
    expect(findSelfIntersection([[0, 0], [2, 0], [2, 2], [0, 2]])).toBeNull();
    // A spike that folds back on itself.
    expect(findSelfIntersection([[0, 0], [2, 0], [4, 0], [3, 0], [3, 2]])).not.toBeNull();
  });

  it("point in polygon across ±180", () => {
    const ring: Position[] = [[170, -10], [-170, -10], [-170, 10], [170, 10], [170, -10]];
    expect(pointInRing([179.5, 0], ring)).toBe(true);
    expect(pointInRing([-179.5, 0], ring)).toBe(true);
    expect(pointInRing([180, 5], ring)).toBe(true);
    expect(pointInRing([0, 0], ring)).toBe(false);
    expect(pointInRing([165, 0], ring)).toBe(false);
    const withHole: RegionGeometry = {
      type: "Polygon",
      coordinates: [ring, [[178, -2], [178, 2], [-178, 2], [-178, -2], [178, -2]]],
    };
    expect(pointInGeometry([179.9, 0], withHole)).toBe(false);
    expect(pointInGeometry([172, 0], withHole)).toBe(true);
  });

  it("normalises winding: outer counter-clockwise, holes clockwise", () => {
    const cw: Position[] = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
    const ccwHole: Position[] = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];
    expect(signedArea(cw)).toBeLessThan(0);
    const [outer, hole] = normalizeWinding([cw, ccwHole]);
    expect(signedArea(outer)).toBeGreaterThan(0);
    expect(signedArea(hole)).toBeLessThan(0);
    // Winding is judged on the unwrapped ring, so a ring across ±180 is handled.
    const across: Position[] = [[170, 0], [170, 10], [-170, 10], [-170, 0], [170, 0]]; // clockwise
    expect(signedArea(unwrapRing(normalizeWinding([across])[0]))).toBeGreaterThan(0);
  });
});

describe("simplify and smooth", () => {
  it("Douglas–Peucker drops points within the tolerance", () => {
    const line: Position[] = Array.from({ length: 101 }, (_, i) => [i, Math.sin(i / 3) * 0.01]);
    expect(douglasPeucker(line, 0.1)).toHaveLength(2);
    const zig: Position[] = Array.from({ length: 11 }, (_, i) => [i, i % 2 ? 1 : 0]);
    expect(douglasPeucker(zig, 0.5)).toHaveLength(11);
  });

  it("simplifies a dense circle to a few vertices but never below 3", () => {
    const circle = cap(0, 0, 10, 400).slice(0, -1);
    const simple = simplifyRing(circle, 0.5);
    expect(simple.length).toBeGreaterThan(8);
    expect(simple.length).toBeLessThan(60);
    expect(simplifyRing(circle, 1000)).toHaveLength(3);
  });

  it("Chaikin doubles the vertex count each pass", () => {
    const sq: Position[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const once = chaikin(sq);
    expect(once).toHaveLength(8);
    expect(chaikin(once)).toHaveLength(16);
    expect(once[0]).toEqual([2.5, 0]);
    expect(once[1]).toEqual([7.5, 0]);
  });
});

describe("spherical measures", () => {
  it("area of a known cap: 2π(1 − cos r)", () => {
    const r = 20;
    const g: RegionGeometry = { type: "Polygon", coordinates: [cap(40, 30, r)] };
    const exact = 2 * Math.PI * (1 - Math.cos((r * Math.PI) / 180));
    expect(sphericalArea(g) / exact).toBeCloseTo(1, 3);
    expect(areaPercent(g)).toBeCloseTo((exact / (4 * Math.PI)) * 100, 2);
  });

  it("area of an octant (lon 0..90, lat 0..~90) is an eighth of the sphere", () => {
    const g: RegionGeometry = { type: "Polygon", coordinates: [[[0, 0], [90, 0], [90, 89.9999], [0, 89.9999], [0, 0]]] };
    // Edges are great circles: the "top" edge collapses to the pole, so this is the octant triangle.
    expect(areaPercent(g)).toBeCloseTo(12.5, 2);
  });

  it("centroid and bounding cap of a cap are its centre and radius, also across the antimeridian", () => {
    for (const [lon, lat] of [[40, 30], [178, -20], [-120, 60]]) {
      const g: RegionGeometry = { type: "Polygon", coordinates: [cap(lon, lat, 12)] };
      const c = sphericalCentroid(g);
      expect(c[0]).toBeCloseTo(lon, 4);
      expect(c[1]).toBeCloseTo(lat, 4);
      expect(boundingCap(g).radius).toBeCloseTo(12, 3);
    }
  });

  it("holes subtract from the area", () => {
    const outer = cap(0, 0, 20);
    const hole = cap(0, 0, 10).reverse();
    const g: RegionGeometry = { type: "Polygon", coordinates: [outer, hole] };
    const k = (r: number) => 2 * Math.PI * (1 - Math.cos((r * Math.PI) / 180));
    expect(sphericalArea(g) / (k(20) - k(10))).toBeCloseTo(1, 3);
  });
});

describe("image frame ↔ globe frame", () => {
  it("applies shift and pole padding like the texture, and inverts", () => {
    const f = { north: 10, south: 20, shift: 30 };
    expect(imageToGlobe([0, 90], f)).toEqual([30, 72]); // top of the image sits under the 10% north cap
    expect(imageToGlobe([170, -90], f)[0]).toBe(-160);
    expect(imageToGlobe([0, -90], f)[1]).toBeCloseTo(-54, 10); // 20% south cap
    const p: Position = [123.4, -45.6];
    const back = globeToImage(imageToGlobe(p, f), f);
    expect(back[0]).toBeCloseTo(p[0], 10);
    expect(back[1]).toBeCloseTo(p[1], 10);
  });

  it("bounds cross the antimeridian when that's tighter", () => {
    const g: RegionGeometry = { type: "Polygon", coordinates: [[[170, 0], [-170, 0], [-170, 10], [170, 10], [170, 0]]] };
    expect(geometryBounds(g)).toEqual([170, 0, 190, 10]);
  });
});

describe("stored geometry", () => {
  it("wraps, rounds, closes and winds editor rings; one part is a Polygon", () => {
    const g = toStoredGeometry([[[[175.123456, 0], [175.1, 10], [185.00004, 10], [185, 0]]]]);
    expect(g.type).toBe("Polygon");
    const ring = (g as { coordinates: Position[][] }).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.map((p) => p[0])).toContain(-175);
    expect(ring.every(([x]) => x >= -180 && x <= 180)).toBe(true);
    expect(ring.flat().every((v) => Math.round(v * 1e4) / 1e4 === v)).toBe(true);
    expect(checkGeometry(g)).toEqual([]);
  });

  it("two parts become a MultiPolygon", () => {
    const sq = (x: number): Position[] => [[x, 0], [x + 1, 0], [x + 1, 1], [x, 1]];
    expect(toStoredGeometry([[sq(0)], [sq(5)]]).type).toBe("MultiPolygon");
  });
});
