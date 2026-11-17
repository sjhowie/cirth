/**
 * Wires the Markdown preview into the shell: the preview component, the two commands, and
 * the per-tab show/hide rule (hidden on non-Markdown tabs, restored when returning to a
 * Markdown tab that had it open).
 */
import MarkdownPreview from "#lib/components/MarkdownPreview.svelte";
import { registerCommand } from "#lib/commands.js";
import { MARKDOWN_LANG } from "#lib/editor/languages.js";
import { layout, setPreviewComponent, type PreviewMode } from "#lib/layout.svelte.js";
import { notifyInfo } from "#lib/notifications.svelte.js";
import { tabsStore } from "#lib/tabs.svelte.js";

/** Preview mode chosen per tab id; tabs absent from the map have the preview off. */
const tabModes = new Map<number, PreviewMode>();

function activeMarkdownTabId(): number | null {
  const tab = tabsStore.active;
  if (!tab || tab.languageName !== MARKDOWN_LANG) {
    notifyInfo("Preview is only for Markdown files");
    return null;
  }
  return tab.id;
}

/** Sets the active tab's mode and applies it to the layout right away. */
function setMode(id: number, mode: PreviewMode): void {
  if (mode === "off") tabModes.delete(id);
  else tabModes.set(id, mode);
  layout.previewMode = mode;
}

/** `target` unless the tab is already in it, in which case the preview closes. */
function toggleMode(target: PreviewMode): void {
  const id = activeMarkdownTabId();
  if (id === null) return;
  setMode(id, (tabModes.get(id) ?? "off") === target ? "off" : target);
}

export function registerMarkdownPreview(): void {
  setPreviewComponent(MarkdownPreview);

  registerCommand({
    id: "markdown.togglePreview",
    label: "Markdown: Toggle Preview",
    category: "View",
    keys: ["Mod-Shift-v"],
    run: () => toggleMode("only"),
  });
  registerCommand({
    id: "markdown.previewSide",
    label: "Markdown: Open Preview to the Side",
    category: "View",
    keys: ["Mod-k v"],
    run: () => toggleMode("side"),
  });

  // Follow the active tab: restore its remembered mode on Markdown tabs, hide it elsewhere.
  $effect.root(() => {
    $effect(() => {
      const tab = tabsStore.active;
      const isMarkdown = tab?.languageName === MARKDOWN_LANG;
      const live = new Set(tabsStore.tabs.map((t) => t.id));
      for (const id of [...tabModes.keys()]) if (!live.has(id)) tabModes.delete(id);
      layout.previewMode = tab && isMarkdown ? (tabModes.get(tab.id) ?? "off") : "off";
    });
  });
}
