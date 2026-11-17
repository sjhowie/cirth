<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { registerAppCommands } from "#lib/appCommands.js";
  import ChangedBanner from "#lib/components/ChangedBanner.svelte";
  import Editor from "#lib/components/Editor.svelte";
  import MenuBar from "#lib/components/MenuBar.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import SettingsPanel from "#lib/components/SettingsPanel.svelte";
  import Sidebar from "#lib/components/Sidebar.svelte";
  import StatusBar from "#lib/components/StatusBar.svelte";
  import TabBar from "#lib/components/TabBar.svelte";
  import Toasts from "#lib/components/Toasts.svelte";
  import { reconfigureAllTabs } from "#lib/editorHost.svelte.js";
  import { confirmExit, newTab, openStartupPaths } from "#lib/files.js";
  import { isTauri } from "#lib/ipc.js";
  import { installKeyHandler } from "#lib/keys.svelte.js";
  import { layout } from "#lib/layout.svelte.js";
  import { registerMarkdownPreview } from "#lib/markdown/preview.svelte.js";
  import { reportError } from "#lib/notifications.svelte.js";
  import { flushSettings, initSettings, isDark, settings, themeState } from "#lib/settings.svelte.js";
  import { tabsStore } from "#lib/tabs.svelte.js";
  import { startUpdater } from "#lib/updater.svelte.js";
  import { startWatching, syncWatchedPaths } from "#lib/watch.svelte.js";
  import { registerPaletteAndSearch } from "#lib/palette/register.js";

  // Theme: chrome CSS variables + every tab's CodeMirror theme/font/indent/wrap.
  $effect(() => {
    const dark = isDark();
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    // The native window/WebView2 background shows while resizing; keep it on the theme (startup sets it in Rust).
    if (isTauri()) {
      import("@tauri-apps/api/webviewWindow")
        .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().setBackgroundColor(dark ? "#282c34" : "#ffffff"))
        .catch((e) => reportError("Set window background", e));
    }
    // Touch every setting the editor depends on so this effect re-runs when any changes.
    void [settings.fontFamily, settings.fontSize, settings.indent, settings.wordWrap];
    untrack(reconfigureAllTabs);
  });

  // Keep the backend watch set in sync with the open folder and file paths.
  $effect(() => {
    if (isTauri()) syncWatchedPaths();
  });

  // Window title.
  $effect(() => {
    const tab = tabsStore.active;
    const title = tab ? `${tab.dirty ? "● " : ""}${tab.title} - Cirth` : "Cirth";
    document.title = title;
    if (isTauri()) {
      import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
        .catch((e) => console.error("Set window title", e));
    }
  });

  onMount(() => {
    registerAppCommands();
    registerPaletteAndSearch();
    registerMarkdownPreview();
    const uninstallKeys = installKeyHandler();
    const stopUpdater = startUpdater();

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    themeState.systemDark = media.matches;
    const onMedia = (e: MediaQueryListEvent) => (themeState.systemDark = e.matches);
    media.addEventListener("change", onMedia);

    let unlistenClose: (() => void) | null = null;

    (async () => {
      await initSettings();
      if (isTauri()) {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          let closing = false;
          unlistenClose = await win.onCloseRequested(async (event) => {
            // Tauri destroys the window after this handler unless it is prevented, so every path
            // prevents and only the confirmed path destroys. A second X / Alt+F4 while the prompt is
            // up must leave the window (and the prompt) alone.
            event.preventDefault();
            if (closing) return;
            closing = true;
            try {
              if (!(await confirmExit())) return;
              await flushSettings();
              await win.destroy();
            } catch (e) {
              reportError("Close window", e);
            } finally {
              closing = false;
            }
          });
        } catch (e) {
          reportError("Register close handler", e);
        }
        await startWatching();
        await openStartupPaths();
      }
      if (tabsStore.tabs.length === 0) await newTab();
    })().catch((e) => reportError("Startup", e));

    return () => {
      uninstallKeys();
      stopUpdater();
      media.removeEventListener("change", onMedia);
      unlistenClose?.();
    };
  });
</script>

<div class="app">
  <MenuBar />
  <div class="main">
    {#if layout.sidebarVisible}
      <Sidebar />
    {/if}
    <div class="center">
      <TabBar />
      <div class="area">
        <!-- Editor pane stays mounted (hidden, never destroyed) so the single EditorView survives preview-only mode. -->
        <div class="pane editor-pane" class:hidden={layout.previewMode === "only"}>
          <ChangedBanner />
          <Editor />
        </div>
        <!-- Preview slot: layout.previewComponent, shown when layout.previewMode is "side" or "only". -->
        {#if layout.previewMode !== "off" && layout.previewComponent}
          {@const Preview = layout.previewComponent}
          <div class="pane preview-pane" class:only={layout.previewMode === "only"} id="preview-slot">
            <Preview />
          </div>
        {/if}
      </div>
    </div>
  </div>
  <StatusBar />
</div>

<Toasts />
<Modal />
<SettingsPanel />
{#each layout.overlays as Overlay, i (i)}
  <Overlay />
{/each}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .main {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .center {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .area {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .pane {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .pane.hidden {
    display: none;
  }
  .preview-pane {
    border-left: 1px solid var(--border);
    overflow: auto;
    background: var(--bg-editor);
  }
</style>
