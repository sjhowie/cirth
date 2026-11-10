/**
 * Tab and Shift+Tab in the editor. CodeMirror leaves Tab unbound by default (so keyboard users can leave the editor).
 * Tab with only carets inserts one indent at each caret: a tab character, or spaces up to the next indent stop.
 * Tab with a selection, and Shift+Tab always, indent or outdent the selected lines.
 */
import { countColumn, EditorSelection } from "@codemirror/state";
import type { Extension, StateCommand } from "@codemirror/state";
import { indentLess, indentMore } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { keymap } from "@codemirror/view";

export const insertIndent: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore({ state, dispatch });
  const unit = state.facet(indentUnit);
  const spaces = /^ +$/.test(unit) ? unit.length : 0;
  const tr = state.changeByRange((range) => {
    let insert = unit;
    if (spaces > 0) {
      const line = state.doc.lineAt(range.head);
      const col = countColumn(line.text.slice(0, range.head - line.from), state.tabSize);
      insert = " ".repeat(spaces - (col % spaces));
    }
    return { changes: { from: range.head, insert }, range: EditorSelection.cursor(range.head + insert.length) };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.indent" }));
  return true;
};

export function tabKey(): Extension {
  return keymap.of([{ key: "Tab", run: insertIndent, shift: indentLess, preventDefault: true }]);
}
