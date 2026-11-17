import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { nextVersion } from "./release.mjs";

describe("nextVersion", () => {
  it("bumps each part", () => {
    expect(nextVersion("0.1.9", "patch")).toBe("0.1.10");
    expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(nextVersion("0.9.3", "major")).toBe("1.0.0");
  });

  it("takes an explicit higher version", () => {
    expect(nextVersion("0.1.0", "0.2.0")).toBe("0.2.0");
    expect(nextVersion("0.1.0", "0.1.1")).toBe("0.1.1");
  });

  it("refuses a version that is not higher, and bad input", () => {
    expect(() => nextVersion("0.2.0", "0.2.0")).toThrow(/not above/);
    expect(() => nextVersion("0.2.0", "0.1.9")).toThrow(/not above/);
    expect(() => nextVersion("0.2.0", "1.0")).toThrow(/X.Y.Z/);
    expect(() => nextVersion("0.2.0", undefined)).toThrow(/X.Y.Z/);
  });
});
