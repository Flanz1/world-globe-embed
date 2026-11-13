/**
 * Draws a region onto a 2D canvas. Used for the globe overlay texture, the flat embed, and the admin
 * page's thumbnails and editor, so they all trace the same shape the same way.
 */
import { traceLine } from "./borders.ts";
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

/* ── Layered parts ── */

/** One part as the painter needs it: its polygon (outer ring then holes) and colour. */
export interface PaintPart {
  rings: Position[][];
  color: string;
  /** Per ring: edges shared with another part, left out of this part's coloured outline (see borders.ts). */
  hide?: Set<number>[];
}

/**
 * Everything needed to draw a region. `plain` regions (no overlapping parts, no shared or province
 * borders) are drawn by paintLayers from `layers`, exactly as before; the rest part by part, in order.
 */
export interface PaintSpec {
  plain: boolean;
  layers: { color: string; geometry: RegionGeometry }[];
  parts: PaintPart[];
  /** Per part: the later parts that overlap it. They are layers on top: the part is hidden under them. */
  front: number[][];
  /** National borders (lines parts of different legend colours share) and province borders (lines drawn inside the region), as open polylines. */
  borders?: { national: Position[][]; provincial: Position[][] };
}

/** National borders: dark ink over a light parchment casing; provincial: fine ink dots. Widths in line widths. */
export const BORDER_INK = "rgba(20,14,10,0.95)";
export const BORDER_CASING = "rgba(243,230,200,0.85)";
export const NATIONAL_W = 1;
export const CASING_W = 1.8;
export const PROVINCIAL_W = 1.2;
export const PROVINCIAL_GAP = 2.5;

function tracePoly(ctx: Ctx, rings: Position[][], x: (lon: number) => number, y: (lat: number) => number, offsets: number[], hide?: Set<number>[]): void {
  // Holes in the outer ring's copy, so a clip or fill with evenodd cuts them out at every offset.
  const outer = rings[0] ? unwrapRing(rings[0]) : [];
  const lon0 = outer[0]?.[0] ?? 0;
  rings.forEach((r, i) => {
    let u = i === 0 ? outer : unwrapRing(r);
    if (i > 0 && u.length) {
      const k = Math.round((lon0 - u[0][0]) / 360) * 360;
      if (k) u = u.map(([a, b]) => [a + k, b] as Position);
    }
    const skip = hide?.[i];
    if (skip?.size) traceRingEdges(ctx, u, skip, x, y, offsets);
    else traceRing(ctx, u, x, y, offsets);
  });
}

/** Clips to outside each of the parts in `front` (the layers above one part), so it shows only where they don't cover it. */
function clipOutside(ctx: Ctx, spec: PaintSpec, front: readonly number[], x: (lon: number) => number, y: (lat: number) => number, offsets: number[], area: { w: number; h: number }): void {
  for (const j of front) {
    const q = spec.parts[j];
    if (!q) continue;
    ctx.beginPath();
    // A rectangle well past the canvas, plus the part: with evenodd that's everywhere but the part (its holes included).
    ctx.rect(-area.w * 2, -area.h * 2, area.w * 5, area.h * 5);
    tracePoly(ctx, q.rings, x, y, offsets);
    ctx.clip("evenodd");
  }
}

/** Like traceRing for an outline, leaving out the edges in `skip` (edge i runs from vertex i to i + 1). */
function traceRingEdges(ctx: Ctx, ring: Position[], skip: Set<number>, x: (lon: number) => number, y: (lat: number) => number, offsets: number[]): void {
  // The ring may be closed (last position repeats the first): edges are over the open ring.
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const n = closed ? ring.length - 1 : ring.length;
  if (n < 2) return;
  for (const off of offsets) {
    let pen = false;
    for (let i = 0; i < n; i++) {
      if (skip.has(i)) {
        pen = false;
        continue;
      }
      const a = ring[i];
      const b = i + 1 < ring.length ? ring[i + 1] : ring[0];
      if (!pen) ctx.moveTo(x(a[0] + off), y(a[1]));
      ctx.lineTo(x(b[0] + off), y(b[1]));
      pen = true;
    }
  }
}

/** Draws the borders (see PaintSpec.borders) at line width `lw`. Province borders show only inside the parts (where a part is on top). */
function paintBorders(ctx: Ctx, spec: PaintSpec, x: (lon: number) => number, y: (lat: number) => number, offsets: number[], lw: number, area: { w: number; h: number }): void {
  const b = spec.borders!;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (b.provincial.length) {
    spec.parts.forEach((p, i) => {
      ctx.save();
      clipOutside(ctx, spec, spec.front[i] ?? [], x, y, offsets, area);
      ctx.beginPath();
      tracePoly(ctx, p.rings, x, y, offsets);
      ctx.clip("evenodd");
      ctx.beginPath();
      for (const l of b.provincial) traceLine(ctx, l, x, y, offsets);
      ctx.setLineDash([0.01, PROVINCIAL_GAP * lw]);
      ctx.lineWidth = PROVINCIAL_W * lw;
      ctx.strokeStyle = BORDER_INK;
      ctx.stroke();
      ctx.restore();
    });
  }
  if (b.national.length) {
    ctx.beginPath();
    for (const l of b.national) traceLine(ctx, l, x, y, offsets);
    ctx.lineWidth = CASING_W * lw;
    ctx.strokeStyle = BORDER_CASING;
    ctx.stroke();
    ctx.lineWidth = NATIONAL_W * lw;
    ctx.strokeStyle = BORDER_INK;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draws a region from a PaintSpec. Plain regions go through paintLayers unchanged. Otherwise each part,
 * first to last (bottom layer to top), is filled and outlined in its colour, except where a later part
 * overlapping it covers it; then the borders.
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
  spec.parts.forEach((p, i) => {
    const front = spec.front[i] ?? [];
    if (front.length) {
      ctx.save();
      clipOutside(ctx, spec, front, x, y, offsets, area);
    }
    ctx.beginPath();
    tracePoly(ctx, p.rings, x, y, offsets);
    ctx.globalAlpha = fo;
    ctx.fillStyle = p.color;
    ctx.fill("evenodd");
    ctx.globalAlpha = 1;
    ctx.strokeStyle = p.color;
    ctx.beginPath();
    tracePoly(ctx, p.rings, x, y, offsets, p.hide);
    ctx.stroke();
    if (front.length) ctx.restore();
  });
  if (spec.borders) paintBorders(ctx, spec, x, y, offsets, lw, area);
  ctx.restore();
}
