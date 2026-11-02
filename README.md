# World globe embed

A lightweight 3D globe for embedding in an Obsidian Publish site (or any page) with an `<iframe>`. It's a stripped-down web port of the globe viewer from [Fantasy-World-Visualizer](https://github.com/Flanz1/Fantasy-World-Visualizer). It's fully static and hosted on GitHub Pages.

- **Viewer:** `https://flanz1.github.io/world-globe-embed/v/<slot>/`
- **Admin page:** `https://flanz1.github.io/world-globe-embed/admin/`
- **Slot list with embed codes:** `https://flanz1.github.io/world-globe-embed/`

Maps and settings live in this repo. Anyone with write access can change which map an embed shows, without writing code and without a local setup.

## Embedding in Obsidian Publish

Paste this into a note:

```html
<iframe src="https://flanz1.github.io/world-globe-embed/v/aerthos/?grid=1&rotate=1"
        width="100%" height="480" style="border:0;border-radius:8px;background:transparent"
        loading="lazy" allow="fullscreen" title="Aerthos globe"></iframe>
```

Query parameters override the slot's defaults:

| Param | Values | Meaning |
|---|---|---|
| `grid` | `0` / `1` | Grid overlay (15° lines, gold equator, red prime meridian) |
| `legend` | `0` / `1` | Grid legend (shown only while the grid is on) |
| `rotate` | `0` / `1` | Slow auto-spin on load |
| `controls` | `0` / `1` | The small grid and fullscreen buttons |
| `bg` | `transparent` or a hex colour like `%23101010` | Background (`#` must be written as `%23` in a URL) |
| `lat`, `lon` | degrees | Point facing the viewer at load |
| `zoom` | `0.47` to `2.2` | `1` is the default framing; larger is closer |

How it moves: on load the globe spins slowly from the slot's default view. As soon as someone drags, pinches or scrolls, the spin stops for the rest of that visit, and the globe then moves only while they move it, with no drift or momentum. Nothing is remembered between visits. With "reduce motion" turned on in the OS, the globe starts still.

> **Transparent background tip:** browsers only keep an iframe transparent when its colour scheme matches the page's. If you see a white or black box around the globe, set `bg` to your theme's background colour, e.g. `bg=%23202020`.

## How to change the map (no coding needed)

### Option A: GitHub website

**1. Upload the image**

1. Open the repo on GitHub and go into the folder **`content/incoming`**.
2. Click **Add file → Upload files** and drag in your map. It must be an equirectangular PNG, JPEG or WebP, about twice as wide as it is tall (e.g. 4096×2048).
   - The file name becomes the map's id: `Aerthos v2.png` becomes `aerthos-v2`.
   - Images wider than 4096 px are fine, but they make the repo bigger. Downscale them first if you can.
3. Leave **Commit directly to the `main` branch** selected and click **Commit changes**.
4. Open the **Actions** tab. A run called **Process maps** converts the image (usually 1 to 2 minutes). Once it's green, there's a new file `content/maps/aerthos-v2.json`.
   - If it's red, open the run to see why (for example "is 3000×2000 (ratio 1.500:1)"). Delete your file from `content/incoming`, fix the image and try again. **The site won't redeploy while a rejected image is still sitting in `content/incoming`.**

**2. Point the embed at it**

1. Open **`content/slots.json`** and click the pencil icon (**Edit this file**).
2. Find your slot and change its `"map"` value to the new id:
   ```json
   "aerthos": { "map": "aerthos-v2", "title": "Aerthos", ... }
   ```
3. Click **Commit changes…** and then **Commit changes**.
4. The **Deploy** run in the Actions tab publishes it. Allow up to about 10 minutes for GitHub Pages caching.

You don't need to wait for step 1 to finish before doing step 2. If the map isn't processed yet, the deploy waits for it. If you mistype a map id, the deploy fails with a message like `slot "aerthos" points at map "aerthos-v3", which doesn't exist. Did you mean "aerthos-v2"?` and the live site stays as it was. Fix the typo the same way.

**To add a new embed (slot)**, add another entry to `content/slots.json`. Slot names use lowercase letters, digits and dashes. Its address is `/v/<slot name>/`.

### Option B: admin page

