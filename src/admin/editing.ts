/**
 * A live link to the admin API's "who has a region open" room (worker/src/presence.ts). Tabs keep one
 * WebSocket open; the room tells everyone as soon as a tab opens a region, changes what it has open, or goes
 * away (closed, reloaded or crashed: the connection drops). Nothing is polled and no KV is used.
 */
import type { Editing, GitHub } from "./github.ts";

/** Matches PING_MS in worker/src/presence.ts. */
const PING_MS = 30_000;
/** How often to look whether the open regions changed (local only; a message goes out only on a change). */
const CHECK_MS = 2_000;
const MAX_RETRY_MS = 60_000;

/**
 * Connects and keeps reconnecting until `stop()`. `regions()` is what this tab has open ([] to only watch);
 * `onList` gets everyone's open regions after every change. Failures are quiet: it's only a hint.
 */
export function connectEditing(gh: GitHub, regions: () => string[], onList: (list: Editing[]) => void): { stop: () => void } {
  let ws: WebSocket | null = null;
  let stopped = false;
  let sent = "";
  let retry = 2_000;
  let retryTimer = 0;
  let pingTimer = 0;
  let checkTimer = 0;

  const send = () => {
    const now = JSON.stringify(regions());
    if (ws?.readyState !== WebSocket.OPEN || now === sent) return;
    sent = now;
    ws.send(JSON.stringify({ regions: JSON.parse(now) }));
  };

  const open = () => {
    if (stopped) return;
    let s: WebSocket;
    try {
      s = gh.editingSocket();
    } catch {
      return schedule();
    }
    ws = s;
    sent = "";
    s.onopen = () => {
      retry = 2_000;
      send();
    };
    s.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data === "pong") return;
      try {
        const m = JSON.parse(e.data) as { editing?: Editing[] };
        if (Array.isArray(m.editing) && !stopped) onList(m.editing);
      } catch {
        /* not for us */
      }
    };
    s.onclose = () => {
      if (ws === s) ws = null;
      if (!stopped) {
        onList([]);
        schedule();
      }
    };
  };

  const schedule = () => {
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(open, retry);
    retry = Math.min(retry * 2, MAX_RETRY_MS);
  };

  open();
  pingTimer = window.setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
  }, PING_MS);
  checkTimer = window.setInterval(send, CHECK_MS);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      clearInterval(checkTimer);
      ws?.close(1000);
      ws = null;
    },
  };
}
