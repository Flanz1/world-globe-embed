/**
 * Admin page: list maps and slots, upload a map, switch a slot's map, draw regions, manage users.
 * People sign in with GitHub through the admin API (worker/), which checks what they may do and makes
 * every change as one commit with the site's GitHub App. The page keeps only the API's short-lived
 * session token, in sessionStorage (this tab only). It is never logged.
 */
import type { MapMeta, Slot, SlotsFile, ViewMode } from "../shared/types.ts";
import { escapeHtml } from "../shared/page.ts";
import { GitHub, GitHubError, NotListed, type FileChange, type WorkflowRun } from "./github.ts";
import { openPreview } from "./preview.ts";
import { $, SITE, h } from "./dom.ts";
import { initRegions, loadRegions, renderRegions } from "./regions.ts";
import { PART_BYTES, prepareImage } from "./upload-image.ts";
import { can, setMe } from "./session.ts";
import { initUsers, loadUsers } from "./users.ts";

declare const __REPO__: string;
/** The admin API (worker/). Set with VITE_ADMIN_API at build time; empty means it isn't set up yet. */
const ADMIN_API: string = (import.meta.env.VITE_ADMIN_API ?? "").trim().replace(/\/+$/, "");

const SESSION_KEY = "wge-admin-session";
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/*
 * Every GitHub Pages project site of an account shares one origin (<user>.github.io), so anything
 * stored here is readable by script on any of the owner's other Pages sites. The session therefore
 * lives in sessionStorage (this tab only, gone when it closes), and it expires after 12 hours anyway.
 */
const tryStorage = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const store = {
  get: () => tryStorage(() => sessionStorage.getItem(SESSION_KEY), null),
  set: (t: string) => tryStorage(() => sessionStorage.setItem(SESSION_KEY, t), undefined),
  clear: () => {
    tryStorage(() => sessionStorage.removeItem(SESSION_KEY), undefined);
    // Tokens from before the admin API (personal access tokens) are dropped too.
    tryStorage(() => localStorage.removeItem("wge-admin-token"), undefined);
    tryStorage(() => sessionStorage.removeItem("wge-admin-token"), undefined);
  },
};

/** The page acts for the signed-in person, so it must never run inside someone else's frame (clickjacking). */
const framed = tryStorage(() => window.top !== window.self, true);

let gh: GitHub | null = null;
let maps: MapMeta[] = [];
let slots: SlotsFile = { slots: {} };

function setStatus(text: string, kind: "muted" | "error" | "ok" = "muted"): void {
  const el = $("#status");
  el.textContent = text;
  el.className = kind;
}

