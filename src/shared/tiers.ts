/**
 * Which texture to load next. Shared by the globe and the flat view so both step up the same way.
 *
 * Up to 4096 the viewer jumps straight to the size the screen needs (1024 → 2048, or 1024 → 4096).
 * 8192 is never the first upgrade: when it's wanted, the 4096 loads and shows first (a few hundred KB),
 * then the 8192 (a few MB) replaces it. So a zoomed-in region gets sharp quickly, then sharper.
 */

/** Sizes above this are only loaded once this size is on screen. */
export const STAGE_BEFORE = 4096;

export interface Tier {
  w: number;
  url: string;
}

/**
 * @param textures available sizes, smallest first
 * @param current width on screen now
 * @param want width the screen needs
 * @param limit largest width this device may load (GPU max texture size, memory)
 */
export function nextTier<T extends Tier>(textures: readonly T[], current: number, want: number, limit: number): T | undefined {
  let cap = Math.min(want, limit);
  if (current < STAGE_BEFORE && textures.some((t) => t.w === STAGE_BEFORE)) cap = Math.min(cap, STAGE_BEFORE);
  return textures.filter((t) => t.w > current && t.w <= cap).pop();
}

/** deviceMemory where the browser reports it (Chromium), in GB. */
export function deviceMemory(): number | undefined {
  return (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
}

/**
 * Largest texture width this device should hold. An 8192 × 4096 texture is 128 MB decoded and about
 * 170 MB on the GPU with mipmaps, so it's desktop only, needs a GPU that takes 8192 textures, and is
 * skipped where the browser says the device has under 8 GB of memory.
 */
export function deviceLimit(mobile: boolean, maxTextureSize = Infinity): number {
  const mem = deviceMemory();
  const big = !mobile && (mem === undefined || mem >= 8);
  return Math.min(big ? 8192 : 4096, maxTextureSize);
}
