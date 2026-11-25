import { describe, expect, it } from "vitest";
import { displayName, idFromName, nameFromId, randomId } from "../src/shared/region.ts";

describe("idFromName", () => {
  it("slugifies the name and keeps the id free", () => {
    expect(idFromName("Kingdom of Aerthos", new Set())).toBe("kingdom-of-aerthos");
    expect(idFromName("Kingdom of Aerthos", new Set(["kingdom-of-aerthos"]))).toBe("kingdom-of-aerthos-2");
    expect(idFromName("Café Éire!", new Set())).toBe("cafe-eire");
  });
  it("is random when the name has nothing usable", () => {
    for (const n of ["", "   ", "!!!"]) expect(idFromName(n, new Set())).toMatch(/^region-[a-z0-9]{6}$/);
  });
  it("never repeats a taken random id", () => {
    const seq = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    let i = 0;
    const first = `region-${"a".repeat(6)}`;
    expect(randomId("region", new Set([first]), () => seq[i++ % seq.length])).not.toBe(first);
  });
});

describe("display names", () => {
  it("keeps the typed capitals; old regions get their id made readable", () => {
    expect(displayName({ name: "  The North Reach " }, "north")).toBe("The North Reach");
    expect(displayName({}, "kindly-lords")).toBe("Kindly lords");
    expect(nameFromId("x")).toBe("X");
  });
});
