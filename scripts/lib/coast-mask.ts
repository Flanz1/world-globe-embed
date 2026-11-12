/**
 * Finds land and open sea in a painted map, and traces the coast between them.
 *
 * The map's sea is one flat colour (found as the most common colour). Everything else is a
 * question of what counts as sea:
 *
 *  - Rivers, river deltas, marsh channels and lakes are often painted in the sea colour too.
 *    They count as land: sea is only what can be reached from the open ocean through water at
 *    least `riverWidth` wide (a morphological opening of the sea colour, kept where it connects
 *    to the ocean). Narrow channels are cut off, and everything they lead to stays land.
 *  - Big inland seas that reach the ocean through a narrow mouth (wider inside than
 *    `inlandSeaWidth`) still count as sea when `inlandSeas` is on.
 *  - Sea names painted in white over the water are not islands: white blobs surrounded by sea
 *    are checked for lettering (crisp edges, pure white, even stroke width) and the lettering goes.
 *    Ice and snow (soft edges, textured, uneven) stay land.
 *  - Name boxes standing in the sea go back to sea, and so does the water they cut off from it.
 *  - Pictures drawn in the sea (ships, mermaids, sea monsters, a whirlpool's black eye and its
 *    swirls) are not islands either: they're inked, so a blob of up to island size whose edge is
 *    mostly near-black line work around a brighter inside goes, and so does a blob that is
 *    nearly all darker than the sea. Painted islands have soft, coloured shores; dark islands
 *    (dark all through, not just at the edge) stay.
 *  - Specks smaller than `minIsland` are dropped.
 *
 * Works on a raw RGB(A) raster; sizes are tuned for a 16384 px wide map and scale with the width.
 * The map wraps east–west, so everything here wraps horizontally.
 */
import type { RawLine } from "../../src/shared/coast.ts";

export interface CoastOptions {
  /** Sea colour; found automatically (most common colour) when left out. */
  seaColour?: [number, number, number];
  /** Largest per-channel difference from the sea colour that still counts as sea (default 22). */
  tolerance?: number;
  /** Water narrower than this many px (at 16384 wide) is river/marsh, not sea (default 5). */
  riverWidth?: number;
  /** Inland seas: water wider than this many px (at 16384 wide) reached through any channel counts as sea (default 50). */
  inlandSeaWidth?: number;
  /** Count big inland seas as sea (default true). Off: only water connected through `riverWidth` is sea. */
  inlandSeas?: boolean;
  /** Smallest island kept, in px at 16384 wide (default 16). */
  minIsland?: number;
  /** Douglas–Peucker tolerance for the traced lines, in px of this raster (default 0.6). */
  simplify?: number;
}

export interface CoastStats {
  seaColour: [number, number, number];
  width: number;
  height: number;
  seaPixels: number;
  /** Sea-coloured pixels that count as land (rivers, lakes, marshes, deltas). */
  inlandWaterPixels: number;
  /** Inland seas counted as sea. */
  inlandSeas: number;
  /** White blobs taken for lettering and removed. */
  labelsRemoved: number;
  /** Name boxes (cream labels) standing mostly in the sea, taken out. */
  boxesRemoved: number;
  /** Pictures in the sea (ships, sea creatures, whirlpools) taken out. */
  decorationsRemoved: number;
  /** Specks dropped. */
  specksRemoved: number;
  lines: number;
  points: number;
}

// Bits of the per-pixel state.
const SEA_COLOUR = 1;
const CORE = 2; // eroded sea connected to the ocean
const REACH = 4; // sea colour connected to the ocean at any width
const SEA = 8; // final: open sea
const SEEN = 16; // flood-fill scratch

