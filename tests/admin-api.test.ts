/**
 * The admin API (worker/) end to end, in Node: the real handler in front of an in-memory GitHub, driven by
 * the admin page's own GitHub client. These are the permission checks that matter, because the API is
 * the only thing that can write to the repository.
 */
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHub, GitHubError, NotListed, mapLimit, retrying, type FileChange } from "../src/admin/github.ts";
import { resetRateLimits } from "../worker/src/ratelimit.ts";
import { EDITING_REFRESH_SECONDS, EDITING_SECONDS, handle, resetCaches, returnAllowed, type Env, type KV } from "../worker/src/handler.ts";
import { appJwt, fromB64url, sign, verify } from "../worker/src/crypto.ts";
import { MockGitHub, mockFetch } from "../scripts/e2e/mock-github.mjs";
import { VALIDATORS_FILE, generateValidators } from "../scripts/build-worker-validators.ts";
import type { AccessFile } from "../src/shared/access.ts";
import type { CategoriesFile } from "../src/shared/categories.ts";

const REPO = "Flanz1/world-globe-embed";
const API = "https://admin-api.test";
const ADMIN = "https://flanz1.github.io/world-globe-embed/admin/";
const OWNER = { id: 45669787, login: "Flanz1" };
const SIMON = { id: 138310181, login: "LoopSimon" };
const ANN = { id: 5002, login: "carto-ann" }; // Contributor
const BO = { id: 5003, login: "drafter-bo" }; // Editor
const MANAGER = { id: 5001, login: "e2e-user" }; // Create regions + Manage users, no maps
const CURATOR = { id: 5004, login: "curator-cy" }; // Create + edit others' + delete others'
const STRANGER = { id: 7777, login: "stranger" };

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

class MemoryKV implements KV {
  data = new Map<string, unknown>();
  puts = 0;
  values = new Map<string, string>();
  async put(key: string, value: string, opts?: { metadata?: unknown }) {
    this.puts++;
    this.data.set(key, opts?.metadata);
    this.values.set(key, value);
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async delete(key: string) {
    this.data.delete(key);
    this.values.delete(key);
  }
  lists = 0;
  async list(opts?: { prefix?: string }) {
    this.lists++;
    return { keys: [...this.data].filter(([k]) => k.startsWith(opts?.prefix ?? "")).map(([name, metadata]) => ({ name, metadata })) };
  }
}

const region = (id: string, createdBy?: { id: number; login: string }, updatedBy = createdBy, extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      $schema: "../../schema/region.schema.json",
      type: "Feature",
      id,
      properties: {
        slot: "aerthos",
        map: "globe-map",
        color: "#5881ad",
        updated: "2026-11-12T10:00:00Z",
        ...(createdBy ? { created: "2026-11-12T10:00:00Z", createdBy } : {}),
        ...(updatedBy ? { updatedBy } : {}),
        ...extra,
      },
      geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] },
    },
    null,
    2,
  ) + "\n";

const ACCESS: AccessFile = {
  $schema: "../schema/access.schema.json",
  users: [
    { ...OWNER, permissions: ["maps", "regions", "editOthers", "deleteOthers", "users"] },
    { ...SIMON, permissions: ["maps", "regions"] },
    { ...ANN, permissions: ["regions"] },
    { ...BO, permissions: ["regions", "editOthers"] },
    { ...MANAGER, permissions: ["regions", "users"] },
    { ...CURATOR, permissions: ["regions", "editOthers", "deleteOthers"] },
  ],
};

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "wge-api-"));
  roots.push(root);
  mkdirSync(path.join(root, "content/regions"), { recursive: true });
  mkdirSync(path.join(root, "content/maps"), { recursive: true });
  writeFileSync(path.join(root, "content/slots.json"), JSON.stringify({ slots: { aerthos: { map: "globe-map" } } }, null, 2));
  writeFileSync(path.join(root, "content/maps/globe-map.json"), "{}\n");
  writeFileSync(path.join(root, "content/access.json"), JSON.stringify(ACCESS, null, 2) + "\n");
  writeFileSync(path.join(root, "content/regions/simon-land.json"), region("simon-land", SIMON));
  writeFileSync(path.join(root, "content/regions/ann-land.json"), region("ann-land", ANN));
  writeFileSync(path.join(root, "content/regions/old-land.json"), region("old-land"));
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

let mock: MockGitHub;
let kv: MemoryKV;
let env: Env;
const KEY = "k".repeat(40);

beforeEach(() => {
  resetCaches();
  resetRateLimits();
  mock = new MockGitHub({ root: fixture(), branches: ["main"] });
  kv = new MemoryKV();
  env = {
    REPO,
    BRANCH: "main",
    OWNER_ID: String(OWNER.id),
    ADMIN_URLS: ADMIN,
    APP_ID: "123",
    APP_PRIVATE_KEY: PEM,
    APP_CLIENT_ID: "Iv1.client",
    APP_CLIENT_SECRET: "secret",
    SESSION_KEY: KEY,
    WAITING: kv,
  };
  const up = mockFetch(mock);
  // The admin page's fetch() goes to the admin API, which talks to the mock.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init), env, up)) as typeof fetch;
});

const session = (a: { id: number; login: string }, hours = 1) => sign({ ...a, exp: Math.floor(Date.now() / 1000) + hours * 3600 }, KEY);
async function client(a: { id: number; login: string }): Promise<GitHub> {
  const gh = new GitHub(await session(a), REPO, API);
  await gh.whoAmI();
  return gh;
}
const call = async (url: string, init: RequestInit = {}) => handle(new Request(url, init), env, mockFetch(mock));
const head = () => mock.refs.get("main");

/** One commit through the client, as the admin page makes it; resolves to the refusal message, or null when it landed. */
async function tryCommit(gh: GitHub, changes: FileChange[]): Promise<string | null> {
  const before = head();
  try {
    await gh.commit("test", async () => changes);
    expect(head()).not.toBe(before);
    return null;
  } catch (e) {
    expect(head()).toBe(before);
    return (e as Error).message;
  }
}
const put = (p: string, content: string): FileChange => ({ path: p, content });
const del = (p: string): FileChange => ({ path: p, content: "", delete: true });

const bearer = async (a: { id: number; login: string }) => ({ Authorization: `Bearer ${await session(a)}` });

