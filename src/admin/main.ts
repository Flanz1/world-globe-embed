/**
 * Admin page: list maps and slots, upload a map, switch a slot's map.
 * Every action is a single commit through the GitHub API, signed in with the
 * collaborator's own fine-grained token (kept in localStorage, never logged).
 */
import type { MapMeta, Slot, SlotsFile } from "../shared/types.ts";
import { GitHub, type FileChange, type WorkflowRun } from "./github.ts";

declare const __REPO__: string;

const TOKEN_KEY = "wge-admin-token";
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SITE = new URL("../", location.href);

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(el, rest);
  if (dataset) Object.assign(el.dataset, dataset);
  for (const c of children) if (c) el.append(c);
  return el;
}

const store = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string) => {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* private mode: token lives for this page only */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

let gh: GitHub | null = null;
let maps: MapMeta[] = [];
let slots: SlotsFile = { slots: {} };

function setStatus(text: string, kind: "muted" | "error" | "ok" = "muted"): void {
  const el = $("#status");
  el.textContent = text;
  el.className = kind;
}

const embedCode = (slug: string, title: string) =>
  `<iframe src="${new URL(`v/${slug}/`, SITE).href}" width="100%" height="480" ` +
  `style="border:0;border-radius:8px;background:transparent" loading="lazy" allow="fullscreen" ` +
  `title="${title.replace(/"/g, "&quot;")} globe"></iframe>`;

function thumb(map: MapMeta | undefined, cls = "thumb"): HTMLImageElement {
  const img = h("img", { className: cls, alt: map ? map.name : "", loading: "lazy", decoding: "async" });
  if (!map) return img;
  img.src = map.lqip;
  // The deployed 1024 texture, if this map is live already; otherwise keep the LQIP.
  const full = new Image();
  full.onload = () => (img.src = full.src);
  full.src = new URL(map.sizes["1024"]!, SITE).href;
  return img;
}

function mapOptions(select: HTMLSelectElement, selected?: string): void {
  select.replaceChildren(...maps.map((m) => h("option", { value: m.id, textContent: `${m.name} (${m.id})`, selected: m.id === selected })));
}

/* ── Rendering ── */

function renderMaps(): void {
  $("#maps").replaceChildren(
    ...(maps.length
      ? maps.map((m) =>
          h(
            "div",
            { className: "map" },
            thumb(m, ""),
            h("div", {}, h("strong", { textContent: m.name }), " ", h("code", { textContent: m.id })),
            h("div", { className: "muted", textContent: `${m.width}×${m.height} · ${m.uploadedBy} · ${new Date(m.date).toLocaleDateString()}` }),
          ),
        )
      : [h("p", { className: "muted", textContent: "No maps yet." })]),
  );
  document.querySelectorAll<HTMLSelectElement>("select.map-select").forEach((s) => mapOptions(s, s.value));
}

function renderSlots(): void {
  const entries = Object.entries(slots.slots);
  $("#slots").replaceChildren(
    ...entries.map(([slug, slot]) => {
      const current = maps.find((m) => m.id === slot.map);
      const title = slot.title ?? current?.name ?? slug;
      const select = h("select", { className: "map-select", ariaLabel: `Map for ${slug}` });
      mapOptions(select, slot.map);
      const img = thumb(current);
      const save = h("button", { type: "button", textContent: "Switch map", disabled: true });
      const copy = h("button", { type: "button", className: "ghost", textContent: "Copy embed code" });
      select.addEventListener("change", () => {
        save.disabled = select.value === slot.map;
        img.replaceWith(Object.assign(thumb(maps.find((m) => m.id === select.value)), {}));
      });
      save.addEventListener("click", () => {
        const target = select.value;
        void act(`Switching ${slug} to ${target}…`, () =>
          gh!.commit(`Show map "${target}" in slot "${slug}"`, async () => [
            await slotsChange((s) => {
              if (!s.slots[slug]) throw new Error(`Slot "${slug}" no longer exists.`);
              s.slots[slug].map = target;
            }),
          ]),
        );
      });
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(embedCode(slug, title)).then(
          () => setStatus(`Embed code for "${slug}" copied.`, "ok"),
          () => setStatus("Couldn't access the clipboard.", "error"),
        );
      });
      return h(
        "div",
        { className: "slot" },
        img,
        h(
          "div",
          {},
          h("strong", { textContent: title }),
          " ",
          h("code", { textContent: slug }),
          " ",
          h("a", { href: new URL(`v/${slug}/`, SITE).href, target: "_blank", rel: "noopener", textContent: "open" }),
          h("div", { className: "actions" }, select, save, copy),
        ),
      );
    }),
  );
  const slotSelect = $<HTMLSelectElement>('#upload select[name="slot"]');
  slotSelect.replaceChildren(
    h("option", { value: "", textContent: "(no slot)" }),
    ...entries.map(([slug]) => h("option", { value: slug, textContent: slug })),
  );
}