// No ?view= here: the page reads the slot's default view, so changing it later updates embeds already pasted.
const embedCode = (slug: string, title: string, view: ViewMode) =>
  `<iframe src="${new URL(`v/${slug}/`, SITE).href}" width="100%" height="480" ` +
  `style="border:0;border-radius:8px;background:transparent" loading="lazy" allow="fullscreen" ` +
  `title="${escapeHtml(`${title} ${view === "flat" ? "map" : "globe"}`)}"></iframe>`;

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
            h("button", { type: "button", className: "ghost", textContent: "Preview", onclick: () => openPreview({ maps, mapId: m.id }) }),
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
      let img = thumb(current);
      const save = h("button", { type: "button", textContent: "Switch map", disabled: true });
      const copy = h("button", { type: "button", className: "ghost", textContent: "Copy embed code" });
      const preview = h("button", { type: "button", className: "ghost", textContent: "Preview" });
      preview.addEventListener("click", () =>
        openPreview({
          maps,
          slug,
          slot,
          mapId: select.value,
          onSave: (patch) => {
            const unchanged =
              patch.map === slot.map &&
              patch.view === (slot.view ?? "globe") &&
              patch.north === (slot.north ?? 0) &&
              patch.south === (slot.south ?? 0) &&
              patch.pole.toLowerCase() === (slot.pole ?? "#e8dcc8").toLowerCase() &&
              patch.shift === (slot.shift ?? 0);
            if (unchanged) return setStatus("Nothing changed.");
            void act(`Saving ${slug}…`, () =>
              gh!.commit(`Update slot "${slug}": map "${patch.map}", ${patch.view} view, padding N ${patch.north}% / S ${patch.south}%, prime meridian ${patch.shift}°`, async () => [
                await slotsChange((s) => {
                  const cur = s.slots[slug];
                  if (!cur) throw new Error(`Slot "${slug}" no longer exists.`);
                  cur.map = patch.map;
                  // Globe is the default, so only a flat default is written.
                  if (patch.view === "flat") cur.view = "flat";
                  else delete cur.view;
                  // Keep slots.json tidy: write padding only when it's used.
                  for (const k of ["north", "south", "shift"] as const) {
                    if (patch[k]) cur[k] = patch[k];
                    else delete cur[k];
                  }
                  if (patch.north || patch.south || cur.pole) cur.pole = patch.pole;
                }),
              ]),
            );
          },
        }),
      );
      select.addEventListener("change", () => {
        save.disabled = select.value === slot.map;
        const next = thumb(maps.find((m) => m.id === select.value));
        img.replaceWith(next);
        img = next;
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
        void navigator.clipboard.writeText(embedCode(slug, title, slot.view ?? "globe")).then(
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
          h("div", { className: "actions" }, select, save, preview, copy),
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
  await loadRegions();
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

/** After a commit: tell the user, watch the workflows, reload everything. */
async function afterCommit(sha: string): Promise<void> {
  setStatus(`Committed ${sha.slice(0, 7)} to ${gh!.branch}. Waiting for the workflow to publish it…`, "ok");
  if (gh!.branch !== gh!.defaultBranch) setStatus(`Committed ${sha.slice(0, 7)} to the test branch ${gh!.branch}. GitHub Pages only deploys ${gh!.defaultBranch}, so it won't go live from here.`, "ok");
  pollRuns();
  if (can("users")) void loadUsers();
  await loadAll().catch((e) => setStatus((e as Error).message, "error"));
}

async function act(label: string, fn: () => Promise<string>): Promise<void> {
  document.querySelectorAll("button").forEach((b) => b.setAttribute("aria-busy", "true"));
  setStatus(label);
  try {
    const sha = await fn();
    await afterCommit(sha);
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
      const bar = $<HTMLProgressElement>("#upload-progress");
      const info = $("#upload-info");
      /** Progress from 0 to 1, or undefined for "busy, no estimate". */
      const step = (text: string, frac?: number) => {
        bar.hidden = false;
        if (frac === undefined) bar.removeAttribute("value");
        else bar.value = frac;
        info.textContent = text;
      };
      try {
        step("Reading the image…");
        const img = await prepareImage(file);
        const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
        const size = img.blob.size;
        const name = `content/incoming/${id}.${img.ext}`;
        // Big files go up in parts: GitHub's API refuses single uploads of a few tens of MB.
        const parts = Math.max(1, Math.ceil(size / PART_BYTES));
        const changes: FileChange[] = [];
        let done = 0;
        for (let i = 0; i < parts; i++) {
          const part = img.blob.slice(i * PART_BYTES, Math.min(size, (i + 1) * PART_BYTES));
          const label = parts > 1 ? ` (part ${i + 1} of ${parts})` : "";
          const say = (sent: number) => step(`Uploading ${img.w}×${img.h} ${img.ext.toUpperCase()}, ${mb(done + sent)} of ${mb(size)}${label}…${img.note}`, (done + sent) / size);
          say(0);
          const sha = await gh!.createBlob(await blobToBase64(part), (loaded, total) => say((loaded / total) * part.size));
          done += part.size;
          changes.push({ path: parts > 1 ? `${name}.part${String(i + 1).padStart(3, "0")}` : name, content: "", sha });
        }
        if (parts > 1) {
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await img.blob.arrayBuffer()));
          const sha256 = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
          changes.push({ path: `${name}.parts.json`, content: JSON.stringify({ parts, bytes: size, sha256 }, null, 2) + "\n" });
        }
        step("Saving the commit…", 1);
        const msg = slot ? `Upload map "${id}" and show it in slot "${slot}"` : `Upload map "${id}"`;
        const sha = await gh!.commit(msg, async () => {
          const all = [...changes];
          if (slot)
            all.push(
              await slotsChange((s) => {
                if (s.slots[slot]) s.slots[slot].map = id;
              }),
            );
          return all;
        });
        bar.hidden = true;
        info.textContent = `Uploaded ${img.w}×${img.h} (${mb(size)}). It'll be on the site in a few minutes, once it's processed.${img.note}`;
        form.reset();
        return sha;
      } catch (e) {
        bar.hidden = true;
        info.textContent = "";
        throw e;
      }
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

/* ── Tabs (kept in the URL hash so a reload stays on the same tab) ── */

const TABS = ["maps", "regions", "users"] as const;
type Tab = (typeof TABS)[number];
/** The tabs this person may open: Maps & slots and Users need their own permission. */
const allowedTabs = (): Tab[] => TABS.filter((t) => t === "regions" || (t === "maps" ? can("maps") : can("users")));

function showTab(name: Tab): void {
  const allowed = allowedTabs();
  if (!allowed.includes(name)) name = allowed[0];
  for (const t of TABS) {
    $(`#tab-${t}`).hidden = t !== name;
    const b = $(`#tab-btn-${t}`);
    b.hidden = !allowed.includes(t);
    b.setAttribute("aria-selected", String(t === name));
    b.tabIndex = t === name ? 0 : -1;
  }
  if (name === "regions") renderRegions();
  if (name === "users") void loadUsers();
}

const tabFromHash = (): Tab => (location.hash === "#regions" ? "regions" : location.hash === "#users" ? "users" : "maps");

function wireTabs(): void {
  for (const t of TABS)
    $(`#tab-btn-${t}`).addEventListener("click", () => {
      history.replaceState(null, "", t === "maps" ? location.pathname + location.search : `#${t}`);
      showTab(t);
    });
  $(".tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const allowed = allowedTabs();
    const i = allowed.indexOf(tabFromHash());
    const next = allowed[(Math.max(0, i) + (e.key === "ArrowRight" ? 1 : allowed.length - 1)) % allowed.length];
    $(`#tab-btn-${next}`).click();
    $(`#tab-btn-${next}`).focus();
  });
  window.addEventListener("hashchange", () => gh && showTab(tabFromHash()));
}

/** Shows which branch the page writes to whenever it isn't the default branch. */
function showBranch(client: GitHub): void {
  const el = $("#branch");
  el.hidden = client.branch === client.defaultBranch;
  el.textContent = `Writing to branch ${client.branch} (not ${client.defaultBranch})`;
}

/* ── Sign in ── */

function signInWithGitHub(): void {
  // The admin API sends people back here with #session=… (or #signin-error=…). Only this page's address is accepted.
  const back = location.origin + location.pathname;
  location.href = `${ADMIN_API}/auth/login?return=${encodeURIComponent(back)}`;
}

/** What the sign-in left in the address: a session, or why it failed. The fragment is removed right away. */
function takeFragment(): { session?: string; error?: string } {
  const m = /^#(session|signin-error)=([^&]*)$/.exec(location.hash);
  if (!m) return {};
  history.replaceState(null, "", location.pathname + location.search);
  return m[1] === "session" ? { session: m[2] } : { error: decodeURIComponent(m[2]) };
}

function showSignIn(error = ""): void {
  $("#signin").hidden = false;
  $("#main").hidden = true;
  $("#signin-error").textContent = error;
  const ready = !!ADMIN_API;
  $<HTMLButtonElement>("#signin-github").disabled = !ready;
  $("#signin-setup").hidden = ready;
}

async function signIn(token: string): Promise<void> {
  const client = new GitHub(token, __REPO__, ADMIN_API);
  try {
    const me = await client.whoAmI();
    setMe(me);
    gh = client;
    $("#who").textContent = `${__REPO__} · signed in as ${me.login}`;
    showBranch(client);
    $("#forget").hidden = false;
    $("#signin").hidden = true;
    $("#waiting").hidden = true;
    $("#main").hidden = false;
    showTab(tabFromHash());
    setStatus("Loading…");
    await loadAll();
    setStatus("Ready.");
    void refreshRuns();
  } catch (e) {
    if (e instanceof NotListed) {
      // Signed in, but nobody has added them yet: the owner sees them in the Users tab.
      $("#forget").hidden = false;
      $("#signin").hidden = true;
      $("#waiting").hidden = false;
      $("#waiting-who").textContent = e.login;
      return;
    }
    if (e instanceof GitHubError && e.status === 401) store.clear();
    showSignIn((e as Error).message);
  }
}

function signOut(): void {
  store.clear();
  gh = null;
  setMe(null);
  clearTimeout(pollTimer);
  location.reload();
}

if (framed) {
  $("#app").replaceChildren(
    h("p", { className: "error", textContent: "The admin page can't be used inside a frame. " }, h("a", { href: location.href, target: "_top", rel: "noopener", textContent: "Open it directly" })),
  );
} else {
  $("#forget").addEventListener("click", signOut);
  $("#waiting-out").addEventListener("click", signOut);
  $("#signin-github").addEventListener("click", signInWithGitHub);
  wireUpload();
  wireNewSlot();
  initRegions({ gh: () => gh!, maps: () => maps, slots: () => slots, act, afterCommit });
  initUsers({ gh: () => gh!, act });
  wireTabs();
  $("#who").textContent = __REPO__;

  const back = takeFragment();
  if (back.session) store.set(back.session);
  const saved = store.get();
  if (back.error) showSignIn(back.error);
  else if (saved) void signIn(saved);
  else showSignIn();
}
