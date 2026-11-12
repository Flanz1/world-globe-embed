/**
 * Coastlines of a map, for snapping region edges to the shore in the admin editor.
 *
 * scripts/lib/coast-mask.ts finds land and open sea in the map texture and traces the boundary
 * into polylines; this module stores them compactly ("<hash>-coast.bin" next to the textures). The
 * editor snaps to them (src/admin/editor/coast.ts).
 *
 * Coordinates are [lon, lat] in the map image's frame (see geo.ts). A line may run past ±180
 * (it is kept continuous across the antimeridian); callers wrap positions they keep.
 *
 * File layout (little-endian): "WGC1", u32 width, u32 height, u32 line count, then per line:
 * varint point count, varint flags (bit 0: closed), then the points in half-pixel units of a
 * width × height raster, the first absolute and the rest as deltas, all zig-zag varints.
 */

export interface CoastLine {
  /** Flat [lon0, lat0, lon1, lat1, …]; a closed line does not repeat its first point. */
  pts: Float64Array;
  closed: boolean;
}

export interface CoastData {
  /** Raster the lines were traced on (half-pixel resolution is 360 / (2 * width) degrees). */
  width: number;
  height: number;
  lines: CoastLine[];
}

/** A line as integer half-pixel coordinates, the way the tracer makes it. */
export interface RawLine {
  xy: Int32Array;
  closed: boolean;
}

const MAGIC = [0x57, 0x47, 0x43, 0x31]; // "WGC1"

/* ── Encoding ── */

export function encodeCoast(width: number, height: number, lines: RawLine[]): Uint8Array {
  let cap = 16 + lines.reduce((n, l) => n + 10 + l.xy.length * 3, 0);
  let buf = new Uint8Array(cap);
  let o = 0;
  const ensure = (n: number) => {
    if (o + n <= cap) return;
    cap = Math.max(cap * 2, o + n);
    const b = new Uint8Array(cap);
    b.set(buf);
    buf = b;
  };
  const u32 = (v: number) => {
    ensure(4);
    buf[o++] = v & 255;
    buf[o++] = (v >>> 8) & 255;
    buf[o++] = (v >>> 16) & 255;
    buf[o++] = (v >>> 24) & 255;
  };
  const varint = (v: number) => {
    ensure(6);
    while (v >= 128) {
      buf[o++] = (v & 127) | 128;
      v = Math.floor(v / 128);
    }
    buf[o++] = v;
  };
  const zz = (v: number) => varint(v >= 0 ? v * 2 : -v * 2 - 1);
  for (const b of MAGIC) buf[o++] = b;
  u32(width);
  u32(height);
  u32(lines.length);
  for (const l of lines) {
    const n = l.xy.length / 2;
    varint(n);
    varint(l.closed ? 1 : 0);
    let px = 0;
    let py = 0;
    for (let i = 0; i < n; i++) {
      const x = l.xy[2 * i];
      const y = l.xy[2 * i + 1];
      zz(x - px);
      zz(y - py);
      px = x;
      py = y;
    }
  }
  return buf.slice(0, o);
}

export function decodeCoast(data: ArrayBuffer | Uint8Array): CoastData {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (buf.length < 16 || MAGIC.some((b, i) => buf[i] !== b)) throw new Error("not a coast file");
  let o = 4;
  const u32 = () => {
    const v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24);
    o += 4;
    return v >>> 0;
  };
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (o >= buf.length) throw new Error("coast file is cut short");
      const b = buf[o++];
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
  };
  const zz = () => {
    const v = varint();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  const width = u32();
  const height = u32();
  const count = u32();
  const kx = 360 / (2 * width);
  const ky = 180 / (2 * height);
  const lines: CoastLine[] = [];
  for (let l = 0; l < count; l++) {
    const n = varint();
    const closed = (varint() & 1) === 1;
    const pts = new Float64Array(n * 2);
    let x = 0;
    let y = 0;
    for (let i = 0; i < n; i++) {
      x += zz();
      y += zz();
      pts[2 * i] = x * kx - 180;
      pts[2 * i + 1] = 90 - y * ky;
    }
    lines.push({ pts, closed });
  }
  return { width, height, lines };
}
