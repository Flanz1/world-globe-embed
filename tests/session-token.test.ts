import { describe, expect, it } from "vitest";
import { needsRenewal, sessionRemembers, tokenInfo } from "../src/admin/session-token.ts";

const tok = (p: object) => `${btoa(JSON.stringify(p)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${"A".repeat(43)}`;
const now = 1_000_000;

describe("session token (admin page)", () => {
  it("reads the expiry and the keep-me-signed-in mark", () => {
    expect(tokenInfo(tok({ id: 1, login: "a", exp: now + 10, m: 1 }))).toEqual({ exp: now + 10, remember: true });
    expect(tokenInfo(tok({ id: 1, login: "a", exp: now + 10 }))).toEqual({ exp: now + 10, remember: false });
    expect(tokenInfo("garbage")).toBeNull();
    expect(sessionRemembers(tok({ exp: 5, m: 1 }))).toBe(true);
    expect(sessionRemembers("garbage")).toBe(false);
  });

  it("renews remembered sessions once they are a day old, never plain or expired ones", () => {
    const day = 86400;
    expect(needsRenewal(tok({ exp: now + 30 * day, m: 1 }), now)).toBe(false);
    expect(needsRenewal(tok({ exp: now + 28 * day, m: 1 }), now)).toBe(true);
    expect(needsRenewal(tok({ exp: now + 1 * day, m: 1 }), now)).toBe(true);
    expect(needsRenewal(tok({ exp: now - 1, m: 1 }), now)).toBe(false);
    expect(needsRenewal(tok({ exp: now + 3600 }), now)).toBe(false);
  });
});
