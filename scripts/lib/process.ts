/** Turns an uploaded equirectangular image into WebP textures + LQIP + metadata. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp, { type Sharp } from "sharp";
import { TEXTURE_WIDTHS, type MapMeta, type TextureWidth } from "../../src/shared/types.ts";
import { COAST_WIDTH, buildCoast, coastFile, type Raster } from "./coast-build.ts";
import { TILE_LEVELS, tileGrid, tileRect, tileUrl, type TileLevel } from "../../src/shared/tiles.ts";
import { contentPaths, type ContentPaths } from "./paths.ts";

export type ImageKind = "png" | "jpeg" | "webp";

/** Identifies the image type from its first bytes, ignoring the file extension. */
export function sniff(buf: Uint8Array): ImageKind | null {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "webp";
  return null;
}

/**
 * Any landscape image from square (1:1) up to 4:1 is accepted. The globe stretches it over the sphere,
 * so 2:1 looks undistorted; wider maps can use north/south pole padding to keep their proportions.
 */
export const MIN_ASPECT = 1;
export const MAX_ASPECT = 4;
export const MIN_WIDTH = 1024;
/** Largest source accepted: 65535 × 32768, about 2.1 gigapixels (enough for a 49152 px wide map). */
export const MAX_PIXELS = 65535 * 32768;

export function checkAspect(width: number, height: number): { ok: boolean; aspect: number; message?: string } {
  const aspect = width / height;
  if (aspect >= MIN_ASPECT - 1e-9 && aspect <= MAX_ASPECT + 1e-9) return { ok: true, aspect };
  return {
    ok: false,
    aspect,
    message:
      `is ${width}×${height} (ratio ${aspect.toFixed(2)}:1). A globe map has to be at least as wide as it is tall ` +
      `and no more than 4 times as wide (2:1, e.g. 4096×2048, looks best).`,
  };
}

