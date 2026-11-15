/**
 * The fill tool: click inside an area and get its outline, traced out to the coast and to the
 * borders of other parts and regions. Pure functions, no DOM (unit-tested directly).
 *
 * The lines that bound an area (coast lines, borders) are drawn into a small raster around the click,
 * the area is flood-filled from the click, and the outline of what got filled is walked and returned
 * as a dense ring. The editor then runs that through `followBorders` (snap.ts), so stretches along a
 * border take the border's own vertices and neighbours share it exactly.
 *
 * Positions are [lon, lat] as in model.ts; rings are open and unwrapped, and every ring is also tried
 * shifted by ±360° so an area on the antimeridian fills like any other.
 */
import type { Position } from "../../shared/geo.ts";

/** A line that stops the fill. A closed one also counts its closing edge. */
export interface Barrier {
  pts: readonly Position[];
  closed: boolean;
}

export type FillResult = { ok: true; ring: Position[]; cell: number } | { ok: false; reason: "line" | "open" | "none" };

/** Largest raster side, in cells. */
const MAX_SIDE = 2048;
/** Where the search starts: a window of this many cells a side, doubling until it contains the area. */
const START_SIDE = 128;

const FREE = 0;
const WALL = 1;
const FILLED = 2;

/**
 * Traces the area round `at`. `cell` is the size of a raster cell in degrees of longitude (about one
 * screen pixel); `ky` is the latitude scale of the flat map (2 / aspect). The window grows around the
 * click until the area is closed in; once the raster is as big as allowed the cells grow instead.
 * Fails with "line" when the click is on a line, "open" when the area isn't enclosed (open sea, a gap
 * in the coast), "none" when there's nothing to fill (no lines at all).
 */
export function fillArea(at: Position, barriers: readonly Barrier[], ky: number, cell: number): FillResult {
  if (!barriers.length) return { ok: false, reason: "none" };
  let side = START_SIDE;
  let c = cell;
  for (;;) {
    // Wider than the world and still open: it never will be closed.
    if (side * c >= 360 * 2) return { ok: false, reason: "open" };
    const res = fillWindow(at, barriers, ky, c, side);
    if (res !== "leak") return res;
    if (side < MAX_SIDE) side *= 2;
    else c *= 2;
  }
}

function fillWindow(at: Position, barriers: readonly Barrier[], ky: number, c: number, side: number): FillResult | "leak" {
  const dy = c / ky;
  const lon0 = at[0] - (side / 2) * c;
  const latTop = at[1] + (side / 2) * dy;
  const grid = new Uint8Array(side * side);
  // Cells beyond the poles are walls.
  for (let y = 0; y < side; y++) {
    const lat = latTop - (y + 0.5) * dy;
    if (lat > 90 || lat < -90) grid.fill(WALL, y * side, (y + 1) * side);
  }
  const gx = (lon: number) => (lon - lon0) / c;
  const gy = (lat: number) => (latTop - lat) / dy;
  const box = [lon0, latTop - side * dy, lon0 + side * c, latTop];
  for (const b of barriers) {
    if (b.pts.length < 2) continue;
    let w = Infinity;
    let e = -Infinity;
    let s = Infinity;
    let n = -Infinity;
    for (const [x, y] of b.pts) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
    if (n < box[1] || s > box[3]) continue;
    for (let shift = Math.ceil((box[0] - e) / 360) * 360; w + shift <= box[2]; shift += 360) {
      const m = b.closed ? b.pts.length : b.pts.length - 1;
      for (let i = 0; i < m; i++) {
        const p = b.pts[i];
        const q = b.pts[(i + 1) % b.pts.length];
        drawLine(grid, side, gx(p[0] + shift), gy(p[1]), gx(q[0] + shift), gy(q[1]));
      }
    }
  }
  let sx = Math.floor(gx(at[0]));
  let sy = Math.floor(gy(at[1]));
  if (grid[sy * side + sx] === WALL) {
    // On a line: a free cell right next to it will do.
    let found = false;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      if (grid[(sy + oy) * side + sx + ox] === FREE) {
        sx += ox;
        sy += oy;
        found = true;
        break;
      }
    }
    if (!found) return { ok: false, reason: "line" };
  }
  if (!floodFill(grid, side, sx, sy)) return "leak";
  const ring = traceOutline(grid, side).map(([px, py]) => [lon0 + px * c, latTop - py * dy] as Position);
  return ring.length >= 3 ? { ok: true, ring, cell: c } : { ok: false, reason: "line" };
}

