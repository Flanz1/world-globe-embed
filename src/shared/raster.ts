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
    const trace = () => traceGeometry(ctx, l.geometry, x, y, offsets);
    ctx.beginPath();
    trace();
    ctx.globalAlpha = Math.max(0, Math.min(1, s.fillOpacity));
    ctx.fillStyle = l.color;
    ctx.fill("evenodd");
    ctx.globalAlpha = 1;
    ctx.strokeStyle = l.color;
    insetStroke(ctx, s.lineWidth, trace);
  }
  ctx.restore();
}

/**
 * Strokes an outline that sits just inside the shape: double width, clipped to the shape's own interior.
 * Where two parts touch, each keeps its own line beside the other's instead of one covering the other.
 * `trace` draws the lines to stroke, `interior` the closed shape to clip to (the same unless edges are left out).
 */
function insetStroke(ctx: Ctx, lw: number, trace: () => void, interior: () => void = trace): void {
  ctx.save();
  ctx.beginPath();
  interior();
  ctx.clip("evenodd");
  ctx.beginPath();
  trace();
  ctx.lineWidth = lw * 2;
  ctx.stroke();
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
  /**
   * Per part: the later parts that overlap it. They are layers on top: where they overlap, the overlap is
   * contested, filled in the upper part's colour (the main one) and hatched in this part's (the secondary).
   */
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

/** The contested hatch's opacity on top of the fill. */
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
 * overlapping it covers it; a part's overlaps with the parts under it are hatched in their colours
 * (contested: the upper colour is the main one, the lower the secondary); then the borders.
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
    // Contested: where this part covers earlier ones, hatch the overlap in each covered part's colour.
    spec.front.forEach((f, j) => {
      if (j >= i || !f.includes(i) || spec.parts[j].color === p.color) return;
      const pat = hatchPattern(ctx, spec.parts[j].color, lw);
      if (!pat) return;
      ctx.save();
      ctx.beginPath();
      tracePoly(ctx, spec.parts[j].rings, x, y, offsets);
      ctx.clip("evenodd");
      ctx.beginPath();
      tracePoly(ctx, p.rings, x, y, offsets);
      ctx.globalAlpha = HATCH_ALPHA;
      ctx.fillStyle = pat;
      ctx.fill("evenodd");
      ctx.restore();
    });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = p.color;
    // Every border is a thin solid line, inset so touching parts keep both their lines.
    insetStroke(
      ctx,
      lw,
      () => tracePoly(ctx, p.rings, x, y, offsets, p.hide),
      () => tracePoly(ctx, p.rings, x, y, offsets),
    );
    if (front.length) ctx.restore();
  });
  if (spec.borders) paintBorders(ctx, spec, x, y, offsets, lw, area);
  ctx.restore();
}
