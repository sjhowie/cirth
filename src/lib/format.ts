import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dispatchToTab, getTabDoc, getTabState, getView } from "./editorHost.svelte";
import { formatterKind } from "./editor/languages";
import { formatText, toAppError, type FormatMode } from "./ipc";
import { notifyError, reportError } from "./notifications.svelte";
import { settings } from "./settings.svelte";
import { tabsStore } from "./tabs.svelte";

/** Format Document / Minify for the active JSON or XML tab, as one undoable transaction. */
export async function formatActiveDocument(mode: FormatMode): Promise<void> {
  const tab = tabsStore.active;
  if (!tab) return;
  const kind = formatterKind(tab.languageName);
  if (!kind) {
    notifyError(`No formatter for ${tab.languageName}`);
    return;
  }
  const doc = getTabDoc(tab);
  let formatted: string;
  try {
    formatted = await formatText(kind, doc, mode, settings.indent);
  } catch (e) {
    const err = toAppError(e);
    if (err.kind === "parse") {
      const where = err.line !== undefined && err.col !== undefined ? ` (line ${err.line}, col ${err.col})` : "";
      notifyError(`${tab.languageName}: ${err.message}${where}`);
      console.error("format parse error", e);
      moveCursorTo(err.line, err.col);
    } else {
      reportError(`Format ${tab.languageName}`, e);
    }
    return;
  }
  const current = getTabDoc(tab);
  if (current !== doc) {
    notifyError("The document changed while formatting; run it again");
    return;
  }
  if (formatted === doc.toString()) return;
  const head = getTabState(tab).selection.main.head;
  dispatchToTab(tab, {
    changes: { from: 0, to: doc.length, insert: formatted },
    selection: EditorSelection.cursor(Math.min(head, formatted.length)),
    userEvent: "input.format",
  });
}

function moveCursorTo(line: number | undefined, col: number | undefined): void {
  const view = getView();
  if (!view || line === undefined) return;
  const doc = view.state.doc;
  const info = doc.line(Math.min(Math.max(1, line), doc.lines));
  const pos = Math.min(info.from + Math.max(0, (col ?? 1) - 1), info.to);
  view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  view.focus();
}
