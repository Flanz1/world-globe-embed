/**
 * The "Legend names" dialog: a pin map's own words for the embed's pin legend on a region (its title and a label per
 * pin kind). Set in the region editor's Underlays section, one pin map at a time. Empty boxes keep the defaults; only
 * the words change, never a kind's icon, colour or its id in ?pins=.
 */
import { inkFor, pinIcon } from "../shared/pin-icons.ts";
import { LEGEND_LABEL_MAX, LEGEND_TITLE_MAX, PIN_KINDS, PIN_LEGEND_TITLE, type PinLegend } from "../shared/pins.ts";
import { h } from "./dom.ts";
import { modal } from "./region-dialogs.ts";

/** Opens the dialog for `current`; `onSave` gets the new words (undefined when everything was reset to the defaults). */
export function legendDialog(current: PinLegend | undefined, scope: string, onSave: (legend: PinLegend | undefined) => void): void {
  const cur = current;
  const m = modal("Legend names", "legend-dlg");
  const title = h("input", { type: "text", value: cur?.title ?? "", maxLength: LEGEND_TITLE_MAX, placeholder: PIN_LEGEND_TITLE, autocomplete: "off", dataset: { field: "legend-title" } });
  const rows = PIN_KINDS.map((k) => ({ k, input: h("input", { type: "text", value: cur?.kinds?.[k.id] ?? "", maxLength: LEGEND_LABEL_MAX, placeholder: k.label, autocomplete: "off", ariaLabel: `${k.label} label`, dataset: { field: `legend-kind-${k.id}` } }) }));
  const swatch = (k: (typeof PIN_KINDS)[number]) => {
    const i = h("span", { className: "lg-icon", ariaHidden: "true" }, pinIcon(k.id, 12));
    i.style.background = k.color;
    i.style.color = inkFor(k.color);
    return i;
  };
  const form = h(
    "form",
    { className: "dlg-body" },
    h("p", { className: "muted small", textContent: `${scope} Leave a box empty to keep the default; icons, colours and ?pins= addresses stay the same.` }),
    h("label", {}, "Panel title ", title),
    ...rows.map((r) => h("label", { className: "lg-row" }, swatch(r.k), r.input)),
  );
  const go = h("button", { type: "submit", textContent: "Save", dataset: { action: "confirm-legend" } });
  const reset = h("button", { type: "button", className: "text lg-reset", textContent: "Reset all", dataset: { action: "reset-legend" } });
  reset.addEventListener("click", () => {
    title.value = "";
    for (const r of rows) r.input.value = "";
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const kinds: PinLegend["kinds"] = {};
    for (const r of rows) if (r.input.value.trim()) kinds[r.k.id] = r.input.value.trim();
    const legend: PinLegend = { ...(title.value.trim() ? { title: title.value.trim() } : {}), ...(Object.keys(kinds).length ? { kinds } : {}) };
    m.close();
    onSave(legend.title || legend.kinds ? legend : undefined);
  });
  go.addEventListener("click", (e) => {
    e.preventDefault();
    form.requestSubmit();
  });
  m.body.append(form);
  m.foot.append(reset, h("span", { className: "grow" }), h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }), go);
  title.focus();
}

