# Module map

One line per source file: what it is for. The first comment in each file says more. Files are grouped by where they run; see [architecture.md](architecture.md) for how the parts fit together. Test files are not listed (`tests/` mirrors `src/` by name); each `scripts/e2e/*.mjs` starts with a header describing its suite.


## Viewer (`src/viewer/`)

| File | Purpose |
|---|---|
| `src/viewer/boot.ts` | Tiny inline boot script, compiled to an IIFE and inlined into every slot page: poster, query params, starts loading the viewer. |
| `src/viewer/contract.ts` | The JSON inlined into each slot page (`#wge-data`): the shape the page generator writes and the boot script and viewers read. |
| `src/viewer/flat.ts` | The flat (2D) viewer for view=flat. |
| `src/viewer/globe-tiles.ts` | The globe's tile layers above 8192 (see shared/tiles.ts). |
| `src/viewer/globe.ts` | The 3D globe, ported from GlobePanel in Fantasy-World-Visualizer (src/App.jsx) as plain TypeScript with no React. |
| `src/viewer/pins.ts` | Map pins in the embed, shared by the globe and flat viewers: ?pins=1 (or ?pins=holy-sites for one pin map) fetches pins/<slot>.json and draws each pin as a small round marker on top of the map and the regions. |
| `src/viewer/region-ui.ts` | Region embed UI shared by the globe and flat viewers: the view lock, the region label and the "Region not found" note. |
| `src/viewer/ruler.ts` | The embed's ruler: a reader tool (corner button) that measures distance along the globe's surface and the area of a shape, in km or miles, using the world radius an admin set for the slot. |

## Shared (`src/shared/`)

| File | Purpose |
|---|---|
| `src/shared/access.ts` | Who may do what on the admin page: the permission names, the presets the Users tab offers, and the rules the admin API (worker/) applies to every change before it reaches the repository. |
| `src/shared/activity.ts` | Pure helpers for the admin Activity tab (kept apart from the DOM code so they can be unit tested). |
| `src/shared/borders.ts` | Shared borders: lines two parts of a region share exactly. |
| `src/shared/categories.ts` | Region categories: the folders the admin page's Regions tab sorts regions into (content/categories.json). |
| `src/shared/clash.ts` | Where parts overlap ("clash"): shared by the editor, the build and the renderers. |
| `src/shared/coast.ts` | Coastlines of a map, for snapping region edges to the shore in the admin editor. |
| `src/shared/combine.ts` | Combining several saved regions into one new region. |
| `src/shared/embed.ts` | Embed snippets for regions. |
| `src/shared/geo.ts` | Small geometry toolkit for regions, shared by the validator, the page generator, the viewer and the admin editor. |
| `src/shared/hct.ts` | HCT colour space (hue and chroma from CAM16, tone = CIE L*) and the Material You (M3) colour scheme the admin page and editor use. |
| `src/shared/history.ts` | The save log: who changed what in content/, and when, as the admin API's GET /history serves it. |
| `src/shared/json.ts` | Region files as text: pretty-printed JSON, except that a position stays on one line. |
| `src/shared/layers.ts` | Layer order for regions saved before parts were layers. |
| `src/shared/measure.ts` | Real-size maths for the embed's ruler and the editor's area readout. |
| `src/shared/page.ts` | Renders the static HTML for one slot (/v/<slug>/index.html). |
| `src/shared/params.ts` | Reads and normalises the embed's query parameters (`grid`, `bg`, `zoom`, pole padding, …) and the slot defaults they override. |
| `src/shared/pin-icons.ts` | Pin icons: line drawings in a 24×24 box, built as SVG elements (never from strings of markup). |
| `src/shared/pinmaps.ts` | Pin maps: named, embeddable sets of pins ("Holy sites", "Battles"), kept in folders that nest like the Regions tab's (content/pinmaps.json). |
| `src/shared/pins.ts` | Map pins: single places (a city, a ruin, a battle site…) on a slot's map. |
| `src/shared/raster.ts` | Draws a region onto a 2D canvas. |
| `src/shared/region-paint.ts` | Turns a region into what raster.ts paints: a colour per part, which parts overlap which, and the contested land where parts of different colours overlap. |
| `src/shared/region.ts` | Region types and helpers shared by the build, the viewer and the admin page. |
| `src/shared/rename.ts` | Changing a region's id (its file name, and so the `?region=<id>` of every embed that shows it). |
| `src/shared/theme-prefs.ts` | The colour theme of an account (accent seed + light/dark/system), as the admin page and the admin API both see it. |
| `src/shared/tiers.ts` | Which texture to load next. |
| `src/shared/tiles.ts` | Tile levels above 8192: the map at 16384 (and 32768) px wide, cut into square tiles, so a zoomed-in view loads only the few tiles it shows instead of a whole texture of half a gigabyte or more. |
| `src/shared/trash.ts` | The trash for deleted regions and map pins. |
| `src/shared/types.ts` | Shapes shared by the viewer, the build scripts and the admin page. |