Open `/admin/` on the site and sign in with a token (see [Tokens for the admin page](#tokens-for-the-admin-page)). From there you can:

- see every map (with thumbnails) and every slot;
- **switch a slot's map** with a preview;
- **upload a map**, optionally switching a slot to it in the same commit (the image is downscaled to at most 4096 px in your browser first);
- copy each slot's embed code;
- follow the latest workflow runs, so you can see when your change is live.

Each action is a single commit made under your own GitHub account.

### Slot settings (`content/slots.json`)

| Field | Default | |
|---|---|---|
| `map` | (required) | Map id, the file name in `content/maps/` without `.json` |
| `title` | the map's name | Page title, and the iframe title in copied embed codes |
| `grid` | `false` | Grid overlay on load |
| `legend` | `false` | Grid legend |
| `rotate` | `true` | Auto-spin on load |
| `controls` | `true` | Show the grid and fullscreen buttons |
| `bg` | `"transparent"` | Or a hex colour like `"#202020"` |
| `lat`, `lon` | `15`, `0` | Point facing the viewer at load |
| `zoom` | `1` | Initial zoom |

The schema is in `schema/slots.schema.json`. Editors like VS Code use it for autocomplete and error highlighting. To rename a map, edit `"name"` in its `content/maps/<id>.json`. Leave the other fields alone.

### Who changed what

The history is the activity log:

```fish
git log --stat -- content/
```

On GitHub, open `content/` (or `content/slots.json`) and click **History**.

## One-time setup (repo owner)

1. **Enable Pages:** go to **Settings → Pages → Build and deployment → Source** and pick **GitHub Actions**. On a free account the repo has to be public for Pages.
2. **Allow the workflows to commit:** go to **Settings → Actions → General → Workflow permissions**. The default read-only setting is fine, because each workflow asks for the permissions it needs. If your account forces something stricter, choose **Read and write permissions**.
3. **First deploy:** push to `main`, or run **Actions → Deploy → Run workflow**.
4. **Add collaborators:** go to **Settings → Collaborators → Add people**. On a personal account, collaborators get write access to the whole repo, which is why the embed lives in its own repo and not in the app's.
5. **Custom domain (optional):** go to **Settings → Pages → Custom domain**. The build only uses relative URLs, so nothing in the code needs to change.

### Tokens for the admin page

The admin page works in your browser only. It sends your token only to `api.github.com` and never logs it. By default the token is kept in `sessionStorage`, so it's gone when you close the tab; tick **Remember on this device** to keep it in `localStorage` until you press **Forget token** (only do that on your own computer). The page refuses tokens with more than the `public_repo` scope, refuses to run inside a frame, and ships a strict Content-Security-Policy. It has `noindex` and is harmless without a token.

Keep in mind that every GitHub Pages site under `flanz1.github.io` shares one browser origin, so script on any of those sites could read a remembered token. Serving this repo from its own custom domain removes that.

- **Repository owner:** create a [fine-grained token](https://github.com/settings/personal-access-tokens/new). Pick **Only select repositories → world-globe-embed**, then under **Repository permissions** set **Contents: Read and write**. Optionally add **Actions: Read-only** for the run status, which works without it on a public repo. Give it an expiry.
- **Collaborators:** GitHub [doesn't allow fine-grained tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) to write to a personal account's repo where you're only a collaborator. Collaborators should create a [classic token](https://github.com/settings/tokens/new?scopes=public_repo&description=Globe%20maps%20admin) with **only** the `public_repo` scope and a short expiry. Alternatively, move this repo into a (free) GitHub organization: then everyone can use fine-grained tokens limited to this one repo.

## Local development

Requires Node 22+. On Fedora: `sudo dnf install nodejs`. All commands are for the fish shell.

```fish
git clone https://github.com/Flanz1/world-globe-embed.git
cd world-globe-embed
npm ci

npm run dev                  # http://localhost:5173/v/aerthos/ and /admin/
npm run check                # typecheck + lint + tests
npm run validate             # check content/slots.json and content/maps
npm run build                # production build into dist/
npm run preview              # serve dist/ at http://localhost:4173/v/aerthos/

# Process images sitting in content/incoming/ locally (CI normally does this)
npm run process-maps

# Regenerate the procedural sample map
npm run sample

# Build as the workflow does, with an explicit base path
env BASE_PATH=./ npm run build

# Cold-load timings in headless Chromium, with the embed in a cross-origin iframe
# (needs Playwright + Chromium installed globally)
npm run build; and npm run measure

# The admin page's repo comes from GITHUB_REPOSITORY (set automatically in Actions)
set -x GITHUB_REPOSITORY Flanz1/world-globe-embed
npm run build
set -e GITHUB_REPOSITORY
```

### Layout

```
content/
  slots.json            which map each embed shows, plus per-slot defaults
  maps/<map-id>.json    map metadata (written by process-maps)
  incoming/             drop new images here
public/maps/<map-id>/   processed WebPs: <hash>-1024.webp, -2048, -4096 (written by process-maps)
schema/                 JSON schemas for slots.json and map metadata
src/viewer/boot.ts      tiny inline boot script (poster, params, starts loading)
src/viewer/globe.ts     Three.js globe, loaded with import() after first paint
src/shared/             types, query params, the per-slot page template
src/admin/              admin page code (admin/index.html is the page)
scripts/                processing, validation, page generation, sample, measurement
.github/workflows/      process-maps.yml, deploy.yml, ci.yml (PR checks)
```

### How a page loads

1. `v/<slot>/index.html` is generated at build time. Its CSS, the slot config and a blurred LQIP of the map (about 1 KB) are inlined, so the first paint shows a globe-shaped poster with no extra request.
2. After first paint, the inline boot script creates the WebGL context and `import()`s the viewer (Three.js and the globe code). The 1024px texture is already downloading thanks to `<link rel="preload">`.
3. The globe crossfades in over the poster with the 1024px texture. It then loads the 2048px texture, or 4096px on large, high-DPI desktop screens, and crossfades to it.
4. It renders only while something moves, and pauses completely when it's scrolled out of view or the tab is hidden.
5. Without WebGL, it shows the flat 2048px map.

## GitHub Pages limits and pruning old maps

- The published site can be up to **1 GB**, a single file up to **100 MB**, and there's a soft cap of **100 GB/month** of bandwidth. A 4096×2048 map is usually 0.3 to 3 MB for all three sizes, so hundreds of maps fit.
- The **repo** should stay under about 1 GB too. Every upload stays in git history, which is why the admin page downscales before uploading.

**To remove a map you no longer use:** make sure no slot uses it (`npm run validate` or the deploy will tell you), then delete both `content/maps/<id>.json` and the folder `public/maps/<id>/`. On GitHub, open the file or folder, click **⋯ → Delete**, and commit. The next deploy drops it from the site.

Deleting files doesn't shrink git history. If the repo itself ever gets too big, the history can be rewritten with `git filter-repo`, but that's a last resort, and every collaborator has to re-clone afterwards.

## License

MIT. The globe and grid code is ported from Fantasy-World-Visualizer (MIT).
