/**
 * Region facts: what a reader sees when they click a part in a region embed. Everything is computed at build time
 * (scripts/generate-pages.ts writes facts/<region>.json) and fetched on the first click, so the embed does no
 * geometry work and the Worker is never involved. Pure data, no DOM.
 *
 * Per part (polygon): its share of the whole world, the regions it borders (shared edges, matched within a small
 * tolerance), and the pins inside it. Shares are fractions of the whole sphere in the globe frame (after pole
 * padding), so the embed turns them into km² with the slot's world radius.
 */
import {
  imageToGlobe,
  lonDelta,
  mapGeometry,
  pointInPolygon,
  polygonsOf,
  sphericalArea,
  unwrapRing,
  type GlobeFrame,
  type Position,
  type Ring,
} from "./geo.ts";
import { PIN_ID, PIN_NAME_MAX, isPinKind, type PinKind } from "./pins.ts";
import { REGION_ID, nameFromId } from "./region.ts";

export const FACTS_VERSION = 1;
/** Most neighbours and pins kept per part (the card shows fewer; the rest is a count). */
export const FACTS_LIST_MAX = 24;
export const FACTS_NAME_MAX = 80;

export interface FactsPart {
  /** Share of the whole sphere (0–1). */
  a: number;
  /** Indices into `FactsFile.r` of the regions this part borders, the longest shared border first. */
  n?: number[];
  /** Indices into `FactsFile.i` of the pins inside this part. */
  i?: number[];
}

export interface FactsFile {
  v: typeof FACTS_VERSION;
  /** Sum of the parts' shares. */
  t: number;
  p: FactsPart[];
  /** Neighbouring regions. */
  r: { id: string; name: string }[];
  /** Pins inside the parts: pin map and kind are kept so the embed shows only the pins its ?pins= selects. */
  i: { name: string; kind: PinKind; map?: string }[];
}

export { nameFromId };

/** A region as facts need it. */
export interface FactsRegion {
  id: string;
  name: string;
  geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
  /** Regions only count as each other's neighbours inside one group (e.g. countries with countries, not with religions). */
  group: string;
}

export interface FactsPin {
  name: string;
  kind: PinKind;
  pinMap?: string;
  at: Position;
}

/** Two vertices closer than this (in degrees) are on the same border. Coordinates are stored to 4 decimals. */
export const BORDER_TOLERANCE = 0.004;
/** Hits (vertices of one part on the other's border, both directions) needed to count as bordering. A lone touching corner doesn't. */
export const MIN_BORDER_HITS = 3;
const CELL = 0.05;

const cellKey = (x: number, y: number): number => Math.floor((((x + 180) % 360) + 360) % 360 / CELL) * 8192 + Math.floor((y + 90) / CELL);

interface Seg {
  part: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** Distance in degrees from p to the segment, with p's longitude moved to the segment's copy of the world. */
function distToSeg(px: number, py: number, s: Seg): number {
  const x = s.ax + lonDelta(s.ax, px);
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (py - s.ay) * dy) / len2));
  return Math.hypot(x - (s.ax + t * dx), py - (s.ay + t * dy));
}

/**
 * For every part of every region: the other regions of its group that it shares a border with. Returns, per
 * region (by index), per part, the neighbour region indices ordered by how many border vertices matched.
 */
export function bordering(regions: readonly FactsRegion[]): number[][][] {
  // Flatten to parts; a part is its outer ring and holes.
  const parts: { region: number; rings: Ring[] }[] = [];
  regions.forEach((r, ri) => {
    for (const poly of polygonsOf(r.geometry)) parts.push({ region: ri, rings: poly.map((ring) => unwrapRing(ring)) });
  });
  // Index every edge by the cells it passes through.
  const grid = new Map<number, Seg[]>();
  parts.forEach((p, pi) => {
    for (const ring of p.rings) {
      for (let k = 0; k + 1 < ring.length; k++) {
        const [ax, ay] = ring[k];
        const [bx, by] = ring[k + 1];
        const seg: Seg = { part: pi, ax, ay, bx, by };
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL / 2)));
        const seen = new Set<number>();
        for (let s = 0; s <= steps; s++) {
          const x = ax + ((bx - ax) * s) / steps;
          const y = ay + ((by - ay) * s) / steps;
          // The tolerance can reach into the next cell: register the neighbours of the cell a sample is in.
          for (const k2 of [cellKey(x, y), cellKey(x + BORDER_TOLERANCE, y), cellKey(x - BORDER_TOLERANCE, y), cellKey(x, y + BORDER_TOLERANCE), cellKey(x, y - BORDER_TOLERANCE)]) {
            if (seen.has(k2)) continue;
            seen.add(k2);
            const list = grid.get(k2);
            if (list) list.push(seg);
            else grid.set(k2, [seg]);
          }
        }
      }
    }
  });
  // Count, for each (part, other part), the vertices of the first that lie on the second's border.
  const hits = new Map<string, number>();
  parts.forEach((p, pi) => {
    const mine = new Map<number, number>();
    for (const ring of p.rings) {
      for (let k = 0; k + 1 < ring.length; k++) {
        const [x, y] = ring[k];
        const found = new Set<number>();
        for (const s of grid.get(cellKey(x, y)) ?? []) {
          const other = parts[s.part];
          if (s.part === pi || other.region === p.region || regions[other.region].group !== regions[p.region].group || found.has(s.part)) continue;
          if (distToSeg(x, y, s) <= BORDER_TOLERANCE) found.add(s.part);
        }
        for (const o of found) mine.set(o, (mine.get(o) ?? 0) + 1);
      }
    }
    for (const [o, n] of mine) {
      const key = pi < o ? `${pi}:${o}` : `${o}:${pi}`;
      hits.set(key, (hits.get(key) ?? 0) + n);
    }
  });
  // Per part: region → total hits.
  const perPart = parts.map(() => new Map<number, number>());
  for (const [key, n] of hits) {
    if (n < MIN_BORDER_HITS) continue;
    const [a, b] = key.split(":").map(Number);
    perPart[a].set(parts[b].region, (perPart[a].get(parts[b].region) ?? 0) + n);
    perPart[b].set(parts[a].region, (perPart[b].get(parts[a].region) ?? 0) + n);
  }
  const out: number[][][] = regions.map(() => []);
  parts.forEach((p, pi) => {
    out[p.region].push([...perPart[pi]].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([r]) => r));
  });
  return out;
}

