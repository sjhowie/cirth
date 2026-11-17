<script lang="ts">
  /** Small popup list (optionally filterable) anchored above its parent; parent must be position: relative. */
  let {
    items,
    current = "",
    filterable = false,
    onpick,
    onclose,
  }: {
    items: string[];
    current?: string;
    filterable?: boolean;
    onpick: (item: string) => void;
    onclose: () => void;
  } = $props();

  let query = $state("");
  const shown = $derived(items.filter((i) => i.toLowerCase().includes(query.toLowerCase())));

  function focusNode(node: HTMLElement): void {
    node.focus();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      onclose();
    } else if (e.key === "Enter" && !e.isComposing && shown.length > 0) {
      // Enter on a focused item button is handled by that button's own click.
      if ((e.target as HTMLElement).closest("button.item")) return;
      onpick(shown[0]);
    }
  }
</script>

<svelte:window onclick={onclose} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="picker" role="listbox" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKeydown}>
  {#if filterable}
    <input type="text" placeholder="Filter…" bind:value={query} use:focusNode />
  {/if}
  <div class="list">
    {#each shown as item (item)}
      <button class="item" class:current={item === current} role="option" aria-selected={item === current} onclick={() => onpick(item)}>
        {item}
      </button>
    {:else}
      <div class="none">No matches</div>
    {/each}
  </div>
</div>

<style>
  .picker {
    position: absolute;
    bottom: 100%;
    right: 0;
    min-width: 180px;
    max-height: 340px;
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow);
    z-index: 900;
    padding: 4px;
  }
  input {
    margin-bottom: 4px;
  }
  .list {
    overflow-y: auto;
  }
  .item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 4px 8px;
    border-radius: 4px;
  }
  .item:hover {
    background: var(--bg-hover);
  }
  .item.current {
    color: var(--accent);
    font-weight: 600;
  }
  .none {
    padding: 6px 8px;
    color: var(--fg-dim);
  }
</style>
