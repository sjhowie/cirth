import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { insertIndent } from "./tabKey";

function make(doc: string, ranges: [number, number][], unit: string): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h))),
    extensions: [EditorState.allowMultipleSelections.of(true), EditorState.tabSize.of(4), indentUnit.of(unit)],
  });
}

function tab(state: EditorState): EditorState {
  let s = state;
  const handled = insertIndent({ state, dispatch: (tr: Transaction) => (s = tr.state) });
  expect(handled).toBe(true);
  return s;
}

describe("insertIndent (Tab)", () => {
  it("inserts a tab character at the caret with tab indent", () => {
    const s = tab(make("abcd", [[2, 2]], "\t"));
    expect(s.doc.toString()).toBe("ab\tcd");
    expect(s.selection.main.head).toBe(3);
  });

  it("inserts spaces up to the next indent stop with space indent", () => {
    expect(tab(make("abcd", [[0, 0]], "  ")).doc.toString()).toBe("  abcd");
    expect(tab(make("abcd", [[1, 1]], "    ")).doc.toString()).toBe("a   bcd");
    expect(tab(make("abcd", [[4, 4]], "    ")).doc.toString()).toBe("abcd    ");
  });

  it("counts a tab before the caret by the tab size", () => {
    // "\tx" caret after x: column 5, so 3 spaces reach column 8.
    expect(tab(make("\tx", [[2, 2]], "    ")).doc.toString()).toBe("\tx   ");
  });

  it("inserts at every caret of a multi-caret (box) selection", () => {
    const s = tab(make("ab\nab\nab", [[1, 1], [4, 4], [7, 7]], "\t"));
    expect(s.doc.toString()).toBe("a\tb\na\tb\na\tb");
    expect(s.selection.ranges.map((r) => r.head)).toEqual([2, 6, 10]);
  });

  it("indents the selected lines when text is selected", () => {
    const s = tab(make("ab\ncd", [[0, 4]], "  "));
    expect(s.doc.toString()).toBe("  ab\n  cd");
  });

  it("does nothing in a read-only state", () => {
    const state = EditorState.create({ doc: "x", extensions: [EditorState.readOnly.of(true)] });
    expect(insertIndent({ state, dispatch: () => {} })).toBe(false);
  });
});
