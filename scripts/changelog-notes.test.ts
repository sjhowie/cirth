import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { notesFor, stampUnreleased, unreleasedItemCount, localDate } from "./changelog-notes.mjs";

const log = [
  "# Changelog",
  "Notable changes.",
  "## Unreleased",
  "### New",
  "- Added `thing`",
  "### Fixed",
  "- A bug",
  "## 0.2.1 - 2026-11-17",
  "### Fixed",
  "- Older fix",
  "## 0.2.0 - 2026-11-01",
  "### New",
  "- First",
  "",
].join("\n");

describe("unreleasedItemCount", () => {
  it("counts bullets under Unreleased only", () => {
    expect(unreleasedItemCount(log)).toBe(2);
  });
  it("is 0 when the section is missing or has no bullets", () => {
    expect(unreleasedItemCount("# Changelog\n## 0.2.1 - 2026-11-17\n- x\n")).toBe(0);
    expect(unreleasedItemCount("# Changelog\n## Unreleased\n### New\n## 0.2.1 - 2026-11-17\n- x\n")).toBe(0);
  });
});

describe("notesFor", () => {
  it("returns that version's sections", () => {
    expect(notesFor(log, "0.2.1")).toBe("### Fixed\n- Older fix");
    expect(notesFor(log, "0.2.0")).toBe("### New\n- First");
  });
  it("is null for a missing version, a prefix of one, or an empty entry", () => {
    expect(notesFor(log, "0.3.0")).toBeNull();
    expect(notesFor(log, "0.2")).toBeNull();
    expect(notesFor("## 0.2.1 - 2026-11-17\n\n## 0.2.0 - x\n- y\n", "0.2.1")).toBeNull();
  });
  it("handles CRLF", () => {
    expect(notesFor(log.replace(/\n/g, "\r\n"), "0.2.1")).toBe("### Fixed\n- Older fix");
  });
});

describe("stampUnreleased", () => {
  it("renames the heading and leaves the rest alone", () => {
    const out = stampUnreleased(log, "0.3.0", "2026-12-01");
    expect(out).toBe(log.replace("## Unreleased", "## 0.3.0 - 2026-12-01"));
    expect(unreleasedItemCount(out)).toBe(0);
    expect(notesFor(out, "0.3.0")).toBe("### New\n- Added `thing`\n### Fixed\n- A bug");
  });
  it("keeps CRLF line endings", () => {
    const crlf = log.replace(/\n/g, "\r\n");
    expect(stampUnreleased(crlf, "0.3.0", "2026-12-01")).toBe(crlf.replace("## Unreleased", "## 0.3.0 - 2026-12-01"));
  });
  it("refuses a missing or empty Unreleased and a version that already exists", () => {
    expect(() => stampUnreleased("# Changelog\n## 0.2.1 - 2026-11-17\n- x\n", "0.3.0", "2026-12-01")).toThrow(/Unreleased/);
    expect(() => stampUnreleased("## Unreleased\n### New\n## 0.2.1 - d\n- x\n", "0.3.0", "2026-12-01")).toThrow(/Unreleased/);
    expect(() => stampUnreleased(log, "0.2.1", "2026-12-01")).toThrow(/already has an entry/);
  });
});

describe("localDate", () => {
  it("formats the local date as YYYY-MM-DD", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
