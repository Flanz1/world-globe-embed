/**
 * Generates a procedural equirectangular test world (seamless, sampled on the sphere)
 * and runs it through the same processing as uploads. Used for the sample slot.
 *
 *   npm run sample            # writes content/maps/sample-world.json + public/maps/sample-world/*
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { contentPaths } from "./lib/paths.ts";
import { processImage } from "./lib/process.ts";

const W = 4096;
const H = 2048;

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const fade = (t: number) => t * t * (3 - 2 * t);
function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), xf), l(c(0, 1, 0), c(1, 1, 0), xf), yf),
    l(l(c(0, 0, 1), c(1, 0, 1), xf), l(c(0, 1, 1), c(1, 1, 1), xf), yf),
    zf,
  );
}
function fbm(x: number, y: number, z: number, oct: number, seed: number): number {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x * f, y * f, z * f, seed + i);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const DEEP: RGB = [18, 42, 82], SHALLOW: RGB = [46, 104, 148], SAND: RGB = [196, 178, 128];
const GRASS: RGB = [84, 122, 62], FOREST: RGB = [44, 82, 46], ROCK: RGB = [122, 106, 88], ICE: RGB = [232, 236, 240];

const px = Buffer.alloc(W * H * 3);
for (let j = 0; j < H; j++) {
  const lat = Math.PI / 2 - ((j + 0.5) / H) * Math.PI;
  const cl = Math.cos(lat), sl = Math.sin(lat);
  for (let i = 0; i < W; i++) {
    const lon = ((i + 0.5) / W) * Math.PI * 2 - Math.PI;
    const x = cl * Math.cos(lon), y = sl, z = cl * Math.sin(lon);
    const e = fbm(x * 1.6 + 7, y * 1.6 + 3, z * 1.6 + 11, 6, 17);
    const m = fbm(x * 3 + 2, y * 3 + 9, z * 3 + 5, 3, 91);
    const sea = 0.52;
    let c: RGB;
    if (e < sea) c = mix(DEEP, SHALLOW, Math.pow(e / sea, 3));
    else if (e < sea + 0.012) c = SAND;
    else {
      const h = (e - sea) / (1 - sea);
      c = mix(mix(GRASS, FOREST, m), ROCK, Math.min(1, Math.max(0, (h - 0.25) * 2.2)));
    }
    const polar = Math.abs(lat) / (Math.PI / 2);
    const iceT = Math.min(1, Math.max(0, (polar - 0.8 + (e - 0.5) * 0.25) * 9));
    c = mix(c, ICE, iceT);
    const o = (j * W + i) * 3;
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
  }
}

const paths = contentPaths();
mkdirSync(paths.incomingDir, { recursive: true });
const file = path.join(paths.incomingDir, "sample-world.png");
await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 6 }).toFile(file);
const meta = await processImage(file, { uploadedBy: "sample generator" });
console.log(`Sample map "${meta.id}" written:`, Object.values(meta.sizes).join(", "));