/** Most common colour, from a sample of the raster, quantized to 4 levels. */
export function findSeaColour(rgb: Uint8Array, w: number, h: number, ch: number): [number, number, number] {
  const counts = new Map<number, number>();
  const n = w * h;
  const step = Math.max(1, Math.floor(n / 2_000_000)) | 1;
  for (let i = 0; i < n; i += step) {
    const o = i * ch;
    const k = ((rgb[o] >> 2) << 12) | ((rgb[o + 1] >> 2) << 6) | (rgb[o + 2] >> 2);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 0;
  let bestN = -1;
  for (const [k, c] of counts)
    if (c > bestN) {
      bestN = c;
      best = k;
    }
  return [((best >> 12) << 2) + 2, (((best >> 6) & 63) << 2) + 2, ((best & 63) << 2) + 2];
}

/**
 * Squared Euclidean distance from every pixel with `inside(i)` to the nearest pixel without it,
 * capped at cap² (Felzenszwalb–Huttenlocher, two passes). Wraps east–west; beyond the top and
 * bottom edges counts as inside, so the edges don't erode anything.
 */
export function distance2(inside: (i: number) => boolean, w: number, h: number, cap: number): Uint16Array {
  const big = Math.min(255, cap);
  const g = new Uint8Array(w * h);
  // Columns: distance to the nearest outside pixel above or below.
  for (let x = 0; x < w; x++) {
    let d = big;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      d = inside(i) ? Math.min(big, d + 1) : 0;
      g[i] = d;
    }
    d = big;
    for (let y = h - 1; y >= 0; y--) {
      const i = y * w + x;
      d = g[i] === 0 ? 0 : Math.min(big, d + 1);
      if (d < g[i]) g[i] = d;
    }
  }
  // Rows: lower envelope of parabolas over the row padded by `cap` px from the other side.
  const pad = Math.min(w, cap + 1);
  const n = w + 2 * pad;
  const f = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const out = new Uint16Array(w * h);
  const cap2 = Math.min(65535, cap * cap);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let q = 0; q < n; q++) {
      const x = (((q - pad) % w) + w) % w;
      const gv = g[row + x];
      f[q] = gv * gv;
    }
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      if (q < pad || q >= pad + w) continue;
      const d = (q - v[k]) * (q - v[k]) + f[v[k]];
      out[row + q - pad] = d > cap2 ? cap2 : d;
    }
  }
  return out;
}

/** Growable int stack for flood fills. */
class Stack {
  a = new Int32Array(1 << 16);
  n = 0;
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  pop() {
    return this.a[--this.n];
  }
}

/**
 * Flood fill (4-connected, wrapping east–west) from `seed` over pixels where `ok(i)`, setting
 * `bit` on each. Calls `visit` for each pixel. Pixels that already have `bit` are not entered.
 */
function flood(st: Uint8Array, w: number, h: number, seed: number, bit: number, ok: (i: number) => boolean, stack: Stack, visit?: (i: number) => void) {
  if (st[seed] & bit || !ok(seed)) return;
  st[seed] |= bit;
  stack.push(seed);
  while (stack.n) {
    const i = stack.pop();
    visit?.(i);
    const x = i % w;
    const y = (i - x) / w;
    const nb = [y > 0 ? i - w : -1, y < h - 1 ? i + w : -1, x > 0 ? i - 1 : i + w - 1, x < w - 1 ? i + 1 : i - w + 1];
    for (const j of nb)
      if (j >= 0 && !(st[j] & bit) && ok(j)) {
        st[j] |= bit;
        stack.push(j);
      }
  }
}

/** Features of a white blob that tell lettering from ice; see buildLandMask. Exported for tests. */
export function looksLikeLettering(rgb: Uint8Array, ch: number, w: number, pixels: Int32Array, count: number, seaLike: (i: number) => boolean): boolean {
  const f = letteringFeatures(rgb, ch, w, pixels, count, seaLike);
  if (!f) return false;
  const votes = +(f.trans < 0.9) + +(f.white > 0.38) + +(f.roughness >= 0 && f.roughness < 0.75) + +(f.cv >= 0 && f.cv < 0.6);
  // Drifting ice only shows up towards the poles; away from them one sign of lettering is enough.
  return votes >= (Math.abs(f.lat) < 45 ? 1 : 2);
}

export interface LetteringFeatures {
  trans: number;
  white: number;
  roughness: number;
  cv: number;
  /** Latitude of the blob's middle. */
  lat: number;
}