/** Draws a line into the grid so that it has no gaps a 4-connected fill can slip through; clipped to the grid. */
function drawLine(grid: Uint8Array, side: number, x0: number, y0: number, x1: number, y1: number): void {
  // Liang–Barsky clip to [0, side).
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  const max = side - 1e-6;
  if (!clip(-dx, x0) || !clip(dx, max - x0) || !clip(-dy, y0) || !clip(dy, max - y0)) return;
  let ax = Math.floor(x0 + t0 * dx);
  let ay = Math.floor(y0 + t0 * dy);
  const bx = Math.floor(x0 + t1 * dx);
  const by = Math.floor(y0 + t1 * dy);
  const ddx = Math.abs(bx - ax);
  const ddy = -Math.abs(by - ay);
  const stepX = ax < bx ? 1 : -1;
  const stepY = ay < by ? 1 : -1;
  let err = ddx + ddy;
  for (;;) {
    grid[ay * side + ax] = WALL;
    if (ax === bx && ay === by) return;
    const e2 = 2 * err;
    if (e2 >= ddy) {
      err += ddy;
      ax += stepX;
    }
    if (e2 <= ddx) {
      err += ddx;
      ay += stepY;
    }
  }
}

/** Scanline flood fill (4-connected). False when the fill reached the edge of the grid. */
function floodFill(grid: Uint8Array, side: number, sx: number, sy: number): boolean {
  let leaked = false;
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (grid[y * side + x] !== FREE) continue;
    let l = x;
    let r = x;
    while (l > 0 && grid[y * side + l - 1] === FREE) l--;
    while (r < side - 1 && grid[y * side + r + 1] === FREE) r++;
    if (l === 0 || r === side - 1 || y === 0 || y === side - 1) leaked = true;
    for (let i = l; i <= r; i++) grid[y * side + i] = FILLED;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= side) continue;
      let inRun = false;
      for (let i = l; i <= r; i++) {
        const free = grid[ny * side + i] === FREE;
        if (free && !inRun) stack.push(i, ny);
        inRun = free;
      }
    }
  }
  return !leaked;
}

/** Walks the outer boundary of the filled area, returning the middle of every cell edge on it (in cell units, y down). */
function traceOutline(grid: Uint8Array, side: number): Position[] {
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < side && y < side && grid[y * side + x] === FILLED;
  const start = grid.indexOf(FILLED);
  if (start < 0) return [];
  const x0 = start % side;
  const y0 = Math.floor(start / side);
  // Directions: 0 right, 1 down, 2 left, 3 up. The filled cell is on the right-hand side.
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  let x = x0;
  let y = y0;
  let d = 0;
  const out: Position[] = [];
  const limit = 4 * side * side;
  for (let n = 0; n < limit; n++) {
    out.push([x + DX[d] / 2, y + DY[d] / 2]);
    x += DX[d];
    y += DY[d];
    // The cells just ahead of the corner, to the left and to the right of the way on.
    const fl = d === 0 ? filled(x, y - 1) : d === 1 ? filled(x, y) : d === 2 ? filled(x - 1, y) : filled(x - 1, y - 1);
    const fr = d === 0 ? filled(x, y) : d === 1 ? filled(x - 1, y) : d === 2 ? filled(x - 1, y - 1) : filled(x, y - 1);
    if (!fr) d = (d + 1) % 4;
    else if (fl) d = (d + 3) % 4;
    if (x === x0 && y === y0 && d === 0) break;
  }
  return out;
}
