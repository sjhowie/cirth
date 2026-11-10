import { basicSetup } from "codemirror";
import { EditorView, lineNumbers, highlightActiveLine, drawSelection, keymap, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { columnSelect } from "./columnSelect";
import { tabKey } from "./tabKey";

/**
 * Light mode: for very large files (above the size threshold).
 * Nothing here parses, folds, wraps or decorates the whole document; every
 * extension only does work for the visible viewport or the current selection.
 * Deliberately excluded: language/syntax highlighting, foldGutter, lineWrapping,
 * bracketMatching, closeBrackets, autocompletion, indentOnInput, highlightSelectionMatches.
 */
export function lightModeExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    columnSelect(),
    tabKey(),
    history(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
  ];
}

/**
 * Full mode: for normal-sized files. CodeMirror's standard basicSetup
 * (line numbers, folding, bracket matching, autocomplete, selection matches, ...)
 * plus the given language extension (which brings syntax highlighting via its parser).
 */
export function fullModeExtensions(lang: Extension): Extension[] {
  return [
    basicSetup,
    columnSelect(),
    tabKey(),
    lang,
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
  ];
}
