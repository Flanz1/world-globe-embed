# Content model

Everything the site shows lives under `content/` and `public/maps/`, and is validated on every build (`npm run validate`, `scripts/lib/content.ts`) and on every admin save (the Worker uses the same JSON schemas). The schemas in `schema/*.schema.json` are the source of truth for field names; this page explains how the files relate.

| File | Written by | Schema | Holds |
|---|---|---|---|
| `content/slots.json` | admin page (Maps & slots) or by hand | `slots.schema.json` | One entry per embeddable address `/v/<slot>/`: which `map`, `title`, default `view`, `grid`, `rotate`, `legend`, `controls`, `bg`, `lat`/`lon`/`zoom`, pole padding (`north`, `south`, `pole`), `shift` (prime meridian), `radius` (world radius in km, turns on the ruler). |
| `content/maps/<id>.json` | `process-maps` | `map.schema.json` | Metadata of a processed image: `hash`, `width`/`height`/`aspect`, `sizes` (WebP per width), `tiles` (levels above 8192), `coast` (coast file), `lqip` (blurred poster), `uploadedBy`, `date`. |
| `public/maps/<id>/` | `process-maps` | | `<hash>-1024.webp` … `-8192.webp`, tiles `<hash>-16384-<col>-<row>.webp`, `<hash>-coast.bin`. The hash is in the name so files can be cached for ever. |
| `content/regions/<id>.json` | region editor | `region.schema.json` | One GeoJSON Feature per region. See below. |
| `content/pins/<id>.json` | Pins tab | `pin.schema.json` | One GeoJSON Point Feature per pin: `slot`, `map`, `name`, `kind`, `pinMap`, `color`, `description`, `link`, creator/updater stamps. |
| `content/pinmaps.json` | Pins tab | `pinmaps.schema.json` | Pin maps (named, embeddable sets of pins, each on one slot) and the folders they sit in. |
| `content/categories.json` | Regions tab | `categories.schema.json` | Region folders: nested, each lists region ids. A region is in at most one; others show as "Uncategorized". |
| `content/access.json` | Users tab | `access.schema.json` | Who may use the admin page: GitHub account id + login + permissions. See [admin-access.md](admin-access.md). |
| `content/incoming/` | uploads | | Drop folder for new images; emptied by `process-maps`. |

Accounts store the permanent numeric GitHub **id** next to the login, because logins can be renamed.

## Regions

`id` (equals the file name, lowercase letters, digits, dashes; embeds use `?region=<id>`, so it only changes through More… → Rename…) and `geometry` (Polygon or MultiPolygon, one polygon per **part**) plus `properties`:

- **Where it lives:** `slot`, `map`. Coordinates are `[lon, lat]` in the map image's own frame, not adjusted for pole padding or `shift` (viewers apply those; `shared/geo.ts` has `imageToGlobe`).
- **Look:** `color`, `colorLabel`, `fillOpacity`, `label`, `description`, `nationalBorders`, `provinceBorders`.
- **Parts (arrays indexed like the polygons):** `partLabels`, `partLabelHidden`, `partLocked`, `partContested`, `partOccupied`, `partLegend`. Parts are layers: a later part covers an earlier one (`shared/layers.ts`); where parts of different colours overlap the land is contested (`shared/clash.ts`, `region-paint.ts`). Colour folders group parts by colour (`colorLabel`, `partLegend`, `legend`, `legendTitle`).
- **Combining:** `linked`, `linkedNames` for a combined region that follows other regions.
- **Showing other things in the embed:** `under` (regions drawn under this one), `underClip`, `underTitle`, `ownToggle`, `layerLabel`, `pinMaps`.
- **Stamps:** `created`, `createdBy`, `updated`, `updatedBy`. `createdBy` decides who may edit or delete it (`shared/access.ts`).

`shared/json.ts` writes region files with each `[lon, lat]` on one line, which keeps files and diffs small. Always save through it.

## IDs

Slot, map, region, pin, pin map and category ids all match `^[a-z0-9][a-z0-9-]{0,63}$`. A map's file name must equal its `id`; the Worker rejects a mismatch.
