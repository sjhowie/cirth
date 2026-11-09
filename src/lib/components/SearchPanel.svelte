<script lang="ts">
  import { onMount } from "svelte";
  import { runCommand } from "$lib/commands";
  import { explorer } from "$lib/explorer.svelte";
  import { relativeTo, splitPreview, summaryText } from "$lib/search/results";
  import { canReplaceAll, openMatch, replaceAll, runSearch, scheduleSearch, search } from "$lib/search/search.svelte";

  let queryEl = $state<HTMLInputElement | null>(null);

  const groups = $derived.by(() => {
    void search.version;
    return search.results ? search.results.files.slice() : [];
  });
  const summary = $derived.by(() => {
    void search.version;
    // A finished search with no matches shows "No results" (below) instead of "0 results in 0 files".
    const r = search.results;
    return r && !(r.finished && r.matches === 0) ? summaryText(r) : "";
  });
  const replaceEnabled = $derived.by(() => {
    void search.version;
    return canReplaceAll();
  });
  const hasQuery = $derived(search.query !== "");

  onMount(() => queryEl?.focus());

  // Command "Find in Folder" asks for focus (also when the panel was already open).
  let seenFocus = search.focusRequest;
  $effect(() => {
    const req = search.focusRequest;
    if (req !== seenFocus) {
      seenFocus = req;
      queryEl?.focus();
      queryEl?.select();
    }
  });

  function toggle(key: "caseSensitive" | "wholeWord" | "regex"): void {
    search[key] = !search[key];
    void runSearch();
  }

  function onQueryKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void runSearch();
    }
  }
</script>