describe("admin API sign-in", () => {
  it("only sends sessions back to the admin page", () => {
    expect(returnAllowed(ADMIN, env)).toBe(true);
    expect(returnAllowed(`${ADMIN}?x=1`, env)).toBe(true);
    expect(returnAllowed("https://flanz1.github.io/world-globe-embed/admin", env)).toBe(false);
    expect(returnAllowed("https://flanz1.github.io/other-site/admin/", env)).toBe(false);
    expect(returnAllowed("https://flanz1.github.io.evil.example/world-globe-embed/admin/", env)).toBe(false);
    expect(returnAllowed("https://evil.example/?https://flanz1.github.io/world-globe-embed/admin/", env)).toBe(false);
    expect(returnAllowed("https://user:pw@flanz1.github.io/world-globe-embed/admin/", env)).toBe(false);
    expect(returnAllowed("javascript:alert(1)", env)).toBe(false);
  });

  it("signs in through GitHub and hands the admin page a session for that account", async () => {
    const bad = await call(`${API}/auth/login?return=${encodeURIComponent("https://evil.example/")}`);
    expect(bad.status).toBe(400);
    const NONCE = "n".repeat(24);
    expect((await call(`${API}/auth/login?return=${encodeURIComponent(ADMIN)}`)).status).toBe(400);
    const start = await call(`${API}/auth/login?return=${encodeURIComponent(ADMIN)}&nonce=${NONCE}`);
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("Location")!);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("Iv1.client");
    expect(to.searchParams.get("redirect_uri")).toBe(`${API}/auth/callback`);
    const state = to.searchParams.get("state")!;

    const forged = await call(`${API}/auth/callback?code=${mock.oauthCode("carto-ann")}&state=${state.slice(0, -2)}xx`);
    expect(forged.status).toBe(400);

    const back = await call(`${API}/auth/callback?code=${mock.oauthCode("carto-ann")}&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(302);
    const loc = back.headers.get("Location")!;
    expect(loc.startsWith(`${ADMIN}#session=`)).toBe(true);
    expect(loc.endsWith(`&nonce=${NONCE}`)).toBe(true);
    const token = loc.split("#session=")[1].split("&")[0];
    const s = await verify<{ id: number; login: string; exp: number }>(token, KEY);
    expect(s).toMatchObject(ANN);
    expect(s!.exp - Date.now() / 1000).toBeLessThanOrEqual(12 * 3600 + 5);

    const me = await new GitHub(token, REPO, API).whoAmI();
    expect(me).toEqual({ ...ANN, owner: false, permissions: ["regions"] });
  });

  it("rejects forged, tampered and expired sessions", async () => {
    const good = await session(ANN);
    const [body] = good.split(".");
    const tampered = `${btoa(JSON.stringify({ ...ANN, id: OWNER.id, exp: 9e9 })).replace(/=+$/, "")}.${good.split(".")[1]}`;
    for (const t of [tampered, `${body}.AAAA`, await sign({ ...OWNER, exp: 9e9 }, "x".repeat(40)), await session(ANN, -1)]) {
      const r = await call(`${API}/session`, { headers: { Authorization: `Bearer ${t}` } });
      expect(r.status).toBe(401);
    }
  });

  it("puts people who aren't on the list on the waiting list, which only user managers see", async () => {
    await expect(client(STRANGER)).rejects.toBeInstanceOf(NotListed);
    // The page asks /session and the repo in parallel and gives up on the first refusal; let /session finish.
    await call(`${API}/session`, { headers: await bearer(STRANGER) });
    expect([...kv.data.values()]).toEqual([expect.objectContaining({ id: STRANGER.id, login: STRANGER.login })]);
    // Not listed means no reads or writes either.
    const r = await call(`${API}/gh/repos/${REPO}/contents/content/slots.json`, { headers: { Authorization: `Bearer ${await session(STRANGER)}` } });
    expect(r.status).toBe(403);
    expect(await (await client(MANAGER)).waiting()).toEqual([expect.objectContaining({ login: "stranger" })]);
    await expect((await client(ANN)).waiting()).rejects.toThrow(/manage users/);
    await (await client(MANAGER)).dismissWaiting(STRANGER.id);
    expect(kv.data.size).toBe(0);
  });

  it("tells editors who else has a region open, and forgets people who leave or go quiet", async () => {
    const ann = await client(ANN);
    const mgr = await client(MANAGER);
    expect(await ann.editingBeat("tabannnn1", ["nordland"])).toEqual([expect.objectContaining({ login: ANN.login, regions: ["nordland"] })]);
    const seen = await mgr.editingBeat("tabmgrrr1", ["nordland", "other"]);
    expect(seen.map((e) => e.login).sort()).toEqual([ANN.login, MANAGER.login].sort());
    expect((await ann.editingNow()).length).toBe(2);
    // Leaving removes only that tab.
    await ann.editingDone("tabannnn1");
    expect((await mgr.editingNow()).map((e) => e.login)).toEqual([MANAGER.login]);
    // A tab that stopped beating drops off even if KV hasn't expired the key yet.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (EDITING_SECONDS + 5) * 1000);
    expect(await mgr.editingNow()).toEqual([]);
    vi.useRealTimers();
    await expect(ann.editingBeat("x", ["nordland"])).rejects.toThrow();
    await expect(ann.editingBeat("tabannnn1", ["../x"])).rejects.toThrow();
    // Not on the list: nothing.
    await expect(client(STRANGER)).rejects.toBeInstanceOf(NotListed);
  });

  it("keeps the editing notices cheap on KV: no lists, and a write only when something changed or is due a refresh", async () => {
    const ann = await client(ANN);
    const mgr = await client(MANAGER);
    const puts0 = kv.puts;
    const lists0 = kv.lists;
    await ann.editingBeat("tabannnn2", ["nordland"]);
    expect(kv.puts - puts0).toBe(1);
    // The same regions again, 30 s later: no write.
    for (let i = 0; i < 5; i++) await ann.editingBeat("tabannnn2", ["nordland"]);
    await mgr.editingNow();
    expect(kv.puts - puts0).toBe(1);
    // Other regions: written straight away.
    await ann.editingBeat("tabannnn2", ["nordland", "other"]);
    expect(kv.puts - puts0).toBe(2);
    // Due a refresh: written again, and still there for others.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (EDITING_REFRESH_SECONDS + 5) * 1000);
    await ann.editingBeat("tabannnn2", ["nordland", "other"]);
    expect(kv.puts - puts0).toBe(3);
    expect((await mgr.editingNow()).map((e) => e.login)).toEqual([ANN.login]);
    vi.useRealTimers();
    // Closing a tab that isn't there writes nothing.
    await ann.editingDone("tabnothere");
    expect(kv.puts - puts0).toBe(3);
    await ann.editingDone("tabannnn2");
    expect(await mgr.editingNow()).toEqual([]);
    expect(kv.lists - lists0).toBe(0);
  });

  it("signs App requests with a JWT GitHub accepts (PKCS#1 key)", async () => {
    const jwt = await appJwt("123", PEM, 1_700_000_000);
    const [h, b, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(fromB64url(b)))).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "123" });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${b}`);
    expect(v.verify(privateKey, Buffer.from(fromB64url(s)))).toBe(true);
  });
});

describe("admin API permissions", () => {
  it("contributors create regions as themselves and edit or delete only their own", async () => {
    const gh = await client(ANN);
    expect(await tryCommit(gh, [put("content/regions/new-ann.json", region("new-ann", ANN))])).toBeNull();
    expect(mock.log.at(-1)).toMatchObject({ branch: "main" });
    expect(mock.commits.get(head()!)!.author).toBe("carto-ann");
    expect(await tryCommit(gh, [put("content/regions/ann-land.json", region("ann-land", ANN, ANN, { color: "#112233" }))])).toBeNull();
    expect(await tryCommit(gh, [del("content/regions/new-ann.json")])).toBeNull();

    expect(await tryCommit(gh, [put("content/regions/simon-land.json", region("simon-land", SIMON, ANN))])).toMatch(/can't edit "simon-land": someone else created it/);
    expect(await tryCommit(gh, [del("content/regions/simon-land.json")])).toMatch(/can't delete "simon-land"/);
    // Regions from before owners existed belong to the repository owner.
    expect(await tryCommit(gh, [put("content/regions/old-land.json", region("old-land", undefined, ANN))])).toMatch(/someone else created it/);
    expect(mock.read("main", "content/regions/simon-land.json")).toBe(region("simon-land", SIMON));
  });

  it("restores a deleted region: its creator or someone who may edit and delete others' regions can put it back", async () => {
    const ann = await client(ANN);
    const path = "content/regions/ann-land.json";
    const before = mock.read("main", path)!;
    expect(await tryCommit(ann, [del(path)])).toBeNull();
    // The save log names the delete and the commit before it, which still has the file.
    const log = await ann.history({ path, files: true, limit: 1 });
    expect(log.entries[0].files).toEqual([{ path, status: "removed" }]);
    expect(log.entries[0].parent).toMatch(/^[0-9a-f]{40}$/);
    expect(await ann.readFileAt(path, log.entries[0].parent!)).toBe(before);
    expect(await ann.history({ path, since: "2999-01-01T00:00:00Z" })).toMatchObject({ entries: [] });
    expect(await tryCommit(await client(BO), [put(path, region("ann-land", ANN, BO))])).toMatch(/createdBy set to you/);
    expect(await tryCommit(await client(CURATOR), [put(path, region("ann-land", ANN, CURATOR))])).toBeNull();
    expect(JSON.parse(mock.read("main", path)!).properties).toMatchObject({ createdBy: ANN, updatedBy: CURATOR });
    // Restoring as the creator is the ordinary rule: your own region, saved by you.
    expect(await tryCommit(ann, [del(path)])).toBeNull();
    expect(await tryCommit(ann, [put(path, region("ann-land", ANN, ANN))])).toBeNull();
  });

  it("refuses made-up creators and savers", async () => {
    const gh = await client(ANN);
    expect(await tryCommit(gh, [put("content/regions/fake.json", region("fake", OWNER, ANN))])).toMatch(/createdBy set to you/);
    expect(await tryCommit(gh, [put("content/regions/fake.json", region("fake", ANN, OWNER))])).toMatch(/updatedBy set to you/);
    expect(await tryCommit(gh, [put("content/regions/fake.json", region("fake", undefined, ANN))])).toMatch(/createdBy set to you/);
    // Taking over your own region for someone else, or claiming someone else's.
    expect(await tryCommit(gh, [put("content/regions/ann-land.json", region("ann-land", SIMON, ANN))])).toMatch(/someone else|who created/);
    expect(await tryCommit(gh, [put("content/regions/simon-land.json", region("simon-land", ANN, ANN))])).toMatch(/someone else created it/);
  });

  it("editors change anyone's regions but can't delete them or change who made them", async () => {
    const gh = await client(BO);
    expect(await tryCommit(gh, [put("content/regions/simon-land.json", region("simon-land", SIMON, BO, { color: "#abcdef" }))])).toBeNull();
    expect(await tryCommit(gh, [put("content/regions/old-land.json", region("old-land", undefined, BO))])).toBeNull();
    expect(await tryCommit(gh, [del("content/regions/simon-land.json")])).toMatch(/can't delete/);
    expect(await tryCommit(gh, [put("content/regions/simon-land.json", region("simon-land", BO, BO))])).toMatch(/Only the repository owner or an admin can change who created/);
  });

  it("lets only the owner or an admin transfer who created a region", async () => {
    // Contributors and editors can't, even for their own region.
    expect(await tryCommit(await client(ANN), [put("content/regions/ann-land.json", region("ann-land", BO, ANN))])).toMatch(/owner or an admin/);
    // An admin (Manage users) can hand over a region they couldn't edit otherwise, if nothing else changes.
    const mgr = await client(MANAGER);
    expect(await tryCommit(mgr, [put("content/regions/simon-land.json", region("simon-land", ANN, MANAGER, { updated: "2026-11-13T10:00:00Z" }))])).toBeNull();
    expect(JSON.parse(mock.read("main", "content/regions/simon-land.json")!).properties.createdBy).toEqual(ANN);
    // ...but not slip another edit in with it.
    expect(await tryCommit(mgr, [put("content/regions/ann-land.json", region("ann-land", BO, MANAGER, { color: "#abcdef" }))])).toMatch(/can't edit/);
    // Regions with no creator recorded can be handed to their real author.
    expect(await tryCommit(mgr, [put("content/regions/old-land.json", region("old-land", SIMON, MANAGER))])).toBeNull();
    // The owner can too.
    expect(await tryCommit(await client(OWNER), [put("content/regions/old-land.json", region("old-land", ANN, OWNER))])).toBeNull();
  });

  it("keeps maps, uploads and slots to people with Maps & slots", async () => {
    const ann = await client(ANN);
    for (const c of [put("content/slots.json", "{}\n"), put("content/incoming/x.webp", "RIFF"), put("content/maps/globe-map.json", "{\"x\":1}\n"), del("content/maps/globe-map.json")])
      expect(await tryCommit(ann, [c])).toMatch(/permission to change maps or slots/);
    // A region and an upload in one commit: the whole commit is refused.
    expect(await tryCommit(ann, [put("content/regions/mixed.json", region("mixed", ANN)), put("content/incoming/y.webp", "RIFF")])).toMatch(/maps or slots/);
    expect(mock.read("main", "content/regions/mixed.json")).toBeNull();
    const simon = await client(SIMON);
    expect(await tryCommit(simon, [put("content/incoming/x.webp", "RIFF"), put("content/slots.json", '{"slots":{}}\n')])).toBeNull();
  });

  it("never writes outside content/, not even for the owner", async () => {
    for (const who of [ANN, OWNER]) {
      const gh = await client(who);
      for (const p of ["README.md", "src/admin/main.ts", ".github/workflows/deploy.yml", "package.json"])
        expect(await tryCommit(gh, [put(p, "x")])).toMatch(/Only files in content\//);
    }
    // Other content/ files are the owner's alone.
    expect(await tryCommit(await client(SIMON), [put("content/notes.txt", "x")])).toMatch(/Only the repository owner/);
    expect(await tryCommit(await client(OWNER), [put("content/notes.txt", "x")])).toBeNull();
  });

  it("the owner can do everything in content/, whatever access.json says", async () => {
    const gh = await client(OWNER);
    expect(await tryCommit(gh, [put("content/access.json", JSON.stringify({ users: [] }) + "\n")])).toBeNull();
    resetCaches();
    const me = await (await client(OWNER)).whoAmI();
    expect(me.owner).toBe(true);
    expect(me.permissions).toHaveLength(5);
    expect(await tryCommit(gh, [del("content/regions/simon-land.json"), put("content/regions/gift.json", region("gift", SIMON, OWNER))])).toBeNull();
  });

  it("checks regions against the schema", async () => {
    const gh = await client(ANN);
    expect(await tryCommit(gh, [put("content/regions/bad.json", region("bad", ANN, ANN, { color: "red" }))])).toMatch(/doesn't match its schema/);
    expect(await tryCommit(gh, [put("content/regions/bad.json", region("other-id", ANN))])).toMatch(/must have the id "bad"/);
    expect(await tryCommit(gh, [put("content/regions/bad.json", "{not json")])).toMatch(/isn't valid JSON/);
  });
});

describe("admin API user management", () => {
  const access = () => JSON.parse(mock.read("main", "content/access.json")!) as AccessFile;
  const withUsers = (f: (a: AccessFile) => void) => {
    const a = access();
    f(a);
    return put("content/access.json", JSON.stringify(a, null, 2) + "\n");
  };

  it("lets user managers add people with permissions they hold themselves", async () => {
    const gh = await client(MANAGER);
    expect(await gh.lookupUser("drafter-bo")).toEqual({ id: 5003, login: "drafter-bo" });
    await expect(gh.lookupUser("some-org")).rejects.toThrow(/not a person/);
    await expect(gh.lookupUser("nobody-here")).rejects.toThrow(/no GitHub account/);
    expect(await tryCommit(gh, [withUsers((a) => a.users.push({ id: 6001, login: "newbie", permissions: ["regions"] }))])).toBeNull();
    expect(await tryCommit(gh, [withUsers((a) => a.users.push({ id: 6002, login: "uploader", permissions: ["maps"] }))])).toMatch(/can't give uploader "Maps & slots"/);
    expect(await tryCommit(gh, [withUsers((a) => (a.users.find((u) => u.id === SIMON.id)!.permissions = ["regions"]))])).toMatch(/can't take "Maps & slots" from LoopSimon/);
    expect(await tryCommit(gh, [withUsers((a) => (a.users.find((u) => u.id === MANAGER.id)!.permissions = ["regions", "users", "maps"]))])).toMatch(/your own permissions/);
    expect(await tryCommit(gh, [withUsers((a) => (a.users = a.users.filter((u) => u.id !== OWNER.id)))])).toMatch(/owner's entry/);
    expect(await tryCommit(gh, [withUsers((a) => a.users.push({ ...ANN, permissions: ["regions"] }))])).toMatch(/listed twice/);
    // Removing a contributor (who holds nothing the manager lacks) is fine.
    expect(await tryCommit(gh, [withUsers((a) => (a.users = a.users.filter((u) => u.id !== ANN.id)))])).toBeNull();
  });

  it("people without Manage users can't touch the list", async () => {
    const gh = await client(SIMON);
    expect(await tryCommit(gh, [withUsers((a) => a.users.push({ id: 6001, login: "newbie", permissions: ["regions"] }))])).toMatch(/permission to manage users/);
    await expect(gh.lookupUser("drafter-bo")).rejects.toThrow(/manage users/);
  });

  it("someone removed from the list can't save any more, even with a session", async () => {
    const ann = await client(ANN);
    expect(await tryCommit(await client(OWNER), [withUsers((a) => (a.users = a.users.filter((u) => u.id !== ANN.id)))])).toBeNull();
    const msg = await tryCommit(ann, [put("content/regions/ann-land.json", region("ann-land", ANN, ANN, { color: "#000000" }))]);
    expect(msg).toMatch(/isn't on the admin list/);
  });
});

describe("admin API categories", () => {
  const CATS = "content/categories.json";
  const cat = (id: string, by: { id: number; login: string } | undefined, regions: string[] = [], name = id) => ({ id, name, regions, ...(by ? { createdBy: by, created: "2026-11-12T10:00:00Z" } : {}) });
  const seed = (cats: CategoriesFile["categories"]) => mock.externalWrite("main", CATS, JSON.stringify({ categories: cats }, null, 2) + "\n");
  const write = (cats: CategoriesFile["categories"]) => put(CATS, JSON.stringify({ categories: cats }, null, 2) + "\n");

  it("folders have no owner: anyone who can create regions adds, renames and deletes any of them", async () => {
    seed([cat("simon-cat", SIMON, ["simon-land"]), cat("old-cat", undefined)]);
    const ann = await client(ANN);
    expect(await tryCommit(ann, [write([cat("simon-cat", SIMON, ["simon-land"], "Renamed"), cat("old-cat", undefined), cat("new-cat", undefined)])])).toBeNull();
    expect(await tryCommit(ann, [write([cat("old-cat", undefined)])])).toBeNull();
    expect(await tryCommit(ann, [write([])])).toBeNull();
    // A new folder needs no creator.
    expect(await tryCommit(ann, [write([cat("ann-stuff", undefined)])])).toBeNull();
  });

  it("people without Create regions can't change categories", async () => {
    const mute = { id: 8001, login: "reader" };
    await client(OWNER).then((gh) => tryCommit(gh, [put("content/access.json", JSON.stringify({ users: [...ACCESS.users, { ...mute, permissions: ["maps"] }] }) + "\n")]));
    expect(await tryCommit(await client(mute), [write([cat("x", undefined)])])).toMatch(/permission to change categories/);
  });

  it("anyone who can create regions puts any region in any folder; the region must exist", async () => {
    seed([cat("a", undefined), cat("b", undefined)]);
    const ann = await client(ANN);
    expect(await tryCommit(ann, [write([cat("a", undefined, ["simon-land", "old-land", "ann-land"]), cat("b", undefined)])])).toBeNull();
    expect(await tryCommit(ann, [write([cat("a", undefined, ["old-land"]), cat("b", undefined, ["simon-land"])])])).toBeNull();
    // Ids of regions that don't exist can't be reserved, but leftovers can be tidied away.
    expect(await tryCommit(ann, [write([cat("a", undefined, ["old-land", "ghost"]), cat("b", undefined, ["simon-land"])])])).toMatch(/no region "ghost"/);
    seed([cat("a", undefined, ["ghost", "ann-land"])]);
    expect(await tryCommit(ann, [write([cat("a", undefined, ["ann-land"])])])).toBeNull();
  });

  it("anyone who can create regions pins and reorders regions in a folder; bad pins are refused", async () => {
    const pins = (pinned: string[]) => ({ ...cat("a", undefined, ["ann-land", "simon-land", "old-land"]), pinned });
    seed([cat("a", undefined, ["ann-land", "simon-land", "old-land"])]);
    const ann = await client(ANN);
    expect(await tryCommit(ann, [write([pins(["simon-land"])])])).toBeNull(); // someone else's region
    expect(await tryCommit(ann, [write([pins(["simon-land", "ann-land"])])])).toBeNull();
    expect(await tryCommit(ann, [write([pins(["ann-land", "simon-land"])])])).toBeNull();
    expect((JSON.parse(mock.read("main", CATS)!) as CategoriesFile).categories[0].pinned).toEqual(["ann-land", "simon-land"]);
    expect(await tryCommit(ann, [write([pins(["nope"])])])).toMatch(/isn't a region in this folder/);
  });

  it("deleting a category sends its regions to Uncategorized", async () => {
    seed([cat("mine", undefined, ["simon-land", "ann-land"])]);
    expect(await tryCommit(await client(ANN), [write([])])).toBeNull();
  });

  it("anyone may nest any folder in another; nesting must be valid", async () => {
    const inside = (c: ReturnType<typeof cat>, parent: string) => ({ ...c, parent });
    seed([cat("mine", undefined), cat("theirs", undefined)]);
    const ann = await client(ANN);
    expect(await tryCommit(ann, [write([cat("mine", undefined), cat("theirs", undefined), inside(cat("sub", undefined), "theirs")])])).toBeNull();
    expect(await tryCommit(ann, [write([cat("mine", undefined), inside(cat("theirs", undefined), "mine"), inside(cat("sub", undefined), "theirs")])])).toBeNull();
    // Deleting a folder moves what's in it up.
    expect(await tryCommit(ann, [write([cat("theirs", undefined)])])).toBeNull();
    // Bad trees.
    expect(await tryCommit(ann, [write([inside(cat("a", undefined), "nope")])])).toMatch(/parent must be/);
  });

  it("lets anyone who can create regions reorder, and checks the file's shape", async () => {
    seed([cat("a", ANN), cat("b", SIMON), cat("c", BO)]);
    const ann = await client(ANN);
    expect(await tryCommit(ann, [write([cat("b", SIMON), cat("c", BO), cat("a", ANN)])])).toBeNull();
    expect(await tryCommit(ann, [write([cat("a", ANN, ["ann-land"]), cat("a", ANN)])])).toMatch(/used twice/);
    expect(await tryCommit(ann, [write([cat("a", ANN, [], "x"), cat("b", ANN, [], "X")])])).toMatch(/two folders called/);
    expect(await tryCommit(ann, [write([cat("a", ANN, ["ann-land"]), cat("b", ANN, ["ann-land"])])])).toMatch(/in two categories/);
    expect(await tryCommit(ann, [write([{ ...cat("a", ANN), name: "" }])])).toMatch(/schema|name/);
    expect(await tryCommit(ann, [put(CATS, "{not json")])).toMatch(/isn't valid JSON/);
  });
});

describe("admin API reads", () => {
  it("reads a file over 1 MB through its blob, because the contents API leaves its content out", async () => {
    const gh = await client(ANN);
    const text = await gh.readText("content/regions/ann-land.json");
    const inner = globalThis.fetch;
    // What GitHub does for a big file: sha and size, no content.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await inner(input, init);
      if (!String(input instanceof Request ? input.url : input).includes("/contents/content/regions/")) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, content: "", encoding: "none", size: 1_500_000 }), { status: res.status });
    }) as typeof fetch;
    try {
      const f = await gh.readFile("content/regions/ann-land.json");
      expect(f.text).toBe(text);
      expect(f.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      globalThis.fetch = inner;
    }
  });
});

describe("admin API save log", () => {
  const regionPath = "content/regions/ann-land.json";
  it("lists the saves that touched a file, newest first, with who made them, and pages back", async () => {
    const ann = await client(ANN);
    const bo = await client(BO);
    for (const [who, label, by] of [[ann, "one", ANN], [bo, "two", BO], [ann, "three", ANN]] as const) {
      await who.commit(`Edit ${label}`, async () => [put(regionPath, region("ann-land", ANN, by, { color: label === "one" ? "#111111" : label === "two" ? "#222222" : "#333333" }))]);
    }
    await bo.commit("Edit elsewhere", async () => [put("content/regions/old-land.json", region("old-land", undefined, BO, { color: "#abcdef" }))]);
    const first = await ann.history({ path: regionPath, limit: 2 });
    expect(first.entries.map((e) => e.message)).toEqual(["Edit three", "Edit two"]);
    expect(first.entries[1].author).toEqual({ login: BO.login, id: BO.id });
    expect(first.entries[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.next).toBe(2);
    const second = await ann.history({ path: regionPath, limit: 2, page: first.next! });
    expect(second.entries.map((e) => e.message)).toEqual(["Edit one", "initial"]);
    // The whole of content/ includes the other region's save; files=1 names what each save changed.
    const all = await ann.history({ files: true, limit: 2 });
    expect(all.entries[0].message).toBe("Edit elsewhere");
    expect(all.entries[0].files).toEqual([{ path: "content/regions/old-land.json", status: "modified" }]);
  });
  it("is for people on the admin list, and only for content/", async () => {
    const r = await call(`${API}/history`, { headers: { Authorization: `Bearer ${await session(STRANGER)}` } });
    expect(r.status).toBe(403);
    expect((await call(`${API}/history`)).status).toBe(401);
    const ann = await client(ANN);
    await expect(ann.history({ path: "worker/src/handler.ts" })).rejects.toThrow(/only kept for files in content/);
    await expect(ann.history({ path: "content/../.github" })).rejects.toThrow(GitHubError);
  });
  it("reads a file as it was in an earlier save", async () => {
    const ann = await client(ANN);
    const was = await ann.readText(regionPath);
    await ann.commit("Edit", async () => [put(regionPath, region("ann-land", ANN, ANN, { color: "#999999" }))]);
    const log = await ann.history({ path: regionPath });
    expect(await ann.readFileAt(regionPath, log.entries[1].sha)).toBe(was);
    expect(await ann.readFileAt("content/regions/nope.json", log.entries[1].sha)).toBeNull();
  });
});

describe("admin API branch updates", () => {
  const raw = async (who: { id: number; login: string }, method: string, p: string, body?: unknown) => {
    const r = await call(`${API}/gh/repos/${REPO}${p}`, { method, headers: { Authorization: `Bearer ${await session(who)}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  it("lists folders by tree hash and lets the browser keep blobs and trees, but nothing else", async () => {
    const base = head()!;
    const root = ((await raw(ANN, "GET", `/git/commits/${base}`)).body.tree as { sha: string }).sha;
    const top = await raw(ANN, "GET", `/git/trees/${root}`);
    expect(top.status, JSON.stringify(top.body)).toBe(200);
    const content = (top.body.tree as { path: string; sha: string }[]).find((e) => e.path === "content")!;
    expect(content).toBeTruthy();
    // By hash only: a branch name or a recursive listing is refused.
    expect((await raw(ANN, "GET", "/git/trees/main")).status).toBe(404);
    const r = await call(`${API}/gh/repos/${REPO}/git/trees/${content.sha}`, { headers: { Authorization: `Bearer ${await session(ANN)}` } });
    expect(r.headers.get("Cache-Control")).toMatch(/immutable/);
    const live = await call(`${API}/gh/repos/${REPO}/git/ref/heads/main`, { headers: { Authorization: `Bearer ${await session(ANN)}` } });
    expect(live.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses force pushes, other branches and commits that don't build on the head", async () => {
    const base = head()!;
    const tree = (await raw(ANN, "GET", `/git/commits/${base}`)).body.tree as { sha: string };
    const blob = (await raw(ANN, "POST", "/git/blobs", { content: btoa(region("ff", ANN)), encoding: "base64" })).body.sha as string;
    const t = (await raw(ANN, "POST", "/git/trees", { base_tree: tree.sha, tree: [{ path: "content/regions/ff.json", mode: "100644", type: "blob", sha: blob }] })).body.sha as string;
    const c = (await raw(ANN, "POST", "/git/commits", { message: "x", tree: t, parents: [base] })).body.sha as string;
    expect((await raw(ANN, "PATCH", "/git/refs/heads/main", { sha: c, force: true })).status).toBe(422);
    expect((await raw(ANN, "PATCH", "/git/refs/heads/other", { sha: c })).status).toBe(403);
    mock.externalWrite("main", "content/slots.json", "{}\n");
    const ff = await raw(ANN, "PATCH", "/git/refs/heads/main", { sha: c });
    expect(ff.status).toBe(422);
    expect(ff.body.message).toMatch(/not a fast forward/);
    // Trees with symlinks or paths outside content/ are refused when they're made.
    expect((await raw(ANN, "POST", "/git/trees", { base_tree: tree.sha, tree: [{ path: "content/regions/x.json", mode: "120000", type: "blob", sha: blob }] })).status).toBe(422);
    expect((await raw(ANN, "POST", "/git/trees", { base_tree: tree.sha, tree: [{ path: "src/x.ts", mode: "100644", type: "blob", sha: blob }] })).status).toBe(403);
    // Only this repository.
    expect((await call(`${API}/gh/repos/someone/else/contents/x`, { headers: { Authorization: `Bearer ${await session(ANN)}` } })).status).toBe(404);
  });

  it("the client retries on a moved head, and the retry is checked again", async () => {
    const gh = await client(ANN);
    let first = true;
    await gh.commit("retry", async () => {
      if (first) mock.externalWrite("main", "content/slots.json", '{"slots":{}}\n');
      first = false;
      return [put("content/regions/again.json", region("again", ANN))];
    });
    expect(mock.read("main", "content/regions/again.json")).toBe(region("again", ANN));
    expect(mock.read("main", "content/slots.json")).toBe('{"slots":{}}\n');
  });
});

