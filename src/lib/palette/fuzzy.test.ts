import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch, highlightSegments } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "src/foo/TabBar.svelte", { path: true })).toBeNull();
    expect(fuzzyMatch("ba", "ab")).toBeNull();
  });

  it("is case-insensitive and returns exact indices", () => {
    const m = fuzzyMatch("TB", "src/foo/tabBar.ts", { path: true });
    expect(m).not.toBeNull();
    const text = "src/foo/tabBar.ts";
    expect(m!.indices.map((i) => text[i].toLowerCase()).join("")).toBe("tb");
    expect(m!.indices).toEqual([8, 11]); // t of tab, B of Bar
  });

  it("indices are ascending and one per query char", () => {
    const m = fuzzyMatch("abc", "a_b_c")!;
    expect(m.indices).toEqual([0, 2, 4]);
  });

  it("ranks ftb: src/foo/TabBar.svelte above src/fit/ab.ts", () => {
    const ranked = fuzzyFilter(["src/fit/ab.ts", "src/foo/TabBar.svelte"], "ftb", (s) => s, { path: true });
    expect(ranked.map((r) => r.item)).toEqual(["src/foo/TabBar.svelte", "src/fit/ab.ts"]);
  });

  it("prefers a basename match over the same letters spread over directories", () => {
    const ranked = fuzzyFilter(["tab/x/y.ts", "a/b/Tab.ts"], "tab", (s) => s, { path: true });
    expect(ranked[0].item).toBe("a/b/Tab.ts");
    expect(ranked[0].indices).toEqual([4, 5, 6]);
  });

  it("rewards consecutive characters and word starts", () => {
    const consecutive = fuzzyMatch("edit", "editor.ts")!;
    const scattered = fuzzyMatch("edit", "e_d_i_t.ts")!;
    expect(consecutive.score).toBeGreaterThan(scattered.score);
    const wordStart = fuzzyMatch("fb", "foo_bar")!;
    const midWord = fuzzyMatch("fb", "fabulous")!;
    expect(wordStart.score).toBeGreaterThan(midWord.score);
    const camel = fuzzyMatch("gl", "goToLine")!;
    expect(camel.indices).toEqual([0, 4]);
  });

  it("handles backslash paths", () => {
    const m = fuzzyMatch("tb", "src\\ui\\TabBar.svelte", { path: true })!;
    expect(m.indices).toEqual([7, 10]);
  });

  it("empty query matches everything with no indices", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });

  it("applies boost and limit", () => {
    const items = ["a/one.ts", "b/one.ts", "c/one.ts"];
    const ranked = fuzzyFilter(items, "one", (s) => s, { path: true, limit: 2, boost: (s) => (s.startsWith("c") ? 10 : 0) });
    expect(ranked).toHaveLength(2);
    expect(ranked[0].item).toBe("c/one.ts");
  });
});

describe("highlightSegments", () => {
  it("returns no segments for empty text", () => {
    expect(highlightSegments("", [0, 1])).toEqual([]);
  });

  it("splits text into hit / non-hit runs", () => {
    expect(highlightSegments("abcde", [1, 2, 4])).toEqual([
      { text: "a", hit: false },
      { text: "bc", hit: true },
      { text: "d", hit: false },
      { text: "e", hit: true },
    ]);
    // indices relative to a larger target: the text starts at offset 3
    expect(highlightSegments("abc", [3, 5], 3)).toEqual([
      { text: "a", hit: true },
      { text: "b", hit: false },
      { text: "c", hit: true },
    ]);
  });
});

describe("performance", () => {
  function fakePaths(count: number): string[] {
    const dirs = ["src", "lib", "components", "routes", "tests", "docs", "node_modules", "static", "build", "utils"];
    const names = ["TabBar", "Editor", "Explorer", "foo", "index", "main", "helpers", "settings", "palette", "search"];
    const exts = [".ts", ".svelte", ".css", ".md", ".json", ".rs"];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const d1 = dirs[i % dirs.length];
      const d2 = dirs[(i * 7 + 3) % dirs.length];
      const d3 = `pkg${i % 313}`;
      out.push(`${d1}/${d2}/${d3}/${names[(i * 3) % names.length]}${i}${exts[i % exts.length]}`);
    }
    return out;
  }

  it("filters 50 000 paths in under 50 ms per keystroke", () => {
    const paths = fakePaths(50_000);
    const queries = ["ftb", "tb", "tbar", "edit", "srcsvelte", "e", "s", "palsea"];
    fuzzyFilter(paths, "warm", (s) => s, { path: true, limit: 200 }); // JIT warm-up
    for (const q of queries) {
      // Best of 3 so a GC pause on a busy machine does not fail the test.
      let ms = Infinity;
      let res = fuzzyFilter(paths, q, (s) => s, { path: true, limit: 200 });
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        res = fuzzyFilter(paths, q, (s) => s, { path: true, limit: 200 });
        ms = Math.min(ms, performance.now() - t0);
      }
      console.info(`fuzzy "${q}": ${res.length} results, ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(50);
    }
  });
});
