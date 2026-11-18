import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_KM, KM_PER_MI, distanceKm, cleanTravel, formatDuration, formatArea, formatLength, formatPercent, geodesic, pathKm, perimeterKm, ringAreaKm2, ringSphereFraction, sphereAreaKm2, validRadius } from "../src/shared/measure.ts";
import type { Position } from "../src/shared/geo.ts";

describe("distance", () => {
  it("a quarter of the equator is a quarter of the circumference", () => {
    expect(distanceKm([0, 0], [90, 0], EARTH_RADIUS_KM)).toBeCloseTo((2 * Math.PI * EARTH_RADIUS_KM) / 4, 3);
  });
  it("pole to pole is half the circumference, along any meridian", () => {
    expect(distanceKm([10, 90], [200, -90], 1000)).toBeCloseTo(Math.PI * 1000, 3);
  });
  it("a path adds its legs", () => {
    const p: Position[] = [[0, 0], [90, 0], [90, 90]];
    expect(pathKm(p, 1000)).toBeCloseTo(Math.PI * 1000, 3);
  });
  it("scales with the radius", () => {
    expect(distanceKm([0, 0], [30, 20], 2000)).toBeCloseTo(2 * distanceKm([0, 0], [30, 20], 1000), 6);
  });
});

describe("area", () => {
  it("one octant (0..90° lon, 0..90° lat) is an eighth of the sphere", () => {
    const tri: Position[] = [[0, 0], [90, 0], [0, 90]];
    expect(ringSphereFraction(tri)).toBeCloseTo(1 / 8, 6);
    expect(ringAreaKm2(tri, 1000)).toBeCloseTo(sphereAreaKm2(1000) / 8, 3);
  });
  it("doesn't depend on winding", () => {
    const tri: Position[] = [[0, 0], [90, 0], [0, 90]];
    expect(ringSphereFraction([...tri].reverse())).toBeCloseTo(1 / 8, 6);
  });
  it("is zero for fewer than 3 points", () => {
    expect(ringSphereFraction([[0, 0], [10, 10]])).toBe(0);
  });
  it("perimeter closes the ring", () => {
    expect(perimeterKm([[0, 0], [90, 0], [0, 90]], 1000)).toBeCloseTo(1.5 * Math.PI * 1000, 3);
  });
});

describe("geodesic", () => {
  it("keeps both ends and stays within the step", () => {
    const g = geodesic([0, 0], [90, 0], 2);
    expect(g[0]).toEqual([0, 0]);
    expect(g[g.length - 1]).toEqual([90, 0]);
    expect(g.length).toBe(46);
  });
  it("goes over the pole's side for a long route at high latitude", () => {
    const g = geodesic([0, 80], [180, 80]);
    expect(Math.max(...g.map((p) => p[1]))).toBeCloseTo(90, 0);
  });
  it("handles identical and antipodal points", () => {
    expect(geodesic([5, 5], [5, 5])).toHaveLength(2);
    expect(geodesic([0, 0], [180, 0])).toHaveLength(2);
  });
});

describe("formatting and limits", () => {
  it("formats lengths in km and miles", () => {
    expect(formatLength(1234.5, "km")).toBe("1,235 km");
    expect(formatLength(KM_PER_MI * 10, "mi")).toBe("10 mi");
    expect(formatLength(3.456, "km")).toBe("3.46 km");
  });
  it("formats big areas in millions", () => {
    expect(formatArea(12_345_000, "km")).toBe("12.35 million km²");
    expect(formatArea(500, "km")).toBe("500 km²");
    expect(formatArea(KM_PER_MI * KM_PER_MI * 1000, "mi")).toBe("1,000 mi²");
  });
  it("formats the share of the world", () => {
    expect(formatPercent(0.024)).toBe("2.4%");
    expect(formatPercent(0.00012)).toBe("0.012%");
  });
  it("accepts only sane radii", () => {
    expect(validRadius(6371)).toBe(true);
    for (const v of [0, 99, 1_000_001, NaN, Infinity, "6371", null, undefined]) expect(validRadius(v)).toBe(false);
  });
});

describe("travel time", () => {
  it("writes durations from days to years", () => {
    expect(formatDuration(0.4)).toBe("under a day");
    expect(formatDuration(1)).toBe("1 day");
    expect(formatDuration(3.2, "on foot")).toBe("3 days on foot");
    expect(formatDuration(14)).toBe("about 2 weeks (14 days)");
    expect(formatDuration(37, "by horse")).toBe("about 5 weeks by horse (37 days)");
    expect(formatDuration(330)).toBe("about 11 months (330 days)");
    expect(formatDuration(400)).toBe("about 1 year (400 days)");
    expect(formatDuration(526, "on foot")).toBe("about 1.5 years on foot (526 days)");
    expect(formatDuration(1000)).toBe("about 2.5 years (1,000 days)");
    expect(formatDuration(NaN)).toBe("");
  });
  it("keeps only usable travel speeds, trimmed and capped", () => {
    expect(cleanTravel(undefined)).toEqual([]);
    expect(cleanTravel([{ label: " Horse ", kmPerDay: 50 }, { label: "", kmPerDay: 5 }, { label: "Bad", kmPerDay: 0 }, null, { label: "x".repeat(40), kmPerDay: 1 }])).toEqual([
      { label: "Horse", kmPerDay: 50 },
      { label: "x".repeat(24), kmPerDay: 1 },
    ]);
    expect(cleanTravel(Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, kmPerDay: 10 })))).toHaveLength(6);
  });
});
