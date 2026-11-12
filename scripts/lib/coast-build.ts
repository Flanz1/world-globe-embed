/**
 * Builds a map's coast file (public/maps/<id>/<hash>-coast.bin) from its textures, and the pieces
 * process-maps and `npm run coast` share. See coast-mask.ts for how land and sea are told apart.
 */
import path from "node:path";
import sharp from "sharp";
import { encodeCoast } from "../../src/shared/coast.ts";
import type { MapMeta } from "../../src/shared/types.ts";
import { tileRect, tileUrl } from "../../src/shared/tiles.ts";
import { buildLandMask, traceCoast, type CoastOptions, type CoastStats } from "./coast-mask.ts";

/** Coast lines are traced at this width (or the map's own width when smaller). */
export const COAST_WIDTH = 16384;

export const coastFile = (id: string, hash: string) => `maps/${id}/${hash}-coast.bin`;

export interface Raster {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

/** Coast file bytes and what was found, from a raw raster. */
export function buildCoast(r: Raster, opts: CoastOptions = {}): { bytes: Uint8Array; stats: CoastStats; land: Uint8Array } {
  const mask = buildLandMask(r.data, r.width, r.height, r.channels, opts);
  const lines = traceCoast(mask.land, r.width, r.height, opts.simplify);
  const bytes = encodeCoast(r.width, r.height, lines);
  const points = lines.reduce((n, l) => n + l.xy.length / 2, 0);
  return { bytes, stats: { ...mask.stats, lines: lines.length, points }, land: mask.land };
}

/** The map at up to COAST_WIDTH px wide, from its processed files: the 16384 tiles when there are any, else the largest texture. */
export async function loadMapRaster(meta: MapMeta, publicDir: string): Promise<Raster> {
  const level = meta.tiles?.["16384"];
  if (level) {
    const data = new Uint8Array(level.w * level.h * 3);
    for (let r = 0; r < level.rows; r++)
      for (let c = 0; c < level.cols; c++) {
        const [u0, v0] = tileRect(level, c, r);
        const left = Math.round(u0 * level.w);
        const top = Math.round(v0 * level.h);
        const { data: t, info } = await sharp(path.join(publicDir, tileUrl(level, c, r)))
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        for (let y = 0; y < info.height && top + y < level.h; y++) {
          const row = t.subarray(y * info.width * 3, (y + 1) * info.width * 3);
          data.set(row.subarray(0, Math.min(info.width, level.w - left) * 3), ((top + y) * level.w + left) * 3);
        }
      }
    return { data, width: level.w, height: level.h, channels: 3 };
  }
  const widths = Object.keys(meta.sizes).map(Number).sort((a, b) => b - a);
  const file = meta.sizes[`${widths[0]}` as keyof MapMeta["sizes"]]!;
  const { data, info } = await sharp(path.join(publicDir, file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 3 };
}

export const describeStats = (s: CoastStats) =>
  `sea colour rgb(${s.seaColour.join(", ")}); ${((100 * s.seaPixels) / (s.width * s.height)).toFixed(1)}% open sea; ` +
  `${s.inlandWaterPixels.toLocaleString("en")} px of rivers/lakes/marsh counted as land; ${s.inlandSeas} inland sea(s); ` +
  `${s.labelsRemoved} sea labels, ${s.boxesRemoved} name boxes, ${s.decorationsRemoved} pictures and ${s.specksRemoved} specks removed; ${s.lines.toLocaleString("en")} coast lines, ${s.points.toLocaleString("en")} points`;
