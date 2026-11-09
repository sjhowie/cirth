/**
 * Filesystem watching: keeps the backend watch set in sync with the open folder/files and
 * reconciles open tabs and the explorer tree when `fs://changed` arrives.
 */
import { EditorSelection, Text, Transaction } from "@codemirror/state";
import { dispatchToTab, getTabDoc, getTabState, recomputeDirty } from "./editorHost.svelte";
import { splitLines } from "./dirty";
import { explorer, refreshForChanges } from "./explorer.svelte";
import { onFsChanged, readFile, toAppError, watchPaths } from "./ipc";
import { notifyError, reportError } from "./notifications.svelte";
import { isInside, normPath, samePath } from "./paths";
import { tabsStore, type Tab } from "./tabs.svelte";

/** [open folder, ...open file paths outside it], de-duplicated. */
export function computeWatchSet(root: string | null, filePaths: string[]): string[] {
  const out: string[] = root ? [root] : [];
  const seen = new Set(out.map(normPath));
  for (const p of filePaths) {
    if (root && isInside(root, p)) continue;
    const key = normPath(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

let lastKey = "";

/** Call from an effect whenever the folder or tab paths change. */
export function syncWatchedPaths(): void {
  const paths = computeWatchSet(
    explorer.root,
    tabsStore.tabs.flatMap((t) => (t.path ? [t.path] : [])),
  );
  const key = paths.map(normPath).join("\n");
  if (key === lastKey) return;
  lastKey = key;
  watchPaths(paths).catch((e) => reportError("Watch paths", e));
}

export async function startWatching(): Promise<void> {
  try {
    await onFsChanged((payload) => void handleFsChanged(payload.paths));
  } catch (e) {
    reportError("Start file watching", e);
  }
}

const inFlight = new Set<number>();
const rerun = new Set<number>();

export async function handleFsChanged(paths: string[]): Promise<void> {
  await refreshForChanges(paths);
  for (const tab of [...tabsStore.tabs]) {
    if (tab.path && paths.some((p) => samePath(p, tab.path as string))) void reconcileTab(tab.id);
  }
}

function sameText(disk: string, doc: Text): boolean {
  const diskDoc = Text.of(splitLines(disk));
  return diskDoc.length === doc.length && diskDoc.eq(doc);
}

async function reconcileTab(id: number): Promise<void> {
  if (inFlight.has(id)) {
    rerun.add(id);
    return;
  }
  inFlight.add(id);
  try {
    const tab = tabsStore.byId(id);
    if (!tab?.path) return;
    let result;
    try {
      result = await readFile(tab.path);
    } catch (e) {
      if (toAppError(e).kind === "notFound") tab.deleted = true;
      else reportError(`Re-read ${tab.title}`, e);
      return;
    }
    tab.deleted = false;
    if (sameText(result.text, tab.savedDoc)) {
      tab.diskChanged = false; // our own save, or a revert
      return;
    }
    recomputeDirty(tab);
    if (tab.dirty) tab.diskChanged = true;
    else applyDiskText(tab, result.text, result.meta, false);
  } finally {
    inFlight.delete(id);
    if (rerun.delete(id)) void reconcileTab(id);
  }
}

interface DiskMeta {
  encoding: string;
  bom: boolean;
  eol: "lf" | "crlf";
}

/** Replaces a tab's content with disk text; new savedDoc, cursor clamped. */
function applyDiskText(tab: Tab, text: string, meta: DiskMeta, undoable: boolean): void {
  const newDoc = Text.of(splitLines(text));
  const old = getTabState(tab);
  const sel = old.selection.main;
  dispatchToTab(tab, {
    changes: { from: 0, to: old.doc.length, insert: newDoc },
    selection: EditorSelection.single(Math.min(sel.anchor, newDoc.length), Math.min(sel.head, newDoc.length)),
    annotations: Transaction.addToHistory.of(undoable),
  });
  tab.savedDoc = getTabDoc(tab);
  tab.encoding = meta.encoding;
  tab.bom = meta.bom;
  tab.eol = meta.eol;
  tab.metaChanged = false;
  tab.diskChanged = false;
  tab.deleted = false;
  dispatchToTab(tab, {}); // recompute dirty against the new savedDoc
}

/** Banner "Reload": discard edits and take the disk version (undoable). */
export async function reloadFromDisk(tab: Tab): Promise<void> {
  if (!tab.path) return;
  try {
    const { text, meta } = await readFile(tab.path);
    applyDiskText(tab, text, meta, true);
  } catch (e) {
    if (toAppError(e).kind === "notFound") {
      tab.deleted = true;
      notifyError(`${tab.title} no longer exists on disk`);
    } else reportError(`Reload ${tab.title}`, e);
  }
}

/** Banner "Keep mine". */
export function keepMine(tab: Tab): void {
  tab.diskChanged = false;
}
