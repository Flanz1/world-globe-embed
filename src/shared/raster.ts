/**
 * Draws a region onto a 2D canvas. Used for the globe overlay texture, the flat embed, and the admin
 * page's thumbnails and editor, so they all trace the same shape the same way.
 */
import { polygonsOf, unwrapRing, type Position, type RegionGeometry } from "./geo.ts";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Adds one already-unwrapped open ring (once per offset) to the current path. */
export function traceRing(ctx: Ctx, ring: Position[], x: (lon: number) => number, y: (lat: number) => number, offsets: number[] = [0]): void {
  if (ring.length < 2) return;
  for (const off of offsets) {
    ctx.moveTo(x(ring[0][0] + off), y(ring[0][1]));
    for (let i = 1; i < ring.length; i++) ctx.lineTo(x(ring[i][0] + off), y(ring[i][1]));
    ctx.closePath();
  }
}

/**
 * Adds every ring of `g` to the current path. `x(lon)` and `y(lat)` map unwrapped coordinates to canvas
 * pixels; each ring is drawn once per entry in `offsets` (in degrees of longitude, e.g. [-360, 0, 360]),
 * so shapes that cross the antimeridian show on both sides of a wrapping map.
 */
export function traceGeometry(
  ctx: Ctx,
  g: RegionGeometry,
  x: (lon: number) => number,
  y: (lat: number) => number,
  offsets: number[] = [0],
): void {
  for (const poly of polygonsOf(g)) {
    for (const ring of poly) traceRing(ctx, unwrapRing(ring), x, y, offsets);
  }
}

export interface RegionStyle {
  color: string;
  fillOpacity: number;
  /** Border width in canvas pixels. */
  lineWidth: number;
  /** Dim everything outside the region. */
  dim?: boolean;
}

/** Dim (optional), fill and outline a region. The canvas transform and size are the caller's. */
export function paintRegion(
  ctx: Ctx,
  g: RegionGeometry,
  x: (lon: number) => number,
  y: (lat: number) => number,
  offsets: number[],
  s: RegionStyle,
  area: { w: number; h: number },
): void {
  paintLayers(ctx, [{ color: s.color, geometry: g }], x, y, offsets, s, area);
}

/**
 * Like paintRegion, for a region whose parts have different colours (see regionLayers): the dim
 * covers everything outside all of them, then each layer is filled and outlined in its own colour.
 */
export function paintLayers(
  ctx: Ctx,
  layers: { color: string; geometry: RegionGeometry }[],
  x: (lon: number) => number,
  y: (lat: number) => number,
  offsets: number[],
  s: Omit<RegionStyle, "color">,
  area: { w: number; h: number },
): void {
  ctx.save();
  if (s.dim) {
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.rect(0, 0, area.w, area.h);
    for (const l of layers) traceGeometry(ctx, l.geometry, x, y, offsets);
    ctx.fill("evenodd");
  }
  ctx.lineJoin = "round";
  ctx.lineWidth = s.lineWidth;
  for (const l of layers) {
    ctx.beginPath();
    traceGeometry(ctx, l.geometry, x, y, offsets);
    ctx.globalAlpha = Math.max(0, Math.min(1, s.fillOpacity));
    ctx.fillStyle = l.color;
    ctx.fill("evenodd");
    ctx.globalAlpha = 1;
    ctx.strokeStyle = l.color;
    ctx.stroke();
  }
  ctx.restore();
}

/* ── Contested zones and overlaps ── */

/** One part as the painter needs it: its polygon (outer ring then holes), colour, and whether it's a contested zone. */
export interface PaintPart {
  rings: Position[][];
  color: string;
  contested: boolean;
}

/**
 * Everything needed to draw a region. `plain` regions (no contested zones, no overlaps) are drawn by
 * paintLayers from `layers`, exactly as before; the rest by the parts, partners and hatches.
 */
export interface PaintSpec {
  plain: boolean;
  layers: { color: string; geometry: RegionGeometry }[];
  parts: PaintPart[];
  /** Per part: the polygons it overlaps. Its border is dashed inside them and solid elsewhere. */
  partners: Position[][][][];
  /** Overlap areas (inside both a and b) to hatch, in `color`. */
  hatches: { a: Position[][]; b: Position[][]; color: string }[];
}

/** Dash and gap, in multiples of the line width (round caps add half a width to each end of a dash). */
export const DASH = [2, 3] as const;
/** The hatch's opacity on top of the fill. */
const HATCH_ALPHA = 0.55;

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
const patterns = new WeakMap<object, Map<string, CanvasPattern | null>>();

