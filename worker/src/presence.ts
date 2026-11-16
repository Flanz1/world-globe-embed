/**
 * "Who has a region open", kept live in one Durable Object (the EditingRoom class in index.ts) that every
 * admin tab holds a WebSocket to. There is no storage: the list is just the open sockets.
 *
 * - A tab that closes, reloads or crashes drops its TCP connection, so the room hears about it at once and
 *   tells everyone else.
 * - A tab whose computer sleeps or loses its network can't say goodbye. It stops pinging, and the sweep
 *   (an alarm every SWEEP_MS, only while someone is connected) drops it after STALE_MS.
 * - Pings are answered by Cloudflare's auto-response without waking the room, and the room hibernates
 *   between messages, so an open tab costs about 150 billed requests a day (incoming messages count 1 in 20)
 *   and no KV at all. The sweep adds at most 1,440 a day for the whole site. The free plan allows 100,000.
 *
 * This file holds the logic only, against small interfaces, so the tests can run it without Cloudflare.
 */

/** How often a tab pings (the client uses this). Browsers may slow timers in hidden tabs to once a minute. */
export const PING_MS = 30_000;
/** A socket that has neither pinged nor sent anything for this long is dropped. Leaves room for throttled timers. */
export const STALE_MS = 150_000;
/** How often the room looks for stale sockets while anyone is connected. */
export const SWEEP_MS = 60_000;
export const MAX_EDITING_REGIONS = 200;
const REGION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface Editing {
  id: number;
  login: string;
  tab: string;
  regions: string[];
  at: string;
}

/** Who a socket belongs to; decided by the Worker before the socket reaches the room. */
export interface Who {
  id: number;
  login: string;
  /** May this person change anything? Viewers can watch the list but never appear in it. */
  write: boolean;
}

interface Attachment extends Who {
  tab: string;
  regions: string[];
  /** When the socket connected (ms). */
  at: number;
  /** The last message other than an auto-answered ping (ms). */
  seen: number;
}

export interface Sock {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The parts of DurableObjectState the room uses. */
export interface RoomState {
  acceptWebSocket(ws: Sock): void;
  getWebSockets(): Sock[];
  getWebSocketAutoResponseTimestamp(ws: Sock): Date | null;
  storage: { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> };
}

const tabId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("");

export class PresenceRoom {
  constructor(
    private readonly state: RoomState,
    private readonly now: () => number = Date.now,
  ) {}

  private att(ws: Sock): Attachment | null {
    const a = ws.deserializeAttachment() as Attachment | null | undefined;
    return a && typeof a.id === "number" ? a : null;
  }

  /** Everyone (except `gone`) who has at least one region open. */
  list(gone?: Sock): Editing[] {
    const out: Editing[] = [];
    for (const ws of this.state.getWebSockets()) {
      if (ws === gone) continue;
      const a = this.att(ws);
      if (a?.write && a.regions.length) out.push({ id: a.id, login: a.login, tab: a.tab, regions: a.regions, at: new Date(a.at).toISOString() });
    }
    return out;
  }

  private broadcast(gone?: Sock): void {
    const msg = JSON.stringify({ editing: this.list(gone) });
    for (const ws of this.state.getWebSockets()) {
      if (ws === gone) continue;
      try {
        ws.send(msg);
      } catch {
        /* closing; the close handler tidies up */
      }
    }
  }

  private async ensureSweep(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(this.now() + SWEEP_MS);
  }

  async join(ws: Sock, who: Who): Promise<void> {
    this.state.acceptWebSocket(ws);
    const now = this.now();
    const a: Attachment = { id: who.id, login: who.login, write: who.write, tab: tabId(), regions: [], at: now, seen: now };
    ws.serializeAttachment(a);
    ws.send(JSON.stringify({ editing: this.list() }));
    await this.ensureSweep();
  }

  /** A message from a tab: "ping" (when the auto-response didn't take it) or {"regions": [...]}. */
  message(ws: Sock, data: string): void {
    const a = this.att(ws);
    if (!a) return;
    a.seen = this.now();
    if (data === "ping") {
      ws.serializeAttachment(a);
      ws.send("pong");
      return;
    }
    let regions: unknown;
    try {
      regions = (JSON.parse(data) as { regions?: unknown }).regions;
    } catch {
      return;
    }
    if (!Array.isArray(regions) || regions.length > MAX_EDITING_REGIONS || !regions.every((r) => typeof r === "string" && REGION_ID.test(r))) return;
    const next = a.write ? [...new Set(regions as string[])] : [];
    const changed = JSON.stringify(next) !== JSON.stringify(a.regions);
    a.regions = next;
    ws.serializeAttachment(a);
    if (changed) this.broadcast();
  }

  closed(ws: Sock): void {
    const had = this.att(ws)?.regions.length;
    if (had) this.broadcast(ws);
  }

  /** Drops sockets that went quiet, and keeps sweeping while anyone is connected. */
  async sweep(): Promise<void> {
    const now = this.now();
    let dropped = false;
    const gone = new Set<Sock>();
    for (const ws of this.state.getWebSockets()) {
      const a = this.att(ws);
      const pinged = this.state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const last = Math.max(pinged, a?.seen ?? 0);
      if (now - last > STALE_MS) {
        gone.add(ws);
        if (a?.regions.length) dropped = true;
        try {
          ws.close(4000, "No ping for too long.");
        } catch {
          /* already gone */
        }
      }
    }
    const left = this.state.getWebSockets().filter((ws) => !gone.has(ws));
    if (dropped) {
      const msg = JSON.stringify({ editing: this.list().filter((e) => left.some((ws) => this.att(ws)?.tab === e.tab)) });
      for (const ws of left) {
        try {
          ws.send(msg);
        } catch {
          /* closing */
        }
      }
    }
    if (left.length) await this.state.storage.setAlarm(now + SWEEP_MS);
  }
}