## Admin page (`src/admin/`)

| File | Purpose |
|---|---|
| `src/admin/activity.ts` | Activity: who saved, moved or deleted what, from the admin API's save log (GET /history). |
| `src/admin/categories.ts` | Region folders (categories) on the admin page: the state (content/categories.json), who may change what, and the dialogs to add, rename, reorder, move and delete folders and to move regions between them. |
| `src/admin/comments.ts` | Reviewer comments on the admin page: one list read once and kept up to date by the person's own actions (never polled). |
| `src/admin/dom.ts` | Tiny DOM helpers for the admin page. |
| `src/admin/editing.ts` | A live link to the admin API's "who has a region open" room (worker/src/presence.ts). |
| `src/admin/github.ts` | Minimal GitHub REST client for the admin page. |
| `src/admin/images.ts` | Same-origin map images for the admin page's canvases (thumbnails and the region editor), cached. |
| `src/admin/main.ts` | Admin page: list maps and slots, upload a map, switch a slot's map, draw regions, manage users. |
| `src/admin/optimistic.ts` | Optimistic saves for the admin page. |
| `src/admin/pinmaps.ts` | Pin maps and their folders on the admin page's Pins tab (content/pinmaps.json): the state, the dialogs to add, rename, move, reorder and delete folders and pin maps, and the folder tree itself. |
| `src/admin/pins.ts` | The Pins tab: places (cities, ruins, battle sites…) marked on a slot's map. |
| `src/admin/preview-pins.ts` | Sends this slot's pins to a same-origin preview iframe, so the preview shows what the embed will (the pins aren't deployed yet). |
| `src/admin/preview.ts` | The admin page's preview dialog: shows the real viewer (preview/?map=<id>) in a same-origin iframe and adjusts pole padding live with postMessage, then optionally saves to a slot. |
| `src/admin/region-dialogs.ts` | Small dialogs for regions: embed code, rename, delete, preview, and a generic confirm. |
| `src/admin/region-filter.ts` | Search, creator filter and sorting for lists of regions. |
| `src/admin/region-history.ts` | Version history of one region: the saves that changed its file (who, when), a preview of an old outline dashed over the current one, and a one-click restore. |
| `src/admin/regions.ts` | The Regions tab: every saved region as a card with a thumbnail, and the actions on it (edit, rename, duplicate, delete, preview, copy embed code), and combining several regions into a new one. |
| `src/admin/session.ts` | Who is signed in to the admin page and what they may do. |
| `src/admin/status.ts` | The admin sidebar's "Checks" list: will this commit and deploy cleanly? |
| `src/admin/suggestions.ts` | Suggested changes, on the Regions tab. |
| `src/admin/theme.ts` | The account's colour theme: an accent colour (a seed the whole palette is made from, src/shared/hct.ts) and light / dark / follow the system. |
| `src/admin/trash.ts` | "Recently deleted": regions and map pins deleted in the last few days, with a Restore button. |
| `src/admin/upload-image.ts` | Getting an upload ready in the browser. |
| `src/admin/users.ts` | The Users tab: who may use the admin page and what they may do (content/access.json), plus the people who signed in but aren't on the list yet. |

## Region editor (`src/admin/editor/`)

| File | Purpose |
|---|---|
| `src/admin/editor/coast.ts` | The map's coastline as snap targets for the region editor (data: shared/coast.ts, made by scripts/lib/coast-mask.ts). |
| `src/admin/editor/comments.ts` | The region editor's Comment tool: click the map to leave a comment, numbered markers, a popover to read, resolve, reopen or delete. |
| `src/admin/editor/draft.ts` | Local copy of the editor's unsaved work, so a crash, a reload or a closed tab doesn't lose it. |
| `src/admin/editor/editor.ts` | The region editor: a flat equirectangular canvas for drawing and editing, with the real globe (the preview page) beside it, updated live by postMessage. |
| `src/admin/editor/fill.ts` | The fill tool: click inside an area and get its outline, traced out to the coast and to the borders of other parts and regions. |
| `src/admin/editor/live.ts` | Editing several saved regions together ("Edit together" in the Combine regions dialog): their parts load into one editor state, each part tagged with the region it belongs to (`owners`), and saving splits the state back into one… |
| `src/admin/editor/merge.ts` | Combining parts and extending a part with a drawn shape: polygon unions that also close small gaps between the shapes. |
| `src/admin/editor/model.ts` | The region editor's data model: pure functions on an immutable-ish state, plus an undo/redo command stack. |
| `src/admin/editor/overlay-filter.ts` | The editor's "Other regions" tool: a button at the right end of the toolbar that opens a panel (top right of the map) to choose which other regions are drawn as outlines (and used as snap targets). |
| `src/admin/editor/presence.ts` | "Someone is editing this": an editor tab tells the admin API's editing room which regions it has open (../editing.ts keeps a WebSocket to it), and hears straight away who else has regions open. |
| `src/admin/editor/snap.ts` | Snapping, border tracing and attached (glued) vertices for the region editor. |

