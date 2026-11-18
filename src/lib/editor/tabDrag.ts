/**
 * Dragging selected text from one tab into another. Every tab shares one EditorView, so CodeMirror's own
 * drag-and-drop only knows the document shown when the drop happens. This extension remembers which tab
 * a drag started in and, when the text is dropped into a different tab, removes it from its source tab
 * (a move; holding Ctrl, or Alt on macOS, copies), the same as a drag within one document.
 * Hovering a tab during a drag shows that tab (`dragOverTab`), so the text can be dropped into it.
 */
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Marks a drag that started in this window, so a drop from another app is never taken for one. */
const DRAG_MIME = "application/x-cirth-text-drag";
export const TAB_HOVER_MS = 500;

export interface TabDragHost {
  activeTabId(): number | null;
  /** The tab's current state, or null if it has been closed. */
  tabState(id: number): EditorState | null;
  deleteInTab(id: number, from: number, to: number): void;
}

interface DragSource {
  tabId: number;
  from: number;
  to: number;
  text: string;
  token: string;
}

let source: DragSource | null = null;
let hover: { id: number; timer: ReturnType<typeof setTimeout> } | null = null;

/** CodeMirror's rule for whether a drop moves the text or copies it. */
function dropMoves(view: EditorView, e: DragEvent): boolean {
  const custom = view.state.facet(EditorView.dragMovesSelection);
  if (custom.length) return custom[0](e);
  return /Mac/.test(navigator.platform) ? !e.altKey : !e.ctrlKey;
}

/** The drag this drop belongs to, if it started in this window; clears it either way. */
function takeSource(dt: DataTransfer): DragSource | null {
  const s = source;
  source = null;
  if (!s || !dt.types.includes(DRAG_MIME) || dt.getData(DRAG_MIME) !== s.token) return null;
  return s;
}

export function tabDragExtension(host: TabDragHost) {
  return EditorView.domEventHandlers({
    dragstart(e, view) {
      source = null;
      const tabId = host.activeTabId();
      const { from, to } = view.state.selection.main;
      if (tabId === null || from === to || !e.dataTransfer) return false;
      const token = `${Date.now()}-${Math.random()}`;
      e.dataTransfer.setData(DRAG_MIME, token);
      source = { tabId, from, to, text: view.state.sliceDoc(from, to), token };
      return false;
    },
    // Synthetic dragend events (activateTabWhileDragging) only reset CodeMirror's own drag state.
    dragend(e) {
      if (e.isTrusted) source = null;
      return false;
    },
    drop(e, view) {
      cancelTabHover();
      const dt = e.dataTransfer;
      if (!dt) return false;
      // CodeMirror would insert a dropped file's contents as text; Cirth opens files, it doesn't paste them.
      if (dt.files.length) {
        e.preventDefault();
        return true;
      }
      const s = takeSource(dt);
      if (s && s.tabId !== host.activeTabId() && dropMoves(view, e)) {
        const st = host.tabState(s.tabId);
        // Only if the source still holds the dragged text (it could have been reloaded from disk meanwhile).
        if (st && s.to <= st.doc.length && st.sliceDoc(s.from, s.to) === s.text) host.deleteInTab(s.tabId, s.from, s.to);
      }
      return false; // CodeMirror inserts the text
    },
  });
}

/** Call on every dragover of a tab: shows that tab once the pointer has rested on it for TAB_HOVER_MS. */
export function dragOverTab(id: number, activate: (id: number) => void): void {
  if (hover?.id === id) return;
  cancelTabHover();
  hover = {
    id,
    timer: setTimeout(() => {
      hover = null;
      activate(id);
    }, TAB_HOVER_MS),
  };
}

export function cancelTabHover(): void {
  if (hover) clearTimeout(hover.timer);
  hover = null;
}
