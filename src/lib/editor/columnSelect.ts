/**
 * Visual Studio-style box (column) selection from the keyboard and Shift+Alt+click.
 *
 * The box is kept as a fixed anchor (line + visual column) and a moving head (line + visual column).
 * Columns are visual (tabs expand to the tab size) and the head column is virtual: it may be past the
 * end of a short line, so passing a short line and coming back to a longer one keeps the original column.
 * CodeMirror has no virtual space, so each range is clamped to its line's length.
 * Any selection or document change that did not come from this module drops the box.
 */
import { countColumn, EditorSelection, EditorState, findColumn, Prec, StateEffect, StateField } from "@codemirror/state";
import type { Extension, SelectionRange, TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

export interface Box {
  anchorLine: number;
  anchorCol: number;
  headLine: number;
  headCol: number;
}

const setBox = StateEffect.define<Box | null>();

/** The current keyboard/click box, or null when the selection is not one this module made. */
export const boxField = StateField.define<Box | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBox)) return e.value;
    return tr.selection || tr.docChanged ? null : value;
  },
});

function columnOf(state: EditorState, lineNumber: number, pos: number): number {
  const line = state.doc.line(lineNumber);
  return countColumn(line.text.slice(0, pos - line.from), state.tabSize);
}

/** The box the next press starts from: the live one, or the main range of the current selection. */
function currentBox(state: EditorState): Box {
  const existing = state.field(boxField, false);
  if (existing) return existing;
  const { anchor, head } = state.selection.main;
  const anchorLine = state.doc.lineAt(anchor).number;
  const headLine = state.doc.lineAt(head).number;
  return { anchorLine, anchorCol: columnOf(state, anchorLine, anchor), headLine, headCol: columnOf(state, headLine, head) };
}

/** One range per line between the anchor and head lines, clamped to each line. */
export function boxRanges(state: EditorState, box: Box): { ranges: SelectionRange[]; main: number } {
  const first = Math.min(box.anchorLine, box.headLine);
  const last = Math.max(box.anchorLine, box.headLine);
  const ranges: SelectionRange[] = [];
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    const a = findColumn(line.text, box.anchorCol, state.tabSize);
    const h = findColumn(line.text, box.headCol, state.tabSize);
    ranges.push(EditorSelection.range(line.from + a, line.from + h));
  }
  return { ranges, main: box.headLine - first };
}

/** A transaction spec that selects `box` and remembers it. */
export function boxSpec(state: EditorState, box: Box): TransactionSpec {
  const { ranges, main } = boxRanges(state, box);
  return { selection: EditorSelection.create(ranges, main), effects: setBox.of(box), scrollIntoView: true, userEvent: "select" };
}

type Target = { state: EditorState; dispatch: (spec: TransactionSpec) => void };

/** Moves the box head by whole lines/columns, or to an absolute column (`toCol`, or "end" for the line end). */
export function moveBoxHead(target: Target, dLine: number, dCol: number, toCol?: number | "end"): boolean {
  const { state } = target;
  const box = currentBox(state);
  const headLine = Math.min(state.doc.lines, Math.max(1, box.headLine + dLine));
  let headCol = box.headCol + dCol;
  if (toCol === "end") {
    const line = state.doc.line(headLine);
    headCol = countColumn(line.text, state.tabSize);
  } else if (toCol !== undefined) {
    headCol = toCol;
  }
  target.dispatch(boxSpec(state, { ...box, headLine, headCol: Math.max(0, headCol) }));
  return true;
}

export const boxUp = (t: Target): boolean => moveBoxHead(t, -1, 0);
export const boxDown = (t: Target): boolean => moveBoxHead(t, 1, 0);
export const boxLeft = (t: Target): boolean => moveBoxHead(t, 0, -1);
export const boxRight = (t: Target): boolean => moveBoxHead(t, 0, 1);
export const boxLineStart = (t: Target): boolean => moveBoxHead(t, 0, 0, 0);
export const boxLineEnd = (t: Target): boolean => moveBoxHead(t, 0, 0, "end");

function pageLines(view: EditorView): number {
  return Math.max(1, Math.floor(view.dom.clientHeight / view.defaultLineHeight) - 1);
}
const boxPageUp = (view: EditorView): boolean => moveBoxHead(view, -pageLines(view), 0);
const boxPageDown = (view: EditorView): boolean => moveBoxHead(view, pageLines(view), 0);

/** Shift+Alt+click: extend a box from the current caret/box anchor to the clicked position. */
function onShiftAltClick(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0 || !event.shiftKey || !event.altKey) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  if (pos === null) return false;
  const line = view.state.doc.lineAt(pos);
  let col = columnOf(view.state, line.number, pos);
  // Clicking right of the line end: extend by whole characters (exact for monospace fonts).
  const end = pos === line.to ? view.coordsAtPos(line.to) : null;
  if (end && event.clientX > end.right) col += Math.round((event.clientX - end.right) / view.defaultCharacterWidth);
  const box = currentBox(view.state);
  view.dispatch(boxSpec(view.state, { ...box, headLine: line.number, headCol: col }));
  event.preventDefault();
  return true;
}

/**
 * Keyboard + Shift+Alt+click box selection. Highest precedence so these keys win over
 * the default keymap's copy-line (Shift-Alt-Up/Down) and syntax selection (Shift-Alt-Left/Right).
 */
export function columnSelect(): Extension {
  return [
    boxField,
    Prec.highest(
      keymap.of([
        { key: "Shift-Alt-ArrowUp", run: boxUp, preventDefault: true },
        { key: "Shift-Alt-ArrowDown", run: boxDown, preventDefault: true },
        { key: "Shift-Alt-ArrowLeft", run: boxLeft, preventDefault: true },
        { key: "Shift-Alt-ArrowRight", run: boxRight, preventDefault: true },
        { key: "Shift-Alt-Home", run: boxLineStart, preventDefault: true },
        { key: "Shift-Alt-End", run: boxLineEnd, preventDefault: true },
        { key: "Shift-Alt-PageUp", run: boxPageUp, preventDefault: true },
        { key: "Shift-Alt-PageDown", run: boxPageDown, preventDefault: true },
      ]),
    ),
    EditorView.domEventHandlers({ mousedown: onShiftAltClick }),
  ];
}
