/**
 * The Users tab: who may use the admin page and what they may do (content/access.json), plus the people
 * who signed in but aren't on the list yet. Editing happens in the table; "Save changes" is one commit.
 * The admin API checks the same rules on save (src/shared/access.ts): someone who isn't the owner can't
 * change their own entry or the owner's, and can only give or take away permissions they hold themselves.
 */
import { ACCESS_PATH, LOGIN, PERMISSIONS, PERMISSION_LABELS, PRESETS, presetOf, type AccessFile, type AccessUser, type Permission } from "../shared/access.ts";
import { $, h } from "./dom.ts";
import { GitHubError, type GitHub } from "./github.ts";
import { OWNER_ID, can, currentUser } from "./session.ts";

export interface UsersDeps {
  gh: () => GitHub;
  act: (label: string, fn: () => Promise<string>) => Promise<void>;
}

let deps: UsersDeps;
/** As loaded (to undo), the blob SHA (to notice someone else saving meanwhile), and the table being edited. */
let loaded: AccessFile = { users: [] };
let loadedSha: string | null = null;
let draft: AccessUser[] = [];

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const clone = (u: AccessUser[]) => u.map((x) => ({ ...x, permissions: [...x.permissions] }));
const sortPerms = (p: Permission[]) => PERMISSIONS.filter((x) => p.includes(x));
const dirty = () => JSON.stringify(draft) !== JSON.stringify(loaded.users);

const note = (text: string, cls = "muted small") => {
  const el = $("#users-note");
  el.textContent = text;
  el.className = cls;
};

/** Whether the signed-in person may change this row (and this permission in it). */
function editable(u: AccessUser, p?: Permission): boolean {
  const me = currentUser();
  if (!me) return false;
  if (me.owner) return u.id !== OWNER_ID;
  if (u.id === me.id || u.id === OWNER_ID) return false;
  return p ? can(p) : true;
}

function row(u: AccessUser): HTMLElement {
  const isOwner = u.id === OWNER_ID;
  const me = currentUser();
  const preset = h("select", { ariaLabel: `Access for ${u.login}`, disabled: !editable(u) });
  const current = presetOf(u.permissions);
  preset.append(
    ...PRESETS.map((p) => h("option", { value: p.name, textContent: p.name, selected: p.name === current, disabled: !p.permissions.every((x) => editable(u, x) || u.permissions.includes(x)) })),
    h("option", { value: "", textContent: "Custom", selected: !current }),
  );
  preset.addEventListener("change", () => {
    const p = PRESETS.find((x) => x.name === preset.value);
    if (!p) return;
    // Keep permissions the editor can't touch exactly as they are.
    const keep = u.permissions.filter((x) => !editable(u, x));
    const set = p.permissions.filter((x) => editable(u, x));
    u.permissions = sortPerms([...new Set([...keep, ...set])]);
    render();
  });
  const boxes = PERMISSIONS.map((p) =>
    h(
      "label",
      { className: "check", title: PERMISSION_LABELS[p].help },
      h("input", {
        type: "checkbox",
        checked: isOwner || u.permissions.includes(p),
        disabled: isOwner || !editable(u, p),
        dataset: { perm: p },
        onchange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked;
          u.permissions = sortPerms(on ? [...u.permissions, p] : u.permissions.filter((x) => x !== p));
          render();
        },
      }),
      PERMISSION_LABELS[p].label,
    ),
  );
  const isNew = !loaded.users.some((x) => x.id === u.id);
  return h(
    "div",
    { className: `urow${isNew ? " new" : ""}`, dataset: { user: u.login } },
    h(
      "div",
      { className: "uname" },
      h("a", { href: `https://github.com/${encodeURIComponent(u.login)}`, target: "_blank", rel: "noopener noreferrer", textContent: u.login }),
      isOwner ? h("span", { className: "badge", textContent: "owner" }) : null,
      me && u.id === me.id ? h("span", { className: "badge", textContent: "you" }) : null,
      isNew ? h("span", { className: "badge warn", textContent: "not saved" }) : null,
    ),
    isOwner ? h("span", { className: "muted small", textContent: "Can always do everything." }) : preset,
    isOwner ? null : h("div", { className: "uperms" }, ...boxes),
    isOwner
      ? null
      : h("button", {
          type: "button",
          className: "ghost danger",
          textContent: "Remove",
          disabled: !editable(u) || u.permissions.some((p) => !editable(u, p)),
          title: editable(u) ? "" : "You can't change this person.",
          dataset: { action: "remove-user" },
          onclick: () => {
            draft = draft.filter((x) => x !== u);
            render();
          },
        }),
  );
}

function render(): void {
  const owner = draft.find((u) => u.id === OWNER_ID);
  const rest = draft.filter((u) => u !== owner);
  $("#users").replaceChildren(...[...(owner ? [owner] : []), ...rest].map(row));
  if (!owner) $("#users").prepend(h("p", { className: "muted small", textContent: "The repository owner isn't listed, but can always do everything." }));
  const d = dirty();
  $<HTMLButtonElement>("#users-save").disabled = !d;
  $<HTMLButtonElement>("#users-reset").disabled = !d;
  if (d) note("Unsaved changes.", "warn small");
  // Presets in the add form: only those the signed-in person can hand out.
  const sel = $<HTMLSelectElement>("#user-preset");
  const keep = sel.value;
  sel.replaceChildren(...PRESETS.filter((p) => p.permissions.every(can)).map((p) => h("option", { value: p.name, textContent: p.name, selected: p.name === keep })));
}

