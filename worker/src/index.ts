/** Cloudflare Worker entry for the admin API (see handler.ts), and the Durable Object behind "X is editing" (presence.ts). */
import { handle, type Env } from "./handler.ts";
import { PresenceRoom, type RoomState, type Sock, type Who } from "./presence.ts";

// Cloudflare runtime globals (this project doesn't pull in @cloudflare/workers-types).
declare const WebSocketPair: { new (): { 0: Sock; 1: Sock } };
declare const WebSocketRequestResponsePair: { new (request: string, response: string): unknown };

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, (url, init) => fetch(url, init));
  },
};

/** One instance for the whole site (the Worker always asks for the one named "editing"). */
export class EditingRoom {
  private readonly room: PresenceRoom;

  constructor(state: RoomState & { setWebSocketAutoResponse(pair: unknown): void }) {
    // Pings are answered without waking the room, so idle tabs cost no compute time.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.room = new PresenceRoom(state);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket.", { status: 426 });
    const who = JSON.parse(req.headers.get("X-Editing-Actor") ?? "null") as Who | null;
    if (!who || !Number.isSafeInteger(who.id) || typeof who.login !== "string") return new Response("Who is this?", { status: 400 });
    const pair = new WebSocketPair();
    await this.room.join(pair[1], who);
    return new Response(null, { status: 101, webSocket: pair[0], headers: { "Sec-WebSocket-Protocol": "presence" } } as ResponseInit);
  }

  webSocketMessage(ws: Sock, message: string | ArrayBuffer): void {
    if (typeof message === "string") this.room.message(ws, message);
  }

  webSocketClose(ws: Sock): void {
    this.room.closed(ws);
  }

  webSocketError(ws: Sock): void {
    this.room.closed(ws);
  }

  alarm(): Promise<void> {
    return this.room.sweep();
  }
}
