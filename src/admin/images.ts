/** Same-origin map images for the admin page's canvases (thumbnails and the region editor), cached. */
import type { MapMeta } from "../shared/types.ts";
import { SITE } from "./dom.ts";

const cache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(url: string): Promise<HTMLImageElement> {
  let p = cache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => {
        cache.delete(url);
        reject(new Error(`couldn't load ${url}`));
      };
      img.src = url;
    });
    cache.set(url, p);
  }
  return p;
}

/** URL of a map's texture of the given width (or the nearest smaller one); LQIP if none is deployed. */
export function mapImageUrl(map: MapMeta, want: 1024 | 2048 | 4096): string {
  for (const w of [want, 2048, 1024] as const) {
    if (w <= want && map.sizes[`${w}`]) return new URL(map.sizes[`${w}`]!, SITE).href;
  }
  return map.lqip;
}

/** Loads the map at `want` width, falling back to smaller sizes and finally the LQIP (e.g. not deployed yet). */
export async function loadMapImage(map: MapMeta, want: 1024 | 2048 | 4096): Promise<HTMLImageElement> {
  const tries = ([4096, 2048, 1024] as const).filter((w) => w <= want && map.sizes[`${w}`]).map((w) => new URL(map.sizes[`${w}`]!, SITE).href);
  for (const u of tries) {
    try {
      return await loadImage(u);
    } catch {
      /* next size */
    }
  }
  return loadImage(map.lqip);
}
