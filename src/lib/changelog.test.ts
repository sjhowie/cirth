import { describe, expect, it } from "vitest";
import realChangelog from "../../CHANGELOG.md?raw";
import { formatReleaseDate, parseChangelog, renderInline, shouldShowWhatsNew, visibleReleases } from "./changelog";

const SAMPLE = [
  "# Changelog",
  "Intro line.",
  "",
  "## Unreleased",
  "### Fixed",
  "- Fixed a thing.",
  "### New",
  "- Added `Ctrl+K`.",
  "",
  "## 0.2.1 - 2026-11-17",
  "### Fixed",
  "- Fixed one.",
  "- Fixed two.",
  "",
  "## 0.2.0 - 2026-11-10",
  "### Improved",
  "- Changed it.",
].join("\r\n");

describe("parseChangelog", () => {
  it("keeps release order and normalizes section order", () => {
    const r = parseChangelog(SAMPLE);
    expect(r.map((x) => x.version)).toEqual([null, "0.2.1", "0.2.0"]);
    expect(r[0].sections.map((s) => s.label)).toEqual(["NEW", "FIXED"]);
    expect(r[0].sections[0].items).toEqual(["Added <code>Ctrl+K</code>."]);
    expect(r[1]).toEqual({ version: "0.2.1", date: "2026-11-17", sections: [{ kind: "fixed", label: "FIXED", items: ["Fixed one.", "Fixed two."] }] });
    expect(r[2].sections.map((s) => s.kind)).toEqual(["improved"]);
  });

  it("handles missing sections and drops empty releases", () => {
    const r = parseChangelog("# Changelog\n## Unreleased\n## 1.0.0 - 2026-01-02\n### New\n- Added x.\n## 0.9.0 - 2025-12-01\n");
    expect(r).toEqual([{ version: "1.0.0", date: "2026-01-02", sections: [{ kind: "new", label: "NEW", items: ["Added x."] }] }]);
  });

  it("moves Unreleased to the top and hides it outside dev builds", () => {
    const r = parseChangelog("## 1.0.0 - 2026-01-02\n### New\n- a\n## Unreleased\n### Fixed\n- b\n");
    expect(r.map((x) => x.version)).toEqual([null, "1.0.0"]);
    expect(visibleReleases(r, false).map((x) => x.version)).toEqual(["1.0.0"]);
    expect(visibleReleases(r, true).map((x) => x.version)).toEqual([null, "1.0.0"]);
  });

  it("escapes HTML in items, including inside code", () => {
    const r = parseChangelog("## 1.0.0 - 2026-01-02\n### Fixed\n- <img src=x onerror=alert(1)> & `<b>\"'`\n");
    expect(r[0].sections[0].items[0]).toBe("&lt;img src=x onerror=alert(1)&gt; &amp; <code>&lt;b&gt;&quot;&#39;</code>");
  });

  it("ignores malformed and unknown lines safely", () => {
    const md = [
      "- orphan item before any release",
      "## not a version",
      "### New",
      "- under an unknown heading",
      "## 1.0.0 - 2026-01-02",
      "- item before any section",
      "### Breaking",
      "- under an unknown section",
      "### New",
      "-no space",
      "- ",
      "plain text",
      "- kept",
      "## 1.0.0-beta.1",
      "### Fixed",
      "- beta fix",
    ].join("\n");
    const r = parseChangelog(md);
    expect(r).toEqual([
      { version: "1.0.0", date: "2026-01-02", sections: [{ kind: "new", label: "NEW", items: ["kept"] }] },
      { version: "1.0.0-beta.1", date: null, sections: [{ kind: "fixed", label: "FIXED", items: ["beta fix"] }] },
    ]);
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("\u0000\u0001 garbage ``` ##")).toEqual([]);
  });

  it("parses the real CHANGELOG.md", () => {
    const r = parseChangelog(realChangelog);
    const released = visibleReleases(r, false);
    // Not pinned to the newest versions: every release adds one at the top.
    const cmp = (a: string, b: string): number => {
      const [x, y] = [a, b].map((v) => v.split(".").map(Number));
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    };
    const versions = released.map((x) => x.version ?? "");
    expect(versions.every((v, i) => i === 0 || cmp(versions[i - 1], v) > 0)).toBe(true);
    expect(released.map((x) => x.version)).toEqual(expect.arrayContaining(["0.2.1", "0.2.0"]));
    expect(released.every((x) => x.date !== null)).toBe(true);
    expect(r.find((x) => x.version === "0.2.0")?.sections.map((s) => s.label)).toEqual(["NEW", "FIXED"]);
  });
});

describe("renderInline", () => {
  it("leaves an unpaired backtick literal", () => {
    expect(renderInline("a `b` c `d")).toBe("a <code>b</code> c `d");
    expect(renderInline("``")).toBe("<code></code>");
  });
});

describe("formatReleaseDate", () => {
  it("formats ISO dates and passes others through", () => {
    expect(formatReleaseDate("2026-11-17")).toBe("November 17, 2026");
    expect(formatReleaseDate("2026-01-05")).toBe("January 5, 2026");
    expect(formatReleaseDate("2026-13-01")).toBe("2026-13-01");
    expect(formatReleaseDate("soon")).toBe("soon");
  });
});

describe("shouldShowWhatsNew", () => {
  it("shows once after a version change in release builds only", () => {
    expect(shouldShowWhatsNew("0.2.1", "0.2.0", false)).toBe(true);
    expect(shouldShowWhatsNew("0.2.1", "0.2.1", false)).toBe(false);
    expect(shouldShowWhatsNew("0.2.1", null, false)).toBe(false);
    expect(shouldShowWhatsNew("0.2.1", "0.2.0", true)).toBe(false);
    expect(shouldShowWhatsNew("", "0.2.0", false)).toBe(false);
  });
});
