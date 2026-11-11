/**
 * Getting an upload ready in the browser. Up to 16384 px wide the image is shrunk if needed and
 * re-encoded (which drops EXIF). Wider than that, browsers can't hold it on a canvas, so the file goes
 * up as it is, with its metadata segments removed, and process-maps makes every size from it.
 */

/** Widest image re-encoded in the browser; process-maps makes the 16384 tiles from sources this wide. */
export const REENCODE_MAX = 16384;
/** Biggest file sent as is (in parts, see PART_BYTES): GitHub warns about repos growing past a few GB. */
export const PASS_MAX_BYTES = 100 * 1024 * 1024;
/** Files bigger than this go up in parts of this size, which process-maps joins again. GitHub's API
 * refuses single uploads of a few tens of MB ("input too large"), well under its 100 MB file limit. */
export const PART_BYTES = 8 * 1024 * 1024;

export type Kind = "png" | "jpeg" | "webp";

/** Width and height from the file header, without decoding the pixels. */
export function imageSize(b: Uint8Array): { kind: Kind; width: number; height: number } | null {
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: "png", width: u32(16), height: u32(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) {
        i++;
        continue;
      }
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { kind: "jpeg", width: u16(i + 7), height: u16(i + 5) };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + u16(i + 2);
    }
    return null;
  }
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return { kind: "webp", width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { kind: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { kind: "webp", width: le24(24) + 1, height: le24(27) + 1 };
  }
  return null;
}

/**
 * The file without its metadata: JPEG APP1–APP15 segments (EXIF, XMP, IPTC, … but APP2 keeps the
 * colour profile) and comments; PNG text, EXIF and time chunks. Pixels are untouched.
 */
export function stripMetadata(b: Uint8Array, kind: Kind): Uint8Array {
  const parts: Uint8Array[] = [];
  if (kind === "jpeg") {
    parts.push(b.subarray(0, 2));
    let i = 2;
    while (i + 4 <= b.length) {
      const m = b[i + 1];
      if (b[i] !== 0xff) break;
      if (m === 0xda) break; // start of scan: the rest is image data
      const len = (b[i + 2] << 8) | b[i + 3];
      const icc = m === 0xe2 && String.fromCharCode(...b.subarray(i + 4, i + 15)) === "ICC_PROFILE";
      const drop = (m >= 0xe1 && m <= 0xef && !icc) || m === 0xfe;
      if (!drop) parts.push(b.subarray(i, i + 2 + len));
      i += 2 + len;
    }
    parts.push(b.subarray(i));
  } else if (kind === "png") {
    parts.push(b.subarray(0, 8));
    let i = 8;
    while (i + 12 <= b.length) {
      const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
      const end = i + 12 + len;
      if (!["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type)) parts.push(b.subarray(i, end));
      i = end;
    }
  } else return b;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface PreparedImage {
  blob: Blob;
  ext: string;
  w: number;
  h: number;
  /** Extra words for the upload status, e.g. why it's smaller than the original. */
  note: string;
}

function checkShape(w: number, h: number): void {
  const aspect = w / h;
  if (aspect < 1 || aspect > 4) throw new Error(`This image is ${w}×${h}. Globe maps need to be at least as wide as they are tall, and at most 4× as wide.`);
  if (w < 1024) throw new Error(`This image is only ${w}px wide; maps need at least 1024px.`);
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = imageSize(bytes);
  if (info && info.width > REENCODE_MAX) {
    checkShape(info.width, info.height);
    if (info.kind === "webp") throw new Error("WebP can't be wider than 16383 px, so this file looks broken. Save it as JPEG instead.");
    const clean = stripMetadata(bytes, info.kind);
    if (clean.length > PASS_MAX_BYTES)
      throw new Error(
        `This ${info.width} px image is ${(clean.length / 1048576).toFixed(0)} MB, and images wider than ${REENCODE_MAX} px are uploaded as they are, so it has to be under ${PASS_MAX_BYTES / 1048576} MB. ` +
          `Save it as a JPEG at quality 80–90 (a 32768 px map is usually 40–70 MB), or shrink it. For bigger files, ask whoever runs the repo to add it with "npm run import-map".`,
      );
    const ext = info.kind === "jpeg" ? "jpg" : "png";
    return {
      blob: new Blob([clean as BlobPart], { type: `image/${info.kind}` }),
      ext,
      w: info.width,
      h: info.height,
      note: "",
    };
  }

  const bmp = await createImageBitmap(file);
  checkShape(bmp.width, bmp.height);
  try {
    // Full size (up to 16384), then smaller if the browser can't make a canvas that big.
    const first = Math.min(bmp.width, REENCODE_MAX);
    for (const w of [first, ...[8192, 4096].filter((t) => t < first)]) {
      const hgt = Math.round((bmp.height * w) / bmp.width);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = hgt;
      const g = canvas.getContext("2d");
      if (!g) continue;
      g.drawImage(bmp, 0, 0, w, hgt);
      const encode = (type: string, q?: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
      // WebP stops at 16383 px, so a 16384 px image goes up as JPEG.
      let blob = w > 16383 ? await encode("image/jpeg", 0.92) : await encode("image/webp", 0.92);
      if (!blob || !/^image\/(webp|jpeg)$/.test(blob.type)) blob = await encode("image/png");
      canvas.width = canvas.height = 0; // free the canvas memory now, not at GC
      if (!blob) continue;
      const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
      // Say so when the full-size attempt failed, so a smaller upload than expected isn't a mystery.
      const wanted = Math.min(bmp.width, REENCODE_MAX);
      const note =
        w < wanted
          ? ` Your browser couldn't make an image ${wanted} px wide, so it was shrunk to ${w} px and this map won't get the ${wanted >= 16384 ? "16384 tiles" : "8192 version"}. Try Chrome or Edge on a desktop.`
          : "";
      return { blob, ext, w, h: hgt, note };
    }
  } finally {
    bmp.close();
  }
  throw new Error("Your browser couldn't encode the image.");
}