function renderRuns(runs: WorkflowRun[]): void {
  $("#runs").replaceChildren(
    ...runs.map((r) => {
      const state = r.status === "completed" ? (r.conclusion ?? "done") : r.status.replace("_", " ");
      const cls = r.conclusion === "success" ? "ok" : r.conclusion && r.conclusion !== "skipped" ? "error" : "muted";
      return h(
        "li",
        {},
        h("span", { className: cls, textContent: `● ${state}` }),
        " ",
        h("a", { href: r.html_url, target: "_blank", rel: "noopener", textContent: r.name }),
        h("span", { className: "muted", textContent: ` · ${new Date(r.created_at).toLocaleString()} · ${(r.head_commit?.message ?? "").split("\n")[0]}` }),
      );
    }),
    h("li", {}, h("a", { href: `https://github.com/${__REPO__}/actions`, target: "_blank", rel: "noopener", textContent: "All workflow runs" })),
  );
}

/* ── Data ── */

async function loadAll(): Promise<void> {
  const files = (await gh!.listDir("content/maps")).filter((f) => f.type === "file" && f.name.endsWith(".json"));
  const texts = await Promise.all(files.map((f) => gh!.readText(f.path)));
  maps = texts.map((t) => JSON.parse(t) as MapMeta).sort((a, b) => b.date.localeCompare(a.date));
  slots = JSON.parse(await gh!.readText("content/slots.json")) as SlotsFile;
  renderMaps();
  renderSlots();
}

async function slotsChange(mutate: (s: SlotsFile) => void): Promise<FileChange> {
  const fresh = JSON.parse(await gh!.readText("content/slots.json")) as SlotsFile;
  mutate(fresh);
  return { path: "content/slots.json", content: JSON.stringify(fresh, null, 2) + "\n" };
}

let pollTimer = 0;
async function refreshRuns(): Promise<WorkflowRun[]> {
  try {
    const runs = await gh!.latestRuns();
    renderRuns(runs);
    return runs;
  } catch {
    renderRuns([]);
    return [];
  }
}
/** After a commit, watch the workflows until they finish (max ~15 min). */
function pollRuns(): void {
  clearTimeout(pollTimer);
  const until = Date.now() + 15 * 60_000;
  const tick = async () => {
    const runs = await refreshRuns();
    const busy = runs.some((r) => r.status !== "completed");
    if (!busy && runs.length && Date.now() > until - 14 * 60_000) {
      const failed = runs.find((r) => r.conclusion === "failure");
      if (failed) setStatus(`A workflow failed: open "${failed.name}" below to see why.`, "error");
      else setStatus("Live. Embeds update within about 10 minutes (GitHub Pages caching).", "ok");
      await loadAll().catch(() => {});
      return;
    }
    if (Date.now() < until) pollTimer = window.setTimeout(tick, 10_000);
  };
  pollTimer = window.setTimeout(tick, 5_000);
}

async function act(label: string, fn: () => Promise<string>): Promise<void> {
  document.querySelectorAll("button").forEach((b) => b.setAttribute("aria-busy", "true"));
  setStatus(label);
  try {
    const sha = await fn();
    setStatus(`Committed ${sha.slice(0, 7)}. Waiting for the workflow to publish it…`, "ok");
    pollRuns();
    await loadAll();
  } catch (e) {
    setStatus((e as Error).message, "error");
  } finally {
    document.querySelectorAll("button").forEach((b) => b.removeAttribute("aria-busy"));
  }
}

