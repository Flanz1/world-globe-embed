/**
 * Paints the globe's region overlay off the main thread. The overlay canvas (up to 8192×4096) is handed over
 * as an OffscreenCanvas, so rasterising every part's fill, hatching and borders never blocks dragging or zooming;
 * the page only uploads the finished canvas as a texture.
 *
 * Messages in: { init: OffscreenCanvas } once, then { id, w, h, layers?, lineWidth, dim } per paint (the layers
 * are sent only when they changed). Message out: { id } once that paint is on the canvas.
 */
import { paintLayerStack, type PaintLayer } from "../shared/raster.ts";

let off: OffscreenCanvas | null = null;
let layers: PaintLayer[] = [];

type Msg = { init: OffscreenCanvas } | { id: number; w: number; h: number; layers?: PaintLayer[]; lineWidth: number; dim: boolean };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if ("init" in m) {
    off = m.init;
    return;
  }
  if (!off) return;
  if (m.layers) layers = m.layers;
  if (off.width !== m.w || off.height !== m.h) {
    off.width = m.w;
    off.height = m.h;
  }
  const g = off.getContext("2d")!;
  g.clearRect(0, 0, m.w, m.h);
  // Map-image frame → texture pixels, exactly like the map texture's own UVs.
  paintLayerStack(
    g,
    layers,
    (lon) => ((lon + 180) / 360) * m.w,
    (lat) => ((90 - lat) / 180) * m.h,
    [-360, 0, 360],
    { lineWidth: m.lineWidth, dim: m.dim },
    { w: m.w, h: m.h },
  );
  // Reply in a later task: the canvas commits its frame when this one ends.
  setTimeout(() => (self as unknown as Worker).postMessage({ id: m.id }), 0);
};
