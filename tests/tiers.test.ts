import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceLimit, nextTier } from "../src/shared/tiers.ts";

const all = [1024, 2048, 4096, 8192].map((w) => ({ w, url: `${w}.webp` }));
const no8k = all.slice(0, 3);

describe("nextTier", () => {
  it("goes straight to the size the screen needs, up to 4096", () => {
    expect(nextTier(all, 1024, 2048, 8192)?.w).toBe(2048);
    expect(nextTier(all, 1024, 4096, 8192)?.w).toBe(4096);
    expect(nextTier(all, 2048, 4096, 8192)?.w).toBe(4096);
  });
  it("loads 4096 before 8192: two stages when zoomed in close", () => {
    expect(nextTier(all, 1024, 8192, 8192)?.w).toBe(4096);
    expect(nextTier(all, 2048, 8192, 8192)?.w).toBe(4096);
    expect(nextTier(all, 4096, 8192, 8192)?.w).toBe(8192);
    expect(nextTier(all, 8192, 8192, 8192)).toBeUndefined();
  });
  it("respects the device limit (small GPU texture size, phones)", () => {
    expect(nextTier(all, 4096, 8192, 4096)).toBeUndefined();
    expect(nextTier(all, 1024, 8192, 4096)?.w).toBe(4096);
    expect(nextTier(all, 1024, 8192, 2048)?.w).toBe(2048);
  });
  it("stops at the largest size the map has", () => {
    expect(nextTier(no8k, 1024, 8192, 8192)?.w).toBe(4096);
    expect(nextTier(no8k, 4096, 8192, 8192)).toBeUndefined();
    // A map with no 4096 (source under 4096 wide) has no staging step to wait for.
    expect(nextTier(all.slice(0, 2), 1024, 8192, 8192)?.w).toBe(2048);
  });
  it("never steps down", () => {
    expect(nextTier(all, 4096, 2048, 8192)).toBeUndefined();
  });
});

describe("deviceLimit", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("allows 8192 on desktops, 4096 on phones and low-memory devices, and never more than the GPU takes", () => {
    vi.stubGlobal("navigator", {});
    expect(deviceLimit(false)).toBe(8192);
    expect(deviceLimit(false, 4096)).toBe(4096);
    expect(deviceLimit(true)).toBe(4096);
    vi.stubGlobal("navigator", { deviceMemory: 4 });
    expect(deviceLimit(false)).toBe(4096);
    vi.stubGlobal("navigator", { deviceMemory: 8 });
    expect(deviceLimit(false, 16384)).toBe(8192);
  });
  it("ignores Brave's randomized deviceMemory", () => {
    vi.stubGlobal("navigator", { deviceMemory: 2, brave: {} });
    expect(deviceLimit(false)).toBe(8192);
    expect(deviceLimit(false, 4096)).toBe(4096);
    expect(deviceLimit(true)).toBe(4096);
  });
});
