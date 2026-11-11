/** Shapes shared by the viewer, the build scripts and the admin page. */
import type { TileLevel, TileLevelWidth } from "./tiles.ts";

/** Widths the processing workflow generates, smallest first. */
export const TEXTURE_WIDTHS = [1024, 2048, 4096, 8192] as const;
export type TextureWidth = (typeof TEXTURE_WIDTHS)[number];

export type ViewMode = "globe" | "flat";

/** Per-slot view defaults. Every field can be overridden by a query param. */
export interface ViewDefaults {
  /** Which view the embed opens in: the 3D globe or the flat map. */
  view: ViewMode;
  grid: boolean;
  rotate: boolean;
  legend: boolean;
  controls: boolean;
  /** "transparent" or a #hex colour. */
  bg: string;
  /** Latitude (degrees, -90..90) facing the viewer at load. */
  lat: number;
  /** Longitude (degrees, -180..180) facing the viewer at load. */
  lon: number;
  /** 1 = default framing; larger is closer. */
  zoom: number;
  /** Percent of the globe's height left unmapped at the north pole (0–49), like the desktop app. */
  north: number;
  /** Percent left unmapped at the south pole (0–49). */
  south: number;
  /** Fill colour for the padded polar areas. */
  pole: string;
  /**
   * Prime meridian position: moves the map east (+) or west (-) by this many degrees, like the
   * desktop app's "Horizontal Shift", so the map's own prime meridian lines up with the grid's red line.
   */
  shift: number;
}

export const DEFAULT_VIEW: ViewDefaults = {
  view: "globe",
  grid: false,
  rotate: true,
  legend: false,
  controls: true,
  bg: "transparent",
  lat: 15,
  lon: 0,
  zoom: 1,
  north: 0,
  south: 0,
  pole: "#e8dcc8",
  shift: 0,
};

export interface Slot extends Partial<ViewDefaults> {
  /** Map id: the file stem of content/maps/<id>.json. */
  map: string;
  /** Used for the page <title> and the iframe title in the embed snippet. */
  title?: string;
}

export interface SlotsFile {
  $schema?: string;
  slots: Record<string, Slot>;
}

export interface MapMeta {
  $schema?: string;
  id: string;
  name: string;
  uploadedBy: string;
  /** ISO 8601 timestamp of processing. */
  date: string;
  /** width / height of the processed source. */
  aspect: number;
  width: number;
  height: number;
  /** Content hash of the source image (first 12 hex chars of sha256). */
  hash: string;
  /** Width → path relative to the site root, e.g. "maps/aerthos/ab12cd34ef56-1024.webp". */
  sizes: Partial<Record<`${TextureWidth}`, string>>;
  /** Tile levels above 8192 (see shared/tiles.ts); `url` is a path prefix relative to the site root. */
  tiles?: Partial<Record<`${TileLevelWidth}`, TileLevel>>;
  /** Tiny blurred preview as a data: URI. */
  lqip: string;
}

/** What a generated slot page hands to the viewer (inlined as JSON). */
export interface ViewerConfig extends ViewDefaults {
  slug: string;
  title: string;
  /** Available textures, URLs relative to the slot page, smallest first. */
  textures: { w: number; url: string }[];
  /** Tile levels, smallest first, URLs relative to the slot page. */
  tiles?: TileLevel[];
  /** Map image width / height (the flat view keeps the image's own proportions). Defaults to 2. */
  aspect?: number;
}

/** One map as the preview page needs it. */
export interface PreviewMap {
  name: string;
  aspect: number;
  lqip: string;
  textures: { w: number; url: string }[];
}
