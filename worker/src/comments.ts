/**
 * Reviewer comments: anyone on the admin list can drop a short comment at a spot on a region ("the border
 * looks off here"). The people who may edit that region see the comment in the editor and tick it off
 * (resolve it). It is lighter than a suggested change (proposals.ts), which needs a whole redrawn region.
 *
 * Comments live in KV, as one JSON value (the whole list, a few hundred small records at most), so
 * nothing reaches main: a comment never causes a commit, a rebuild or a deploy. Each comment is a small
 * record with the id `<region>~<8 hex>`.
 *
 * Cost: KV's free plan allows few lists and writes a day, so this never lists. Showing comments is one `get`
 * (the admin page asks once when it loads, and again only after its own changes); posting, resolving,
 * reopening and deleting are one `get` and one `put`. Nothing polls. Old records are dropped on write.
 */
import type { Actor } from "../../src/shared/access.ts";
import type { KV } from "./handler.ts";
import { mayReview } from "./proposals.ts";

export interface CommentKV extends KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Comment {
  /** `<region>~<8 hex>` */
  id: string;
  region: string;
  by: { id: number; login: string };
  at: string;
  text: string;
  /** Where on the map the comment sits, in degrees. */
  lon: number;
  lat: number;
  /** Account id of the region's creator when the comment was posted. */
  owner: number;
  status: "open" | "resolved";
  resolvedBy?: string;
  resolvedAt?: string;
}

export const TEXT_MAX = 240;
const TEXT_MAX_BYTES = 480;
export const MAX_OPEN_PER_PERSON = 20;
const OPEN_DAYS = 180;
const RESOLVED_DAYS = 14;
const ID = /^[a-z0-9][a-z0-9-]{0,63}~[0-9a-f]{8}$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class CommentError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CommentCtx {
  kv: CommentKV | undefined;
  actor: Actor;
  /** The region as it is on the branch now: its creator's id, or null when there is no such region. */
  region: (id: string) => Promise<{ owner: number } | null>;
}

const store = (c: CommentCtx): CommentKV => {
  if (!c.kv) throw new CommentError(501, "Comments aren't set up on this admin API (it has no key-value store).");
  return c.kv;
};

const seen = (c: CommentCtx, m: Comment) => m.by.id === c.actor.id || mayReview(c.actor, m.owner);

/** The text, trimmed and cut to its limits (characters, and bytes so the metadata stays under KV's 1 KB). */
export function cleanText(s: unknown): string {
  let t = typeof s === "string" ? [...s.trim().replace(/\s+/g, " ")].slice(0, TEXT_MAX).join("") : "";
  const enc = new TextEncoder();
  while (enc.encode(t).length > TEXT_MAX_BYTES) t = [...t].slice(0, -1).join("");
  return t;
}

const coord = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max ? Math.round(v * 1e4) / 1e4 : null);

/** All comments are one KV value (a few hundred small records at most): a read is one `get`, never a list. */
const INDEX = "comments";
const MAX_TOTAL = 800;

async function readAll(c: CommentCtx): Promise<Comment[]> {
  const raw = await store(c).get(INDEX);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw) as Comment[];
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** Writes the index back, dropping old records (open ones after 180 days, resolved after 14). */
async function writeAll(c: CommentCtx, all: Comment[]): Promise<void> {
  const now = Date.now();
  const keep = all.filter((m) => now - Date.parse(m.status === "open" ? m.at : (m.resolvedAt ?? m.at)) < (m.status === "open" ? OPEN_DAYS : RESOLVED_DAYS) * 86400_000);
  await store(c).put(INDEX, JSON.stringify(keep));
}

async function find(c: CommentCtx, id: string): Promise<{ all: Comment[]; m: Comment }> {
  if (!ID.test(id)) throw new CommentError(400, "Bad comment id.");
  const all = await readAll(c);
  const m = all.find((x) => x.id === id);
  if (!m) throw new CommentError(404, "That comment is gone (it may have been deleted or expired).");
  return { all, m };
}

/** The comments this person may see (their own, and those on regions they may edit), newest first. One region, or all of them. */
export async function listComments(c: CommentCtx, region?: string): Promise<Comment[]> {
  if (region !== undefined && !REGION.test(region)) throw new CommentError(400, "Bad region id.");
  return (await readAll(c))
    .filter((m) => (!region || m.region === region) && seen(c, m))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export async function postComment(c: CommentCtx, body: { region?: unknown; text?: unknown; lon?: unknown; lat?: unknown }): Promise<Comment> {
  if (typeof body.region !== "string" || !REGION.test(body.region)) throw new CommentError(400, "Bad region id.");
  const text = cleanText(body.text);
  if (!text) throw new CommentError(422, "Write something in the comment.");
  const lon = coord(body.lon, 180);
  const lat = coord(body.lat, 90);
  if (lon === null || lat === null) throw new CommentError(422, "A comment needs a spot on the map.");
  const cur = await c.region(body.region);
  if (!cur) throw new CommentError(404, `There's no region "${body.region}" to comment on.`);
  const all = await readAll(c);
  if (all.length >= MAX_TOTAL) throw new CommentError(429, "There are too many comments on this site right now. Ask a reviewer to clear some.");
  const mine = all.filter((m) => m.by.id === c.actor.id && m.status === "open").length;
  if (mine >= MAX_OPEN_PER_PERSON) throw new CommentError(429, `You already have ${MAX_OPEN_PER_PERSON} open comments. Delete some first.`);
  const rnd = crypto.getRandomValues(new Uint8Array(4));
  const m: Comment = {
    id: `${body.region}~${[...rnd].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    region: body.region,
    by: { id: c.actor.id, login: c.actor.login },
    at: new Date().toISOString(),
    text,
    lon,
    lat,
    owner: cur.owner,
    status: "open",
  };
  await writeAll(c, [...all, m]);
  return m;
}

/** Ticks a comment off (or reopens it). Only people who may edit the region, as it is now. */
export async function setStatus(c: CommentCtx, id: string, status: "open" | "resolved"): Promise<Comment> {
  const { all, m } = await find(c, id);
  const cur = await c.region(m.region);
  const owner = cur?.owner ?? m.owner;
  if (!mayReview(c.actor, owner)) throw new CommentError(403, `You can't resolve comments on "${m.region}": someone else created it.`);
  if (m.status === status) return m;
  const next: Comment = { ...m, owner, status };
  delete next.resolvedBy;
  delete next.resolvedAt;
  if (status === "resolved") Object.assign(next, { resolvedBy: c.actor.login, resolvedAt: new Date().toISOString() });
  await writeAll(c, all.map((x) => (x.id === id ? next : x)));
  return next;
}

/** Deletes a comment: its author, or a reviewer of the region. */
export async function removeComment(c: CommentCtx, id: string): Promise<void> {
  const { all, m } = await find(c, id);
  const cur = await c.region(m.region);
  if (m.by.id !== c.actor.id && !mayReview(c.actor, cur?.owner ?? m.owner)) throw new CommentError(403, "Only the person who wrote a comment, or someone who can edit the region, can delete it.");
  await writeAll(c, all.filter((x) => x.id !== id));
}