export function letteringFeatures(
  rgb: Uint8Array,
  ch: number,
  w: number,
  pixels: Int32Array,
  count: number,
  seaLike: (i: number) => boolean,
): LetteringFeatures | null {
  // Bounding box (blobs crossing the seam are left alone: there's no lettering that big).
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < count; k++) {
    const i = pixels[k];
    const x = i % w;
    const y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 - x0 > w / 2) return null;
  const M = 6;
  const bx = x0 - M;
  const by = y0 - M;
  const cw = x1 - x0 + 1 + 2 * M;
  const chh = y1 - y0 + 1 + 2 * M;
  const H = (Math.floor(rgb.length / ch) / w) | 0;
  const m = new Uint8Array(cw * chh); // 1 = blob
  const ink = new Uint8Array(cw * chh); // blob and not sea-coloured
  const gray = new Float32Array(cw * chh);
  for (let cy = 0; cy < chh; cy++)
    for (let cx = 0; cx < cw; cx++) {
      const x = (((bx + cx) % w) + w) % w;
      const y = Math.min(H - 1, Math.max(0, by + cy));
      const o = (y * w + x) * ch;
      gray[cy * cw + cx] = (rgb[o] + rgb[o + 1] + rgb[o + 2]) / 3;
    }
  for (let k = 0; k < count; k++) {
    const i = pixels[k];
    const x = i % w;
    const y = (i - x) / w;
    const c = (y - by) * cw + (x - bx);
    m[c] = 1;
    if (!seaLike(i)) ink[c] = 1;
  }
  const at = (a: Uint8Array, x: number, y: number) => (x < 0 || y < 0 || x >= cw || y >= chh ? 0 : a[y * cw + x]);
  const step = (a: Uint8Array, grow: boolean) => {
    const b = new Uint8Array(a.length);
    for (let y = 0; y < chh; y++)
      for (let x = 0; x < cw; x++) {
        const s = at(a, x, y) + at(a, x - 1, y) + at(a, x + 1, y) + at(a, x, y - 1) + at(a, x, y + 1);
        b[y * cw + x] = grow ? (s > 0 ? 1 : 0) : s === 5 ? 1 : 0;
      }
    return b;
  };
  // 1. Edge crispness: anti-aliased lettering has ~1 px of in-between colour per px of outline,
  //    soft-edged ice has more.
  let per = 0;
  const e1 = step(m, false);
  for (let i = 0; i < m.length; i++) if (m[i] && !e1[i]) per++;
  let d5 = m;
  let e5 = m;
  for (let k = 0; k < 5; k++) {
    d5 = step(d5, true);
    e5 = step(e5, false);
  }
  let mid = 0;
  for (let i = 0; i < m.length; i++) if (d5[i] && !e5[i] && gray[i] > 70 && gray[i] < 200) mid++;
  const trans = mid / Math.max(1, per);
  // 2. Pure white: lettering is (near) 255 in green and blue; ice is a grey-white.
  let bright = 0;
  let tw = 0;
  for (let cy = 0; cy < chh; cy++)
    for (let cx = 0; cx < cw; cx++) {
      const c = cy * cw + cx;
      if (!ink[c]) continue;
      const x = (((bx + cx) % w) + w) % w;
      const o = ((by + cy) * w + x) * ch;
      const r = rgb[o];
      const g = rgb[o + 1];
      const b = rgb[o + 2];
      if (Math.min(r, g, b) < 200) continue;
      bright++;
      if (g >= 254 && b >= 254 && r >= 236) tw++;
    }
  const white = tw / Math.max(1, bright);
  // 3. Flat inside: lettering is one colour, ice is textured.
  // (Bright pixels only: some lettering has a dark outline, which isn't part of the stroke.)
  const lit = new Uint8Array(cw * chh);
  for (let c = 0; c < lit.length; c++) if (ink[c] && gray[c] >= 200) lit[c] = 1;
  const dInk = localDist(lit, cw, chh);
  const roughAt = (depth: number): number => {
    let inner = 0;
    let rough = 0;
    for (let y = 1; y < chh - 1; y++)
      for (let x = 1; x < cw - 1; x++) {
        const c = y * cw + x;
        if (dInk[c] < depth) continue;
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += gray[c + dy * cw + dx];
        rough += Math.abs(gray[c] - s / 9);
        inner++;
      }
    return inner >= 20 ? rough / inner : -1;
  };
  // Thin strokes have hardly any pixels 3 deep: look 2 deep then.
  let roughness = roughAt(3);
  if (roughness < 0) roughness = roughAt(2);
  // 4. Even strokes: distance-to-edge along the middle of the strokes hardly varies for lettering.
  const dM = localDist(m, cw, chh);
  let rn = 0;
  let rs = 0;
  let rss = 0;
  for (let y = 1; y < chh - 1; y++)
    for (let x = 1; x < cw - 1; x++) {
      const c = y * cw + x;
      const d = dM[c];
      if (d <= 1.5) continue;
      let ridge = true;
      for (let dy = -1; dy <= 1 && ridge; dy++) for (let dx = -1; dx <= 1; dx++) if (dM[c + dy * cw + dx] > d) ridge = false;
      if (!ridge) continue;
      rn++;
      rs += d;
      rss += d * d;
    }
  const cv = rn > 5 ? Math.sqrt(Math.max(0, rss / rn - (rs / rn) ** 2)) / (rs / rn) : -1;
  return { trans, white, roughness, cv, lat: 90 - ((y0 + y1) / 2 / H) * 180 };
}