## Admin API (`worker/src/`)

| File | Purpose |
|---|---|
| `worker/src/comments.ts` | Reviewer comments: anyone on the admin list can drop a short comment at a spot on a region; people who may edit the region see it and tick it off. Kept in one KV value, never listed. |
| `worker/src/crypto.ts` | Signing helpers for the admin API: HMAC-signed session and state tokens, and the GitHub App's RS256 JWT. |
| `worker/src/handler.ts` | The admin API: a Cloudflare Worker that is the only thing allowed to write to the repository. |
| `worker/src/index.ts` | Cloudflare Worker entry for the admin API (see handler.ts), and the Durable Object behind "X is editing" (presence.ts). |
| `worker/src/presence.ts` | "Who has a region open", kept live in one Durable Object (the EditingRoom class in index.ts) that every admin tab holds a WebSocket to. |
| `worker/src/proposals.ts` | Suggested changes: someone who can't edit a region (they didn't create it and lack "Edit others' regions") edits it anyway in the editor and sends the result as a proposal. |
| `worker/src/ratelimit.ts` | Rate limits for the public admin API, kept apart from the handler so the endpoints other features add only have to be listed in `limitFor`. |

## Build and content scripts (`scripts/`)

| File | Purpose |
|---|---|
| `scripts/build-worker-validators.ts` | Generates worker/src/generated/validators.js: the region, pin, access, categories, slots, map and prefs JSON schemas compiled to plain functions, because Cloudflare Workers can't compile schemas at run time (no eval). |
| `scripts/coast.ts` | Builds (or rebuilds) the coast file of maps that are already processed, from their textures: npm run coast                 every map npm run coast -- my-map    one map npm run coast -- my-map --mask out/mask.png   also write the… |
| `scripts/generate-pages.ts` | Post-build step: writes dist/v/<slug>/index.html for every slot, plus the landing page. |
| `scripts/import-map.ts` | Adds a map straight from a local image, for originals too big to upload to GitHub (over 100 MB, or wider than the admin page can take). |
| `scripts/lib/build-boot.ts` | Compiles `src/viewer/boot.ts` into a small minified IIFE for inlining. |
| `scripts/lib/coast-build.ts` | Builds a map's coast file (public/maps/<id>/<hash>-coast.bin) from its textures, and the pieces process-maps and `npm run coast` share. |
| `scripts/lib/coast-mask.ts` | Finds land and open sea in a painted map, and traces the coast between them. |
| `scripts/lib/content.ts` | Loads and validates content/slots.json, content/maps/*.json and content/regions/*.json. |
| `scripts/lib/landing.ts` | The small, unindexed landing page listing slots and their embed snippets. |
| `scripts/lib/pages.ts` | Generates the static files for a build: slot pages, the preview page, region and pin JSON. |
| `scripts/lib/paths.ts` | Repository paths (content, regions, pins, maps) shared by the scripts. |
| `scripts/lib/process.ts` | Turns an uploaded equirectangular image into WebP textures + LQIP + metadata. |
| `scripts/make-sample.ts` | Generates a procedural equirectangular test world (seamless, sampled on the sphere) and runs it through the same processing as uploads. |
| `scripts/measure.mjs` | Cold-load measurement in a headless browser, with the embed in a cross-origin iframe. |
| `scripts/migrate-layers.ts` | One-off: puts the parts of saved regions into layer order (see src/shared/layers.ts), so regions drawn before parts were layers look as they did: where parts overlap, the smaller one stays on top. |
| `scripts/preflight.mjs` | Pre-merge checks for a feature branch: run it before saying a PR is ready, and again after a rebase. |
| `scripts/process-maps.ts` | CLI used by process-maps.yml: validates every file in content/incoming/, then converts each to WebP textures + metadata and deletes the original. |
| `scripts/region-owners.ts` | One-off migration: gives every region without a creator (properties.createdBy) the GitHub account that first committed its file, read from the commit's GitHub noreply address (<id>+<login>@users.noreply.github.com). |
| `scripts/validate-content.ts` | CLI: validate content/ and exit non-zero with readable errors. |

## Other

| Path | Purpose |
|---|---|
| `admin/index.html` | The admin page's HTML (built by Vite with `src/admin/main.ts`). |
| `public/admin-theme-boot.js` | Tiny script that paints the cached colour theme before the admin page loads. |
| `schema/*.schema.json` | JSON schemas for every content file; compiled to `worker/src/generated/validators.js`. |
| `worker/src/generated/validators.js` | Generated; never edit or merge by hand (`npm run worker:validators`). |
| `vite.config.ts` | Build config plus the dev-server middleware that serves slot pages and regions from `content/`. |
| `.github/workflows/` | `ci.yml` (PR checks), `e2e.yml` (browser suites), `deploy.yml` (build and publish), `process-maps.yml` (image processing), `admin-api.yml` (Worker deploy). |
