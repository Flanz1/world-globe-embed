/**
 * Paints the globe's region overlay off the main thread. The overlay (up to 8192×4096) is rasterised here, so
 * painting every part's fill, hatching and borders never blocks dragging or zooming; the page only uploads the
 * finished bitmap as a texture. The picture is painted upside down: an ImageBitmap upload ignores flipY.
 *
 * Messages in: { id, w, h, layers?, lineWidth, dim } per paint (the layers are sent only when they changed).
 * Message out: { id, bitmap } with the finished paint.
 */
import { paintLayerStack, type PaintLayer } from "../shared/raster.ts";

let off: OffscreenCanvas | null = null;
let layers: PaintLayer[] = [];

type Msg = { id: number; w: number; h: number; layers?: PaintLayer[]; lineWidth: number; dim: boolean };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.layers) layers = m.layers;
  if (!off || off.width !== m.w || off.height !== m.h) off = new OffscreenCanvas(m.w, m.h);
  const g = off.getContext("2d")!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, m.w, m.h);
  g.setTransform(1, 0, 0, -1, 0, m.h);
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
  const bitmap = off.transferToImageBitmap();
  (self as unknown as Worker).postMessage({ id: m.id, bitmap }, [bitmap]);
};
