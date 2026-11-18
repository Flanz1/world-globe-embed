# Architecture

World globe embed is a static site plus one small API. Everything readers see is static files on GitHub Pages; everything people edit is a commit to this repository, made through the API.

```
 Obsidian Publish note
   └─ <iframe src="editor.garmeley.com/v/<slot>/">            reader (no sign-in)
                │
                ▼
 GitHub Pages  (dist/ built by .github/workflows/deploy.yml)
   v/<slot>/index.html   generated page: inline CSS, config, LQIP poster, boot script
   regions/<id>.json     region outlines     pins/<slot>.json   map pins
   maps/<map-id>/…webp   textures + tiles    admin/             the admin page
                ▲
                │ commit on main (every edit is one commit)
 Admin page (src/admin) ──HTTPS──► Admin API (worker/, Cloudflare Worker, admin-api.garmeley.com)
   people sign in with GitHub          checks permissions + schemas, then moves main
                                       as the site's GitHub App
```

## The three runtimes

| Part | Code | Runs in | Notes |
|---|---|---|---|
| Viewer (embed) | `src/viewer/`, page template in `src/shared/page.ts` | Reader's browser | `boot.ts` is inlined; the globe (Three.js) or flat view loads after first paint. See [README → How a page loads](../README.md#how-a-page-loads). |
| Admin page + editor | `src/admin/`, `admin/index.html` | Contributor's browser | Static page, no server of its own. Talks to the Admin API only. |
| Admin API | `worker/src/` | Cloudflare Worker (+ one Durable Object) | The only writer to the repository. See [worker-api.md](worker-api.md). |
| Build and content scripts | `scripts/` | GitHub Actions, or locally | Validate content, process images, generate pages. |

`src/shared/` holds code used by more than one runtime (geometry, region painting, access rules, schemas' TypeScript types). It has no DOM and no Node-only imports unless a file says so, so it runs in the browser, the Worker and the build. Anything the Worker imports from `src/shared/` must stay Worker-safe (no `document`, no `fs`).

## Data flow

**Reading.** `scripts/generate-pages.ts` (after `vite build`) reads `content/` and writes `dist/v/<slot>/index.html`, `dist/regions/<id>.json`, `dist/pins/<slot>.json`, `dist/facts/<id>.json` (area, borders and pins per part; read only when a reader clicks a part) and the landing page (`scripts/lib/pages.ts`, `landing.ts`). The viewer only fetches those files and the map textures.

**Writing.** The admin page builds a Git tree in the browser (blobs → tree → commit) through the API's `/gh/…` proxy, then asks to move `main` to that commit. The API checks, for every changed file, that the person may change it (`src/shared/access.ts`) and that the JSON matches its schema (`schema/*.json`, compiled to `worker/src/generated/validators.js`). Only then does it fast-forward `main`. `main` is also protected on GitHub (PR + `check` required, only the App and admins bypass). See [admin-access.md](admin-access.md).

**Deploy.** A push to `main` runs `deploy.yml` (validate, build, publish to Pages). Pushes touching `worker/**`, `src/shared/access.ts` or `schema/*.schema.json` also run `admin-api.yml` and redeploy the Worker.

**Maps.** Uploads land in `content/incoming/`; `process-maps.yml` runs `scripts/process-maps.ts` (`scripts/lib/process.ts`) to make WebP sizes (1024 → 8192), tiles above that, a blurred LQIP and the coast file for snapping, commits them back and calls `deploy.yml`.

## Content model in one paragraph

A **slot** (`content/slots.json`) is an embeddable address (`/v/<slot>/`) bound to a **map** (`content/maps/<id>.json`, processed images in `public/maps/<id>/`). **Regions** (`content/regions/<id>.json`, GeoJSON Features) and **pins** (`content/pins/<id>.json`) belong to a slot and use the map image's own lon/lat frame. **Categories**, **pin maps** and **access** (`content/categories.json`, `pinmaps.json`, `access.json`) are admin-only organisation and permissions. Details: [content-model.md](content-model.md).

## Region rendering

A region is parts (polygons) with colours, layers and optional labels. `region-paint.ts` decides what to paint (a colour per part, overlaps, contested land); `raster.ts` paints it on a 2D canvas. The same painter makes the globe overlay texture, the flat embed, admin thumbnails and the editor, so all of them trace the same shape the same way. Overlaps, borders and layer order are covered by `clash.ts`, `borders.ts`, `layers.ts` and `combine.ts`.

## The editor

`src/admin/editor/` is the biggest module. `model.ts` is the pure state (parts, selection, undo/redo history) with unit tests; `snap.ts`, `fill.ts`, `merge.ts`, `live.ts`, `coast.ts` are pure helpers; `editor.ts` is the DOM, canvas and input layer that ties them together and talks to the globe preview over `postMessage`. `draft.ts` keeps unsaved work in IndexedDB; `presence.ts` reports which regions you have open to the API's "X is editing" room.

## Tests

- `npm test` (vitest, `tests/`): pure logic and the Worker handler against an in-memory GitHub.
- `npm run e2e`: headless Chromium suites in `scripts/e2e/`, each with a first-line `// e2e-suite:` header. See [parallel-work.md](parallel-work.md).
- `npm run check` = typecheck + lint + vitest.
