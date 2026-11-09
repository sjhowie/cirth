import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { isDocDirty, splitLines } from "./dirty";

describe("isDocDirty", () => {
  const saved = Text.of(["hello", "world"]);

  it("same instance is clean", () => {
    expect(isDocDirty(saved, saved)).toBe(false);
  });

  it("equal content in a different instance is clean", () => {
    expect(isDocDirty(Text.of(["hello", "world"]), saved)).toBe(false);
  });

  it("different length is dirty", () => {
    expect(isDocDirty(Text.of(["hello", "world!"]), saved)).toBe(true);
  });

  it("same length, different content is dirty", () => {
    expect(isDocDirty(Text.of(["hellO", "world"]), saved)).toBe(true);
  });

  it("edit then undo back to saved content is clean", () => {
    const edited = saved.replace(0, 1, Text.of(["J"]));
    expect(isDocDirty(edited, saved)).toBe(true);
    expect(isDocDirty(edited.replace(0, 1, Text.of(["h"])), saved)).toBe(false);
  });

  it("empty docs are clean", () => {
    expect(isDocDirty(Text.of([""]), Text.of([""]))).toBe(false);
  });
});

describe("splitLines", () => {
  it("normalises CRLF, CR and LF", () => {
    expect(splitLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
    expect(splitLines("")).toEqual([""]);
  });
});
