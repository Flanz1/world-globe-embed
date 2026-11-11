import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentPaths } from "../scripts/lib/paths.ts";
import { joinParts, listIncoming } from "../scripts/lib/process.ts";

function setup(data: Buffer, size: number, manifest?: object, skip?: number) {
  const paths = contentPaths(mkdtempSync(path.join(tmpdir(), "wge-j-")));
  mkdirSync(paths.incomingDir, { recursive: true });
  const n = Math.ceil(data.length / size);
  for (let i = 0; i < n; i++)
    if (i !== skip) writeFileSync(path.join(paths.incomingDir, `map.jpg.part${String(i + 1).padStart(3, "0")}`), data.subarray(i * size, (i + 1) * size));
  const spec = manifest ?? { parts: n, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  writeFileSync(path.join(paths.incomingDir, "map.jpg.parts.json"), JSON.stringify(spec));
  return paths;
}

describe("joinParts", () => {
  const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

  it("joins the parts into the original file and removes them", () => {
    const paths = setup(data, 300);
    expect(listIncoming(paths)).toEqual([]);
    const { joined, errors } = joinParts(paths);
    expect(errors).toEqual([]);
    const out = path.join(paths.incomingDir, "map.jpg");
    expect(joined.get(out)).toBe(path.join(paths.incomingDir, "map.jpg.parts.json"));
    expect(readFileSync(out).equals(data)).toBe(true);
    expect(readdirSync(paths.incomingDir)).toEqual(["map.jpg"]);
    expect(listIncoming(paths)).toEqual([out]);
  });

  it("leaves an incomplete set alone and says which part is missing", () => {
    const paths = setup(data, 300, undefined, 1);
    const { joined, errors } = joinParts(paths);
    expect(joined.size).toBe(0);
    expect(errors[0]).toMatch(/map\.jpg\.part002 are missing/);
    expect(readdirSync(paths.incomingDir)).toHaveLength(4);
  });

  it("refuses parts that don't match the checksum", () => {
    const paths = setup(data, 300, { parts: 4, bytes: 1000, sha256: "0".repeat(64) });
    const { joined, errors } = joinParts(paths);
    expect(joined.size).toBe(0);
    expect(errors[0]).toMatch(/don't match/);
  });

  it("does nothing without an incoming folder", () => {
    expect(joinParts(contentPaths(mkdtempSync(path.join(tmpdir(), "wge-j-"))))).toEqual({ joined: new Map(), errors: [] });
  });
});