<div class="panel">
  {#if !explorer.root}
    <div class="empty">
      <p>Open a folder to search</p>
      <button class="btn" onclick={() => void runCommand("file.openFolder")}>Open Folder…</button>
    </div>
  {:else}
    <div class="form">
      <div class="row">
        <button
          class="chevron"
          class:open={search.replaceOpen}
          title={search.replaceOpen ? "Hide replace" : "Show replace"}
          aria-label="Toggle replace"
          aria-expanded={search.replaceOpen}
          onclick={() => (search.replaceOpen = !search.replaceOpen)}>&#9656;</button
        >
        <div class="field">
          <input
            bind:this={queryEl}
            type="text"
            placeholder="Search"
            spellcheck="false"
            aria-label="Search query"
            aria-invalid={search.error !== null}
            bind:value={search.query}
            oninput={scheduleSearch}
            onkeydown={onQueryKey}
          />
          <button class="toggle" class:on={search.caseSensitive} title="Match Case" aria-pressed={search.caseSensitive} onclick={() => toggle("caseSensitive")}>Aa</button>
          <button class="toggle" class:on={search.wholeWord} title="Match Whole Word" aria-pressed={search.wholeWord} onclick={() => toggle("wholeWord")}><u>ab</u></button>
          <button class="toggle" class:on={search.regex} title="Use Regular Expression" aria-pressed={search.regex} onclick={() => toggle("regex")}>.*</button>
        </div>
      </div>
      {#if search.error}
        <div class="error" role="alert">{search.error}</div>
      {/if}
      {#if search.replaceOpen}
        <div class="row">
          <span class="chevron-gap"></span>
          <div class="field">
            <input type="text" placeholder="Replace" spellcheck="false" aria-label="Replacement" bind:value={search.replacement} />
            <button class="toggle wide" title="Replace All in the matching files" disabled={!replaceEnabled} onclick={() => void replaceAll()}>
              {search.replacing ? "…" : "All"}
            </button>
          </div>
        </div>
      {/if}
      <label class="glob">
        <span>files to include</span>
        <input type="text" placeholder="e.g. *.ts, src/**" spellcheck="false" bind:value={search.include} oninput={scheduleSearch} onkeydown={onQueryKey} />
      </label>
      <label class="glob">
        <span>files to exclude</span>
        <input type="text" placeholder="e.g. **/*.min.js" spellcheck="false" bind:value={search.exclude} oninput={scheduleSearch} onkeydown={onQueryKey} />
      </label>
    </div>

    {#if search.searching || summary}
      <div class="summary">
        {#if search.searching}<span class="spin">Searching…</span>{/if}
        {summary}
      </div>
    {:else if hasQuery && !search.error}
      <div class="summary">No results</div>
    {/if}

    <div class="results" role="tree" aria-label="Search results">
      {#each groups as g (g.path)}
        {@const rel = relativeTo(explorer.root, g.path)}
        {@const open = !search.collapsed[g.path]}
        <div class="group" role="treeitem" aria-selected="false" aria-expanded={open}>
          <button class="file" title={g.path} onclick={() => (search.collapsed[g.path] = open)}>
            <span class="caret" class:open>&#9656;</span>
            <span class="rel">{rel}</span>
            <span class="count">{g.items.length}</span>
          </button>
          {#if open}
            {#each g.items as item, i (i)}
              {@const p = splitPreview(item.preview, item.col, item.matchLen)}
              <button class="match" title="Line {item.line}" onclick={() => void openMatch(g.path, item)}>
                <span class="ln">{item.line}</span>
                <span class="preview">{p.before}<mark>{p.match}</mark>{p.after}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .empty {
    padding: 16px 12px;
    color: var(--fg-dim);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .empty p {
    margin: 0;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    flex: none;
  }
  .row {
    display: flex;
    gap: 4px;
    align-items: stretch;
  }
  .chevron,
  .chevron-gap {
    width: 16px;
    flex: none;
    color: var(--fg-dim);
  }
  .chevron {
    transition: transform 0.1s;
  }
  .chevron.open {
    transform: rotate(90deg);
  }
  .field {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 2px;
    align-items: center;
  }
  .field input {
    flex: 1;
    min-width: 0;
  }
  .field input[aria-invalid="true"] {
    border-color: var(--danger);
  }
  .toggle {
    flex: none;
    min-width: 24px;
    height: 24px;
    padding: 0 4px;
    border-radius: 4px;
    border: 1px solid transparent;
    color: var(--fg-dim);
    font-size: 12px;
  }
  .toggle:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .toggle.on {
    background: var(--bg-active);
    border-color: var(--accent);
    color: var(--fg);
  }
  .toggle:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .toggle.wide {
    border-color: var(--border);
    padding: 0 8px;
  }
  .error {
    color: var(--danger);
    font-size: 12px;
    padding-left: 20px;
    overflow-wrap: anywhere;
  }
  .glob {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 20px;
    font-size: 11px;
    color: var(--fg-dim);
  }
  .summary {
    padding: 2px 10px 6px;
    color: var(--fg-dim);
    font-size: 12px;
    flex: none;
  }
  .spin {
    margin-right: 6px;
  }
  .results {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding-bottom: 8px;
  }
  .file,
  .match {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    text-align: left;
    white-space: nowrap;
  }
  .file {
    padding: 3px 8px;
    font-weight: 600;
  }
  .file:hover,
  .match:hover {
    background: var(--bg-hover);
  }
  .caret {
    display: inline-block;
    width: 10px;
    color: var(--fg-dim);
    transition: transform 0.1s;
  }
  .caret.open {
    transform: rotate(90deg);
  }
  .rel {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    flex: none;
    background: var(--bg-active);
    border-radius: 9px;
    padding: 0 6px;
    font-size: 11px;
    font-weight: 400;
  }
  .match {
    padding: 1px 8px 1px 24px;
    font-family: Consolas, "Cascadia Code", monospace;
    font-size: 12px;
  }
  .ln {
    flex: none;
    min-width: 3ch;
    text-align: right;
    color: var(--fg-dim);
  }
  .preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }
  mark {
    background: color-mix(in srgb, var(--accent) 35%, transparent);
    color: inherit;
    border-radius: 2px;
  }
</style>
