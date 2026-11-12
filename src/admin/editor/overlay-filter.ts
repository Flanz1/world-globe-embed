/**
 * The editor's "Other regions" tool: a button in the top right of the map that opens a panel to choose
 * which other regions are drawn as outlines (and used as snap targets). All are hidden until the user
 * turns them on. The panel searches, filters by category and creator, and sorts like the Regions tab
 * (the logic lives in ../region-filter.ts). Which regions are on is remembered in this browser.
 */
import { h } from "../dom.ts";
import { compareBy, creatorChoices, creatorId, matchesQuery, type Filterable } from "../region-filter.ts";

export interface OverlayItem extends Filterable {
  /** Position in the editor's neighbour list. */
  index: number;
  categoryId: string | null;
}

/** A region's filter data plus its category, keyed by region id in `EditorOptions.neighbourMeta`. */
export type OverlayMeta = Filterable & { categoryId: string | null };

export interface OverlayCategory {
  id: string;
  name: string;
}

export const OVERLAY_PREF = "wge.editor.overlays";
const UNCATEGORIZED = "__none";

export function loadEnabled(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(OVERLAY_PREF) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveEnabled(ids: Set<string>): void {
  try {
    localStorage.setItem(OVERLAY_PREF, JSON.stringify([...ids]));
  } catch {
    /* not remembered: fine */
  }
}

export interface OverlayFilter {
  /** Wrapper to put in the top right of the map: the button, and the panel when open. */
  el: HTMLElement;
  /** Is the neighbour at this index drawn? */
  visible: (index: number) => boolean;
  /** Closes the panel. */
  close: () => void;
}

export function createOverlayFilter(o: { items: OverlayItem[]; categories: OverlayCategory[]; meId: number | undefined; onChange: () => void }): OverlayFilter {
  const enabled = loadEnabled();
  const byIndex = new Map(o.items.map((i) => [i.index, i]));
  const on = (i: OverlayItem) => enabled.has(i.id);
  const count = () => o.items.filter(on).length;

  const button = h("button", { type: "button", className: "ghost ed-ov-btn", title: "Choose which other regions are shown on the map (all hidden until you turn them on)", ariaExpanded: "false" });
  button.dataset.act = "overlays";
  const search = h("input", { type: "search", placeholder: "Search id, label or creator", ariaLabel: "Search other regions", name: "ov-search" });
  const cat = h("select", { ariaLabel: "Category", name: "ov-category" });
  const who = h("select", { ariaLabel: "Creator", name: "ov-creator" });
  const sort = h(
    "select",
    { ariaLabel: "Sort by", name: "ov-sort" },
    h("option", { value: "id", textContent: "Sort: ID / name" }),
    h("option", { value: "updated", textContent: "Sort: recently updated" }),
    h("option", { value: "created", textContent: "Sort: recently created" }),
    h("option", { value: "creator", textContent: "Sort: creator" }),
  );
  const list = h("div", { className: "ed-ov-list" });
  const info = h("p", { className: "muted small ed-ov-info", ariaLive: "polite" });

  cat.append(h("option", { value: "", textContent: "All categories" }));
  for (const k of o.categories) cat.append(h("option", { value: k.id, textContent: k.name }));
  if (o.categories.length) cat.append(h("option", { value: UNCATEGORIZED, textContent: "Uncategorized" }));
  cat.hidden = !o.categories.length;
  who.append(h("option", { value: "", textContent: "Anyone" }), h("option", { value: "me", textContent: "Me" }));
  for (const [id, name] of creatorChoices(o.items, o.meId)) who.append(h("option", { value: String(id), textContent: name }));

  /** The regions the search and filters currently list, in sort order. */
  function listed(): OverlayItem[] {
    const q = search.value.trim().toLowerCase();
    const wid = creatorId(who.value, o.meId);
    return o.items
      .filter((i) => matchesQuery(q, i))
      .filter((i) => wid == null || i.creatorId === wid)
      .filter((i) => !cat.value || (cat.value === UNCATEGORIZED ? i.categoryId === null : i.categoryId === cat.value))
      .sort((a, b) => compareBy(sort.value, a, b));
  }

  const changed = () => {
    saveEnabled(enabled);
    o.onChange();
    renderButton();
    render();
  };
  function set(items: OverlayItem[], v: boolean): void {
    for (const i of items) {
      if (v) enabled.add(i.id);
      else enabled.delete(i.id);
    }
    changed();
  }

  function renderButton(): void {
    const n = count();
    button.textContent = n ? `Other regions (${n})` : "Other regions";
    button.classList.toggle("active", n > 0);
  }

  function render(): void {
    const shown = listed();
    info.textContent = !o.items.length
      ? "There are no other regions on this map."
      : `${count()} of ${o.items.length} shown on the map${shown.length !== o.items.length ? ` · ${shown.length} listed` : ""}`;
    list.replaceChildren(
      ...shown.map((i) => {
        const box = h("input", { type: "checkbox", checked: on(i), name: `ov-${i.id}`, onchange: () => set([i], box.checked) });
        const catName = o.categories.find((k) => k.id === i.categoryId)?.name;
        return h(
          "label",
          { className: "ed-ov-row", dataset: { region: i.id } },
          box,
          h("span", { className: "ed-ov-name", textContent: i.id }),
          h("span", { className: "muted small", textContent: [i.labels && i.labels !== i.id ? i.labels : "", catName ?? "", i.creator].filter(Boolean).join(" · ") }),
        );
      }),
    );
    if (o.items.length && !shown.length) list.append(h("p", { className: "muted small", textContent: "No regions match." }));
  }

  const panel = h(
    "div",
    { className: "ed-ov-panel", hidden: true, role: "dialog", ariaLabel: "Other regions on the map" },
    h("strong", { textContent: "Other regions" }),
    search,
    h("div", { className: "row" }, cat, who, sort),
    h(
      "div",
      { className: "row" },
      h("button", { type: "button", className: "ghost", textContent: "Show listed", title: "Turn on every region the search and filters list", dataset: { act: "overlays-show" }, onclick: () => set(listed(), true) }),
      h("button", { type: "button", className: "ghost", textContent: "Hide listed", title: "Turn off every region the search and filters list", dataset: { act: "overlays-hide" }, onclick: () => set(listed(), false) }),
      h("button", { type: "button", className: "ghost", textContent: "Hide all", dataset: { act: "overlays-hide-all" }, onclick: () => set(o.items, false) }),
    ),
    info,
    list,
  );
  for (const el of [search, cat, who, sort]) el.addEventListener(el === search ? "input" : "change", render);

  const toggle = (open = panel.hidden) => {
    panel.hidden = !open;
    button.ariaExpanded = String(open);
    if (open) render();
  };
  button.addEventListener("click", () => toggle());
  panel.addEventListener("keydown", (e) => {
    // Typing in the panel must not trigger the editor's one-key shortcuts.
    e.stopPropagation();
    if (e.key === "Escape") toggle(false);
  });
  renderButton();
  return { el: h("div", { className: "ed-ov" }, button, panel), visible: (i) => !!byIndex.get(i) && on(byIndex.get(i)!), close: () => toggle(false) };
}
