/**
 * Editing several saved regions together ("Edit together" in the Combine regions dialog): their parts
 * load into one editor state, each part tagged with the region it belongs to (`owners`), and saving
 * splits the state back into one state per region. Pure data, unit-tested directly.
 *
 * Colours: the first region's own colour is the editor's own colour (OWN_COLOUR). Every other region's
 * own colour, and every region's legend entries, become legend entries tagged with where they came
 * from, so each part keeps exactly its colour and a save puts each entry back where it was. A part
 * that ends up using a colour from another region (or a new one) gets that colour added to its own
 * region's legend.
 */
import { LEGEND_LABEL_MAX, LEGEND_MAX, OWN_COLOUR } from "../../shared/region.ts";
import { MAX_MOVED_PER_COMMIT } from "../../shared/categories.ts";
import { cloneState, type EditorLegendEntry, type EditorState } from "./model.ts";

/** Most regions edited together: one save writes at most this many region files (the admin API's limit). */
export const MAX_LIVE = MAX_MOVED_PER_COMMIT;

export interface LiveSource {
  id: string;
  /** The region as saved, in editor form (model.ts stateOf). */
  state: EditorState;
}

/** The regions' parts in one state: the sources in order, each one's parts in its own order. */
export function liveState(sources: readonly LiveSource[]): EditorState {
  if (!sources.length) throw new Error("Nothing to edit.");
  const first = sources[0].state;
  const legend: EditorLegendEntry[] = [];
  const out: EditorState = {
    parts: [],
    styles: [],
    labels: [],
    labelHidden: [],
    contested: [],
    locked: [],
    owners: [],
    // Province borders aren't tied to parts: each region keeps its own (see splitLive).
    lines: [],
    props: { ...first.props, legend },
  };
  for (const [si, src] of sources.entries()) {
    const s = src.state;
    const base = legend.length;
    for (const [j, e] of s.props.legend.entries()) legend.push({ label: e.label, color: e.color, src: src.id, srcIdx: j });
    let own = OWN_COLOUR;
    if (si > 0) {
      own = legend.length;
      legend.push({ label: s.props.colorLabel || src.id, color: s.props.color, src: src.id, own: true });
    }
    s.parts.forEach((rings, p) => {
      const k = s.styles[p] ?? OWN_COLOUR;
      out.parts.push(rings.map((r) => r.map(([x, y]) => [x, y] as [number, number])));
      out.styles.push(k === OWN_COLOUR ? own : base + k);
      out.labels.push(s.labels[p] ?? "");
      out.labelHidden.push(s.labelHidden?.[p] === true);
      out.contested.push(-1);
      out.locked.push(s.locked?.[p] !== false);
      out.owners!.push(src.id);
    });
  }
  return out;
}

/** The legend entry of region `id`'s own colour in a live state (-1 for the first region, or if it was removed). */
export function ownEntry(s: EditorState, id: string): number {
  return s.props.legend.findIndex((e) => e.src === id && e.own);
}

/**
 * Removes legend entry `k` in a live state: its parts go back to their own region's colour (not the
 * first region's), later indices shift down.
 */
export function removeLiveEntry(s: EditorState, k: number): EditorState {
  const next = cloneState(s);
  next.props.legend.splice(k, 1);
  next.styles = next.styles.map((v, p) => {
    if (v > k) return v - 1;
    if (v !== k) return v;
    const own = ownEntry(next, next.owners?.[p] ?? "");
    return own >= 0 ? own : OWN_COLOUR;
  });
  return next;
}

export interface LiveSplit {
  id: string;
  /** That region's state with its parts from the live state; its region-wide settings and province borders as saved. */
  state: EditorState;
  /** Why it can't be saved (no parts left, too many colours), or null. */
  problem: string | null;
}

const sameEntry = (a: { label: string; color: string }, b: { label: string; color: string }) => a.label === b.label && a.color === b.color;

