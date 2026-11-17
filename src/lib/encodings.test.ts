import { describe, expect, it } from "vitest";
import { encodingChoices, encodingLabel, eolChoices, eolFromLabel, eolLabel, lossyLabel } from "./encodings";

describe("EOL choices", () => {
  it("offers LF, CRLF and CR, and each label round-trips", () => {
    expect(Object.keys(eolChoices)).toEqual(["LF", "CRLF", "CR"]);
    for (const [label, eol] of Object.entries(eolChoices)) {
      expect(eolLabel(eol)).toBe(label);
      expect(eolFromLabel(label)).toBe(eol);
    }
  });

  it("returns null for an unknown label", () => {
    expect(eolFromLabel("LFCR")).toBeNull();
  });
});

describe("lossyLabel", () => {
  it("names the encoding a lossy read failed, and is null for a clean read", () => {
    expect(lossyLabel({ lossy: true, encoding: "utf-8", bom: true })).toBe("UTF-8 with BOM");
    expect(lossyLabel({ lossy: false, encoding: "utf-8", bom: true })).toBeNull();
  });
});

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
