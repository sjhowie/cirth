/** File-level actions: open, new, save, save as, save all, close, open folder, startup paths. */
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Extension } from "@codemirror/state";
import { activateTab, getTabDoc, makeTabState, recomputeDirty, removeTab, setTabLanguageExtension } from "./editorHost.svelte";
import { showDialog } from "./dialogs.svelte";
import { detectLanguageName, loadLanguageExtension, PLAIN_TEXT } from "./editor/languages";
import { setRoot } from "./explorer.svelte";
import { getStartupPaths, isTauri, listDir, onOpenPaths, readFile, toAppError, writeFile } from "./ipc";
import { notifyError, notifyInfo, reportError } from "./notifications.svelte";
import { basename } from "./paths";
import { defaultEol } from "./platform";
import { settings } from "./settings.svelte";
import { tabsStore, type Tab } from "./tabs.svelte";

function requireTauri(): boolean {
  if (isTauri()) return true;
  notifyError("Not running in Tauri: this action needs the desktop app");
  return false;
}

async function languageFor(name: string, largeFile: boolean): Promise<Extension> {
  if (largeFile) return [];
  try {
    return await loadLanguageExtension(name);
  } catch (e) {
    reportError(`Load language ${name}`, e);
    return [];
  }
}

// ---------- new / open ----------

export async function newTab(): Promise<Tab> {
  const state = makeTabState("", false, []);
  const tab = tabsStore.add({
    id: tabsStore.newId(),
    path: null,
    title: tabsStore.nextUntitledTitle(),
    state,
    encoding: "utf-8",
    bom: false,
    eol: defaultEol,
    savedDoc: state.doc,
    dirty: false,
    metaChanged: false,
    languageName: PLAIN_TEXT,
    largeFile: false,
    scrollTop: 0,
    diskChanged: false,
    deleted: false,
  });
  activateTab(tab.id);
  return tab;
}

/** An empty, untouched Untitled tab is replaced by the first file opened (like most editors). */
function pristineUntitled(): Tab | null {
  const t = tabsStore.active;
  return t && t.path === null && !t.dirty && getTabDoc(t).length === 0 ? t : null;
}

export async function openPath(path: string): Promise<Tab | null> {
  const existing = tabsStore.byPath(path);
  if (existing) {
    activateTab(existing.id);
    return existing;
  }
  let result;
  try {
    result = await readFile(path);
  } catch (e) {
    reportError(`Open ${basename(path)}`, e);
    return null;
  }
  const dup = tabsStore.byPath(path);
  if (dup) {
    activateTab(dup.id);
    return dup;
  }
  const { meta, text } = result;
  const largeFile = meta.size >= settings.largeFileThresholdMb * 1024 * 1024;
  const languageName = detectLanguageName(basename(path));
  const state = makeTabState(text, largeFile, await languageFor(languageName, largeFile));
  const replace = pristineUntitled();
  const tab = tabsStore.add({
    id: tabsStore.newId(),
    path,
    title: basename(path),
    state,
    encoding: meta.encoding,
    bom: meta.bom,
    eol: meta.eol,
    savedDoc: state.doc,
    dirty: false,
    metaChanged: false,
    languageName,
    largeFile,
    scrollTop: 0,
    diskChanged: false,
    deleted: false,
  });
  activateTab(tab.id);
  if (replace) removeTab(replace.id);
  return tab;
}

export async function openFilesDialog(): Promise<void> {
  if (!requireTauri()) return;
  let picked: string[] | string | null;
  try {
    picked = await open({ multiple: true, directory: false });
  } catch (e) {
    reportError("Open file dialog", e);
    return;
  }
  if (!picked) return;
  for (const p of Array.isArray(picked) ? picked : [picked]) await openPath(p);
}

export async function openFolderDialog(): Promise<void> {
  if (!requireTauri()) return;
  let picked: string | string[] | null;
  try {
    picked = await open({ multiple: false, directory: true });
  } catch (e) {
    reportError("Open folder dialog", e);
    return;
  }
  const dir = Array.isArray(picked) ? picked[0] : picked;
  if (dir) await setRoot(dir);
}

/** Opens paths: folders become the explorer root, files become tabs. */
export async function openPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    // The contract has no stat command: a successful list_dir means "folder", otherwise try as a file.
    let isFolder = false;
    try {
      await listDir(p);
      isFolder = true;
    } catch (e) {
      console.debug("startup path is not a folder, opening as file", p, e);
    }
    if (isFolder) await setRoot(p);
    else await openPath(p);
  }
}

let openPathsSubscribed = false;

/** Opens command-line paths, and keeps opening paths that later launches hand to this instance. */
export async function openStartupPaths(): Promise<void> {
  if (isTauri() && !openPathsSubscribed) {
    openPathsSubscribed = true;
    try {
      // Awaited before get_startup_paths: that call tells Rust we are ready to receive events.
      await onOpenPaths((payload) => {
        openPaths(payload.paths).catch((e) => reportError("Open paths from another launch", e));
      });
    } catch (e) {
      openPathsSubscribed = false;
      reportError("Listen for paths from other launches", e);
    }
  }
  let paths: string[];
  try {
    paths = await getStartupPaths();
  } catch (e) {
    reportError("Read startup paths", e);
    return;
  }
  await openPaths(paths);
}

