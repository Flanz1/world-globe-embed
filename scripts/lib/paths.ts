import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface ContentPaths {
  root: string;
  content: string;
  slotsFile: string;
  mapsDir: string;
  /** content/regions/<id>.json, one GeoJSON Feature per region. */
  regionsDir: string;
  /** content/pins/<id>.json, one GeoJSON Point Feature per map pin. */
  pinsDir: string;
  incomingDir: string;
  /** public/ (Vite copies it into dist/). Processed WebPs live in public/maps/<id>/. */
  publicDir: string;
}

export function contentPaths(root = ROOT): ContentPaths {
  return {
    root,
    content: path.join(root, "content"),
    slotsFile: path.join(root, "content", "slots.json"),
    mapsDir: path.join(root, "content", "maps"),
    regionsDir: path.join(root, "content", "regions"),
    pinsDir: path.join(root, "content", "pins"),
    incomingDir: path.join(root, "content", "incoming"),
    publicDir: path.join(root, "public"),
  };
}
