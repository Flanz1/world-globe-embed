import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildLandMask, findSeaColour, traceCoast } from "../scripts/lib/coast-mask.ts";
import { buildCoast } from "../scripts/lib/coast-build.ts";
import { decodeCoast, encodeCoast } from "../src/shared/coast.ts";
import { thinTrace } from "../src/admin/editor/coast.ts";

const W = 2048;
const H = 1024;
const SEA = "#1e3236";

/**
 * A small painted world: a continent with a lake and a river (sea-coloured, 2 px) ending in a pond, a delta of
 * three channels, a big inland sea joined to the ocean by a river-wide neck, white lettering in the
 * sea, a small island, and two pictures in the sea: an inked one (a "ship") and a black whirlpool eye.
 */
const scene = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="${SEA}"/>
  <rect x="400" y="300" width="600" height="400" fill="#5a8a3c"/>
  <path d="M400 500 L560 500" stroke="${SEA}" stroke-width="2"/>
  <circle cx="562" cy="500" r="2.5" fill="${SEA}"/>
  <circle cx="750" cy="380" r="40" fill="${SEA}"/>
  <path d="M1000 400 L900 420 M1000 430 L900 420 M1000 460 L900 420" stroke="${SEA}" stroke-width="2"/>
  <rect x="1200" y="200" width="600" height="600" fill="#8a7a3c"/>
  <circle cx="1500" cy="500" r="150" fill="${SEA}"/>
  <path d="M1200 500 L1350 500" stroke="${SEA}" stroke-width="2"/>
  <path d="M120 520 q 15 -40 30 0 t 30 0 t 30 0 M220 490 l 0 40 M250 490 q 20 0 20 20 q 0 20 -20 20" stroke="#ffffff" stroke-width="4" fill="none"/>
  <circle cx="200" cy="800" r="12" fill="#5a8a3c"/>
  <circle cx="1000" cy="900" r="14" fill="#e0d0a0" stroke="#000000" stroke-width="3"/>
  <circle cx="1100" cy="900" r="6" fill="#000000"/>
</svg>`;

async function raster() {
  const { data, info } = await sharp(Buffer.from(scene)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height, channels: info.channels };
}

describe("land mask", () => {
  it("finds the sea colour", async () => {
    const r = await raster();
    const [cr, cg, cb] = findSeaColour(r.data, r.width, r.height, r.channels);
    expect(Math.abs(cr - 0x1e)).toBeLessThan(4);
    expect(Math.abs(cg - 0x32)).toBeLessThan(4);
    expect(Math.abs(cb - 0x36)).toBeLessThan(4);
  });

  it("counts rivers, lakes and deltas as land, open sea and inland seas as sea, and drops lettering", async () => {
    const r = await raster();
    const { land, stats } = buildLandMask(r.data, r.width, r.height, r.channels);
    const at = (x: number, y: number) => land[y * W + x];
    expect(at(100, 100)).toBe(0); // open ocean
    expect(at(700, 600)).toBe(1); // continent
    expect(at(562, 500)).toBe(1); // pond at the end of a river
    expect(at(750, 380)).toBe(1); // lake
    expect(at(480, 500)).toBe(1); // the river itself
    expect(at(950, 425)).toBe(1); // between the delta's channels
    expect(at(970, 445)).toBe(1); // in a delta channel
    expect(at(1500, 500)).toBe(0); // the inland sea counts as sea
    expect(at(1300, 500)).toBe(1); // …but the river-wide neck to it is land
    expect(at(150, 500)).toBe(0); // lettering is not an island
    expect(at(220, 510)).toBe(0);
    expect(at(200, 800)).toBe(1); // a real island stays
    expect(at(1000, 900)).toBe(0); // an inked picture is not an island
    expect(at(1100, 900)).toBe(0); // nor a black whirlpool eye
    expect(stats.decorationsRemoved).toBe(2);
    expect(stats.labelsRemoved).toBeGreaterThan(0);
    expect(stats.inlandSeas).toBeGreaterThan(0);
  });

  it("can treat inland seas as land", async () => {
    const r = await raster();
    const { land } = buildLandMask(r.data, r.width, r.height, r.channels, { inlandSeas: false });
    expect(land[500 * W + 1500]).toBe(1);
  });
});

describe("coast lines", () => {
  it("traces a square island as one closed line on its outline", () => {
    const w = 64;
    const h = 32;
    const land = new Uint8Array(w * h);
    for (let y = 10; y < 20; y++) for (let x = 20; x < 40; x++) land[y * w + x] = 1;
    const lines = traceCoast(land, w, h);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(true);
    // Half-pixel units: the outline runs half a pixel outside the land pixel centres' hull, through edge midpoints.
    const xs = [...lines[0].xy].filter((_, i) => i % 2 === 0);
    const ys = [...lines[0].xy].filter((_, i) => i % 2 === 1);
    // (Simplification may cut the corners' half-pixel bevel: within one half-pixel unit.)
    expect(Math.abs(Math.min(...xs) - 40)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.max(...xs) - 80)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.min(...ys) - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.max(...ys) - 40)).toBeLessThanOrEqual(1);
    expect(lines[0].xy.length / 2).toBeLessThanOrEqual(8); // simplified: corners only
  });

  it("keeps a line continuous across the east–west seam", () => {
    const w = 64;
    const h = 32;
    const land = new Uint8Array(w * h);
    for (let y = 10; y < 20; y++) for (let x = 0; x < w; x++) if (x < 6 || x >= 58) land[y * w + x] = 1;
    const lines = traceCoast(land, w, h);
    expect(lines).toHaveLength(1);
    const xs = [...lines[0].xy].filter((_, i) => i % 2 === 0);
    // One island 12 px wide straddling the seam: its x span (half-pixel units) is 24, not the map width.
    expect(Math.max(...xs) - Math.min(...xs)).toBe(24);
  });

  it("round-trips through the file format into map coordinates", () => {
    const bytes = encodeCoast(360, 180, [{ xy: Int32Array.from([0, 0, 720, 0, 720, 360, 361, 181]), closed: true }]);
    const data = decodeCoast(bytes);
    expect(data.width).toBe(360);
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].closed).toBe(true);
    expect([...data.lines[0].pts]).toEqual([-180, 90, 180, 90, 180, -90, 0.5, -0.5]);
  });

  it("rejects other files", () => {
    expect(() => decodeCoast(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))).toThrow();
  });

  it("builds a coast file for a map", async () => {
    const { bytes, stats } = buildCoast(await raster());
    const data = decodeCoast(bytes);
    expect(data.width).toBe(W);
    expect(stats.lines).toBe(data.lines.length);
    // The continent's north-west corner: lon -180 + 400/2048*360 ≈ -109.7, lat 90 - 300/1024*180 ≈ 37.3.
    const west = data.lines.some((l) => {
      for (let i = 0; i < l.pts.length; i += 2) if (Math.abs(l.pts[i] + 109.7) < 0.3 && Math.abs(l.pts[i + 1] - 37.3) < 0.3) return true;
      return false;
    });
    expect(west).toBe(true);
  });
});

describe("thinTrace", () => {
  it("keeps the ends and the corners of a traced stretch", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 10; i++) pts.push([i, 0]);
    for (let i = 1; i <= 10; i++) pts.push([10, i]);
    expect(thinTrace(pts, 0.1, 1)).toEqual([0, 10, 20]);
  });
});
