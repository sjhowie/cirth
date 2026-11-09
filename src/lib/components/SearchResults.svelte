<script lang="ts">
  import { explorer } from "$lib/explorer.svelte";
  import { relativeTo, splitPreview, summaryText } from "$lib/search/results";
  import { openMatch, search } from "$lib/search/search.svelte";

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
</script>

{#if search.searching || summary}
  <div class="summary">
    {#if search.searching}<span class="spin">Searching…</span>{/if}
    {summary}
  </div>
{:else if search.query !== "" && !search.error}
  <div class="summary">No results</div>
{/if}

<div class="results" role="tree" aria-label="Search results">
  {#each groups as g (g.path)}
    {@const rel = relativeTo(explorer.root ?? "", g.path)}
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

<style>
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
