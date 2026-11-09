/**
 * Draws a region onto a 2D canvas. Used for the globe overlay texture, the flat embed, and the admin
 * page's thumbnails and editor, so they all trace the same shape the same way.
 */
import { polygonsOf, unwrapRing, type RegionGeometry } from "./geo.ts";

/**
 * Adds every ring of `g` to the current path. `x(lon)` and `y(lat)` map unwrapped coordinates to canvas
 * pixels; each ring is drawn once per entry in `offsets` (in degrees of longitude, e.g. [-360, 0, 360]),
 * so shapes that cross the antimeridian show on both sides of a wrapping map.
 */
export function traceGeometry(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  g: RegionGeometry,
  x: (lon: number) => number,
  y: (lat: number) => number,
  offsets: number[] = [0],
): void {
  for (const poly of polygonsOf(g)) {
    for (const ring of poly) {
      const r = unwrapRing(ring);
      if (r.length < 2) continue;
      for (const off of offsets) {
        ctx.moveTo(x(r[0][0] + off), y(r[0][1]));
        for (let i = 1; i < r.length; i++) ctx.lineTo(x(r[i][0] + off), y(r[i][1]));
        ctx.closePath();
      }
    }
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
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  g: RegionGeometry,
  x: (lon: number) => number,
  y: (lat: number) => number,
  offsets: number[],
  s: RegionStyle,
  area: { w: number; h: number },
): void {
  ctx.save();
  if (s.dim) {
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.rect(0, 0, area.w, area.h);
    traceGeometry(ctx, g, x, y, offsets);
    ctx.fill("evenodd");
  }
  ctx.beginPath();
  traceGeometry(ctx, g, x, y, offsets);
  ctx.globalAlpha = Math.max(0, Math.min(1, s.fillOpacity));
  ctx.fillStyle = s.color;
  ctx.fill("evenodd");
  ctx.globalAlpha = 1;
  ctx.lineJoin = "round";
  ctx.lineWidth = s.lineWidth;
  ctx.strokeStyle = s.color;
  ctx.stroke();
  ctx.restore();
}
