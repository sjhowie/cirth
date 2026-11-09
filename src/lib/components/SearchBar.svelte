<script module lang="ts">
  // Last focus request this bar acted on; module-level so a bar mounted after the request (sidebar
  // was hidden) still focuses once, and never when it just mounts.
  let handledFocus = 0;
</script>

<script lang="ts">
  import { canReplaceAll, clearSearch, replaceAll, runSearch, scheduleSearch, search } from "$lib/search/search.svelte";

  let queryEl = $state<HTMLInputElement | null>(null);

  const replaceEnabled = $derived.by(() => {
    void search.version;
    return canReplaceAll();
  });

  // Command "Find in Folder" asks for focus (also when the box was already visible).
  $effect(() => {
    const req = search.focusRequest;
    if (req !== handledFocus && queryEl) {
      handledFocus = req;
      queryEl.focus();
      queryEl.select();
    }
  });

  function toggle(key: "caseSensitive" | "wholeWord" | "regex"): void {
    search[key] = !search[key];
    void runSearch();
  }

  function clearQuery(): void {
    search.query = "";
    clearSearch();
    queryEl?.focus();
  }

  function onQueryKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void runSearch();
    } else if (e.key === "Escape" && search.query !== "") {
      e.preventDefault();
      clearQuery();
    }
  }
</script>

<div class="form">
  <div class="row">
    <div class="field">
      <svg class="mag" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="4.5" />
        <path d="M10 10l4.5 4.5" />
      </svg>
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
      {#if search.query !== ""}
        <button class="clear" title="Clear search" aria-label="Clear search" onclick={clearQuery}>&times;</button>
      {/if}
      <button class="toggle" class:on={search.caseSensitive} title="Match Case" aria-pressed={search.caseSensitive} onclick={() => toggle("caseSensitive")}>Aa</button>
      <button class="toggle" class:on={search.wholeWord} title="Match Whole Word" aria-pressed={search.wholeWord} onclick={() => toggle("wholeWord")}><u>ab</u></button>
      <button class="toggle" class:on={search.regex} title="Use Regular Expression" aria-pressed={search.regex} onclick={() => toggle("regex")}>.*</button>
      <button
        class="toggle"
        class:on={search.replaceOpen}
        title={search.replaceOpen ? "Hide replace and file filters" : "Show replace and file filters"}
        aria-label="Toggle search options"
        aria-expanded={search.replaceOpen}
        onclick={() => (search.replaceOpen = !search.replaceOpen)}>&hellip;</button
      >
    </div>
  </div>
  {#if search.error}
    <div class="error" role="alert">{search.error}</div>
  {/if}
  {#if search.replaceOpen}
    <div class="row">
      <div class="field">
        <input type="text" placeholder="Replace" spellcheck="false" aria-label="Replacement" bind:value={search.replacement} />
        <button class="toggle wide" title="Replace All in the matching files" disabled={!replaceEnabled} onclick={() => void replaceAll()}>
          {search.replacing ? "…" : "All"}
        </button>
      </div>
    </div>
    <label class="glob">
      <span>files to include</span>
      <input type="text" placeholder="e.g. *.ts, src/**" spellcheck="false" bind:value={search.include} oninput={scheduleSearch} onkeydown={onQueryKey} />
    </label>
    <label class="glob">
      <span>files to exclude</span>
      <input type="text" placeholder="e.g. **/*.min.js" spellcheck="false" bind:value={search.exclude} oninput={scheduleSearch} onkeydown={onQueryKey} />
    </label>
  {/if}
</div>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 8px 6px;
    flex: none;
  }
  .row {
    display: flex;
    gap: 4px;
    align-items: stretch;
  }
  .field {
    position: relative;
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
  .field input[aria-label="Search query"] {
    padding-left: 22px;
  }
  .mag {
    position: absolute;
    left: 6px;
    color: var(--fg-dim);
    pointer-events: none;
  }
  .field input[aria-invalid="true"] {
    border-color: var(--danger);
  }
  .clear {
    flex: none;
    width: 20px;
    height: 24px;
    color: var(--fg-dim);
    font-size: 16px;
    line-height: 1;
  }
  .clear:hover {
    color: var(--fg);
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
    overflow-wrap: anywhere;
  }
  .glob {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--fg-dim);
  }
</style>
