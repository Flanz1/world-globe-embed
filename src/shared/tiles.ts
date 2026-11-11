/**
 * Tile levels above 8192: the map at 16384 (and 32768) px wide, cut into square tiles, so a zoomed-in
 * view loads only the few tiles it shows instead of a whole texture of half a gigabyte or more.
 * Shared by process-maps (cutting), the page generator (config) and both viewers (picking tiles).
 */

/** Widths cut into tiles, smallest first. A level is made only when the source is at least that wide. */
export const TILE_LEVELS = [16384, 32768] as const;
export type TileLevelWidth = (typeof TILE_LEVELS)[number];
/** Tile edge in px. */
export const TILE_SIZE = 2048;
/** Most tiles a viewer keeps decoded at once (2048² RGBA without mipmaps is 16 MB each). */
export const TILE_BUDGET = 16;

/** One tile level as stored in map metadata and handed to the viewer. */
export interface TileLevel {
  w: number;
  h: number;
  size: number;
  cols: number;
  rows: number;
  /** Path prefix: tile (c, r) is `${url}-${c}-${r}.webp`. */
  url: string;
}

export const tileUrl = (l: TileLevel, c: number, r: number): string => `${l.url}-${c}-${r}.webp`;

/** Grid for a level of width `w` over an image of the given aspect (width / height). */
export function tileGrid(w: number, aspect: number, size = TILE_SIZE): Omit<TileLevel, "url"> {
  const h = Math.round(w / aspect);
  return { w, h, size, cols: Math.ceil(w / size), rows: Math.ceil(h / size) };
}

/** Where tile (c, r) sits, as fractions of the image: [u0, v0, u1, v1], v measured from the top. */
export function tileRect(l: Omit<TileLevel, "url">, c: number, r: number): [number, number, number, number] {
  return [(c * l.size) / l.w, (r * l.size) / l.h, Math.min(l.w, (c + 1) * l.size) / l.w, Math.min(l.h, (r + 1) * l.size) / l.h];
}

/**
 * Tiles under a set of points in image fractions (u wraps around, v is clamped), plus their
 * neighbours when `pad` is set, nearest the first point first. Points are samples of what is on screen.
 */
export function tilesAt(l: Omit<TileLevel, "url">, points: readonly [number, number][], pad = false): [number, number][] {
  const seen = new Map<string, [number, number]>();
  const add = (c: number, r: number) => {
    const cc = ((c % l.cols) + l.cols) % l.cols;
    if (r < 0 || r >= l.rows) return;
    seen.set(`${cc},${r}`, [cc, r]);
  };
  for (const [u, v] of points) {
    const uu = u - Math.floor(u);
    const c = Math.min(l.cols - 1, Math.floor((uu * l.w) / l.size));
    const r = Math.min(l.rows - 1, Math.max(0, Math.floor((Math.min(1, Math.max(0, v)) * l.h) / l.size)));
    add(c, r);
    if (pad) for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) add(c + dc, r + dr);
  }
  return [...seen.values()];
}

/** The tile level to show for a wanted texture width: the largest one at or below ~1.37× want, if any. */
export function levelFor<T extends { w: number }>(levels: readonly T[] | undefined, want: number): T | undefined {
  // Same ratio as the whole textures: 4096 from want 3000, 8192 from 6000, so 16384 from 12000.
  return levels?.filter((l) => want >= l.w * 0.73).pop();
}

/** A small least-recently-used cache of decoded tiles. */
export class TileCache<V> {
  private m = new Map<string, V>();
  constructor(
    private budget: number,
    private dispose: (v: V) => void,
  ) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  has(k: string): boolean {
    return this.m.has(k);
  }
  /** Adds a tile; evicts the least recently used ones beyond the budget, except those in `keep`. */
  set(k: string, v: V, keep: ReadonlySet<string> = new Set()): void {
    this.m.set(k, v);
    for (const old of this.m.keys()) {
      if (this.m.size <= this.budget) break;
      if (old === k || keep.has(old)) continue;
      this.dispose(this.m.get(old)!);
      this.m.delete(old);
    }
  }
  entries(): IterableIterator<[string, V]> {
    return this.m.entries();
  }
  clear(): void {
    for (const v of this.m.values()) this.dispose(v);
    this.m.clear();
  }
  get size(): number {
    return this.m.size;
  }
}
