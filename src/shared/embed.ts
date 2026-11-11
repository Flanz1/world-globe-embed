/** Embed snippets for regions. Uses the same escapeHtml as the slot snippet and the page generator. */
import { escapeHtml } from "./page.ts";
import { clamp } from "./params.ts";

/* ── Embed code ── */

export interface EmbedOptions {
  view: "globe" | "flat";
  height: number;
  label: boolean;
  dim: boolean;
  lock: boolean;
  /** Show the region's legend (key=0 hides it). */
  key: boolean;
  /** Mark overlaps with other regions on the same slot (clash=0 turns it off). */
  clash: boolean;
}

export const defaultEmbedOptions = (region: { label?: boolean }): EmbedOptions => ({
  view: "globe",
  height: 480,
  label: region.label ?? true,
  dim: false,
  lock: true,
  key: true,
  clash: true,
});

/** v/<slot>/?region=<id>&view=… with only the params that differ from the defaults. */
export function regionEmbedUrl(site: string | URL, slot: string, region: { id: string; label?: boolean }, o: EmbedOptions): string {
  const q = new URLSearchParams({ region: region.id, view: o.view });
  if (o.label !== (region.label ?? true)) q.set("label", o.label ? "1" : "0");
  if (o.dim) q.set("dim", "1");
  if (!o.lock) q.set("lock", "0");
  if (o.key === false) q.set("key", "0");
  if (o.clash === false) q.set("clash", "0");
  return new URL(`v/${encodeURIComponent(slot)}/?${q}`, site).href;
}

export function regionEmbedCode(
  site: string | URL,
  slot: string,
  slotTitle: string,
  region: { id: string; name: string; label?: boolean },
  o: EmbedOptions,
): string {
  const height = Math.round(clamp(Number.isFinite(o.height) ? o.height : 480, 100, 2000));
  return (
    `<iframe src="${escapeHtml(regionEmbedUrl(site, slot, region, o))}"\n` +
    `        width="100%" height="${height}" style="border:0;border-radius:8px;background:transparent"\n` +
    `        loading="lazy" allow="fullscreen" title="${escapeHtml(`${region.name} (${slotTitle})`)}"></iframe>`
  );
}
