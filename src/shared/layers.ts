/**
 * Layer order for regions saved before parts were layers. Back then overlapping parts were all drawn
 * (the overlap hatched); now a later part covers an earlier one. To keep what was visible, the parts
 * that overlap another part are put in order of size, largest at the bottom, so a small part inside a
 * big one stays on top. Parts that overlap nothing keep their place. No DOM.
 */
import { findClashes, prepare } from "./clash.ts";
import { polygonsOf, sphericalArea, type RegionGeometry } from "./geo.ts";
import { migrateZoneColours, normalizePartLegend, type RegionFeature } from "./region.ts";

/** The new order of the parts (new index → old index), or null when nothing needs to move. */
export function legacyLayerOrder(g: RegionGeometry): number[] | null {
  const polys = polygonsOf(g);
  const clashes = findClashes(polys.map((p) => prepare(p)));
  if (!clashes.length) return null;
  const involved = [...new Set(clashes.flat())].sort((a, b) => a - b);
  const area = (i: number) => sphericalArea({ type: "Polygon", coordinates: polys[i] });
  const bySize = [...involved].sort((a, b) => area(b) - area(a) || a - b);
  const order = polys.map((_, i) => i);
  involved.forEach((slot, k) => (order[slot] = bySize[k]));
  return order.every((v, i) => v === i) ? null : order;
}

/** The region with its parts (and per-part lists) in `order` (new index → old index). Other fields are kept. */
export function reorderFeature(f: RegionFeature, order: readonly number[]): RegionFeature {
  const polys = polygonsOf(f.geometry);
  const p = f.properties;
  const pick = <T>(a: readonly T[] | undefined): T[] | undefined => (a && a.length === polys.length ? order.map((i) => a[i]) : a ? [...a] : undefined);
  const { partContested, ...rest } = p;
  // An old contested zone keeps the colour it was drawn in.
  const legend = p.partLegend || partContested ? migrateZoneColours(normalizePartLegend(p.partLegend, polys.length, p.legend?.length ?? 0), partContested) : undefined;
  return {
    ...f,
    properties: {
      ...rest,
      ...(legend && p.legend?.length ? { partLegend: pick(legend)! } : {}),
      ...(p.partLabels ? { partLabels: pick(p.partLabels)! } : {}),
      ...(p.partLabelHidden ? { partLabelHidden: pick(p.partLabelHidden)! } : {}),
      ...(p.partLocked ? { partLocked: pick(p.partLocked)! } : {}),
    },
    geometry: { type: "MultiPolygon", coordinates: order.map((i) => polys[i]) },
  };
}
