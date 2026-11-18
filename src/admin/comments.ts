/**
 * Reviewer comments, as the admin page sees them (the API is worker/src/comments.ts). One list for the page: it is read
 * once when the Regions tab loads (or when an editor opens first), then kept up to date by this person's own actions.
 * It never polls: the API keeps all comments in one value and every read costs a request.
 */
import type { GitHub, MapComment } from "./github.ts";

let getGh: (() => GitHub) | null = null;
let items: MapComment[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

const changed = () => listeners.forEach((f) => f());

export function initComments(gh: () => GitHub): void {
  getGh = gh;
}

/** Reads the list (once; `force` reads it again). Quiet when comments aren't set up. */
export function loadComments(force = false): Promise<void> {
  if (!getGh) return Promise.resolve();
  if (!loaded || force) {
    loaded = getGh()
      .comments()
      .then((c) => void (items = c))
      .catch(() => void (items = []))
      .then(changed);
  }
  return loaded;
}

export const onCommentsChange = (f: () => void): (() => void) => (listeners.add(f), () => void listeners.delete(f));
export const commentsFor = (region: string): MapComment[] => items.filter((c) => c.region === region);
export const openCountFor = (region: string): number => items.filter((c) => c.region === region && c.status === "open").length;

export async function addComment(region: string, text: string, lon: number, lat: number): Promise<MapComment> {
  const c = await getGh!().addComment(region, text, lon, lat);
  items = [c, ...items.filter((x) => x.id !== c.id)];
  changed();
  return c;
}

export async function setCommentStatus(id: string, status: "open" | "resolved"): Promise<void> {
  const c = await getGh!().setCommentStatus(id, status);
  items = items.map((x) => (x.id === id ? c : x));
  changed();
}

export async function deleteComment(id: string): Promise<void> {
  await getGh!().removeComment(id);
  items = items.filter((x) => x.id !== id);
  changed();
}
