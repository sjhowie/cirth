<script lang="ts">
  import Explorer from "./Explorer.svelte";
  import { layout } from "#lib/layout.svelte.js";

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
  <div class="body">
    <Explorer />
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
