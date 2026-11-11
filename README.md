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
| `view` | `globe` / `flat` | Open on the 3D globe or the flat map (the slot's default view otherwise) |
| `grid` | `0` / `1` | Grid overlay (15° lines, gold equator, red prime meridian) |
| `legend` | `0` / `1` | Grid legend (shown only while the grid is on) |
| `rotate` | `0` / `1` | Slow auto-spin on load |
| `controls` | `0` / `1` | The small buttons in the corner (globe/flat switch, grid, fullscreen) |
| `bg` | `transparent` or a hex colour like `%23101010` | Background (`#` must be written as `%23` in a URL) |
| `lat`, `lon` | degrees | Point facing the viewer at load |
| `zoom` | `0.47` to `2.2` | `1` is the default framing; larger is closer |
| `north`, `south` | `0` to `49` | Percent of the globe left unmapped at each pole (pole padding) |
| `pole` | hex colour like `%23e8dcc8` | Fill colour for the padded polar areas |
| `shift` | `-180` to `180` | Prime meridian: moves the map east (+) or west (−) by this many degrees |

How it moves: on load the globe spins slowly from the slot's default view. As soon as someone drags, pinches or scrolls, the spin stops for the rest of that visit, and the globe then moves only while they move it, with no drift or momentum. Nothing is remembered between visits. With "reduce motion" turned on in the OS, the globe starts still.

> **Transparent background tip:** browsers only keep an iframe transparent when its colour scheme matches the page's. If you see a white or black box around the globe, set `bg` to your theme's background colour, e.g. `bg=%23202020`.

## Regions

A region is an outline (a kingdom, a province, a battlefield) drawn on a slot's map. An embed can show one region: it outlines and labels it, centres the globe or flat map on it and starts locked there, so the note it sits in scrolls normally.

### Drawing and editing a region

1. Open the admin page and sign in, then pick the **Regions** tab (the address ends in `#regions`, so a reload stays there).
2. Choose a slot and press **New region**, or press **Edit** on an existing card.
3. Draw on the flat map. A new region starts on the freehand tool (drag to draw, let go to close); press `P` for the polygon tool. The map wraps round left and right, so a region can cross the ±180° edge.
4. Set its **Id** (lowercase letters, digits and dashes; embeds use it, so it can't change after the first save), and a colour under **Colours and legend**, in the side panel. Each part can have its own label: type it into that part's row in the **Parts** list and the embed shows it on that part. Leave a row empty for no label. The globe preview on the right updates as you draw, and **Centre on region** turns it to face the region.
5. Press **Save**. Each save is one commit that changes only `content/regions/<id>.json`. If someone changed the same file on GitHub since you opened it, the editor refuses to overwrite it and offers to reload.

| Keys and mouse | Does |
|---|---|
| `V` / `P` / `F` | Select, polygon and freehand tools |
| Click (polygon) | Add a point; double-click, `Enter` or click the first point to close |
| `Backspace` while drawing | Remove the last point |
| `Esc` | Cancel the outline being drawn, or clear the selection (vertices first, then the selected part) |
| Drag a vertex | Move it; hold `Shift` to snap to a neighbouring region's vertex |
| Drag a midpoint | Insert a vertex there |
| `Alt`+click, right-click | Delete a vertex |
| `Shift`+click, box drag | Select several vertices |
| `Delete` / `Backspace` | Delete the selected vertices |
| Click inside a part, its badge or **Select** in its row | Select that part (yellow outline, filled badge) |
| `Alt`+click inside | Where parts overlap: select the next part under the pointer (the status line says "Part 3 (1 of 2 here…)") |
| Drag inside a part | Move that part (with its holes); `Ctrl`+drag (`Cmd` on macOS) moves the whole region |
| Arrow keys | Nudge the selected vertices, else the selected part, else the whole region, 1 px; `Shift` for 10 px |
| `Ctrl+Z`, `Ctrl+Shift+Z` / `Ctrl+Y` | Undo and redo (at least 100 steps; a whole drag is one step) |
| Wheel / pinch | Zoom around the cursor |
| `Space`+drag, middle drag | Pan |
| `G` | Grid |
| `?` | This list, in the editor |

**Add part** draws another separate piece (islands), **Cut hole** draws a hole inside a part (a lake). **Simplify…** removes vertices with a live preview and before/after counts, **Smooth** rounds the corners (one pass per click). An edit that would make an outline cross itself is refused and the vertex snaps back. The limit is 5,000 vertices per region.

**Colours and legend.** A region can use several colours, for example one per province or per faction. In the editor's side panel, under **Colours and legend**, press **Add colour** and give each colour a label; then pick a colour for each part in the **Parts** list. Each part has a numbered badge on the map that matches its row; pointing at either one highlights the other. Parts left on "Default colour" use the colour set at the top of that section. The embed shows the labelled colours as a small legend in the top-left corner, under the legend title you set (default "Legend"); readers can fold it away by clicking its header. Up to 16 colours per region. Removing a colour sends its parts back to the default colour; undo brings it back.

**Contested zones.** A contested zone is land a part claims but doesn't firmly hold. The embed draws it with a dashed border and a lighter, hatched fill, in the colour of the part it extends (or in its own legend colour, if you pick one for it, to show who else claims it). To add one, select a part and press **Add contested zone**, then draw it with the polygon or freehand tool; with no part selected, the editor asks which part it extends. To turn an existing part into a zone, or back into a normal part, use the **Contested of** dropdown in its row of the **Parts** list; zones are listed, indented, under their part, and their badges on the map have a dashed ring. A part that has zones of its own can't become one. Moving a part leaves its zones where they are, unless you tick **Move contested zones with their part**. Deleting a part turns its zones into normal parts (the editor says so).

**Locked parts.** Press **Lock** in a part's row of the **Parts** list (or select the part and press `L`) to lock it while you work around it. A locked part can't be dragged, nudged with the arrow keys, or moved with the whole region (`Ctrl`+drag refuses while any part is locked), but you can still drag its vertices and midpoints to reshape it; dragging inside it draws a selection box instead. Its badge on the map gets a small padlock. A locked contested zone stays put when its part moves with **Move contested zones with their part** ticked. The lock is saved with the region and only affects the editor; the embed ignores it.

**Overlaps are dashed automatically.** Wherever two parts overlap, or one lies inside another, the stretch of each border that lies inside the other part is drawn dashed and the overlap is hatched, so the overlap reads as contested with no extra work. Parts that only touch along a shared edge or at a vertex (snapped with `Shift`) stay solid, and so does a part sitting in another's hole. The same goes for overlaps with other regions on the same slot: the editor shows them live and lists every overlap under **Overlaps** in the side panel (for example "Part 2 overlaps *Kingdom of Vael*"); the build adds the other regions' overlapping outlines to the embed's data, so a region embed marks those overlaps too, without drawing the other region. When a region has a contested zone or an overlap, its legend gets a **Contested** row with a dashed swatch.

Regions are identified by their id; there is no separate name. Regions saved before part labels existed show their old name once, in the middle of the region, until you open and save them: the editor then moves that name into part 1's label. **Duplicate** opens an unsaved copy with a new id. **Delete** asks you to type the region's id; embeds of a deleted region fall back to the plain globe with a small "Region not found" note.

### How regions are stored

Each region is a GeoJSON Feature in `content/regions/<id>.json`, checked against `schema/region.schema.json` by `npm run validate` and in CI:

- Coordinates are `[longitude, latitude]` in the **map image's** frame: longitude −180 at the image's left edge to 180 at its right edge, latitude 90 at the top to −90 at the bottom. Pole padding and the prime-meridian shift are applied when drawing, so changing a slot's padding or shift keeps regions on the same land.
- An edge between two points always takes the shorter way round, so `170 → -170` crosses the ±180° line (20°), never the long way (340°). A single ring may span at most 180° of longitude and can't go round a pole; split anything bigger into parts.
- Outer rings run counter-clockwise and holes clockwise, every ring is closed, nothing crosses itself, and coordinates have at most 4 decimals.
- `properties.legend` is an optional list of `{ "label", "color" }` entries (at most 16), and `properties.partLegend` gives one number per part (per polygon, in order): the index of the legend entry that part is drawn in, or `-1` for the region's own `color`. Leave both out for a single-colour region. `properties.legendTitle` is the legend's heading.
- `properties.partLabels` is an optional list with one text per part (`""` for none), shown on each part in the embed. `properties.name` is optional and only used by older regions without part labels.
- `properties.partContested` is an optional list with one number per part: `-1` for a normal part, or `k` (counted from 0) for a contested zone extending part `k`, which must itself be a normal part. Leave it out when there are no zones.
- `properties.partLocked` is an optional list with one `true`/`false` per part: `true` for a part locked in the editor. It doesn't change the embed. Leave it out when nothing is locked.
- The overlaps with other regions aren't stored in the region file: the build works them out per slot and adds a compact `clash` field (just the other regions' overlapping outlines, at most 2,000 vertices, simplified if bigger) to `regions/<id>.json`.
- `properties.slot` must name an existing slot. `properties.map` records which map it was drawn on; if the slot now shows a different map, validation warns (it doesn't fail) and the admin card says "drawn on a different map".

### Embedding a region

Press **Copy embed code** on a region's card (or **Embed code…** in the editor) and paste the snippet into a note:

```html
<iframe src="https://flanz1.github.io/world-globe-embed/v/aerthos/?region=old-kingdom"
        width="100%" height="480" style="border:0;border-radius:8px;background:transparent"
        loading="lazy" allow="fullscreen" title="Old Kingdom (Aerthos)"></iframe>
```

Region embeds take these parameters on top of the ones above:

| Param | Values | Meaning |
|---|---|---|
| `region` | a region id | The region to show (it must belong to this slot) |
| `view` | `globe` / `flat` | 3D globe (default) or the flat map; the flat view never loads Three.js |
| `label` | `0` / `1` | Part labels (default: the region's own "Show part labels in embed" setting) |
| `dim` | `0` / `1` | Dim everything outside the region |
| `lock` | `0` / `1` | `1` (default) starts locked on the region; `0` starts unlocked |
| `key` | `0` / `1` | `0` hides the region's colour legend (shown by default when the region has one), including its "Contested" row. Not the same as `legend`, which is the grid legend |
| `clash` | `0` / `1` | `0` stops marking overlaps with other regions on the slot (dashes and hatching from the build-time data); overlaps between the region's own parts and its contested zones are always shown. The embed-code popover's "Mark overlaps with other regions" box sets it |
| `lat`, `lon`, `zoom` | as above | Override the automatic framing (in the flat view: centre in map degrees and a zoom multiplier) |

`rotate` defaults to off for region embeds.

**View lock:** a region embed starts locked on the region. While locked, dragging, scrolling and pinching over it do nothing to the view and go to the page instead, so the note scrolls as usual. Press the padlock (bottom right) to unlock and move freely; press it again to glide back (in under 300 ms, instantly with "reduce motion") to the region and lock. Nothing is remembered: every load, reload or back-navigation starts locked again. The padlock shows even with `controls=0`.

## How to change the map (no coding needed)

### Option A: GitHub website

**1. Upload the image**

1. Open the repo on GitHub and go into the folder **`content/incoming`**.
2. Click **Add file → Upload files** and drag in your map: an equirectangular PNG, JPEG or WebP. 2:1 (e.g. 4096×2048) looks best, but anything from square up to 4:1 is accepted. The globe stretches it to fit, and pole padding can fill in the rest (see below).
   - The file name becomes the map's id: `Aerthos v2.png` becomes `aerthos-v2`.
   - Images 8192 px wide or more also get an extra-sharp 8192 px version, which zoomed-in embeds (especially region embeds) load after the 4096.
   - Images 16384 or 32768 px wide or more also get **close-up tiles** at that size: the map cut into 2048 px squares, of which an embed at (or near) its closest zoom loads only the few under the view. Anything wider than 32768 is used for the 32768 tiles, so there's no point going bigger.
   - GitHub refuses files over 100 MB, and the web upload stops at 25 MB, so for a big map use the admin page (below) or `npm run import-map` (see "Very large maps").
   - Big images make the repo bigger. If you don't need the close-ups, downscale to 4096 or 8192 px first.
3. Leave **Commit directly to the `main` branch** selected and click **Commit changes**.
4. Open the **Actions** tab. A run called **Process maps** converts the image (usually 1 to 2 minutes). Once it's green, there's a new file `content/maps/aerthos-v2.json`.
   - If it's red, open the run to see why (for example a portrait image, or one wider than 4:1). Delete your file from `content/incoming`, fix the image and try again. **The site won't redeploy while a rejected image is still sitting in `content/incoming`.**

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
- **upload a map**, optionally switching a slot to it in the same commit (up to 16384 px wide the image is re-encoded in your browser first, which also strips its metadata. Wider images go up as they are, with their metadata stripped, in 8 MB parts that process-maps joins again, and must be under 100 MB: save them as JPEG at quality 80–90. A 32768 px wide map is usually 40–70 MB);
- **preview** any map or slot on the page itself as a real, spinnable globe. For a slot, you can adjust the north/south pole padding, pole colour and prime meridian live, use **Fit padding to image** for maps wider than 2:1, see whether the map is stretched or squashed, and **Save to slot**;
- copy each slot's embed code;
- follow the latest workflow runs, so you can see when your change is live.

Each action is a single commit made under your own GitHub account.

### Slot settings (`content/slots.json`)

| Field | Default | |
|---|---|---|
| `map` | (required) | Map id, the file name in `content/maps/` without `.json` |
| `title` | the map's name | Page title, and the iframe title in copied embed codes |
| `view` | `"globe"` | `"flat"` opens the embed on the flat map. Set it with *Default view* in the admin preview. Readers can still switch with the corner button. Embed codes don't carry it, so changing it updates embeds you've already pasted |
| `grid` | `false` | Grid overlay on load |
| `legend` | `false` | Grid legend |
| `rotate` | `true` | Auto-spin on load |
| `controls` | `true` | Show the globe/flat switch, grid and fullscreen buttons |
| `bg` | `"transparent"` | Or a hex colour like `"#202020"` |
| `lat`, `lon` | `15`, `0` | Point facing the viewer at load |
| `zoom` | `1` | Initial zoom |
| `north`, `south` | `0` | Pole padding: percent of the globe's height left unmapped at each pole, as in the desktop app |
| `pole` | `"#e8dcc8"` | Colour of the padded polar areas |
| `shift` | `0` | Prime meridian: degrees to move the map east (+) or west (−) so its own prime meridian lines up with the grid's red line (the desktop app's "Horizontal Shift") |

The schema is in `schema/slots.schema.json`. Editors like VS Code use it for autocomplete and error highlighting. To rename a map, edit `"name"` in its `content/maps/<id>.json`. Leave the other fields alone.

### Pole padding

As in the desktop app, padding leaves part of the globe unmapped at the north and/or south pole and fills it with a solid colour. This is useful when a map doesn't reach the poles. A map wider than 2:1 keeps its proportions when the padding adds up to `100 × (1 − 2 / ratio)` percent (e.g. 33% total for a 3:1 map), and the admin page's **Fit padding to image** button works that out for you. A map narrower than 2:1 (like 6000×3465) is squashed a little north–south to fit, the same as in the desktop app.

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

# Point the admin page at another branch, e.g. to try region editing without touching main.
# The page then says "Writing to branch … (not main)" at the top.
env VITE_CONTENT_BRANCH=test/region-overlays npm run build
env VITE_CONTENT_BRANCH=test/region-overlays npm run dev

# Timings for a region embed (globe, then flat)
env SLUG=aerthos QUERY='region=old-kingdom' npm run measure
env SLUG=aerthos QUERY='region=old-kingdom&view=flat' npm run measure

# Browser checks for regions: builds a throwaway copy with test content and drives the embeds
# and the admin editor in headless Chromium against a fake GitHub API (nothing is pushed).
# Screenshots and report.json go to .e2e/regions/
npm run e2e:regions
npm run e2e:contested # contested zones, dashed overlaps (embeds and editor), moving parts; .e2e/contested/
npm run e2e:locks     # locked parts in the region editor: no moving, vertices and midpoints still edit; .e2e/locks/
npm run e2e:tiers     # which texture sizes load, and in what order (1024 → 4096 → 8192 when zoomed in)
npm run e2e:tiles     # close-up tiles at max zoom (synthetic 32768 map; env TILES_MAP=your.jpg for your own)
npm run e2e:upload    # a big admin upload in 8 MB parts, with the progress bar (env UPLOAD_FILE=your.jpg for your own)
npm run e2e:view      # a slot's default view (globe or flat) in the embed and the admin preview
```

### Layout

```
content/
  slots.json            which map each embed shows, plus per-slot defaults
  maps/<map-id>.json    map metadata (written by process-maps)
  regions/<id>.json     region outlines (GeoJSON Features, written by the admin editor)
  incoming/             drop new images here
public/maps/<map-id>/   processed WebPs: <hash>-1024.webp, -2048, -4096, -8192, and tiles <hash>-16384-<col>-<row>.webp, -32768-… (written by process-maps)
schema/                 JSON schemas for slots.json, map metadata and regions
src/viewer/boot.ts      tiny inline boot script (poster, params, starts loading)
src/viewer/globe.ts     Three.js globe, loaded with import() after first paint
src/viewer/flat.ts      flat 2D map viewer (view=flat), no Three.js
src/shared/             types, query params, the per-slot page template
src/admin/              admin page code (admin/index.html is the page); editor/ is the region editor
scripts/                processing, validation, page generation, sample, measurement
.github/workflows/      process-maps.yml, deploy.yml, ci.yml (PR checks)
```

### How a page loads

1. `v/<slot>/index.html` is generated at build time. Its CSS, the slot config and a blurred LQIP of the map (about 1 KB) are inlined, so the first paint shows a globe-shaped poster with no extra request.
2. After first paint, the inline boot script creates the WebGL context and `import()`s the viewer (Three.js and the globe code). The 1024px texture is already downloading thanks to `<link rel="preload">`. For a region embed, `regions/<id>.json` is fetched at the same time, and the first frame is already centred on the region (its centre and zoom are inlined in the page).
3. The globe crossfades in over the poster with the 1024px texture. It then loads the 2048px texture, or 4096px on large, high-DPI desktop screens or when zoomed in, and crossfades to it.
   - Zoomed in further (a small region embed, or zooming in by hand), it loads in two stages: the 4096px texture first, then the 8192px one, if the map has it. The flat view (`view=flat`) does the same.
   - At (or near) the closest zoom, it then loads the close-up tiles under the view, if the map has them: the 16384 tiles first, then the 32768 ones on big or high-DPI screens. Only the few tiles on screen load (2048 px each, usually 50–300 KB), at most 16 are kept, and panning loads the next ones.
   - 8192 and the tiles are desktop only. Phones, devices that report under 4 GB of memory (Brave's randomized value is ignored), and GPUs whose largest texture is under 8192 stay at 4096. If the GPU runs out of memory, the embed keeps what it has.
4. It renders only while something moves, and pauses completely when it's scrolled out of view or the tab is hidden.
5. Without WebGL, it shows the flat 2048px map.

## Very large maps

Originals over 100 MB (for example a 49152 px PNG) are too big for the admin page. Process them on your own computer instead; only the small outputs get committed, and the original stays where it is:

```fish
cd world-globe-embed
npm ci
npm run import-map -- ~/Maps/world_map.png world-map   # path, then the map id (optional)
git add content/maps/world-map.json public/maps/world-map
git commit -m "Add map world-map"
git push
```

It needs several GB of free memory for a 30000+ px image and takes a few minutes. On Windows the same commands work in PowerShell.

## GitHub Pages limits and pruning old maps

- The published site can be up to **1 GB**, a single file up to **100 MB**, and there's a soft cap of **100 GB/month** of bandwidth. A 4096×2048 map is usually 0.3 to 3 MB for all three sizes, so hundreds of maps fit. An 8192×4096 upload adds an 8192 texture, typically 2 to 4 times the size of its 4096 one (so a few MB), which only zoomed-in desktop viewers download. Close-up tiles add about 6 MB (16384) and 23 MB (32768) per detailed map on the site, but a viewer only downloads the few under the view.
- The **repo** should stay under about 1 GB too. Every upload stays in git history, which is why the admin page downscales before uploading.

**To remove a map you no longer use:** make sure no slot uses it (`npm run validate` or the deploy will tell you), then delete both `content/maps/<id>.json` and the folder `public/maps/<id>/`. On GitHub, open the file or folder, click **⋯ → Delete**, and commit. The next deploy drops it from the site.

Deleting files doesn't shrink git history. If the repo itself ever gets too big, the history can be rewritten with `git filter-repo`, but that's a last resort, and every collaborator has to re-clone afterwards.

## License

MIT. The globe and grid code is ported from Fantasy-World-Visualizer (MIT).