/** Facts for every region. `pins` are the pins of the regions' slot, in the map image's frame like the regions. */
export function computeFacts(regions: readonly FactsRegion[], pins: readonly FactsPin[], frame: GlobeFrame): Map<string, FactsFile> {
  const borders = bordering(regions);
  const out = new Map<string, FactsFile>();
  regions.forEach((r, ri) => {
    const polys = polygonsOf(r.geometry);
    const nbr: number[] = [];
    const pinIdx: number[] = [];
    const parts: FactsPart[] = polys.map((poly, pi) => {
      const area = sphericalArea(mapGeometry({ type: "Polygon", coordinates: poly }, (p) => imageToGlobe(p, frame))) / (4 * Math.PI);
      const part: FactsPart = { a: Number(area.toPrecision(5)) };
      const ns = (borders[ri][pi] ?? []).slice(0, FACTS_LIST_MAX).map((rj) => {
        let k = nbr.indexOf(rj);
        if (k < 0) k = nbr.push(rj) - 1;
        return k;
      });
      if (ns.length) part.n = ns;
      const inside: number[] = [];
      pins.forEach((pin, pj) => {
        if (inside.length < FACTS_LIST_MAX && pointInPolygon(pin.at, poly)) {
          let k = pinIdx.indexOf(pj);
          if (k < 0) k = pinIdx.push(pj) - 1;
          inside.push(k);
        }
      });
      if (inside.length) part.i = inside;
      return part;
    });
    out.set(r.id, {
      v: FACTS_VERSION,
      t: Number(parts.reduce((s, p) => s + p.a, 0).toPrecision(5)),
      p: parts,
      r: nbr.map((rj) => ({ id: regions[rj].id, name: regions[rj].name })),
      i: pinIdx.map((pj) => ({ name: pins[pj].name, kind: pins[pj].kind, ...(pins[pj].pinMap ? { map: pins[pj].pinMap } : {}) })),
    });
  });
  return out;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const idx = (v: unknown, n: number): number[] | undefined =>
  Array.isArray(v) ? v.filter((k): k is number => Number.isInteger(k) && k >= 0 && k < n).slice(0, FACTS_LIST_MAX) : undefined;
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** Validates a fetched facts file; null if it isn't one. Anything inside that doesn't fit is dropped (never trusted as is). */
export function parseFacts(j: unknown, parts: number): FactsFile | null {
  const f = j as Partial<FactsFile> | null;
  if (!f || typeof f !== "object" || f.v !== FACTS_VERSION || !Array.isArray(f.p) || f.p.length !== parts || !finite(f.t) || !Array.isArray(f.r) || !Array.isArray(f.i)) return null;
  const r = f.r
    .slice(0, 500)
    .map((x) => x as { id?: unknown; name?: unknown })
    .map((x) => (x && REGION_ID.test(String(x.id)) && str(x.name, FACTS_NAME_MAX) ? { id: x.id as string, name: x.name } : null));
  const i = f.i
    .slice(0, 2000)
    .map((x) => x as { name?: unknown; kind?: unknown; map?: unknown })
    .map((x) => (x && str(x.name, PIN_NAME_MAX) && isPinKind(x.kind) ? { name: x.name, kind: x.kind, ...(typeof x.map === "string" && PIN_ID.test(x.map) ? { map: x.map } : {}) } : null));
  const p: FactsPart[] = [];
  for (const raw of f.p) {
    const q = raw as Partial<FactsPart> | null;
    if (!q || !finite(q.a) || q.a < 0 || q.a > 1) return null;
    const n = idx(q.n, r.length)?.filter((k) => r[k]);
    const pi = idx(q.i, i.length)?.filter((k) => i[k]);
    p.push({ a: q.a, ...(n?.length ? { n } : {}), ...(pi?.length ? { i: pi } : {}) });
  }
  return {
    v: FACTS_VERSION,
    t: Math.max(0, Math.min(1, f.t)),
    p,
    r: r.map((x) => x ?? { id: "x", name: "" }),
    i: i.map((x) => x ?? { name: "", kind: "other" as PinKind }),
  };
}
