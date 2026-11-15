/**
 * Rate limits for the public admin API, kept apart from the handler so the endpoints other features add
 * only have to be listed in `limitFor`.
 *
 * Two layers:
 *  - Cloudflare's rate-limiting binding (`RATE_LIMITER`, see wrangler.toml), which counts across every
 *    Worker instance. Optional: without it only the second layer applies.
 *  - A small fixed-window counter per Worker instance, always on. It's weaker (each instance counts for
 *    itself) but needs no setup and is what the tests exercise.
 */

export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

interface Bucket {
  max: number;
  windowMs: number;
}

/** Sign-in endpoints: nobody needs more than a handful a minute. */
const AUTH: Bucket = { max: 20, windowMs: 60_000 };
/** Everything else: a big save is a few hundred small requests, so this is generous. */
const GENERAL: Bucket = { max: 900, windowMs: 60_000 };

const windows = new Map<string, { start: number; count: number }>();
const MAX_KEYS = 5000;

/** Forget all counters (tests). */
export function resetRateLimits(): void {
  windows.clear();
}

function bucketFor(path: string): { name: string; bucket: Bucket } {
  return path.startsWith("/auth/") ? { name: "auth", bucket: AUTH } : { name: "api", bucket: GENERAL };
}

/**
 * Whether this request is over its limit. `ip` is the caller's address; Cloudflare always sends it, so a
 * request without one isn't coming through Cloudflare (a test run) and isn't counted.
 */
export async function rateLimited(ip: string | null, path: string, limiter?: RateLimiter): Promise<boolean> {
  if (!ip) return false;
  const { name, bucket } = bucketFor(path);
  const now = Date.now();
  const key = `${name}:${ip}`;
  if (windows.size > MAX_KEYS) for (const [k, w] of windows) if (now - w.start > bucket.windowMs) windows.delete(k);
  const w = windows.get(key);
  if (!w || now - w.start >= bucket.windowMs) windows.set(key, { start: now, count: 1 });
  else if (++w.count > bucket.max) return true;
  if (limiter) {
    try {
      if (!(await limiter.limit({ key })).success) return true;
    } catch {
      /* A limiter outage must never take the API down with it. */
    }
  }
  return false;
}