describe("generated validators", () => {
  it("are up to date with schema/", () => {
    expect(readFileSync(VALIDATORS_FILE, "utf8")).toBe(generateValidators());
  });
});

describe("admin API big saves", () => {
  /** Upstream (GitHub) calls the Worker made for its busiest request: a Worker gets about 50 per request. */
  function countSubrequests() {
    resetCaches();
    const up0 = mockFetch(mock);
    let calls = 0;
    const stats = { busiest: 0 };
    const up = (async (u: string, i?: RequestInit) => (calls++, up0(u, i))) as typeof up0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls = 0;
      const r = await handle(new Request(input, init), env, up);
      stats.busiest = Math.max(stats.busiest, calls);
      return r;
    }) as typeof fetch;
    return stats;
  }
  const mk = (id: string, who: { id: number; login: string }, v: number) => region(id, SIMON, who, { color: `#${String(v).padStart(6, "0")}` });
  const batch = (n: number, who: { id: number; login: string }, v: number) => Array.from({ length: n }, (_, k) => put(`content/regions/big-${k}.json`, mk(`big-${k}`, who, v)));

  it("lets the owner save 32 changed regions in one commit, within the subrequest limit", async () => {
    const stats = countSubrequests();
    const gh = await client(OWNER);
    expect(await tryCommit(gh, batch(32, OWNER, 1))).toBeNull();
    expect(await tryCommit(gh, batch(32, OWNER, 2))).toBeNull();
    expect(stats.busiest).toBeLessThanOrEqual(50);
    expect(await tryCommit(gh, batch(33, OWNER, 3))).toMatch(/changes 33 regions; the admin page saves at most 32/);
  });

  it("lets an editor save 16 changed regions in one commit, within the subrequest limit", async () => {
    const stats = countSubrequests();
    expect(await tryCommit(await client(OWNER), batch(16, OWNER, 1))).toBeNull();
    const bo = await client(BO);
    expect(await tryCommit(bo, batch(16, BO, 2))).toBeNull();
    expect(stats.busiest).toBeLessThanOrEqual(50);
    expect(await tryCommit(bo, batch(17, BO, 3))).toMatch(/changes 17 regions; the admin page saves at most 16/);
  });

  it("still needs the old version for anyone but the owner (editors can't take over someone's region)", async () => {
    const bo = await client(BO);
    expect(await tryCommit(await client(OWNER), batch(2, OWNER, 1))).toBeNull();
    expect(await tryCommit(bo, [put("content/regions/big-0.json", mk("big-0", BO, 4).replace('"id": 5002', '"id": 5003'))])).toBeNull();
    expect(await tryCommit(bo, [put("content/regions/big-1.json", region("big-1", BO, BO))])).toMatch(/who created/);
  });

  it("uploads in a few at a time and retries a busy GitHub", async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (x) => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(peak).toBe(3);
    let tries = 0;
    expect(await retrying(async () => (++tries < 3 ? Promise.reject(new GitHubError(403, "You have exceeded a secondary rate limit.")) : "ok"), 3, 1)).toBe("ok");
    tries = 0;
    await expect(retrying(async () => (tries++, Promise.reject(new GitHubError(403, "No permission"))), 3, 1)).rejects.toThrow("No permission");
    expect(tries).toBe(1);
  });
});

