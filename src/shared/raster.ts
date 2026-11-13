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

/** One part as the painter needs it: its polygon (outer ring then holes), colour, and whether it's an occupied area (it leaves the borders under it as they are). */
export interface PaintPart {
  rings: Position[][];
  color: string;
  occupied?: boolean;
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
  /** Per part: the later parts that overlap it (province borders are drawn once, in the topmost part). */
  front: number[][];
  /** Per part: every part that overlaps it. */
  overlaps: number[][];
  /**
   * Contested land: each area covered by exactly `parts` (overlapping each other, of two or more colours),
   * which `outside` (the other parts overlapping them) don't cover. Filled with equal stripes of `colors`,
   * and the parts' borders through it dashed in those colours, except that an occupied area leaves the
   * borders of the parts under it as they are (see paintSpec).
   */
  cells: { parts: number[]; colors: string[]; outside: number[] }[];
  /** National borders (lines parts of different legend colours share) and province borders (lines drawn inside the region), as open polylines. */
  borders?: { national: Position[][]; provincial: Position[][] };
}

/** National borders: dark ink over a light parchment casing; provincial: fine ink dashes, thinner than the outline and longer than their gaps. Widths and lengths in line widths. */
export const BORDER_INK = "rgba(20,14,10,0.95)";
export const BORDER_CASING = "rgba(243,230,200,0.85)";
export const NATIONAL_W = 1;
export const CASING_W = 1.8;
export const PROVINCIAL_W = 0.6;
export const PROVINCIAL_DASH = 5;
export const PROVINCIAL_GAP = 2.5;

/** Contested stripes: their opacity, and their width in line widths (every colour's stripe is the same width). */
const STRIPE_ALPHA = 0.5;
const STRIPE_W = 2.5;
/** Contested borders: each colour's dash, in line widths. */
const CONTESTED_DASH = 4;

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
const patterns = new WeakMap<object, Map<string, CanvasPattern | null>>();

/**
 * Diagonal stripes cycling through `colors` ("" for a transparent stripe), each `w` px wide (along x) and
 * `colors` repeated over and over; cached per canvas.
 */
function stripePattern(ctx: Ctx, colors: readonly string[], w: number): CanvasPattern | null {
  const key = `${colors.join(",")}|${w}`;
  let m = patterns.get(ctx.canvas);
  if (!m) patterns.set(ctx.canvas, (m = new Map()));
  if (m.has(key)) return m.get(key)!;
  const n = colors.length;
  const s = w * n;
  let tile: AnyCanvas;
  if (typeof OffscreenCanvas !== "undefined") tile = new OffscreenCanvas(s, s);
  else {
    tile = document.createElement("canvas");
    tile.width = tile.height = s;
  }
  const t = tile.getContext("2d") as Ctx | null;
  let pat: CanvasPattern | null = null;
  if (t) {
    // The band where x + y runs from c to c + w, for each colour, over two periods so the tile wraps seamlessly.
    for (let j = 0; j < 2; j++)
      colors.forEach((c, k) => {
        if (!c) return;
        const c0 = j * s + k * w;
        t.beginPath();
        t.moveTo(c0, 0);
        t.lineTo(c0 + w, 0);
        t.lineTo(c0 + w - s, s);
        t.lineTo(c0 - s, s);
        t.closePath();
        t.fillStyle = c;
        t.fill();
      });
    pat = ctx.createPattern(tile as CanvasImageSource, "repeat");
  }
  m.set(key, pat);
  return pat;
}
/** Equal contested stripes of every colour. */
const contestedStripes = (ctx: Ctx, colors: readonly string[], lw: number) => stripePattern(ctx, colors, Math.max(2, Math.round(lw * STRIPE_W)));

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
      ctx.lineCap = "butt";
      ctx.setLineDash([PROVINCIAL_DASH * lw, PROVINCIAL_GAP * lw]);
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
 * Draws a region from a PaintSpec. Plain regions go through paintLayers unchanged. Otherwise each part is
 * filled and outlined in its colour where no part of another colour overlaps it; contested land (parts of
 * several colours overlapping) gets equal stripes of all of them and borders dashed in all of them;
 * an occupied area does the same, but leaves the borders of the parts under it solid, as they were;
 * then the national and province borders.
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
  const clipCell = (cell: PaintSpec["cells"][number]) => {
    for (const j of cell.parts) {
      ctx.beginPath();
      tracePoly(ctx, spec.parts[j].rings, x, y, offsets);
      ctx.clip("evenodd");
    }
    clipOutside(ctx, spec, cell.outside, x, y, offsets, area);
  };
  // Fills: each part where no part of another colour overlaps it (and, within one colour, only once).
  spec.parts.forEach((p, i) => {
    const out = (spec.overlaps[i] ?? []).filter((j) => j > i || spec.parts[j]?.color !== p.color);
    ctx.save();
    clipOutside(ctx, spec, out, x, y, offsets, area);
    ctx.beginPath();
    tracePoly(ctx, p.rings, x, y, offsets);
    ctx.globalAlpha = fo;
    ctx.fillStyle = p.color;
    ctx.fill("evenodd");
    ctx.restore();
  });
  // Contested land: equal stripes of every colour there.
  for (const cell of spec.cells) {
    const pat = contestedStripes(ctx, cell.colors, lw);
    if (!pat) continue;
    ctx.save();
    clipCell(cell);
    ctx.globalAlpha = Math.max(fo, STRIPE_ALPHA);
    ctx.fillStyle = pat;
    ctx.fillRect(-area.w, -area.h, area.w * 3, area.h * 3);
    ctx.restore();
  }
  // Borders: a thin solid line in the part's colour, inset so touching parts keep both their lines…
  const outline = (p: PaintPart) => () => tracePoly(ctx, p.rings, x, y, offsets, p.hide);
  const interior = (p: PaintPart) => () => tracePoly(ctx, p.rings, x, y, offsets);
  // (An occupied area doesn't change the borders under it: they stay solid through it.)
  spec.parts.forEach((p, i) => {
    ctx.save();
    clipOutside(ctx, spec, (spec.overlaps[i] ?? []).filter((j) => p.occupied || !spec.parts[j]?.occupied), x, y, offsets, area);
    ctx.strokeStyle = p.color;
    insetStroke(ctx, lw, outline(p), interior(p));
    ctx.restore();
  });
  // …and where it runs through contested land, equal dashes of every colour there (each colour starting where the last one stops).
  const dash = CONTESTED_DASH * lw;
  ctx.globalAlpha = 1;
  for (const cell of spec.cells) {
    ctx.save();
    clipCell(cell);
    // A normal part's border is dashed only in the colours of the normal parts here (occupied areas leave it be).
    const normal = [...new Set(cell.parts.filter((i) => !spec.parts[i].occupied).map((i) => spec.parts[i].color))];
    for (const i of cell.parts) {
      const colors = spec.parts[i].occupied ? cell.colors : normal.length >= 2 ? normal : [];
      const n = colors.length;
      colors.forEach((c, k) => {
        ctx.setLineDash([dash, dash * (n - 1)]);
        ctx.lineDashOffset = ((n - k) % n) * dash;
        ctx.strokeStyle = c;
        insetStroke(ctx, lw, outline(spec.parts[i]), interior(spec.parts[i]));
      });
    }
    ctx.restore();
  }
  ctx.setLineDash([]);
  if (spec.borders) paintBorders(ctx, spec, x, y, offsets, lw, area);
  ctx.restore();
}
