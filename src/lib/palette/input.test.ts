import { describe, expect, it } from "vitest";
import { buildCandidates, candidatePath, joinRelative } from "./candidates";
import { parseGoto, parsePaletteInput, pushRecent } from "./input";

describe("parseGoto", () => {
  it("parses line and line:col", () => {
    expect(parseGoto(":12")).toEqual({ line: 12, col: null });
    expect(parseGoto(":12:4")).toEqual({ line: 12, col: 4 });
    expect(parseGoto(": 7 ")).toEqual({ line: 7, col: null });
  });

  it("rejects non-numeric, empty and zero", () => {
    expect(parseGoto(":abc")).toBeNull();
    expect(parseGoto(":")).toBeNull();
    expect(parseGoto(":12:")).toBeNull();
    expect(parseGoto(":12:x")).toBeNull();
    expect(parseGoto(":0")).toBeNull();
    expect(parseGoto(":3:0")).toBeNull();
    expect(parseGoto(":-3")).toBeNull();
    expect(parseGoto(":1:2:3")).toBeNull();
  });
});

describe("parsePaletteInput", () => {
  it("routes by leading character", () => {
    expect(parsePaletteInput(">save as")).toEqual({ mode: "command", query: "save as" });
    expect(parsePaletteInput(">")).toEqual({ mode: "command", query: "" });
    expect(parsePaletteInput(":12:4")).toEqual({ mode: "goto", text: "12:4", target: { line: 12, col: 4 } });
    expect(parsePaletteInput(":abc")).toEqual({ mode: "goto", text: "abc", target: null });
    expect(parsePaletteInput(" tab ")).toEqual({ mode: "file", query: "tab" });
    expect(parsePaletteInput("")).toEqual({ mode: "file", query: "" });
  });
});

describe("pushRecent", () => {
  it("moves to front, de-duplicates and caps", () => {
    expect(pushRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(pushRecent(["a", "b"], "z", 2)).toEqual(["z", "a"]);
  });
});

describe("file candidates", () => {
  it("lists open tabs first and drops their duplicates from the index", () => {
    const c = buildCandidates(
      "D:\\proj",
      ["src/a.ts", "src/b.ts"],
      [
        { id: 1, path: "D:\\proj\\src\\b.ts", title: "b.ts" },
        { id: 2, path: null, title: "Untitled-1" },
        { id: 3, path: "E:\\other\\x.md", title: "x.md" },
      ],
    );
    expect(c.map((x) => x.text)).toEqual(["src/b.ts", "Untitled-1", "E:\\other\\x.md", "src/a.ts"]);
    expect(c.map((x) => x.tabId)).toEqual([1, 2, 3, null]);
  });

  it("without a folder only tabs remain", () => {
    expect(buildCandidates(null, [], [{ id: 1, path: "C:\\a.txt", title: "a.txt" }]).map((x) => x.text)).toEqual(["C:\\a.txt"]);
  });

  it("joins relative paths with the root's separator", () => {
    expect(joinRelative("D:\\proj", "src/a.ts")).toBe("D:\\proj\\src\\a.ts");
    expect(joinRelative("/home/me/", "src/a.ts")).toBe("/home/me/src/a.ts");
    expect(candidatePath("D:\\proj", { text: "src/a.ts", abs: null, tabId: null })).toBe("D:\\proj\\src\\a.ts");
    expect(candidatePath(null, { text: "src/a.ts", abs: null, tabId: null })).toBeNull();
  });
});
