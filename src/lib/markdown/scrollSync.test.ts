import { describe, expect, it } from "vitest";
import { lineToTop, normalizeAnchors, topToLine, type Anchor } from "./scrollSync";

const anchors: Anchor[] = [
  { line: 0, top: 0 },
  { line: 10, top: 100 },
  { line: 20, top: 400 },
];

describe("scroll mapping", () => {
  it("hits anchors exactly and interpolates between them", () => {
    expect(lineToTop(anchors, 10, 40, 1000)).toBe(100);
    expect(lineToTop(anchors, 15, 40, 1000)).toBe(250);
    expect(topToLine(anchors, 250, 40, 1000)).toBe(15);
  });

  it("interpolates toward the end anchor after the last element", () => {
    expect(lineToTop(anchors, 30, 40, 1000)).toBe(700);
    expect(lineToTop(anchors, 40, 40, 1000)).toBe(1000);
    expect(topToLine(anchors, 1000, 40, 1000)).toBe(40);
  });

  it("clamps outside the range", () => {
    expect(lineToTop(anchors, -3, 40, 1000)).toBe(0);
    expect(lineToTop(anchors, 99, 40, 1000)).toBe(1000);
    expect(topToLine(anchors, 5000, 40, 1000)).toBe(40);
  });

  it("round-trips", () => {
    for (const line of [0, 3, 10, 12.5, 20, 33]) {
      expect(topToLine(anchors, lineToTop(anchors, line, 40, 1000), 40, 1000)).toBeCloseTo(line, 6);
    }
  });

  it("works with no anchors (empty document) without dividing by zero", () => {
    expect(Number.isFinite(lineToTop([], 3, 10, 500))).toBe(true);
    expect(Number.isFinite(topToLine([], 100, 10, 500))).toBe(true);
  });

  it("adds an implicit start anchor when the first element starts below line 0", () => {
    expect(lineToTop([{ line: 4, top: 80 }], 2, 10, 200)).toBe(40);
  });
});

describe("normalizeAnchors", () => {
  it("sorts, drops duplicate lines and non-monotonic tops", () => {
    const out = normalizeAnchors([
      { line: 5, top: 50 },
      { line: 0, top: 0 },
      { line: 5, top: 60 },
      { line: 8, top: 40 },
      { line: 9, top: 90 },
    ]);
    expect(out).toEqual([
      { line: 0, top: 0 },
      { line: 5, top: 50 },
      { line: 9, top: 90 },
    ]);
  });
});
