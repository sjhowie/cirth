/** Registers the built-in commands. Later features add their own via registerCommand(). */
import { openSearchPanel, gotoLine } from "@codemirror/search";
import { copyLineDown, copyLineUp, redo, selectAll, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { registerCommand, setCommandErrorHandler } from "./commands";
import { getView } from "./editorHost.svelte";
import { closeActiveTab, newTab, openFilesDialog, openFolderDialog, saveAll, saveTab, saveTabAs } from "./files";
import { formatActiveDocument } from "./format";
import { openAbout, openChangelog } from "./helpDialogs.svelte";
import { layout } from "./layout.svelte";
import { reportError } from "./notifications.svelte";
import { settings, updateSettings } from "./settings.svelte";
import { tabsStore } from "./tabs.svelte";
import { checkForUpdate } from "./updater.svelte";

function withView(fn: (v: EditorView) => unknown): () => void {
  return () => {
    const v = getView();
    if (!v || !tabsStore.active) return;
    fn(v);
    v.focus();
  };
}

export function registerAppCommands(): void {
  setCommandErrorHandler(reportError);

  // Help (menu order: What's New, Check for Updates, About)
  registerCommand({ id: "help.changelog", label: "What's New", category: "Help", run: openChangelog });
  registerCommand({ id: "help.checkForUpdates", label: "Check for Updates…", category: "Help", run: () => checkForUpdate(true) });
  registerCommand({ id: "help.about", label: "About Cirth", category: "Help", run: openAbout });

  // File
  registerCommand({ id: "file.new", label: "New File", category: "File", keys: ["Mod-n"], run: () => void newTab() });
  registerCommand({ id: "file.open", label: "Open File…", category: "File", keys: ["Mod-o"], run: openFilesDialog });
  registerCommand({ id: "file.openFolder", label: "Open Folder…", category: "File", keys: ["Mod-k Mod-o"], run: openFolderDialog });
  registerCommand({
    id: "file.save",
    label: "Save",
    category: "File",
    keys: ["Mod-s"],
    run: async () => {
      const tab = tabsStore.active;
      if (tab) await saveTab(tab);
    },
  });
  registerCommand({
    id: "file.saveAs",
    label: "Save As…",
    category: "File",
    keys: ["Mod-Shift-s"],
    run: async () => {
      const tab = tabsStore.active;
      if (tab) await saveTabAs(tab);
    },
  });
  registerCommand({ id: "file.saveAll", label: "Save All", category: "File", keys: ["Mod-Alt-s"], run: async () => void (await saveAll()) });
  registerCommand({ id: "file.close", label: "Close Tab", category: "File", keys: ["Mod-w"], run: closeActiveTab });

  // Edit (the editing keys themselves are CodeMirror's; hintKeys only labels the menu)
  registerCommand({ id: "edit.undo", label: "Undo", category: "Edit", hintKeys: ["Mod-z"], run: withView(undo) });
  registerCommand({ id: "edit.redo", label: "Redo", category: "Edit", hintKeys: ["Mod-y"], run: withView(redo) });
  registerCommand({ id: "edit.selectAll", label: "Select All", category: "Edit", hintKeys: ["Mod-a"], run: withView(selectAll) });
  registerCommand({ id: "edit.find", label: "Find…", category: "Edit", hintKeys: ["Mod-f"], run: withView(openSearchPanel) });
  registerCommand({ id: "edit.replace", label: "Find and Replace…", category: "Edit", keys: ["Mod-h"], run: withView(openSearchPanel) });
  // No default keys: Shift+Alt+Up/Down is box selection (columnSelect.ts).
  registerCommand({ id: "edit.copyLineUp", label: "Copy Line Up", category: "Edit", run: withView(copyLineUp) });
  registerCommand({ id: "edit.copyLineDown", label: "Copy Line Down", category: "Edit", run: withView(copyLineDown) });
  registerCommand({ id: "edit.gotoLine", label: "Go to Line…", category: "Edit", hintKeys: ["Mod-Alt-g"], run: withView(gotoLine) });

  // View
  registerCommand({
    id: "view.toggleSidebar",
    label: "Toggle Sidebar",
    category: "View",
    keys: ["Mod-b"],
    run: () => {
      layout.sidebarVisible = !layout.sidebarVisible;
    },
  });
  registerCommand({ id: "view.explorer", label: "Show Explorer", category: "View", run: () => void (layout.sidebarVisible = true) });
  registerCommand({
    id: "view.wordWrap",
    label: "Toggle Word Wrap",
    category: "View",
    keys: ["Alt-z"],
    run: () => updateSettings({ wordWrap: !settings.wordWrap }),
  });
  registerCommand({
    id: "view.settings",
    label: "Settings…",
    category: "View",
    keys: ["Mod-,"],
    run: () => {
      layout.settingsOpen = true;
    },
  });

  // Format
  registerCommand({
    id: "format.document",
    label: "Format Document",
    category: "Format",
    keys: ["Shift-Alt-f"],
    run: () => formatActiveDocument("pretty"),
  });
  registerCommand({
    id: "format.minify",
    label: "Minify",
    category: "Format",
    keys: ["Mod-Alt-m"],
    run: () => formatActiveDocument("minify"),
  });
}
