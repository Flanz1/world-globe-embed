/**
 * Suggested changes: someone who can't edit a region (they didn't create it and lack "Edit others'
 * regions") edits it anyway in the editor and sends the result as a proposal. The people who may edit
 * that region see it, compare it with the current region, and accept or decline it.
 *
 * Proposals live in KV, not in the repository: nothing about them reaches main, the site isn't rebuilt,
 * and the permission rules for regions stay exactly as they are. Accepting one is an ordinary save by
 * the reviewer (the admin page writes the region with the reviewer's own permissions, through the API's
 * normal commit checks); this module only keeps the proposals and who may see or decide them.
 *
 * One pending proposal per person per region: sending another one replaces it. Keys: `p:<region>~<proposer id>`.
 * The value is the proposal (JSON); the key's metadata is a short summary for lists.
 */
import { canEditRegion, type Actor } from "../../src/shared/access.ts";
import type { KV } from "./handler.ts";

export interface ProposalKV extends KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
}

/** What a list shows about a proposal (also the KV metadata, so it stays small). */
export interface ProposalSummary {
  /** `<region>~<proposer id>` */
  id: string;
  region: string;
  by: { id: number; login: string };
  at: string;
  note: string;
  /** Who created the region when this was sent (their id). */
  owner: number;
  /** Blob SHA of the region file the suggestion started from. */
  base: string;
  status: "pending" | "accepted" | "declined";
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
}

export interface Proposal extends ProposalSummary {
  /** The suggested region (a complete region file). */
  feature: unknown;
}

export const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
export const MAX_PENDING_PER_PERSON = 15;
const PENDING_DAYS = 90;
const DECIDED_DAYS = 30;
const NOTE_MAX = 160;
const REASON_MAX = 120;
const ID = /^[a-z0-9][a-z0-9-]{0,63}~\d{1,15}$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class ProposalError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the handler lends this module: the store, region lookups and the schema check. */
export interface ProposalCtx {
  kv: ProposalKV | undefined;
  actor: Actor;
  ownerId: number;
  /** The region as it is on the branch now: its blob SHA and creator's id, or null when there is none. */
  region: (id: string) => Promise<{ sha: string; owner: number } | null>;
  /** The reason a region file doesn't match its schema, or null. */
  schemaProblem: (data: unknown) => string | null;
}

const store = (c: ProposalCtx): ProposalKV => {
  if (!c.kv) throw new ProposalError(501, "Suggested changes aren't set up on this admin API (it has no key-value store).");
  return c.kv;
};

const clip = (s: unknown, n: number) => (typeof s === "string" ? [...s.trim()].slice(0, n).join("") : "");

/** May this person decide proposals for a region created by `owner`? Same rule as editing the region. */
export const mayReview = (a: Actor, owner: number) => a.owner || canEditRegion(a.permissions, a.id, owner);

const summaryOf = (p: Proposal): ProposalSummary => {
  const s: Partial<Proposal> = { ...p };
  delete s.feature;
  return s as ProposalSummary;
};

const keyOf = (id: string) => `p:${id}`;

async function load(c: ProposalCtx, id: string): Promise<Proposal> {
  if (!ID.test(id)) throw new ProposalError(400, "Bad suggestion id.");
  const raw = await store(c).get(keyOf(id));
  if (!raw) throw new ProposalError(404, "That suggestion is gone (it may have been withdrawn or expired).");
  try {
    return JSON.parse(raw) as Proposal;
  } catch {
    throw new ProposalError(500, "That suggestion is damaged.");
  }
}

async function save(c: ProposalCtx, p: Proposal): Promise<void> {
  const summary = summaryOf(p);
  await store(c).put(keyOf(p.id), JSON.stringify(p), { expirationTtl: (p.status === "pending" ? PENDING_DAYS : DECIDED_DAYS) * 86400, metadata: summary });
}

const seen = (c: ProposalCtx, s: ProposalSummary) => s.by.id === c.actor.id || mayReview(c.actor, s.owner);