/** Splits a live state back into one state per source region, in source order. */
export function splitLive(s: EditorState, sources: readonly LiveSource[]): LiveSplit[] {
  const firstId = sources[0]?.id;
  return sources.map((src, si) => {
    const orig = src.state;
    const props = { ...orig.props };
    // Its own colour: the editor's own colour for the first region, its tagged entry for the others.
    if (si === 0) {
      props.color = s.props.color;
      props.colorLabel = s.props.colorLabel;
    } else {
      const own = s.props.legend[ownEntry(s, src.id)];
      if (own) {
        props.color = own.color;
        // The entry's label falls back to the region id when the colour had none: keep it unlabelled then.
        props.colorLabel = own.label === src.id && !orig.props.colorLabel ? "" : own.label;
      }
    }
    // Its legend: its own entries still in the live legend (in the live order, with any edits), then colours its parts borrowed.
    const legend: { label: string; color: string }[] = [];
    const map = new Map<number, number>();
    s.props.legend.forEach((e, k) => {
      if (e.src === src.id && e.srcIdx !== undefined) {
        map.set(k, legend.length);
        legend.push({ label: e.label, color: e.color });
      }
    });
    const borrow = (e: { label: string; color: string }): number => {
      const entry = { label: e.label.slice(0, LEGEND_LABEL_MAX), color: e.color };
      const at = legend.findIndex((x) => sameEntry(x, entry));
      if (at >= 0) return at;
      legend.push(entry);
      return legend.length - 1;
    };
    const styleOf = (k: number): number => {
      if (k === OWN_COLOUR) {
        if (si === 0 || s.props.color === props.color) return OWN_COLOUR;
        return borrow({ label: s.props.colorLabel || firstId, color: s.props.color });
      }
      const e = s.props.legend[k];
      if (!e) return OWN_COLOUR;
      if (e.src === src.id && e.own) return OWN_COLOUR;
      const mine = map.get(k);
      if (mine !== undefined) return mine;
      // A colour from another region, or one added while editing together. The same colour as its own: just that.
      if (e.color === props.color && (e.label === props.colorLabel || !e.label)) return OWN_COLOUR;
      return borrow(e);
    };
    const ps = s.parts.flatMap((_, p) => ((s.owners?.[p] ?? firstId) === src.id ? [p] : []));
    const state: EditorState = {
      parts: ps.map((p) => s.parts[p].map((r) => r.map(([x, y]) => [x, y] as [number, number]))),
      styles: ps.map((p) => styleOf(s.styles[p] ?? OWN_COLOUR)),
      labels: ps.map((p) => s.labels[p] ?? ""),
      labelHidden: ps.map((p) => s.labelHidden?.[p] === true),
      contested: ps.map(() => -1),
      locked: ps.map((p) => s.locked?.[p] !== false),
      lines: (orig.lines ?? []).map((l) => l.map(([x, y]) => [x, y] as [number, number])),
      props: { ...props, legend },
    };
    const problem = !ps.length
      ? `${src.id} would have no parts left. Move a part back to it, or delete the region from the Regions tab instead.`
      : legend.length > LEGEND_MAX
        ? `${src.id} would use ${legend.length} legend colours; a region can have at most ${LEGEND_MAX}. Give some of its parts colours it already has.`
        : null;
    return { id: src.id, state, problem };
  });
}

/**
 * The live legend squeezed to what one region may show (for the globe preview only): identical
 * entries are shared, and past the limit the rest show in the main colour.
 */
export function previewLegend(s: EditorState): { legend: { label: string; color: string }[]; styles: number[] } {
  const legend: { label: string; color: string }[] = [];
  const map = s.props.legend.map((e) => {
    const at = legend.findIndex((x) => sameEntry(x, e));
    if (at >= 0) return at;
    if (legend.length >= LEGEND_MAX) return OWN_COLOUR;
    legend.push({ label: e.label.slice(0, LEGEND_LABEL_MAX), color: e.color });
    return legend.length - 1;
  });
  return { legend, styles: s.styles.map((k) => (k === OWN_COLOUR ? OWN_COLOUR : (map[k] ?? OWN_COLOUR))) };
}
