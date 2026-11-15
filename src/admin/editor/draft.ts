/**
 * Local copy of the editor's unsaved work, so a crash, a reload or a closed tab doesn't lose it.
 *
 * Kept in this browser's IndexedDB, one draft per thing being edited (a region, a new region on a slot,
 * or a set of regions edited together). The editor writes it shortly after every change, removes it
 * once the work is saved (or the person chose to discard it) and offers it back when the same thing is
 * opened again. Everything here fails quietly: a browser that blocks storage just has no recovery.
 */

const DB = "wge-editor";
const STORE = "drafts";
/** Drafts older than this are ignored and removed. */
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export interface Draft {
  v: 1;
  /** When the draft was written (ms). */
  at: number;
  /** Blob SHA of each file the work was based on (regions, and a linked region as `link:<id>`), to tell if GitHub's copy changed since. */
  shas: Record<string, string | null>;
  /** The editor state (EditorState; JSON). */
  state: unknown;
  /** A new region's id as typed. */
  id?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  try {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** What the draft is about: the GitHub branch (and the signed-in account) plus the region(s) being edited. */
export function draftKey(branch: string, login: string, what: string): string {
  return `${branch}|${login}|${what}`;
}

export async function loadDraft(key: string): Promise<Draft | null> {
  const d = (await run("readonly", (s) => s.get(key))) as Draft | null;
  if (!d || d.v !== 1 || typeof d.at !== "number" || !d.state || typeof d.state !== "object" || !Array.isArray((d.state as { parts?: unknown }).parts)) return null;
  if (Date.now() - d.at > MAX_AGE_MS) {
    void clearDraft(key);
    return null;
  }
  return d;
}

export async function saveDraft(key: string, d: Draft): Promise<void> {
  await run("readwrite", (s) => s.put(d, key));
}

export async function clearDraft(key: string): Promise<void> {
  await run("readwrite", (s) => s.delete(key));
}
