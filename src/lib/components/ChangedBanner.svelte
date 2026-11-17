<script lang="ts">
  import { keepMine, reloadFromDisk } from "$lib/watch.svelte";
  import { tabsStore } from "$lib/tabs.svelte";

  const tab = $derived(tabsStore.active);
</script>

{#if tab?.diskChanged}
  <div class="banner" role="alert">
    <span>Changed on disk</span>
    <button class="btn" onclick={() => void reloadFromDisk(tab)}>Reload</button>
    <button class="btn" onclick={() => keepMine(tab)}>Keep mine</button>
  </div>
{/if}
{#if tab?.lossy}
  <div class="banner lossy" role="status">
    <span>
      This file contains bytes that aren't valid {tab.lossy}; they were replaced with "{"�"}". Saving writes
      the replacement characters.
    </span>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    background: var(--warn-bg);
    color: var(--warn-fg);
    border-bottom: 1px solid var(--border);
  }
  span {
    flex: 1;
  }
  .btn {
    padding: 2px 10px;
    color: var(--fg);
  }
</style>
