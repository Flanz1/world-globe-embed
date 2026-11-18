/**
 * What the admin page may read from its own session token (a signed "<base64url json>.<mac>" made by the admin API).
 * The page can't check the signature (the API does, on every request); it only reads the expiry and the
 * "Keep me signed in" mark, to decide where to store the token and when to renew it.
 */

export interface TokenInfo {
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Signed in with "Keep me signed in". */
  remember: boolean;
}

/** A remembered session is renewed when it has less than this left (29 of its 30 days: about once a day). */
export const RENEW_BELOW_SECONDS = 29 * 86400;

export function tokenInfo(token: string): TokenInfo | null {
  try {
    const body = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(body + "===".slice((body.length + 3) % 4))) as { exp?: unknown; m?: unknown };
    return typeof p.exp === "number" ? { exp: p.exp, remember: p.m === 1 } : null;
  } catch {
    return null;
  }
}

export const sessionRemembers = (token: string): boolean => tokenInfo(token)?.remember ?? false;

/** Should the page ask the admin API for a fresh 30 days? Only remembered sessions that are still valid and have used up a day. */
export function needsRenewal(token: string, now = Date.now() / 1000): boolean {
  const i = tokenInfo(token);
  return !!i && i.remember && i.exp > now && i.exp - now < RENEW_BELOW_SECONDS;
}
