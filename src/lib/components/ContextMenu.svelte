<script module lang="ts">
  export interface MenuItem {
    label: string;
    action: () => void;
  }
</script>

<script lang="ts">
  let { x, y, items, onclose }: { x: number; y: number; items: MenuItem[]; onclose: () => void } = $props();

  const MARGIN = 4;
  let menu = $state<HTMLDivElement | null>(null);
  let innerW = $state(0);
  let innerH = $state(0);
  // Clamp to the viewport once the menu's size is measured.
  const left = $derived(menu ? Math.max(MARGIN, Math.min(x, innerW - menu.offsetWidth - MARGIN)) : x);
  const top = $derived(menu ? Math.max(MARGIN, Math.min(y, innerH - menu.offsetHeight - MARGIN)) : y);
</script>

<svelte:window
  onclick={onclose}
  oncontextmenu={onclose}
  onkeydowncapture={(e) => e.key === "Escape" && onclose()}
  bind:innerWidth={innerW}
  bind:innerHeight={innerH}
/>

<div class="ctx" role="menu" bind:this={menu} style:left="{left}px" style:top="{top}px">
  {#each items as item (item.label)}
    <button
      class="entry"
      role="menuitem"
      onclick={(e) => {
        e.stopPropagation();
        onclose();
        item.action();
      }}
    >
      {item.label}
    </button>
  {/each}
</div>

<style>
  .ctx {
    position: fixed;
    min-width: 150px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow);
    padding: 4px;
    z-index: 960;
  }
  .entry {
    display: block;
    width: 100%;
    text-align: left;
    padding: 5px 10px;
    border-radius: 4px;
  }
  .entry:hover {
    background: var(--bg-hover);
  }
</style>
