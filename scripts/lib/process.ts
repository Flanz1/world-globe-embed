/** Turns an uploaded equirectangular image into WebP textures + LQIP + metadata. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp, { type Sharp } from "sharp";
import { TEXTURE_WIDTHS, type MapMeta, type TextureWidth } from "../../src/shared/types.ts";
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
  const meta = await sharp(buf).metadata();
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
}

export async function processImage(file: string, opts: ProcessOptions): Promise<MapMeta> {
  const paths = opts.paths ?? contentPaths();
  const info = await inspect(file);
  if (info.errors.length) throw new Error(info.errors.join("\n"));
  const buf = readFileSync(file);
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  // .rotate() applies EXIF orientation; sharp drops EXIF/ICC/XMP metadata on output by default.
  const base = sharp(buf, { limitInputPixels: 16384 * 8192 }).rotate();
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
      .webp({ quality: w === 4096 ? 80 : 82, effort: 5, smartSubsample: true })
      .toFile(path.join(outDir, name));
    sizes[`${w as TextureWidth}`] = `maps/${info.id}/${name}`;
  }
  // Remove textures from earlier uploads of the same map id.
  const keep = new Set(Object.values(sizes).map((p) => path.basename(p!)));
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
    lqip: await makeLqip(base, aspect),
  };
  mkdirSync(paths.mapsDir, { recursive: true });
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
  if (opts.removeSource !== false) unlinkSync(file);
  return meta;
}

/** Image candidates in content/incoming (dotfiles and README are ignored). */
export function listIncoming(paths: ContentPaths = contentPaths()): string[] {
  if (!existsSync(paths.incomingDir)) return [];
  return readdirSync(paths.incomingDir)
    .filter((f) => !f.startsWith(".") && !/^readme/i.test(f))
    .sort()
    .map((f) => path.join(paths.incomingDir, f));
}