/** Exact distance to the nearest 0 for a small crop (outside the crop counts as 0). */
function localDist(a: Uint8Array, w: number, h: number): Float32Array {
  const cap = Math.max(w, h) + 1;
  const d2 = distance2Box(a, w, h, cap);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.sqrt(d2[i]);
  return out;
}

function distance2Box(a: Uint8Array, w: number, h: number, cap: number): Float64Array {
  const g = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    let d = 0;
    for (let y = 0; y < h; y++) {
      d = a[y * w + x] ? d + 1 : 0;
      g[y * w + x] = d;
    }
    d = 0;
    for (let y = h - 1; y >= 0; y--) {
      d = a[y * w + x] ? d + 1 : 0;
      if (d < g[y * w + x]) g[y * w + x] = d;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!a[y * w + x]) continue;
      let best = cap * cap;
      // Outside the crop is 0: the edges are at distance x+1, w-x, y-ish.
      best = Math.min(best, (x + 1) ** 2, (w - x) ** 2);
      for (let q = 0; q < w; q++) {
        const dx = q - x;
        if (dx * dx >= best) continue;
        const gv = g[y * w + q];
        const v = dx * dx + gv * gv;
        if (v < best) best = v;
      }
      out[y * w + x] = best;
    }
  return out;
}

/** Cream of the parchment name boxes ("Tiazol" etc.). */
const isCream = (r: number, g: number, b: number) => r >= 225 && g >= 200 && g <= 252 && b >= 160 && b <= 225 && r - b >= 28;

/**
 * Name boxes (cream rectangles with the name in them) that stand mostly in the sea would make
 * square islands or bumps on the coast: they go back to sea. Boxes mostly on land stay land.
 * Returns how many were removed.
 */
function removeLabelBoxes(rgb: Uint8Array, ch: number, w: number, h: number, st: Uint8Array, s: number, stack: Stack): number[][] {
  const n = w * h;
  const cream = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    if (isCream(rgb[o], rgb[o + 1], rgb[o + 2])) cream[i] = 1;
  }
  // Close the cream (grow 3 px, shrink 3 px) so the lettering inside a box becomes part of it.
  const r = Math.max(1, Math.round(3 * s));
  const grown = distance2((i) => !cream[i], w, h, r + 2);
  const shrunk = distance2((i) => grown[i] <= r * r, w, h, r + 2);
  const box = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (grown[i] <= r * r && shrunk[i] > r * r) box[i] = 1;
  const minArea = 300 * s * s;
  const maxArea = 60000 * s * s;
  const removed: number[][] = [];
  let buf = new Int32Array(1 << 14);
  const BOXSEEN = 2;
  for (let i0 = 0; i0 < n; i0++) {
    if (box[i0] !== 1) continue;
    let count = 0;
    let x0 = w;
    let x1 = 0;
    let y0 = h;
    let y1 = 0;
    box[i0] = BOXSEEN;
    stack.push(i0);
    while (stack.n) {
      const i = stack.pop();
      if (count === buf.length) {
        const b = new Int32Array(buf.length * 2);
        b.set(buf);
        buf = b;
      }
      buf[count++] = i;
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const j of [y > 0 ? i - w : -1, y < h - 1 ? i + w : -1, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1])
        if (j >= 0 && box[j] === 1) {
          box[j] = BOXSEEN;
          stack.push(j);
        }
    }
    // A box: big enough, and filling most of its bounding rectangle.
    const rect = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count < minArea || count > maxArea || count < 0.8 * rect) continue;
    // Look at a band 3–6 px outside the rectangle (outside its dark frame).
    let seaN = 0;
    let all = 0;
    const m0 = Math.max(3, Math.round(3 * s));
    const m1 = Math.max(6, Math.round(6 * s));
    for (let y = y0 - m1; y <= y1 + m1; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = x0 - m1; x <= x1 + m1; x++) {
        if (x >= x0 - m0 && x <= x1 + m0 && y >= y0 - m0 && y <= y1 + m0) continue;
        const i = y * w + ((x + w) % w);
        all++;
        if (st[i] & SEA) seaN++;
      }
    }
    if (seaN < 0.5 * all) continue;
    // Into the sea with it, frame included.
    for (let y = y0 - m0; y <= y1 + m0; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = x0 - m0; x <= x1 + m0; x++) st[y * w + ((x + w) % w)] |= SEA;
    }
    removed.push([x0 - m0, y0 - m0, x1 + m0, y1 + m0]);
  }
  return removed;
}

