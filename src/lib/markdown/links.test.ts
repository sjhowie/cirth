import { describe, expect, it } from "vitest";
import { isExternalRef, resolveRelativePath, slugify, splitRef } from "./links";

describe("resolveRelativePath", () => {
  it("joins with the directory's separator style", () => {
    expect(resolveRelativePath("D:\\a\\b", "c/d.png")).toBe("D:\\a\\b\\c\\d.png");
    expect(resolveRelativePath("/a/b", "c/d.png")).toBe("/a/b/c/d.png");
  });

  it("handles spaces, .. and . segments", () => {
    expect(resolveRelativePath("D:\\a\\b", "../x y/./z%20w.md")).toBe("D:\\a\\x y\\z w.md");
  });

  it("never climbs above the drive or root", () => {
    expect(resolveRelativePath("D:\\a", "../../../x.md")).toBe("D:\\x.md");
    expect(resolveRelativePath("/a", "../../x.md")).toBe("/x.md");
  });

  it("keeps a UNC root", () => {
    expect(resolveRelativePath("\\\\srv\\share\\d", "x.md")).toBe("\\\\srv\\share\\d\\x.md");
  });

  it("treats rooted and drive references as absolute", () => {
    expect(resolveRelativePath("D:\\a\\b", "/x/y.md")).toBe("D:\\x\\y.md");
    expect(resolveRelativePath("D:\\a\\b", "C:\\x\\..\\y.md")).toBe("C:\\y.md");
  });

  it("returns null for external refs, empty refs and missing directories", () => {
    expect(resolveRelativePath("D:\\a", "https://x.com/a.png")).toBeNull();
    expect(resolveRelativePath("D:\\a", "")).toBeNull();
    expect(resolveRelativePath(null, "a.png")).toBeNull();
  });

  it("falls back to the literal text on a malformed escape", () => {
    expect(resolveRelativePath("D:\\a", "100%.png")).toBe("D:\\a\\100%.png");
  });
});

describe("refs", () => {
  it("tells schemes from drive letters", () => {
    expect(isExternalRef("https://x")).toBe(true);
    expect(isExternalRef("mailto:a@b")).toBe(true);
    expect(isExternalRef("//cdn/x.png")).toBe(true);
    expect(isExternalRef("C:\\x.png")).toBe(false);
    expect(isExternalRef("img/a.png")).toBe(false);
  });

  it("splits path, query and hash", () => {
    expect(splitRef("a/b.md?x=1#sec")).toEqual({ path: "a/b.md", hash: "sec" });
    expect(splitRef("#only")).toEqual({ path: "", hash: "only" });
  });

  it("slugifies headings like GitHub", () => {
    expect(slugify("Hello, World! 2")).toBe("hello-world-2");
    expect(slugify("  Under_score-dash ")).toBe("under_score-dash");
  });
});
