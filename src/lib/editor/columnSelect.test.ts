import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { boxDown, boxField, boxLeft, boxLineEnd, boxLineStart, boxRight, boxUp, columnSelect } from "./columnSelect";

function make(doc: string, anchor: number, head = anchor, tabSize = 4): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [EditorState.allowMultipleSelections.of(true), EditorState.tabSize.of(tabSize), columnSelect()],
  });
}

type Cmd = (t: { state: EditorState; dispatch: (s: never) => void }) => boolean;
function press(state: EditorState, cmd: unknown, times = 1): EditorState {
  let s = state;
  for (let i = 0; i < times; i++) {
    (cmd as Cmd)({
      state: s,
      dispatch: ((spec: never) => {
        s = s.update(spec).state;
      }) as never,
    });
  }
  return s;
}
const ranges = (s: EditorState): [number, number][] => s.selection.ranges.map((r) => [r.anchor, r.head]);

describe("columnSelect", () => {
  // Line starts: 0, 8, 16, 24, 32
  const doc = "abcdefg\nabcdefg\nabcdefg\nabcdefg\nabcdefg";

  it("grows down 3 lines then right 2 columns", () => {
    let s = make(doc, 2); // line 1, col 2
    s = press(s, boxDown, 3);
    s = press(s, boxRight, 2);
    expect(ranges(s)).toEqual([
      [2, 4],
      [10, 12],
      [18, 20],
      [26, 28],
    ]);
    expect(s.selection.mainIndex).toBe(3);
  });

  it("clamps a short line but the next longer line gets the full column", () => {
    const d = "abcdefgh\nab\nabcdefgh";
    let s = make(d, 5); // line 1, col 5
    s = press(s, boxDown, 2);
    s = press(s, boxRight, 2);
    // line 1 [5,7]; line 2 (len 2, starts at 9) clamped to [11,11]; line 3 (starts at 12) full
    expect(ranges(s)).toEqual([
      [5, 7],
      [11, 11],
      [12 + 5, 12 + 7],
    ]);
    // Going up again over the short line keeps the original columns on the long one.
    s = press(s, boxUp, 1);
    expect(ranges(s)).toEqual([
      [5, 7],
      [11, 11],
    ]);
  });

  it("counts a tab as tab-size columns", () => {
    const d = "\tabcd\nxxxxxxxx";
    let s = make(d, 1); // after the tab: col 4
    s = press(s, boxDown, 1);
    s = press(s, boxRight, 2);
    // line 1: cols 4..6 = offsets 1..3; line 2: offsets 4..6 (+ line start 6)
    expect(ranges(s)).toEqual([
      [1, 3],
      [6 + 4, 6 + 6],
    ]);
  });

  it("shrinking back up removes ranges", () => {
    let s = make(doc, 2);
    s = press(s, boxDown, 3);
    expect(s.selection.ranges.length).toBe(4);
    s = press(s, boxUp, 2);
    expect(ranges(s)).toEqual([
      [2, 2],
      [10, 10],
    ]);
    s = press(s, boxUp, 1);
    expect(s.selection.ranges.length).toBe(1);
    // Crossing above the anchor flips the box.
    s = press(s, boxUp, 1);
    expect(s.selection.ranges.length).toBe(1);
  });

  it("flips above the anchor line", () => {
    let s = make(doc, 18); // line 3 col 2
    s = press(s, boxUp, 2);
    expect(ranges(s)).toEqual([
      [2, 2],
      [10, 10],
      [18, 18],
    ]);
    expect(s.selection.mainIndex).toBe(0);
  });

  it("Left cannot go below column 0 and Home/End jump the head column", () => {
    let s = make(doc, 2);
    s = press(s, boxDown, 1);
    s = press(s, boxLeft, 5);
    expect(ranges(s)).toEqual([
      [2, 0],
      [10, 8],
    ]);
    s = press(s, boxLineEnd);
    expect(ranges(s)).toEqual([
      [2, 7],
      [10, 15],
    ]);
    s = press(s, boxLineStart);
    expect(ranges(s)).toEqual([
      [2, 0],
      [10, 8],
    ]);
  });

  it("a non-box selection change resets the anchor", () => {
    let s = make(doc, 2);
    s = press(s, boxDown, 2);
    expect(s.field(boxField)).not.toBeNull();
    s = s.update({ selection: EditorSelection.cursor(10) }).state; // line 2 col 3
    expect(s.field(boxField)).toBeNull();
    s = press(s, boxDown, 1);
    expect(ranges(s)).toEqual([
      [10, 10],
      [18, 18],
    ]);
  });

  it("a zero-width box inserts on every line", () => {
    let s = make(doc, 3);
    s = press(s, boxDown, 3);
    expect(s.selection.ranges.every((r) => r.empty)).toBe(true);
    s = s.update(
      s.changeByRange((r) => ({ changes: { from: r.from, insert: "X" }, range: EditorSelection.cursor(r.from + 1) })),
    ).state;
    expect(s.doc.toString()).toBe("abcXdefg\nabcXdefg\nabcXdefg\nabcXdefg\nabcdefg");
  });

  it("clamps at the first and last line", () => {
    let s = make(doc, 2);
    s = press(s, boxUp, 3);
    expect(s.selection.ranges.length).toBe(1);
    s = press(s, boxDown, 20);
    expect(s.selection.ranges.length).toBe(5);
  });
});
