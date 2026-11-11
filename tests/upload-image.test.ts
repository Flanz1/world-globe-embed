import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { imageSize, stripMetadata } from "../src/admin/upload-image.ts";

const img = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#2a6" } });

describe("imageSize", () => {
  it("reads PNG, JPEG (with EXIF in front) and WebP sizes from the header", async () => {
    expect(imageSize(await img(300, 150).png().toBuffer())).toEqual({ kind: "png", width: 300, height: 150 });
    const jpg = await img(321, 123).jpeg().withExif({ IFD0: { Copyright: "x".repeat(2000) } }).toBuffer();
    expect(imageSize(jpg)).toEqual({ kind: "jpeg", width: 321, height: 123 });
    expect(imageSize(await img(200, 100).webp().toBuffer())).toEqual({ kind: "webp", width: 200, height: 100 });
    expect(imageSize(await img(200, 100).webp({ lossless: true }).toBuffer())).toEqual({ kind: "webp", width: 200, height: 100 });
    expect(imageSize(new TextEncoder().encode("<svg/>"))).toBeNull();
  });
});

describe("stripMetadata", () => {
  it("removes EXIF from a JPEG and text chunks from a PNG, and the image still decodes the same", async () => {
    const jpg = await img(64, 32).jpeg().withExif({ IFD0: { Copyright: "secret-gps-like-data" } }).toBuffer();
    expect((await sharp(jpg).metadata()).exif).toBeDefined();
    const clean = stripMetadata(jpg, "jpeg");
    expect(Buffer.from(clean).includes("secret-gps-like-data")).toBe(false);
    const m = await sharp(clean).metadata();
    expect([m.width, m.height, m.exif]).toEqual([64, 32, undefined]);
    expect(Buffer.compare(await sharp(clean).raw().toBuffer(), await sharp(jpg).raw().toBuffer())).toBe(0);

    const png = await img(64, 32).png().withExif({ IFD0: { Copyright: "secret-gps-like-data" } }).toBuffer();
    const cleanPng = stripMetadata(png, "png");
    expect(Buffer.from(cleanPng).includes("secret-gps-like-data")).toBe(false);
    expect((await sharp(cleanPng).metadata()).width).toBe(64);
  });
});
