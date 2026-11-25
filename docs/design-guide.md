# Design guide

How the admin page, the region and pin editors and the embed should look and behave. New UI follows these rules;
the design review checks plans and PRs against them.

## Principles
- **Calm and familiar.** One look across tabs: the same feature has the same name, control and place everywhere.
- **The embed stays simple.** No settings in `/v/<slot>/`; only the small corner buttons (lock, ruler, view, grid,
  fullscreen) and the legend. Slot settings live in the admin preview dialog, saved with *Save to slot*.
- **Always live.** No static image exports of maps or regions: an embed must keep following the map.
- **Works at 375 px.** Nothing on the admin page scrolls sideways at phone width.

## Colours and type
- Material You (M3) colour roles, built in our own CSS (never @material/web). Every UI colour uses a role token from
  `src/admin/admin.css` `:root`: `--md-sys-color-primary`, `on-primary`, `primary-container`, `on-primary-container`,
  `secondary(-container)`, `on-secondary(-container)`, `surface`, `surface-container-lowest|low|(none)|high|highest`,
  `on-surface`, `on-surface-variant`, `outline`, `outline-variant`, `error(-container)`, `on-error(-container)`, plus
  project roles `--app-warn(-container)`, `--app-on-warn(-container)`, `--app-ok`. Values come from `schemeFromSeed()`
  in `src/shared/hct.ts` (default seed Gold #8a6a1f); never hard-code a UI colour or add a `var()` fallback.
- Old names (`--bg --fg --muted --card --line --accent --err --ok --warn`) are aliases for one release only: don't use
  them in new rules.
- Where things sit: page `surface`; header and editor toolbar `surface-container`; cards `surface-container-low`
  (with an `outline-variant` hairline); items inside cards `surface-container-high`; dialogs and floating panels
  `surface-container-high`; menus `surface-container`. Selected/pressed = `secondary-container` + a tick or outline.
- Themes: light/dark follow the system; `[data-theme=light|dark]` on `<html>` overrides it. Each account picks its
  own accent seed (header swatch menu: 8 presets + Custom…) and mode (sun/moon button; System in the menu), saved
  per account via the Worker `/prefs` (#135). The embed and region/pin/map colours are never themed.
- Map/canvas backgrounds use `--app-map-bg` (#14120f) in both themes. Region, pin and map colours are data.
- Native controls follow the accent (`accent-color`).
- System UI font. Text 15 px; buttons and labels 13–14 px weight 500; tiny hints 12 px (`.small`). Card titles
  16 px, dialog titles 20 px, weight 600.
- Contrast WCAG AA (tests/theme.test.ts checks every on-colour). Never show state by colour alone.

## Spacing and shape
- Gaps: 4 px inside a control group, 6–8 px between buttons, 10–12 px between rows, 16 px between cards.
- Radius: 16 px cards, 12 px nested boxes (region cards, folders, panels), 8 px text fields, thumbnails and menus,
  28 px dialogs (16 px for the full-screen editor), buttons are pills.

## Buttons
- **Filled** (plain `<button>`, primary): one per view, the main action (Save, Upload, New region, Place a pin).
- **Tonal** (`.tonal`, secondary-container; primary-container inside region cards): Edit-type actions on an item.
- **Outlined** (`.ghost`): the default for everything else.
- **Text** (`.text`): low emphasis: More…, Recently deleted…, and all folder-head actions.
- **Danger**: `ghost danger` (error text) in rows; filled `danger` only in the confirm dialog.
- Sizes: 40 px; 32 px in card rows, folder heads and the editor; 28 px `.tiny`. State layers: hover 8%, focus and
  pressed 10% of the content colour, plus the 2 px focus ring.
- **Pressed toggles** (tools, Snap, Grid, layer buttons) use `aria-pressed`, `secondary-container` and a tick, never
  the primary fill. The editor's drawing tools are one connected segmented button.
- **Button rows** sit flush left on one line. When there's no room, the row scrolls sideways inside itself; buttons
  never wrap their text and never push the page wider (#119).
- Rows with many actions keep the 2–3 common ones visible and put the rest in **More…** (a menu button, keyboard
  operable, Delete last and separated).
- Labels: verb first, sentence case. A trailing `…` means it opens a dialog or menu. `+ X` adds a thing to the list.
- **Copy embed code** copies straight away (slot cards, atlas). **Embed code…** opens the dialog (region cards, pins).
  Both names are allowed, by that rule.

## Names (use exactly these)
Region, part, colour folder, pin, pin map, folder / subfolder, slot, map, embed code, *Suggest changes*,
*Recently deleted*, *Save to slot*, *Collapse all* / *Expand all*.

## Folder trees
Collapsible folders with an arrow and a count, *Collapse all* above the tree (#121, #123, #124). Regions: a list +
inspector. Rows are compact (swatch, name, badges, part count); picking a folder or a region shows its actions (and the
region card) in the inspector beside the list, a bottom sheet at 860 px and below (Close and Esc close it). Folder
actions sit in the inspector as a two-column grid, Delete last. Pins: the same tree (folders, pin maps, pins) under the
map, and an inspector beside it for a pin's form (title and Save/Delete/Close on top), a pin map or a folder. Under
1024 px it's one column: a pin's form sits right under the map (keep the map in view while placing), a pin map or folder
opens as the sheet.

## Touch
On `(pointer: coarse)` every control has a 44 px hit area (admin, editor, embed). The editor toolbar uses 40 px.

## Embed
- One `.rstack` panel column holds every "what's shown" panel: the legend (layers inside it), then pin filters.
  Background `var(--embed-panel)`; the ruler panel uses it too (#169).
- Placement: left edge, vertically centred at ≥768 px; top-left on phones; folds to a *Legend* button when the
  embed is under 300 px tall.
- Bottom-right is for the reader corner buttons only, with the hint above the buttons.
- Region labels: min 12 px, even-pixel size steps, tilt ≤ 70 deg. On a clash shrink one step, then slide (≤ 110 px),
  then fade. Labels avoid the legend column, corner buttons and pins (#162). Not done yet: clamp globe label centres
  inside the visible disc.

## Editor
- The drawing tools form one segmented button, followed by the [Pin][Comments] place-mode group. Pin and Comments use
  a shared popover at 768/1440 px and a bottom sheet at 375 px.
- Side panel sections: Region / Parts / Underlays / Layers (sections on desktop, sheet tabs on phone).
- Toolbar labels (#163): drawing tools have labels; secondary tools are icon-only (title, `aria-label` and visually
  hidden text). Under 1600 px Undo/Redo/Snap go icon-only; under 1400 px Pin/Comments too. *Other regions* stays
  visible without scrolling at ≥1280 px. Counts on icon buttons are a small pill at the top right.
- Mode-specific options (e.g. Freehand *Open line*, #175) are chips at the map's top-left, not toolbar buttons.

## Admin
- Shell: a navigation rail on the left (Maps, Regions, Pins, Health, Users; icon in a pill over a short name, the
  selected one filled and bold), a 5-item bottom bar at 720 px and below, hidden while the bulk selection bar is up.
  Header: logo and title (title visually hidden under 600 px), sun/moon, accent swatch, Account avatar menu (repo/user
  and Sign out) at every width.
- The strip under the header always shows the save state: saved (tick), saving / deploying (spinner, wording differs),
  failed ("!", says what failed). The branch is an outlined tag when it isn't the default branch. The whole strip
  opens the Activity · Deploys · Checks popup (a bottom sheet on phones); a failed deploy opens it on Deploys.
- Card heads: title (with a count pill where it lists things) on the left, the card's main button on the right: Slots
  "+ Slot…", Maps "+ Upload map…", Health "Check again". Adding a slot and uploading a map are dialogs, not inline forms.
- Top error banner (`role="alert"`, dismissible) only for errors with no inline home; field errors sit next to the
  field.
- Under 600 px, rows use the shared **More…** menu (`src/admin/more-menu.ts`); don't copy it.
- Reversible draft edits (e.g. removing a user before Save) need no confirm; the sticky Save/Undo bar shows only
  while there are unsaved changes.
- Bulk selection bar: count and Done on the first row, actions scroll below it; the page gets bottom padding so
  nothing hides behind the bar.

## Forms and dialogs
- Label above the input (`label` grid). Inputs shrink rather than overflow.
- Dialogs: title and Close in the header; the main action in a footer that stays visible (`.dlg-foot`), primary on the
  right. Escape closes. Focus goes to the first field and back to the opener on close.

## States
Every list or panel has: an **empty state** (what it is plus the button to start, in the `.empty` box), a
**loading** state, an **error** shown next to the thing that failed (`.error`, `role="alert"` when it needs action),
and **disabled** controls with a title explaining why.

**Feedback:** the snackbar is for success plus Undo only, shown for 5 s, paused on hover or focus, and it sits above
the bulk bar when that's open. Errors stay inline next to the thing that failed (the only exception is the Admin top
banner for errors with no inline home).

## Accessibility
- Semantic elements first: `button` for actions, `a` for navigation, `fieldset`/`legend` for groups, `dialog` for
  dialogs, `role="tab"` tabs.
- Everything reachable by keyboard with a visible focus ring (`:focus-visible`, 2 px accent outline), including the
  editor and pin canvases.
- Icon-only buttons have `aria-label` and `title`. Live status text uses `aria-live="polite"`.

## Checking a UI change
Screenshots at 375, 768 and 1440 px in light and dark, before and after, in the PR. No element wider than the screen
at 375 px. Editor changes run the full CI including e2e.
