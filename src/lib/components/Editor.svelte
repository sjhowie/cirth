<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { attachView, detachView } from "$lib/editorHost.svelte";
  import { tabsStore } from "$lib/tabs.svelte";

  let host: HTMLDivElement;

  onMount(() => {
    const view = new EditorView({ state: EditorState.create({ doc: "" }), parent: host });
    attachView(view);
    return () => {
      detachView();
      view.destroy();
    };
  });
</script>

<div class="editor" class:hidden={!tabsStore.active} bind:this={host}></div>
{#if !tabsStore.active}
  <div class="empty">No file open. Ctrl/⌘+N for a new file, Ctrl/⌘+O to open one.</div>
{/if}

<style>
  .editor {
    flex: 1;
    min-height: 0;
    min-width: 0;
    background: var(--bg-editor);
    overflow: hidden;
  }
  .editor.hidden {
    display: none;
  }
  .empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-dim);
    background: var(--bg-editor);
  }
</style>