/**
 * Water a removed name box was standing in front of (between the box and the shore) was cut off
 * from the sea by the box: it is opened again around each box, the same way as the whole map
 * (water at least `riverR` deep, connected to the sea, grown back), so rivers behind it stay land.
 */
function reopenAroundBoxes(st: Uint8Array, w: number, h: number, rects: number[][], riverR: number, margin: number) {
  const cap = Math.ceil(riverR) + 2;
  const r2 = riverR * riverR;
  const b2 = (riverR + 0.5) ** 2;
  for (const [rx0, ry0, rx1, ry1] of rects) {
    // A window around the box, padded with `cap` px of land so its edges add nothing.
    const X0 = rx0 - margin - cap;
    const Y0 = Math.max(0, ry0 - margin) - cap;
    const lw = rx1 + margin + cap - X0 + 1;
    const lh = Math.min(h - 1, ry1 + margin) + cap - Y0 + 1;
    const gi = (lx: number, ly: number) => {
      const y = Y0 + ly;
      if (lx < cap || lx >= lw - cap || ly < cap || ly >= lh - cap || y < 0 || y >= h) return -1;
      return y * w + ((((X0 + lx) % w) + w) % w);
    };
    const idx = new Int32Array(lw * lh);
    for (let ly = 0; ly < lh; ly++) for (let lx = 0; lx < lw; lx++) idx[ly * lw + lx] = gi(lx, ly);
    const water = (li: number) => idx[li] >= 0 && (st[idx[li]] & (SEA_COLOUR | SEA)) !== 0;
    const d2 = distance2(water, lw, lh, cap);
    // Deep water connected to the sea that's already there.
    const open = new Uint8Array(lw * lh);
    const stack: number[] = [];
    for (let li = 0; li < lw * lh; li++)
      if (d2[li] > r2 && st[idx[li]] & SEA) {
        open[li] = 1;
        stack.push(li);
      }
    while (stack.length) {
      const li = stack.pop()!;
      const lx = li % lw;
      for (const lj of [li - lw, li + lw, lx > 0 ? li - 1 : -1, lx < lw - 1 ? li + 1 : -1])
        if (lj >= 0 && lj < lw * lh && !open[lj] && d2[lj] > r2) {
          open[lj] = 1;
          stack.push(lj);
        }
    }
    const back = distance2((li) => !open[li], lw, lh, cap);
    for (let li = 0; li < lw * lh; li++) if (idx[li] >= 0 && back[li] <= b2 && st[idx[li]] & SEA_COLOUR) st[idx[li]] |= SEA;
  }
}

export interface LandMask {
  /** 1 = land, 0 = open sea; width × height. */
  land: Uint8Array;
  width: number;
  height: number;
  stats: Omit<CoastStats, "lines" | "points">;
}

const lum3 = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

/** Offsets within Manhattan distance 3 (the band along a blob's edge). */
const EDGE_BAND: [number, number][] = [];
for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if ((dx || dy) && Math.abs(dx) + Math.abs(dy) <= 3) EDGE_BAND.push([dx, dy]);

/**
 * How inked a land blob looks: `dark` is the share of its pixels darker than the sea, `edgeInk` the
 * share of near-black pixels in the 3 px band along its edge, `lum` its mean brightness.
 */
