/**
 * The admin API (worker/) end to end, in Node: the real handler in front of an in-memory GitHub, driven by
 * the admin page's own GitHub client. These are the permission checks that matter, because the API is
 * the only thing that can write to the repository.
 */
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GitHub, NotListed, type FileChange } from "../src/admin/github.ts";
import { handle, resetCaches, returnAllowed, type Env, type KV } from "../worker/src/handler.ts";
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
const STRANGER = { id: 7777, login: "stranger" };

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

class MemoryKV implements KV {
  data = new Map<string, unknown>();
  async put(key: string, _v: string, opts?: { metadata?: unknown }) {
    this.data.set(key, opts?.metadata);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list(opts?: { prefix?: string }) {
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
    const start = await call(`${API}/auth/login?return=${encodeURIComponent(ADMIN)}`);
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
    const token = loc.split("#session=")[1];
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
    expect([...kv.data.values()]).toEqual([expect.objectContaining({ id: STRANGER.id, login: STRANGER.login })]);
    // Not listed means no reads or writes either.
    const r = await call(`${API}/gh/repos/${REPO}/contents/content/slots.json`, { headers: { Authorization: `Bearer ${await session(STRANGER)}` } });
    expect(r.status).toBe(403);
    expect(await (await client(MANAGER)).waiting()).toEqual([expect.objectContaining({ login: "stranger" })]);
    await expect((await client(ANN)).waiting()).rejects.toThrow(/manage users/);
    await (await client(MANAGER)).dismissWaiting(STRANGER.id);
    expect(kv.data.size).toBe(0);
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
  const file = () => JSON.parse(mock.read("main", CATS)!) as CategoriesFile;
  const write = (cats: CategoriesFile["categories"]) => put(CATS, JSON.stringify({ categories: cats }, null, 2) + "\n");

  it("anyone who can create regions adds categories as themselves, and manages their own", async () => {
    const ann = await client(ANN);
    expect(await tryCommit(ann, [write([cat("ann-stuff", ANN)])])).toBeNull();
    expect(await tryCommit(ann, [write([cat("ann-stuff", ANN, ["ann-land"], "Ann's stuff")])])).toBeNull(); // rename + own region in
    expect(file().categories[0].regions).toEqual(["ann-land"]);
    expect(await tryCommit(ann, [write([])])).toBeNull(); // delete her own
    // Made-up creators are refused, and so is no creator at all.
    expect(await tryCommit(ann, [write([cat("fake", OWNER)])])).toMatch(/createdBy set to you/);
    expect(await tryCommit(ann, [write([cat("fake", undefined)])])).toMatch(/createdBy set to you/);
  });

  it("people without Create regions can't change categories", async () => {
    const mute = { id: 8001, login: "reader" };
    await client(OWNER).then((gh) => tryCommit(gh, [put("content/access.json", JSON.stringify({ users: [...ACCESS.users, { ...mute, permissions: ["maps"] }] }) + "\n")]));
    expect(await tryCommit(await client(mute), [write([cat("x", mute)])])).toMatch(/permission to change categories/);
  });

  it("only editors of others' regions touch other people's categories", async () => {
    seed([cat("simon-cat", SIMON, ["simon-land"]), cat("old-cat", undefined)]);
    const ann = await client(ANN);
    expect(await tryCommit(ann, [write([cat("simon-cat", SIMON, ["simon-land"], "Renamed"), cat("old-cat", undefined)])])).toMatch(/can't rename the category "simon-cat": LoopSimon created it/);
    expect(await tryCommit(ann, [write([cat("old-cat", undefined)])])).toMatch(/can't delete the category "simon-cat"/);
    expect(await tryCommit(ann, [write([cat("simon-cat", SIMON, ["simon-land"])])])).toMatch(/can't delete the category "old-cat": the owner created it/);
    const bo = await client(BO);
    expect(await tryCommit(bo, [write([cat("simon-cat", SIMON, ["simon-land"], "Renamed"), cat("old-cat", undefined)])])).toBeNull();
    expect(await tryCommit(bo, [write([cat("simon-cat", SIMON, ["simon-land"], "Renamed")])])).toBeNull();
    // Nobody but the owner changes who created a category.
    expect(await tryCommit(bo, [write([cat("simon-cat", BO, ["simon-land"], "Renamed")])])).toMatch(/Only the repository owner can change who created/);
  });

  it("moving a region needs the right to edit that region", async () => {
    seed([cat("a", ANN), cat("b", SIMON)]);
    const ann = await client(ANN);
    // Her own region goes into someone else's category: fine (the folder keeps its creator and name).
    expect(await tryCommit(ann, [write([cat("a", ANN), cat("b", SIMON, ["ann-land"])])])).toBeNull();
    expect(await tryCommit(ann, [write([cat("a", ANN, ["ann-land"]), cat("b", SIMON)])])).toBeNull();
    // LoopSimon's region isn't hers to move, and neither is the owner's older region.
    expect(await tryCommit(ann, [write([cat("a", ANN, ["simon-land"]), cat("b", SIMON)])])).toMatch(/can't move "simon-land"/);
    expect(await tryCommit(ann, [write([cat("a", ANN, ["old-land"]), cat("b", SIMON)])])).toMatch(/can't move "old-land"/);
    // The owner can, and an editor.
    expect(await tryCommit(await client(OWNER), [write([cat("a", ANN, ["simon-land"]), cat("b", SIMON)])])).toBeNull();
    expect(await tryCommit(await client(BO), [write([cat("a", ANN, ["simon-land", "ann-land"]), cat("b", SIMON)])])).toBeNull();
    // Ids of regions that don't exist can't be reserved, but leftovers can be tidied away.
    expect(await tryCommit(await client(BO), [write([cat("a", ANN, ["simon-land", "ann-land", "ghost"]), cat("b", SIMON)])])).toMatch(/no region "ghost"/);
    seed([cat("a", ANN, ["ghost", "ann-land"])]);
    expect(await tryCommit(ann, [write([cat("a", ANN, ["ann-land"])])])).toBeNull();
  });

  it("deleting a category sends its regions to Uncategorized without needing rights over them", async () => {
    seed([cat("mine", ANN, ["simon-land", "ann-land"])]);
    expect(await tryCommit(await client(ANN), [write([])])).toBeNull();
    seed([cat("mine", ANN, ["simon-land"]), cat("other", ANN)]);
    // But moving them into another category still counts as moving them.
    expect(await tryCommit(await client(ANN), [write([cat("other", ANN, ["simon-land"])])])).toMatch(/can't move "simon-land"/);
  });

  it("lets anyone who can create regions reorder, and checks the file's shape", async () => {
    seed([cat("a", ANN), cat("b", SIMON), cat("c", BO)]);
    const ann = await client(ANN);
    expect(await tryCommit(ann, [write([cat("b", SIMON), cat("c", BO), cat("a", ANN)])])).toBeNull();
    expect(await tryCommit(ann, [write([cat("a", ANN, ["ann-land"]), cat("a", ANN)])])).toMatch(/used twice/);
    expect(await tryCommit(ann, [write([cat("a", ANN, [], "x"), cat("b", ANN, [], "X")])])).toMatch(/two categories called/);
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

describe("admin API branch updates", () => {
  const raw = async (who: { id: number; login: string }, method: string, p: string, body?: unknown) => {
    const r = await call(`${API}/gh/repos/${REPO}${p}`, { method, headers: { Authorization: `Bearer ${await session(who)}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

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