/* ── Upload ── */

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Downscales to ≤4096 px wide and re-encodes (which also drops EXIF). */
async function prepareImage(file: File): Promise<{ blob: Blob; ext: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const aspect = bmp.width / bmp.height;
  if (Math.abs(aspect / 2 - 1) > 0.03)
    throw new Error(`This image is ${bmp.width}×${bmp.height}. Globe maps need to be about 2:1 (twice as wide as tall).`);
  if (bmp.width < 1024) throw new Error(`This image is only ${bmp.width}px wide; maps need at least 1024px.`);
  const scale = Math.min(1, 4096 / bmp.width);
  const w = Math.round(bmp.width * scale);
  const hgt = Math.round(bmp.height * scale);
  const canvas = h("canvas", { width: w, height: hgt });
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, hgt);
  bmp.close();
  const encode = (type: string, q?: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
  let blob = await encode("image/webp", 0.92);
  if (!blob || blob.type !== "image/webp") blob = await encode("image/png");
  if (!blob) throw new Error("Your browser couldn't encode the image.");
  return { blob, ext: blob.type === "image/webp" ? "webp" : "png", w, h: hgt };
}

function wireUpload(): void {
  const form = $<HTMLFormElement>("#upload");
  const fileInput = form.elements.namedItem("file") as HTMLInputElement;
  const idInput = form.elements.namedItem("id") as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f && !idInput.value)
      idInput.value = f.name
        .replace(/\.[^.]+$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const file = fileInput.files?.[0];
    const id = idInput.value.trim();
    const slot = (form.elements.namedItem("slot") as HTMLSelectElement).value;
    if (!file) return;
    if (!SLUG.test(id)) return setStatus("Map id: lowercase letters, digits and dashes only.", "error");
    const replacing = maps.some((m) => m.id === id);
    if (replacing && !confirm(`A map called "${id}" already exists. Replace its image?`)) return;
    void act("Preparing image…", async () => {
      const img = await prepareImage(file);
      $("#upload-info").textContent = `Uploading ${img.w}×${img.h} ${img.ext.toUpperCase()}, ${(img.blob.size / 1048576).toFixed(1)} MB…`;
      const b64 = await blobToBase64(img.blob);
      const msg = slot ? `Upload map "${id}" and show it in slot "${slot}"` : `Upload map "${id}"`;
      const sha = await gh!.commit(msg, async () => {
        const changes: FileChange[] = [{ path: `content/incoming/${id}.${img.ext}`, content: b64, base64: true }];
        if (slot)
          changes.push(
            await slotsChange((s) => {
              if (s.slots[slot]) s.slots[slot].map = id;
            }),
          );
        return changes;
      });
      $("#upload-info").textContent = "Uploaded. The processing workflow converts it, then the site redeploys.";
      form.reset();
      return sha;
    });
  });
}

function wireNewSlot(): void {
  const form = $<HTMLFormElement>("#new-slot");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const slug = String(data.get("slug")).trim();
    const title = String(data.get("title") ?? "").trim();
    const map = String(data.get("map"));
    if (!SLUG.test(slug)) return setStatus("Slot name: lowercase letters, digits and dashes only.", "error");
    if (slots.slots[slug]) return setStatus(`Slot "${slug}" already exists.`, "error");
    void act(`Adding slot ${slug}…`, async () => {
      const sha = await gh!.commit(`Add slot "${slug}" showing map "${map}"`, async () => [
        await slotsChange((s) => {
          if (s.slots[slug]) throw new Error(`Slot "${slug}" already exists.`);
          const slot: Slot = { map, ...(title ? { title } : {}) };
          s.slots[slug] = slot;
        }),
      ]);
      form.reset();
      return sha;
    });
  });
}

/* ── Sign in ── */

async function signIn(token: string): Promise<boolean> {
  const client = new GitHub(token, __REPO__);
  try {
    const me = await client.whoAmI();
    if (!me.canPush) throw new Error(`This token can read ${__REPO__} but can't write to it. Give it Contents: Read and write.`);
    gh = client;
    $("#who").textContent = `${__REPO__} · signed in as ${me.login}`;
    $("#forget").hidden = false;
    $("#signin").hidden = true;
    $("#main").hidden = false;
    setStatus("Loading…");
    await loadAll();
    setStatus("Ready.");
    void refreshRuns();
    return true;
  } catch (e) {
    $("#signin").hidden = false;
    $("#signin-error").textContent = (e as Error).message;
    return false;
  }
}

function signOut(): void {
  store.clear();
  gh = null;
  clearTimeout(pollTimer);
  location.reload();
}

$("#forget").addEventListener("click", signOut);
$<HTMLFormElement>("#signin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("#token");
  const token = input.value.trim();
  input.value = "";
  void signIn(token).then((ok) => ok && store.set(token));
});
wireUpload();
wireNewSlot();

const saved = store.get();
if (saved) void signIn(saved);
else $("#signin").hidden = false;
$("#who").textContent = __REPO__;