export function inkFeatures(
  rgb: Uint8Array,
  ch: number,
  w: number,
  h: number,
  st: Uint8Array,
  pixels: Int32Array,
  count: number,
  seaLum: number,
): { dark: number; edgeInk: number; lum: number } {
  let dark = 0;
  let band = 0;
  let ink = 0;
  let sum = 0;
  for (let k = 0; k < count; k++) {
    const i = pixels[k];
    const o = i * ch;
    const l = lum3(rgb[o], rgb[o + 1], rgb[o + 2]);
    sum += l;
    if (l < 0.86 * seaLum) dark++;
    const x = i % w;
    const y = (i - x) / w;
    let edge = false;
    for (const [dx, dy] of EDGE_BAND) {
      const yy = y + dy;
      if (yy < 0 || yy >= h || st[yy * w + ((x + dx + w) % w)] & SEA) {
        edge = true;
        break;
      }
    }
    if (edge) {
      band++;
      if (l < 0.68 * seaLum) ink++;
    }
  }
  return { dark: dark / count, edgeInk: band ? ink / band : 0, lum: sum / count };
}

/** Land/sea mask of a raw raster (channels 3 or 4). See the file comment for the rules. */
export function buildLandMask(rgb: Uint8Array, w: number, h: number, ch: number, opts: CoastOptions = {}): LandMask {
  const s = w / 16384;
  const tol = opts.tolerance ?? 22;
  const riverR = Math.max(1, ((opts.riverWidth ?? 5) * s) / 2);
  const inlandR = ((opts.inlandSeaWidth ?? 50) * s) / 2;
  const minIsland = Math.max(2, (opts.minIsland ?? 16) * s * s);
  const maxLabel = 2_000_000 * s * s;
  // Pictures in the sea: from a few hundred px to the size of a big ship or sea monster.
  const minDecoration = 300 * s * s;
  const maxDecoration = 80_000 * s * s;
  const sea = opts.seaColour ?? findSeaColour(rgb, w, h, ch);
  // Blobs mostly in shades between the sea colour and white are checked for lettering (outlined
  // lettering has dark outline pixels, so away from the poles, where there's no drifting ice, half is enough).
  const [wr, wg, wb] = [255 - sea[0], 255 - sea[1], 255 - sea[2]];
  const wl2 = wr * wr + wg * wg + wb * wb;
  const midLatitude = (y0: number, y1: number) => Math.abs(90 - ((y0 + y1) / 2 / h) * 180) < 45;
  const n = w * h;
  const st = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    if (Math.abs(rgb[o] - sea[0]) <= tol && Math.abs(rgb[o + 1] - sea[1]) <= tol && Math.abs(rgb[o + 2] - sea[2]) <= tol) st[i] = SEA_COLOUR;
  }
  const seaLike = (i: number) => (st[i] & SEA_COLOUR) !== 0;
  const cap = Math.ceil(Math.max(riverR, inlandR)) + 2;
  const d2 = distance2(seaLike, w, h, cap);
  // The ocean: the eroded sea around the point farthest from any shore.
  let seed = 0;
  for (let i = 1; i < n; i++) if (d2[i] > d2[seed]) seed = i;
  const stack = new Stack();
  const r2 = riverR * riverR;
  const deep = (i: number) => d2[i] > r2;
  flood(st, w, h, seed, CORE, deep, stack);
  let inlandSeas = 0;
  if (opts.inlandSeas !== false) {
    flood(st, w, h, seed, REACH, seaLike, stack);
    const in2 = inlandR * inlandR;
    for (let i = 0; i < n; i++)
      if (d2[i] >= in2 && st[i] & REACH && !(st[i] & CORE)) {
        flood(st, w, h, i, CORE, deep, stack);
        inlandSeas++;
      }
  }
  // Grow the eroded sea back by the same radius, within the sea colour (the opening).
  const back = distance2((i) => !(st[i] & CORE), w, h, Math.ceil(riverR) + 2);
  const b2 = (riverR + 0.5) ** 2;
  let seaPixels = 0;
  let seaColourPixels = 0;
  for (let i = 0; i < n; i++) {
    if (st[i] & SEA_COLOUR) seaColourPixels++;
    if (st[i] & SEA_COLOUR && back[i] <= b2) {
      st[i] |= SEA;
      seaPixels++;
    }
  }
  const boxes = removeLabelBoxes(rgb, ch, w, h, st, s, stack);
  const boxesRemoved = boxes.length;
  reopenAroundBoxes(st, w, h, boxes, riverR, Math.ceil(40 * s));
  // Land blobs (8-connected): lettering and pictures go back to sea, specks go.
  let labelsRemoved = 0;
  let decorationsRemoved = 0;
  let specksRemoved = 0;
  const seaLum = lum3(sea[0], sea[1], sea[2]);
  let buf = new Int32Array(1 << 16);
  for (let i0 = 0; i0 < n; i0++) {
    if (st[i0] & (SEA | SEEN)) continue;
    let count = 0;
    let ink = 0;
    let white = 0;
    let yMin = h;
    let yMax = 0;
    st[i0] |= SEEN;
    stack.push(i0);
    while (stack.n) {
      const i = stack.pop();
      if (count < maxLabel + 1) {
        if (count === buf.length) {
          const b = new Int32Array(buf.length * 2);
          b.set(buf);
          buf = b;
        }
        buf[count] = i;
      }
      count++;
      const yy0 = (i / w) | 0;
      if (yy0 < yMin) yMin = yy0;
      if (yy0 > yMax) yMax = yy0;
      if (!(st[i] & SEA_COLOUR)) {
        ink++;
        const o = i * ch;
        // On the line from the sea colour to white: white lettering and its anti-aliased edge, or ice.
        const pr = rgb[o] - sea[0];
        const pg = rgb[o + 1] - sea[1];
        const pb = rgb[o + 2] - sea[2];
        const t = Math.max(0, Math.min(1, (pr * wr + pg * wg + pb * wb) / wl2));
        if (Math.hypot(pr - t * wr, pg - t * wg, pb - t * wb) <= 20) white++;
      }
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = (x + dx + w) % w;
          const j = yy * w + xx;
          if (!(st[j] & (SEA | SEEN))) {
            st[j] |= SEEN;
            stack.push(j);
          }
        }
      }
    }
    let drop = false;
    if (count < minIsland) {
      drop = true;
      specksRemoved++;
    } else if (count <= maxLabel && white > (midLatitude(yMin, yMax) ? 0.5 : 0.6) * ink && looksLikeLettering(rgb, ch, w, buf, count, seaLike)) {
      drop = true;
      labelsRemoved++;
    } else if (count <= maxDecoration) {
      const { dark, edgeInk, lum } = inkFeatures(rgb, ch, w, h, st, buf, count, seaLum);
      if (dark >= 0.8 || (count >= minDecoration && edgeInk >= 0.2 && lum >= 1.4 * seaLum)) {
        drop = true;
        decorationsRemoved++;
      }
    }
    if (drop) for (let k = 0; k < count; k++) st[buf[k]] |= SEA;
  }
  const land = new Uint8Array(n);
  let finalSea = 0;
  for (let i = 0; i < n; i++) {
    if (st[i] & SEA) finalSea++;
    else land[i] = 1;
  }
  return {
    land,
    width: w,
    height: h,
    stats: {
      seaColour: sea,
      width: w,
      height: h,
      seaPixels: finalSea,
      inlandWaterPixels: seaColourPixels - seaPixels,
      inlandSeas,
      labelsRemoved,
      boxesRemoved,
      decorationsRemoved,
      specksRemoved,
    },
  };
}

