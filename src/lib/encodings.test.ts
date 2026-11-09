import { describe, expect, it } from "vitest";
import { encodingChoices, encodingLabel } from "./encodings";

describe("encodingLabel", () => {
  it("names every picker choice by its own label (round trip)", () => {
    for (const [label, c] of Object.entries(encodingChoices)) expect(encodingLabel(c.encoding, c.bom)).toBe(label);
  });

  it("detected UTF-16 with BOM shows the picker label, not 'UTF-16LE with BOM'", () => {
    expect(encodingLabel("utf-16le", true)).toBe("UTF-16 LE");
    expect(encodingLabel("utf-16be", true)).toBe("UTF-16 BE");
  });

  it("falls back to the upper-cased encoding for others", () => {
    expect(encodingLabel("shift_jis", false)).toBe("SHIFT_JIS");
    expect(encodingLabel("windows-1250", true)).toBe("WINDOWS-1250 with BOM");
  });

  it("never offers BOM-less UTF-16 (undetectable on reopen)", () => {
    for (const c of Object.values(encodingChoices)) if (c.encoding.startsWith("utf-16")) expect(c.bom).toBe(true);
  });
});
