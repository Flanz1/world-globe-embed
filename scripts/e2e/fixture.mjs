/**
 * Builds a throwaway copy of this repo with test content for the region checks:
 * a map with known landmarks, a padded + shifted slot, and regions drawn exactly on those landmarks
 * (one crossing the antimeridian, one with a hostile name). Nothing here touches the real content/.
 *
 *   node scripts/e2e/fixture.mjs   → prints the temp dir
 */
import { cpSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(path.join(ROOT, "package.json"));
const sharp = require("sharp");

/** The test map: 3600 × 2000 (1.8:1, not 2:1 on purpose). */
export const MAP = { id: "landmarks", w: 3600, h: 2000 };
/** Slot with pole padding and a prime meridian shift, so the overlay has to follow both. */
export const SLOT = { slug: "align", north: 12, south: 6, shift: 40 };
/** Magenta ellipse that is a circle of 6° in lon/lat degrees, at image lon 150, lat 40. */
export const DISC = { lon: 150, lat: 40, r: 6 };
/** Three boxes in one region, each drawn in its own colour (two from the legend), over plain sea. */
export const PROVINCES = {
  colours: ["#ff3b30", "#00e676", "#2979ff"],
  boxes: [
    [60, -40, 70, -30],
    [72, -40, 82, -30],
    [84, -40, 94, -30],
  ],
};
/** Yellow box across the antimeridian: lon 170 → -170, lat -30 → -10. */
export const BOX = { west: 170, east: -170, south: -30, north: -10 };

const px = (lon, lat) => [((lon + 180) / 360) * MAP.w, ((90 - lat) / 180) * MAP.h];

function mapSvg() {
  const [cx, cy] = px(DISC.lon, DISC.lat);
  const rx = (DISC.r / 360) * MAP.w;
  const ry = (DISC.r / 180) * MAP.h;
  const [bx0, by0] = px(BOX.west, BOX.north);
  const [, by1] = px(BOX.west, BOX.south);
  const bw = ((BOX.east + 360 - BOX.west) / 360) * MAP.w; // 20° wide, wraps
  const lines = [];
  for (let lon = -150; lon < 180; lon += 30) {
    const [x] = px(lon, 0);
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${MAP.h}" stroke="#ffffff" stroke-opacity=".35" stroke-width="3"/>`);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = px(0, lat);
    lines.push(`<line x1="0" y1="${y}" x2="${MAP.w}" y2="${y}" stroke="#ffffff" stroke-opacity=".35" stroke-width="3"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP.w}" height="${MAP.h}">
<rect width="100%" height="100%" fill="#1d4f7a"/>
<rect x="${MAP.w * 0.2}" y="${MAP.h * 0.35}" width="${MAP.w * 0.25}" height="${MAP.h * 0.3}" fill="#5a8a3c"/>
${lines.join("\n")}
<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#ff00ff"/>
<rect x="${bx0}" y="${by0}" width="${bw}" height="${by1 - by0}" fill="#ffd400"/>
<rect x="${bx0 - MAP.w}" y="${by0}" width="${bw}" height="${by1 - by0}" fill="#ffd400"/>
</svg>`;
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

export function discRing(n = 96) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    ring.push([r4(DISC.lon + DISC.r * Math.cos(t)), r4(DISC.lat + DISC.r * Math.sin(t))]);
  }
  ring.push(ring[0]);
  return ring;
}

function region(id, name, geometry, extra = {}) {
  return {
    $schema: "../../schema/region.schema.json",
    type: "Feature",
    id,
    properties: { name, slot: SLOT.slug, map: MAP.id, color: "#00e5ff", fillOpacity: 0.25, label: true, updated: "2026-11-09T12:00:00Z", ...extra },
    geometry,
  };
}

/** Copies the repo's source and content into dir (public/maps' tiles are linked, not copied) and links node_modules. */
export function copyRepo(dir) {
  for (const f of ["package.json", "tsconfig.json", "vite.config.ts", "eslint.config.js", "admin", "content", "schema", "scripts", "src"])
    cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  // public/ holds the real maps' tiles (tens of MB): link each map's folder instead of copying it.
  // The fixture's own map is written to a real public/maps/<id>/ beside the links.
  cpSync(path.join(ROOT, "public"), path.join(dir, "public"), { recursive: true, filter: (src) => !src.startsWith(path.join(ROOT, "public/maps/")) });
  mkdirSync(path.join(dir, "public/maps"), { recursive: true });
  for (const m of readdirSync(path.join(ROOT, "public/maps"))) symlinkSync(path.join(ROOT, "public/maps", m), path.join(dir, "public/maps", m), "dir");
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
}

export async function makeFixture({ quiet = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wge-e2e-"));
  copyRepo(dir);

  await sharp(Buffer.from(mapSvg())).png().toFile(path.join(dir, "content/incoming", `${MAP.id}.png`));
  const run = (cmd, args, env = {}) =>
    execFileSync(cmd, args, { cwd: dir, env: { ...process.env, ...env }, stdio: quiet ? "pipe" : "inherit" });
  run("npx", ["tsx", "scripts/process-maps.ts"], { GITHUB_ACTOR: "e2e" });

  const slotsFile = path.join(dir, "content/slots.json");
  const slots = JSON.parse(readFileSync(slotsFile, "utf8"));
  slots.slots[SLOT.slug] = { map: MAP.id, title: "Alignment test", north: SLOT.north, south: SLOT.south, shift: SLOT.shift, pole: "#334455" };
  writeFileSync(slotsFile, JSON.stringify(slots, null, 2) + "\n");

  // Only the test regions: real ones saved to content/regions would change the counts the checks expect.
  const regionsDir = path.join(dir, "content/regions");
  rmSync(regionsDir, { recursive: true, force: true });
  mkdirSync(regionsDir, { recursive: true });
  const write = (r) => writeFileSync(path.join(regionsDir, `${r.id}.json`), JSON.stringify(r, null, 2) + "\n");
  write(region("landmark-disc", "Magenta Isle", { type: "Polygon", coordinates: [discRing()] }));
  write(
    region("dateline-box", "Dateline Reach", {
      type: "Polygon",
      coordinates: [[[BOX.west, BOX.south], [BOX.east, BOX.south], [BOX.east, BOX.north], [BOX.west, BOX.north], [BOX.west, BOX.south]]],
    }, { color: "#ff3b30" }),
  );
  write(
    region("evil-name", '"><script>alert(1)</script>', { type: "Polygon", coordinates: [[[-60, 0], [-50, 0], [-50, 10], [-60, 10], [-60, 0]]] }, {
      description: "</script><img src=x onerror=alert(2)>",
      color: "#c33",
    }),
  );
  // Same for categories: start with none, so the folder lists the checks expect aren't affected by the real ones.
  writeFileSync(path.join(dir, "content/categories.json"), JSON.stringify({ categories: [] }, null, 2) + "\n");
  // On the other slot, drawn on a map that slot no longer shows: a warning in CI, a badge in the admin page.
  writeFileSync(
    path.join(regionsDir, "old-map-region.json"),
    JSON.stringify({ ...region("old-map-region", "Old Province", { type: "Polygon", coordinates: [[[0, 0], [20, 0], [20, 15], [0, 15], [0, 0]]] }), properties: { name: "Old Province", slot: "inara", map: "retired-map", color: "#2e86de" } }, null, 2) + "\n",
  );
  // Several colours with a legend (one label hostile), for the legend checks.
  write(
    region(
      "provinces",
      "Three Provinces",
      { type: "MultiPolygon", coordinates: PROVINCES.boxes.map(([w, s, e, n]) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]]) },
      {
        color: PROVINCES.colours[0],
        fillOpacity: 0.9,
        legendTitle: "Provinces",
        legend: [
          { label: "Green March", color: PROVINCES.colours[1] },
          { label: '<img src=x onerror=alert(3)>', color: PROVINCES.colours[2] },
        ],
        partLegend: [-1, 0, 1],
        partLabels: ["Red Reach", "", "Blue Coast"],
      },
    ),
  );
  // 2,000 vertices, for the editor's live-preview speed check.
  const big = [];
  for (let i = 0; i < 2000; i++) {
    const t = (i / 2000) * 2 * Math.PI;
    const r = 9 + 1.5 * Math.sin(t * 7);
    big.push([r4(-100 + r * Math.cos(t)), r4(20 + r * Math.sin(t))]);
  }
  big.push(big[0]);
  write(region("big-ring", "Big Ring", { type: "Polygon", coordinates: [big] }, { color: "#8e44ad" }));
  return dir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = await makeFixture();
  console.log(dir);
}