/** The proposals this person may see: their own (any status), and pending/decided ones for regions they may edit. */
export async function listProposals(c: ProposalCtx): Promise<ProposalSummary[]> {
  const { keys } = await store(c).list({ prefix: "p:", limit: 1000 });
  return keys
    .map((k) => k.metadata as ProposalSummary | undefined)
    .filter((s): s is ProposalSummary => !!s && typeof s.id === "string" && seen(c, s))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export async function getProposal(c: ProposalCtx, id: string): Promise<Proposal> {
  const p = await load(c, id);
  if (!seen(c, p)) throw new ProposalError(403, "You can't see that suggestion.");
  return p;
}

/** Sends (or replaces) the signed-in person's suggestion for a region. */
export async function propose(c: ProposalCtx, body: { region?: unknown; feature?: unknown; note?: unknown }, rawLength: number): Promise<ProposalSummary> {
  if (!c.actor.owner && !c.actor.permissions.has("regions")) throw new ProposalError(403, "You don't have permission to suggest changes (it needs \"Create regions\").");
  if (typeof body.region !== "string" || !REGION.test(body.region)) throw new ProposalError(400, "Bad region id.");
  if (rawLength > MAX_PROPOSAL_BYTES) throw new ProposalError(413, "That suggestion is too big.");
  const f = body.feature as { id?: unknown } | null;
  if (!f || typeof f !== "object" || f.id !== body.region) throw new ProposalError(422, `The suggested region must have the id "${body.region}".`);
  const bad = c.schemaProblem(f);
  if (bad) throw new ProposalError(422, `The suggestion doesn't match the region schema: ${bad}`);
  const cur = await c.region(body.region);
  if (!cur) throw new ProposalError(404, `There's no region "${body.region}" to suggest changes to.`);
  if (mayReview(c.actor, cur.owner)) throw new ProposalError(409, "You can edit this region yourself: change it directly.");
  const id = `${body.region}~${c.actor.id}`;
  const { keys } = await store(c).list({ prefix: "p:", limit: 1000 });
  const mine = keys.map((k) => k.metadata as ProposalSummary | undefined).filter((s) => s && s.by?.id === c.actor.id && s.status === "pending" && s.id !== id);
  if (mine.length >= MAX_PENDING_PER_PERSON) throw new ProposalError(429, `You already have ${MAX_PENDING_PER_PERSON} suggestions waiting. Withdraw one first.`);
  const p: Proposal = {
    id,
    region: body.region,
    by: { id: c.actor.id, login: c.actor.login },
    at: new Date().toISOString(),
    note: clip(body.note, NOTE_MAX),
    owner: cur.owner,
    base: cur.sha,
    status: "pending",
    feature: f,
  };
  await save(c, p);
  const summary = summaryOf(p);
  return summary;
}

/** Declines (with an optional reason) or marks accepted. Only people who may edit the region, as it is now. */
export async function decide(c: ProposalCtx, id: string, status: "accepted" | "declined", reason?: unknown): Promise<ProposalSummary> {
  const p = await load(c, id);
  const cur = await c.region(p.region);
  // A region deleted since: whoever could see the suggestion may close it, as the stored owner.
  const owner = cur?.owner ?? p.owner;
  if (!mayReview(c.actor, owner)) throw new ProposalError(403, `You can't decide suggestions for "${p.region}": someone else created it.`);
  if (p.status !== "pending") throw new ProposalError(409, `That suggestion was already ${p.status}.`);
  const next: Proposal = { ...p, owner, status, decidedBy: c.actor.login, decidedAt: new Date().toISOString(), ...(status === "declined" && clip(reason, REASON_MAX) ? { reason: clip(reason, REASON_MAX) } : {}) };
  await save(c, next);
  const summary = summaryOf(next);
  return summary;
}

/** Withdraws one's own suggestion, or clears a decided one away (the reviewer or the sender). */
export async function remove(c: ProposalCtx, id: string): Promise<void> {
  const p = await load(c, id);
  if (p.by.id !== c.actor.id && !(p.status !== "pending" && mayReview(c.actor, p.owner))) throw new ProposalError(403, "Only the person who sent a suggestion can withdraw it.");
  await store(c).delete(keyOf(id));
}