export async function loadUsers(): Promise<void> {
  if (!can("users")) return;
  const gh = deps.gh();
  try {
    const f = await gh.readFile(ACCESS_PATH).catch((e) => {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    });
    loaded = f ? (JSON.parse(f.text) as AccessFile) : { users: [] };
    loadedSha = f?.sha ?? null;
    draft = clone(loaded.users);
    note("");
    render();
  } catch (e) {
    note(`Couldn't load the user list: ${(e as Error).message}`, "error small");
  }
  void renderWaiting();
}

async function renderWaiting(): Promise<void> {
  const box = $("#waiting-list");
  let list: Awaited<ReturnType<GitHub["waiting"]>>;
  try {
    list = (await deps.gh().waiting()).filter((w) => !draft.some((u) => u.id === w.id)).sort((a, b) => b.at.localeCompare(a.at));
  } catch (e) {
    box.replaceChildren(h("p", { className: "error small", textContent: (e as Error).message }));
    return;
  }
  const presets = PRESETS.filter((p) => p.permissions.every(can));
  box.replaceChildren(
    ...(list.length
      ? list.map((w) => {
          const sel = h("select", { ariaLabel: `Access for ${w.login}` }, ...presets.map((p) => h("option", { value: p.name, textContent: p.name })));
          return h(
            "div",
            { className: "urow", dataset: { waiting: w.login } },
            h("div", { className: "uname" }, h("a", { href: `https://github.com/${encodeURIComponent(w.login)}`, target: "_blank", rel: "noopener noreferrer", textContent: w.login }), h("span", { className: "muted small", textContent: ` asked ${new Date(w.at).toLocaleString()}` })),
            sel,
            h("button", {
              type: "button",
              textContent: "Approve",
              dataset: { action: "approve" },
              onclick: () => {
                const p = PRESETS.find((x) => x.name === sel.value)!;
                if (dirty()) return note("Save or undo your other changes first.", "error small");
                draft.push(newUser(w, p.permissions));
                void save(`Give ${w.login} ${p.name} access to the admin page`, () => deps.gh().dismissWaiting(w.id).catch(() => {}));
              },
            }),
            h("button", {
              type: "button",
              className: "ghost",
              textContent: "Dismiss",
              dataset: { action: "dismiss" },
              onclick: () => void deps.gh().dismissWaiting(w.id).then(renderWaiting, (e) => note((e as Error).message, "error small")),
            }),
          );
        })
      : [h("p", { className: "muted small", textContent: "Nobody is waiting." })]),
  );
}

function newUser(a: { id: number; login: string }, permissions: Permission[]): AccessUser {
  return { id: a.id, login: a.login, permissions: sortPerms(permissions), added: stamp(), addedBy: currentUser()?.login ?? "" };
}

function summary(): string {
  const before = new Map(loaded.users.map((u) => [u.id, u]));
  const after = new Map(draft.map((u) => [u.id, u]));
  const parts: string[] = [];
  for (const u of draft) if (!before.has(u.id)) parts.push(`add ${u.login}`);
  for (const u of loaded.users) if (!after.has(u.id)) parts.push(`remove ${u.login}`);
  for (const u of draft) if (before.has(u.id) && JSON.stringify(before.get(u.id)!.permissions) !== JSON.stringify(u.permissions)) parts.push(`change ${u.login}`);
  return `Admin users: ${parts.join(", ") || "update"}`;
}

async function save(message = summary(), then?: () => Promise<unknown>): Promise<void> {
  const file: AccessFile = { $schema: "../schema/access.schema.json", users: draft.map((u) => ({ ...u, permissions: sortPerms(u.permissions) })) };
  await deps.act("Saving users…", async () => {
    const sha = await deps.gh().commit(message, async () => {
      const cur = await deps.gh().fileSha(ACCESS_PATH);
      if (cur !== loadedSha) throw new Error("Someone else changed the user list since you opened it. Undo your changes (or reload the page) and try again.");
      return [{ path: ACCESS_PATH, content: JSON.stringify(file, null, 2) + "\n" }];
    });
    await then?.();
    return sha;
  });
}

export function initUsers(d: UsersDeps): void {
  deps = d;
  $("#users-save").addEventListener("click", () => void save());
  $("#users-reset").addEventListener("click", () => {
    draft = clone(loaded.users);
    note("");
    render();
  });
  $<HTMLFormElement>("#user-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("#user-login");
    const login = input.value.trim().replace(/^@/, "");
    if (!LOGIN.test(login)) return note("That isn't a GitHub username.", "error small");
    if (draft.some((u) => u.login.toLowerCase() === login.toLowerCase())) return note(`${login} is already on the list.`, "error small");
    const preset = PRESETS.find((p) => p.name === $<HTMLSelectElement>("#user-preset").value) ?? PRESETS[0];
    note(`Looking up ${login}…`);
    void deps
      .gh()
      .lookupUser(login)
      .then(
        (a) => {
          if (draft.some((u) => u.id === a.id)) return note(`${a.login} is already on the list.`, "error small");
          draft.push(newUser(a, preset.permissions.filter(can)));
          input.value = "";
          render();
          note(`${a.login} added as ${preset.name}. Press Save changes to give them access.`, "warn small");
        },
        (err) => note((err as Error).message, "error small"),
      );
  });
}