export function mapIdFromFilename(file: string): string {
  return path
    .basename(file, path.extname(file))
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const titleCase = (id: string) => id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export interface Inspection {
  file: string;
  id: string;
  kind: ImageKind | null;
  width: number;
  height: number;
  errors: string[];
}

/** Checks an incoming file without writing anything. */
export async function inspect(file: string): Promise<Inspection> {
  const name = path.basename(file);
  const id = mapIdFromFilename(file);
  const buf = readFileSync(file);
  const kind = sniff(buf);
  const out: Inspection = { file, id, kind, width: 0, height: 0, errors: [] };
  if (!id) out.errors.push(`${name}: the file name needs at least one letter or digit (it becomes the map id)`);
  if (!kind) {
    out.errors.push(`${name}: is not a PNG, JPEG or WebP image (checked by file contents, not extension)`);
    return out;
  }
  const meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata();
  // EXIF orientation 5–8 means the stored image is rotated 90°.
  const swap = (meta.orientation ?? 1) >= 5;
  out.width = (swap ? meta.height : meta.width) ?? 0;
  out.height = (swap ? meta.width : meta.height) ?? 0;
  const a = checkAspect(out.width, out.height);
  if (!a.ok) out.errors.push(`${name}: ${a.message}`);
  if (out.width < MIN_WIDTH) out.errors.push(`${name}: is only ${out.width}px wide; maps need to be at least ${MIN_WIDTH}px wide`);
  return out;
}

const LQIP_MAX_BYTES = 2048;

export async function makeLqip(img: Sharp, aspect = 2): Promise<string> {
  for (const [w, q] of [[48, 50], [40, 40], [32, 35], [24, 30]] as const) {
    const buf = await img.clone().resize(w, Math.max(1, Math.round(w / aspect)), { fit: "fill" }).blur(0.5).webp({ quality: q, effort: 6 }).toBuffer();
    if (buf.length <= LQIP_MAX_BYTES) return `data:image/webp;base64,${buf.toString("base64")}`;
  }
  throw new Error("could not make an LQIP under 2 KB");
}

export interface ProcessOptions {
  paths?: ContentPaths;
  uploadedBy: string;
  now?: Date;
  /** Delete the source from content/incoming afterwards (default true). */
  removeSource?: boolean;
  /** Map id to use instead of the one from the file name. */
  id?: string;
  /** Trace coast lines for the region editor (default true). */
  coast?: boolean;
}

export async function processImage(file: string, opts: ProcessOptions): Promise<MapMeta> {
  const paths = opts.paths ?? contentPaths();
  const info = await inspect(file);
  if (opts.id) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(opts.id)) throw new Error(`"${opts.id}" isn't a valid map id: lowercase letters, digits and dashes only`);
    info.id = opts.id;
    info.errors = info.errors.filter((e) => !e.includes("the file name needs"));
  }
  if (info.errors.length) throw new Error(info.errors.join("\n"));
  const buf = readFileSync(file);
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  // .rotate() applies EXIF orientation; sharp drops EXIF/ICC/XMP metadata on output by default.
  const base = sharp(buf, { limitInputPixels: MAX_PIXELS }).rotate();
  // Outputs keep the source's proportions; the viewer maps them onto the sphere.
  const aspect = info.width / info.height;

  const outDir = path.join(paths.publicDir, "maps", info.id);
  mkdirSync(outDir, { recursive: true });
  const sizes: MapMeta["sizes"] = {};
  const widths = TEXTURE_WIDTHS.filter((w) => w === 1024 || w <= info.width);
  for (const w of widths) {
    const name = `${hash}-${w}.webp`;
    await base
      .clone()
      .resize(w, Math.round(w / aspect), { fit: "fill", kernel: "lanczos3" })
      .webp({ quality: w >= 8192 ? 76 : w === 4096 ? 80 : 82, effort: 5, smartSubsample: true })
      .toFile(path.join(outDir, name));
    sizes[`${w as TextureWidth}`] = `maps/${info.id}/${name}`;
  }
  // Tile levels (16384, 32768) for sources at least that wide: resized once, then cut into 2048 px tiles.
  const tiles: NonNullable<MapMeta["tiles"]> = {};
  const tileFiles: string[] = [];
  let coastRaster: Raster | null = null;
  for (const w of TILE_LEVELS.filter((w) => w <= info.width)) {
    const grid = tileGrid(w, aspect);
    const level: TileLevel = { ...grid, url: `maps/${info.id}/${hash}-${w}` };
    const { data, info: raw } = await base.clone().resize(grid.w, grid.h, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
    if (w === COAST_WIDTH) coastRaster = { data, width: raw.width, height: raw.height, channels: raw.channels };
    for (let r = 0; r < grid.rows; r++)
      for (let c = 0; c < grid.cols; c++) {
        const [u0, v0, u1, v1] = tileRect(grid, c, r);
        const left = Math.round(u0 * grid.w);
        const top = Math.round(v0 * grid.h);
        const file = tileUrl(level, c, r);
        await sharp(data, { raw: { width: raw.width, height: raw.height, channels: raw.channels }, limitInputPixels: MAX_PIXELS })
          .extract({ left, top, width: Math.round(u1 * grid.w) - left, height: Math.round(v1 * grid.h) - top })
          .webp({ quality: 78, effort: 4, smartSubsample: true })
          .toFile(path.join(paths.publicDir, file));
        tileFiles.push(path.basename(file));
      }
    tiles[`${w}`] = level;
  }
  // Coast lines for snapping in the region editor, traced at up to 16384 px wide.
  let coast: string | undefined;
  if (opts.coast !== false) {
    if (!coastRaster) {
      const cw = Math.min(COAST_WIDTH, info.width);
      const { data, info: raw } = await base.clone().resize(cw, Math.round(cw / aspect), { fit: "fill", kernel: "lanczos3" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      coastRaster = { data, width: raw.width, height: raw.height, channels: raw.channels };
    }
    coast = coastFile(info.id, hash);
    writeFileSync(path.join(paths.publicDir, coast), buildCoast(coastRaster).bytes);
  }
  // Remove textures from earlier uploads of the same map id.
  const keep = new Set([...Object.values(sizes).map((p) => path.basename(p!)), ...tileFiles, ...(coast ? [path.basename(coast)] : [])]);
  for (const f of readdirSync(outDir)) if (!keep.has(f)) rmSync(path.join(outDir, f));

  const metaFile = path.join(paths.mapsDir, `${info.id}.json`);
  const previous = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf8")) as Partial<MapMeta>) : {};
  const meta: MapMeta = {
    $schema: "../../schema/map.schema.json",
    id: info.id,
    name: previous.name ?? titleCase(info.id),
    uploadedBy: opts.uploadedBy,
    date: (opts.now ?? new Date()).toISOString(),
    aspect: Math.round((info.width / info.height) * 1000) / 1000,
    width: info.width,
    height: info.height,
    hash,
    sizes,
    ...(Object.keys(tiles).length ? { tiles } : {}),
    ...(coast ? { coast } : {}),
    lqip: await makeLqip(base, aspect),
  };
  mkdirSync(paths.mapsDir, { recursive: true });
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
  if (opts.removeSource !== false) unlinkSync(file);
  return meta;
}

/**
 * Big uploads arrive in parts (`<name>.part001`, … plus `<name>.parts.json` with the count, size and
 * SHA-256), because GitHub's API refuses single uploads of a few tens of MB. Joins each set back into
 * `<name>` and removes the parts. Returns joined file → manifest (for "who uploaded it"), and errors
 * for incomplete or corrupt sets, which are left alone.
 */
export function joinParts(paths: ContentPaths = contentPaths()): { joined: Map<string, string>; errors: string[] } {
  const joined = new Map<string, string>();
  const errors: string[] = [];
  if (!existsSync(paths.incomingDir)) return { joined, errors };
  const all = readdirSync(paths.incomingDir);
  for (const m of all.filter((f) => f.endsWith(".parts.json"))) {
    const name = m.slice(0, -".parts.json".length);
    const manifest = path.join(paths.incomingDir, m);
    let spec: { parts?: number; bytes?: number; sha256?: string };
    try {
      spec = JSON.parse(readFileSync(manifest, "utf8")) as typeof spec;
    } catch {
      errors.push(`${m}: is not valid JSON; upload the map again`);
      continue;
    }
    const n = Number(spec.parts);
    const files = Array.from({ length: n }, (_, i) => `${name}.part${String(i + 1).padStart(3, "0")}`);
    const missing = files.filter((f) => !all.includes(f));
    if (!Number.isInteger(n) || n < 1 || n > 999 || missing.length) {
      errors.push(`${name}: ${missing.length ? `parts ${missing.join(", ")} are missing` : "bad part count"}; upload the map again`);
      continue;
    }
    const buf = Buffer.concat(files.map((f) => readFileSync(path.join(paths.incomingDir, f))));
    const sha = createHash("sha256").update(buf).digest("hex");
    if (buf.length !== spec.bytes || sha !== spec.sha256) {
      errors.push(`${name}: the joined parts don't match what was uploaded (${buf.length} bytes); upload the map again`);
      continue;
    }
    const out = path.join(paths.incomingDir, name);
    writeFileSync(out, buf);
    for (const f of files) rmSync(path.join(paths.incomingDir, f));
    rmSync(manifest);
    joined.set(out, manifest);
  }
  return { joined, errors };
}

/** Image candidates in content/incoming (dotfiles and README are ignored). */
export function listIncoming(paths: ContentPaths = contentPaths()): string[] {
  if (!existsSync(paths.incomingDir)) return [];
  return readdirSync(paths.incomingDir)
    .filter((f) => !f.startsWith(".") && !/^readme/i.test(f) && !/\.part\d{3}$|\.parts\.json$/.test(f))
    .sort()
    .map((f) => path.join(paths.incomingDir, f));
}
