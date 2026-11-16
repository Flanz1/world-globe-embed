import { describe, expect, it } from "vitest";
import { PresenceRoom, STALE_MS, SWEEP_MS, type RoomState, type Sock } from "../worker/src/presence.ts";

class FakeSock implements Sock {
  got: string[] = [];
  closed: number | null = null;
  private att: unknown = null;
  constructor(private readonly room: FakeState) {}
  send(m: string) {
    if (this.closed !== null) throw new Error("closed");
    this.got.push(m);
  }
  close(code = 1000) {
    this.closed = code;
    this.room.socks = this.room.socks.filter((s) => s !== this);
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
  /** What the last list this socket got says. */
  last(): { login: string; regions: string[] }[] {
    const m = [...this.got].reverse().find((g) => g.startsWith("{"));
    return m ? (JSON.parse(m) as { editing: { login: string; regions: string[] }[] }).editing.map(({ login, regions }) => ({ login, regions })) : [];
  }
}

class FakeState implements RoomState {
  socks: FakeSock[] = [];
  alarm: number | null = null;
  pinged = new Map<Sock, number>();
  acceptWebSocket(ws: Sock) {
    this.socks.push(ws as FakeSock);
  }
  getWebSockets() {
    return [...this.socks];
  }
  getWebSocketAutoResponseTimestamp(ws: Sock) {
    const t = this.pinged.get(ws);
    return t === undefined ? null : new Date(t);
  }
  storage = {
    getAlarm: async () => this.alarm,
    setAlarm: async (t: number) => {
      this.alarm = t;
    },
  };
}

const ANN = { id: 1, login: "ann", write: true };
const BO = { id: 2, login: "bo", write: true };
const VIEWER = { id: 3, login: "vi", write: false };

function setup() {
  let now = 1_000_000;
  const state = new FakeState();
  const room = new PresenceRoom(state, () => now);
  const join = async (who: typeof ANN) => {
    const s = new FakeSock(state);
    await room.join(s, who);
    return s;
  };
  return { state, room, join, tick: (ms: number) => (now += ms), now: () => now };
}

describe("editing room", () => {
  it("tells everyone at once who opens what, and who leaves", async () => {
    const { room, join, state } = setup();
    const ann = await join(ANN);
    const bo = await join(BO);
    expect(bo.last()).toEqual([]);
    room.message(ann, JSON.stringify({ regions: ["nordland"] }));
    expect(bo.last()).toEqual([{ login: "ann", regions: ["nordland"] }]);
    // The same regions again: no new message.
    const n = bo.got.length;
    room.message(ann, JSON.stringify({ regions: ["nordland"] }));
    expect(bo.got.length).toBe(n);
    // A crash or a closed tab drops the connection: the others hear straight away.
    state.socks = state.socks.filter((s) => s !== ann);
    room.closed(ann);
    expect(bo.last()).toEqual([]);
  });

  it("lists viewers as watchers only, and ignores bad region ids", async () => {
    const { room, join } = setup();
    const vi = await join(VIEWER);
    const ann = await join(ANN);
    room.message(vi, JSON.stringify({ regions: ["nordland"] }));
    expect(room.list()).toEqual([]);
    room.message(ann, JSON.stringify({ regions: ["../x"] }));
    room.message(ann, "not json");
    expect(room.list()).toEqual([]);
    room.message(ann, JSON.stringify({ regions: ["south"] }));
    expect(vi.last()).toEqual([{ login: "ann", regions: ["south"] }]);
  });

  it("drops a tab that stopped pinging (sleep, lost network), but keeps one that pings", async () => {
    const { room, join, state, tick, now } = setup();
    const ann = await join(ANN);
    const bo = await join(BO);
    room.message(ann, JSON.stringify({ regions: ["nordland"] }));
    room.message(bo, JSON.stringify({ regions: ["south"] }));
    expect(state.alarm).toBe(now() + SWEEP_MS);
    // Bo's pings are answered by Cloudflare without waking the room; it only sees the timestamps.
    for (let t = 0; t < STALE_MS + SWEEP_MS; t += 30_000) {
      tick(30_000);
      state.pinged.set(bo, now());
    }
    await room.sweep();
    expect(ann.closed).toBe(4000);
    expect(bo.closed).toBeNull();
    expect(bo.last()).toEqual([{ login: "bo", regions: ["south"] }]);
    expect(state.alarm).toBe(now() + SWEEP_MS);
  });

  it("stops sweeping when nobody is connected", async () => {
    const { room, join, state, tick } = setup();
    await join(ANN);
    state.alarm = null;
    tick(STALE_MS + 1);
    await room.sweep();
    expect(state.socks).toEqual([]);
    expect(state.alarm).toBeNull();
  });
});
