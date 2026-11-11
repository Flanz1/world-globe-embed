/**
 * Small dialogs for regions: embed code, rename, delete, preview, and a generic confirm.
 * Built with h()/textContent only; region names and descriptions are untrusted text.
 */
import { defaultEmbedOptions, regionEmbedCode, type EmbedOptions } from "../shared/embed.ts";
import type { RegionData } from "../shared/region.ts";
import { DEFAULT_VIEW, type Slot } from "../shared/types.ts";
import type { RegionMessage } from "../viewer/contract.ts";
import { SITE, h } from "./dom.ts";

/** A modal <dialog> that removes itself when closed. */
export function modal(title: string, cls = ""): { dlg: HTMLDialogElement; body: HTMLDivElement; foot: HTMLDivElement; close: () => void } {
  const body = h("div", { className: "dlg-body" });
  const foot = h("div", { className: "dlg-foot" });
  const close = () => dlg.close();
  const dlg = h(
    "dialog",
    { className: `small-dlg ${cls}` },
    h("div", { className: "pv-head" }, h("h2", { textContent: title }), h("button", { type: "button", className: "ghost", textContent: "Close", onclick: close })),
    body,
    foot,
  );
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body, foot, close };
}

export function alertBox(title: string, text: string): void {
  const m = modal(title);
  m.body.append(h("p", { textContent: text }));
  m.foot.append(h("button", { type: "button", textContent: "OK", onclick: m.close }));
}

export function confirmBox(title: string, text: string, ok: string, cancel = "Cancel"): Promise<boolean> {
  return new Promise((resolve) => {
    const m = modal(title);
    let answer = false;
    m.body.append(h("p", { textContent: text }));
    m.foot.append(
      h("button", { type: "button", className: "ghost", textContent: cancel, onclick: m.close }),
      h("button", { type: "button", textContent: ok, onclick: () => ((answer = true), m.close()) }),
    );
    m.dlg.addEventListener("close", () => resolve(answer));
  });
}

/* ── Embed code ── */

export interface EmbedTarget {
  region: { id: string; name: string; label?: boolean; hasLegend?: boolean };
  slot: string;
  slotTitle: string;
}

/** The "Copy embed code" popover: options on the left, live snippet, Copy button with confirmation. */
export function openEmbedDialog(t: EmbedTarget): void {
  const o: EmbedOptions = defaultEmbedOptions(t.region);
  const m = modal(`Embed "${t.region.id}"`, "embed-dlg");
  const code = h("textarea", { className: "code", readOnly: true, rows: 5, spellcheck: false, ariaLabel: "Embed code" });
  const copied = h("span", { className: "ok small", role: "status" });
  const update = () => {
    code.value = regionEmbedCode(SITE, t.slot, t.slotTitle, t.region, o);
    copied.textContent = "";
  };
  const radio = (v: "globe" | "flat", text: string) =>
    h("label", { className: "check" }, h("input", { type: "radio", name: "embed-view", value: v, checked: o.view === v, onchange: () => ((o.view = v), update()) }), text);
  const check = (key: "label" | "dim" | "lock" | "key" | "clash", text: string) =>
    h("label", { className: "check" }, h("input", { type: "checkbox", checked: o[key], dataset: { opt: key }, onchange: (e: Event) => ((o[key] = (e.target as HTMLInputElement).checked), update()) }), text);
  const height = h("input", { type: "number", min: "100", max: "2000", step: "10", value: String(o.height), ariaLabel: "Height in pixels" });
  height.addEventListener("input", () => {
    const v = Number(height.value);
    if (Number.isFinite(v) && v > 0) o.height = v;
    update();
  });
  m.body.append(
    h(
      "div",
      { className: "embed-opts" },
      h("fieldset", {}, h("legend", { textContent: "View" }), radio("globe", "Globe"), radio("flat", "Flat map")),
      h("label", {}, "Height (px)", height),
      check("label", "Show label"),
      check("dim", "Dim outside the region"),
      check("lock", "Start locked"),
      ...(t.region.hasLegend ? [check("key", "Show legend")] : []),
      check("clash", "Mark overlaps with other regions"),
    ),
    code,
    h("p", { className: "muted small", textContent: "Paste this into an Obsidian note. Renaming the region keeps this embed working; deleting it doesn't." }),
  );
  m.foot.append(
    copied,
    h("button", {
      type: "button",
      textContent: "Copy embed code",
      className: "copy-embed",
      onclick: () =>
        void navigator.clipboard.writeText(code.value).then(
          () => (copied.textContent = "Copied"),
          () => {
            code.select();
            copied.textContent = "Couldn't reach the clipboard; the code is selected, press Ctrl+C.";
          },
        ),
    }),
  );
  update();
}