/** A diagonal hatch tile in `color`, its spacing scaled by the line width; cached per canvas. */
function hatchPattern(ctx: Ctx, color: string, lw: number): CanvasPattern | null {
  const key = `${color}|${Math.round(lw * 4)}`;
  let m = patterns.get(ctx.canvas);
  if (!m) patterns.set(ctx.canvas, (m = new Map()));
  if (m.has(key)) return m.get(key)!;
  const s = Math.max(4, Math.round(lw * 4));
  let tile: AnyCanvas;
  if (typeof OffscreenCanvas !== "undefined") tile = new OffscreenCanvas(s, s);
  else {
    tile = document.createElement("canvas");
    tile.width = tile.height = s;
  }
  const t = tile.getContext("2d") as Ctx | null;
  let pat: CanvasPattern | null = null;
  if (t) {
    t.strokeStyle = color;
    t.lineWidth = Math.max(1, lw * 0.45);
    t.lineCap = "square";
    t.beginPath();
    // One diagonal plus the two corner pieces, so the tile repeats seamlessly.
    t.moveTo(0, s);
    t.lineTo(s, 0);
    t.moveTo(-s / 2, s / 2);
    t.lineTo(s / 2, -s / 2);
    t.moveTo(s / 2, s * 1.5);
    t.lineTo(s * 1.5, s / 2);
    t.stroke();
    pat = ctx.createPattern(tile as CanvasImageSource, "repeat");
  }
  m.set(key, pat);
  return pat;
}

function tracePoly(ctx: Ctx, rings: Position[][], x: (lon: number) => number, y: (lat: number) => number, offsets: number[]): void {
  // Holes in the outer ring's copy, so a clip or fill with evenodd cuts them out at every offset.
  const outer = rings[0] ? unwrapRing(rings[0]) : [];
  const lon0 = outer[0]?.[0] ?? 0;
  rings.forEach((r, i) => {
    let u = i === 0 ? outer : unwrapRing(r);
    if (i > 0 && u.length) {
      const k = Math.round((lon0 - u[0][0]) / 360) * 360;
      if (k) u = u.map(([a, b]) => [a + k, b] as Position);
    }
    traceRing(ctx, u, x, y, offsets);
  });
}

/**
 * Draws a region from a PaintSpec. Plain regions go through paintLayers unchanged. Otherwise: fills
 * (normal parts, then contested zones at half opacity with a hatch), hatches over the overlaps, then
 * borders: contested zones dashed all round, normal parts solid outside their partners and dashed inside.
 */
export function paintSpec(
  ctx: Ctx,
  spec: PaintSpec,
  x: (lon: number) => number,
  y: (lat: number) => number,
  offsets: number[],
  s: Omit<RegionStyle, "color">,
  area: { w: number; h: number },
): void {
  if (spec.plain) return paintLayers(ctx, spec.layers, x, y, offsets, s, area);
  const lw = s.lineWidth;
  const fo = Math.max(0, Math.min(1, s.fillOpacity));
  const order = [...spec.parts.keys()].sort((a, b) => Number(spec.parts[a].contested) - Number(spec.parts[b].contested) || a - b);
  ctx.save();
  if (s.dim) {
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.rect(0, 0, area.w, area.h);
    for (const p of spec.parts) tracePoly(ctx, p.rings, x, y, offsets);
    ctx.fill("evenodd");
  }
  ctx.lineJoin = "round";
  ctx.lineWidth = lw;
  // Fills.
  for (const i of order) {
    const p = spec.parts[i];
    ctx.beginPath();
    tracePoly(ctx, p.rings, x, y, offsets);
    ctx.globalAlpha = p.contested ? fo / 2 : fo;
    ctx.fillStyle = p.color;
    ctx.fill("evenodd");
    if (p.contested) {
      const pat = hatchPattern(ctx, p.color, lw);
      if (pat) {
        ctx.globalAlpha = HATCH_ALPHA;
        ctx.fillStyle = pat;
        ctx.fill("evenodd");
      }
    }
  }
  // Hatch where parts overlap.
  ctx.globalAlpha = HATCH_ALPHA;
  for (const hz of spec.hatches) {
    const pat = hatchPattern(ctx, hz.color, lw);
    if (!pat) continue;
    ctx.save();
    ctx.beginPath();
    tracePoly(ctx, hz.a, x, y, offsets);
    ctx.clip("evenodd");
    ctx.beginPath();
    tracePoly(ctx, hz.b, x, y, offsets);
    ctx.clip("evenodd");
    ctx.fillStyle = pat;
    ctx.fillRect(-area.w, -area.h, area.w * 3, area.h * 3);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  // Borders.
  const dashed = () => {
    ctx.setLineDash([DASH[0] * lw, DASH[1] * lw]);
    ctx.lineCap = "round";
  };
  for (const i of order) {
    const p = spec.parts[i];
    const partners = spec.partners[i] ?? [];
    ctx.strokeStyle = p.color;
    const trace = () => {
      ctx.beginPath();
      tracePoly(ctx, p.rings, x, y, offsets);
    };
    if (p.contested) {
      ctx.save();
      dashed();
      trace();
      ctx.stroke();
      ctx.restore();
      continue;
    }
    if (!partners.length) {
      trace();
      ctx.stroke();
      continue;
    }
    // Solid outside every partner: clip to "not inside" each one in turn (big box plus its rings, evenodd).
    ctx.save();
    for (const q of partners) {
      ctx.beginPath();
      ctx.rect(-area.w, -area.h, area.w * 3, area.h * 3);
      tracePoly(ctx, q, x, y, offsets);
      ctx.clip("evenodd");
    }
    trace();
    ctx.stroke();
    ctx.restore();
    // Dashed inside each partner.
    for (const q of partners) {
      ctx.save();
      ctx.beginPath();
      tracePoly(ctx, q, x, y, offsets);
      ctx.clip("evenodd");
      dashed();
      trace();
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}
