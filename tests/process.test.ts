import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { checkAspect, inspect, mapIdFromFilename, processImage, sniff } from "../scripts/lib/process.ts";
import { contentPaths } from "../scripts/lib/paths.ts";

function tempProject() {
  const root = mkdtempSync(path.join(tmpdir(), "wge-"));
  const paths = contentPaths(root);
  mkdirSync(paths.incomingDir, { recursive: true });
  mkdirSync(paths.mapsDir, { recursive: true });
  mkdirSync(paths.publicDir, { recursive: true });
  return paths;
}

const gradient = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 90, b: 160 } } }).composite([
    { input: Buffer.from(`<svg width="${w}" height="${h}"><circle cx="${w / 3}" cy="${h / 2}" r="${h / 4}" fill="#5a8a3c"/></svg>`) },
  ]);

describe("sniff", () => {
  it("recognises PNG, JPEG and WebP by magic bytes", async () => {
    const img = sharp({ create: { width: 4, height: 2, channels: 3, background: "#000" } });
    expect(sniff(await img.clone().png().toBuffer())).toBe("png");
    expect(sniff(await img.clone().jpeg().toBuffer())).toBe("jpeg");
    expect(sniff(await img.clone().webp().toBuffer())).toBe("webp");
  });
  it("rejects other content regardless of extension", () => {
    expect(sniff(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniff(Buffer.from("GIF89a......"))).toBeNull();
  });
});

describe("checkAspect", () => {
  it("accepts anything from square to 4:1, including the 6000×3465 map that used to fail", () => {
    expect(checkAspect(4096, 2048).ok).toBe(true);
    expect(checkAspect(6000, 3465).ok).toBe(true); // 1.73
    expect(checkAspect(2048, 2048).ok).toBe(true);
    expect(checkAspect(8000, 2000).ok).toBe(true);
  });
  it("rejects portrait and extremely wide images with a readable message", () => {
    const r = checkAspect(1000, 1500);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/at least as wide as it is tall/);
    expect(checkAspect(9000, 2000).ok).toBe(false); // 4.5
  });
});

describe("mapIdFromFilename", () => {
  it("slugifies the stem", () => {
    expect(mapIdFromFilename("My World (v2).PNG")).toBe("my-world-v2");
    expect(mapIdFromFilename("Ærthos Ñorth.jpg")).toBe("rthos-north");
  });
});

describe("processImage", () => {
  it("writes 1024/2048 WebPs, a small LQIP and metadata, strips EXIF and removes the source", async () => {
    const paths = tempProject();
    const src = path.join(paths.incomingDir, "Test World.jpg");
    await gradient(2400, 1200).jpeg().withExif({ IFD0: { Copyright: "secret-gps-like-data" } }).toFile(src);
    expect((await sharp(src).metadata()).exif).toBeDefined();

    const meta = await processImage(src, { paths, uploadedBy: "tester", now: new Date("2026-01-02T03:04:05Z") });

    expect(meta.id).toBe("test-world");
    expect(meta.name).toBe("Test World");
    expect(meta.uploadedBy).toBe("tester");
    expect(meta.date).toBe("2026-01-02T03:04:05.000Z");
    expect(meta.hash).toMatch(/^[0-9a-f]{12}$/);
    // 2400px source: no 4096 upscale.
    expect(Object.keys(meta.sizes)).toEqual(["1024", "2048"]);
    for (const [w, rel] of Object.entries(meta.sizes)) {
      expect(rel).toBe(`maps/test-world/${meta.hash}-${w}.webp`);
      const out = await sharp(path.join(paths.publicDir, rel!)).metadata();
      expect(out.format).toBe("webp");
      expect(out.width).toBe(Number(w));
      expect(out.height).toBe(Number(w) / 2);
      expect(out.exif).toBeUndefined();
    }
    expect(meta.lqip).toMatch(/^data:image\/webp;base64,/);
    expect(Buffer.from(meta.lqip.split(",")[1], "base64").length).toBeLessThan(2048);
    expect(existsSync(src)).toBe(false);
    const written = JSON.parse(readFileSync(path.join(paths.mapsDir, "test-world.json"), "utf8"));
    expect(written.sizes).toEqual(meta.sizes);
  });

  it("keeps a hand-edited name and replaces old textures on re-upload", async () => {
    const paths = tempProject();
    const a = path.join(paths.incomingDir, "terra.png");
    await gradient(2048, 1024).png().toFile(a);
    const first = await processImage(a, { paths, uploadedBy: "a" });
    const metaFile = path.join(paths.mapsDir, "terra.json");
    writeFileSync(metaFile, JSON.stringify({ ...first, name: "Terra Prime" }));

    await gradient(2048, 1024).modulate({ hue: 90 }).png().toFile(a);
    const second = await processImage(a, { paths, uploadedBy: "b" });
    expect(second.name).toBe("Terra Prime");
    expect(second.hash).not.toBe(first.hash);
    expect(existsSync(path.join(paths.publicDir, first.sizes["1024"]!))).toBe(false);
    expect(existsSync(path.join(paths.publicDir, second.sizes["1024"]!))).toBe(true);
  });

  it("keeps the source's proportions for maps that aren't 2:1", async () => {
    const paths = tempProject();
    const src = path.join(paths.incomingDir, "tall.jpg");
    await gradient(2400, 1386).jpeg().toFile(src); // same ratio as 6000×3465
    const meta = await processImage(src, { paths, uploadedBy: "x" });
    expect(meta.aspect).toBeCloseTo(1.732, 2);
    const out = await sharp(path.join(paths.publicDir, meta.sizes["2048"]!)).metadata();
    expect([out.width, out.height]).toEqual([2048, 1183]);
  });

  it("rejects a portrait image without writing anything", async () => {
    const paths = tempProject();
    const src = path.join(paths.incomingDir, "portrait.png");
    await gradient(1200, 1500).png().toFile(src);
    expect((await inspect(src)).errors[0]).toMatch(/portrait\.png: is 1200×1500/);
    await expect(processImage(src, { paths, uploadedBy: "x" })).rejects.toThrow(/at least as wide/);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(path.join(paths.mapsDir, "portrait.json"))).toBe(false);
  });

  it("rejects files that are not images even with an image extension", async () => {
    const paths = tempProject();
    const src = path.join(paths.incomingDir, "fake.png");
    writeFileSync(src, "this is not an image");
    expect((await inspect(src)).errors[0]).toMatch(/not a PNG, JPEG or WebP/);
  });
});