/* ── Delete ── */

export function openDelete(id: string, onDelete: () => void): void {
  const m = modal("Delete region", "danger");
  const input = h("input", { type: "text", autocomplete: "off", spellcheck: false, ariaLabel: "Type the region id to confirm" });
  const btn = h("button", { type: "button", className: "danger", textContent: "Delete region", disabled: true });
  m.body.append(
    h("p", {}, "This deletes ", h("code", { textContent: id }), " in one commit."),
    h("p", { className: "error", textContent: "Embeds that show this region will stop showing it: they fall back to the plain globe with a small “Region not found” note." }),
    h("label", {}, "Type the region's id to confirm", input),
  );
  input.addEventListener("input", () => (btn.disabled = input.value !== id));
  btn.addEventListener("click", () => {
    m.close();
    onDelete();
  });
  m.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }), btn);
  input.focus();
}

/* ── Preview: the region embed in the preview page, fed the region by postMessage ── */

export function previewUrl(slot: Slot, q: Record<string, string>): string {
  const p = new URLSearchParams({
    map: slot.map,
    north: String(slot.north ?? DEFAULT_VIEW.north),
    south: String(slot.south ?? DEFAULT_VIEW.south),
    pole: slot.pole ?? DEFAULT_VIEW.pole,
    shift: String(slot.shift ?? DEFAULT_VIEW.shift),
    rotate: "0",
    ...q,
  });
  return new URL(`preview/?${p}`, SITE).href;
}

/** Sends a region to a same-origin preview iframe, always with an explicit target origin. */
export function sendRegion(frame: HTMLIFrameElement, region: RegionData, centre = false, focus?: number): void {
  const msg: RegionMessage = { type: "wge-region", region, ...(centre ? { centre } : {}), ...(centre && focus !== undefined && focus >= 0 ? { focus } : {}) };
  frame.contentWindow?.postMessage(msg, SITE.origin);
}

export function openRegionPreview(region: RegionData, slot: Slot, slotTitle: string): void {
  const m = modal(`Preview: ${region.id}`, "rpreview");
  const frame = h("iframe", { title: "Region embed preview", className: "rp-frame" });
  const state = { view: "globe" as "globe" | "flat", label: region.label, dim: false };
  const load = () => {
    frame.src = previewUrl(slot, {
      region: region.id,
      view: state.view,
      label: state.label ? "1" : "0",
      dim: state.dim ? "1" : "0",
      lock: "1",
    });
  };
  frame.addEventListener("load", () => sendRegion(frame, region));
  const seg = (v: "globe" | "flat", text: string) =>
    h("button", {
      type: "button",
      className: state.view === v ? "" : "ghost",
      textContent: text,
      ariaPressed: String(state.view === v),
      dataset: { view: v },
      onclick: (e: Event) => {
        state.view = v;
        for (const b of (e.currentTarget as HTMLElement).parentElement!.querySelectorAll("button")) {
          const on = b.dataset.view === v;
          b.className = on ? "" : "ghost";
          b.setAttribute("aria-pressed", String(on));
        }
        load();
      },
    });
  const check = (key: "label" | "dim", text: string) =>
    h("label", { className: "check" }, h("input", { type: "checkbox", checked: state[key], onchange: (e: Event) => ((state[key] = (e.target as HTMLInputElement).checked), load()) }), text);
  m.body.append(
    h("div", { className: "row" }, h("div", { className: "seg" }, seg("globe", "Globe"), seg("flat", "Flat map")), check("label", "Label"), check("dim", "Dim outside")),
    frame,
    h("p", { className: "muted small", textContent: `Exactly what the embed shows on ${slotTitle}: it starts locked; press the padlock to move it.` }),
  );
  m.foot.append(h("button", { type: "button", textContent: "Embed code…", onclick: () => openEmbedDialog({ region: { ...region, name: region.id, hasLegend: region.legend.length > 0 }, slot: region.slot, slotTitle }) }));
  load();
}
