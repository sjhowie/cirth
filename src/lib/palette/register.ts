/**
 * Single entry point for the command palette, quick open and folder search.
 * Call once from the page's onMount, after registerAppCommands().
 */
import CommandPalette from "../components/CommandPalette.svelte";
import SearchPanel from "../components/SearchPanel.svelte";
import { registerCommand } from "../commands";
import { getView } from "../editorHost.svelte";
import { isTauri } from "../ipc";
import { registerOverlay, registerSidebarPanel, showSidebarPanel } from "../layout.svelte";
import { reportError } from "../notifications.svelte";
import { explorer } from "../explorer.svelte";
import { listenForSearchEvents, runSearch, search } from "../search/search.svelte";
import { watchFileIndex } from "./fileIndex.svelte";
import { openPalette } from "./state.svelte";

let registered = false;

/** The editor's selection when it is a non-empty single line (used to prefill the search box). */
function selectedSingleLine(): string | null {
  const view = getView();
  if (!view) return null;
  const sel = view.state.selection.main;
  if (sel.empty) return null;
  const text = view.state.sliceDoc(sel.from, sel.to);
  return /[\r\n]/.test(text) ? null : text;
}

export function registerPaletteAndSearch(): void {
  if (registered) return;
  registered = true;

  registerOverlay(CommandPalette);
  registerSidebarPanel({ id: "search", title: "Search", component: SearchPanel });

  registerCommand({ id: "palette.commands", label: "Command Palette…", category: "View", keys: ["Mod-Shift-p"], run: () => openPalette(">") });
  registerCommand({ id: "palette.quickOpen", label: "Go to File…", category: "File", keys: ["Mod-p"], run: () => openPalette("") });
  registerCommand({
    id: "search.findInFolder",
    label: "Find in Folder",
    category: "Edit",
    keys: ["Mod-Shift-f"],
    run: () => {
      const selected = selectedSingleLine();
      if (selected !== null) search.query = selected;
      showSidebarPanel("search");
      search.focusRequest++;
      if (selected !== null && explorer.root) void runSearch();
    },
  });

  if (isTauri()) {
    watchFileIndex().catch((e) => reportError("Watch file list", e));
    listenForSearchEvents().catch((e) => reportError("Listen for search results", e));
  }
}
