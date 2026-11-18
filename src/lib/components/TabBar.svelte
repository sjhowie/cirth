<script lang="ts">
  import { activateTab, activateTabWhileDragging } from "#lib/editorHost.svelte.js";
  import { cancelTabHover, dragOverTab } from "#lib/editor/tabDrag.js";
  import { closeTab } from "#lib/files.js";
  import { tabsStore } from "#lib/tabs.svelte.js";

  let strip: HTMLDivElement;

  function onWheel(e: WheelEvent): void {
    if (e.deltaY !== 0 && e.deltaX === 0) {
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }

  function onAux(e: MouseEvent, id: number): void {
    if (e.button === 1) {
      e.preventDefault();
      void closeTab(id);
    }
  }

  // Attached here rather than as an attribute: a drag handler on the tablist would make it an interactive element.
  $effect(() => {
    const onDragLeave = (e: DragEvent): void => {
      if (!(e.relatedTarget instanceof Node && strip.contains(e.relatedTarget))) cancelTabHover();
    };
    strip.addEventListener("dragleave", onDragLeave);
    return () => strip.removeEventListener("dragleave", onDragLeave);
  });

  $effect(() => {
    const id = tabsStore.activeId;
    if (id === null) return;
    strip.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
</script>

<div class="strip" role="tablist" bind:this={strip} onwheel={onWheel}>
  {#each tabsStore.tabs as tab (tab.id)}
    <div
      class="tab"
      class:active={tab.id === tabsStore.activeId}
      class:deleted={tab.deleted}
      data-tab={tab.id}
      role="presentation"
      onmousedown={(e) => e.button === 1 && e.preventDefault()}
      onauxclick={(e) => onAux(e, tab.id)}
      ondragover={() => dragOverTab(tab.id, activateTabWhileDragging)}
    >
      <button
        class="label"
        role="tab"
        aria-selected={tab.id === tabsStore.activeId}
        title={tab.deleted ? `${tab.path ?? tab.title} (deleted on disk)` : (tab.path ?? tab.title)}
        onclick={() => activateTab(tab.id)}
      >
        {tab.title}{tab.deleted ? " (deleted)" : ""}
      </button>
      <button class="close" aria-label={`Close ${tab.title}`} onclick={() => void closeTab(tab.id)}>
        {#if tab.dirty}<span class="dot" aria-label="Unsaved changes"></span><span class="x">×</span>{:else}<span class="x always">×</span>{/if}
      </button>
    </div>
  {/each}
</div>

<style>
  .strip {
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--bg-tab);
    border-bottom: 1px solid var(--border);
    scrollbar-width: thin;
    flex: none;
  }
  .tab {
    display: flex;
    align-items: center;
    flex: none;
    border-right: 1px solid var(--border);
    background: var(--bg-tab);
    color: var(--fg-dim);
    max-width: 240px;
  }
  .tab.active {
    background: var(--bg-tab-active);
    color: var(--fg);
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .tab.deleted .label {
    text-decoration: line-through;
    font-style: italic;
  }
  .label {
    padding: 7px 4px 7px 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: inherit;
  }
  .close {
    width: 24px;
    height: 24px;
    margin: 0 4px 0 2px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-dim);
    position: relative;
  }
  .close:hover {
    background: var(--bg-hover);
  }
  .x {
    font-size: 15px;
    line-height: 1;
    visibility: hidden;
  }
  .x.always,
  .tab:hover .x {
    visibility: visible;
  }
  .dot {
    position: absolute;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg-dim);
  }
  .tab:hover .dot,
  .close:hover .dot {
    display: none;
  }
</style>
