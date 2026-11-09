import { describe, expect, it } from "vitest";
import type { SearchDonePayload, SearchResultPayload } from "../ipc";
import { locateMatch, planReplace, relativeTo, SearchResults, splitPreview, summaryText } from "./results";

const result = (searchId: string, path: string, n = 1): SearchResultPayload => ({
  searchId,
  path,
  items: Array.from({ length: n }, (_, i) => ({ line: i + 1, col: 1, preview: "foo", matchLen: 3 })),
});
const done = (searchId: string, over: Partial<SearchDonePayload> = {}): SearchDonePayload => ({
  searchId,
  files: 0,
  matches: 0,
  truncated: false,
  cancelled: false,
  ...over,
});

describe("SearchResults", () => {
  it("groups items per file in arrival order and counts matches", () => {
    const r = new SearchResults("s1");
    expect(r.addResult(result("s1", "D:\\p\\a.ts", 2))).toBe(true);
    expect(r.addResult(result("s1", "D:\\p\\b.ts", 1))).toBe(true);
    expect(r.addResult(result("s1", "D:\\p\\a.ts", 3))).toBe(true); // same file again: merged
    expect(r.files.map((f) => [f.path, f.items.length])).toEqual([
      ["D:\\p\\a.ts", 5],
      ["D:\\p\\b.ts", 1],
    ]);
    expect(r.matches).toBe(6);
  });

  it("ignores events from stale searchIds", () => {
    const r = new SearchResults("new");
    expect(r.addResult(result("old", "a.ts", 4))).toBe(false);
    expect(r.finish(done("old"))).toBe(false);
    expect(r.files).toHaveLength(0);
    expect(r.matches).toBe(0);
    expect(r.finished).toBe(false);
    expect(r.addResult(result("new", "a.ts"))).toBe(true);
    expect(r.finish(done("new", { files: 1, matches: 1 }))).toBe(true);
    expect(r.finished).toBe(true);
  });

  it("replays an interleaved stream of two searches correctly", () => {
    // search 1 is superseded by search 2; late events of 1 must not leak into 2.
    const events: (SearchResultPayload | SearchDonePayload)[] = [
      result("s1", "x.ts"),
      result("s2", "y.ts"),
      result("s1", "z.ts"),
      done("s1", { cancelled: true }),
      result("s2", "w.ts", 2),
      done("s2", { files: 2, matches: 3 }),
    ];
    const r = new SearchResults("s2");
    for (const e of events) {
      if ("items" in e) r.addResult(e);
      else r.finish(e);
    }
    expect(r.files.map((f) => f.path)).toEqual(["y.ts", "w.ts"]);
    expect(r.matches).toBe(3);
    expect(r.done?.cancelled).toBe(false);
  });

  it("rejects results after done", () => {
    const r = new SearchResults("s");
    r.finish(done("s"));
    expect(r.addResult(result("s", "a.ts"))).toBe(false);
  });
});

describe("summaryText", () => {
  it("formats counts, truncated and cancelled", () => {
    const r = new SearchResults("s");
    r.addResult(result("s", "a.ts", 2));
    expect(summaryText(r)).toBe("2 results in 1 file");
    r.finish(done("s", { truncated: true }));
    expect(summaryText(r)).toBe("2 results in 1 file (truncated)");
    const c = new SearchResults("c");
    c.finish(done("c", { cancelled: true }));
    expect(summaryText(c)).toBe("0 results in 0 files Cancelled");
  });
});

describe("planReplace", () => {
  it("skips files with unsaved changes and counts the rest", () => {
    const r = new SearchResults("s");
    r.addResult(result("s", "a.ts", 2));
    r.addResult(result("s", "b.ts", 3));
    r.addResult(result("s", "c.ts", 1));
    const plan = planReplace(r, (p) => p === "b.ts");
    expect(plan).toEqual({ paths: ["a.ts", "c.ts"], occurrences: 3, skipped: ["b.ts"] });
  });
});

describe("relativeTo", () => {
  it("strips the root (any separator, any case) and normalises slashes", () => {
    expect(relativeTo("D:\\proj", "D:\\proj\\src\\a.ts")).toBe("src/a.ts");
    expect(relativeTo("D:\\proj\\", "d:\\PROJ\\src\\a.ts")).toBe("src/a.ts");
    expect(relativeTo("/home/me", "/home/me/x.txt")).toBe("x.txt");
    expect(relativeTo("D:\\proj", "E:\\other\\a.ts")).toBe("E:/other/a.ts");
  });
});

describe("splitPreview / locateMatch", () => {
  it("splits by code points", () => {
    expect(splitPreview("a\u{1F600}bcd", 3, 2)).toEqual({ before: "a\u{1F600}", match: "bc", after: "d" });
    expect(splitPreview("abc", 99, 5)).toEqual({ before: "abc", match: "", after: "" });
  });

  it("maps the preview column onto the full line (trimmed indentation)", () => {
    const line = "    hello world, hello!";
    // second 'hello' at preview col 14 of "hello world, hello!"
    expect(locateMatch(line, { line: 1, col: 14, preview: "hello world, hello!", matchLen: 5 })).toEqual({ col: 18, len: 5 });
  });

  it("counts UTF-16 units for the editor when astral characters precede the match", () => {
    const line = "\u{1F600} target";
    // preview col is in code points: emoji(1) + space(1) -> col 3
    expect(locateMatch(line, { line: 1, col: 3, preview: line, matchLen: 6 })).toEqual({ col: 4, len: 6 });
  });

  it("falls back to the matched text when the line changed, null when gone", () => {
    expect(locateMatch("edited: needle here", { line: 1, col: 1, preview: "needle", matchLen: 6 })).toEqual({ col: 9, len: 6 });
    expect(locateMatch("nothing", { line: 1, col: 1, preview: "needle", matchLen: 6 })).toBeNull();
  });
});