/**
 * Traces the land/sea boundary (marching squares through pixel centres, land kept on the left)
 * into lines of half-pixel image coordinates, simplified by Douglas–Peucker. Lines are continuous
 * across the east–west seam (x may run past the width); lines that reach the top or bottom row stay open.
 */
export function traceCoast(land: Uint8Array, w: number, h: number, simplify = 0.6): RawLine[] {
  // Edge ids: horizontal edge between pixel (x,y) and (x+1,y) → 2(yw+x); vertical between (x,y) and (x,y+1) → 2(yw+x)+1.
  const next = new Map<number, number>();
  const hasIn = new Set<number>();
  const Hd = (x: number, y: number) => 2 * (y * w + (x % w));
  const Vd = (x: number, y: number) => 2 * (y * w + (x % w)) + 1;
  const link = (a: number, b: number) => {
    next.set(a, b);
    hasIn.add(b);
  };
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w; x++) {
      const x1 = (x + 1) % w;
      const a = land[y * w + x];
      const b = land[y * w + x1];
      const c = land[(y + 1) * w + x1];
      const d = land[(y + 1) * w + x];
      const idx = (a << 3) | (b << 2) | (c << 1) | d;
      if (idx === 0 || idx === 15) continue;
      const T = Hd(x, y);
      const B = Hd(x, y + 1);
      const L = Vd(x, y);
      const R = Vd(x + 1, y);
      switch (idx) {
        case 8: link(L, T); break; // a
        case 4: link(T, R); break; // b
        case 2: link(R, B); break; // c
        case 1: link(B, L); break; // d
        case 7: link(T, L); break; // not a
        case 11: link(R, T); break; // not b
        case 13: link(B, R); break; // not c
        case 14: link(L, B); break; // not d
        case 12: link(L, R); break; // a b
        case 6: link(T, B); break; // b c
        case 3: link(R, L); break; // c d
        case 9: link(B, T); break; // d a
        case 10: link(R, T); link(L, B); break; // a c (land joined through the middle)
        case 5: link(T, L); link(B, R); break; // b d
      }
    }
  // Half-pixel image coordinates of an edge's midpoint (pixel centre = index + 0.5).
  const pos = (e: number): [number, number] => {
    const k = e >> 1;
    const x = k % w;
    const y = (k - x) / w;
    return e & 1 ? [2 * x + 1, 2 * y + 2] : [2 * x + 2, 2 * y + 1];
  };
  const lines: RawLine[] = [];
  const done = new Set<number>();
  const walk = (start: number) => {
    const xs: number[] = [];
    let e: number | undefined = start;
    let off = 0;
    let px = NaN;
    while (e !== undefined && !done.has(e)) {
      done.add(e);
      const [x0, y] = pos(e);
      let x = x0 + off;
      if (!Number.isNaN(px) && Math.abs(x - px) > w) {
        const shift = x > px ? -2 * w : 2 * w;
        off += shift;
        x += shift;
      }
      xs.push(x, y);
      px = x;
      e = next.get(e);
    }
    const closed = e === start;
    lines.push({ xy: simplifyLine(xs, closed, 2 * simplify, 2 * w), closed });
  };
  for (const e of next.keys()) if (!hasIn.has(e)) walk(e);
  for (const e of next.keys()) if (!done.has(e)) walk(e);
  return lines.filter((l) => l.xy.length >= (l.closed ? 6 : 4));
}

