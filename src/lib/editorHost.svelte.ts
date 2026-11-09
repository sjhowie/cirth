/**
 * Owns the single EditorView and everything that moves state between it and the tabs:
 * tab switching (setState + scroll restore), throttled dirty tracking, per-tab dispatch,
 * and settings reconfiguration of all tabs.
 *
 * Extension point: `onEditorUpdate(fn)` lets other features (e.g. markdown preview) observe
 * every ViewUpdate of the active editor; `getActiveText()` reads the active document.
 */
import { EditorSelection, EditorState, Text, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { buildExtensions, languageC, settingsEffects } from "./editor/config";
import { isDocDirty } from "./dirty";
import { isDark, settings } from "./settings.svelte";
import { tabsStore, type Tab } from "./tabs.svelte";

const DIRTY_INTERVAL_MS = 300;

let view: EditorView | null = null;
const updateSubscribers = new Set<(u: ViewUpdate) => void>();

export const status = $state({ line: 1, col: 1, selLen: 0, lines: 1 });

export function getView(): EditorView | null {
  return view;
}

export function onEditorUpdate(fn: (u: ViewUpdate) => void): () => void {
  updateSubscribers.add(fn);
  return () => updateSubscribers.delete(fn);
}

export function attachView(v: EditorView): void {
  view = v;
  const tab = tabsStore.active;
  if (tab) loadIntoView(tab);
}

export function detachView(): void {
  view = null;
}

/** The up-to-date state of a tab (the live view state for the active one). */
export function getTabState(tab: Tab): EditorState {
  return view && tab.id === tabsStore.activeId ? view.state : tab.state;
}

export function getTabDoc(tab: Tab): Text {
  return getTabState(tab).doc;
}

export function getActiveText(): string | null {
  const tab = tabsStore.active;
  return tab ? getTabDoc(tab).toString() : null;
}

// ---------- dirty tracking ----------

export function recomputeDirty(tab: Tab): void {
  const dirty = tab.metaChanged || isDocDirty(getTabDoc(tab), tab.savedDoc);
  if (tab.dirty !== dirty) tab.dirty = dirty;
}

let lastDirtyCheck = 0;
let dirtyTimer: ReturnType<typeof setTimeout> | null = null;

/** At most one check per ~300 ms: runs at once if idle, otherwise once more at the end of the window. */
function scheduleDirtyCheck(): void {
  const run = () => {
    dirtyTimer = null;
    lastDirtyCheck = Date.now();
    const tab = tabsStore.active;
    if (tab) recomputeDirty(tab);
  };
  const wait = DIRTY_INTERVAL_MS - (Date.now() - lastDirtyCheck);
  if (wait <= 0) run();
  else if (dirtyTimer === null) dirtyTimer = setTimeout(run, wait);
}

/** Brings every tab's dirty flag up to date (before close/exit prompts). */
export function refreshAllDirty(): void {
  tabsStore.tabs.forEach(recomputeDirty);
}

// ---------- state creation ----------

export function makeTabState(doc: string, largeFile: boolean, lang: Extension): EditorState {
  return EditorState.create({
    doc,
    extensions: buildExtensions({ largeFile, lang, settings, dark: isDark(), onUpdate: handleUpdate }),
  });
}

function handleUpdate(u: ViewUpdate): void {
  if (u.docChanged) scheduleDirtyCheck();
  if (u.docChanged || u.selectionSet) refreshStatus(u.state);
  updateSubscribers.forEach((fn) => fn(u));
}

function refreshStatus(state: EditorState): void {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  status.line = line.number;
  status.col = main.head - line.from + 1;
  status.selLen = Math.abs(main.to - main.from);
  status.lines = state.doc.lines;
}

// ---------- switching ----------

function loadIntoView(tab: Tab): void {
  if (!view) return;
  view.setState(tab.state);
  const top = tab.scrollTop;
  view.scrollDOM.scrollTop = top;
  requestAnimationFrame(() => {
    if (view && tabsStore.activeId === tab.id) view.scrollDOM.scrollTop = top;
  });
  refreshStatus(tab.state);
  view.focus();
}

/** Saves the outgoing tab's state/scroll, then shows `id` in the single view. */
export function activateTab(id: number): void {
  const next = tabsStore.byId(id);
  if (!next) return;
  const current = tabsStore.active;
  if (current && view && current.id !== id) {
    current.state = view.state;
    current.scrollTop = view.scrollDOM.scrollTop;
  }
  if (current?.id === id) return;
  tabsStore.activeId = id;
  loadIntoView(next);
}

/** Removes a tab (no prompts) and activates its neighbour; frees the view's doc when none are left. */
export function removeTab(id: number): void {
  const index = tabsStore.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  const wasActive = tabsStore.activeId === id;
  tabsStore.remove(id);
  if (!wasActive) return;
  const neighbour = tabsStore.tabs[Math.min(index, tabsStore.tabs.length - 1)];
  if (neighbour) {
    tabsStore.activeId = neighbour.id;
    loadIntoView(neighbour);
  } else {
    tabsStore.activeId = null;
    view?.setState(EditorState.create({ doc: "" }));
  }
}

// ---------- per-tab edits ----------

/** Applies a transaction to a tab whether or not it is the one currently shown. */
export function dispatchToTab(tab: Tab, spec: TransactionSpec): void {
  if (view && tab.id === tabsStore.activeId) view.dispatch(spec);
  else tab.state = tab.state.update(spec).state;
  recomputeDirty(tab);
}

export function setTabLanguageExtension(tab: Tab, lang: Extension): void {
  dispatchToTab(tab, { effects: languageC.reconfigure(lang) });
}

/**
 * Selects `matchLen` chars at 1-based `line`/`col` in the active document, scrolls the selection
 * into the vertical centre and focuses the editor. Line/col are clamped to the document.
 * Returns false when no editor is attached.
 */
export function revealPosition(line: number, col: number, matchLen: number): boolean {
  if (!view) return false;
  const doc = view.state.doc;
  const ln = doc.line(Math.min(Math.max(1, line), doc.lines));
  const from = Math.min(ln.from + Math.max(0, col - 1), ln.to);
  const to = Math.min(from + Math.max(0, matchLen), ln.to);
  view.dispatch({
    selection: EditorSelection.single(from, to),
    effects: EditorView.scrollIntoView(from, { y: "center" }),
    userEvent: "select",
  });
  view.focus();
  return true;
}

/** Re-applies theme/indent/wrap/font to every tab, including inactive ones. */
export function reconfigureAllTabs(): void {
  const dark = isDark();
  for (const tab of tabsStore.tabs) {
    dispatchToTab(tab, { effects: settingsEffects(settings, dark, tab.largeFile) });
  }
}
