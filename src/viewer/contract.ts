import type { RegionData, RegionIndexEntry } from "../shared/region.ts";
import type { PreviewMap, ViewerConfig } from "../shared/types.ts";

/** JSON inlined into each slot page as <script type="application/json" id="wge-data">. */
export interface BootData {
  cfg: ViewerConfig;
  /** URL of the 3D viewer module, relative to the slot page. */
  globe: string;
  /** URL of the flat (2D, no Three.js) viewer module, relative to the slot page. */
  flat?: string;
  /** Chunks each module imports, preloaded by the boot script for the view it picks. */
  preload?: { globe: string[]; flat: string[] };
  /** Path from the page to the site root (for regions/<id>.json). */
  root?: string;
  /** Slot pages: where each of this slot's regions is, so the poster can face it before anything loads. */
  regions?: Record<string, RegionIndexEntry>;
  /** Only on the preview page. */
  maps?: Record<string, PreviewMap>;
}

/** postMessage the admin page sends to its same-origin preview iframe to adjust it live. */
export interface PreviewMessage {
  type: "wge-preview";
  north: number;
  south: number;
  pole: string;
  /** Prime meridian shift in degrees. */
  shift?: number;
  grid?: boolean;
}

/** postMessage from the admin page's region editor or region preview to the preview iframe. */
export interface RegionMessage {
  type: "wge-region";
  /** Validated with parseRegionData on arrival; never trusted as is. */
  region: RegionData;
  /** Turn the view to face the region again. */
  centre?: boolean;
}

export type ViewMode = "globe" | "flat";

/** Everything about ?region=… that the viewer modules need. */
export interface RegionContext {
  id: string;
  /** Resolves with the validated region, or null if it doesn't exist (or isn't on this slot). */
  data: Promise<RegionData | null>;
  /** Preview page only: later live updates from the admin page. */
  subscribe?: (cb: (r: RegionData, centre: boolean) => void) => void;
  /** label=0|1, or null to use the region's own setting. */
  label: boolean | null;
  dim: boolean;
  /** Start locked on the selected position (lock=0 starts unlocked). */
  lock: boolean;
  /** lat/lon/zoom given explicitly in the URL; they override auto-fit. */
  explicit: { lat: boolean; lon: boolean; zoom: boolean };
  /** The inline index already framed the view (cfg.lat/lon/zoom, or the flat bounds below). */
  fitted: boolean;
  /** Flat view: bounds from the inline index, if any. */
  bounds?: [number, number, number, number];
}

/** What boot.ts hands to the 3D viewer module's start(). */
export interface StartContext {
  cfg: ViewerConfig;
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  firstTexture: Promise<Blob>;
  region: RegionContext | null;
}

/** What boot.ts hands to the flat viewer module's start(). */
export type FlatStartContext = Omit<StartContext, "gl">;