// ---------- save ----------

async function writeTab(tab: Tab, path: string): Promise<boolean> {
  const doc = getTabDoc(tab); // captured: edits made while the write runs stay dirty
  try {
    await writeFile(path, doc, { encoding: tab.encoding, bom: tab.bom, eol: tab.eol });
  } catch (e) {
    const err = toAppError(e);
    if (err.kind === "encoding") notifyError(`Cannot save as ${tab.encoding}: ${err.message}. Pick another encoding in the status bar.`);
    else reportError(`Save ${tab.title}`, e);
    console.error("write_file failed", path, e);
    return false;
  }
  tab.savedDoc = doc;
  tab.metaChanged = false;
  tab.deleted = false;
  tab.diskChanged = false;
  recomputeDirty(tab);
  return true;
}

export async function saveTabAs(tab: Tab): Promise<boolean> {
  if (!requireTauri()) return false;
  let target: string | null;
  try {
    target = await save({ defaultPath: tab.path ?? tab.title });
  } catch (e) {
    reportError("Save dialog", e);
    return false;
  }
  if (!target) return false;
  const other = tabsStore.byPath(target);
  if (other && other.id !== tab.id) {
    notifyError(`${basename(target)} is already open in another tab`);
    return false;
  }
  if (!(await writeTab(tab, target))) return false;
  tab.path = target;
  tab.title = basename(target);
  if (tab.languageName === PLAIN_TEXT && !tab.largeFile) {
    const name = detectLanguageName(tab.title);
    if (name !== PLAIN_TEXT) await setTabLanguage(tab, name);
  }
  return true;
}

export async function saveTab(tab: Tab): Promise<boolean> {
  if (tab.path === null) return saveTabAs(tab);
  if (!requireTauri()) return false;
  return writeTab(tab, tab.path);
}

/** Saves every dirty tab; stops (false) at the first failure or cancelled Save As. */
export async function saveAll(): Promise<boolean> {
  for (const tab of [...tabsStore.tabs]) {
    recomputeDirty(tab);
    if (tab.dirty && !(await saveTab(tab))) return false;
  }
  return true;
}

// ---------- close ----------

export async function closeTab(id: number): Promise<boolean> {
  const tab = tabsStore.byId(id);
  if (!tab) return true;
  recomputeDirty(tab);
  if (tab.dirty) {
    activateTab(id);
    const answer = await showDialog({
      title: `Save changes to ${tab.title}?`,
      message: "Your changes will be lost if you don't save them.",
      buttons: [
        { label: "Save", value: "save", primary: true },
        { label: "Don't Save", value: "discard", danger: true },
        { label: "Cancel", value: "cancel" },
      ],
      cancelValue: "cancel",
    });
    if (answer === "cancel") return false;
    if (answer === "save" && !(await saveTab(tab))) return false;
  }
  removeTab(id);
  return true;
}

export async function closeActiveTab(): Promise<void> {
  const tab = tabsStore.active;
  if (tab) await closeTab(tab.id);
}

/** Window-close prompt. Resolves true when it is OK to exit. */
export async function confirmExit(): Promise<boolean> {
  tabsStore.tabs.forEach(recomputeDirty);
  const dirty = tabsStore.tabs.filter((t) => t.dirty);
  if (dirty.length === 0) return true;
  const answer = await showDialog({
    title: "Unsaved changes",
    message: `${dirty.length} file${dirty.length === 1 ? " has" : "s have"} unsaved changes: ${dirty.map((t) => t.title).join(", ")}`,
    buttons: [
      { label: "Save All", value: "save", primary: true },
      { label: "Discard", value: "discard", danger: true },
      { label: "Cancel", value: "cancel" },
    ],
    cancelValue: "cancel",
  });
  if (answer === "discard") return true;
  if (answer === "save") return saveAll();
  return false;
}

// ---------- tab metadata ----------

export async function setTabLanguage(tab: Tab, name: string): Promise<void> {
  tab.languageName = name;
  if (tab.largeFile) {
    notifyInfo("Light mode: syntax highlighting is off for large files");
    return;
  }
  setTabLanguageExtension(tab, await languageFor(name, false));
}

export function setTabEol(tab: Tab, eol: "lf" | "crlf"): void {
  if (tab.eol === eol) return;
  tab.eol = eol;
  tab.metaChanged = true;
  recomputeDirty(tab);
}

export function setTabEncoding(tab: Tab, encoding: string, bom: boolean): void {
  if (tab.encoding === encoding && tab.bom === bom) return;
  tab.encoding = encoding;
  tab.bom = bom;
  tab.metaChanged = true;
  recomputeDirty(tab);
}
