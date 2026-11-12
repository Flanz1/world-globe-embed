/** Signing helpers for the admin API: HMAC-signed session and state tokens, and the GitHub App's RS256 JWT. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    hmacKeys.set(secret, k);
  }
  return k;
}

/** `payload` as JSON, signed: "<base64url json>.<base64url hmac>". */
export async function sign(payload: object, secret: string): Promise<string> {
  const body = b64url(JSON.stringify(payload));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(mac)}`;
}

/** The payload of a token made by sign(), or null if it was tampered with, malformed or past its `exp` (seconds). */
export async function verify<T extends { exp: number }>(token: string, secret: string, now = Date.now() / 1000): Promise<T | null> {
  const m = /^([A-Za-z0-9_-]{1,4000})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(m[2]), enc.encode(m[1]));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const p = JSON.parse(dec.decode(fromB64url(m[1]))) as T;
    return typeof p.exp === "number" && p.exp > now ? p : null;
  } catch {
    return null;
  }
}

/* ── GitHub App JWT (RS256) ── */

function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  return fromB64url(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

/** DER length bytes. */
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/**
 * GitHub hands out App keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), but WebCrypto only imports PKCS#8.
 * Wrapping is mechanical: SEQUENCE { INTEGER 0, AlgorithmIdentifier rsaEncryption, OCTET STRING pkcs1 }.
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = [0x02, 0x01, 0x00];
  const alg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length)];
  const inner = version.length + alg.length + octet.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLen(inner), ...version, ...alg, ...octet, ...pkcs1]);
  return out;
}

const rsaKeys = new Map<string, Promise<CryptoKey>>();
function rsaKey(pem: string): Promise<CryptoKey> {
  let k = rsaKeys.get(pem);
  if (!k) {
    const der = pemBody(pem);
    const pkcs8 = /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1ToPkcs8(der) : der;
    k = crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    rsaKeys.set(pem, k);
  }
  return k;
}

/** A JWT that authenticates as the GitHub App for up to 9 minutes. */
export async function appJwt(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Backdated a minute against clock drift, as GitHub recommends.
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await rsaKey(privateKeyPem), enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/** A random URL-safe string. */
export const nonce = (bytes = 16) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
