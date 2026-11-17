<script lang="ts">
  import { status } from "$lib/editorHost.svelte";
  import { listLanguageNames } from "$lib/editor/languages";
  import { encodingChoices, encodingLabel, eolChoices, eolFromLabel, eolLabel } from "$lib/encodings";
  import { setTabEncoding, setTabEol, setTabLanguage } from "$lib/files";
  import { reportError } from "$lib/notifications.svelte";
  import { chordHint } from "$lib/keys.svelte";
  import { layout } from "$lib/layout.svelte";
  import { settings } from "$lib/settings.svelte";
  import { tabsStore } from "$lib/tabs.svelte";
  import { installUpdate, updater } from "$lib/updater.svelte";
  import Picker from "./Picker.svelte";

  type Which = "language" | "encoding" | "eol" | null;
  let open = $state<Which>(null);

  const tab = $derived(tabsStore.active);
  const languageNames = listLanguageNames();

  const encodings = encodingChoices;
  const currentEncoding = $derived(tab ? encodingLabel(tab.encoding, tab.bom) : "");

  function toggle(which: Exclude<Which, null>, e: MouseEvent): void {
    e.stopPropagation();
    open = open === which ? null : which;
  }

  function pickLanguage(name: string): void {
    open = null;
    if (tab) setTabLanguage(tab, name).catch((e) => reportError(`Set language ${name}`, e));
  }

  function pickEncoding(label: string): void {
    open = null;
    const e = encodings[label];
    if (tab && e) setTabEncoding(tab, e.encoding, e.bom);
  }

  function pickEol(label: string): void {
    open = null;
    const eol = eolFromLabel(label);
    if (!eol) {
      reportError("Set line ending", new Error(`Unknown line ending ${label}`));
      return;
    }
    if (tab) setTabEol(tab, eol);
  }
</script>

<footer class="status">
  <div class="left">
    {#if chordHint.text}<span>{chordHint.text}</span>{/if}
    {#if tab?.deleted}<span class="warn">Deleted on disk (Save to recreate)</span>{/if}
    {#if updater.phase === "downloading"}
      <span class="badge">Downloading update{updater.progress === null ? "…" : ` ${Math.round(updater.progress * 100)}%`}</span>
    {:else if updater.phase === "installing"}
      <span class="badge">Installing update…</span>
    {:else if updater.available}
      <button class="item badge update" title="Install Cirth {updater.available} (you have {updater.version})" onclick={() => void installUpdate()}>
        Update to {updater.available}
      </button>
    {/if}
  </div>
  {#if tab}
    <div class="right">
      <span title="Lines in document">{status.lines.toLocaleString()} lines</span>
      <span>Ln {status.line.toLocaleString()}, Col {status.col.toLocaleString()}{status.selLen > 0 ? ` (${status.selLen.toLocaleString()} selected)` : ""}</span>
      <button class="item" title="Indentation (open settings)" onclick={() => (layout.settingsOpen = true)}>
        {settings.indent === "tab" ? "Tabs" : `Spaces: ${settings.indent}`}
      </button>
      <span class="anchor">
        <button class="item" title="End of line (applies on next save)" onclick={(e) => toggle("eol", e)}>{eolLabel(tab.eol)}</button>
        {#if open === "eol"}
          <Picker items={Object.keys(eolChoices)} current={eolLabel(tab.eol)} onpick={pickEol} onclose={() => (open = null)} />
        {/if}
      </span>
      <span class="anchor">
        <button class="item" title="Save with encoding… (applies on next save)" onclick={(e) => toggle("encoding", e)}>{currentEncoding}</button>
        {#if open === "encoding"}
          <Picker items={Object.keys(encodings)} current={currentEncoding} onpick={pickEncoding} onclose={() => (open = null)} />
        {/if}
      </span>
      <span class="anchor">
        <button class="item" title="Language" onclick={(e) => toggle("language", e)}>{tab.languageName}</button>
        {#if open === "language"}
          <Picker items={languageNames} current={tab.languageName} filterable onpick={pickLanguage} onclose={() => (open = null)} />
        {/if}
      </span>
      {#if tab.largeFile}<span class="badge" title="Syntax highlighting, folding and wrapping are off for large files">Light mode</span>{/if}
    </div>
  {/if}
</footer>

<style>
  .status {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex: none;
    height: 24px;
    padding: 0 8px;
    background: var(--bg-status);
    color: var(--fg-status);
    font-size: 12px;
    white-space: nowrap;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .warn {
    font-weight: 600;
  }
  .item {
    padding: 2px 4px;
    border-radius: 3px;
    color: inherit;
  }
  .item:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  .anchor {
    position: relative;
  }
  .badge {
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.25);
    font-weight: 600;
  }
</style>
