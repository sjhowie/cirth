import { createDir, createFile, listDir, renamePath, trashPath, type DirEntry } from "./ipc";
import { showDialog } from "./dialogs.svelte";
import { layout } from "./layout.svelte";
import { notifyError, reportError } from "./notifications.svelte";
import { basename, dirname, isInside, joinPath, normPath, replacePrefix, samePath } from "./paths";
import { tabsStore } from "./tabs.svelte";

interface LoadedDir {
  path: string;
  entries: DirEntry[];
}

interface Creating {
  parent: string;
  kind: "file" | "dir";
}

class ExplorerStore {
  root = $state<string | null>(null);
  /** Loaded directory listings keyed by normPath(dir). */
  dirs = $state<Record<string, LoadedDir>>({});
  /** Expanded folders keyed by normPath(dir); survives collapse/expand. */
  expanded = $state<Record<string, boolean>>({});
  selected = $state<string | null>(null);
  renaming = $state<string | null>(null);
  creating = $state<Creating | null>(null);
}

export const explorer = new ExplorerStore();

export function entriesOf(dir: string): DirEntry[] | undefined {
  return explorer.dirs[normPath(dir)]?.entries;
}

export function isExpanded(dir: string): boolean {
  return explorer.expanded[normPath(dir)] === true;
}

export async function loadDir(path: string): Promise<boolean> {
  try {
    const entries = await listDir(path);
    explorer.dirs[normPath(path)] = { path, entries };
    return true;
  } catch (e) {
    reportError(`List ${basename(path) || path}`, e);
    return false;
  }
}

export async function setRoot(path: string): Promise<void> {
  explorer.dirs = {};
  explorer.expanded = {};
  explorer.selected = null;
  explorer.renaming = null;
  explorer.creating = null;
  if (await loadDir(path)) {
    explorer.root = path;
    explorer.expanded[normPath(path)] = true;
    layout.sidebarVisible = true;
  }
}

export async function toggleDir(path: string): Promise<void> {
  const key = normPath(path);
  if (explorer.expanded[key]) {
    explorer.expanded[key] = false;
    return;
  }
  if (!explorer.dirs[key] && !(await loadDir(path))) return;
  explorer.expanded[key] = true;
}

/** Re-lists every loaded directory that directly contains one of the changed paths (or is one). */
export async function refreshForChanges(changed: string[]): Promise<void> {
  const keys = new Set<string>();
  for (const p of changed) {
    keys.add(normPath(dirname(p)));
    keys.add(normPath(p));
  }
  const targets = Object.entries(explorer.dirs).filter(([key]) => keys.has(key));
  await Promise.all(
    targets.map(async ([key, dir]) => {
      try {
        explorer.dirs[key] = { path: dir.path, entries: await listDir(dir.path) };
      } catch (e) {
        if (typeof e === "object" && e !== null && (e as { kind?: string }).kind === "notFound") {
          delete explorer.dirs[key];
          explorer.expanded[key] = false;
        } else {
          reportError(`Refresh ${basename(dir.path)}`, e);
        }
      }
    }),
  );
}

export function startCreate(parent: string, kind: "file" | "dir"): void {
  explorer.expanded[normPath(parent)] = true;
  explorer.renaming = null;
  explorer.creating = { parent, kind };
}

export function startRename(path: string): void {
  explorer.creating = null;
  explorer.renaming = path;
}

export function cancelEdit(): void {
  explorer.creating = null;
  explorer.renaming = null;
}

function validName(name: string): string | null {
  if (!name || name === "." || name === "..") return "Name cannot be empty";
  if (/[\\/]/.test(name)) return "Name cannot contain / or \\";
  return null;
}

/** Creates the pending file/folder; returns the new path for files (so the caller can open it). */
export async function commitCreate(name: string): Promise<string | null> {
  const pending = explorer.creating;
  explorer.creating = null;
  if (!pending) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const bad = validName(trimmed);
  if (bad) {
    notifyError(bad);
    return null;
  }
  const path = joinPath(pending.parent, trimmed);
  try {
    if (pending.kind === "file") await createFile(path);
    else await createDir(path);
  } catch (e) {
    reportError(`Create ${trimmed}`, e);
    return null;
  }
  await loadDir(pending.parent);
  return pending.kind === "file" ? path : null;
}

/** Renames and re-points any open tabs under the old path. */
export async function commitRename(name: string): Promise<void> {
  const from = explorer.renaming;
  explorer.renaming = null;
  if (!from) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === basename(from)) return;
  const bad = validName(trimmed);
  if (bad) {
    notifyError(bad);
    return;
  }
  const parent = dirname(from);
  const to = joinPath(parent, trimmed);
  try {
    await renamePath(from, to);
  } catch (e) {
    reportError(`Rename ${basename(from)}`, e);
    return;
  }
  for (const tab of tabsStore.tabs) {
    if (tab.path && isInside(from, tab.path)) {
      tab.path = replacePrefix(tab.path, from, to);
      if (samePath(tab.path, to)) tab.title = trimmed;
    }
  }
  if (explorer.root && samePath(explorer.root, from)) explorer.root = to;
  await loadDir(parent);
}

export async function deleteEntry(path: string, isDir: boolean): Promise<void> {
  const answer = await showDialog({
    title: `Delete ${isDir ? "folder" : "file"}?`,
    message: `"${basename(path)}" will be moved to the recycle bin.`,
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Delete", value: "delete", danger: true, primary: true },
    ],
    cancelValue: "cancel",
  });
  if (answer !== "delete") return;
  try {
    await trashPath(path);
  } catch (e) {
    reportError(`Delete ${basename(path)}`, e);
    return;
  }
  await loadDir(dirname(path));
}
