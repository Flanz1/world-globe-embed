import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface ContentPaths {
  root: string;
  content: string;
  slotsFile: string;
  mapsDir: string;
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
    incomingDir: path.join(root, "content", "incoming"),
    publicDir: path.join(root, "public"),
  };
}