/** Douglas–Peucker on flat [x0,y0,x1,y1,…]; closed lines are split at the point farthest from the first. */
function simplifyLine(xs: number[], closed: boolean, tol: number, period: number): Int32Array {
  const n = xs.length / 2;
  if (n <= 3) return Int32Array.from(xs);
  // Where the closing point (the first one again) sits, continuing from the last point.
  const last = xs[2 * (n - 1)];
  const endX = xs[0] + period * Math.round((last - xs[0]) / period);
  const keep = new Uint8Array(n + 1);
  const P = (i: number) => (i === n ? 0 : i);
  const dp = (s0: number, e0: number) => {
    const stack = [s0, e0];
    keep[s0] = keep[e0] = 1;
    while (stack.length) {
      const e = stack.pop()!;
      const s = stack.pop()!;
      const ax = xs[2 * P(s)];
      const ay = xs[2 * P(s) + 1];
      const bx = e === n ? endX : xs[2 * e];
      const by = xs[2 * P(e) + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      let best = -1;
      let bestD = tol;
      for (let i = s + 1; i < e; i++) {
        const px = xs[2 * i] - ax;
        const py = xs[2 * i + 1] - ay;
        const d = len ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py);
        if (d > bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) {
        keep[best] = 1;
        stack.push(s, best, best, e);
      }
    }
  };
  if (closed) {
    let far = 1;
    let farD = -1;
    for (let i = 1; i < n; i++) {
      const d = Math.hypot(xs[2 * i] - xs[0], xs[2 * i + 1] - xs[1]);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    dp(0, far);
    dp(far, n);
  } else dp(0, n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(xs[2 * i], xs[2 * i + 1]);
  return Int32Array.from(out);
}