describe("admin API hardening", () => {
  it("writes the waiting list once per person, and only from /session", async () => {
    await call(`${API}/gh/repos/${REPO}/contents/content/slots.json`, { headers: await bearer(STRANGER) });
    expect(kv.puts).toBe(0);
    for (let i = 0; i < 5; i++) expect((await call(`${API}/session`, { headers: await bearer(STRANGER) })).status).toBe(403);
    expect(kv.puts).toBe(1);
  });

  it("answers 429 when one address asks too much, and counts sign-in apart", async () => {
    const ip = { "CF-Connecting-IP": "203.0.113.9" };
    for (let i = 0; i < 20; i++) expect((await call(`${API}/auth/login?return=${encodeURIComponent(ADMIN)}&nonce=${"n".repeat(24)}`, { headers: ip })).status).toBe(302);
    const r = await call(`${API}/auth/login?return=${encodeURIComponent(ADMIN)}&nonce=${"n".repeat(24)}`, { headers: ip });
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("60");
    // Other addresses and the rest of the API are unaffected.
    expect((await call(`${API}/`, { headers: ip })).status).toBe(200);
    expect((await call(`${API}/auth/login?return=${encodeURIComponent(ADMIN)}&nonce=${"n".repeat(24)}`, { headers: { "CF-Connecting-IP": "203.0.113.10" } })).status).toBe(302);
  });

  it("uses the Cloudflare limiter when there is one", async () => {
    env.RATE_LIMITER = { limit: async () => ({ success: false }) };
    expect((await call(`${API}/`, { headers: { "CF-Connecting-IP": "203.0.113.11" } })).status).toBe(429);
  });

  it("only moves the branch to a commit credited to the person asking", async () => {
    const ann = await bearer(ANN);
    const api = `${API}/gh/repos/${REPO}/git`;
    const mk = async (hdr: Record<string, string>) => {
      const blob = await (await call(`${api}/blobs`, { method: "POST", headers: hdr, body: JSON.stringify({ content: region("author-test", ANN), encoding: "utf-8" }) })).json();
      const base = (await (await call(`${api}/commits/${head()}`, { headers: hdr })).json()).tree.sha;
      const tree = await (await call(`${api}/trees`, { method: "POST", headers: hdr, body: JSON.stringify({ base_tree: base, tree: [{ path: "content/regions/author-test.json", mode: "100644", type: "blob", sha: blob.sha }] }) })).json();
      return (await (await call(`${api}/commits`, { method: "POST", headers: hdr, body: JSON.stringify({ message: "x", tree: tree.sha, parents: [head()] }) })).json()).sha as string;
    };
    const sha = await mk(ann);
    // Someone else (the owner, who may change anything) can't move the branch to Ann's commit.
    const stolen = await call(`${api}/refs/heads/main`, { method: "PATCH", headers: await bearer(OWNER), body: JSON.stringify({ sha }) });
    expect(stolen.status).toBe(403);
    expect((await stolen.json()).message).toMatch(/isn't credited to you/);
    const ok = await call(`${api}/refs/heads/main`, { method: "PATCH", headers: ann, body: JSON.stringify({ sha }) });
    expect(ok.status).toBe(200);
  });

  it("refuses slots and map files that fail their schemas or point nowhere", async () => {
    const owner = await client(OWNER);
    const map = (id: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ id, name: "A map", uploadedBy: "x", date: "2026-11-01T10:00:00Z", aspect: 2, width: 2048, height: 1024, hash: "0123456789ab", sizes: { "1024": "maps/x/0123456789ab-1024.webp" }, lqip: "data:image/webp;base64,AAAA", ...extra });
    expect(await tryCommit(owner, [put("content/slots.json", "{ nope")])).toMatch(/isn't valid JSON/);
    expect(await tryCommit(owner, [put("content/slots.json", JSON.stringify({ slots: { aerthos: { map: "globe-map", bogus: 1 } } }))])).toMatch(/doesn't match its schema/);
    expect(await tryCommit(owner, [put("content/slots.json", JSON.stringify({ slots: { aerthos: { map: "no-such-map" } } }))])).toMatch(/doesn't exist/);
    expect(await tryCommit(owner, [put("content/maps/globe-map.json", "{\"id\":\"globe-map\"}\n")])).toMatch(/doesn't match its schema/);
    expect(await tryCommit(owner, [put("content/maps/new-map.json", map("other-id"))])).toMatch(/must have the id "new-map"/);
    expect(await tryCommit(owner, [put("content/maps/new-map.json", map("new-map")), put("content/slots.json", JSON.stringify({ slots: { aerthos: { map: "new-map" } } }))])).toBeNull();
  });
});

describe("suggested changes", () => {
  const suggestion = (id: string, by: { id: number; login: string }, extra: Record<string, unknown> = {}) => JSON.parse(region(id, id === "ann-land" ? ANN : SIMON, by, extra));
  const send = (gh: GitHub, id: string, by: { id: number; login: string }, note = "moved the border", extra: Record<string, unknown> = {}) => gh.suggest(id, suggestion(id, by, extra), note);

  it("lets someone who can't edit a region suggest a change, and nothing reaches the repository", async () => {
    const before = head();
    const s = await send(await client(ANN), "simon-land", ANN, "moved the border", { color: "#112233" });
    expect(s).toMatchObject({ id: `simon-land~${ANN.id}`, region: "simon-land", status: "pending", owner: SIMON.id, note: "moved the border" });
    expect(head()).toBe(before);
    expect(mock.read("main", "content/regions/simon-land.json")).toBe(region("simon-land", SIMON));
  });

  it("is seen by the sender and the people who may edit that region, not by others", async () => {
    await send(await client(ANN), "simon-land", ANN);
    expect((await (await client(ANN)).suggestions()).map((x) => x.id)).toEqual([`simon-land~${ANN.id}`]);
    expect((await (await client(SIMON)).suggestions()).length).toBe(1); // the region's creator
    expect((await (await client(BO)).suggestions()).length).toBe(1); // may edit others' regions
    expect((await (await client(OWNER)).suggestions()).length).toBe(1);
    expect((await (await client(MANAGER)).suggestions()).length).toBe(0);
    expect((await (await client(MANAGER)).suggestion(`simon-land~${ANN.id}`).catch((e: Error) => e.message))).toMatch(/can't see/);
    expect((await (await client(BO)).suggestion(`simon-land~${ANN.id}`)).feature.id).toBe("simon-land");
  });

  it("refuses suggestions for missing regions, other ids, bad shapes and people without Create regions", async () => {
    const ann = await client(ANN);
    await expect(send(ann, "nowhere", ANN)).rejects.toThrow(/no region "nowhere"/);
    await expect(ann.suggest("simon-land", suggestion("ann-land", ANN), "")).rejects.toThrow(/must have the id/);
    await expect(ann.suggest("simon-land", { ...suggestion("simon-land", ANN), geometry: 5 }, "")).rejects.toThrow(/schema/);
    await expect(ann.suggest("../x", suggestion("simon-land", ANN), "")).rejects.toThrow(/Bad region id/);
    await expect(client(STRANGER)).rejects.toBeInstanceOf(NotListed);
    const viewer = { id: 5009, login: "viewer" };
    expect(await tryCommit(await client(OWNER), [put("content/access.json", JSON.stringify({ users: [...ACCESS.users, { ...viewer, permissions: ["maps"] }] }) + "\n")])).toBeNull();
    await expect(send(await client(viewer), "simon-land", viewer)).rejects.toThrow(/permission to suggest/);
  });

  it("keeps one pending suggestion per person per region (sending again replaces it) and at most 15 waiting", async () => {
    const ann = await client(ANN);
    await send(ann, "simon-land", ANN, "first");
    await send(ann, "simon-land", ANN, "second");
    const list = await ann.suggestions();
    expect(list.length).toBe(1);
    expect(list[0].note).toBe("second");
    const owner = await client(OWNER);
    expect(await tryCommit(owner, [...Array.from({ length: 15 }, (_, i) => put(`content/regions/r${i}.json`, region(`r${i}`, SIMON, OWNER))), put("content/regions/one-more.json", region("one-more", SIMON, OWNER))])).toBeNull();
    for (let i = 0; i < 14; i++) await send(ann, `r${i}`, ANN);
    await expect(send(ann, "r14", ANN)).rejects.toThrow(/already have 15/);
  });

  it("lets only people who may edit the region accept or decline, once", async () => {
    await send(await client(ANN), "simon-land", ANN);
    const id = `simon-land~${ANN.id}`;
    await expect((await client(ANN)).decideSuggestion(id, "accepted")).rejects.toThrow(/your own suggestion/);
    await expect((await client(MANAGER)).decideSuggestion(id, "declined")).rejects.toThrow(/can't decide|can't see/);
    await (await client(SIMON)).decideSuggestion(id, "declined", "keep the old border");
    const after = (await (await client(ANN)).suggestions())[0];
    expect(after).toMatchObject({ status: "declined", decidedBy: "LoopSimon", reason: "keep the old border" });
    await expect((await client(OWNER)).decideSuggestion(id, "accepted")).rejects.toThrow(/already declined/);
  });

  it("is accepted by saving the region as the reviewer, which the normal permission checks allow", async () => {
    await send(await client(ANN), "simon-land", ANN, "", { color: "#112233" });
    const id = `simon-land~${ANN.id}`;
    const simon = await client(SIMON);
    const sug = await simon.suggestion(id);
    // Same creator as the region, saved by the reviewer.
    const feature = { ...sug.feature, properties: { ...sug.feature.properties, created: "2026-11-12T10:00:00Z", createdBy: SIMON, updatedBy: SIMON } };
    expect(await tryCommit(simon, [put("content/regions/simon-land.json", JSON.stringify(feature) + "\n")])).toBeNull();
    await simon.decideSuggestion(id, "accepted");
    expect((await (await client(ANN)).suggestions())[0].status).toBe("accepted");
    expect(JSON.parse(mock.read("main", "content/regions/simon-land.json")!).properties.color).toBe("#112233");
  });

  it("lets the sender withdraw, and the reviewer clear a decided one, but not a pending one", async () => {
    const ann = await client(ANN);
    await send(ann, "simon-land", ANN);
    const id = `simon-land~${ANN.id}`;
    await expect((await client(SIMON)).removeSuggestion(id)).rejects.toThrow(/Only the person who sent/);
    await ann.removeSuggestion(id);
    expect((await ann.suggestions()).length).toBe(0);
    await send(ann, "simon-land", ANN);
    await (await client(SIMON)).decideSuggestion(id, "declined");
    await (await client(SIMON)).removeSuggestion(id);
    expect((await ann.suggestions()).length).toBe(0);
  });

  it("lets people who can edit a region propose too, but never decide their own", async () => {
    const bo = await client(BO);
    await send(bo, "simon-land", BO, "for Simon to check");
    const id = `simon-land~${BO.id}`;
    await expect(bo.decideSuggestion(id, "accepted")).rejects.toThrow(/your own suggestion/);
    await expect(bo.decideSuggestion(id, "declined")).rejects.toThrow(/your own suggestion/);
    // Others who may edit it can: the region's creator, and the owner.
    expect((await (await client(SIMON)).suggestions()).map((x) => x.id)).toContain(id);
    await (await client(SIMON)).decideSuggestion(id, "accepted");
    // The owner proposes on their own region; an editor decides.
    await send(await client(OWNER), "old-land", OWNER);
    const oid = `old-land~${OWNER.id}`;
    await expect((await client(OWNER)).decideSuggestion(oid, "accepted")).rejects.toThrow(/your own suggestion/);
    await (await client(BO)).decideSuggestion(oid, "declined");
    expect((await (await client(OWNER)).suggestions()).find((x) => x.id === oid)?.status).toBe("declined");
  });

  it("answers 501 where there's no key-value store", async () => {
    env.WAITING = undefined;
    await expect((await client(ANN)).suggestions()).rejects.toThrow(/aren't set up/);
  });
});
