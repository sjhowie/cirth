<script lang="ts">
  import { layout } from "$lib/layout.svelte";

  const panel = $derived(layout.panels.find((p) => p.id === layout.activePanel) ?? layout.panels[0]);

  function startDrag(e: PointerEvent): void {
    const startX = e.clientX;
    const startW = layout.sidebarWidth;
    const move = (ev: PointerEvent) => layout.setSidebarWidth(startW + ev.clientX - startX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  }

  function onHandleKey(e: KeyboardEvent): void {
    if (e.key === "ArrowLeft") layout.setSidebarWidth(layout.sidebarWidth - 16);
    else if (e.key === "ArrowRight") layout.setSidebarWidth(layout.sidebarWidth + 16);
  }
</script>

<aside class="sidebar" style:width="{layout.sidebarWidth}px">
  {#if layout.panels.length > 1}
    <div class="switch" role="tablist">
      {#each layout.panels as p (p.id)}
        <button role="tab" aria-selected={p.id === panel?.id} class:active={p.id === panel?.id} onclick={() => (layout.activePanel = p.id)}>
          {p.title}
        </button>
      {/each}
    </div>
  {/if}
  <div class="body">
    {#if panel}
      {@const Panel = panel.component}
      <Panel />
    {/if}
  </div>
</aside>
<button class="handle" aria-label="Resize sidebar (drag, or use arrow keys)" onpointerdown={startDrag} onkeydown={onHandleKey}></button>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    flex: none;
    background: var(--bg);
    min-height: 0;
    overflow: hidden;
  }
  .switch {
    display: flex;
    border-bottom: 1px solid var(--border);
  }
  .switch button {
    flex: 1;
    padding: 6px 0;
    color: var(--fg-dim);
  }
  .switch button.active {
    color: var(--fg);
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .body {
    flex: 1;
    min-height: 0;
  }
  .handle {
    width: 4px;
    flex: none;
    cursor: col-resize;
    padding: 0;
    border: none;
    background: var(--border);
  }
  .handle:hover,
  .handle:focus-visible {
    background: var(--accent);
  }
</style>
