import type { ViewerConfig } from "../shared/types.ts";

/** JSON inlined into each slot page as <script type="application/json" id="wge-data">. */
export interface BootData {
  cfg: ViewerConfig;
  /** URL of the viewer module, relative to the slot page. */
  globe: string;
}

/** What boot.ts hands to the viewer module's start(). */
export interface StartContext {
  cfg: ViewerConfig;
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  firstTexture: Promise<Blob>;
}
