/**
 * Two-way scroll sync between the editor and the preview.
 *
 * The preview marks block elements with `data-source-line`; each becomes an anchor
 * { line, top } (0-based source line, pixel offset inside the preview's scroll content).
 * Positions between anchors are linearly interpolated, in either direction.
 */
import type { EditorView } from "@codemirror/view";
import { SOURCE_LINE_ATTR } from "./render";

export interface Anchor {
  line: number;
  top: number;
}

/** How long the echo of a programmatic scroll is ignored. */
export const ECHO_MS = 100;

/** Anchors sorted by line, ties dropped (first wins) and tops forced non-decreasing. */
export function normalizeAnchors(raw: Anchor[]): Anchor[] {
  const sorted = [...raw].sort((a, b) => a.line - b.line || a.top - b.top);
  const out: Anchor[] = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last && a.line === last.line) continue;
    if (last && a.top < last.top) continue;
    out.push(a);
  }
  return out;
}

/** Appends the end of the document so positions after the last anchor interpolate too. */
function withEnd(anchors: Anchor[], endLine: number, endTop: number): Anchor[] {
  const last = anchors[anchors.length - 1];
  if (!last) return [{ line: 0, top: 0 }, { line: Math.max(endLine, 1), top: Math.max(endTop, 0) }];
  const end = { line: Math.max(endLine, last.line + 1), top: Math.max(endTop, last.top) };
  const first = anchors[0];
  return first.line > 0 ? [{ line: 0, top: 0 }, ...anchors, end] : [...anchors, end];
}

function interpolate(x: number, x0: number, x1: number, y0: number, y1: number): number {
  return x1 === x0 ? y0 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/** Preview pixel offset for a (fractional) source line. */
export function lineToTop(anchors: Anchor[], line: number, endLine: number, endTop: number): number {
  const pts = withEnd(anchors, endLine, endTop);
  if (line <= pts[0].line) return pts[0].top;
  for (let i = 1; i < pts.length; i++) {
    if (line <= pts[i].line) return interpolate(line, pts[i - 1].line, pts[i].line, pts[i - 1].top, pts[i].top);
  }
  return pts[pts.length - 1].top;
}

/** (Fractional) source line at a preview pixel offset. */
export function topToLine(anchors: Anchor[], top: number, endLine: number, endTop: number): number {
  const pts = withEnd(anchors, endLine, endTop);
  if (top <= pts[0].top) return pts[0].line;
  for (let i = 1; i < pts.length; i++) {
    if (top <= pts[i].top) return interpolate(top, pts[i - 1].top, pts[i].top, pts[i - 1].line, pts[i].line);
  }
  return pts[pts.length - 1].line;
}

/** Collects anchors from the rendered preview, in the scroller's content coordinates. */
export function collectAnchors(scroller: HTMLElement, root: HTMLElement): Anchor[] {
  const scrollerTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const raw: Anchor[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTR}]`)) {
    const line = Number(el.getAttribute(SOURCE_LINE_ATTR));
    if (Number.isFinite(line)) raw.push({ line, top: el.getBoundingClientRect().top - scrollerTop });
  }
  return normalizeAnchors(raw);
}

/** Source line (0-based, fractional: wrapped lines count by height) at the editor scroll offset `scrollTop`. */
export function editorLineAt(view: EditorView, scrollTop: number): number {
  const block = view.lineBlockAtHeight(scrollTop);
  const line = view.state.doc.lineAt(block.from).number - 1;
  const frac = block.height > 0 ? Math.min(1, Math.max(0, (scrollTop - block.top) / block.height)) : 0;
  return line + frac;
}

/** Top visible source line of the editor. */
export function editorTopLine(view: EditorView): number {
  return editorLineAt(view, view.scrollDOM.scrollTop);
}

/** The top line when the editor is scrolled all the way down (the end anchor of the mapping). */
export function editorEndLine(view: EditorView): number {
  const max = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
  return editorLineAt(view, max);
}

/** Scrolls the editor so the given (fractional, 0-based) source line is at the top. */
export function scrollEditorToLine(view: EditorView, line: number): void {
  const doc = view.state.doc;
  const whole = Math.min(doc.lines - 1, Math.max(0, Math.floor(line)));
  const block = view.lineBlockAt(doc.line(whole + 1).from);
  const frac = Math.min(1, Math.max(0, line - whole));
  view.scrollDOM.scrollTop = block.top + frac * block.height;
}
