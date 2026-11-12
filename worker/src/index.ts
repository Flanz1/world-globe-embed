/** Cloudflare Worker entry for the admin API (see handler.ts). */
import { handle, type Env } from "./handler.ts";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, (url, init) => fetch(url, init));
  },
};
