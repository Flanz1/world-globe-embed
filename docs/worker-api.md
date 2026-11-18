# Admin API reference

`worker/` is a Cloudflare Worker at `https://admin-api.garmeley.com` (config: `worker/wrangler.toml`; auto-deployed by `.github/workflows/admin-api.yml`). It is the only thing that writes to the repository. The code is in `worker/src/handler.ts` (routes), `proposals.ts`, `comments.ts`, `presence.ts`, `ratelimit.ts`, `crypto.ts`; `index.ts` is the Worker entry and the Durable Object class.

Authentication: `Authorization: Bearer <session token>`, a token signed with `SESSION_KEY`, valid for a short time, issued after GitHub sign-in. The WebSocket route sends the token in `Sec-WebSocket-Protocol` instead. Every route except `/`, `/auth/*` and `OPTIONS` needs a session. Errors are JSON `{ "message": "…" }` with the HTTP status. CORS allows the origins in `ADMIN_URLS`.

Rate limit, per caller IP: 20 requests a minute on `/auth/*` and 900 a minute on everything else (a per-instance counter, plus the Cloudflare `RATE_LIMITER` binding when set; the binding in `wrangler.toml` is 900/min). Over the limit the API answers `429` with `Retry-After: 60`.

## Routes

| Method and path | Who | What |
|---|---|---|
| `GET /` | anyone | Plain-text hello. |
| `GET /auth/login` | anyone | Starts GitHub sign-in (redirects to GitHub). |
| `GET /auth/callback` | anyone | Finishes sign-in and redirects back to the admin page with a session token. |
| `GET /session` | signed in | Who you are: `{ id, login, owner, permissions, repo, branch, prefs }`. Signing in as someone not on the list adds them to the waiting list (`noteWaiting`). |
| `GET /users/<login>` | signed in | Looks a GitHub username up: `{ id, login }`. People only, not orgs or bots. |
| `PUT /prefs` | signed in | Saves the account's colour theme `{ seed, mode }` (KV). |
| `GET /history` | signed in | The save log (commits touching `content/`), for the activity feed, version history and trash. Query: `path`, `since` (ISO time), `limit`, `files`. |
| `GET /waiting` | `users` | People who signed in but aren't on the list. |
| `DELETE /waiting/<id>` | `users` | Dismisses one from that list. |
| `GET /editing/live` | listed user | WebSocket upgrade to the "X is editing" room (Durable Object). `501` if not bound. |
| `GET /proposals`, `POST /proposals` | listed user | List suggested changes visible to you / send one (`{ region, feature, note }`). |
| `GET /proposals/<id>` | listed user | One suggestion. |
| `POST /proposals/<id>/accepted`, `…/declined` | reviewer | Mark a suggestion decided (declined takes `{ reason }`). Accepting only records it; the reviewer then saves the region normally. |
| `DELETE /proposals/<id>` | proposer; or a reviewer once it is decided | Withdraw a suggestion, or clear a decided one. |
| `GET /comments` | listed user | Reviewer comments you may see (your own, and those on regions you may edit). Query `region` narrows it. One KV read, never a list. |
| `POST /comments` | listed user | Drops a comment `{ region, text (240 chars), lon, lat }`. Up to 20 open per person. |
| `POST /comments/<id>/resolved`, `…/open` | may edit the region | Ticks a comment off / reopens it. |
| `DELETE /comments/<id>` | author, or may edit the region | Deletes a comment. |
| `GET/POST/PATCH /gh/repos/<repo>/…` | see below | Allow-listed copy of the GitHub REST API. |

## `/gh/` proxy

Reads (any signed-in user): `GET` repo info, `contents/<path>`, `git/ref/heads/<branch>`, `git/blobs/<sha>`, `git/trees/<sha>`, `git/commits/<sha>`, `commits` (`path`, `sha`, `per_page`), `actions/runs`. Blobs and trees are returned with long-lived cache headers because they are named by hash. Nothing else is passed on.

Writes (need at least one change permission): `POST git/blobs` (size capped), `POST git/trees` (only `100644` blob entries, only under `content/`, capped number of files), `POST git/commits` (exactly one parent; the author is forced to the signed-in person's noreply address, message capped at 2000 chars). None of these change a branch.

`PATCH git/refs/heads/<branch>` is the step that publishes a change, and where rules are enforced. It must be the configured branch, `force` must be false, and the new commit must be a fast-forward of the current head (otherwise `422 Update is not a fast forward` and the admin page rebuilds on the new head and retries). The commit must be credited to the caller. Then the API diffs the commit against the head and, using permissions read fresh at the head (`content/access.json`), checks each changed file:

- who may change it (`src/shared/access.ts`: creators edit their own regions; `editOthers`, `deleteOthers`, `renameIds`, `maps`, `users` for the rest);
- that it matches its JSON schema (regions, pins, access, categories, pin maps, slots, maps);
- cross-file rules: category and pin-map folder moves, id changes, per-commit limits (`src/shared/categories.ts`).

Problems come back as `403` with `errors: [...]`; a clean commit moves the branch and clears the permissions cache.

## Bindings and settings

| Name | Kind | Purpose |
|---|---|---|
| `REPO`, `BRANCH`, `OWNER_ID`, `ADMIN_URLS` | vars | Content repo, branch it writes, owner account id (always has every permission), allowed sign-in return URLs. |
| `APP_ID`, `APP_CLIENT_ID`, `APP_PRIVATE_KEY`, `APP_CLIENT_SECRET` | App credentials | The site's GitHub App. |
| `SESSION_KEY` | secret (32+ chars) | Signs sessions. Changing it signs everyone out. |
| `WAITING` (KV) | optional | Waiting list; also the fallback store for prefs and proposals. |
| `PREFS`, `PROPOSALS` (KV) | optional | Themes, suggested changes. |
| `COMMENTS` (KV) | optional | Reviewer comments (one value, `comments`); falls back to `PROPOSALS`, then `WAITING`. |
| `RATE_LIMITER` | optional binding | Cross-instance rate limit. |
| `EDITING_ROOM` | Durable Object | "X is editing" presence. No storage; pings are auto-answered while hibernating. |

KV has a small daily write/list limit on the free plan: never put or list KV per poll or per keystroke (see the 2026-11-16 incident, fixed by moving presence to the Durable Object).

## Generated validators

`worker/src/generated/validators.js` is built from `schema/*.json` by `npm run worker:validators` (Workers can't compile schemas at run time). Never merge it by hand; see [parallel-work.md](parallel-work.md).

## Tests

`tests/admin-api.test.ts` runs `handle()` against an in-memory GitHub; `tests/presence.test.ts` runs the room against fake sockets; `scripts/e2e/admin-api.mjs` fronts the admin page with the real handler for the browser suites.
